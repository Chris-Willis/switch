"""Persisting each controller's stream connection, so any process can tell
whether the machine is connected.

Core's `ControllerPresence` decides when a controller's connection opens,
beats and closes, in the memory of the process that holds the stream. It
tells this ledger as each happens, and the ledger writes the connection's
state to the controller's row (`connection_id`, `connected_at`,
`connection_beat_at`, `disconnected_at`, `disconnect_reason`), which is what
a machine's online state is read from (`placement.controller_state`).

Writes are coalesced per controller: only the latest state of each is held,
and it is written when presence is asked to persist. Openings and closings
are always written. Beats are throttled: one is written only when the last
beat written for the same connection is at least `BEAT_PERSIST_INTERVAL`
old, so a controller beating every two seconds costs a write every six.
`PERSISTED_BEAT_STALE_AFTER` is how old a written beat may be before the
connection is read as gone without a closing ever having been written: the
process holding it died, or lost the database. It covers the throttle, one
beat interval of rounding, and the heartbeat TTL, plus a margin for a write
that queues behind others.

Which write wins, across processes: an opening or a beat comes from the
process holding the live connection, and replaces whatever the row holds. A
closing only updates the row while it still names that connection, so a
process that sweeps a connection the controller has since replaced through
another process leaves the replacement standing. (Clocks are not compared:
two processes' clocks need not agree.)

A write that fails is kept, unless something newer for the same controller
has arrived meanwhile, and written by the next flush.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import (
    ControllerConnection,
)
from switch_core.bridges.agent.protocol.liveness import (
    HEARTBEAT_INTERVAL_SECONDS,
    HEARTBEAT_TTL_SECONDS,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_store import AgentControllerStore

BEAT_PERSIST_INTERVAL = timedelta(seconds=5)

# How old the written beat of a live connection can be: the throttle and one
# beat interval of rounding, plus the TTL its next beat must arrive within.
LIVE_BEAT_LAG = BEAT_PERSIST_INTERVAL + timedelta(
    seconds=HEARTBEAT_INTERVAL_SECONDS + HEARTBEAT_TTL_SECONDS
)

PERSISTED_BEAT_STALE_AFTER = timedelta(seconds=15)


@dataclass(frozen=True)
class _ConnectionRecord:
    tenant_id: str
    controller_id: str
    connection_id: str
    connected_at: datetime
    beat_at: datetime
    disconnected_at: datetime | None
    disconnect_reason: str | None
    # The connection is live (an opening or a beat), or its opening was
    # never written: the record replaces whatever the row holds, rather than
    # updating the connection the row names.
    replaces: bool


class ControllerConnectionLedger:
    """Core's `ControllerConnectionLedger`, written to `agent_controllers`."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        controllers: AgentControllerStore,
        clock: Callable[[], datetime],
    ) -> None:
        self._session_factory = session_factory
        self._controllers = controllers
        self._clock = clock
        self._pending: dict[str, _ConnectionRecord] = {}
        # The connection each controller's last written beat was for, and
        # that beat's time, which the throttle measures from.
        self._beat_written: dict[str, tuple[str, datetime]] = {}
        self._lock = asyncio.Lock()

    def _wall(self, *monotonic_at: float) -> list[datetime]:
        """`time.monotonic()` readings as times on the ledger's clock."""
        wall_now, monotonic_now = self._clock(), time.monotonic()
        return [wall_now - timedelta(seconds=monotonic_now - at) for at in monotonic_at]

    def _record(
        self,
        conn: ControllerConnection,
        *,
        disconnected_at: datetime | None,
        disconnect_reason: str | None,
        replaces: bool,
    ) -> _ConnectionRecord:
        connected_at, beat_at = self._wall(conn.opened_at, conn.last_beat)
        return _ConnectionRecord(
            tenant_id=conn.tenant_id,
            controller_id=conn.controller_id,
            connection_id=conn.id,
            connected_at=connected_at,
            beat_at=beat_at,
            disconnected_at=disconnected_at,
            disconnect_reason=disconnect_reason,
            replaces=replaces,
        )

    def _pending_replacement(self, conn: ControllerConnection) -> bool:
        """Whether a replacing write for this connection is still pending."""
        pending = self._pending.get(conn.controller_id)
        return (
            pending is not None
            and pending.connection_id == conn.id
            and pending.replaces
        )

    def opened(self, conn: ControllerConnection) -> None:
        self._pending[conn.controller_id] = self._record(
            conn, disconnected_at=None, disconnect_reason=None, replaces=True
        )

    def beat(self, conn: ControllerConnection) -> None:
        pending = self._pending.get(conn.controller_id)
        if pending is not None and pending.connection_id == conn.id:
            if pending.disconnected_at is None:
                [beat_at] = self._wall(conn.last_beat)
                self._pending[conn.controller_id] = replace(pending, beat_at=beat_at)
            return
        record = self._record(
            conn, disconnected_at=None, disconnect_reason=None, replaces=True
        )
        written = self._beat_written.get(conn.controller_id)
        if (
            written is not None
            and written[0] == conn.id
            and record.beat_at - written[1] < BEAT_PERSIST_INTERVAL
        ):
            return
        self._pending[conn.controller_id] = record

    def closed(self, conn: ControllerConnection, reason: str) -> None:
        pending = self._pending.get(conn.controller_id)
        if (
            pending is not None
            and pending.connection_id != conn.id
            and pending.replaces
        ):
            # A newer connection's write is pending and will replace the row.
            return
        self._pending[conn.controller_id] = self._record(
            conn,
            disconnected_at=self._clock(),
            disconnect_reason=reason,
            replaces=self._pending_replacement(conn),
        )

    async def flush(self, controller_id: str) -> None:
        async with self._lock:
            record = self._pending.pop(controller_id, None)
            if record is not None:
                await self._write([record])

    async def flush_all(self) -> None:
        async with self._lock:
            records = list(self._pending.values())
            self._pending.clear()
            if records:
                await self._write(records)

    async def _write(self, records: list[_ConnectionRecord]) -> None:
        by_tenant: dict[str, list[_ConnectionRecord]] = {}
        for record in records:
            by_tenant.setdefault(record.tenant_id, []).append(record)
        unwritten = list(records)
        try:
            for tenant_id, batch in by_tenant.items():
                async with tenant_session(self._session_factory, tenant_id) as session:
                    for record in batch:
                        await self._controllers.record_connection(
                            session,
                            tenant_id,
                            record.controller_id,
                            connection_id=record.connection_id,
                            connected_at=record.connected_at,
                            beat_at=record.beat_at,
                            disconnected_at=record.disconnected_at,
                            disconnect_reason=record.disconnect_reason,
                            replaces=record.replaces,
                        )
                    await session.commit()
                for record in batch:
                    unwritten.remove(record)
                    self._written(record)
        except BaseException:
            for record in unwritten:
                self._requeue(record)
            raise

    def _requeue(self, record: _ConnectionRecord) -> None:
        """Keep a record that failed to write, unless a newer one for the same
        controller has arrived; a newer one for the same connection inherits
        the failed one's replacing the row."""
        newer = self._pending.get(record.controller_id)
        if newer is None:
            self._pending[record.controller_id] = record
        elif newer.connection_id == record.connection_id and record.replaces:
            self._pending[record.controller_id] = replace(newer, replaces=True)

    def _written(self, record: _ConnectionRecord) -> None:
        if record.disconnected_at is None:
            self._beat_written[record.controller_id] = (
                record.connection_id,
                record.beat_at,
            )
        else:
            self._beat_written.pop(record.controller_id, None)
