from __future__ import annotations

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import FeatureFlag, require_tenant_id


class FeatureFlagStore:
    """Storage for the bound workspace's feature flags (``feature_flags``).

    A row is a workspace's own choice for one flag. Without one, the flag takes
    the server-wide default this store was built with: the registry's default
    (OFF), unless the deployment turned it on (``FEATURE_FLAGS_DEFAULT_ON``).
    Callers validate keys against the registry before writing (see
    ``switch_core.feature_flags``).
    """

    def __init__(self, defaults: dict[str, bool]) -> None:
        self._defaults = dict(defaults)

    @property
    def defaults(self) -> dict[str, bool]:
        return dict(self._defaults)

    async def get(self, session: AsyncSession, key: str) -> bool:
        result = await session.execute(
            select(FeatureFlag.enabled).where(
                FeatureFlag.tenant_id == require_tenant_id(),
                FeatureFlag.key == key,
            )
        )
        enabled = result.scalar_one_or_none()
        if enabled is None:
            return self._defaults.get(key, False)
        return enabled

    async def overrides(self, session: AsyncSession) -> dict[str, bool]:
        """The workspace's own choices, for known flags only."""
        result = await session.execute(
            select(FeatureFlag.key, FeatureFlag.enabled).where(
                FeatureFlag.tenant_id == require_tenant_id()
            )
        )
        return {key: enabled for key, enabled in result.all() if key in self._defaults}

    async def get_all(self, session: AsyncSession) -> dict[str, bool]:
        """The effective state of every known flag: defaults, then the workspace's choices."""
        return {**self._defaults, **await self.overrides(session)}

    async def set(self, session: AsyncSession, key: str, enabled: bool) -> None:
        stmt = (
            insert(FeatureFlag)
            .values(tenant_id=require_tenant_id(), key=key, enabled=enabled)
            .on_conflict_do_update(
                index_elements=[FeatureFlag.tenant_id, FeatureFlag.key],
                set_={"enabled": enabled, "updated_at": func.now()},
            )
        )
        await session.execute(stmt)
        await session.flush()

    async def clear(self, session: AsyncSession, key: str) -> None:
        """Drop the workspace's choice, so the flag follows the server default."""
        await session.execute(
            delete(FeatureFlag).where(
                FeatureFlag.tenant_id == require_tenant_id(),
                FeatureFlag.key == key,
            )
        )
        await session.flush()
