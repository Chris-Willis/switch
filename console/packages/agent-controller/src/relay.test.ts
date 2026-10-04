import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { SwitchEventStreamDeps } from '@sandboxaq/switch-agent-runtime';
import {
  callOperation,
  type CallerContext,
  fetchMediaToFile,
  SESSION_SELECTOR_HEADERS,
} from '@sandboxaq/switch-agent-runtime/hosted';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHub } from './agent-hub';
import { AccessTokens } from './api';
import { silentLogger } from './log';
import { LocalRelay } from './relay';
import { UpstreamForwarder } from './relay-forward';
import type { AgentAssignment } from './schemas';
import { FakeCore } from './testing/fake-core';

const AGENT = 'agent-1';

function assigned(agentId: string): AgentAssignment {
  return {
    agent_id: agentId,
    revision: 1,
    desired_state: 'running',
    definition: {
      name: agentId,
      display_name: null,
      icon_url: null,
      provider: 'claude',
      model: null,
      instructions: '',
      auto_approve: false,
      directory: null,
    },
  };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(10);
  }
}

let core: FakeCore;
let hub: AgentHub;
let relay: LocalRelay;
let token: string;
let revokedCalls: number;
const stops: (() => void)[] = [];

beforeEach(async () => {
  core = new FakeCore();
  await core.start();
  core.setAssignment({ revision: 1, agents: [assigned(AGENT), assigned('agent-2')] });
  const tokens = new AccessTokens({
    fetch,
    server: core.url,
    controllerId: core.controllerId,
    credential: async () => core.credential,
    now: Date.now,
    log: silentLogger,
  });
  revokedCalls = 0;
  hub = new AgentHub({
    log: silentLogger,
    onCursor: () => {},
    onChange: () => {},
    bufferLimit: 100,
  });
  relay = new LocalRelay({
    log: silentLogger,
    roomFor: (agentId, sessionId) => hub.roomFor(agentId, sessionId),
    forwarder: new UpstreamForwarder({
      server: core.url,
      auth: {
        token: () => tokens.get(),
        invalidate: (stale) => tokens.invalidate(stale),
        revoked: () => revokedCalls++,
      },
      log: silentLogger,
    }),
  });
  await relay.start(null);
  token = relay.mint(AGENT);
  hub.streamAttached();
  hub.attach(AGENT, 0, ['room-a', 'room-b']);
  relay.setReady();
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await relay.close();
  await core.stop();
});

/** The agent's watcher, as the controller hosts it: its stream comes from the hub. */
function watch() {
  const controller = new AbortController();
  const deps: SwitchEventStreamDeps = {
    creds: { agentId: AGENT, apiEndpoint: relay.endpoint, token },
    connectionId: 'watcher-connection',
    worker: null,
    scope: 'all',
    filter: 'addressed',
    spawnCapable: true,
    rooms: [],
    onEvent: () => {},
    onGap: () => {},
    onEvicted: () => {},
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    signal: controller.signal,
  };
  const stream = hub.open(AGENT, deps);
  stream.start();
  stops.push(() => controller.abort());
  return stream;
}

function caller(sessionId: string | null = 'session-1'): CallerContext {
  return {
    identity: { endpoint: relay.endpoint, agentId: AGENT, token },
    connectionId: 'watcher-connection',
    selector: sessionId
      ? {
          [SESSION_SELECTOR_HEADERS.sessionId]: sessionId,
          [SESSION_SELECTOR_HEADERS.hostId]: 'host-1',
          [SESSION_SELECTOR_HEADERS.epoch]: 'epoch-1',
        }
      : {},
    room: null,
    mediaDir: '/nonexistent',
    cwd: '/',
    deadConnection: (operation) => `dead: ${operation}`,
  };
}

async function post(path: string, body: unknown, bearer = token): Promise<Response> {
  return fetch(`${relay.endpoint}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('the room a call is made in', () => {
  it('names the calling session’s room, or the agent’s only room, from its watcher’s placements', async () => {
    const stream = watch();
    await stream.replacePlacements({ 'session-1': 'room-a' });

    const placed = await callOperation(caller(), 'post_message', { body: 'hi' });
    expect(placed.isError).toBeFalsy();
    expect(placed.structuredContent).toMatchObject({ room_id: 'room-a' });
    const forwarded = core.requests.findLast((r) => r.path.endsWith('/ops/post_message'))!;
    expect(forwarded.headers['x-switch-room-id']).toBe('room-a');
    expect(forwarded.headers['x-switch-agent-id']).toBe(AGENT);
    expect(forwarded.headers['x-switch-session-id']).toBe('session-1');
    expect(forwarded.headers['x-switch-connection-id']).toBeUndefined();
    expect(forwarded.headers.authorization).toMatch(/^Bearer access-token-/);

    const unplaced = await callOperation(caller('session-9'), 'post_message', {});
    expect(unplaced.structuredContent).toMatchObject({ room_id: null });
    const bySoleRoom = await callOperation(caller(null), 'post_message', {});
    expect(bySoleRoom.structuredContent).toMatchObject({ room_id: 'room-a' });
  });

  it('serves no event stream and no connection bookkeeping: the controller holds the connection', async () => {
    for (const path of [
      `/agents/${AGENT}/connection/beat`,
      `/agents/${AGENT}/connection/placements`,
      `/agents/${AGENT}/connection/subscribe`,
    ]) {
      const response = await post(path, { connection_id: 'watcher-connection' });
      expect(response.status, path).toBe(404);
    }
    const events = await fetch(`${relay.endpoint}/agents/${AGENT}/events`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    });
    expect(events.status).toBe(404);
    expect(core.requests.filter((r) => r.path.includes('/connection'))).toEqual([]);
  });
});

describe('what the relay refuses', () => {
  it('binds to loopback only', () => {
    expect(relay.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('refuses a token it did not mint with 401, and asks to retry while starting', async () => {
    const refused = await post(`/agents/${AGENT}/ops/post_message`, {}, 'swlr_not-a-token');
    expect(refused.status).toBe(401);
    const starting = new LocalRelay({
      log: silentLogger,
      forwarder: { forward: async () => {} },
      roomFor: () => null,
    });
    await starting.start(null);
    try {
      const early = await fetch(`${starting.endpoint}/agents/${AGENT}/ops`, {
        headers: { Authorization: 'Bearer swlr_unknown' },
      });
      expect(early.status).toBe(503);
    } finally {
      await starting.close();
    }
  });

  it('refuses another agent’s routes, and never relays the management routes', async () => {
    const other = await fetch(`${relay.endpoint}/agents/agent-2/ops`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(other.status).toBe(403);
    for (const path of [
      `/v1/management/controllers/${core.controllerId}/credential/rotate`,
      `/v1/controllers/${core.controllerId}/connection`,
      `/agents/${AGENT}/../../v1/management/controllers/${core.controllerId}/assignment`,
      `/agents/${AGENT}%2F..%2F..%2Fv1/x`,
    ]) {
      const response = await post(path, {});
      expect([403, 404], path).toContain(response.status);
    }
    expect(core.requests.filter((r) => r.path.startsWith('/v1/'))).toEqual([]);
  });

  it('stops accepting an agent’s token once it is unregistered', async () => {
    relay.unregister(AGENT);
    const response = await fetch(`${relay.endpoint}/agents/${AGENT}/ops`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });
});

describe('forwarding to Switch', () => {
  it('swaps the credential, names the agent, and passes the answer back', async () => {
    const response = await fetch(`${relay.endpoint}/agent-sessions/session-1/activity`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Switch-Agent-Id': 'agent-2',
        'X-Switch-Room-Id': 'room-spoofed',
      },
      body: JSON.stringify({ row: 1 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: '/agent-sessions/session-1/activity' });
    const forwarded = core.requests.at(-1)!;
    expect(forwarded.headers.authorization).toMatch(/^Bearer access-token-/);
    expect(forwarded.headers['x-switch-agent-id']).toBe(AGENT);
    expect(forwarded.headers['x-switch-room-id']).toBeUndefined();
    expect(forwarded.headers['switch-controller-protocol']).toBe('1');
    expect(forwarded.body).toEqual({ row: 1 });
  });

  it('passes an upstream refusal through as it came', async () => {
    core.scripted.push({
      method: 'POST',
      path: `/agents/${AGENT}/ops/connect_to_room`,
      status: 409,
      body: { detail: 'connection watcher-connection is not open' },
    });
    const response = await post(`/agents/${AGENT}/ops/connect_to_room`, { room_id: 'room-a' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: 'connection watcher-connection is not open' });
  });

  it('exchanges a token Switch refused as stale and sends the request once more', async () => {
    await post(`/agents/${AGENT}/ops/post_message`, {});
    core.expireTokens();
    const response = await post(`/agents/${AGENT}/ops/post_message`, { body: 'again' });
    expect(response.status).toBe(200);
    expect(core.tokensIssued).toBe(2);
  });

  it('reports a revoked controller, and answers 502 when Switch is unreachable', async () => {
    core.revoked = true;
    const revoked = await post(`/agents/${AGENT}/ops/post_message`, {});
    expect(revoked.status).toBe(401);
    expect(revokedCalls).toBe(1);
    await core.stop();
    const unreachable = await post(`/agents/${AGENT}/ops/post_message`, {});
    expect(unreachable.status).toBe(502);
  });

  it('streams an upload through without holding it', async () => {
    const chunk = Buffer.alloc(64 * 1024, 7);
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(`${relay.endpoint}/agents/${AGENT}/rooms/room-a/media`);
      const upload = request(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      });
      upload.on('response', (response) => {
        let body = '';
        response.on('data', (data: Buffer) => (body += data.toString()));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      upload.on('error', reject);
      upload.write(chunk);
      // The rest is sent only once Switch has the first part: a relay that
      // read the whole body before forwarding would wait here forever.
      void waitFor(() => core.uploadReceived >= chunk.length, 'the first part upstream')
        .then(() => {
          upload.write(chunk);
          upload.end();
        })
        .catch(reject);
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ received: chunk.length * 2 });
  });

  it('streams a download through, and the runtime writes it to a file', async () => {
    let release: () => void = () => {};
    core.waitBetweenChunks = new Promise<void>((resolve) => (release = resolve));
    core.mediaChunks = [Buffer.from('first-part-'), Buffer.from('second-part')];
    const response = await fetch(`${relay.endpoint}/agents/${AGENT}/rooms/room-a/media?mxc=x`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    // The first part arrived while Switch still holds back the second.
    expect(Buffer.from(first.value!).toString()).toBe('first-part-');
    release();
    let rest = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += Buffer.from(next.value).toString();
    }
    expect(rest).toBe('second-part');

    core.waitBetweenChunks = null;
    const dir = mkdtempSync(join(tmpdir(), 'relay-media-'));
    try {
      const written = await fetchMediaToFile(
        { endpoint: relay.endpoint, agentId: AGENT, token },
        dir,
        'room-a',
        'mxc://example.org/abc',
        'file.bin'
      );
      expect(readFileSync(written, 'utf8')).toBe('first-part-second-part');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
