"""A management app wired the way `main` wires it, against the test database.

The agent bridge side is a bare FastAPI app behind the real
`BearerAuthMiddleware` with the real `ManagementAuthenticator`; the gateway
side is mounted at `/gateway` with the real `get_current_user`. Only what
those need from the rest of the server is stubbed: the agent bridge's session
and protocol, and the gateway's config. The protocol is a real
`AgentCore` with its collaborators faked out, so registration and key
rotation write real rows.

Requests go through `httpx.AsyncClient` over `ASGITransport`, for the reason
`gateway/test_tenant_resolution.py` gives.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent import dependencies as bridge_deps
from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import TENANT_ZERO_ID, Client, TenantMember, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.management.wiring import Management, build_management

JWT_SECRET = "unit-test-jwt-key-unit-test-jwt-key-unit-test"  # gitleaks:allow
TOKEN_SECRET = "unit-test-controller-token-secret-0123456789"  # gitleaks:allow
STATUS_INTERVAL = 60

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "agent_controllers"


def fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


@dataclass
class Clock:
    """A clock a test moves by hand."""

    now: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now = self.now + timedelta(**delta)


class _FakeClientLifecycle:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def stop(self, client_id: str) -> None:
        return None

    async def delete_record(self, session: AsyncSession, client_id: str) -> None:
        return None

    async def create_client(self, *, client_type: str, display_name: str) -> Client:
        async with self._session_factory() as session:
            client = Client(
                transport_user_id=f"@{display_name}:test",
                display_name=display_name,
                type=client_type,
            )
            session.add(client)
            await session.commit()
            return client

    def start_client(self, client: Client) -> None:
        return None


class _NoBridges:
    def bridges_for_tenant(self, tenant_id: str) -> list[object]:
        return []


def protocol_service(
    session_factory: async_sessionmaker[AsyncSession], cache: ApiKeyCache
) -> AgentCore:
    svc = object.__new__(AgentCore)
    svc.session_factory = session_factory  # type: ignore[assignment]
    svc.agent_store = AgentStore()
    svc.api_key_store = ApiKeyStore()
    svc.api_key_cache = cache
    svc.client_lifecycle = _FakeClientLifecycle(session_factory)  # type: ignore[assignment]
    svc.collab_lifecycle = _NoBridges()  # type: ignore[assignment]
    svc.config = SimpleNamespace(jwt_secret_key=JWT_SECRET)  # type: ignore[assignment]
    svc.telemetry = None
    svc.event_buffer = SimpleNamespace(remove=lambda _agent_id: None)  # type: ignore[assignment]
    return svc


@dataclass
class Harness:
    app: FastAPI
    management: Management
    protocol: AgentCore
    cache: ApiKeyCache
    clock: Clock
    session_factory: async_sessionmaker[AsyncSession]

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://test"
        )

    def middleware(self) -> BearerAuthMiddleware:
        async def _app(scope: Any, receive: Any, send: Any) -> None:
            return None

        return BearerAuthMiddleware(
            _app,
            agent_store=AgentStore(),
            api_key_store=ApiKeyStore(),
            api_key_cache=self.cache,
            session_factory=self.session_factory,
            controller_auth=self.management.authenticator,
        )


def build_harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    clock = Clock()
    management = build_management(
        token_secret=TOKEN_SECRET,
        status_interval_seconds=STATUS_INTERVAL,
        session_factory=session_factory,
        clock=clock,
    )
    cache = ApiKeyCache(ttl_seconds=5, max_entries=64)
    protocol = protocol_service(session_factory, cache)

    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    agent_app = FastAPI()
    gateway_app = FastAPI()
    management.install(
        agent_bridge_app=agent_app, gateway_app=gateway_app, protocol=protocol
    )

    agent_app.dependency_overrides[bridge_deps.get_session] = _session
    agent_app.dependency_overrides[bridge_deps.get_protocol] = lambda: protocol

    gateway_app.dependency_overrides[gw_deps.get_session] = _session
    gateway_app.dependency_overrides[gw_deps.get_session_factory] = lambda: (
        session_factory
    )
    gateway_app.dependency_overrides[gw_deps.get_user_store] = lambda: UserStore()
    gateway_app.dependency_overrides[gw_deps.get_protocol] = lambda: protocol
    gateway_app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        jwt_secret_key=JWT_SECRET, gateway_tenant_choice_enabled=False
    )
    agent_app.mount("/gateway", gateway_app)
    agent_app.add_middleware(
        BearerAuthMiddleware,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=cache,
        session_factory=session_factory,
        controller_auth=management.authenticator,
    )
    return Harness(
        app=agent_app,
        management=management,
        protocol=protocol,
        cache=cache,
        clock=clock,
        session_factory=session_factory,
    )


async def add_member(
    session_factory: async_sessionmaker[AsyncSession],
    name: str,
    tenant_id: str = TENANT_ZERO_ID,
) -> User:
    async with session_factory() as session:
        user = User(name=name, email=f"{name}@example.invalid", role="user")
        session.add(user)
        await session.flush()
        session.add(TenantMember(tenant_id=tenant_id, user_id=user.id, role="member"))
        await session.commit()
        return user


def cookies_for(user: User, tenant_id: str = TENANT_ZERO_ID) -> dict[str, str]:
    return {
        "switch_auth": create_jwt(user.id, user.email, user.role, JWT_SECRET, tenant_id)
    }


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def platform() -> dict[str, str]:
    return {"os": "linux", "arch": "x64", "os_version": "6.1.0"}


def status_report(
    seq: int,
    *,
    providers: list[dict[str, Any]] | None = None,
    agents: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The status fixture, with its sequence and optionally its lists replaced."""
    report = fixture("status_request.json")
    report["seq"] = seq
    if providers is not None:
        report["providers"] = providers
    if agents is not None:
        report["agents"] = agents
    return report


def provider(name: str, *, installed: bool = True, auth: str = "ok") -> dict[str, Any]:
    return {
        "provider": name,
        "installed": installed,
        "version": "1.0.0" if installed else None,
        "auth": auth,
        "auth_source": "local" if installed else None,
        "checked_at": "2026-01-01T00:00:00Z",
    }


@dataclass
class EnrolledController:
    controller_id: str
    credential: str
    access_token: str
    owner: User

    @property
    def headers(self) -> dict[str, str]:
        return bearer(self.access_token)


async def enroll_console(
    harness: Harness, client: httpx.AsyncClient, owner: User, name: str = "laptop"
) -> EnrolledController:
    """Enroll a console controller for `owner` and exchange its credential."""
    response = await client.post(
        "/gateway/management/controllers",
        json={
            "name": name,
            "kind": "console",
            "platform": platform(),
            "version": "0.1.0",
        },
        cookies=cookies_for(owner),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    token = await client.post(
        f"/v1/management/controllers/{body['controller_id']}/token",
        json={"credential": body["credential"]},
    )
    assert token.status_code == 200, token.text
    return EnrolledController(
        controller_id=body["controller_id"],
        credential=body["credential"],
        access_token=token.json()["access_token"],
        owner=owner,
    )


async def report_status(
    client: httpx.AsyncClient,
    controller: EnrolledController,
    seq: int,
    *,
    providers: list[dict[str, Any]] | None = None,
    agents: list[dict[str, Any]] | None = None,
) -> httpx.Response:
    return await client.put(
        f"/v1/management/controllers/{controller.controller_id}/status",
        json=status_report(seq, providers=providers, agents=agents),
        headers=controller.headers,
    )


def definition(provider_name: str = "claude", **overrides: Any) -> dict[str, Any]:
    return {
        "provider": provider_name,
        "model": None,
        "instructions": "",
        "auto_session": True,
        "auto_approve": False,
        "directory": None,
        **overrides,
    }


async def create_managed_agent(
    client: httpx.AsyncClient,
    owner: User,
    *,
    name: str,
    controller_id: str | None,
    desired_state: str = "running",
    definition_body: dict[str, Any] | None = None,
) -> httpx.Response:
    return await client.post(
        "/gateway/management/agents",
        json={
            "name": name,
            "description": f"{name} description",
            "controller_id": controller_id,
            "desired_state": desired_state,
            "definition": definition_body or definition(),
        },
        cookies=cookies_for(owner),
    )
