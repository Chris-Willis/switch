import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ControllerDeps, type ControllerExit, runController } from './controller';
import { silentLogger } from './log';
import type { AgentAssignment, Assignment, StatusReport } from './schemas';
import { CONTROLLER_CREDENTIAL, FileSecretStore } from './secrets';
import { ControllerStore } from './store';
import { FakeCore } from './testing/fake-core';
import { FakeLocator, FakeRuntime } from './testing/fake-runtime';

function agent(revision: number, overrides: Partial<AgentAssignment> = {}): AgentAssignment {
  return {
    agent_id: 'agent-1',
    revision,
    desired_state: 'running',
    definition: {
      name: 'scout',
      display_name: null,
      icon_url: null,
      provider: 'claude',
      model: null,
      instructions: '',
      auto_session: true,
      auto_approve: false,
      directory: null,
    },
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(10);
  }
}

let dir: string;
let core: FakeCore;
let store: ControllerStore;
let secrets: FileSecretStore;
let runtime: FakeRuntime;
let stop: AbortController;
let running: Promise<ControllerExit> | null;

function deps(server = core.url): ControllerDeps {
  store.saveIdentity({
    controllerId: core.controllerId,
    server,
    name: 'test-box',
    enrolledAt: '2026-01-01T00:00:00Z',
  });
  return {
    store,
    secrets,
    runtime,
    locator: new FakeLocator(),
    fetch,
    log: silentLogger,
    dataDir: dir,
    version: '0.1.0',
    now: Date.now,
    random: () => 0,
    timing: {
      resyncMs: 60_000,
      statusPollMs: 20,
      statusMinGapMs: 10,
      defaultReportWithinS: 60,
      streamIdleMs: 2_000,
      streamInitialBackoffMs: 10,
      streamMaxBackoffMs: 50,
    },
  };
}

function reportsFor(agentId: string): StatusReport['agents'] {
  return core.statusReports.flatMap((report) =>
    report.agents.filter((entry) => entry.agent_id === agentId)
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'controller-loop-'));
  core = new FakeCore();
  await core.start();
  store = ControllerStore.open(join(dir, 'controller.db'));
  secrets = new FileSecretStore(join(dir, 'secrets'));
  await secrets.set(CONTROLLER_CREDENTIAL, core.credential);
  runtime = new FakeRuntime();
  stop = new AbortController();
  running = null;
});

afterEach(async () => {
  stop.abort();
  await running?.catch(() => {});
  await core.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runController', () => {
  it('pulls the assignment, starts the agent, reports it, follows changes, and exits when revoked', async () => {
    const first: Assignment = { revision: 1, agents: [agent(1)] };
    core.setAssignment(first);
    running = runController(deps(), stop.signal);

    await waitFor(
      () => reportsFor('agent-1').some((entry) => entry.process === 'running'),
      'a status report with the agent running'
    );
    expect(runtime.launches('agent-1')).toHaveLength(1);
    expect(core.credentialFetches).toEqual(['agent-1']);
    expect(runtime.credentials.get('agent-1')?.endpoint).toBe(core.url);
    const report = core.statusReports.at(-1)!;
    expect(report.controller.assignment_revision).toBe(1);
    expect(report.providers.map((provider) => provider.provider)).toEqual(
      expect.arrayContaining(['claude', 'codex'])
    );
    expect(new Set(core.statusReports.map((r) => r.seq)).size).toBe(core.statusReports.length);
    expect(store.cachedAssignment()?.etag).toBe('"1"');

    core.setAssignment({ revision: 2, agents: [agent(2, {})] });
    core.assignment.agents[0]!.definition.model = 'opus';
    core.push('assignment.changed', { revision: 2 });
    await waitFor(() => runtime.launches('agent-1').length === 2, 'a restart on the new revision');
    expect(runtime.launches('agent-1')[1]!.options.restart).toBe(true);
    expect(runtime.launches('agent-1')[1]!.template.start.input.model).toEqual({ id: 'opus' });
    await waitFor(
      () => reportsFor('agent-1').some((entry) => entry.applied_revision === 2),
      'a status report with revision 2 applied'
    );
    const assignmentPulls = core.requests.filter((r) => r.path.endsWith('/assignment'));
    expect(assignmentPulls.map((r) => r.headers['if-none-match'])).toEqual(
      expect.arrayContaining([undefined, '"1"'])
    );

    core.revoke();
    expect(await running).toBe('revoked');
    expect(runtime.calls).toEqual(
      expect.arrayContaining([
        { kind: 'stop', agentId: 'agent-1', wait: false },
        { kind: 'deleteCredentials', agentId: 'agent-1' },
      ])
    );
    expect(await secrets.get(CONTROLLER_CREDENTIAL)).toBeNull();
    expect(store.revokedAt()).not.toBeNull();
  });

  it('runs pending operations when nudged', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the first start');
    const probesBefore = runtime.probes;
    core.addOperation({
      id: 'op-restart',
      kind: 'agent.restart',
      agent_id: 'agent-1',
      params: {},
      created_at: '2026-01-01T00:00:00Z',
    });
    core.addOperation({
      id: 'op-recheck',
      kind: 'provider.recheck',
      agent_id: null,
      params: { provider: 'claude' },
      created_at: '2026-01-01T00:00:00Z',
    });
    core.addOperation({
      id: 'op-login',
      kind: 'provider.login',
      agent_id: null,
      params: { provider: 'claude', method: 'device_code' },
      created_at: '2026-01-01T00:00:00Z',
    });
    core.push('operation.pending', {
      operation_id: 'op-restart',
      kind: 'agent.restart',
      agent_id: 'agent-1',
    });
    await waitFor(() => core.results.size === 3, 'three operation results');
    expect(core.results.get('op-restart')).toEqual({ outcome: 'succeeded' });
    expect(core.results.get('op-recheck')).toMatchObject({ outcome: 'succeeded' });
    expect(core.results.get('op-login')).toMatchObject({
      outcome: 'failed',
      error: { code: 'operation_unsupported' },
    });
    expect(runtime.launches('agent-1')).toHaveLength(2);
    expect(runtime.launches('agent-1')[1]!.options).toMatchObject({
      restart: true,
      clearTakenOver: true,
    });
    expect(runtime.probes).toBeGreaterThan(probesBefore);
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('replaces a refused agent key as soon as the watcher reports it, without a nudge', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(
      () => reportsFor('agent-1').some((entry) => entry.process === 'running'),
      'the agent running'
    );
    runtime.kill(
      'agent-1',
      'Shared SDK watcher was evicted: Switch rejected the agent credentials (HTTP 401)'
    );
    await waitFor(() => runtime.launches('agent-1').length === 2, 'a relaunch with a new key');
    expect(core.credentialFetches).toEqual(['agent-1', 'agent-1']);
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('resyncs after the stream drops and reconnects', async () => {
    core.setAssignment({ revision: 1, agents: [agent(1)] });
    running = runController(deps(), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the first start');
    core.setAssignment({ revision: 2, agents: [agent(2)] });
    core.closeStreams();
    await waitFor(() => runtime.launches('agent-1').length === 2, 'a resync on reconnect');
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('reconciles the cached assignment while the server is unreachable', async () => {
    store.saveAssignment({ revision: 1, agents: [agent(1)] }, '"1"', '2026-01-01T00:00:00Z');
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:00Z');
    await runtime.writeCredentials('agent-1', {
      endpoint: 'https://switch.example.com',
      apiKey: 'k',
    });
    runtime.calls.length = 0;
    await core.stop();
    running = runController(deps('http://127.0.0.1:1'), stop.signal);
    await waitFor(() => runtime.launches('agent-1').length === 1, 'the agent restored from cache');
    expect(runtime.launches('agent-1')[0]!.options.restart).toBe(false);
    stop.abort();
    expect(await running).toBe('stopped');
  });

  it('exits as revoked when the credential exchange is refused as revoked', async () => {
    core.revoked = true;
    running = runController(deps(), stop.signal);
    expect(await running).toBe('revoked');
    expect(await secrets.get(CONTROLLER_CREDENTIAL)).toBeNull();
  });

  it('refuses to run without an identity or a credential', async () => {
    const empty = ControllerStore.open(join(dir, 'empty.db'));
    try {
      await expect(runController({ ...deps(), store: empty }, stop.signal)).rejects.toThrow(
        /not enrolled/
      );
    } finally {
      empty.close();
    }
    const enrolled = deps();
    await secrets.delete(CONTROLLER_CREDENTIAL);
    store.markRevoked('2026-01-02T00:00:00Z');
    await expect(runController(enrolled, stop.signal)).rejects.toThrow(/revoked at/);
  });
});
