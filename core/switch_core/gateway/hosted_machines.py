from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.api.hosted_worker_routes import post_mailbox_notices
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import HostedMachine, User, require_tenant_id
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.hosted_machine_store import HostedMachineStore, idle_sleeping
from switch_core.db.stores.hosted_mailbox_store import HostedMailboxStore, MailboxNotice
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_protocol, get_session
from switch_core.gateway.hosted_launches import ring_mailbox_cancel

router = APIRouter(prefix="/hosted-machines")

RETIRED_STATES = frozenset({"retained", "deleting", "deleted"})


def _usage(heartbeat: dict | None, key: str) -> dict | None:
    reading = None if heartbeat is None else heartbeat.get(key)
    if reading is None:
        return None
    return {
        "total_bytes": reading["total_bytes"],
        "available_bytes": reading["available_bytes"],
    }


async def machine_summary(session: AsyncSession, machine: HostedMachine) -> dict:
    launches = await HostedMachineStore().launches(session, machine.id)
    return {
        "machine_id": machine.id,
        "state": machine.state,
        "desired_state": machine.desired_state,
        "stop_reason": machine.stop_reason,
        "sleeping": idle_sleeping(machine),
        "revision": machine.revision,
        "instance_type": machine.instance_type,
        "error": machine.error,
        "error_code": machine.error_code,
        "retain_until": None
        if machine.retain_until is None
        else machine.retain_until.isoformat(),
        "heartbeat_at": None
        if machine.heartbeat_at is None
        else machine.heartbeat_at.isoformat(),
        "disk": _usage(machine.heartbeat, "disk"),
        "memory": _usage(machine.heartbeat, "memory"),
        "agents": [launch.id for launch in launches],
    }


async def _owned(
    session: AsyncSession, machine_id: str, owner_id: str
) -> HostedMachine:
    machine = await HostedMachineStore().owned(session, machine_id, owner_id)
    if machine is None:
        raise HTTPException(404, "Cloud machine not found.")
    return machine


@router.get("")
async def owned_machines(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    machines = await session.scalars(
        select(HostedMachine)
        .where(
            HostedMachine.tenant_id == require_tenant_id(),
            HostedMachine.owner_id == user.id,
            HostedMachine.state != "deleted",
        )
        .order_by(HostedMachine.created_at)
    )
    return {"machines": [await machine_summary(session, row) for row in machines]}


@router.get("/{machine_id}")
async def status(
    machine_id: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    return await machine_summary(session, await _owned(session, machine_id, user.id))


class MachineLifecycleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["stop", "start", "retry"]
    revision: int = Field(ge=1)


@router.post("/{machine_id}/lifecycle")
async def lifecycle(
    machine_id: str,
    body: MachineLifecycleRequest,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict:
    machines = HostedMachineStore()
    await _owned(session, machine_id, user.id)
    machine = await machines.locked(session, machine_id)
    assert machine is not None
    if machine.revision != body.revision and not (
        idle_sleeping(machine) and machine.revision == body.revision + 1
    ):
        raise HTTPException(409, "revision mismatch")
    if machine.state in RETIRED_STATES or machine.desired_state in RETIRED_STATES:
        raise HTTPException(409, f"machine is {machine.desired_state}")
    now = datetime.now(UTC)
    cancelled: list[MailboxNotice] = []
    cancel_requested: dict[str, list[tuple[str, str]]] = {}
    if body.action == "stop":
        machines.stop(machine, "owner", now)
        mailbox = HostedMailboxStore()
        for candidate in await machines.launches(session, machine.id):
            launch = await HostedLaunchStore().locked(session, candidate.id)
            if launch is None or launch.desired_state == "deleted":
                continue
            split = await mailbox.stop(session, launch.id)
            cancelled.extend(split.cancelled)
            if launch.agent_id and split.cancel_requested:
                cancel_requested[launch.agent_id] = split.cancel_requested
    elif body.action == "start":
        machines.start(machine, now)
    else:
        if machine.state != "error":
            raise HTTPException(409, "Only a machine in error can be retried.")
        machines.retry(machine, now)
    await session.commit()
    for agent_id, entries in cancel_requested.items():
        ring_mailbox_cancel(protocol, agent_id, entries)
    await post_mailbox_notices(protocol, cancelled)
    return {"machine": await machine_summary(session, machine)}
