"""A machine's online state, read from its persisted stream connection.

The process holding a controller's stream writes what it decides about the
connection (opened, beating, closed and why) to the controller's row, and a
machine's state is read from that row: so it is the same from every process,
survives a restart, and turns offline within seconds of the controller
stopping or its stream dropping. Runs against the real database.
"""

from __future__ import annotations

import time
from datetime import timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import (
    ControllerConnection,
)
from switch_core.bridges.agent.protocol.liveness import HEARTBEAT_TTL_SECONDS
from switch_core.db.models import AgentController
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.management.connection_ledger import (
    BEAT_PERSIST_INTERVAL,
    LIVE_BEAT_LAG,
    PERSISTED_BEAT_STALE_AFTER,
    ControllerConnectionLedger,
)
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    build_harness,
    cookies_for,
    create_managed_agent,
    enroll_console,
    open_connection,
    open_stream,
    place_agent,
    provider,
    report_status,
    report_status_only,
    take,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _row(harness: Harness, controller_id: str) -> AgentController:
    async with harness.session_factory() as session:
        result = await session.execute(
            select(AgentController).where(AgentController.id == controller_id)
        )
        return result.scalar_one()


async def _listed(
    client: httpx.AsyncClient, controller: EnrolledController
) -> dict[str, Any]:
    response = await client.get(
        "/gateway/management/controllers", cookies=cookies_for(controller.owner)
    )
    assert response.status_code == 200, response.text
    [entry] = [c for c in response.json() if c["id"] == controller.controller_id]
    return dict(entry)


async def _goodbye(
    client: httpx.AsyncClient, controller: EnrolledController, opened: dict[str, Any]
) -> httpx.Response:
    return await client.delete(
        f"/v1/controllers/{controller.controller_id}/connection",
        params={
            "connection_id": opened["connection_id"],
            "generation": opened["generation"],
        },
        headers=controller.headers,
    )


def test_a_written_beat_goes_stale_only_after_a_live_connection_would_write_again() -> (
    None
):
    assert PERSISTED_BEAT_STALE_AFTER > LIVE_BEAT_LAG


class TestTheMachineState:
    async def test_a_machine_that_never_connected_is_unknown(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status_only(client, controller, 1)
            listed = await _listed(client, controller)
        assert listed["state"] == "unknown"
        assert listed["connection"] is None
        assert listed["last_seen_at"] is not None

    async def test_opening_makes_it_online_and_a_goodbye_offline_at_once(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            opened = await open_connection(client, controller)
            stream = await open_stream(harness, controller, opened)
            await take(stream, 2)
            live = presence.is_live(agent_id)
            online = await _listed(client, controller)
            goodbye = await _goodbye(client, controller, opened)
            evicted = await take(stream, 1)
            offline = await _listed(client, controller)
            beat = await client.post(
                f"/v1/controllers/{controller.controller_id}/connection/beat",
                json={
                    "connection_id": opened["connection_id"],
                    "generation": opened["generation"],
                    "cursors": {},
                },
                headers=controller.headers,
            )
        row = await _row(harness, controller.controller_id)

        assert live
        assert online["state"] == "online"
        assert online["connection"]["disconnected_at"] is None
        assert goodbye.status_code == 204, goodbye.text
        assert evicted == [
            (
                "evicted",
                {"code": "closed", "reason": "the controller closed its connection"},
            )
        ]
        assert not presence.is_live(agent_id)
        assert offline["state"] == "offline"
        assert offline["connection"]["disconnect_reason"] == "closed"
        assert offline["connection"]["disconnected_at"] is not None
        assert row.connection_id == opened["connection_id"]
        assert (beat.status_code, beat.json()["error"]["code"]) == (
            404,
            "unknown_connection",
        )

    async def test_a_goodbye_for_a_connection_that_is_not_current_is_refused(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            first = await open_connection(client, controller)
            second = await open_connection(client, controller)
            superseded = await _goodbye(client, controller, first)
            unknown = await _goodbye(
                client, controller, {"connection_id": "nope", "generation": 1}
            )
            stale = await _goodbye(
                client,
                controller,
                {**second, "generation": second["generation"] + 1},
            )
            listed = await _listed(client, controller)
        assert (superseded.status_code, superseded.json()["error"]["code"]) == (
            409,
            "taken_over",
        )
        assert (unknown.status_code, unknown.json()["error"]["code"]) == (
            404,
            "unknown_connection",
        )
        assert (stale.status_code, stale.json()["error"]["code"]) == (
            409,
            "stale_generation",
        )
        assert listed["state"] == "online"

    async def test_a_lapsed_beat_is_written_by_the_sweep(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await open_connection(client, controller)
            online = await _listed(client, controller)
            conn = presence.current_connection(controller.controller_id)
            assert conn is not None
            conn.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1
            presence.sweep()
            await presence.persist_all()
            offline = await _listed(client, controller)
        assert online["state"] == "online"
        assert offline["state"] == "offline"
        assert offline["connection"]["disconnect_reason"] == "heartbeat_lapsed"

    async def test_a_beat_written_long_ago_reads_offline_with_no_closing(
        self, harness: Harness
    ) -> None:
        """The process holding the stream died, or the server restarted:
        nothing wrote a closing, and the written beat ages out instead."""
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await open_connection(client, controller)
            harness.clock.advance(seconds=PERSISTED_BEAT_STALE_AFTER.seconds - 2)
            still_online = await _listed(client, controller)
            harness.clock.advance(seconds=3)
            offline = await _listed(client, controller)
        assert still_online["state"] == "online"
        assert offline["state"] == "offline"
        assert offline["connection"]["disconnected_at"] is None

    async def test_another_process_reads_the_same_state(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        holder = build_harness(session_factory)
        other = build_harness(session_factory)
        owner = await add_member(session_factory, "ada")
        async with holder.client() as client, other.client() as elsewhere:
            controller = await enroll_console(holder, client, owner)
            opened = await open_connection(client, controller)
            online = await _listed(elsewhere, controller)
            await _goodbye(client, controller, opened)
            offline = await _listed(elsewhere, controller)
        assert (
            other.protocol.connections.controllers.current_connection(
                controller.controller_id
            )
            is None
        )
        assert online["state"] == "online"
        assert offline["state"] == "offline"

    async def test_a_late_closing_of_a_replaced_connection_leaves_the_new_one(
        self, harness: Harness
    ) -> None:
        """A process that held an earlier connection and only now sweeps it
        does not overwrite the connection another process opened since."""
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await open_connection(client, controller)
            earlier = presence.current_connection(controller.controller_id)
            assert earlier is not None
            replacement = await open_connection(client, controller)
            elsewhere = ControllerConnectionLedger(
                session_factory=harness.session_factory,
                controllers=AgentControllerStore(),
                clock=harness.clock,
            )
            elsewhere.closed(earlier, "heartbeat_lapsed")
            await elsewhere.flush_all()
            listed = await _listed(client, controller)
        row = await _row(harness, controller.controller_id)
        assert row.connection_id == replacement["connection_id"]
        assert listed["state"] == "online"
        assert listed["connection"]["disconnect_reason"] is None

    async def test_a_revoked_machine_is_revoked_and_its_connection_closed(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await open_connection(client, controller)
            revoked = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
            await harness.protocol.connections.controllers.persist_all()
            listed = await _listed(client, controller)
        assert revoked.status_code == 200, revoked.text
        assert listed["state"] == "revoked"
        assert listed["connection"]["disconnect_reason"] == "revoked"

    async def test_placement_needs_the_machine_connected(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            conn = harness.protocol.connections.controllers.current_connection(
                controller.controller_id
            )
            assert conn is not None
            await _goodbye(
                client,
                controller,
                {"connection_id": conn.id, "generation": conn.generation},
            )
            refused = await create_managed_agent(
                client, owner, name="reviewer", controller_id=controller.controller_id
            )
        assert refused.status_code == 409, refused.text
        assert refused.json()["error"] == {
            "code": "controller_offline",
            "message": "Cannot place the agent: the controller is not connected "
            "to Switch.",
            "retryable": False,
        }


class _FailingOnce(AgentControllerStore):
    def __init__(self) -> None:
        self.failures = 1

    async def record_connection(self, *args: Any, **kwargs: Any) -> bool:
        if self.failures:
            self.failures -= 1
            raise ConnectionError("the database went away")
        return await super().record_connection(*args, **kwargs)


class TestTheLedger:
    async def _connect(
        self, harness: Harness, client: httpx.AsyncClient
    ) -> tuple[EnrolledController, ControllerConnection]:
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner)
        await open_connection(client, controller)
        conn = harness.protocol.connections.controllers.current_connection(
            controller.controller_id
        )
        assert conn is not None
        # Beats are taken only while a stream is attached.
        conn.stream_attached = True
        return controller, conn

    async def test_beats_are_written_at_most_every_interval(
        self, harness: Harness
    ) -> None:
        presence = harness.protocol.connections.controllers
        step = timedelta(seconds=2)
        async with harness.client() as client:
            controller, conn = await self._connect(harness, client)
            opened_at = (
                await _row(harness, controller.controller_id)
            ).connection_beat_at
            written = []
            for _ in range(3):
                harness.clock.advance(seconds=step.seconds)
                presence.beat(controller.controller_id, conn.id, conn.generation)
                await presence.persist(controller.controller_id)
                row = await _row(harness, controller.controller_id)
                written.append(row.connection_beat_at)
        assert opened_at is not None
        assert written[0] == opened_at
        assert written[1] == opened_at
        assert written[2] is not None
        assert written[2] - opened_at >= BEAT_PERSIST_INTERVAL

    async def test_a_closing_is_written_at_once(self, harness: Harness) -> None:
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller, conn = await self._connect(harness, client)
            harness.clock.advance(seconds=1)
            presence.beat(controller.controller_id, conn.id, conn.generation)
            presence.close(controller.controller_id, conn.id, conn.generation)
            await presence.persist(controller.controller_id)
        row = await _row(harness, controller.controller_id)
        assert row.disconnected_at is not None
        assert row.disconnect_reason == "closed"

    async def test_a_failed_write_is_kept_for_the_next_flush(
        self, harness: Harness
    ) -> None:
        store = _FailingOnce()
        ledger = ControllerConnectionLedger(
            session_factory=harness.session_factory,
            controllers=store,
            clock=harness.clock,
        )
        async with harness.client() as client:
            controller, conn = await self._connect(harness, client)
        ledger.closed(conn, "heartbeat_lapsed")
        with pytest.raises(ConnectionError):
            await ledger.flush(controller.controller_id)
        assert (await _row(harness, controller.controller_id)).disconnected_at is None
        await ledger.flush_all()
        row = await _row(harness, controller.controller_id)
        assert row.disconnect_reason == "heartbeat_lapsed"
        assert store.failures == 0
