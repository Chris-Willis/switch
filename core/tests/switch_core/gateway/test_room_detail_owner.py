"""The room detail names its owner, which the gateway page needs to tell
the owner they may edit a room that is not publicly writable."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.rooms import _build_room_detail


class _NoRoles:
    async def list_roles(self, session: AsyncSession, room_id: str) -> list[Any]:
        return []

    async def live_holders_for_room(
        self, session: AsyncSession, room_id: str, live: set[str]
    ) -> dict[str, list[str]]:
        return {}


class _Protocol:
    room_role_store = _NoRoles()
    connections = SimpleNamespace(live_connection_ids=lambda: set())

    async def get_agent_statuses_by_ids_in_session(
        self, session: AsyncSession, room_id: str, agent_ids: list[str]
    ) -> dict[str, Any]:
        return {}


async def test_detail_carries_the_owner(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = User(name="owner", email="owner@example.com", role="user")
        session.add(owner)
        await session.flush()
        room = Room(
            transport_room_id="!owned:test",
            name="owned",
            description="",
            owner_id=owner.id,
            read_visibility="private",
            write_visibility="private",
        )
        session.add(room)
        await session.flush()

        detail = await _build_room_detail(
            session,
            room,
            RoomStore(),
            CollaborationBridgeStore(),
            ExternalUserStore(),
            _Protocol(),  # type: ignore[arg-type]
        )

    assert detail.owner_id == owner.id
    assert detail.owner_name == "owner"
