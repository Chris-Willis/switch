# Handoff: Switch pilot stability (connection-lapse / pool-exhaustion bursts)

Status snapshot for whoever picks this up. This branch (`fix/gateway-session-scope`)
carries a **partially complete** code change (see §5). The investigation and the
other changes are described so you have the full picture.

Operational how-to (reading Datadog + kube for this system) lives in the
**`switch-health` skill in the napoleon repo** — use it for any "check how the
server is doing" step below. Do not put infra names/IDs/credentials in this repo
(it is public); keep those in napoleon.

## 1. Symptom
On the pilot, agents drop and reconnect in **bursts** ("heartbeat lapsed"). In the
worst bursts the DB connection pool times out, auth on heartbeats fails, and it
snowballs (late beats → more lapses → more reconnects).

## 2. Root cause (evidence-backed, from live metrics + a py-spy profile + logs)
- **Not the database.** Query latency stayed flat (~44 ms p95) through a burst;
  `DBLoad` ~idle. Not CPU-throttled, not out of DB connections.
- **The bottleneck is the single asyncio worker (event loop).** During the burst
  `runtime.event_loop_lag` spiked to ~240 ms (idle ≈ 2 ms). A DB connection stays
  checked out for as long as its coroutine is *running or waiting for a turn on the
  worker* — not just while the (fast) query runs. So under a stampede, connections
  are held across scheduling waits, the pool (30 + 10 overflow = 40) fills, and
  requests time out (`db_pool_timeout` = 5 s). Timeouts landed in the exact minute
  lag peaked; as lag eased, the pool still hit 40 but drained without timing out.
- **The trigger is simultaneity, not volume.** Steady state is fine; a
  restart/lapse-cascade makes the whole fleet reconnect *at the same instant*
  (their 2 s beat timers and 5 s auth-cache entries end up synchronized), so all
  the work lands together.
- **Two feeders of pool pressure:**
  1. **Held connections** — gateway handlers hold a request-scoped DB session
     across slow Matrix/Slack calls (parked slots). → the fix on this branch (§5).
  2. **Per-request/query CPU + catch-up serialization** — py-spy (steady state)
     showed the worker's baseline CPU is dominated by **SQLAlchemy per-query
     statement compile/param-processing + TLS reads**, driven by the volume of
     beats (~3,800/min) and gateway status-polling (~100/min). Pydantic
     serialization is a **burst-only** cost (catch-up replay), not the baseline.

## 3. What each metric means / where to look
Datadog service `switch-core` (pilot). Key metrics: `agent.connections_expired`
(the lapses), `runtime.event_loop_lag`, `db.pool.in_use` (now a **peak**),
`db.pool.timeouts` (new), `db.query.duration`, `http.request.duration` by route.
Reading guide + queries: napoleon `switch-health` skill.

## 4. Already shipped
- **switch #560 — MERGED** (in image 0.28.1): `db.pool.in_use` is now a peak
  (catches sub-second spikes the old snapshot missed) + new `db.pool.timeouts`
  counter, dashboard panel, and a "pool refusing connections" monitor.
- **napoleon #407 — MERGED**: pilot exports metrics to Datadog.
- **napoleon #409 — open**: turn on OTLP **logs** for dev + pilot (pilot is
  already running with logs on as of the last deploy).
- **napoleon #411 — open**: the `switch-health` skill (DD + kube runbook).
- **The session-ownership redesign is IN 0.28.1**: switch-core no longer holds/
  fans out full transcripts — events are small ("every write is one small row").
  So payload size is *not* the remaining problem; simultaneity is.

Current deploy: **0.28.1**, metrics + logs exporting. A deploy itself causes a
reconnect stampede by design (everyone reconnects at once) — expect a burst on
every `deploy-env pilot`; it self-recovers in a few minutes.

## 5. THIS branch — gateway session-scope fix (PARTIAL, untested)
Goal: stop gateway handlers from holding a pooled DB connection across external
(Matrix/Slack/adapter) calls. Rule: **scope the session to its DB work and close
it before the external call; keep co-committed writes atomic** (do NOT split a
multi-write transaction into separate sessions). Exemplar to copy:
`core/switch_core/gateway/messaging_installs.py::disconnect_install`.

Only `core/switch_core/gateway/rooms.py` is edited so far (uncommitted work was
committed as WIP). It adds two helpers — `_authorize_room_action` (auth on a
short session) and `_room_detail_response` (read-back on a short session after
external work) — and converts these handlers to `get_session_factory`:
- `create_room_from_yaml`, `post_room_agents`, `delete_room_agent`,
  `post_room_users`, `_set_archived`.

**Not done / verify:**
- `_set_archived` was mid-edit when the previous agent stalled — **review it
  first**.
- `create_room_from_yaml` computes `is_admin` in a short block — verify it's still
  passed/used correctly downstream.
- **Not yet converted in rooms.py:** `create_room` (the main one) and
  `delete_room`.
- **Other files not started:** `gateway/collaborations.py` (`delete_bridge`,
  directory search), `gateway/agents.py` (register/delete → `register_agent`/
  `delete_agent`), `gateway/connectors.py` (`delete_connector`), and
  `bridges/agent/api/handlers.py` register endpoints (they hold the session via
  `_resolve_registration_user_id` across `_create_bridge_identities` Matrix calls).
- **Nothing is tested.** `ruff` passes; `mypy` and the gateway pytest suite have
  NOT been run. Gateway store tests need Postgres (testcontainers): set
  `DOCKER_HOST` to the local Docker socket and `TESTCONTAINERS_RYUK_DISABLED=true`.
- Leave pure-read endpoints alone (e.g. `list_rooms`, `GET /agents/{id}`) — they
  don't hold across external calls.

## 6. Remaining work, prioritized
1. **Finish this branch** (§5) + tests, open PR.
2. **Jitter / desynchronize** heartbeats and reconnects (client side: Switch
   Console + sidecar), and consider not lapsing on a single missed beat / adding
   reconnect backoff. This attacks simultaneity — likely the highest-leverage fix.
3. **Move Switch Console off status-polling** (`GET /gateway/agents/{id}` ~100/min)
   onto the push stream it already holds — removes constant pool pressure.
4. **Serialize each event once, reuse across a connection's reads** (helps
   catch-up replay); and look at the SQLAlchemy expanding-param queries that
   re-render each call (`_process_parameters_for_postcompile` showed up hot).
5. Consider a modest **pool size bump** as headroom while the above land (DB has
   ample capacity), and jitter the auth-cache TTL.

## 7. Key files
- `core/switch_core/bridges/agent/protocol/stream.py` — per-connection delivery /
  catch-up (serialization at ~L371).
- `core/switch_core/bridges/agent/protocol/event_buffer.py` — per-agent buffer.
- `core/switch_core/bridges/agent/protocol/connections.py` — heartbeat TTL (6 s),
  the sweep, `db.pool.timeouts` counter site is in `observability/http.py`.
- `core/switch_core/bridges/agent/auth.py` — per-request token resolution (the
  work heartbeats pay before their handler runs).
- `core/switch_core/observability/{pool,catalogue,http,runtime}.py` — metrics.
- `core/switch_core/gateway/*.py` — the handlers this branch is fixing.
