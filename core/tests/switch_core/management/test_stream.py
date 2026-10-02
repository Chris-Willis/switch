"""The nudge stream and the in-process notifier behind it."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.management.notifier import (
    ASSIGNMENT_CHANGED,
    CREDENTIAL_REVOKED,
    OPERATION_PENDING,
    ControllerNotifier,
)
from switch_core.management.stream import KEEPALIVE, controller_event_stream
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    enroll_console,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


def _parse(raw: bytes) -> tuple[str, dict[str, Any]]:
    lines = raw.decode().strip().split("\n")
    assert lines[0].startswith("event: ") and lines[1].startswith("data: ")
    return lines[0][len("event: ") :], json.loads(lines[1][len("data: ") :])


class TestTheNotifier:
    def test_signals_coalesce_and_revocation_comes_last(self) -> None:
        notifier = ControllerNotifier()
        subscription = notifier.subscribe("c1")
        notifier.credential_revoked("c1")
        notifier.assignment_changed("c1", 3)
        notifier.assignment_changed("c1", 5)
        notifier.assignment_changed("c1", 4)
        notifier.operation_pending(
            "c1", operation_id="o1", kind="agent.restart", agent_id="a"
        )
        notifier.assignment_changed("c2", 9)

        assert subscription.wake.is_set()
        assert subscription.drain() == [
            (ASSIGNMENT_CHANGED, {"revision": 5}),
            (
                OPERATION_PENDING,
                {"operation_id": "o1", "kind": "agent.restart", "agent_id": "a"},
            ),
            (CREDENTIAL_REVOKED, {}),
        ]
        assert not subscription.wake.is_set()
        assert subscription.drain() == []

    def test_every_open_stream_hears_and_a_closed_one_is_forgotten(self) -> None:
        notifier = ControllerNotifier()
        first = notifier.subscribe("c1")
        second = notifier.subscribe("c1")
        notifier.assignment_changed("c1", 1)
        assert (
            first.drain() == second.drain() == [(ASSIGNMENT_CHANGED, {"revision": 1})]
        )
        first.close()
        second.close()
        assert notifier.subscriber_count("c1") == 0


class TestTheStream:
    async def test_frames_in_order_then_keepalive_then_revocation_ends_it(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
        principal = ControllerPrincipal(
            controller_id=controller.controller_id,
            owner_id=owner.id,
            tenant_id=TENANT_ZERO_ID,
        )
        notifier = harness.management.service.notifier
        stream = controller_event_stream(
            principal=principal,
            service=harness.management.service,
            session_factory=harness.session_factory,
            keepalive_seconds=0.05,
        )

        first = await anext(stream)
        assert _parse(first) == (
            "connection_state",
            {
                "controller_id": controller.controller_id,
                "assignment_revision": 0,
                "report_within_s": 60,
            },
        )
        assert notifier.subscriber_count(controller.controller_id) == 1

        assert await anext(stream) == KEEPALIVE

        notifier.assignment_changed(controller.controller_id, 2)
        notifier.operation_pending(
            controller.controller_id,
            operation_id="o1",
            kind="provider.recheck",
            agent_id=None,
        )
        assert _parse(await anext(stream)) == ("assignment.changed", {"revision": 2})
        assert _parse(await anext(stream)) == (
            "operation.pending",
            {"operation_id": "o1", "kind": "provider.recheck", "agent_id": None},
        )

        notifier.credential_revoked(controller.controller_id)
        assert _parse(await anext(stream)) == ("credential.revoked", {})
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
        assert notifier.subscriber_count(controller.controller_id) == 0

    async def test_a_nudge_while_waiting_wakes_the_stream_promptly(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
        principal = ControllerPrincipal(
            controller_id=controller.controller_id,
            owner_id=owner.id,
            tenant_id=TENANT_ZERO_ID,
        )
        stream = controller_event_stream(
            principal=principal,
            service=harness.management.service,
            session_factory=harness.session_factory,
            keepalive_seconds=30,
        )
        await anext(stream)
        pending = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0.01)
        harness.management.service.notifier.assignment_changed(
            controller.controller_id, 7
        )
        frame = await asyncio.wait_for(pending, timeout=2)
        assert _parse(frame) == ("assignment.changed", {"revision": 7})
        await stream.aclose()
        assert (
            harness.management.service.notifier.subscriber_count(
                controller.controller_id
            )
            == 0
        )
