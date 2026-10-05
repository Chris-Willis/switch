"""Console ⇄ agents controller relay: one request answered by the agent's
controller, and live views of its sessions.

The same requests, limits and answers as the hosted worker relay
(`hosted_relay.py`), for an agent whose definition places it on a controller,
except that `ensure` (start or restart a session) is relayed too.
The request goes out on that controller's stream as `agent.control` and the
controller answers it over the management routes (`ControlRelays`).

Owner only: an agent that is not the caller's reads as not found, so its
existence does not leak. Nothing relayed is written to the database or the
log.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.control_relay import (
    HEALTH_SUBSCRIPTION,
    RELAY_REQUEST_LIMIT_BYTES,
    ConsoleView,
    ControllerRelay,
    ControlRelays,
    RelayError,
    classify_control_message,
    subscribe_message,
)
from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.bridges.agent.protocol.stream import KEEPALIVE_INTERVAL_SECONDS
from switch_core.db.models import AgentDefinition, User, require_tenant_id
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.gateway.auth import get_current_user, get_current_user_in_transaction
from switch_core.gateway.dependencies import get_protocol, get_session
from switch_core.gateway.hosted_relay import (
    MAX_STREAM_SUBSCRIPTIONS,
    SUBSCRIPTION_RELAY_TIMEOUT_MS,
    RelayRequest,
    relay_error,
    request_body,
    stream_frame,
)

logger = logging.getLogger(__name__)

EC2_CONTROLLER = "ec2"


async def request_wake_for_agent(
    session: AsyncSession, *, tenant_id: str, agent_id: str, controller_id: str
) -> None:
    """Ask the sleeping cloud machine that runs the agent's controller to start.

    The one place a Console control request wakes a machine. Waking a
    controller machine is not implemented yet, so the caller is told the
    machine is asleep and nothing starts it.
    """
    logger.warning(
        "Console control for agent %s found controller %s asleep; waking a "
        "controller machine is not implemented",
        agent_id,
        controller_id,
    )


def controller_info(generation: int | None) -> dict[str, Any]:
    """The relay's far end in the hosted relay's `worker` shape: the
    controller's current stream, which the Console resets its live views on."""
    return {"launch_revision": None, "boot_id": None, "generation": generation}


def live_controller(
    presence: ControllerPresence, relays: ControlRelays, agent_id: str
) -> tuple[str | None, int | None]:
    """The agent's controller, and its current stream while it is live."""
    binding = presence.binding(agent_id)
    if binding is None:
        return None, None
    if not presence.is_live(agent_id):
        return binding.controller_id, None
    return binding.controller_id, relays.generation(binding.controller_id)


async def owned_definition(
    session: AsyncSession, tenant_id: str, agent_id: str, user: User
) -> AgentDefinition:
    row = await AgentDefinitionStore().get_for_agent(session, tenant_id, agent_id)
    if row is None or row.owner_id != user.id:
        raise HTTPException(404, "Managed agent not found.")
    return row


async def control_target(
    session: AsyncSession,
    presence: ControllerPresence,
    relays: ControlRelays,
    tenant_id: str,
    row: AgentDefinition,
) -> str:
    """The controller to send the agent's control request to, or why there is none."""
    if row.controller_id is None:
        raise RelayError(
            "agent_unplaced", "The agent is not placed on any machine.", 409
        )
    binding = presence.binding(row.agent_id)
    if binding is None or binding.controller_id != row.controller_id:
        raise RelayError(
            "controller_changing",
            "The agent is moving to another machine. Retry shortly.",
            409,
        )
    if presence.is_revoked(binding.controller_id):
        raise RelayError(
            "controller_revoked", "The machine running this agent was removed.", 409
        )
    if not binding.running:
        raise RelayError("agent_stopped", "The agent is stopped.", 409)
    if (
        presence.is_live(row.agent_id)
        and relays.generation(binding.controller_id) is not None
    ):
        return binding.controller_id
    controller = await AgentControllerStore().get(
        session, tenant_id, binding.controller_id
    )
    if controller is not None and controller.kind == EC2_CONTROLLER:
        await request_wake_for_agent(
            session,
            tenant_id=tenant_id,
            agent_id=row.agent_id,
            controller_id=binding.controller_id,
        )
        raise RelayError("machine_asleep", "The cloud machine is asleep.", 503)
    raise RelayError(
        "controller_offline",
        f"The machine running this agent ({binding.controller_name}) is offline.",
        503,
    )


def ask_controller(
    relays: ControlRelays,
    tenant_id: str,
    controller_id: str,
    agent_id: str,
    subscription: str,
    on: bool,
) -> None:
    """Subscribe or unsubscribe the controller for Console views; the answer is
    not awaited.

    A subscribe the controller's queue cannot take is shown on every view of
    it and asked again on the next pass. An unsubscribe that cannot be sent is
    not lost either: the controller's next push for it is answered
    `subscribed: false`.
    """
    try:
        relays.dispatch(
            tenant_id=tenant_id,
            controller_id=controller_id,
            agent_id=agent_id,
            message=subscribe_message(subscription, on),
            timeout_ms=SUBSCRIPTION_RELAY_TIMEOUT_MS,
        )
    except RelayError as error:
        if on:
            relays.views.subscribe_failed(agent_id, subscription, error)
            return
        logger.warning(
            "Could not close controller subscription for agent %s: %s; the "
            "controller's next push is refused instead",
            agent_id,
            error.code,
        )


async def control_events(
    presence: ControllerPresence,
    relays: ControlRelays,
    tenant_id: str,
    agent_id: str,
    view: ConsoleView,
    keepalive_seconds: float,
) -> AsyncIterator[bytes]:
    views = relays.views
    views.open(agent_id, view)
    sent: dict[str, Any] | None = None
    last_write = time.monotonic()
    try:
        while True:
            controller_id, generation = live_controller(presence, relays, agent_id)
            info = controller_info(generation)
            if info != sent:
                sent = info
                last_write = time.monotonic()
                yield stream_frame("worker", info)
            if controller_id is not None and generation is not None:
                for name in views.unsubscribed(agent_id, generation):
                    ask_controller(
                        relays, tenant_id, controller_id, agent_id, name, True
                    )
            view.wake.clear()
            for event, data in view.drain():
                last_write = time.monotonic()
                yield stream_frame(event, data)
            try:
                await asyncio.wait_for(view.wake.wait(), timeout=1.0)
            except TimeoutError:
                pass
            if time.monotonic() - last_write >= keepalive_seconds:
                last_write = time.monotonic()
                yield b": keepalive\n\n"
    finally:
        controller_id, generation = live_controller(presence, relays, agent_id)
        for name, asked in views.close(agent_id, view):
            if controller_id is not None and generation is not None:
                if asked == generation:
                    ask_controller(
                        relays, tenant_id, controller_id, agent_id, name, False
                    )


def relay_answer(relay: ControllerRelay, answer: dict[str, Any]) -> JSONResponse:
    return JSONResponse(
        content={
            **answer,
            "worker": controller_info(relay.generation),
        }
    )


def controller_relay_router(relays: ControlRelays) -> APIRouter:
    router = APIRouter(tags=["agent management"])

    @router.post("/agents/{agent_id}/control", response_model=None)
    async def control(
        agent_id: str,
        raw: Annotated[bytes, Depends(request_body)],
        user: Annotated[User, Depends(get_current_user_in_transaction)],
        session: Annotated[AsyncSession, Depends(get_session)],
        protocol: Annotated[AgentCore, Depends(get_protocol)],
    ) -> JSONResponse:
        """One control message for the agent, answered by its controller.

        Waits for the answer up to `timeout_ms`; past it the outcome is
        unknown (`relay_timeout`) and the controller is told to drop it.
        """
        if len(raw) > RELAY_REQUEST_LIMIT_BYTES:
            return relay_error(
                RelayError("too_large", "A relay request is at most 2 MiB.", 413),
                None,
            )
        try:
            body = RelayRequest.model_validate_json(raw)
        except ValidationError as exc:
            raise HTTPException(422, exc.errors(include_input=False)) from exc
        tenant_id = require_tenant_id()
        row = await owned_definition(session, tenant_id, agent_id, user)
        presence = protocol.connections.controllers
        try:
            classify_control_message(body.message)
            controller_id = await control_target(
                session, presence, relays, tenant_id, row
            )
            await session.rollback()
            relay = relays.dispatch(
                tenant_id=tenant_id,
                controller_id=controller_id,
                agent_id=agent_id,
                message=body.message,
                timeout_ms=body.timeout_ms,
            )
            answer = await asyncio.shield(relay.future)
        except RelayError as error:
            return relay_error(
                error, controller_info(live_controller(presence, relays, agent_id)[1])
            )
        return relay_answer(relay, answer)

    @router.get("/agents/{agent_id}/control/stream", response_model=None)
    async def control_stream(
        agent_id: str,
        user: Annotated[User, Depends(get_current_user)],
        session: Annotated[AsyncSession, Depends(get_session)],
        protocol: Annotated[AgentCore, Depends(get_protocol)],
        subscribe: Annotated[list[UUID] | None, Query()] = None,
        watch_health: Annotated[bool, Query(alias="watchHealth")] = False,
    ) -> StreamingResponse:
        """Live events of the subscribed sessions (and health) as SSE, in the
        hosted relay stream's frames."""
        tenant_id = require_tenant_id()
        await owned_definition(session, tenant_id, agent_id, user)
        names = {str(session_id) for session_id in subscribe or []}
        if len(names) > MAX_STREAM_SUBSCRIPTIONS:
            raise HTTPException(422, "Too many subscriptions on one relay stream.")
        if watch_health:
            names.add(HEALTH_SUBSCRIPTION)
        await session.rollback()
        return StreamingResponse(
            control_events(
                protocol.connections.controllers,
                relays,
                tenant_id,
                agent_id,
                ConsoleView(frozenset(names)),
                KEEPALIVE_INTERVAL_SECONDS,
            ),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return router
