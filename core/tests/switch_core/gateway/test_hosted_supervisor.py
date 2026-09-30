import hashlib
import logging
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from switch_core.crypto import encrypt_token
from switch_core.db.models import (
    Agent,
    ApiKey,
    HostedLaunch,
    ProviderConnection,
    User,
    require_tenant_id,
)
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    HEADERS,
    SPEC,
    TOKEN,
    attach_worker,
    controller_app,
    fixture,
    machine_of,
    observe,
    update_launch,
    update_machine,
)
from tests.switch_core.hosted_machine_helpers import seed_launch, seed_machine


@pytest.fixture
async def supervisor(controller_app):  # noqa: F811
    """The controller app plus a prepared machine and the supervisor's headers."""
    client, request_id, agent_id, service, factory, settings = controller_app
    machine = await machine_of(factory, request_id)
    prepared = await client.post(
        f"/hosted-controller/machines/{machine.id}/prepare", headers=HEADERS, json={}
    )
    assert prepared.status_code == 200, prepared.text
    await update_launch(factory, request_id, spec={**SPEC, "provider": "claude"})
    headers = {
        "Authorization": "Bearer " + prepared.json()["machine_capability"],
        "X-Switch-Host-Boot-Id": "00000000-0000-4000-8000-00000000b001",
        "X-Switch-Host-Instance-Id": "i-0123456789abcdef0",
    }
    return client, request_id, agent_id, service, factory, machine.id, headers


def heartbeat_body(**agent) -> dict:
    body = fixture("heartbeat_request.json")
    body["agents"] = [{**body["agents"][0], **agent}] if agent else []
    return body


async def other_owner(factory) -> str:
    async with factory() as session:
        user = User(
            name="other",
            email="other-machine-owner@example.invalid",
            role="user",
            password_hash="x",
        )
        session.add(user)
        await session.commit()
        return user.id


async def launch_row(factory, request_id: str) -> HostedLaunch:
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert launch is not None
        return launch


async def test_supervisor_routes_require_the_machine_capability(supervisor):
    client, _, _, _, factory, machine_id, headers = supervisor
    async with factory() as session:
        other = await seed_machine(
            session,
            owner_id=await other_owner(factory),
            slot_id="slot-b",
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
            generation=1,
        )
        await session.commit()
    for path in (
        f"/hosted/machines/{machine_id}/agents",
        f"/hosted/machines/{machine_id}/heartbeat",
        f"/hosted/machines/{other.id}/agents",
        f"/hosted/machines/{uuid4()}/agents",
    ):
        method = "POST" if path.endswith("heartbeat") else "GET"
        for authorization in (None, "Bearer wrong", "Bearer " + TOKEN):
            sent = {k: v for k, v in headers.items() if k != "Authorization"}
            if authorization is not None:
                sent["Authorization"] = authorization
            response = await client.request(
                method, path, headers=sent, json=heartbeat_body()
            )
            assert response.status_code == 401, path
            assert response.json() == {"detail": "invalid machine capability"}
    another = await client.get(f"/hosted/machines/{other.id}/agents", headers=headers)
    assert another.status_code == 401


@pytest.mark.parametrize(
    "missing", ["X-Switch-Host-Boot-Id", "X-Switch-Host-Instance-Id"]
)
async def test_supervisor_routes_require_the_host_headers(supervisor, missing):
    client, _, _, _, _, machine_id, headers = supervisor
    sent = {k: v for k, v in headers.items() if k != missing}
    response = await client.get(f"/hosted/machines/{machine_id}/agents", headers=sent)
    assert response.status_code == 400


@pytest.mark.parametrize(
    ("state", "desired"),
    [
        ("retained", "retained"),
        ("stopped", "retained"),
        ("deleting", "deleted"),
        ("ready", "deleted"),
    ],
)
async def test_retired_machine_gets_410(supervisor, state, desired):
    client, _, _, _, factory, machine_id, headers = supervisor
    await update_machine(factory, machine_id, state=state, desired_state=desired)
    for method, suffix in (("GET", "agents"), ("POST", "heartbeat")):
        response = await client.request(
            method,
            f"/hosted/machines/{machine_id}/{suffix}",
            headers=headers,
            json=heartbeat_body(),
        )
        assert response.status_code == 410
        assert response.json() == {"detail": "machine retired"}


async def test_agents_lists_the_machine_agents_in_the_contract_shape(supervisor):
    client, request_id, agent_id, _, factory, machine_id, headers = supervisor
    response = await client.get(
        f"/hosted/machines/{machine_id}/agents", headers=headers
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    expected = fixture("agents_response.json")
    assert set(body) == set(expected)
    assert body["machine_id"] == machine_id
    assert body["revision"] == 1
    assert body["desired_state"] == "running"
    [entry] = body["agents"]
    assert set(entry) == set(expected["agents"][0])
    assert set(entry["switch_credentials"]["env"]) == set(
        expected["agents"][0]["switch_credentials"]["env"]
    )
    assert entry["launch_id"] == request_id
    assert entry["agent_id"] == agent_id
    assert entry["name"] == "cloud-helper"
    assert entry["revision"] == 1
    assert entry["desired_state"] == "running"
    assert entry["provider"] == "claude"
    assert entry["provider_credential_kind"] == "setup-token"
    assert entry["repository"] == "example/project"
    assert entry["spec"]["instructions"] == SPEC["instructions"]
    env = entry["switch_credentials"]["env"]
    assert env["SWITCH_API_ENDPOINT"] == "https://switch.example.com/api/agent"
    assert env["SWITCH_AGENT_ID"] == agent_id
    async with factory() as session:
        agent = await session.get(Agent, agent_id)
        key = await session.get(ApiKey, agent.api_key_id)
        assert (
            key.key_hash == hashlib.sha256(env["SWITCH_API_TOKEN"].encode()).hexdigest()
        )
    assert [skill["slug"] for skill in entry["skills"]] == ["github"]
    assert entry["skills"][0]["files"]["SKILL.md"].startswith("---\nname: github\n")
    launch = await launch_row(factory, request_id)
    assert launch.state == "provisioning"
    assert launch.worker_capability_hash is not None


async def test_worker_capability_is_stable_per_revision_and_rotates_on_a_new_one(
    supervisor,
):
    client, request_id, _, _, factory, machine_id, headers = supervisor
    path = f"/hosted/machines/{machine_id}/agents"
    first = (await client.get(path, headers=headers)).json()["agents"][0]
    again = (await client.get(path, headers=headers)).json()["agents"][0]
    assert first["worker_capability"] == again["worker_capability"]
    assert first["switch_credentials"] == again["switch_credentials"]
    await update_launch(factory, request_id, revision=2)
    rotated = (await client.get(path, headers=headers)).json()["agents"][0]
    assert rotated["revision"] == 2
    assert rotated["worker_capability"] != first["worker_capability"]


async def test_agents_omits_deleted_and_unregistered_launches(supervisor):
    client, request_id, _, _, factory, machine_id, headers = supervisor
    machine = await machine_of(factory, request_id)
    async with factory() as session:
        await seed_launch(
            session,
            machine=machine,
            request_id=str(uuid4()),
            name="cloud-unregistered",
            state="queued",
            desired_state="running",
            revision=1,
            agent_id=None,
            spec=SPEC,
        )
        await session.commit()
    path = f"/hosted/machines/{machine_id}/agents"
    listed = (await client.get(path, headers=headers)).json()["agents"]
    assert [entry["launch_id"] for entry in listed] == [request_id]
    await update_launch(factory, request_id, desired_state="deleted")
    assert (await client.get(path, headers=headers)).json()["agents"] == []


async def test_agents_omits_a_launch_whose_agent_row_does_not_exist_yet(supervisor):
    client, request_id, agent_id, _, factory, machine_id, headers = supervisor
    machine = await machine_of(factory, request_id)
    unregistered_agent_id = str(uuid4())
    async with factory() as session:
        await seed_launch(
            session,
            machine=machine,
            request_id=str(uuid4()),
            name="cloud-pending",
            state="queued",
            desired_state="running",
            revision=1,
            agent_id=unregistered_agent_id,
            spec=SPEC,
        )
        await session.commit()
    response = await client.get(
        f"/hosted/machines/{machine_id}/agents", headers=headers
    )
    assert response.status_code == 200
    listed = response.json()["agents"]
    assert len(listed) == 1
    assert listed[0]["agent_id"] == agent_id
    assert listed[0]["name"] == "cloud-helper"


async def test_agents_refuses_rather_than_omits_an_agent_without_its_key(supervisor):
    client, _, agent_id, _, factory, machine_id, headers = supervisor
    async with factory() as session:
        agent = await session.get(Agent, agent_id)
        key = await session.get(ApiKey, agent.api_key_id)
        key.encrypted_key = ""
        await session.commit()
    response = await client.get(
        f"/hosted/machines/{machine_id}/agents", headers=headers
    )
    assert response.status_code == 409
    assert "cloud-helper" in response.json()["detail"]


async def test_agents_sends_no_skills_to_a_provider_without_a_skills_directory(
    supervisor, caplog
):
    client, request_id, _, _, factory, machine_id, headers = supervisor
    launch = await launch_row(factory, request_id)
    await update_launch(factory, request_id, spec={**SPEC, "provider": "cursor"})
    async with factory() as session:
        session.add(
            ProviderConnection(
                user_id=launch.owner_id,
                provider="cursor",
                kind="api-key",
                encrypted_credential=encrypt_token("SYNTHETIC-CURSOR", "test-secret"),
                verified_at=datetime.now(UTC),
            )
        )
        await session.commit()
    with caplog.at_level(logging.WARNING):
        response = await client.get(
            f"/hosted/machines/{machine_id}/agents", headers=headers
        )
    assert response.status_code == 200, response.text
    [entry] = response.json()["agents"]
    assert entry["skills"] == []
    assert entry["provider"] == "cursor"
    assert entry["provider_credential_kind"] == "api-key"
    assert "granted connection skills are not installed" in caplog.text


async def test_agents_lists_a_launch_whose_provider_connection_is_gone(
    supervisor, caplog
):
    client, request_id, _, _, factory, machine_id, headers = supervisor
    launch = await launch_row(factory, request_id)
    async with factory() as session:
        await session.delete(
            await session.get(
                ProviderConnection, (require_tenant_id(), launch.owner_id, "claude")
            )
        )
        await session.commit()
    with caplog.at_level(logging.WARNING):
        response = await client.get(
            f"/hosted/machines/{machine_id}/agents", headers=headers
        )
    assert response.status_code == 200, response.text
    [entry] = response.json()["agents"]
    assert entry["launch_id"] == request_id
    assert "provider_credential_kind" in entry
    assert entry["provider_credential_kind"] is None
    assert "connection is gone" in caplog.text


async def test_heartbeat_fixture_is_accepted_verbatim(supervisor):
    client, request_id, _, _, factory, machine_id, headers = supervisor
    body = fixture("heartbeat_request.json")
    response = await client.post(
        f"/hosted/machines/{machine_id}/heartbeat", headers=headers, json=body
    )
    assert response.status_code == 200, response.text
    assert set(response.json()) == set(fixture("heartbeat_response.json"))
    assert response.json()["heartbeat_every_s"] == 15
    assert response.json()["machine_desired_state"] == "running"
    saved = await machine_of(factory, request_id)
    assert saved.heartbeat == body
    assert saved.heartbeat_at is not None


async def test_heartbeat_records_process_state_and_a_crash(supervisor):
    client, request_id, agent_id, _, factory, machine_id, headers = supervisor
    response = await client.post(
        f"/hosted/machines/{machine_id}/heartbeat",
        headers=headers,
        json=heartbeat_body(launch_id=request_id, agent_id=agent_id, revision=1),
    )
    assert response.status_code == 200, response.text
    launch = await launch_row(factory, request_id)
    assert launch.process_state == "crashed"
    assert launch.process_restarts == 5
    assert launch.process_oom_kills == 1
    assert launch.process_exit == {
        "code": None,
        "signal": 9,
        "result": "start-limit-hit",
    }
    assert launch.process_reported_at is not None
    assert launch.state == "error"
    assert launch.error_code == "agent_crashed"
    assert "5 times in 10 minutes" in launch.error


async def test_heartbeat_marks_a_failed_agent(supervisor):
    client, request_id, agent_id, _, factory, machine_id, headers = supervisor
    await client.post(
        f"/hosted/machines/{machine_id}/heartbeat",
        headers=headers,
        json=heartbeat_body(
            launch_id=request_id, agent_id=agent_id, revision=1, process_state="failed"
        ),
    )
    launch = await launch_row(factory, request_id)
    assert launch.state == "error"
    assert launch.error_code == "agent_failed"


async def test_heartbeat_confirms_a_requested_stop(supervisor):
    client, request_id, agent_id, _, factory, machine_id, headers = supervisor
    await update_launch(factory, request_id, state="stopping", desired_state="stopped")
    await client.post(
        f"/hosted/machines/{machine_id}/heartbeat",
        headers=headers,
        json=heartbeat_body(
            launch_id=request_id,
            agent_id=agent_id,
            revision=1,
            process_state="stopped",
            exit=None,
        ),
    )
    assert (await launch_row(factory, request_id)).state == "stopped"


async def test_stopped_process_does_not_stop_an_agent_meant_to_run(supervisor):
    client, request_id, agent_id, _, factory, machine_id, headers = supervisor
    await client.post(
        f"/hosted/machines/{machine_id}/heartbeat",
        headers=headers,
        json=heartbeat_body(
            launch_id=request_id,
            agent_id=agent_id,
            revision=1,
            process_state="stopped",
            exit=None,
        ),
    )
    assert (await launch_row(factory, request_id)).state == "queued"


async def test_running_process_is_ready_only_once_its_worker_listens(supervisor):
    client, request_id, agent_id, service, factory, machine_id, headers = supervisor
    await update_launch(factory, request_id, state="provisioning")
    body = heartbeat_body(
        launch_id=request_id,
        agent_id=agent_id,
        revision=1,
        process_state="running",
        exit=None,
    )
    path = f"/hosted/machines/{machine_id}/heartbeat"
    await client.post(path, headers=headers, json=body)
    assert (await launch_row(factory, request_id)).state == "provisioning"
    stale = attach_worker(service, agent_id, request_id, revision=2)
    await client.post(path, headers=headers, json=body)
    assert (await launch_row(factory, request_id)).state == "provisioning"
    attach_worker(service, agent_id, request_id, connection_id=stale.id)
    before = datetime.now(UTC)
    await client.post(path, headers=headers, json=body)
    launch = await launch_row(factory, request_id)
    assert launch.state == "ready"
    assert launch.active_at >= before


async def test_stale_revision_report_writes_columns_but_not_state(supervisor):
    client, request_id, agent_id, _, factory, machine_id, headers = supervisor
    await update_launch(factory, request_id, revision=2)
    await client.post(
        f"/hosted/machines/{machine_id}/heartbeat",
        headers=headers,
        json=heartbeat_body(launch_id=request_id, agent_id=agent_id, revision=1),
    )
    launch = await launch_row(factory, request_id)
    assert launch.process_state == "crashed"
    assert launch.state == "queued"
    assert launch.error_code is None


async def test_report_for_another_agent_is_ignored(supervisor):
    client, request_id, _, _, factory, machine_id, headers = supervisor
    await client.post(
        f"/hosted/machines/{machine_id}/heartbeat",
        headers=headers,
        json=heartbeat_body(launch_id=request_id, agent_id=str(uuid4()), revision=1),
    )
    launch = await launch_row(factory, request_id)
    assert launch.process_state is None
    assert launch.state == "queued"


async def test_low_disk_is_flagged_and_cleared(supervisor):
    client, request_id, _, _, factory, machine_id, headers = supervisor
    path = f"/hosted/machines/{machine_id}/heartbeat"
    low = heartbeat_body()
    low["disk"] = {**low["disk"], "available_bytes": 1024}
    await client.post(path, headers=headers, json=low)
    assert (await machine_of(factory, request_id)).error_code == "disk_full"
    await client.post(path, headers=headers, json=heartbeat_body())
    assert (await machine_of(factory, request_id)).error_code is None
    await update_machine(factory, machine_id, error_code="machine_needs_attention")
    await client.post(path, headers=headers, json=low)
    assert (await machine_of(factory, request_id)).error_code == (
        "machine_needs_attention"
    )


async def test_machine_is_ready_after_a_running_observation_and_a_later_heartbeat(
    supervisor,
):
    client, request_id, _, _, factory, machine_id, headers = supervisor
    path = f"/hosted/machines/{machine_id}/heartbeat"
    await client.post(path, headers=headers, json=heartbeat_body())
    assert (await machine_of(factory, request_id)).state == "provisioning"
    await observe(client, machine_id, state="running", revision=1)
    await client.post(path, headers=headers, json=heartbeat_body())
    saved = await machine_of(factory, request_id)
    assert saved.state == "ready"
    assert saved.error is None


async def test_heartbeat_before_the_running_observation_does_not_count(supervisor):
    client, request_id, _, _, factory, machine_id, headers = supervisor
    await update_machine(
        factory,
        machine_id,
        running_observed_at=datetime.now(UTC) + timedelta(minutes=1),
    )
    await client.post(
        f"/hosted/machines/{machine_id}/heartbeat",
        headers=headers,
        json=heartbeat_body(),
    )
    assert (await machine_of(factory, request_id)).state == "provisioning"
