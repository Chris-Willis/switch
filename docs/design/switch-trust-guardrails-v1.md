# Switch Trust guardrails integration, v1

Integrates Switch with **Switch Trust**, a guardrails service that evaluates a
message against a policy and returns a block/allow verdict. The service
exposes a `/guardrails/check` endpoint (see
[hoot#2397](https://github.com/sandbox-quantum/hoot/pull/2397) and its
[README](https://github.com/sandbox-quantum/hoot/blob/300cece9ec3625a5327a06aea66681c444c53139/services/aispm/guardrails/common/externalprocessor/README.md))
that takes a provider-agnostic `messages` array and returns an `outcome` plus
findings. This doc covers v1: a global, env-configured gate in front of every
message Switch sends, blocking on a `BLOCKED` outcome.

## Scope

- One guardrails policy for the whole deployment (no per-tenant override).
- Configured by environment variables only — no gateway or console UI.
- Checks the single outgoing message only — no conversation history sent.
- Only the `BLOCKED` outcome is acted on; `REDACTED`/`ALERTED`/`ERRORED` pass
  through unchanged.
- Text content only — no media/attachments, no tool call/tool result mapping.

These are deliberate v1 cuts, not an assessment that they're unneeded — see
Follow-ups.

## Where it hooks in

The single point every message passes through, regardless of origin, is
`Actor.send_message` (`core/switch_core/clients/actor.py:206`).
`HumanActor`, `AgentActor`, `SystemActor`, and bridge actors all call it before
it reaches `PostgresTransport._send` (`core/switch_core/transport/postgres.py:659`),
which is where the row is actually persisted. The guardrails check runs in
`Actor.send_message`, before the call into the transport — a blocked message
never becomes a row.

`SystemActor`'s own admin/notice sends are excluded from the check: they're
Switch's own control-plane messages (including the blocked-notice this feature
itself posts), not user or agent content.

## Enforcement flow

1. Map the outgoing message to the hoot request shape:
   ```json
   {"messages": [{"role": "<mapped>", "content": "<body>"}]}
   ```
   Role mapping: `agent` → `assistant`, `human`/`bridge` → `user`.
2. `POST {switch_trust_endpoint}/guardrails/check` — the check-only endpoint
   added in [hoot#2397](https://github.com/sandbox-quantum/hoot/pull/2397) —
   with headers `x-guardrails-policy-id` and `x-flintai-api-key`, short
   timeout (2s default).
3. `outcome == "GUARDRAIL_RESULT_OUTCOME_BLOCKED"` → block. Any other outcome
   (`OK`, `REDACTED`, `ALERTED`, `ERRORED`) → allow through unchanged.
4. On block: `Actor.send_message` raises `GuardrailBlockedError` (carrying
   `outcome`, `findings`, `policy_id`) instead of calling the transport. No row
   is created.
5. On network error, timeout, or non-2xx from Switch Trust: **fail open** —
   log a warning and let the message through unchecked. Blocking all of
   Switch's messaging on a guardrails-service outage is a worse failure mode
   than an unchecked message during an outage.

## Differentiated handling by origin

Both call sites catch `GuardrailBlockedError`; each already has the context to
react appropriately for its direction.

- **Agent-originated**, via `AgentProtocolCore.send_message`
  (`core/switch_core/bridges/agent/protocol/agent_core.py:1244`): catch the
  error, and instead of relaying the agent's real content, post a blocked
  notice into the room via `SystemActor.send_admin` with a new
  `AdminMessageType.TRUST_BLOCKED` (`core/switch_core/clients/admin_messages.py`).
  Every collaboration adapter (Slack, Mattermost, Discord, Teams, Telegram)
  already renders `admin_message()` as a platform-native system notice,
  distinct from an ordinary chat bubble — this is "visually stands out" for
  free. The agent's tool/API call gets back an error so it knows its response
  was blocked.
- **Human/bridge-originated**, at the inbound ingestion call site in
  `core/switch_core/bridges/collaboration/collaboration_core.py` where a
  platform event becomes a `human_actor.send_message(...)` call: catch the
  error and call the adapter's `admin_message(...)` back to the **originating
  platform channel** directly. The row is never created, so the message never
  reaches the room or any agent — the notice goes straight back to the
  sender's platform, not into Switch.

## Degraded-mode indicator (Switch Trust unreachable)

v1 ships with a warning log only on fail-open. A lighter-weight in-chat
indicator is worth adding as a fast-follow, reusing the mechanism Switch
already uses for "agent is working" status rather than inventing a new one:
every adapter implements `mark_activity()` (a reaction-emoji badge — 👀
working / ⏳ queued, defined per-adapter, e.g.
`core/switch_core/bridges/collaboration/slack/adapter.py:2049`) and
`post_rich`/`update_rich` (an edited-in-place turn-status card). Teams has no
reaction primitive (`supports_activity_reactions = False`), so it would only
get the card-edit treatment. Deferred out of v1 to avoid coupling the first PR
to the session/turn-rendering system — see Follow-ups.

## Config

New fields on `SwitchConfig` (`core/switch_core/config.py`), mirroring the
existing all-or-nothing settings groups (`_validate_slack_app`,
`core/switch_core/config.py:986`):

```python
switch_trust_endpoint: str = "https://api.flintai.dev"
switch_trust_api_key: str = ""
switch_trust_policy_id: str = ""
switch_trust_timeout_seconds: float = 2.0
```

`switch_trust_endpoint` is a base URL; the client appends
`/guardrails/check` — the check-only route added in
[hoot#2397](https://github.com/sandbox-quantum/hoot/pull/2397) — rather than
treating the configured value as the full check URL. This default will change
once Switch Trust has its own deployment — see Follow-ups.

A `trust_enabled` property returns `bool(switch_trust_api_key and
switch_trust_policy_id)`. A `_validate_switch_trust` model validator checks
the endpoint's URL shape (scheme/host, no path/query — mirroring
`_validate_observability`'s OTLP check) when it's overridden from the default,
and that `switch_trust_api_key`/`switch_trust_policy_id` are both set or both
empty.

When `trust_enabled` is false, a `NullTrustClient` is injected — mirrors
`telemetry/sink.py`'s `NullSink`: off is a client that always allows, so no
call site has to branch on whether the feature is on.

## Execution plan

1. **Config** — add the four `switch_trust_*` fields, `trust_enabled`
   property, and `_validate_switch_trust` validator to `SwitchConfig`. Unit
   tests mirroring the existing Slack/Discord app validator tests.
2. **Trust client** — new `core/switch_core/trust/client.py`: a `TrustClient`
   protocol (`check(role, content) -> TrustCheckResult`), an `HttpTrustClient`
   (httpx, the request/response mapping from §Enforcement flow, fail-open on
   transport errors), and a `NullTrustClient`. Unit tests for request
   building, outcome parsing, and the fail-open path.
3. **Exception + admin message type** — add `GuardrailBlockedError` (new
   module or alongside `transport` exceptions) and
   `AdminMessageType.TRUST_BLOCKED` in `admin_messages.py`.
4. **Wire the client into `Actor`** — inject `TrustClient` into `Actor`
   construction (exact DI point TBD when touching `ClientFactory`/`Actor.__init__`;
   follows the existing store/service injection pattern). Add the check at the
   top of `Actor.send_message`, skipped for `SystemActor`.
5. **Agent-origin handling** — catch `GuardrailBlockedError` in
   `AgentProtocolCore.send_message`, post the `TRUST_BLOCKED` admin message,
   surface an error back to the caller.
6. **Human/bridge-origin handling** — catch `GuardrailBlockedError` at the
   inbound ingestion call site in `collaboration_core.py`, call
   `adapter.admin_message(...)` back to the source channel instead of
   relaying.
7. **Integration tests** (real Postgres, per repo convention) — a blocked
   human message never creates a `messages` row; a blocked agent message
   results in a `TRUST_BLOCKED` admin row instead of the real content; an
   allowed message is unaffected; a Switch Trust timeout/error still delivers
   the message (fail-open).
8. **`docs/old/`**: note the new config block in whichever doc lists
   deployment env vars (none currently fully enumerates `SwitchConfig`, so
   likely just a short mention near the other optional-integration blocks, if
   one exists).

## Resolved decisions

- Prod default for `switch_trust_endpoint`: `https://api.flintai.dev` (base
  URL; the client appends `/guardrails/check`). Expected to change once Switch
  Trust has its own deployment — tracked in Follow-ups.
- 2s timeout default, and `x-guardrails-policy-id` / `x-flintai-api-key`
  headers, confirmed as-is.
- Reaction-badge degraded-mode indicator deferred to a fast-follow rather than
  bundled into this PR.

## Follow-ups (explicitly out of v1 scope)

- **`switch_trust_endpoint` default will change**: `https://api.flintai.dev`
  is a placeholder base URL for now; Switch Trust is expected to get its own
  dedicated endpoint later, at which point the default should move.
- **Conversation history**: send the last N room messages as context so the
  policy can catch things that only make sense across turns (e.g. a PII leak
  split across messages). Needs a role-mapping strategy for Switch's
  multi-party rooms (which don't have a strict two-party turn structure) and a
  decision on including/excluding system/admin notices.
- **Tool calls / tool results**: the hoot endpoint supports `tool_calls` and
  `tool_result` message fields; Switch doesn't yet have an obvious mapping
  from its agent-protocol tool use onto that shape.
- **Redaction / alert handling**: act on `REDACTED` (replace content with the
  engine's sanitized version) and `ALERTED` (log/flag without blocking)
  outcomes instead of only hard-blocking.
- **Per-tenant / per-workspace policy**: today it's one global policy for the
  whole deployment. Multiple tenants wanting different policies needs a DB
  table, migration, and an admin API — a materially bigger lift than the env
  var config in this doc.
- **Settings UI**: a dedicated Switch Trust section, either in the gateway
  operator dashboard or in Console's "server properties" — neither surface has
  an existing settings page to extend today, so this is new UI work in either
  home.
- **Degraded-mode in-chat indicator**: the reaction-badge/turn-status
  treatment sketched above, once the core gate has shipped and proven out.
- **Media/attachment checks**: images and files aren't sent to Switch Trust in
  v1.
