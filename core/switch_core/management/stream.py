"""The controller's nudge stream (`GET /v1/controllers/{id}/events`).

In v1 the stream carries nudges only — `assignment.changed`,
`operation.pending` and `credential.revoked` — after a first
`connection_state` frame. Agent events stay on each agent's own stream. Same
framing as the agent stream (`bridges/agent/protocol/stream.py`): `event:` is
the type, `data:` is JSON, and a keepalive comment goes out whenever nothing
else has for a while, only so idle proxies keep the connection.

The subscription is taken before the first frame is built, so a change that
commits while the stream is opening is still delivered rather than falling
between the read and the wait.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.db.session_scope import tenant_session
from switch_core.management.notifier import CONNECTION_STATE, CREDENTIAL_REVOKED
from switch_core.management.service import ManagementService

KEEPALIVE_INTERVAL_SECONDS = 15.0
KEEPALIVE = b": keepalive\n\n"

STREAM_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def frame(event: str, data: dict[str, Any]) -> bytes:
    return (
        f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
    ).encode()


async def controller_event_stream(
    *,
    principal: ControllerPrincipal,
    service: ManagementService,
    session_factory: async_sessionmaker[AsyncSession],
    keepalive_seconds: float,
) -> AsyncIterator[bytes]:
    subscription = service.notifier.subscribe(principal.controller_id)
    try:
        async with tenant_session(session_factory, principal.tenant_id) as session:
            state = await service.connection_state(session, principal)
        yield frame(CONNECTION_STATE, state)
        while True:
            for event, data in subscription.drain():
                yield frame(event, data)
                if event == CREDENTIAL_REVOKED:
                    return
            try:
                await asyncio.wait_for(subscription.wake.wait(), keepalive_seconds)
            except TimeoutError:
                yield KEEPALIVE
    finally:
        subscription.close()
