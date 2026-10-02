"""The recorded wire messages are what the routes actually send and accept.

`core/tests/switch_core/fixtures/agent_controllers/` holds one JSON file per
message between a controller and Management. The controller's TypeScript
tests parse the same files with its own schemas, so these files are where
the two sides meet: a response that drifts from its fixture breaks this test,
and a request fixture the routes refuse breaks it too.

A response is compared by shape — the same keys at every level, and the same
JSON type for every value — because ids, secrets and times differ on every
run. `null` is a type of its own here, so a field the fixture records as null
must be null in the response the test provokes, and the other way round.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.db.stores.agent_store import AgentStore
from switch_core.management.schemas import (
    EnrollRequest,
    OperationResultRequest,
    StatusReport,
    TokenRequest,
)
from switch_core.management.stream import controller_event_stream
from tests.switch_core.management.harness import (
    FIXTURES,
    Harness,
    add_member,
    build_harness,
    cookies_for,
    create_managed_agent,
    definition,
    enroll_console,
    fixture,
    provider,
    report_status,
)


def _fixture(name: str) -> Any:
    return fixture(name)


def assert_same_shape(actual: Any, expected: Any, where: str = "$") -> None:
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{where}: expected an object, got {actual!r}"
        assert set(actual) == set(expected), (
            f"{where}: keys differ; extra {sorted(set(actual) - set(expected))}, "
            f"missing {sorted(set(expected) - set(actual))}"
        )
        for key, value in expected.items():
            assert_same_shape(actual[key], value, f"{where}.{key}")
    elif isinstance(expected, list):
        assert isinstance(actual, list), f"{where}: expected an array, got {actual!r}"
        if expected:
            assert actual, f"{where}: expected a non-empty array"
            for index, item in enumerate(actual):
                assert_same_shape(item, expected[0], f"{where}[{index}]")
    else:
        assert type(actual) is type(expected), (
            f"{where}: expected {type(expected).__name__} like {expected!r}, "
            f"got {actual!r}"
        )


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


class TestRequestFixturesParse:
    def test_each_request_fixture_is_a_valid_request(self) -> None:
        EnrollRequest.model_validate(_fixture("enroll_request.json"))
        TokenRequest.model_validate(_fixture("token_request.json"))
        StatusReport.model_validate(_fixture("status_request.json"))
        OperationResultRequest.model_validate(
            _fixture("operation_result_succeeded.json")
        )
        OperationResultRequest.model_validate(_fixture("operation_result_failed.json"))


class TestEnrollmentAndTokens:
    async def test_enroll_token_and_rotate(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            code = (
                await client.post(
                    "/gateway/management/enrollment-codes", cookies=cookies_for(owner)
                )
            ).json()["code"]
            enroll_body = _fixture("enroll_request.json")
            enroll_body["proof"]["code"] = code
            enrolled = await client.post(
                "/v1/management/controllers/enroll", json=enroll_body
            )
            controller_id = enrolled.json()["controller_id"]

            token_body = _fixture("token_request.json")
            token_body["credential"] = enrolled.json()["credential"]
            token = await client.post(
                f"/v1/management/controllers/{controller_id}/token", json=token_body
            )
            rotated = await client.post(
                f"/v1/management/controllers/{controller_id}/credential/rotate",
                headers={"Authorization": f"Bearer {token.json()['access_token']}"},
            )

        assert enrolled.status_code == 201, enrolled.text
        assert_same_shape(enrolled.json(), _fixture("enroll_response.json"))
        assert enrolled.json()["credential"].startswith("swcc_")
        assert token.status_code == 200, token.text
        assert_same_shape(token.json(), _fixture("token_response.json"))
        assert token.json()["access_token"].startswith("swct_")
        assert token.json()["expires_at"].endswith("Z")
        assert rotated.status_code == 200
        assert_same_shape(rotated.json(), _fixture("credential_rotate_response.json"))


class TestControllerMessages:
    async def test_assignment_status_operations_and_credentials(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            created = await create_managed_agent(
                client,
                owner,
                name="reviewer",
                controller_id=controller.controller_id,
                definition_body=definition(
                    instructions="Review pull requests.",
                    directory="/home/example/src/project",
                ),
            )
            agent_id = created.json()["agent_id"]
            async with harness.session_factory() as session:
                await AgentStore().update(
                    session,
                    agent_id,
                    display_name="Reviewer",
                    icon_url="https://example.com/icons/reviewer.png",
                )
                await session.commit()

            assignment = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/assignment",
                headers=controller.headers,
            )
            status = await client.put(
                f"/v1/management/controllers/{controller.controller_id}/status",
                json=_fixture("status_request.json"),
                headers=controller.headers,
            )

            recheck = await client.post(
                "/gateway/management/operations",
                json={
                    "controller_id": controller.controller_id,
                    "kind": "provider.recheck",
                    "params": {"provider": "claude"},
                },
                cookies=cookies_for(owner),
            )
            listed = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/operations",
                params={"state": "pending"},
                headers=controller.headers,
            )
            restart = await client.post(
                "/gateway/management/operations",
                json={
                    "controller_id": controller.controller_id,
                    "kind": "agent.restart",
                    "agent_id": agent_id,
                },
                cookies=cookies_for(owner),
            )
            claimed = await client.post(
                f"/v1/management/operations/{restart.json()['id']}/claim",
                headers=controller.headers,
            )
            await client.post(
                f"/v1/management/operations/{recheck.json()['id']}/claim",
                headers=controller.headers,
            )
            succeeded = await client.post(
                f"/v1/management/operations/{restart.json()['id']}/result",
                json=_fixture("operation_result_succeeded.json"),
                headers=controller.headers,
            )
            failed = await client.post(
                f"/v1/management/operations/{recheck.json()['id']}/result",
                json=_fixture("operation_result_failed.json"),
                headers=controller.headers,
            )
            credentials = await client.post(
                f"/v1/management/controllers/{controller.controller_id}"
                f"/agents/{agent_id}/credentials",
                headers=controller.headers,
            )

        assert assignment.status_code == 200
        assert_same_shape(assignment.json(), _fixture("assignment_response.json"))
        assert status.status_code == 200, status.text
        assert_same_shape(status.json(), _fixture("status_response.json"))
        assert status.json()["report_within_s"] == 60
        assert_same_shape(listed.json(), _fixture("operations_response.json"))
        assert claimed.status_code == 200
        assert_same_shape(claimed.json(), _fixture("operation.json"))
        assert succeeded.status_code == 204
        assert failed.status_code == 204
        assert credentials.status_code == 200
        assert_same_shape(
            credentials.json(), _fixture("agent_credentials_response.json")
        )

    async def test_the_error_envelope(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
            refused = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/assignment",
                headers=controller.headers,
            )
        assert refused.status_code == 401
        assert refused.json() == _fixture("error_response.json")


class TestStreamFrames:
    async def test_each_frame_matches(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
        notifier = harness.management.service.notifier
        stream = controller_event_stream(
            principal=ControllerPrincipal(
                controller_id=controller.controller_id,
                owner_id=owner.id,
                tenant_id=TENANT_ZERO_ID,
            ),
            service=harness.management.service,
            session_factory=harness.session_factory,
            keepalive_seconds=30,
        )
        frames = [await anext(stream)]
        notifier.assignment_changed(controller.controller_id, 4)
        notifier.operation_pending(
            controller.controller_id,
            operation_id="op",
            kind="provider.recheck",
            agent_id=None,
        )
        notifier.credential_revoked(controller.controller_id)
        frames.extend([raw async for raw in stream])

        parsed = []
        for raw in frames:
            event_line, data_line = raw.decode().strip().split("\n")
            parsed.append(
                {
                    "event": event_line.removeprefix("event: "),
                    "data": json.loads(data_line.removeprefix("data: ")),
                }
            )
        expected = _fixture("stream_frames.json")
        assert [f["event"] for f in parsed] == [f["event"] for f in expected]
        for actual, recorded in zip(parsed, expected, strict=True):
            assert_same_shape(actual, recorded)


def test_every_fixture_is_exercised() -> None:
    """Every file on disk is read by a test in this module, and nothing here
    reads a file that is not there."""
    referenced = set(re.findall(r'_fixture\("([^"]+)"\)', Path(__file__).read_text()))
    on_disk = {path.name for path in FIXTURES.glob("*.json")}
    assert on_disk == referenced, (
        f"unexercised: {sorted(on_disk - referenced)}; "
        f"missing: {sorted(referenced - on_disk)}"
    )
