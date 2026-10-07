"""Workspace feature flags: who may read and flip them, and who hears about it."""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import feature_flags
from switch_core.db.models import TenantMember
from switch_core.feature_flags import ECOSYSTEM_SHOW_OWNERS
from switch_core.management.notifier import FEATURE_FLAGS_CHANGED
from tests.switch_core.management.harness import (
    TENANT_ZERO_ID,
    Harness,
    add_member,
    build_harness,
    cookies_for,
    enroll_console,
    open_connection,
    open_stream,
    take,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


async def _make_admin(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> None:
    async with session_factory() as session:
        await session.execute(
            update(TenantMember)
            .where(TenantMember.user_id == user_id)
            .values(role="admin")
        )
        await session.commit()


class TestReading:
    async def test_a_member_reads_the_flags_but_may_not_edit(
        self, harness: Harness
    ) -> None:
        member = await add_member(harness.session_factory, "bob")
        async with harness.client() as client:
            listed = await client.get(
                "/gateway/feature-flags", cookies=cookies_for(member)
            )
        assert listed.status_code == 200, listed.text
        assert listed.json() == {
            "flags": [{"key": ECOSYSTEM_SHOW_OWNERS, "enabled": False}],
            "can_edit": False,
        }


class TestFlipping:
    async def test_a_member_is_refused(self, harness: Harness) -> None:
        member = await add_member(harness.session_factory, "bob")
        async with harness.client() as client:
            refused = await client.put(
                f"/gateway/feature-flags/{ECOSYSTEM_SHOW_OWNERS}",
                json={"enabled": True},
                cookies=cookies_for(member),
            )
            listed = await client.get(
                "/gateway/feature-flags", cookies=cookies_for(member)
            )
        assert refused.status_code == 403
        assert listed.json()["flags"][0]["enabled"] is False

    async def test_a_workspace_admin_flips_a_flag(self, harness: Harness) -> None:
        admin = await add_member(harness.session_factory, "ada")
        await _make_admin(harness.session_factory, admin.id)
        async with harness.client() as client:
            flipped = await client.put(
                f"/gateway/feature-flags/{ECOSYSTEM_SHOW_OWNERS}",
                json={"enabled": True},
                cookies=cookies_for(admin),
            )
            listed = await client.get(
                "/gateway/feature-flags", cookies=cookies_for(admin)
            )
        assert flipped.status_code == 200, flipped.text
        assert listed.json() == {
            "flags": [{"key": ECOSYSTEM_SHOW_OWNERS, "enabled": True}],
            "can_edit": True,
        }

    async def test_an_unknown_flag_is_refused(self, harness: Harness) -> None:
        admin = await add_member(harness.session_factory, "ada")
        await _make_admin(harness.session_factory, admin.id)
        async with harness.client() as client:
            refused = await client.put(
                "/gateway/feature-flags/not.a.flag",
                json={"enabled": True},
                cookies=cookies_for(admin),
            )
        assert refused.status_code == 404

    async def test_agents_can_no_longer_flip_flags(self, harness: Harness) -> None:
        async with harness.client() as client:
            refused = await client.put(
                f"/agents/feature-flags/{ECOSYSTEM_SHOW_OWNERS}",
                json={"enabled": True},
            )
        assert refused.status_code in (401, 404, 405)


class TestControllers:
    async def test_a_flip_reaches_the_workspaces_controllers_only(
        self, harness: Harness
    ) -> None:
        admin = await add_member(harness.session_factory, "ada")
        await _make_admin(harness.session_factory, admin.id)
        notifier = harness.management.service.notifier
        ours = notifier.subscribe(f"ours-{uuid.uuid4().hex[:6]}", TENANT_ZERO_ID)
        theirs = notifier.subscribe(f"theirs-{uuid.uuid4().hex[:6]}", "elsewhere")
        async with harness.client() as client:
            await client.put(
                f"/gateway/feature-flags/{ECOSYSTEM_SHOW_OWNERS}",
                json={"enabled": True},
                cookies=cookies_for(admin),
            )
        assert ours.drain() == [
            (FEATURE_FLAGS_CHANGED, {"flags": {ECOSYSTEM_SHOW_OWNERS: True}})
        ]
        assert theirs.drain() == []

    async def test_a_connecting_controller_is_told_the_current_flags(
        self, harness: Harness
    ) -> None:
        admin = await add_member(harness.session_factory, "ada")
        await _make_admin(harness.session_factory, admin.id)
        async with harness.client() as client:
            await client.put(
                f"/gateway/feature-flags/{ECOSYSTEM_SHOW_OWNERS}",
                json={"enabled": True},
                cookies=cookies_for(admin),
            )
            controller = await enroll_console(harness, client, admin)
            opened = await open_connection(client, controller)
        stream = await open_stream(harness, controller, opened)
        [(event, data)] = await take(stream, 1)
        await stream.aclose()
        assert event == "connection_state"
        assert data["feature_flags"] == {ECOSYSTEM_SHOW_OWNERS: True}


class TestConcurrentChanges:
    async def test_two_admins_flipping_different_flags_announce_both(
        self, harness: Harness, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setitem(feature_flags.KNOWN_FEATURE_FLAGS, "test.one", False)
        monkeypatch.setitem(feature_flags.KNOWN_FEATURE_FLAGS, "test.two", False)
        ada = await add_member(harness.session_factory, "ada")
        bob = await add_member(harness.session_factory, "bob")
        await _make_admin(harness.session_factory, ada.id)
        await _make_admin(harness.session_factory, bob.id)
        announced: list[dict[str, bool]] = []
        service = harness.feature_flag_service
        service.add_listener(lambda _tenant, flags: announced.append(flags))
        # Hold each write open until the other has written too, or briefly when
        # it cannot: without serialisation both would read before either commits.
        both_written = asyncio.Barrier(2)
        real_set = service._store.set

        async def set_then_wait(session: AsyncSession, key: str, enabled: bool) -> None:
            await real_set(session, key, enabled)
            try:
                await asyncio.wait_for(both_written.wait(), timeout=0.5)
            except TimeoutError:
                pass

        monkeypatch.setattr(service._store, "set", set_then_wait)
        async with harness.client() as client:
            await asyncio.gather(
                client.put(
                    "/gateway/feature-flags/test.one",
                    json={"enabled": True},
                    cookies=cookies_for(ada),
                ),
                client.put(
                    "/gateway/feature-flags/test.two",
                    json={"enabled": True},
                    cookies=cookies_for(bob),
                ),
            )
        assert len(announced) == 2
        assert announced[-1]["test.one"] is True
        assert announced[-1]["test.two"] is True

    async def test_a_failing_listener_does_not_fail_a_saved_change(
        self, harness: Harness
    ) -> None:
        admin = await add_member(harness.session_factory, "ada")
        await _make_admin(harness.session_factory, admin.id)

        def broken(_tenant: str, _flags: dict[str, bool]) -> None:
            raise RuntimeError("listener down")

        harness.feature_flag_service.add_listener(broken)
        async with harness.client() as client:
            flipped = await client.put(
                f"/gateway/feature-flags/{ECOSYSTEM_SHOW_OWNERS}",
                json={"enabled": True},
                cookies=cookies_for(admin),
            )
            listed = await client.get(
                "/gateway/feature-flags", cookies=cookies_for(admin)
            )
        assert flipped.status_code == 200, flipped.text
        assert listed.json()["flags"][0]["enabled"] is True
