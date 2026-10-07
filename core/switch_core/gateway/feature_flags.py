from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import User
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


async def _response(
    flags: FeatureFlagService, session: AsyncSession, can_edit: bool
) -> FeatureFlagsResponse:
    return FeatureFlagsResponse(
        flags=[
            FeatureFlagState(
                key=state.key,
                enabled=state.enabled,
                default=state.default,
                overridden=state.overridden,
            )
            for state in await flags.states(session)
        ],
        can_edit=can_edit,
    )


def _require_known(key: str) -> None:
    if not is_known_flag(key):
        raise HTTPException(status_code=404, detail=f"Unknown feature flag: {key}")


@router.get("")
async def list_feature_flags(
    session: Annotated[AsyncSession, Depends(get_session)],
    _user: Annotated[User, Depends(get_current_user)],
    is_admin: Annotated[bool, Depends(get_tenant_is_admin)],
    flags: Annotated[FeatureFlagService, Depends(get_feature_flag_service)],
) -> FeatureFlagsResponse:
    """Every known flag of the caller's workspace. Any member may read them."""
    return await _response(flags, session, is_admin)


@router.put("/{key}")
async def set_feature_flag(
    key: str,
    req: SetFeatureFlagRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    _user: Annotated[User, Depends(require_tenant_admin)],
    flags: Annotated[FeatureFlagService, Depends(get_feature_flag_service)],
) -> FeatureFlagsResponse:
    """Turn one of the workspace's flags on or off. Workspace admins only."""
    _require_known(key)
    await flags.set(session, key, req.enabled)
    return await _response(flags, session, True)


@router.delete("/{key}")
async def reset_feature_flag(
    key: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    _user: Annotated[User, Depends(require_tenant_admin)],
    flags: Annotated[FeatureFlagService, Depends(get_feature_flag_service)],
) -> FeatureFlagsResponse:
    """Drop the workspace's choice for a flag, so it follows the server default."""
    _require_known(key)
    await flags.reset(session, key)
    return await _response(flags, session, True)
