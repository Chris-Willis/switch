"""The routes an agent controller calls, mounted on the agent bridge.

All but two authenticate with a controller access token, which the bearer
middleware verifies and binds (`management/auth.py`); a route whose path
names a controller then requires it to be the token's own. Enrollment and
token exchange carry their secret in the body and resolve their tenant from
it here.

Every failure is answered in the contract's error envelope (`errors.py`).
`Switch-Controller-Protocol` is checked when sent, and every response says
which protocol versions this server accepts.
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.bridges.agent.dependencies import get_protocol, get_session
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.session_scope import tenant_session
from switch_core.management import reason_codes
from switch_core.management.auth import ManagementAuthenticator
from switch_core.management.dependencies import (
    get_authenticator,
    get_controller_principal,
    get_management,
    get_management_session_factory,
    require_controller,
)
from switch_core.management.errors import ManagementError, ManagementRoute, error_body
from switch_core.management.schemas import (
    MAX_STATUS_BYTES,
    EnrollRequest,
    OperationResultRequest,
    ProgressRequest,
    StatusReport,
    TokenRequest,
    wire_time,
)
from switch_core.management.service import ManagementService
from switch_core.management.stream import (
    KEEPALIVE_INTERVAL_SECONDS,
    STREAM_HEADERS,
    controller_event_stream,
)

PROTOCOL_HEADER = "Switch-Controller-Protocol"
PROTOCOL_ACCEPTS_HEADER = "Switch-Controller-Protocol-Accepts"
SUPPORTED_PROTOCOLS = "1-1"
_SUPPORTED_PROTOCOL_VERSIONS = frozenset({"1"})


class ControllerRoute(ManagementRoute):
    """A management route that also speaks the controller protocol header."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def versioned(request: Request) -> Response:
            requested = request.headers.get(PROTOCOL_HEADER)
            if requested is not None and requested.strip() not in (
                _SUPPORTED_PROTOCOL_VERSIONS
            ):
                response: Response = JSONResponse(
                    error_body(
                        reason_codes.PROTOCOL_UNSUPPORTED,
                        f"Controller protocol {requested!r} is not supported; "
                        f"this server accepts {SUPPORTED_PROTOCOLS}.",
                        retryable=False,
                    ),
                    status_code=426,
                )
            else:
                response = await handler(request)
            response.headers[PROTOCOL_ACCEPTS_HEADER] = SUPPORTED_PROTOCOLS
            return response

        return versioned


router = APIRouter(route_class=ControllerRoute, tags=["agent management"])

Principal = Annotated[ControllerPrincipal, Depends(get_controller_principal)]
Management = Annotated[ManagementService, Depends(get_management)]
Session = Annotated[AsyncSession, Depends(get_session)]


def _path_controller(controller_id: str, principal: Principal) -> ControllerPrincipal:
    return require_controller(controller_id, principal)


PathController = Annotated[ControllerPrincipal, Depends(_path_controller)]


def _etag(revision: int) -> str:
    return f'"{revision}"'


def _etag_matches(if_none_match: str | None, revision: int) -> bool:
    if if_none_match is None:
        return False
    for candidate in if_none_match.split(","):
        tag = candidate.strip()
        if tag == "*":
            return True
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag in (_etag(revision), str(revision)):
            return True
    return False


# ── Public: authenticated by the body ─────────────────────────────────────────


@router.post("/v1/management/controllers/enroll", status_code=201)
async def enroll_controller(
    body: EnrollRequest,
    management: Management,
    authenticator: Annotated[ManagementAuthenticator, Depends(get_authenticator)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_management_session_factory)
    ],
) -> dict[str, str]:
    tenant_id = await authenticator.tenant_of_secret(body.proof.code)
    if tenant_id is None:
        raise ManagementError(
            401,
            reason_codes.ENROLLMENT_CODE_INVALID,
            "The enrollment code is invalid, already used, or expired.",
        )
    async with tenant_session(session_factory, tenant_id) as session:
        controller, credential = await management.enroll(
            session,
            tenant_id,
            code=body.proof.code,
            description=body.controller,
            public_key=body.public_key,
        )
    return {"controller_id": controller.id, "credential": credential}


@router.post("/v1/management/controllers/{controller_id}/token")
async def exchange_token(
    controller_id: str,
    body: TokenRequest,
    management: Management,
    authenticator: Annotated[ManagementAuthenticator, Depends(get_authenticator)],
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_management_session_factory)
    ],
) -> dict[str, str]:
    tenant_id = await authenticator.tenant_of_secret(body.credential)
    if tenant_id is None:
        raise ManagementError(
            401, reason_codes.INVALID_CREDENTIAL, "The credential is not valid."
        )
    async with tenant_session(session_factory, tenant_id) as session:
        access_token, expires_at = await management.exchange_token(
            session,
            tenant_id,
            controller_id=controller_id,
            credential=body.credential,
        )
    return {"access_token": access_token, "expires_at": wire_time(expires_at)}


# ── Controller access token ───────────────────────────────────────────────────


@router.post("/v1/management/controllers/{controller_id}/credential/rotate")
async def rotate_credential(
    principal: PathController, management: Management, session: Session
) -> dict[str, str]:
    return {"credential": await management.rotate_credential(session, principal)}


@router.get("/v1/management/controllers/{controller_id}/assignment")
async def get_assignment(
    principal: PathController,
    management: Management,
    session: Session,
    if_none_match: Annotated[str | None, Header()] = None,
) -> Response:
    assignment = await management.assignment(session, principal)
    revision = assignment["revision"]
    headers = {"ETag": _etag(revision)}
    if _etag_matches(if_none_match, revision):
        return Response(status_code=304, headers=headers)
    return JSONResponse(assignment, headers=headers)


@router.put("/v1/management/controllers/{controller_id}/status")
async def put_status(
    request: Request,
    report: StatusReport,
    principal: PathController,
    management: Management,
    session: Session,
) -> dict[str, int]:
    if len(await request.body()) > MAX_STATUS_BYTES:
        raise ManagementError(
            413,
            reason_codes.VALIDATION_ERROR,
            f"A status report may be at most {MAX_STATUS_BYTES} bytes.",
        )
    return await management.record_status(session, principal, report)


@router.get("/v1/management/controllers/{controller_id}/operations")
async def list_operations(
    principal: PathController,
    management: Management,
    session: Session,
    state: str = "pending",
) -> dict[str, list[dict[str, Any]]]:
    if state != "pending":
        raise ManagementError(
            422,
            reason_codes.VALIDATION_ERROR,
            "Only state=pending can be listed by a controller.",
        )
    return {"operations": await management.offered_operations(session, principal)}


@router.post("/v1/management/operations/{operation_id}/claim")
async def claim_operation(
    operation_id: str, principal: Principal, management: Management, session: Session
) -> dict[str, Any]:
    return await management.claim_operation(session, principal, operation_id)


@router.post("/v1/management/operations/{operation_id}/progress", status_code=204)
async def operation_progress(
    operation_id: str,
    principal: Principal,
    management: Management,
    session: Session,
    body: ProgressRequest | None = None,
) -> Response:
    await management.renew_operation(session, principal, operation_id)
    return Response(status_code=204)


@router.post("/v1/management/operations/{operation_id}/result", status_code=204)
async def operation_result(
    operation_id: str,
    body: OperationResultRequest,
    principal: Principal,
    management: Management,
    session: Session,
) -> Response:
    await management.complete_operation(session, principal, operation_id, body.stored())
    return Response(status_code=204)


@router.post("/v1/management/controllers/{controller_id}/agents/{agent_id}/credentials")
async def agent_credentials(
    agent_id: str,
    principal: PathController,
    management: Management,
    session: Session,
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict[str, Any]:
    return await management.agent_credentials(session, principal, agent_id, protocol)


@router.get("/v1/controllers/{controller_id}/events")
async def controller_events(
    principal: PathController,
    management: Management,
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_management_session_factory)
    ],
) -> StreamingResponse:
    return StreamingResponse(
        controller_event_stream(
            principal=principal,
            service=management,
            session_factory=session_factory,
            keepalive_seconds=KEEPALIVE_INTERVAL_SECONDS,
        ),
        media_type="text/event-stream",
        headers=STREAM_HEADERS,
    )
