"""Switch Trust: a guardrails service checked before a message is sent.

Calls the check-only endpoint added in
https://github.com/sandbox-quantum/hoot/pull/2397 — a provider-agnostic
`messages` array in, a block/allow verdict out, no LLM provider in the loop.
`NullTrustClient` is what runs when the feature is off (`SwitchConfig.
trust_enabled` is False): a client that always allows, so no call site has to
ask whether the feature is on — the same shape as `telemetry/sink.py`'s
`NullSink`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx

logger = logging.getLogger(__name__)

_BLOCKED_OUTCOME = "GUARDRAIL_RESULT_OUTCOME_BLOCKED"

Role = Literal["user", "assistant"]


class GuardrailsCheckError(RuntimeError):
    """A check did not complete: network error, timeout, or a non-2xx answer."""


class GuardrailBlockedError(Exception):
    """A message was refused by the guardrails policy.

    Carries the verdict so a caller can tell the room or the agent why,
    without re-deriving it.
    """

    def __init__(self, result: TrustCheckResult) -> None:
        self.result = result
        categories = (
            ", ".join(f.category for f in result.findings) or "policy violation"
        )
        super().__init__(f"blocked by Switch Trust ({categories})")


@dataclass(frozen=True)
class TrustFinding:
    """One detector hit. Deliberately narrower than the wire shape: no
    `detected_string` — that is often the sensitive text itself (an email, a
    secret), and this travels into log lines and blocked-message notices."""

    category: str
    detector_name: str
    severity: str | None


@dataclass(frozen=True)
class TrustCheckResult:
    blocked: bool
    policy_id: str | None
    policy_name: str | None
    findings: tuple[TrustFinding, ...] = ()


class TrustClient(Protocol):
    async def check(self, *, role: Role, content: str) -> TrustCheckResult: ...


class NullTrustClient:
    """Off: every message is allowed, and no request is made."""

    async def check(self, *, role: Role, content: str) -> TrustCheckResult:
        return TrustCheckResult(blocked=False, policy_id=None, policy_name=None)


class HttpTrustClient:
    """Posts to `{base_url}/guardrails/check`. One client, reused.

    No history, no tool calls: v1 checks the one message being sent, as a
    `messages` array of length one. Raises `GuardrailsCheckError` on any
    failure — whether that is treated as blocking or fail-open is a decision
    for the caller (`check_message` below), not this client.
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        policy_id: str,
        timeout_seconds: float,
        client: httpx.AsyncClient,
    ) -> None:
        self._url = base_url.rstrip("/") + "/guardrails/check"
        self._headers = {
            "Content-Type": "application/json",
            "x-guardrails-policy-id": policy_id,
            "x-flintai-api-key": api_key,
        }
        self._timeout_seconds = timeout_seconds
        self._client = client

    async def check(self, *, role: Role, content: str) -> TrustCheckResult:
        payload = {"messages": [{"role": role, "content": content}]}
        try:
            response = await self._client.post(
                self._url,
                json=payload,
                headers=self._headers,
                timeout=self._timeout_seconds,
            )
        except httpx.HTTPError as error:
            raise GuardrailsCheckError(f"POST {self._url} failed: {error}") from error
        if response.status_code >= 400:
            raise GuardrailsCheckError(
                f"POST {self._url} answered {response.status_code}: "
                f"{response.text[:200]}"
            )
        try:
            body: dict[str, Any] = response.json()
        except ValueError as error:
            raise GuardrailsCheckError(
                f"POST {self._url} answered a non-JSON body"
            ) from error
        findings = tuple(
            TrustFinding(
                category=finding.get("category", ""),
                detector_name=finding.get("detector_name", ""),
                severity=finding.get("severity"),
            )
            for finding in body.get("findings") or []
        )
        return TrustCheckResult(
            blocked=body.get("outcome") == _BLOCKED_OUTCOME,
            policy_id=body.get("policy_id"),
            policy_name=body.get("policy_name"),
            findings=findings,
        )


async def check_message(
    client: TrustClient, *, role: Role, content: str
) -> TrustCheckResult:
    """`client.check`, failing open: a Switch Trust outage degrades to
    unchecked messages rather than to no messaging at all. Logged loudly
    either way, since this is the one place that gap is visible."""
    try:
        return await client.check(role=role, content=content)
    except GuardrailsCheckError:
        logger.warning(
            "Switch Trust check failed; message allowed through unchecked",
            exc_info=True,
        )
        return TrustCheckResult(blocked=False, policy_id=None, policy_name=None)
