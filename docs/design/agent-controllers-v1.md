# Agent management and agent controllers: v1 implementation spec

Status: in progress. This is the implementation spec for the first slice of the
agent-controller design. It covers the **Core management module behind a flag** and the
**headless agents controller**. The full target contract is
`controller-contract-v1.md` (to be added alongside); this file says what v1 builds, and
where it deliberately stops short.

## Shape

- **Management** (Core package `switch_core/management/`, off unless
  `AGENT_MANAGEMENT_ENABLED=true`): the source of truth for managed agents. It holds agent
  definitions, which controller each one runs on, controller enrollment and credentials,
  controller status, and operations.
- **Agents controller** (`console/packages/agent-controller`, a Node CLI): one per
  machine. It pulls its assignment, runs each assigned agent through the existing
  shared-host watcher (the same `--watch-*` runtime the Console sidecar uses), and reports
  status.
- Core's messaging path is unchanged. Each managed agent still holds its own per-agent
  watcher connection to the agent bridge.

## v1 scope and deliberate deviations from the target contract

| Target contract | v1 | Why |
|---|---|---|
| Controllers act as agents on `/agents/{id}/...` with a controller token | **Not in v1.** The controller fetches a per-agent API key from Management for each bound agent. Every fetch **rotates** the key, which invalidates any earlier holder | The watcher and session hosts read the agent token once, from the credentials file, and cannot refresh a short-lived token. Moving to scoped tokens needs a runtime change first |
| One SSE stream per controller carrying agent events | **The controller stream carries only nudges** (`assignment.changed`, `operation.pending`, `credential.revoked`). Agent events stay on per-agent watcher streams | Avoids touching message delivery. That is roadmap step 7 |
| Connector tokens, sealed provider logins, session relay | Not in v1 | Later steps |
| Enrollment by EC2 machine secret | Not in v1. Supported: Console sign-in (gateway) and one-time code (headless) | |
| Operations | `agent.restart` and `provider.recheck` only. Core rejects other kinds with `400 operation_unsupported` | |
| Per-tenant flag | Deployment-wide env flag | No per-tenant flag mechanism exists yet |

## Core

### Config (`config.py`)
- `agent_management_enabled: bool = False` (`AGENT_MANAGEMENT_ENABLED`).
- `controller_token_secret: str | None = None` (`CONTROLLER_TOKEN_SECRET`). **Required
  when the flag is on**: a model validator raises if it is missing or shorter than 32 chars. It is
  separate from `jwt_secret_key` on purpose.
- `controller_status_interval_seconds: int = 60`. Returned to controllers as `report_within_s`.
  A controller is `unknown` after 3 intervals without a status.

With the flag off, none of the routes below are mounted, and the middleware branch is
inactive.

### Tables (all `TenantScoped`, RLS like every scoped table, one migration)
- `agent_controllers`
  - `id`, `owner_id` (users), `name`, `kind` (`console|daemon|ec2`), `platform` JSONB null,
    `version` null, `public_key` null.
  - `api_key_id`: the credential, an `api_keys` row of type `controller`, holding the hash only.
  - `assignment_revision` int default 0, `status_seq` bigint null, `status` JSONB null.
  - `last_seen_at` null, `revoked_at` null, `created_at`, `updated_at`.
- `agent_controller_enrollment_codes`: `id`, `owner_id`, `api_key_id` (an `api_keys` row of
  type `controller_enrollment`, so the existing global hash → tenant lookup works),
  `expires_at`, `used_at` null, `controller_id` null, `created_at`.
- `agent_definitions`: `id`, `agent_id` (FK agents, cascade, unique per tenant),
  `owner_id`, `controller_id` (FK agent_controllers, null = unplaced), `revision` int,
  `desired_state` (`running|stopped`), `definition` JSONB, `created_at`, `updated_at`.
- `agent_controller_operations`: `id`, `controller_id`, `agent_id` null, `kind`,
  `params` JSONB, `state` (`pending|claimed|succeeded|failed|cancelled|expired`),
  `lease_expires_at` null, `result` JSONB null, `created_by` (users), `created_at`, `updated_at`.

Controller and enrollment `api_keys` rows **must not** appear in the user's API-key list,
and must not be revealable. `encrypted_key` holds an empty string for these types, because
nothing may decrypt them.

### Credentials and tokens
- Controller credential: `swcc_` + `token_urlsafe(32)`. It is stored as a sha256 hash, as an
  `api_keys` row of type `controller`.
- Enrollment code: `swce_` + `token_urlsafe(18)`. Single use, valid for 10 minutes.
- Access token: `swct_` + an HS256 JWT signed with `controller_token_secret`.
  - `aud="switch-controller"`, claims `cid`, `tid` (tenant), `oid` (owner), `iat`, `exp`.
  - Valid for 1 hour.
- Every POST/PUT that creates something accepts `Idempotency-Key`. v1 may treat that as
  best effort, but naturally idempotent routes (claim, result) must be idempotent.

### Agent-bridge routes (bearer). Errors use `{"error": {"code", "message", "retryable"}}`
Public (they authenticate through the body):
- `POST /v1/management/controllers/enroll`
  - Body: `{proof:{kind:"enrollment_code", code}, controller:{kind, name, platform, version}, public_key?}`.
  - Returns `201 {controller_id, credential}`.
- `POST /v1/management/controllers/{id}/token`
  - Body: `{credential}`.
  - Returns `200 {access_token, expires_at}`, or `401 controller_revoked | invalid_credential`.

Controller access token (`{id}` must match the token's `cid`, otherwise `403 forbidden`):
- `POST /v1/management/controllers/{id}/credential/rotate` returns `{credential}`.
- `GET  /v1/management/controllers/{id}/assignment`
  - Honours `If-None-Match`; returns `200` with an `ETag` header, or `304`.
- `PUT  /v1/management/controllers/{id}/status`
  - Body: a `StatusReport`.
  - Returns `{assignment_revision, report_within_s}`.
  - An older `seq` is ignored, and the response is still 200.
- `GET  /v1/management/controllers/{id}/operations?state=pending`
  - Expired leases are re-offered.
- `POST /v1/management/operations/{op}/claim`
  - Returns the operation with `lease_expires_at` (5 min), or `409 already_claimed | 410 cancelled`.
- `POST /v1/management/operations/{op}/progress` renews the lease. Returns `204`.
- `POST /v1/management/operations/{op}/result`
  - Body: `{outcome:"succeeded", output?} | {outcome:"failed", error:{code,message}}`.
  - Returns `204`.
- `POST /v1/management/controllers/{id}/agents/{agent_id}/credentials` (v1 only)
  - Returns `{agent_id, api_key}`, or `403 not_assigned`.
  - Rotates the agent's API key (`AgentCore.rotate_agent_api_key`).
- `GET  /v1/controllers/{id}/events` (SSE)
  - The first frame is `connection_state {controller_id, assignment_revision, report_within_s}`.
  - Then `assignment.changed {revision}`, `operation.pending {operation_id, kind, agent_id}`,
    and `credential.revoked {}`.
  - A `: keepalive` comment is sent every 15s.
  - Notifications are process-local (an in-memory notifier, since Core is single process).
    A controller resyncs fully on every reconnect.

### Gateway routes (cookie, `get_current_user`, owner-only)
- `POST   /gateway/management/enrollment-codes` returns `{code, expires_at}`.
- `POST   /gateway/management/controllers`
  - Console enrollment by a signed-in user.
  - Body: `{name, kind:"console", platform, version, public_key?}`.
  - Returns `{controller_id, credential}`.
- `GET    /gateway/management/controllers`
  - Returns the list, each with derived `state` (`online|unknown|revoked`), `last_seen_at` and its last `status`.
- `DELETE /gateway/management/controllers/{id}`
  - Revokes it: deletes the credential, sends the `credential.revoked` nudge, and leaves definitions placed but shown.
- `GET    /gateway/management/agents` and `GET /gateway/management/agents/{agent_id}`.
- `POST   /gateway/management/agents` creates and places a new agent.
  - Body: `{name, description, display_name?, controller_id, desired_state, definition}`.
  - It registers the agent through `AgentCore.register_agent`, using the known-agent spec for the provider
    (`claude→claude-code`, `codex`, `opencode`, `antigravity`, `cursor`), with `auto_session` taken from the definition and `owner_only=True`.
- `PUT    /gateway/management/agents/{agent_id}`
  - Adopts an agent the user already owns, or replaces its definition and placement.
- `PATCH  /gateway/management/agents/{agent_id}`
  - Changes `definition`, `desired_state` or `controller_id`.
  - Moving bumps both controllers' `assignment_revision`. The new controller's credential fetch rotates the key, which fences the old one out.
- `DELETE /gateway/management/agents/{agent_id}`
  - Stops managing the agent: removes the definition, and the controller stops it. It does not delete the agent.
- `POST   /gateway/management/operations` and `GET /gateway/management/operations?controller_id=`.

**Placement checks** run on create, adopt and move, and on a change to `running`. Each failure returns `409` with a reason:
- `controller_revoked`
- `controller_offline`: no status, or the last status is stale
- `provider_not_installed`
- `provider_login_missing` or `provider_login_expired`

A provider whose `auth` is `unknown` passes.

Any change that affects a controller bumps its `assignment_revision` and nudges it.

### Definition (v1)
```json
{"provider": "claude|codex|opencode|antigravity|cursor",
 "model": null, "instructions": "", "auto_session": true, "auto_approve": false,
 "directory": null}
```

The assignment entry adds the agent's `name`, `display_name` and `icon_url`, read from the agents row.

### Reason codes
These are the codes from the contract, plus `forbidden`, `invalid_credential`, `enrollment_code_invalid`,
`operation_unsupported`, `not_found` and `validation_error`.

### Contract fixtures
`core/tests/switch_core/fixtures/agent_controllers/` holds one JSON file per wire message.
- Core tests check that real route responses match the fixture's shape, with volatile values normalised.
- The controller's TypeScript tests parse the same files with its schemas.

## Headless agents controller (`console/packages/agent-controller`)

- CLI `switch-agent-controller`:
  - `enroll --server <agent-bridge-url> --code <code> [--name] [--data-dir]`
  - `run [--data-dir]`
  - `status [--data-dir]`
- **Data dir:** `SWITCH_CONTROLLER_DATA_DIR`, otherwise the OS default.
  - macOS: `~/Library/Application Support/Switch/agent-controller`
  - Linux: `$XDG_STATE_HOME/switch/agent-controller`, or `~/.local/state/switch/agent-controller`
  - Mode 0700.
- **Store:** `node:sqlite`, one file. It holds identity, the assignment cache, per-agent applied revision and
  runtime state, and the status seq. It is a cache that can be rebuilt from the server.
- **Secrets:** behind a `SecretStore` interface. v1 ships a file backend (0600) that **logs a
  warning at startup**, saying no OS keychain backend is in use.
- **Run loop:**
  1. Exchange the token, refreshing it before expiry. On `controller_revoked`: stop all agents, wipe the credential, and exit non-zero.
  2. Open the nudge stream, reconnecting with backoff.
  3. On connect and on `assignment.changed`: pull the assignment with ETag, then reconcile.
  4. On `operation.pending`: list, claim, execute and report.
  5. As a safety net, resync fully every 10 minutes.
- **Reconcile, per agent:**
  - Running, and not applied or at an older revision:
    1. Ensure the credentials: fetch from the credentials endpoint if there is no local file, or after an auth failure.
    2. Write them to `<data>/agents/<id>/credentials.json` (0600), outside the agent's working directory.
    3. Ensure the working directory: `definition.directory`, otherwise `<data>/workspaces/<name>`.
    4. Write the watcher root `<data>/watchers/<id>/` with `watch.json {enabled:true, spawn:auto_session}` and a `SharedHostConfig` template, as the Console builds.
    5. Run the agent-providers shared-host bundle with `--ensure-watch false`, or `--restart` when the revision changed.
  - Stopped or removed: write `watch.json {enabled:false}`, and delete the credentials of removed agents.
- **Status:** sent on every change, and every `report_within_s`.
  - Machine: os, arch, disk, memory, sessions.
  - Providers: installed via a PATH lookup, auth via the bundle's `--probe`, cached for 10 min. `provider.recheck` forces a probe.
  - Agents: read from each watcher's `health.json` and `supervisor/failure.json`, mapped to the contract's process states and reason codes.
- **Operations:** `agent.restart` runs `--restart`. `provider.recheck` forces a probe and reports.
