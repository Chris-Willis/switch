# Switch agents controller (headless)

`switch-agent-controller` runs the Switch agents that Management assigns to this
machine and reports their status. Run one per machine. It is the headless half of
"agent management and agent controllers v1". The design is in
`docs/design/agent-controllers-v1.md`, and the wire contract in
`docs/design/controller-contract-v1.md`.

Each assigned agent runs as a room watcher, through the same shared-host bundle
(`@switch-console/agent-providers/shared-host-daemon`) that Switch Console deploys to
SSH hosts. Messages still reach each agent over its own watcher connection to the
agent bridge. The controller decides what runs, and the watchers do the running.

## Requirements

- macOS or Linux. The shared host needs POSIX process control.
- Node 22.13 or later. The store uses the built-in `node:sqlite`.
- The workspace packages built, so the shared-host bundle exists:
  `pnpm install && pnpm -r --filter './packages/**' run build` from `console/`.
- Each provider CLI the agents use, installed on `PATH` and signed in as the user
  the controller runs as (`claude`, `codex`, `opencode`, `agent`/`cursor-agent`,
  `antigravity-acp`).
- A Switch server with `AGENT_MANAGEMENT_ENABLED=true`.

## Enroll and run

Create a one-time enrollment code in Switch. It is valid for 10 minutes. Then:

```bash
node packages/agent-controller/dist/cli.mjs enroll \
  --server https://switch.example.com \
  --code <code> \
  [--name build-box] [--data-dir <dir>]

node packages/agent-controller/dist/cli.mjs run [--data-dir <dir>]
node packages/agent-controller/dist/cli.mjs status [--data-dir <dir>]
```

- `--server` is the agent bridge URL. It is the same URL agents use as
  `SWITCH_API_ENDPOINT`, and it must be `https`. Plain `http` is accepted only for a
  loopback server.
- `--name` defaults to the host name.
- `status` reads only local state. It makes no network call.
- Logging goes to stderr. Set the level with `SWITCH_CONTROLLER_LOG_LEVEL`
  (`debug`, `info`, `warn`, `error`; the default is `info`).
- Exit codes:
  - `0`: stopped by SIGINT/SIGTERM.
  - `1`: error.
  - `2`: usage error.
  - `3`: the server revoked this controller.

Stopping the controller does **not** stop its agents. The watchers are detached
processes, and they keep running the last assignment. The next `run` picks them up.
Agents stop when Management says so, or when the controller is revoked.

To run it as a service, have your init system run `run` and restart it on exit code
`1`. Do not restart it on `3`, because a revoked controller must be enrolled again.

## What v1 does

- Exchanges its long-lived credential for a one-hour access token. It refreshes the
  token at 80% of its lifetime, and exchanges once more if a request is refused
  with a 401.
- Holds the nudge stream (`GET /v1/controllers/{id}/events`) open, and reconnects
  with backoff. It also reconnects when no byte, including a keepalive, arrives
  for 45 s.
- On every connect and every `assignment.changed`, it pulls the assignment with
  `If-None-Match` and reconciles. It also resyncs fully every 10 minutes.
- Reconciles each agent:
  - **Desired `running`, not yet applied:** fetches the agent's API key. That
    fetch rotates the key, which fences out any earlier holder. The controller
    then writes the key to `<data>/agents/<id>/credentials.json` (0600), prepares
    the working directory, writes the watcher root
    `<data>/watchers/<id>/` (`watch.json`, `template.json`), and runs the bundle
    with `--ensure-watch false`.
  - **Desired `running`, at a newer revision:** the same, as a restart. The
    watcher is turned off and waited out, then launched again with the new
    template.
  - **Desired `running`, watcher gone with no recorded failure** (after a
    reboot, say): the watcher is launched again.
  - **Watcher refused its key:** the key is fetched again and the watcher
    relaunched. This happens at most once every 10 minutes per agent.
  - **Watcher failed or was taken over:** it is left down, and reported as
    `failed`. A new revision or an `agent.restart` brings it back.
  - **Desired `stopped`:** `watch.json` is set to `{enabled: false}`.
  - **Removed from the assignment:** it is stopped, and its key file is deleted.
  - **Revision older than the one already applied:** the controller refuses it
    (fencing).
- Status (`PUT .../status`) is sent on every observed change and at least every
  `report_within_s`, and never more than once a second. It carries:
  - **Machine:** platform, disk, memory, sessions.
  - **Providers:** installed (a `PATH` lookup and `--version`), and login (the
    bundle's `--probe`, cached for 10 minutes).
  - **Agents:** each one read from its watcher's `health.json` and
    `supervisor/failure.json`.
- Operations:
  - `agent.restart` and `provider.recheck` run.
  - Every other kind is answered `failed` with `operation_unsupported`.
- On `credential.revoked`, or on any request refused as `controller_revoked`: it
  turns every agent off, deletes their key files and the controller credential,
  and exits with code `3`.

## What v1 does not do

- Controllers do not act as agents on `/agents/{id}/...`. Each agent still uses its
  own rotated API key.
- No agent events on the controller stream.
- No connector tokens, no sealed provider logins, and no session relay.
- Only enrollment by one-time code. There is no EC2 machine secret and no OS
  keychain.
- No session limit is enforced. `sessions_max` is reported as `0`.
- OOM kills are not detected. `oom_kills` is always `0`.
- `restarts_10m` counts the relaunches this controller made, not the restarts a
  watcher's own supervisor made.
- No crash-loop guard. A watcher that exits with an error stays down until it is
  restarted on purpose, so there is no loop to guard.
- Windows is not supported.

## Where data lives

The data directory is the first of these that is set:

1. `--data-dir`
2. `SWITCH_CONTROLLER_DATA_DIR`
3. the OS default:
   - macOS: `~/Library/Application Support/Switch/agent-controller`
   - Linux: `$XDG_STATE_HOME/switch/agent-controller`, or
     `~/.local/state/switch/agent-controller`

The directory is created with mode 0700, and tightened to 0700 if it already exists.
It holds:

| Path | What |
|---|---|
| `controller.db` | SQLite: identity, cached assignment, per-agent applied revision and local failures, restart times, status seq. Everything except the identity can be rebuilt from the server. |
| `secrets/controller-credential` | The controller credential (see below). |
| `agents/<id>/credentials.json` | Each agent's API key, in the layout the shared host reads. |
| `watchers/<id>/` | Each agent's watcher state root: `watch.json`, `template.json`, `config.json`, `health.json`, `supervisor/` logs and failure record. |
| `workspaces/<name>/` | The working directory of an agent whose definition sets none. |

Sessions a watcher starts keep their state where the shared host puts it
(`~/.local/state/switch/sdk-sessions/`), as they do under Console.

## The file secret store

v1 keeps the controller credential in a plaintext file. The file has mode 0600 and
sits in a 0700 directory. No OS keychain backend exists yet, and the controller logs
a warning saying so every time it starts. Anyone who can read this user's files, or
a backup of them, can act as this controller until it is revoked. If the file is
ever readable by other users, the controller refuses to use it. In that case, revoke
the controller in Switch and enroll it again. Agent keys are plaintext files too,
and the shared host needs them that way.
