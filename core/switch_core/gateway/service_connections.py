"""A person's service connections, and the grants on their agents.

Connections are listed and disconnected by the person who holds them; grants
are listed, set and removed by the agent's owner, on their own connection.
Someone else's agent answers 404, as a missing one does. The credential broker
(`connections/broker.py`) makes every change and runs the checks; this module
turns its refusals into the gateway's `{"detail": ...}`.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.addressing import parse_policy
from switch_core.connections.broker import (
    ServiceBroker,
    ServiceError,
    effective_tools,
    get_service_broker,
)
from switch_core.connections.loader import CATALOG, AccessLevel
from switch_core.db.models import Agent, ServiceGrant, User, require_tenant_id
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session
from switch_core.gateway.known_agents import known_agent_for

router = APIRouter()
STORE = ServiceConnectionStore()


def _refused(error: ServiceError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.message)


async def _owned_agent(session: AsyncSession, agent_id: str, user: User) -> Agent:
    agent = await session.scalar(
        select(Agent).where(
            Agent.tenant_id == require_tenant_id(), Agent.id == agent_id
        )
    )
    if agent is None or agent.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Agent not found.")
    return agent


def _grant_view(broker: ServiceBroker, agent: Agent, grant: ServiceGrant) -> dict:
    entry = CATALOG.get(grant.service)
    access: AccessLevel = "write" if grant.access == "write" else "read"
    return {
        "service": grant.service,
        "name": grant.service if entry is None else entry.definition.name,
        "access": grant.access,
        "tool_mode": grant.tool_mode,
        "tools": list(grant.tools),
        "effective_tools": (
            []
            if entry is None
            else effective_tools(entry, access, grant.tool_mode, list(grant.tools))
        ),
        "resources": dict(grant.resources),
        "summary": broker.summary(agent.display_name or agent.name, grant),
    }


@router.get("/service-connections")
async def list_service_connections(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any]:
    """Every catalog service, with the person's connection to it."""
    connections = {
        connection.service: connection
        for connection in await STORE.list_connections(session, user.id)
    }
    entries = []
    for entry in CATALOG.values():
        definition = entry.definition
        connection = connections.get(definition.slug)
        unavailable = broker.availability(definition.slug)
        entries.append(
            {
                "slug": definition.slug,
                "name": definition.name,
                "category": definition.category,
                "description": definition.description,
                "configured": unavailable is None,
                "unavailable_reason": unavailable,
                "status": "not_connected" if connection is None else connection.status,
                "consent": None if connection is None else connection.consent,
                "external_identity": (
                    None if connection is None else connection.external_identity
                ),
            }
        )
    return {"connections": entries}


@router.delete("/service-connections/{service}")
async def disconnect_service(
    service: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any]:
    """Disconnect: the grants on it go with it, and what was issued is revoked."""
    try:
        warning = await broker.disconnect(session, user.id, service)
    except ServiceError as error:
        raise _refused(error) from None
    return {"warning": warning}


@router.get("/agents/{agent_id}/service-grants")
async def list_service_grants(
    agent_id: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any]:
    """The agent's grants, and whether others can address it (and so use them)."""
    agent = await _owned_agent(session, agent_id, user)
    grants = await STORE.list_grants(session, agent.id)
    return {
        "grants": [_grant_view(broker, agent, grant) for grant in grants],
        "addressing_open": parse_policy(agent.addressing_policy).is_open(),
    }


class GrantBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    access: Literal["read", "write"] | None = None
    tool_mode: Literal["allow", "deny"] | None = None
    tools: list[str] | None = None
    resources: dict[str, Any]


@router.put("/agents/{agent_id}/service-grants/{service}")
async def set_service_grant(
    agent_id: str,
    service: str,
    body: GrantBody,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any]:
    """Create or replace the grant. With no `access` it reads."""
    agent = await _owned_agent(session, agent_id, user)
    if known_agent_for(agent) is None:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{agent.display_name or agent.name} runs on its own runtime, not "
                "one Switch Console starts, so nothing would start its service "
                "tools. It cannot be granted services."
            ),
        )
    try:
        grant, warning = await broker.set_grant(
            session,
            agent=agent,
            actor_id=user.id,
            service=service,
            access=body.access,
            tool_mode=body.tool_mode,
            tools=body.tools,
            resources=body.resources,
        )
    except ServiceError as error:
        raise _refused(error) from None
    return {"grant": _grant_view(broker, agent, grant), "warning": warning}


@router.delete("/agents/{agent_id}/service-grants/{service}")
async def remove_service_grant(
    agent_id: str,
    service: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any]:
    """Remove the grant; tokens issued under it are revoked."""
    agent = await _owned_agent(session, agent_id, user)
    grant = await STORE.get_grant(session, agent.id, service)
    if grant is None:
        raise HTTPException(status_code=404, detail="No such grant.")
    try:
        warning = await broker.revoke_grant(session, grant, user.id)
    except ServiceError as error:
        raise _refused(error) from None
    return {"warning": warning}
