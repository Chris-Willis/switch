"""Changing a workspace's feature flags, and telling whoever keeps a copy.

The gateway writes a flag; the controllers of that workspace hold the flags
they were sent on connect and need the new values. Core runs as one process,
so the change only has to reach listeners registered here. A listener that
misses a change (a restart, a stream between connections) catches up in full
on its next connect.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import require_tenant_id
from switch_core.db.stores.feature_flag_store import FeatureFlagStore

logger = logging.getLogger(__name__)

FeatureFlagListener = Callable[[str, dict[str, bool]], None]


class FeatureFlagService:
    def __init__(self) -> None:
        self._store = FeatureFlagStore()
        self._listeners: list[FeatureFlagListener] = []
        self._locks: dict[str, asyncio.Lock] = {}

    def add_listener(self, listener: FeatureFlagListener) -> None:
        self._listeners.append(listener)

    async def set(
        self, session: AsyncSession, key: str, enabled: bool
    ) -> dict[str, bool]:
        """Set one flag of the bound workspace and announce the full set.

        Changes to one workspace are serialised, and the set announced is read
        after the write commits, so two admins flipping different flags at once
        cannot announce a set that is missing the other's change, in either
        order. The caller has validated `key` against the registry.
        """
        tenant_id = require_tenant_id()
        async with self._locks.setdefault(tenant_id, asyncio.Lock()):
            await self._store.set(session, key, enabled)
            await session.commit()
            flags = await self._store.get_all(session)
            await session.commit()
            self._announce(tenant_id, flags)
        return flags

    def _announce(self, tenant_id: str, flags: dict[str, bool]) -> None:
        # The change is already committed: a listener that fails must not turn
        # it into an error for the admin who made it.
        for listener in self._listeners:
            try:
                listener(tenant_id, dict(flags))
            except Exception:
                logger.exception(
                    "A feature flag listener failed for tenant %s; its holders "
                    "catch up when they next connect",
                    tenant_id,
                )
