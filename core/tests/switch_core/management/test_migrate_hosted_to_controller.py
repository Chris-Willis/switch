"""Moving a cloud machine from the per-agent worker to the agent controller.

Against Postgres, with KMS stubbed: the plan names no secret, applying it
places each hosted agent on the owner's ec2 controller and seals the owner's
logins for it, a second run changes nothing, a rollback returns the machine
to the worker with its sealed logins kept, and finalizing deletes the keyring
copies, after which a rollback is refused.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import select

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentController,
    AgentDefinition,
    ApiKey,
    Client,
    HostedLaunch,
    HostedMachine,
    ProviderConnection,
    SealedProviderCredential,
    User,
)
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.management import reload
from switch_core.management.bindings import Placements, read_placements
from switch_core.management.migrate_hosted_to_controller import (
    Action,
    MigrationRefused,
    run,
)
from switch_core.management.reload import reload_logins, reload_placements
from tests.switch_core.hosted_machine_helpers import seed_launch
from tests.switch_core.management.harness import KEYRING, add_member
from tests.switch_core.management.test_cloud_controller import (  # noqa: F401
    Cloud,
    cloud,
)

SECRET = "PLACEHOLDER-CLAUDE-TOKEN"


@dataclass
class Hosted:
    owner: User
    machine_id: str
    agent_id: str


async def _hosted(cloud: Cloud, name: str) -> Hosted:  # noqa: F811
    """A worker machine with one running hosted agent, and its owner's Claude
    login held in the keyring."""
    owner = await add_member(cloud.factory, name)
    machine_id = await cloud.machine(owner, runtime="worker")
    async with cloud.factory() as session:
        client = Client(
            type="agent", transport_user_id=f"@{name}-scout:test", display_name="scout"
        )
        api_key = ApiKey(
            type="agent",
            key_hash=uuid4().hex,
            encrypted_key="",
            label=f"{name}-scout",
            user_id=owner.id,
        )
        session.add_all([client, api_key])
        await session.flush()
        agent = Agent(
            name=f"{name}-scout",
            description="scout",
            agent_type="auto_session",
            connector_type="claude_code",
            integration_profile={"connection_model": "auto_session"},
            client_id=client.id,
            api_key_id=api_key.id,
            owner_id=owner.id,
        )
        session.add(agent)
        await session.flush()
        machine = await session.get(HostedMachine, (TENANT_ZERO_ID, machine_id))
        assert machine is not None
        launch = await seed_launch(
            session,
            machine=machine,
            request_id=str(uuid4()),
            name=f"{name}-scout",
            state="ready",
            desired_state="running",
            revision=1,
            agent_id=agent.id,
            spec={
                "provider": "claude",
                "definition": "---\nname: scout\n---\nYou review pull requests.",
                "instructions": "Be brief.",
                "definition_attributes": {"model": "sonnet"},
                "installation_id": 123,
                "repository_id": 456,
                "auto_session": True,
                "auto_approve": False,
            },
        )
        launch.repository = "Example/Project"
        await ProviderConnectionStore().save(
            session, owner.id, "setup-token", KEYRING.encrypt(SECRET), datetime.now(UTC)
        )
        await session.commit()
        return Hosted(owner, machine_id, agent.id)


async def _run(
    cloud: Cloud,  # noqa: F811
    machine_id: str | None,
    action: Action,
    *,
    dry_run: bool,
) -> list[str]:
    return await run(
        cloud.factory,
        TENANT_ZERO_ID,
        cloud.config,  # type: ignore[arg-type]
        cloud.harness.management.service,
        machine_id=machine_id,
        action=action,
        dry_run=dry_run,
    )


async def _machine(cloud: Cloud, machine_id: str) -> HostedMachine:  # noqa: F811
    async with cloud.factory() as session:
        machine = await session.get(HostedMachine, (TENANT_ZERO_ID, machine_id))
    assert machine is not None
    return machine


async def _definition(cloud: Cloud, agent_id: str) -> AgentDefinition | None:  # noqa: F811
    async with cloud.factory() as session:
        return await session.scalar(
            select(AgentDefinition).where(AgentDefinition.agent_id == agent_id)
        )


async def _sealed(cloud: Cloud, owner: User) -> list[tuple[str, str, int]]:  # noqa: F811
    async with cloud.factory() as session:
        rows = await session.scalars(
            select(SealedProviderCredential).where(
                SealedProviderCredential.owner_id == owner.id
            )
        )
        return [(row.provider, row.status, row.revision) for row in rows]


async def _keyring_copy(cloud: Cloud, owner: User) -> bytes | None:  # noqa: F811
    async with cloud.factory() as session:
        return await session.scalar(
            select(ProviderConnection.encrypted_credential).where(
                ProviderConnection.user_id == owner.id
            )
        )


async def _set_launch(cloud: Cloud, agent_id: str, **values: Any) -> None:  # noqa: F811
    async with cloud.factory() as session:
        launch = await session.scalar(
            select(HostedLaunch).where(HostedLaunch.agent_id == agent_id)
        )
        assert launch is not None
        for key, value in values.items():
            setattr(launch, key, value)
        await session.commit()


async def _launch_state(
    cloud: Cloud,  # noqa: F811
    agent_id: str,
) -> tuple[str, str, str | None, str | None]:
    async with cloud.factory() as session:
        launch = await session.scalar(
            select(HostedLaunch).where(HostedLaunch.agent_id == agent_id)
        )
    assert launch is not None
    return (launch.state, launch.desired_state, launch.error, launch.error_code)


async def _revision(cloud: Cloud, controller_id: str) -> int:  # noqa: F811
    async with cloud.factory() as session:
        controller = await session.get(AgentController, controller_id)
    assert controller is not None
    return controller.assignment_revision


@pytest.fixture
async def hosted(cloud: Cloud) -> Hosted:  # noqa: F811
    return await _hosted(cloud, "ada")


class TestMigrate:
    async def test_a_dry_run_names_the_plan_and_no_secret_and_changes_nothing(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
    ) -> None:
        lines = await _run(cloud, hosted.machine_id, "migrate", dry_run=True)

        text = "\n".join(lines)
        assert SECRET not in text
        assert "seal login: claude (setup-token)" in text
        assert (
            f"agent {hosted.agent_id} (ada-scout): provider=claude model=sonnet" in text
        )
        assert "runtime: worker -> controller, revision bump" in text
        assert lines[-1] == "dry run: nothing was changed"
        machine = await _machine(cloud, hosted.machine_id)
        assert (machine.runtime, machine.revision, machine.controller_id) == (
            "worker",
            1,
            None,
        )
        assert await _definition(cloud, hosted.agent_id) is None
        assert await _sealed(cloud, hosted.owner) == []

    async def test_applying_places_the_agent_and_seals_the_login(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
    ) -> None:
        lines = await _run(cloud, hosted.machine_id, "migrate", dry_run=False)

        assert SECRET not in "\n".join(lines)
        assert lines[-1] == "  runtime: worker -> controller, revision bump"
        machine = await _machine(cloud, hosted.machine_id)
        assert (machine.runtime, machine.revision) == ("controller", 2)
        assert machine.controller_id is not None
        row = await _definition(cloud, hosted.agent_id)
        assert row is not None
        assert (row.controller_id, row.owner_id, row.desired_state) == (
            machine.controller_id,
            hosted.owner.id,
            "running",
        )
        assert row.definition == {
            "advanced_config": {},
            "provider": "claude",
            "model": "sonnet",
            "instructions": "---\nname: scout\n---\nYou review pull requests.\n\nBe brief.",
            "auto_approve": False,
            "directory": f"/data/worktrees/{hosted.agent_id}/example/project",
            "isolation": "isolated",
            "repository": {"installation_id": 123, "repository_id": 456},
        }
        assert await _revision(cloud, machine.controller_id) == 1
        assert await _sealed(cloud, hosted.owner) == [("claude", "connected", 1)]
        assert await _keyring_copy(cloud, hosted.owner) is not None

    async def test_running_it_again_changes_nothing(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
    ) -> None:
        await _run(cloud, hosted.machine_id, "migrate", dry_run=False)
        first = await _machine(cloud, hosted.machine_id)
        assert first.controller_id is not None

        lines = await _run(cloud, hosted.machine_id, "migrate", dry_run=False)

        assert f"  agent {hosted.agent_id} (ada-scout): already placed" in lines
        assert "runtime: already controller" in "\n".join(lines)
        assert not any("seal login" in line for line in lines)
        machine = await _machine(cloud, hosted.machine_id)
        assert (machine.revision, machine.controller_id) == (2, first.controller_id)
        assert await _revision(cloud, first.controller_id) == 1
        assert await _sealed(cloud, hosted.owner) == [("claude", "connected", 1)]

    @pytest.mark.parametrize(
        ("left", "desired", "settled"),
        [
            ("queued", "running", "ready"),
            ("provisioning", "running", "ready"),
            ("error", "running", "ready"),
            ("stopping", "stopped", "stopped"),
        ],
    )
    async def test_settles_a_launch_left_mid_transition_at_its_desired_state(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
        left: str,
        desired: str,
        settled: str,
    ) -> None:
        await _set_launch(
            cloud,
            hosted.agent_id,
            state=left,
            desired_state=desired,
            error="crashed",
            error_code="agent_crashed",
        )

        planned = await _run(cloud, hosted.machine_id, "migrate", dry_run=True)
        assert any(f"state {left} -> {settled}" in line for line in planned)
        assert (await _launch_state(cloud, hosted.agent_id))[0] == left

        await _run(cloud, hosted.machine_id, "migrate", dry_run=False)

        assert await _launch_state(cloud, hosted.agent_id) == (
            settled,
            desired,
            None,
            None,
        )

    async def test_running_it_again_settles_a_launch_left_queued_since(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
    ) -> None:
        await _run(cloud, hosted.machine_id, "migrate", dry_run=False)
        await _set_launch(cloud, hosted.agent_id, state="queued")

        lines = await _run(cloud, hosted.machine_id, "migrate", dry_run=False)

        assert any("state queued -> ready" in line for line in lines)
        assert (await _launch_state(cloud, hosted.agent_id))[0] == "ready"
        assert (await _machine(cloud, hosted.machine_id)).revision == 2

    async def test_an_agent_placed_elsewhere_is_refused(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
    ) -> None:
        async with cloud.factory() as session:
            await cloud.harness.management.service.definitions.create(
                session,
                agent_id=hosted.agent_id,
                owner_id=hosted.owner.id,
                controller_id=None,
                desired_state="running",
                definition={},
            )
            await session.commit()

        with pytest.raises(MigrationRefused, match="already has a definition"):
            await _run(cloud, hosted.machine_id, "migrate", dry_run=False)

        assert (await _machine(cloud, hosted.machine_id)).runtime == "worker"

    async def test_all_migrates_every_live_machine(self, cloud: Cloud) -> None:  # noqa: F811
        first = await _hosted(cloud, "ada")
        second = await _hosted(cloud, "bob")

        await _run(cloud, None, "migrate", dry_run=False)

        for hosted in (first, second):
            machine = await _machine(cloud, hosted.machine_id)
            assert machine.runtime == "controller"
            row = await _definition(cloud, hosted.agent_id)
            assert row is not None and row.controller_id == machine.controller_id


class TestRollback:
    async def test_returns_the_machine_to_the_worker_and_keeps_the_seals(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
    ) -> None:
        await _run(cloud, hosted.machine_id, "migrate", dry_run=False)
        controller_id = (await _machine(cloud, hosted.machine_id)).controller_id
        assert controller_id is not None

        planned = await _run(cloud, hosted.machine_id, "rollback", dry_run=True)
        assert f"  agent {hosted.agent_id} (ada-scout): remove definition" in planned
        assert await _definition(cloud, hosted.agent_id) is not None

        lines = await _run(cloud, hosted.machine_id, "rollback", dry_run=False)

        assert lines[-1] == "  sealed logins: kept"
        machine = await _machine(cloud, hosted.machine_id)
        assert (machine.runtime, machine.revision, machine.controller_id) == (
            "worker",
            3,
            controller_id,
        )
        assert await _definition(cloud, hosted.agent_id) is None
        assert await _revision(cloud, controller_id) == 2
        assert await _sealed(cloud, hosted.owner) == [("claude", "connected", 1)]
        assert await _keyring_copy(cloud, hosted.owner) is not None

        await _run(cloud, hosted.machine_id, "migrate", dry_run=False)
        again = await _machine(cloud, hosted.machine_id)
        assert (again.runtime, again.controller_id) == ("controller", controller_id)
        assert await _sealed(cloud, hosted.owner) == [("claude", "connected", 1)]


class TestFinalize:
    async def test_deletes_the_keyring_copy_and_then_refuses_a_rollback(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
    ) -> None:
        await _run(cloud, hosted.machine_id, "migrate", dry_run=False)

        planned = await _run(cloud, hosted.machine_id, "finalize", dry_run=True)
        assert "  delete keyring copy: claude" in planned
        assert await _keyring_copy(cloud, hosted.owner) is not None

        await _run(cloud, hosted.machine_id, "finalize", dry_run=False)

        assert await _keyring_copy(cloud, hosted.owner) is None
        assert await _sealed(cloud, hosted.owner) == [("claude", "connected", 1)]
        with pytest.raises(MigrationRefused, match="only sealed for the controller"):
            await _run(cloud, hosted.machine_id, "rollback", dry_run=False)
        assert (await _machine(cloud, hosted.machine_id)).runtime == "controller"

    async def test_a_machine_still_on_the_worker_is_refused(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
    ) -> None:
        with pytest.raises(MigrationRefused, match="not on the controller runtime"):
            await _run(cloud, hosted.machine_id, "finalize", dry_run=False)

        assert await _keyring_copy(cloud, hosted.owner) is not None

    async def test_a_login_changed_since_sealing_is_refused(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
    ) -> None:
        await _run(cloud, hosted.machine_id, "migrate", dry_run=False)
        await cloud.update_machine(hosted.machine_id, runtime="worker")
        async with cloud.factory() as session:
            await ProviderConnectionStore().save(
                session,
                hosted.owner.id,
                "setup-token",
                KEYRING.encrypt("PLACEHOLDER-CLAUDE-TOKEN-2"),
                datetime.now(UTC),
            )
            await session.commit()
        await cloud.update_machine(hosted.machine_id, runtime="controller")

        with pytest.raises(MigrationRefused, match="Run the migration again"):
            await _run(cloud, hosted.machine_id, "finalize", dry_run=False)
        await _run(cloud, hosted.machine_id, "migrate", dry_run=False)
        await _run(cloud, hosted.machine_id, "finalize", dry_run=False)

        assert await _keyring_copy(cloud, hosted.owner) is None
        assert await _sealed(cloud, hosted.owner) == [("claude", "connected", 2)]


class TestARunningCore:
    """What a Core already running when the command runs makes of it."""

    async def test_binds_the_migrated_agents_and_tells_their_controller(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
    ) -> None:
        service = cloud.harness.management.service
        presence = cloud.harness.protocol.connections.controllers
        await _run(cloud, hosted.machine_id, "migrate", dry_run=False)
        controller_id = (await _machine(cloud, hosted.machine_id)).controller_id
        assert controller_id is not None
        assert presence.binding(hosted.agent_id) is None
        stream = service.notifier.subscribe(controller_id)
        try:
            changed = await reload_placements(cloud.factory, service)
            placed = stream.drain()
            unchanged = await reload_placements(cloud.factory, service)

            await _run(cloud, hosted.machine_id, "rollback", dry_run=False)
            removed = await reload_placements(cloud.factory, service)
            rolled_back = stream.drain()
        finally:
            stream.close()

        assert (changed, unchanged, removed) == (1, 0, 1)
        assert placed == [("assignment.changed", {"revision": 1})]
        assert rolled_back == [("assignment.changed", {"revision": 2})]
        assert presence.binding(hosted.agent_id) is None

    async def test_binds_with_the_definitions_controller_and_state(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
    ) -> None:
        service = cloud.harness.management.service
        await _run(cloud, hosted.machine_id, "migrate", dry_run=False)
        controller_id = (await _machine(cloud, hosted.machine_id)).controller_id

        await reload_placements(cloud.factory, service)

        binding = cloud.harness.protocol.connections.controllers.binding(
            hosted.agent_id
        )
        assert binding is not None
        assert (binding.controller_id, binding.tenant_id, binding.running) == (
            controller_id,
            TENANT_ZERO_ID,
            True,
        )

    async def test_a_reload_overlapping_an_in_process_change_is_dropped(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        service = cloud.harness.management.service
        presence = cloud.harness.protocol.connections.controllers
        await _run(cloud, hosted.machine_id, "migrate", dry_run=False)

        async def read_then_change(**kwargs: Any) -> Placements:
            placements = await read_placements(**kwargs)
            presence.unbind("some-other-agent", "unassigned")
            return placements

        monkeypatch.setattr(reload, "read_placements", read_then_change)
        dropped = await reload_placements(cloud.factory, service)
        monkeypatch.setattr(reload, "read_placements", read_placements)
        applied = await reload_placements(cloud.factory, service)

        assert (dropped, applied) == (0, 1)
        assert presence.binding(hosted.agent_id) is not None

    async def test_announces_each_login_it_sealed_to_the_controller(
        self,
        cloud: Cloud,  # noqa: F811
        hosted: Hosted,
    ) -> None:
        service = cloud.harness.management.service
        await _run(cloud, hosted.machine_id, "migrate", dry_run=False)
        controller_id = (await _machine(cloud, hosted.machine_id)).controller_id
        assert controller_id is not None
        stream = service.notifier.subscribe(controller_id)
        try:
            first = await reload_logins(cloud.factory, service)
            sealed = stream.drain()
            again = await reload_logins(cloud.factory, service)
            async with cloud.factory() as session:
                await ProviderConnectionStore().save(
                    session,
                    hosted.owner.id,
                    "setup-token",
                    KEYRING.encrypt("PLACEHOLDER-CLAUDE-TOKEN-2"),
                    datetime.now(UTC),
                )
                await session.commit()
            lines = await _run(cloud, hosted.machine_id, "migrate", dry_run=False)
            resealed = await reload_logins(cloud.factory, service)
            changed = stream.drain()
        finally:
            stream.close()

        assert "  seal login: claude (setup-token)" in lines
        assert (first, again, resealed) == (1, 0, 1)
        assert sealed == [
            ("provider.credential_changed", {"provider": "claude", "revision": 1})
        ]
        assert changed == [
            ("provider.credential_changed", {"provider": "claude", "revision": 2})
        ]
