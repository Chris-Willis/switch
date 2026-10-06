"""Switch Trust's wire format and fail-open behaviour are ours to keep
correct, so they are tested directly rather than only through the two call
sites that use them.
"""

import json

import httpx
import pytest

from switch_core.trust.client import (
    GuardrailBlockedError,
    GuardrailsCheckError,
    HttpTrustClient,
    NullTrustClient,
    TrustCheckResult,
    TrustFinding,
    check_message,
)


def _client(handler) -> HttpTrustClient:
    return HttpTrustClient(
        base_url="https://trust.example",
        api_key="k",
        policy_id="pol_123",
        timeout_seconds=1.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


@pytest.mark.asyncio
async def test_posts_the_one_message_with_the_expected_headers():
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["policy"] = request.headers.get("x-guardrails-policy-id")
        seen["key"] = request.headers.get("x-flintai-api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"outcome": "GUARDRAIL_RESULT_OUTCOME_OK"})

    client = _client(handler)
    result = await client.check(role="user", content="hi")

    assert seen["url"] == "https://trust.example/guardrails/check"
    assert seen["policy"] == "pol_123"
    assert seen["key"] == "k"
    assert seen["body"] == {"messages": [{"role": "user", "content": "hi"}]}
    assert result.blocked is False


@pytest.mark.asyncio
async def test_a_trailing_slash_on_the_base_url_does_not_double_up():
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"outcome": "GUARDRAIL_RESULT_OUTCOME_OK"})

    client = HttpTrustClient(
        base_url="https://trust.example/",
        api_key="k",
        policy_id="pol_123",
        timeout_seconds=1.0,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    await client.check(role="user", content="hi")
    assert seen["url"] == "https://trust.example/guardrails/check"


@pytest.mark.asyncio
async def test_a_blocked_outcome_carries_its_findings():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "outcome": "GUARDRAIL_RESULT_OUTCOME_BLOCKED",
                "policy_id": "pol_123",
                "policy_name": "Default Policy",
                "findings": [
                    {
                        "category": "pii/email",
                        "detector_name": "PiiDetector",
                        "detected_string": "user@example.com",
                        "severity": "high",
                    }
                ],
            },
        )

    client = _client(handler)
    result = await client.check(role="user", content="my email is user@example.com")

    assert result.blocked is True
    assert result.policy_name == "Default Policy"
    finding = result.findings[0]
    assert finding.category == "pii/email"
    assert finding.severity == "high"
    # The raw detected text never travels past the wire client.
    assert not hasattr(finding, "detected_string")


@pytest.mark.asyncio
async def test_an_error_response_raises_rather_than_allowing_silently():
    client = _client(lambda request: httpx.Response(503, text="unavailable"))
    with pytest.raises(GuardrailsCheckError, match="503"):
        await client.check(role="user", content="hi")


@pytest.mark.asyncio
async def test_a_network_failure_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = _client(handler)
    with pytest.raises(GuardrailsCheckError, match="failed"):
        await client.check(role="user", content="hi")


@pytest.mark.asyncio
async def test_null_client_always_allows():
    result = await NullTrustClient().check(role="user", content="anything")
    assert result.blocked is False


@pytest.mark.asyncio
async def test_check_message_fails_open_on_error():
    client = _client(lambda request: httpx.Response(500, text="boom"))
    result = await check_message(client, role="user", content="hi")
    assert result == TrustCheckResult(blocked=False, policy_id=None, policy_name=None)


@pytest.mark.asyncio
async def test_check_message_passes_through_a_block():
    client = _client(
        lambda request: httpx.Response(
            200, json={"outcome": "GUARDRAIL_RESULT_OUTCOME_BLOCKED"}
        )
    )
    result = await check_message(client, role="assistant", content="hi")
    assert result.blocked is True


def test_guardrail_blocked_error_names_the_categories():
    result = TrustCheckResult(
        blocked=True,
        policy_id="pol_123",
        policy_name="Default",
        findings=(
            TrustFinding(
                category="pii/email", detector_name="PiiDetector", severity="high"
            ),
        ),
    )
    assert "pii/email" in str(GuardrailBlockedError(result))
