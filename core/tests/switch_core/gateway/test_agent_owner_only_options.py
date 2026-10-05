"""The agent directory is shared, but an agent's local folder on its owner's
machine (`known_agent_options.repo_dir`) is shown only to its owner and admins."""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.db.models import User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agents import get_agent_detail, list_agents
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user, is_admin

REPO_DIR = "/home/owner/src/project"


async def _seed(session: AsyncSession) -> tuple[User, str]:
    owner = await add_user(session, name="owner")
    agent = await add_agent(session, name="helper", owner_id=owner.id)
    agent.metadata_ = {
        "known_agent_type": "claude-code",
        "known_agent_options": {"repo_dir": REPO_DIR, "auto_session": True},
    }
    await session.flush()
    return owner, agent.id


async def _views(
    session: AsyncSession, agent_id: str, viewer: User
) -> tuple[dict | None, dict | None]:
    admin = await is_admin(session, viewer)
    detail = await get_agent_detail(
        agent_id,
        session,
        AgentStore(),
        RoomStore(),
        UserStore(),
        SimpleNamespace(  # type: ignore[arg-type]
            agent_session_store=AgentSessionStore(),
            room_role_store=RoomRoleStore(),
            connections=AgentConnectionRegistry(),
        ),
        viewer,
        admin,
    )
    [summary] = await list_agents(session, AgentStore(), UserStore(), viewer, admin)
    return detail.known_agent_options, summary.known_agent_options


async def test_the_owner_sees_the_local_folder(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, agent_id = await _seed(session)
        detail, summary = await _views(session, agent_id, owner)

    assert detail == {"repo_dir": REPO_DIR, "auto_session": True}
    assert summary == {"repo_dir": REPO_DIR, "auto_session": True}


async def test_an_admin_sees_the_local_folder(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        _owner, agent_id = await _seed(session)
        admin = await add_user(session, name="admin", role="admin")
        detail, summary = await _views(session, agent_id, admin)

    assert detail is not None and detail["repo_dir"] == REPO_DIR
    assert summary is not None and summary["repo_dir"] == REPO_DIR


async def test_another_member_does_not(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        _owner, agent_id = await _seed(session)
        other = await add_user(session, name="member")
        detail, summary = await _views(session, agent_id, other)

    assert detail == {"auto_session": True}
    assert summary == {"auto_session": True}
