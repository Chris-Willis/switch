from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import FeatureFlag, require_tenant_id
from switch_core.feature_flags import KNOWN_FEATURE_FLAGS


class FeatureFlagStore:
    """Storage for the bound workspace's feature flags (``feature_flags``).

    Only the value is persisted; an absent row means the flag takes its
    registry default (OFF). Callers are responsible for validating the key
    against the known-flag registry before writing (see
    ``switch_core.feature_flags``).
    """

    async def get(self, session: AsyncSession, key: str) -> bool:
        result = await session.execute(
            select(FeatureFlag.enabled).where(
                FeatureFlag.tenant_id == require_tenant_id(),
                FeatureFlag.key == key,
            )
        )
        enabled = result.scalar_one_or_none()
        if enabled is None:
            return KNOWN_FEATURE_FLAGS.get(key, False)
        return enabled

    async def get_all(self, session: AsyncSession) -> dict[str, bool]:
        """Return the effective state of every known flag (defaults + overrides)."""
        flags = dict(KNOWN_FEATURE_FLAGS)
        result = await session.execute(
            select(FeatureFlag.key, FeatureFlag.enabled).where(
                FeatureFlag.tenant_id == require_tenant_id()
            )
        )
        for key, enabled in result.all():
            if key in flags:
                flags[key] = enabled
        return flags

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
