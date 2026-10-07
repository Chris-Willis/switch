"""Reading and changing a workspace's feature flags, and telling whoever keeps a copy.

A flag's value in a workspace is the workspace's own choice if it made one,
otherwise the server-wide default. The gateway writes a choice; the
controllers of that workspace hold the flags they were sent on connect and
need the new values. Core runs as one process, so the change only has to
reach listeners registered here. A listener that misses a change (a restart,
a stream between connections) catches up in full on its next connect.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import require_tenant_id
from switch_core.db.stores.feature_flag_store import FeatureFlagStore

logger = logging.getLogger(__name__)

FeatureFlagListener = Callable[[str, dict[str, bool]], None]


@dataclass(frozen=True)
class FeatureFlagState:
    key: str
    enabled: bool
    # The server-wide default, which the flag follows unless overridden.
    default: bool
    # Whether the workspace made its own choice for this flag.
    overridden: bool


class FeatureFlagService:
    def __init__(self, defaults: dict[str, bool]) -> None:
        self._store = FeatureFlagStore(defaults)
        self._listeners: list[FeatureFlagListener] = []
        self._locks: dict[str, asyncio.Lock] = {}

    def add_listener(self, listener: FeatureFlagListener) -> None:
        self._listeners.append(listener)

    async def get(self, session: AsyncSession, key: str) -> bool:
        return await self._store.get(session, key)

    async def get_all(self, session: AsyncSession) -> dict[str, bool]:
        return await self._store.get_all(session)

    async def states(self, session: AsyncSession) -> list[FeatureFlagState]:
        """Every known flag of the bound workspace, with where its value comes from."""
        defaults = self._store.defaults
        overrides = await self._store.overrides(session)
        return [
            FeatureFlagState(
                key=key,
                enabled=overrides.get(key, default),
                default=default,
                overridden=key in overrides,
            )
            for key, default in sorted(defaults.items())
        ]

    async def set(self, session: AsyncSession, key: str, enabled: bool) -> None:
        """Make the bound workspace's own choice for one flag. `key` is validated."""
        await self._change(session, lambda: self._store.set(session, key, enabled))

    async def reset(self, session: AsyncSession, key: str) -> None:
        """Drop the bound workspace's choice, so the flag follows the server default."""
        await self._change(session, lambda: self._store.clear(session, key))

    async def _change(
        self, session: AsyncSession, write: Callable[[], Awaitable[None]]
    ) -> None:
        """Commit `write` and announce the workspace's full set.

        Changes to one workspace are serialised, and the set announced is read
        after the write commits, so two admins flipping different flags at once
        cannot announce a set that is missing the other's change, in either
        order.
        """
        tenant_id = require_tenant_id()
        async with self._locks.setdefault(tenant_id, asyncio.Lock()):
            await write()
            await session.commit()
            flags = await self._store.get_all(session)
            await session.commit()
            self._announce(tenant_id, flags)

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
