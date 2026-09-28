# The distributed Telegram app — design spike

**Design and plan only — no implementation.** This is the Telegram counterpart
to the distributed Slack app (`SLACK_DISTRIBUTED_APP.md`, built) and the
distributed Discord app (`DISCORD_DISTRIBUTED_APP.md`, in review).
`TELEGRAM_SETUP.md` describes the bot **an operator registers for themselves**:
they talk to BotFather, paste the token into Switch, and add the bot to their
own chats. This page describes the other one, a bot **we** register once per
deployment. A customer attaches their groups to it by tapping a link Switch
gives them, and never sees a token.

They are two separate bots and both will exist. Nothing here replaces the other
page. It reuses the messaging-install machinery built for Slack: the
`messaging_installs` table, the signed single-use install state, the tenant
lookup exempt from row-level security, and the `/messaging` webhook routes. It
also reuses the tokenless-install and shared-connection seams from the Discord
work. Only what differs is argued here.

## Why Telegram is neither Slack nor Discord

Four facts about Telegram decide the design.

- **There is no OAuth and no install.** Adding a bot to a group grants nothing
  and returns nothing to any server. Slack's and Discord's installs work by
  carrying Switch's signed `state` through the platform's consent screen, which
  hands it back with a code. Telegram has no such screen. The only thing that
  can ride along with an add is the **deep-link start parameter**:
  `t.me/<bot>?startgroup=<payload>`. Telegram posts the payload into the group
  as `/start@<bot> <payload>` right after the bot is added. The payload is
  limited to **1–64 characters of `[A-Za-z0-9_-]`**. The v1 install state
  (`install_state.py`) is about 150 characters, so it does not fit.
- **There is no workspace.** Slack has a workspace and Discord has a guild: one
  container, installed once, holding many channels. Telegram has only chats.
  Each group, supergroup and channel is its own membership, so what a tenant
  "installs" is one chat at a time.
- **The routing key can change.** A basic group that becomes a supergroup gets a
  brand new chat id, silently. The self-hosted adapter already follows this for
  rooms (`telegram/adapter.py:2537` `_handle_migration` →
  `bridge_core.py:1019` `_handle_channel_migrated` → `room_store.py:397`
  `update_external_channel`). A distributed install is keyed by that same id,
  so it has to follow as well.
- **One bot has exactly one delivery channel.** Telegram delivers updates
  either by long polling (`getUpdates`, what `TELEGRAM_SETUP.md` uses) or by
  webhook, never both. A set webhook makes `getUpdates` fail. One token
  therefore means one consumer, the same shape as Discord's one Gateway
  connection. Unlike Discord, Telegram *does* offer HTTP push, and it
  authenticates it with a secret header, so the existing webhook routes fit.

Like Discord's, the bot token is **one credential for every tenant**. No
per-chat secret exists to capture or store.

## What a tenant and a chat are here

A *tenant* is a Switch customer: the row-level-security boundary that owns
agents, rooms and installs. A Telegram *chat* is one group, supergroup or
channel. A tenant may connect many chats. Each chat belongs to exactly one
tenant, which the deployment-wide partial unique index
`uq_messaging_installs_workspace` on `(platform, external_workspace_id) WHERE
status = 'active'` enforces, with `external_workspace_id` holding the chat id.

A *bridge* is one per tenant, not one per chat (decision 2). All of a tenant's
Telegram chats are rooms on that one bridge. That is also how a self-hosted
Telegram bridge looks: one bot, many groups.

Direct messages with the bot stay what they are on the self-hosted bridge: a
lobby that gets a guidance reply and no room (`TELEGRAM_SETUP.md`, "Not a
private chat with the bot"). A DM carries no chat a tenant has claimed, so it
cannot be attributed to anyone. On the shared bot the reply cannot come from a
tenant's adapter, because a DM resolves to no tenant. It is sent by the
`TelegramAppClient` from the unowned-chat hook (change 8, stage 5). Until that
lands, a DM is dropped with no reply.

## Decisions

1. **Each chat is one `messaging_installs` row.** `platform = 'telegram'` and
   `external_workspace_id = <chat id>`. This reuses, unchanged:
   - the unique index, so a chat another tenant already holds is refused with
     `MessagingInstallClaimedError`;
   - the exempt `tenant_of_messaging_install(platform, workspace_id)`, so no new
     function bypasses row-level security;
   - the scoped re-read in `MessagingInstallService.resolve`
     (`install_service.py:460`), so a wrong lookup is a miss rather than a
     cross-tenant read.

   `encrypted_bot_token` is null on every Telegram row, which is the nullable
   column the Discord work introduces.

2. **One shared-delivery bridge per tenant, and every chat install points at
   it.** The tenant's first claim registers the bridge. Later claims attach to
   it.

   *Why not a bridge per chat*, which would have fitted main's one install →
   one bridge shape with no shared changes: `ExternalUser` is unique on
   `(bridge_id, external_user_id)` (`models.py:1402`). Identity is per bridge.
   With a bridge per chat, a person would have to link their Telegram account
   again in every group, and an agent set to answer only its owner would treat
   its owner as a stranger in every group they had not linked in. One bridge
   per tenant makes one link cover every group, as it does on the self-hosted
   bridge.

   The cost is that main's install layer assumes one install per bridge. Five
   shared changes lift that, and none of them changes Slack's behaviour (see
   [Changes to shared code](#changes-to-shared-code)).

3. **A claim is a compact signed token in the deep link.** Groups use
   `?startgroup=<token>`. Channels use `/connect <token>` posted in the channel,
   because a channel add sends no `/start` (the `startchannel` parameter carries
   no payload; see `_handle_start`, `telegram/adapter.py:2618`).

   The token is `c1` followed by the base64url encoding of 44 bytes:

   | bytes | content |
   | --- | --- |
   | 16 | tenant id (UUID) |
   | 16 | install-state id (UUID, the `messaging_install_states` row) |
   | 12 | HMAC-SHA256 over the above, truncated |

   That is 61 characters, inside the 64 limit and inside the allowed alphabet.
   The HMAC key is derived from `JWT_SECRET_KEY` like the v1 key, but under its
   own label (`telegram-claim`). Two things follow from that: a v1 token and a
   compact one cannot stand in for each other, and the platform is implied by
   the key rather than spelled out in the token. Everything else is the v1
   state's behaviour, unchanged:
   - single use: the state row is burnt through `redeem_state`
     (`messaging_install_store.py:79`);
   - `STATE_TTL` is 10 minutes;
   - the tenant comes only from the signature, never from the request.

   *Why not a random short code looked up in the database.* The token has to be
   resolved before any tenant is known. A lookup table would need a new
   row-level-security exemption, and `install_state.py:12-15` argues against
   exactly that. A signed token carries its own tenant, the same as v1.

4. **Inbound is a webhook on the existing routes:
   `POST /messaging/telegram/events`** on `MESSAGING_PUBLIC_URL`.
   `setWebhook` is called at boot with the URL, `secret_token` and
   `allowed_updates` (main's `_ALLOWED_UPDATES`: `message`, `channel_post`,
   `my_chat_member`, `callback_query`). The Telegram installer implements the
   webhook half of `MessagingAppInstaller`:
   - `verify_webhook`: a constant-time comparison of
     `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_APP_WEBHOOK_SECRET`.
     This is the only authenticity proof. Telegram does not sign bodies.
   - `parse_webhook`: `update_id` becomes `external_event_id`, so Telegram's
     retries are deduplicated by the existing receipts.
   - `workspace_of_event`: the chat id of `message`, `channel_post`,
     `my_chat_member` or `callback_query.message`. For a migration notice it is
     the *old* chat id (decision 6).
   - `revocation_of_event`: a `my_chat_member` update whose new status is
     `left` or `kicked` for the bot. It is checked before resolve, as for Slack
     (`install_routes.py:260`).
   - `claim_of_event` (new, decision 3): an `InstallClaim` holding the token
     from `/start@<bot> <token>` or `/connect <token>`, and the grant the event
     amounts to (the chat id, and the name the tenant's bridge gets if this
     claim creates it). It is checked before resolve too, because the chat it
     arrives from is not owned yet.

   Main's status codes already say the right thing to Telegram:
   - an unowned chat → 200, so Telegram stops retrying;
   - a bridge that isn't running → 503, so Telegram retries non-2XX responses
     for a while;
   - a bad secret → 401.

5. **Tenant adapters run in shared-delivery mode.** `TelegramConnectionConfig`
   gets the same hidden discriminator the Discord work gives
   `DiscordConnectionConfig`: `event_delivery:
   SkipJsonSchema[Literal["own_connection", "shared"]] = "own_connection"`,
   with `bot_token` and `bot_username` absent under `shared`. A validator
   refuses the half-states. Under `shared` the adapter:
   - opens no polling loop and never calls `set_my_commands`;
   - receives inbound through `dispatch_event(update)` from the webhook route;
   - sends outbound through a shared handle attached via the Discord work's
     `SupportsSharedConnection`.

   The handle is one deployment-level `TelegramAppClient`. It holds one
   `telegram.Bot` and one **deployment-wide** 429 cooldown. Today the cooldown
   lives on each adapter instance "for the bot" (`telegram/adapter.py:541-551`),
   which is right for one bot per adapter and wrong once every tenant's adapter
   shares the bot: a 429 for one tenant is a 429 for all of them. The client
   also owns what is per bot rather than per tenant:
   - `getMe` at boot, for the username;
   - `setWebhook` and `setMyCommands`;
   - the unclaimed-chat notice (below);
   - `leaveChat` (below).

   Tenants share the bot's global send rate (about 30 messages a second). Fair
   queuing between tenants is deferred.

6. **A supergroup migration re-keys the install row as well as the room.**
   Telegram announces the move from both sides: `migrate_to_chat_id` on the old
   chat's last message and `migrate_from_chat_id` on the new chat's first. Only
   the first one resolves naturally, because the new id is owned by nobody yet.
   So `workspace_of_event` answers the *old* id for a `migrate_from` message
   too, and either message resolves to the right tenant. A new
   `migration_of_event(payload) -> tuple[str, str] | None` (default `None`)
   lets the service re-key the install row, scoped to that tenant, **inline
   before answering**. The update is then dispatched as today, so the adapter
   re-keys the room. Whichever message arrives second finds the work done, as
   `_handle_migration` already expects.

7. **Telegram bridges declare an `exclusive_resource`: the bot id**, the part
   of the token before `:`. Two self-hosted bridges on one token split
   `getUpdates` between them at random (`telegram.md`, "Run one bridge per
   bot"), and nothing refuses that today. Only Teams implements
   `exclusive_resource` (`teams/adapter.py:636`). Registering a self-hosted
   bridge with **the deployment bot's token** is refused as well: its
   `getUpdates` would fail against the webhook, and a tenant pasting that token
   would take over every other tenant's delivery.

8. **Group Privacy is off on the deployment bot.** The bot sees every message
   in a claimed chat. That matches the distributed Slack app, which subscribes
   to all channel messages, and Discord's target once its message-content
   intent is approved. Telegram reads the setting **when the bot joins a
   chat**, so it has to be off before the bot is ever distributed. Changing it
   later fixes no existing chat. The visibility notice on main
   (`_chat_visibility` / `announce_visibility`, `telegram/adapter.py:708-805`)
   stays as the safety net.

   The cost is that the bot also receives every message in chats nobody has
   claimed. **Nothing from an unclaimed chat is stored or dispatched, and no
   message content is logged.** The only thing read from such an update is the
   claim check in decision 4. A test sends a content-bearing update from an
   unowned chat and asserts that no receipt, room, message or `ExternalUser`
   row appears, and that the content is absent from the logs.

9. **An unclaimed add gets one notice and then the bot stays, inert.** If the
   bot is added without a valid token (no link, an expired one, one already
   used), the `TelegramAppClient` posts one message. The message says the chat
   isn't connected and how to connect it: the Add link from Switch Console, or
   `/connect <code>`. After that the bot ignores the chat. It does not leave on
   its own.

   The notice fires on the `my_chat_member` add. With a link, that add arrives
   *before* the `/start <token>` that claims the chat, and Telegram may deliver
   the two concurrently. So the notice waits a short grace period and is
   skipped if the chat has been claimed by then. It is held in process memory,
   which switch-core's forced singleton allows
   (`deploy/remote/helm/switch/templates/switch-core/deployment.yaml:1-2`).

10. **Who may claim is split between admins and members.**
    - **A tenant admin turns Telegram on** by connecting the tenant's first
      chat, which creates the bridge. There is no separate Enable step. A
      bridge is admin-level on main (`gateway/collaborations.py:173,211,262`
      use `require_tenant_admin`).
    - **After that, any tenant member may connect more chats.** A chat is a
      room, and rooms are member-level on main (`gateway/rooms.py:335` uses
      `get_current_user`).
    - **Any member may disconnect one chat.** **Removing the whole Telegram
      connection is admin-only.**

    Role is checked when the link is minted, and again when it is redeemed,
    against whether an active bridge exists *then*: a member's link minted
    while Telegram was on is refused if an admin has since removed it.

    Separately, and for every platform, the existing messaging-install routes
    move from `require_admin` (the deployment operator; its own docstring says
    not to use it for a tenant's resources) to `require_tenant_admin`
    (`gateway/auth.py:495`). That is its own small PR, not part of this work.

11. **Registration is the feature flag.** The distributed Telegram app exists
    when `TELEGRAM_APP_BOT_TOKEN` and `TELEGRAM_APP_WEBHOOK_SECRET` are both
    set, together with `MESSAGING_PUBLIC_URL`. Setting some but not all is a
    startup error, mirroring `_validate_slack_app` (`config.py:759`). The
    secret is checked against Telegram's own rule: 1–256 characters of
    `[A-Za-z0-9_-]`. `MESSAGING_PUBLIC_URL` must be on a port Telegram delivers
    to: 443, 80, 88 or 8443. Its https requirement (`config.py:710`) already
    holds.

## Architecture

```
Telegram ──POST /messaging/telegram/events──▶ install_routes._inbound
             X-Telegram-Bot-Api-Secret-Token
    │ authenticate   secret header, constant time            ✗ → 401
    │ revocation?    my_chat_member left/kicked  → end that chat's install
    │ claim?         /start <token> | /connect <token>
    │                  → verify, burn, record (+ register on first) → provision room
    │ resolve        chat id → tenant_of_messaging_install → scoped re-read
    │                  unowned → 200 (nothing stored; maybe the add notice)
    │                  bridge down → 503 (Telegram retries)
    │ migration?     re-key the install row inline
    ▼
200, then in the background: receipt(update_id) → dispatch under no_tenant()
    ▼
tenant's TelegramAdapter (event_delivery = "shared") → BridgeCore → room
    │ outbound
    ▼
TelegramAppClient: one telegram.Bot, one 429 cooldown, getMe, setWebhook,
                   setMyCommands, unclaimed notice, leaveChat
```

### A claim, end to end

1. A user opens **Add to a Telegram group** in Switch Console. The gateway calls
   `begin()`. That checks role (decision 10), writes an install-state row and
   returns `https://t.me/<bot>?startgroup=<token>`. It returns a link to show,
   not a redirect.
2. In Telegram they pick a group. Telegram adds the bot and sends two updates:
   `my_chat_member` (added) and `/start@<bot> <token>`.
3. The `my_chat_member` update is for an unowned chat. It is dropped with a 200,
   and the unclaimed notice is scheduled (decision 9).
4. The route sees a claim in the `/start` update and calls `service.claim()`,
   which does the following:
   - verifies the token;
   - burns the state;
   - re-checks role;
   - records the install for that chat id;
   - attaches it to the tenant's bridge, registering the bridge first if this
     is the tenant's first chat.
5. The route then resolves the same update normally and dispatches it. Under
   shared delivery, `_handle_start` treats a claim payload as the join. It calls
   `_on_app_joined`, which provisions the room, then `announce_visibility`, as
   `_handle_my_chat_member` does today (`telegram/adapter.py:2369`). Step 3
   dropped the real join event, so this is what creates the room.
6. The scheduled notice checks, finds the chat claimed, and posts nothing.

Telegram may deliver the two updates in either order. If the `my_chat_member`
update is handled after the claim, it resolves too, and it also asks for the
room. Main already makes that harmless. `_handle_app_joined_channel` holds a
lock per channel and returns early when the channel already has a room
(`bridge_core.py:1002-1011`). Whichever update gets there first creates the
room, and the other does nothing.

A channel is the same from step 4, triggered by `/connect <token>` as a
`channel_post`. Main drops channel posts before `_handle_start` because they
have no sender. The shared-delivery adapter must recognise a claim before that
drop.

A claim that fails should send one reply into the chat saying why, with no
detail about any tenant. The possible reasons are: expired, already used, chat
already connected to another Switch account, or not permitted. **Not built
yet:** today a refused claim is logged as a warning and the event is then routed
as normal, so the person who tapped the link sees nothing. It needs an installer
hook on a refused claim, the same shape as `on_unowned_event`.

### Ending a chat

- **The bot is removed in Telegram** → `revocation_of_event` → `revoked()` ends
  that chat's install.
- **A member disconnects the chat in Switch Console** → `disconnect()` ends the
  install and makes the bot `leaveChat`. The `left` update that follows finds
  nothing active, which is `revoked()`'s ordinary already-ended case
  (`install_service.py:342`).
- Either way, **the chat's room is detached**
  (`room_service.py:1152` `unlink_bridge_from_room`) and becomes internal-only,
  unless it was the tenant's **last** active Telegram install. In that case the
  bridge is removed, as today.
- **An admin removes the whole connection** → every install is ended, the bot
  leaves every chat, and the bridge is removed.

## Security

**Authenticity** rests on one shared secret header. That is weaker than Slack's
signed bodies and weaker than Discord's authenticated outbound socket. It is
compared in constant time, lives in deployment secrets, and must be rotatable.
Rotation is re-running `setWebhook` with a new secret at boot. Receipts on
`update_id` make a replayed body a duplicate rather than a second message.

**Credential blast radius** is the same as Discord's, and it is the design's
dominant residual risk. One bot token controls the bot in every tenant's chat.
It is kept in deployment secrets, never in the database or a connection config,
and must be rotatable (BotFather `/revoke`, then redeploy). Decision 7 stops a
tenant from pasting it into a self-hosted bridge.

**Isolation** rests on the guards the Discord work names, each with a test that
fails without it:

- **G1 — Per-event scoping.** The tenant is resolved fresh for every update.
  Dispatch runs under `no_tenant()` and each handler binds its room's tenant, as
  the Slack `deliver` path does. No tenant is cached on the shared client.
- **G2 — Tenant-scoped identity.** `ExternalUser` rows are per bridge, and
  bridges are per tenant (decision 2). So one Telegram user in two tenants'
  groups yields two independent records.
- **G3 — No default tenant.** An update from an unowned chat is dropped (and
  noticed, decision 9), never routed to a first or default tenant.
- **G4 — No DM routing.** A private chat is the lobby. It is never claimed and
  never routed to a tenant.

**A claim token is a bearer credential for ten minutes.** Whoever redeems it
attaches *their* chat to the minting tenant. The damage is bounded: a new room
has no agents until someone in the tenant invites one, and the chat's title is
shown in Switch Console's per-chat list. But the tenant only notices an
unexpected chat by looking at that list. The token names the tenant and not the
chat, as the v1 state does, so keeping it confidential within its short life
matters. Posting `/connect <token>` in a public channel spends it at once.

**Unclaimed chats** are covered by decision 8: nothing is stored or dispatched,
and no content is logged.

## Telling ignored events from lost messages

Main has one drop path for an event that resolves to nobody: a warning per
event (`install_routes.py:271`). On Slack that path is rare and meaningful. Here,
with privacy off and the bot staying in unclaimed chats, it would fire on every
message in every unclaimed chat. Those are events nobody asked Switch to hear,
and they would bury the drops that are real losses. Rate-limiting the warning
only makes that quieter. Instead, each case is recorded where its cause is
known:

| Case | Lost? | How it is surfaced |
| --- | --- | --- |
| A chat nobody claimed | No | The counter `switch.messaging.events_ignored`, `reason=unowned`, with no chat id label. No log per event. The installer's `expects_unowned_events` is what switches the route from warning to counting, so Slack keeps its per-event warning. |
| A claimed chat whose bridge is not running | Yes, once Telegram stops retrying | An error and a 503, as on main. The `TelegramAppClient` also reads `getWebhookInfo` every five minutes and warns on a new delivery error, or when the backlog grows past 50. That is the only view of what Telegram has given up on. |
| A disconnected chat the bot is still in | A leak rather than a loss | Detected at disconnect, not from the drops that would follow: `leaveChat` runs before the install ends, and a failure fails the disconnect with a 502 and leaves the chat connected, so disconnecting again retries it. |
| A migrated chat's messages before the install row is re-keyed | Yes | The service keeps a short in-memory list of recently dropped chat ids: ids and counts only, never content, a few minutes long. When a migration re-keys an install to a new id, it checks the list. A hit is an error naming the chat and how many messages were lost. |

So every real loss produces an error that says which case it is, and the
expected case produces only a count. None of it needs storage, and nothing from
an unclaimed chat outlives the process.

## Changes to shared code

All of these are in the platform-generic install layer. None is under `slack/`.
Slack's existing tests (`test_install_service.py`, `test_install_webhook.py`,
`test_bridge_delete_guard.py`) pass with no assertion changed. The only edit
is one constructor argument, because the service now takes a `UserStore` for
the admin check in `claim()`. Each change is neutral for Slack for the reason
given.

1. **`disconnect` and `revoked` remove the bridge only on its last active
   install.** Otherwise they detach that chat's room. Today they call
   `lifecycle.remove(bridge_id)` unconditionally (`install_service.py:332,396`).
   *Slack-neutral:* a Slack bridge has exactly one install, which is always the
   last.
2. **`get_for_bridge` becomes `list_for_bridge` and returns a list.** Today it
   is `one_or_none` (`messaging_install_store.py:184`). Its one caller, the
   delete guard
   (`gateway/collaborations.py:700`), refuses when the list is non-empty.
   *Slack-neutral:* a one-element list refuses exactly as the one row did.
3. **`complete()` and the new `claim()` share their first steps.** Burning the
   state and encrypting a grant's token move into private helpers that both
   call. After that they differ: `claim()` has no redeem, and it looks up the
   tenant's bridge, records the install, registers the bridge if there is none,
   and attaches, all in **one transaction** under the advisory lock below. A
   failed registration therefore rolls the install back instead of leaving it
   behind. *Slack-neutral:* `complete()` makes the same calls, in the same
   order, with the same sessions.
4. **`begin()` mints the token format the installer names.** The default is v1.
   Telegram names the compact format. *Slack-neutral:* Slack keeps the default.
5. **The route checks `claim_of_event` before resolve.** The default is `None`.
   *Slack-neutral:* a `None` falls through to today's path.

Three new installer hooks complete the set. Each defaults to a no-op, so
Slack, which implements none of them, is unaffected:

6. **`migration_of_event`** (decision 6), default `None`.
7. **An installer hook to release a workspace on disconnect**, default no-op.
   Telegram implements it as `leaveChat`. `disconnect()` only calls
   `installer.revoke` when a token exists (`install_service.py:320`), so a
   tokenless install currently leaves the bot sitting in the chat. Discord has
   the same gap.
8. **An installer hook on an unowned-workspace drop**, default no-op. Telegram
   uses it to schedule the unclaimed notice (decision 9). The drop itself is
   recorded in the counter and the recently-dropped list described in
   [Telling ignored events from lost messages](#telling-ignored-events-from-lost-messages).
   For Slack, the per-event warning stays as it is.

The first bridge for a tenant has a race: two first claims landing together
could each register a bridge. `claim()`'s transaction takes an advisory lock on
`(tenant, platform)` before looking up the bridge, so the second claim waits and
then finds the bridge the first one made.

## What is reused, and what is new

**Reused unchanged:**
- `messaging_installs` and `messaging_install_states`, the unique index and
  row-level security;
- `tenant_of_messaging_install`, whose caller stays inside the allowlisted
  service;
- `redeem_state`, `record_install`, `attach_bridge` and `end`;
- the `/messaging/{platform}/events` route and its status-code policy;
- receipts dedupe and background delivery;
- migration handling in the adapter and `BridgeCore`;
- `announce_visibility`;
- the gateway's `REMOVAL_COPY` pattern.

**From the Discord work** (stacked on it, not duplicated):
- the nullable `encrypted_bot_token` and a tokenless `InstallGrant`;
- `SupportsSharedConnection` and `lifecycle.iter_adapters()`;
- `BridgeCore._provision_identities_on_attach`;
- the `event_delivery` discriminator pattern and its half-state validator.

**New:**
- the compact claim token;
- `TelegramAppInstaller`. `authorize_url` returns the `startgroup` link and
  `redeem` raises, because Telegram has no OAuth leg;
- `service.claim()`;
- the shared-code changes above;
- `TelegramAppClient`;
- shared-delivery mode in `TelegramAdapter`;
- the Telegram `exclusive_resource`;
- the `TELEGRAM_APP_*` config and its deploy wiring;
- a per-chat list, a link dialog and a member-level per-chat disconnect in the
  gateway.

## Implementation stages

The implementation stacks on the Discord PR, because it needs that PR's
tokenless install and shared-connection seams. Each stage is a reviewable
commit that can be tested on its own.

- **Stage 0 — the Discord seams.** Inherited, not rebuilt.
- **Stage 1 — this document.**
- **Stage 2 — the claim protocol.**
  - Work: the compact token with its own label; `begin()` choosing the format;
    `claim_of_event`; `service.claim()` with the shared helpers and the
    advisory lock; `list_for_bridge` and the delete guard following it.
  - Tests: token round trip, the 64-character and alphabet bound, a v1 token
    refused as compact and vice versa, expiry, single use; a claim against real
    Postgres; a second tenant claiming the same chat refused; two concurrent
    first claims producing one bridge.
- **Stage 3 — the installer, ingress and config.**
  - Work: `TelegramAppInstaller`'s webhook half and claim reading;
    `TELEGRAM_APP_*` validation; the first part of `TelegramAppClient`
    (`getMe`, then `setWebhook`, supervised in the background with retry, so an
    unreachable Telegram never blocks boot); the install route answering 503
    when an installer cannot read an event yet; Helm `telegramApp`, compose and
    `.env.example`.
  - Tests: secret refused and accepted, `update_id` deduped, the workspace and
    revocation extraction for each update type, claims read from the right
    messages only, config all-or-none, the port and secret-alphabet rules, and
    a claim before the bot has connected answered with a 503.
- **Stage 4 — shared delivery.**
  - Work: the rest of `TelegramAppClient` (the shared cooldown, the command
    menu published once for the deployment, handing the bot to running bridges
    once it connects); the `event_delivery` discriminator, with the
    registration form still requiring a token and username; the adapter's
    shared mode (no polling, no commands, the deployment-wide cooldown, claims
    as joins including a channel's `/connect`, no unsigned add link); an
    installer `shared_connection()` hook (default `None`) that the service
    attaches to a bridge before its first delivered event, so a bridge created
    by a claim at runtime has a bot; `switch.bridge.throttle.held`, a histogram
    of how long the cooldown held a publication back, by `platform` and
    `delivery`, with a dashboard panel. The cooldown refuses rather than
    sleeps, and the publisher retries, so what it measures is a hold-back and
    not a blocked call.
  - Discord's boot-time attach loop is narrowed to Discord's adapter. It
    matched on the shared-connection protocol alone, which Telegram's shared
    bridges now implement too.
  - Tests: a 429 for one tenant holds back another, no polling in shared mode,
    a hold-back recorded with its delivery mode, claims as joins in a group
    and a channel, a wrong connection type refused, attach on first delivery,
    and a 503 while the bot has not connected.
- **Stage 5 — lifecycle.**
  - Work: per-chat ending, removing the bridge only with its last install and
    otherwise detaching the chat's room (`RoomService.unlink_bridge_channel`),
    under the claim's advisory lock; the release hook and `leaveChat`; the
    install row following a migration inline before delivery; the
    recently-dropped list; `WebhookWorkspaceUnowned`, split from a scoped
    re-read missing; `switch.messaging.events_ignored`, with a dashboard panel;
    the unclaimed notice after a 10-second grace period and the DM reply, from
    `on_unowned_event`; the `getWebhookInfo` watch; `exclusive_resource` for a
    self-registered bot and the app bot reserved in the lifecycle
    (`reserve_resource`), refused at registration, start and edit.
  - `PATCH` now refuses an explicit `event_delivery` change and runs the
    resource-conflict check registration runs. That is generic gateway code,
    so it reaches Slack too: flipping a Slack bridge between Socket Mode and
    webhooks on the edit form is refused.
  - Tests: one chat ending versus the last; revocation; two chats leaving at
    once, made deterministic with two barriers; a failed `leaveChat` keeping
    the chat connected; migration, the duplicate notice and the lost-message
    count; unclaimed traffic counted, answered and never logged; the notice's
    grace; the delivery-health warnings; the reserved bot refused at
    registration and on edit.
- **Stage 6 — gateway and docs.**
  - Work: **Add to a Telegram group** as a link to show; the per-chat list; a
    member-level per-chat disconnect and an admin-only full removal;
    `REMOVAL_COPY['telegram']`; the operator page on registering the
    deployment bot (Group Privacy off first).
- **Stage 7 — the cross-tenant test** (below).

## Open questions

- **The unclaimed-notice grace period.** It has to cover the gap between the
  add and the `/start` under concurrent delivery. A few seconds is the guess;
  measure it.
- **Updates lost during a migration.** Messages from the new chat id that
  arrive before the re-key are dropped as unowned. Doing the re-key inline
  keeps the window small, but it isn't zero. The loss is reported as an error
  rather than prevented (see
  [Telling ignored events from lost messages](#telling-ignored-events-from-lost-messages)).
  `max_connections = 1` would close the window at the cost of serialising every
  tenant's delivery, which is not worth it.
- **An inert bot in an abandoned chat** keeps receiving every message, because
  privacy is off. Nothing is stored, but it is traffic. Auto-leave after a
  period was considered and not chosen. If it is revisited, it has a second
  benefit: with unclaimed traffic near zero, any event from an unowned chat
  would itself signal a fault. It would re-check ownership before leaving, so
  a chat that has just migrated is never abandoned.
- **Fair sending between tenants.** One tenant's burst can take the whole
  global send rate. Deferred until it is observed. `switch.bridge.throttle.held`
  with `delivery=shared` (stage 4) is how it will be seen. Adapters send
  through the shared bot directly today, so per-tenant queues would route
  their sends through `TelegramAppClient` first.
- **A shared bridge restarted at runtime has no bot until its next update.**
  Bridges running at boot are attached when the bot connects, and one created
  by a claim is attached before its first update. One restarted while the
  server runs (a config change, say) is not, so a reply sent before anyone
  writes in that chat fails. Discord's shared bridges have the same gap.
  Closing it needs the lifecycle to tell the app client when a bridge
  starts.

## Testing

The test the isolation story rests on runs against real PostgreSQL under the
restricted role:

- Two tenants, each claiming a chat, drive webhooks through the real route.
- Each update reaches exactly one tenant's room, and no part of it appears in
  the other tenant's rooms, receipts or `ExternalUser` rows.
- The same Telegram user posting in both chats yields two scoped identities
  (G2).
- An unowned chat's update leaves no row and no logged content (decision 8).
- A DM reaches no tenant (G4).
- A wrong lookup answer becomes a scoped miss.

Beyond that, each stage carries the tests listed with it. A doc-vs-code test,
like `test_slack_distributed_app.py`, compares the `allowed_updates` and
command set named here against what the client sends at boot.

## Left out on purpose

- **One-tap account linking by DM** (`/start <code>` in a private chat, linking
  the sender to the Switch user who minted the code). Deferred. Main's
  seen-user linking works, and under decision 2 each person links once per
  tenant, not once per chat.
- **Bridging DMs.** A DM has no tenant (G4).
- **Fair per-tenant rate limiting** (above).
- **Auto-leaving unclaimed chats** (decision 9).

## What is missing

- **No deployment bot is registered.** Nothing here is reachable until one is,
  with Group Privacy turned off *before* it joins any chat.
- **The webhook path must be publicly reachable** at `MESSAGING_PUBLIC_URL`, on
  a port Telegram delivers to. The ingress allowlist is deployment-specific and
  outside this repository.
- **The permission fix for the existing install routes** (decision 10) is a
  separate PR.

Three gaps on main this design inherits and has to close rather than copy:

- **An install can be left without a bridge.** `complete()` commits the install
  row before `lifecycle.register` runs (`install_service.py:206`), and nothing
  undoes the row if registration fails. For Telegram this is worse than for
  Slack. The chat stays claimed by the tenant, so another claim is refused by
  the unique index, and every update resolves to `WebhookBridgeUnavailable`, a
  503 that Telegram retries. `claim()` does not inherit it: it registers inside
  the transaction that records the install (change 3), so a failed
  registration leaves no row. Reporting the failure in the chat is not built
  yet (see "A claim, end to end"). `complete()` keeps the gap for Slack.
- **Bridge `PATCH` had no install guard.** It merged any `connection_config`
  and only re-validated the shape, so an admin could switch a shared bridge to
  `own_connection` with a token, including the deployment bot's. Closed in
  stage 5: an explicit `event_delivery` change is refused, and the
  resource-conflict check, including the reserved app bot, runs on edit.
- **`_handle_start`'s docstring was stale about DMs.** Corrected after stage 5.
