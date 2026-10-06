"""Move cloud machines from the per-agent worker to the shared agent controller.

    switch-migrate-hosted-to-controller (--machine ID | --all)
        [--dry-run] [--rollback | --finalize]

Migrating a machine, under its owner's provider-connection lock and the
machine lock, in one transaction:

- links the owner's ec2 controller to the machine, creating it if the owner
  has none;
- seals, with KMS, every provider login the owner holds a keyring copy of
  that is not already sealed for that controller at its current verification;
- gives each of the machine's hosted agents an `agent_definitions` row with
  the same agent id, placed on that controller: its provider, model, Claude
  agent definition and instructions (as one block of instructions), its
  repository, `auto_approve`, `isolation=isolated`, the launch's desired state,
  and the worktree the worker used as its directory. `auto_session` stays
  where the launch registered it, in the agent's known-agent options;
- settles each of those agents' launches at its desired state (`ready`, or
  `stopped`), clearing any error: no worker reports a launch once the
  controller runs it, so one left starting or in error would stay so;
- sets the machine's runtime to `controller` and bumps its revision, so the
  hosted controller replaces the instance on the controller image.

Running it again changes nothing that is already done: an agent with a
definition on the controller keeps it, a login sealed since it was last
verified is not sealed again, and a settled launch stays as it is.

The keyring copies of the logins stay, so `--rollback` can return the machine
to the worker: it removes those agents' definitions, sets the runtime back to
`worker` and bumps the revision. The controller link and the sealed copies
stay, for a later migration. Once the machine runs well on the controller,
`--finalize` deletes the keyring copies of every login sealed for it; after
that a rollback is refused until the owner logs in again. A login made while
the machine is on the controller runtime is only ever sealed, so it too
blocks a rollback.

`--dry-run` prints the plan, which names no secret, and changes nothing.

This runs outside switch-core, so nothing here reaches the running Core's
in-memory bindings or its controllers' streams directly. Core reads the
placements and sealed logins back every few seconds (`management/reload.py`):
it binds or unbinds the agents, tells their controller its assignment
changed, and announces each login sealed here to a controller that is
already running, as `provider.credential_changed`.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.config import SwitchConfig
from switch_core.db.engine import create_engine_from_config, create_session_factory
from switch_core.db.models import (
    Agent,
    AgentController,
    HostedLaunch,
    HostedMachine,
    ProviderConnection,
    SealedProviderCredential,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_machine_store import HostedMachineStore, bump_revision
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.gateway.hosted_launches import worktree_path
from switch_core.logging_config import configure_logging
from switch_core.management.schemas import DefinitionV1, RepositoryRef
from switch_core.management.service import ManagementService
from switch_core.management.wiring import create_management
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.providers.sealing import (
    SEALED_PROVIDERS,
    kms_settings,
    seal_for_controller,
)
from switch_core.version import switch_core_version

Action = Literal["migrate", "rollback", "finalize"]


class MigrationRefused(RuntimeError):
    """A machine cannot be migrated, rolled back or finalized as asked; the
    message says why."""


@dataclass(frozen=True)
class _AgentPlan:
    launch: HostedLaunch
    agent_id: str
    definition: DefinitionV1


def _instructions(spec: dict) -> str:
    parts = [spec.get("definition") or "", spec.get("instructions") or ""]
    return "\n\n".join(part.strip() for part in parts if part.strip())


def _definition(launch: HostedLaunch, agent_id: str) -> DefinitionV1:
    spec = launch.spec
    missing = [key for key in ("installation_id", "repository_id") if key not in spec]
    if missing:
        raise MigrationRefused(
            f"Cloud launch {launch.id} (agent {agent_id}) has no {', '.join(missing)} "
            "in its spec, so its repository cannot be carried over."
        )
    model = spec.get("definition_attributes", {}).get("model")
    try:
        return DefinitionV1(
            provider=spec.get("provider", "claude"),
            model=model or None,
            instructions=_instructions(spec),
            auto_approve=spec["auto_approve"],
            directory=worktree_path(agent_id, launch.repository),
            isolation="isolated",
            repository=RepositoryRef(
                installation_id=spec["installation_id"],
                repository_id=spec["repository_id"],
            ),
        )
    except ValueError as error:
        raise MigrationRefused(
            f"Cloud launch {launch.id} (agent {agent_id}) cannot be expressed as an "
            f"agent definition: {error}"
        ) from error


async def _locked_machine(session: AsyncSession, machine_id: str) -> HostedMachine:
    store = HostedMachineStore()
    candidate = await store.get(session, machine_id)
    if candidate is None:
        raise MigrationRefused(f"No cloud machine {machine_id}.")
    await ProviderConnectionStore().wait_user(session, candidate.owner_id)
    machine = await store.locked(session, machine_id)
    if machine is None:
        raise MigrationRefused(f"No cloud machine {machine_id}.")
    if machine.state == "deleted" or machine.desired_state == "deleted":
        raise MigrationRefused(f"Cloud machine {machine_id} is deleted.")
    return machine


async def _hosted_agents(
    session: AsyncSession, machine: HostedMachine
) -> list[tuple[HostedLaunch, str]]:
    agents = []
    for launch in await HostedMachineStore().launches(session, machine.id):
        if (
            launch.agent_id is None
            or launch.desired_state == "deleted"
            or launch.state in {"deleting", "deleted"}
        ):
            continue
        agents.append((launch, launch.agent_id))
    return agents


async def _keyring_logins(
    session: AsyncSession, owner_id: str
) -> list[ProviderConnection]:
    return list(
        await session.scalars(
            select(ProviderConnection)
            .where(
                ProviderConnection.tenant_id == require_tenant_id(),
                ProviderConnection.user_id == owner_id,
                ProviderConnection.provider.in_(SEALED_PROVIDERS),
                ProviderConnection.encrypted_credential.is_not(None),
            )
            .order_by(ProviderConnection.provider)
        )
    )


async def _sealed(
    session: AsyncSession, controller_id: str | None, connection: ProviderConnection
) -> bool:
    """Whether the login is sealed for the controller since it was last verified."""
    if controller_id is None:
        return False
    row = await session.scalar(
        select(SealedProviderCredential).where(
            SealedProviderCredential.tenant_id == require_tenant_id(),
            SealedProviderCredential.controller_id == controller_id,
            SealedProviderCredential.provider == connection.provider,
        )
    )
    return (
        row is not None
        and row.status == "connected"
        and row.updated_at >= connection.verified_at
    )


def _settled_state(launch: HostedLaunch) -> str:
    return "stopped" if launch.desired_state == "stopped" else "ready"


def _describe(plan: _AgentPlan) -> str:
    definition = plan.definition
    assert definition.repository is not None
    return (
        f"provider={definition.provider} model={definition.model or '-'} "
        f"isolation={definition.isolation} auto_approve={definition.auto_approve} "
        f"auto_session={plan.launch.spec.get('auto_session')} "
        f"repository={definition.repository.installation_id}/"
        f"{definition.repository.repository_id} directory={definition.directory} "
        f"desired_state={plan.launch.desired_state} "
        f"instructions={len(definition.instructions.encode())} bytes"
    )


async def migrate_machine(
    session: AsyncSession,
    config: SwitchConfig,
    service: ManagementService,
    machine_id: str,
    *,
    dry_run: bool,
    now: datetime,
) -> list[str]:
    tenant_id = require_tenant_id()
    machine = await _locked_machine(session, machine_id)
    lines = [f"machine {machine.id} owner={machine.owner_id} runtime={machine.runtime}"]
    plans: list[_AgentPlan] = []
    for launch, agent_id in await _hosted_agents(session, machine):
        agent = await session.get(Agent, agent_id)
        if agent is None:
            raise MigrationRefused(
                f"Cloud launch {launch.id} names agent {agent_id}, which does not exist."
            )
        if agent.owner_id != machine.owner_id or launch.owner_id != machine.owner_id:
            raise MigrationRefused(
                f"Agent {agent_id} on cloud machine {machine.id} is not its owner's."
            )
        plans.append(_AgentPlan(launch, agent_id, _definition(launch, agent_id)))

    existing = {
        plan.agent_id: await service.definitions.get_for_agent(
            session, tenant_id, plan.agent_id
        )
        for plan in plans
    }
    if dry_run:
        controller_id = machine.controller_id
        lines.append(
            f"  controller: {controller_id}"
            if controller_id is not None
            else "  controller: link the owner's ec2 controller, or create one"
        )
    else:
        controller, linked = await service.cloud_controller(session, machine)
        controller_id = controller.id
        lines.append(
            f"  controller: {controller_id} ({'linked now' if linked else 'linked'})"
        )
    for plan in plans:
        row = existing[plan.agent_id]
        if row is not None and (
            row.controller_id is None or row.controller_id != controller_id
        ):
            raise MigrationRefused(
                f"Agent {plan.agent_id} already has a definition placed on "
                f"{row.controller_id or 'no controller'}; move or delete it first."
            )

    to_seal = [
        connection
        for connection in await _keyring_logins(session, machine.owner_id)
        if not await _sealed(session, controller_id, connection)
    ]
    for connection in to_seal:
        lines.append(f"  seal login: {connection.provider} ({connection.kind})")
    created = 0
    for plan in plans:
        if existing[plan.agent_id] is not None:
            lines.append(
                f"  agent {plan.agent_id} ({plan.launch.name}): already placed"
            )
            continue
        lines.append(f"  agent {plan.agent_id} ({plan.launch.name}): {_describe(plan)}")
        created += 1
    unsettled = [
        plan.launch
        for plan in plans
        if plan.launch.state != _settled_state(plan.launch)
        or plan.launch.error is not None
        or plan.launch.error_code is not None
    ]
    for launch in unsettled:
        lines.append(
            f"  launch {launch.id} ({launch.name}): state {launch.state} -> "
            f"{_settled_state(launch)}"
        )
    lines.append(
        "  runtime: already controller"
        if machine.runtime == "controller"
        else "  runtime: worker -> controller, revision bump"
    )
    if dry_run:
        await session.rollback()
        return lines

    assert controller_id is not None
    controller_row = await session.get(AgentController, controller_id)
    assert controller_row is not None
    if to_seal:
        settings = kms_settings(config)
        for connection in to_seal:
            assert connection.encrypted_credential is not None
            await seal_for_controller(
                session,
                settings,
                controller_row,
                provider=connection.provider,
                kind=connection.kind,
                credential=config.keyring.decrypt(connection.encrypted_credential),
                now=now,
            )
    for plan in plans:
        if existing[plan.agent_id] is not None:
            continue
        await service.definitions.create(
            session,
            agent_id=plan.agent_id,
            owner_id=machine.owner_id,
            controller_id=controller_id,
            desired_state=plan.launch.desired_state,
            definition=plan.definition.model_dump(),
        )
    if created:
        await service.controllers.bump_assignment_revision(
            session, tenant_id, controller_id
        )
    for launch in unsettled:
        launch.state = _settled_state(launch)
        launch.error = None
        launch.error_code = None
        launch.updated_at = now
    if machine.runtime != "controller":
        machine.runtime = "controller"
        bump_revision(machine, now)
    await session.commit()
    return lines


async def rollback_machine(
    session: AsyncSession,
    service: ManagementService,
    machine_id: str,
    *,
    dry_run: bool,
    now: datetime,
) -> list[str]:
    tenant_id = require_tenant_id()
    machine = await _locked_machine(session, machine_id)
    lines = [f"machine {machine.id} owner={machine.owner_id} runtime={machine.runtime}"]
    unsealed_only = list(
        await session.scalars(
            select(ProviderConnection.provider)
            .where(
                ProviderConnection.tenant_id == require_tenant_id(),
                ProviderConnection.user_id == machine.owner_id,
                ProviderConnection.provider.in_(SEALED_PROVIDERS),
                ProviderConnection.encrypted_credential.is_(None),
            )
            .order_by(ProviderConnection.provider)
        )
    )
    if unsealed_only and machine.runtime == "controller":
        raise MigrationRefused(
            f"Cloud machine {machine.id}: the owner's {', '.join(unsealed_only)} "
            "login is only sealed for the controller (finalized, or logged in since "
            "migrating), so the worker would have none. The owner must log in again "
            "after the rollback, or stay on the controller."
        )
    controller_id = machine.controller_id
    removed: list[str] = []
    if controller_id is not None:
        for launch, agent_id in await _hosted_agents(session, machine):
            row = await service.definitions.get_for_agent(session, tenant_id, agent_id)
            if row is None or row.controller_id != controller_id:
                continue
            lines.append(f"  agent {agent_id} ({launch.name}): remove definition")
            removed.append(agent_id)
        hosted = set(removed)
        for row, agent in await service.definitions.list_for_controller(
            session, tenant_id, controller_id
        ):
            if row.agent_id not in hosted:
                lines.append(
                    f"  agent {row.agent_id} ({agent.name}): not a hosted launch; "
                    "stays placed on the controller, which does not run on the worker"
                )
    lines.append(
        "  runtime: already worker"
        if machine.runtime == "worker"
        else "  runtime: controller -> worker, revision bump"
    )
    lines.append("  sealed logins: kept")
    if dry_run:
        await session.rollback()
        return lines
    assert controller_id is not None or not removed
    for agent_id in removed:
        assert controller_id is not None
        await service.definitions.delete(session, tenant_id, agent_id)
        await service.operations.cancel_open(
            session, tenant_id, controller_id=controller_id, agent_id=agent_id
        )
    if removed and controller_id is not None:
        await service.controllers.bump_assignment_revision(
            session, tenant_id, controller_id
        )
    if machine.runtime != "worker":
        machine.runtime = "worker"
        bump_revision(machine, now)
    await session.commit()
    return lines


async def finalize_machine(
    session: AsyncSession, machine_id: str, *, dry_run: bool
) -> list[str]:
    machine = await _locked_machine(session, machine_id)
    if machine.runtime != "controller" or machine.controller_id is None:
        raise MigrationRefused(
            f"Cloud machine {machine.id} is not on the controller runtime; migrate "
            "it before finalizing."
        )
    lines = [f"machine {machine.id} owner={machine.owner_id} runtime={machine.runtime}"]
    connections = await _keyring_logins(session, machine.owner_id)
    unsealed = [
        connection.provider
        for connection in connections
        if not await _sealed(session, machine.controller_id, connection)
    ]
    if unsealed:
        raise MigrationRefused(
            f"Cloud machine {machine.id}: the owner's {', '.join(unsealed)} login is "
            "not sealed for its controller at its current verification. Run the "
            "migration again before finalizing."
        )
    for connection in connections:
        lines.append(f"  delete keyring copy: {connection.provider}")
    if not connections:
        lines.append("  no keyring copies left")
    if dry_run:
        await session.rollback()
        return lines
    for connection in connections:
        connection.encrypted_credential = None
    await session.commit()
    return lines


async def selected_machines(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_id: str,
    machine_id: str | None,
) -> list[str]:
    if machine_id is not None:
        return [machine_id]
    async with tenant_session(session_factory, tenant_id) as session:
        return list(
            await session.scalars(
                select(HostedMachine.id)
                .where(
                    HostedMachine.tenant_id == tenant_id,
                    HostedMachine.state != "deleted",
                    HostedMachine.desired_state != "deleted",
                )
                .order_by(HostedMachine.created_at)
            )
        )


async def run(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_id: str,
    config: SwitchConfig,
    service: ManagementService,
    *,
    machine_id: str | None,
    action: Action,
    dry_run: bool,
) -> list[str]:
    """Migrate, roll back or finalize the selected machines, each in a
    transaction of its own, and return what was (or would be) done."""
    lines: list[str] = []
    for selected in await selected_machines(session_factory, tenant_id, machine_id):
        async with tenant_session(session_factory, tenant_id) as session:
            now = datetime.now(UTC)
            if action == "migrate":
                lines += await migrate_machine(
                    session, config, service, selected, dry_run=dry_run, now=now
                )
            elif action == "rollback":
                lines += await rollback_machine(
                    session, service, selected, dry_run=dry_run, now=now
                )
            else:
                lines += await finalize_machine(session, selected, dry_run=dry_run)
    if dry_run:
        lines.append("dry run: nothing was changed")
    return lines


def _no_bound_connections(agent_id: str) -> None:
    return None


async def _main(
    config: SwitchConfig, machine_id: str | None, action: Action, dry_run: bool
) -> list[str]:
    if not config.hosted_controller_config_path:
        raise MigrationRefused(
            "HOSTED_CONTROLLER_CONFIG_PATH is not set: there are no cloud machines."
        )
    tenant_id = HostedControllerSettings.model_validate_json(
        Path(config.hosted_controller_config_path).read_text()
    ).tenant_id
    engine = create_engine_from_config(config)
    try:
        factory = create_session_factory(engine)
        management = create_management(
            config, factory, ControllerPresence(on_bound=_no_bound_connections)
        )
        if management is None:
            raise MigrationRefused(
                "AGENT_MANAGEMENT_ENABLED is off: the shared agent controller "
                "needs agent management."
            )
        return await run(
            factory,
            tenant_id,
            config,
            management.service,
            machine_id=machine_id,
            action=action,
            dry_run=dry_run,
        )
    finally:
        await engine.dispose()


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="switch-migrate-hosted-to-controller",
        description="Move cloud machines from the per-agent worker to the shared agent controller.",
    )
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--machine", metavar="ID")
    selection.add_argument("--all", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    step = parser.add_mutually_exclusive_group()
    step.add_argument("--rollback", action="store_true")
    step.add_argument("--finalize", action="store_true")
    args = parser.parse_args(argv)

    config = SwitchConfig()
    configure_logging(config, switch_core_version())
    action = cast(
        Action,
        "rollback" if args.rollback else "finalize" if args.finalize else "migrate",
    )
    try:
        lines = asyncio.run(_main(config, args.machine, action, args.dry_run))
    except MigrationRefused as error:
        print(f"refused: {error}", file=sys.stderr)
        raise SystemExit(1) from None
    for line in lines:
        print(line)


if __name__ == "__main__":
    main()
