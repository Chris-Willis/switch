from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import User
from switch_core.db.stores.feature_flag_store import FeatureFlagStore
from switch_core.feature_flag_service import FeatureFlagService
from switch_core.feature_flags import is_known_flag
from switch_core.gateway.auth import (
    get_current_user,
    get_tenant_is_admin,
    require_tenant_admin,
)
from switch_core.gateway.dependencies import get_feature_flag_service, get_session
from switch_core.gateway.schemas import (
    FeatureFlagsResponse,
    FeatureFlagState,
    SetFeatureFlagRequest,
)

router = APIRouter()


def _response(flags: dict[str, bool], can_edit: bool) -> FeatureFlagsResponse:
    return FeatureFlagsResponse(
        flags=[FeatureFlagState(key=k, enabled=v) for k, v in sorted(flags.items())],
        can_edit=can_edit,
    )


@router.get("")
async def list_feature_flags(
    session: Annotated[AsyncSession, Depends(get_session)],
    _user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
) -> FeatureFlagsResponse:
    """Every known flag of the caller's workspace. Any member may read them."""
    return _response(await FeatureFlagStore().get_all(session), is_admin)


@router.put("/{key}")
async def set_feature_flag(
    key: str,
    req: SetFeatureFlagRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    _user: Annotated[User, Depends(require_tenant_admin)],
    flags: Annotated[FeatureFlagService, Depends(get_feature_flag_service)],
) -> FeatureFlagsResponse:
    """Turn one of the workspace's flags on or off. Workspace admins only."""
    if not is_known_flag(key):
        raise HTTPException(status_code=404, detail=f"Unknown feature flag: {key}")
    return _response(await flags.set(session, key, req.enabled), True)
