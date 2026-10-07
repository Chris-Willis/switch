from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.feature_flag_store import FeatureFlagStore
from switch_core.feature_flags import ECOSYSTEM_SHOW_OWNERS


class TestFeatureFlagStore:
    async def test_absent_flag_defaults_off(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = FeatureFlagStore()
        async with session_factory() as session:
            assert await store.get(session, ECOSYSTEM_SHOW_OWNERS) is False

    async def test_set_then_get(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = FeatureFlagStore()
        async with session_factory() as session:
            await store.set(session, ECOSYSTEM_SHOW_OWNERS, True)
            await session.commit()

            assert await store.get(session, ECOSYSTEM_SHOW_OWNERS) is True

    async def test_set_is_idempotent_upsert(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = FeatureFlagStore()
        async with session_factory() as session:
            await store.set(session, ECOSYSTEM_SHOW_OWNERS, True)
            await store.set(session, ECOSYSTEM_SHOW_OWNERS, False)
            await session.commit()

            assert await store.get(session, ECOSYSTEM_SHOW_OWNERS) is False

    async def test_get_all_includes_known_defaults(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = FeatureFlagStore()
        async with session_factory() as session:
            flags = await store.get_all(session)
            assert flags[ECOSYSTEM_SHOW_OWNERS] is False

            await store.set(session, ECOSYSTEM_SHOW_OWNERS, True)
            await session.commit()

            flags = await store.get_all(session)
            assert flags[ECOSYSTEM_SHOW_OWNERS] is True

    async def test_each_workspace_holds_its_own_value(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = FeatureFlagStore()
        other_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            session.add(Tenant(id=other_tenant, slug=other_tenant, name=other_tenant))
            await store.set(session, ECOSYSTEM_SHOW_OWNERS, True)
            await session.commit()

        async with tenant_session(session_factory, other_tenant) as other:
            assert await store.get(other, ECOSYSTEM_SHOW_OWNERS) is False
            assert (await store.get_all(other))[ECOSYSTEM_SHOW_OWNERS] is False
            await store.set(other, ECOSYSTEM_SHOW_OWNERS, False)
            await other.commit()

        async with session_factory() as session:
            assert await store.get(session, ECOSYSTEM_SHOW_OWNERS) is True
