"""`flint_env`: what keeps a test server's usage apart from real usage.

The relay writes every client into one Amplitude project and overwrites
`deployment.environment`, but copies `flint_env` from the resource onto each
event. So it has to be on the resource of every event, and it has to be one of
the values the relay's readers filter on.
"""

from __future__ import annotations

import json

import httpx
import pytest
from pydantic import ValidationError

from switch_core.config import SwitchConfig
from switch_core.observability.otlp import OtlpClient
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.setup import _service
from switch_core.telemetry.sink import NullSink, OtlpRelaySink, TelemetryRecord

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_name="switch",
    matrix_server_name="switch.local",
    agent_registration_token="token",
    jwt_secret_key="jwt",
    gateway_admin_email="admin@example.com",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(  # type: ignore[arg-type]
        **{
            **_BASE_KWARGS,
            "db_password": "placeholder",  # gitleaks:allow
            "gateway_admin_password": "placeholder",  # gitleaks:allow
            **overrides,
        }
    )


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    async def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


class TestTheSetting:
    def test_a_server_that_says_nothing_counts_as_real_usage(self) -> None:
        """A server that switches telemetry on is usually someone's real one;
        a test server is ours, and we say so."""
        assert _config().telemetry_environment == "prod"

    @pytest.mark.parametrize("value", ["prod", "staging", "dev"])
    def test_flints_three_environments_are_accepted(self, value: str) -> None:
        assert _config(telemetry_environment=value).telemetry_environment == value

    def test_anything_else_is_refused_at_boot(self) -> None:
        """A dashboard filtered on `dev` would silently miss a server that
        wrote `development`."""
        with pytest.raises(ValidationError):
            _config(telemetry_environment="development")


class TestItReachesEveryEvent:
    async def test_the_setting_is_on_the_resource(self) -> None:
        sink = _RecordingSink()
        service = _service(
            _config(telemetry_enabled=True, telemetry_environment="dev"),
            sink,  # type: ignore[arg-type]
            client_id="deployment-uuid",
            version="1.2.3",
            session_factory=None,  # type: ignore[arg-type]
            installed_at=None,
        )

        service.emit("deployment_started", tenant_count=1)
        await service.aclose()

        assert sink.sent[0].resource["flint_env"] == "dev"

    async def test_it_is_sent_to_the_relay_as_a_resource_attribute(self) -> None:
        captured: dict = {}

        def _handle(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            return httpx.Response(200)

        http = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        sink = OtlpRelaySink(client=OtlpClient("https://relay.example", 5, {}, http))
        service = TelemetryService(
            sink=sink,
            enabled=True,
            client_id="deployment-uuid",
            service_name="switch-core",
            version=None,
            environment="pilot",
            flint_env="dev",
        )

        service.emit("deployment_started", tenant_count=1)
        await service.aclose()
        await http.aclose()

        resource = {
            a["key"]: a["value"]
            for a in captured["resourceLogs"][0]["resource"]["attributes"]
        }
        assert resource["flint_env"] == {"stringValue": "dev"}

    async def test_a_disabled_server_still_builds_with_it(self) -> None:
        service = _service(
            _config(),
            NullSink(),
            client_id="deployment-uuid",
            version=None,
            session_factory=None,  # type: ignore[arg-type]
            installed_at=None,
        )

        assert not service.enabled
