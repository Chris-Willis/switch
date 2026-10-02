import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControllerApiError } from './api';
import { silentLogger } from './log';
import {
  CREDENTIAL_REFETCH_INTERVAL_MS,
  planReconcile,
  reconcile,
  type ReconcileDeps,
} from './reconcile';
import { emptyObservation } from './runtime';
import type { AgentAssignment, AgentCredentials, Assignment } from './schemas';
import { ControllerStore } from './store';
import { FakeRuntime } from './testing/fake-runtime';

const SERVER = 'https://switch.example.com';

function agent(overrides: Partial<AgentAssignment> = {}, definition = {}): AgentAssignment {
  return {
    agent_id: 'agent-1',
    revision: 1,
    desired_state: 'running',
    ...overrides,
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
      ...definition,
    },
  };
}

function assignment(...agents: AgentAssignment[]): Assignment {
  return { revision: agents.reduce((sum, entry) => sum + entry.revision, 0), agents };
}

let dir: string;
let store: ControllerStore;
let runtime: FakeRuntime;
let fetched: string[];
let credentialError: Error | null;
let clock: number;
let missingProvider: boolean;

function deps(): ReconcileDeps {
  return {
    store,
    runtime,
    fetchCredentials: async (agentId): Promise<AgentCredentials> => {
      if (credentialError) throw credentialError;
      fetched.push(agentId);
      return { agent_id: agentId, api_key: `key-${fetched.length}` };
    },
    server: SERVER,
    binaryPath: async (provider) => (missingProvider ? null : `/usr/bin/${provider}`),
    now: () => clock,
    log: silentLogger,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-reconcile-'));
  store = ControllerStore.open(join(dir, 'controller.db'));
  runtime = new FakeRuntime();
  fetched = [];
  credentialError = null;
  clock = Date.parse('2026-01-01T00:00:00Z');
  missingProvider = false;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reconcile', () => {
  it('starts a running agent: fetches its key, writes it, launches its watcher', async () => {
    await reconcile(assignment(agent()), deps());
    expect(fetched).toEqual(['agent-1']);
    expect(runtime.credentials.get('agent-1')).toEqual({ endpoint: SERVER, apiKey: 'key-1' });
    const [launch] = runtime.launches();
    expect(launch!.options).toEqual({
      spawn: true,
      restart: false,
      replaceIdentity: false,
      clearTakenOver: true,
    });
    expect(launch!.template.start.input.cwd).toBe('/data/workspaces/scout');
    expect(launch!.template.execution!.credentialsPath).toBe(
      '/data/agents/agent-1/credentials.json'
    );
    expect(launch!.template.execution!.binaryPath).toBe('/usr/bin/claude');
    expect(store.agent('agent-1')).toMatchObject({ appliedRevision: 1, failure: null });
    expect(store.restartsSince('agent-1', 0)).toBe(0);
  });

  it('does nothing more once the revision is applied and running', async () => {
    await reconcile(assignment(agent()), deps());
    runtime.calls.length = 0;
    const actions = await reconcile(assignment(agent()), deps());
    expect(actions).toEqual([]);
    expect(runtime.calls).toEqual([]);
  });

  it('restarts on a revision bump, keeping the key it already has', async () => {
    await reconcile(assignment(agent()), deps());
    await reconcile(
      assignment(agent({ revision: 2 }, { model: 'opus', auto_session: false })),
      deps()
    );
    const launches = runtime.launches();
    expect(launches).toHaveLength(2);
    expect(launches[1]!.options).toMatchObject({
      restart: true,
      spawn: false,
      replaceIdentity: false,
    });
    expect(launches[1]!.template.start.input.model).toEqual({ id: 'opus' });
    expect(fetched).toEqual(['agent-1']);
    expect(store.agent('agent-1')?.appliedRevision).toBe(2);
    expect(store.restartsSince('agent-1', 0)).toBe(1);
  });

  it('replaces the saved identity when the provider or directory changes', async () => {
    await reconcile(assignment(agent()), deps());
    await reconcile(assignment(agent({ revision: 2 }, { provider: 'codex' })), deps());
    await reconcile(
      assignment(agent({ revision: 3 }, { provider: 'codex', directory: '/srv/repo' })),
      deps()
    );
    const launches = runtime.launches();
    expect(launches[1]!.options).toMatchObject({ restart: true, replaceIdentity: true });
    expect(launches[2]!.options).toMatchObject({ restart: true, replaceIdentity: true });
    expect(launches[2]!.template.start.input.cwd).toBe('/srv/repo');
  });

  it('stops an agent whose desired state is stopped, and records the revision', async () => {
    await reconcile(assignment(agent()), deps());
    await reconcile(assignment(agent({ revision: 2, desired_state: 'stopped' })), deps());
    expect(runtime.calls.at(-1)).toEqual({ kind: 'stop', agentId: 'agent-1', wait: false });
    expect(store.agent('agent-1')?.appliedRevision).toBe(2);
    runtime.calls.length = 0;
    await reconcile(assignment(agent({ revision: 2, desired_state: 'stopped' })), deps());
    expect(runtime.calls).toEqual([]);
  });

  it('records a stopped agent that never ran without touching its watcher', async () => {
    await reconcile(assignment(agent({ desired_state: 'stopped' })), deps());
    expect(runtime.calls).toEqual([]);
    expect(store.agent('agent-1')?.appliedRevision).toBe(1);
  });

  it('stops a removed agent, deletes its key and forgets it', async () => {
    await reconcile(assignment(agent()), deps());
    await reconcile({ revision: 9, agents: [] }, deps());
    expect(runtime.calls.slice(-2)).toEqual([
      { kind: 'stop', agentId: 'agent-1', wait: false },
      { kind: 'deleteCredentials', agentId: 'agent-1' },
    ]);
    expect(runtime.credentials.has('agent-1')).toBe(false);
    expect(store.agent('agent-1')).toBeNull();
  });

  it('starts again a watcher that is gone without a failure, as after a reboot', async () => {
    await reconcile(assignment(agent()), deps());
    runtime.kill('agent-1', null);
    await reconcile(assignment(agent()), deps());
    expect(runtime.launches()).toHaveLength(2);
    expect(runtime.launches()[1]!.options).toMatchObject({ restart: false, clearTakenOver: false });
    expect(store.restartsSince('agent-1', 0)).toBe(1);
  });

  it('leaves a failed watcher down until something asks for it', async () => {
    await reconcile(assignment(agent()), deps());
    runtime.kill('agent-1', 'Shared SDK host exited with code 1.');
    await reconcile(assignment(agent()), deps());
    expect(runtime.launches()).toHaveLength(1);
  });

  it('leaves a watcher that was taken over standing down', async () => {
    await reconcile(assignment(agent()), deps());
    runtime.kill('agent-1', null);
    runtime.observation('agent-1').takenOver = {
      at: '2026-01-01T00:00:00Z',
      reason: 'another client',
      connectionId: 'c',
    };
    await reconcile(assignment(agent()), deps());
    expect(runtime.launches()).toHaveLength(1);
  });

  it('replaces a refused key and relaunches, but not twice in ten minutes', async () => {
    await reconcile(assignment(agent()), deps());
    const refused =
      'Shared SDK watcher was evicted: Switch rejected the agent credentials (HTTP 401)';
    runtime.kill('agent-1', refused);
    await reconcile(assignment(agent()), deps());
    expect(fetched).toEqual(['agent-1', 'agent-1']);
    expect(runtime.launches()).toHaveLength(2);
    runtime.kill('agent-1', refused);
    clock += CREDENTIAL_REFETCH_INTERVAL_MS - 1;
    await reconcile(assignment(agent()), deps());
    expect(runtime.launches()).toHaveLength(2);
    clock += 1;
    await reconcile(assignment(agent()), deps());
    expect(runtime.launches()).toHaveLength(3);
  });

  it('refuses to apply a revision older than the one applied', async () => {
    await reconcile(assignment(agent({ revision: 5 })), deps());
    const actions = await reconcile(assignment(agent({ revision: 4 })), deps());
    expect(actions).toEqual([expect.objectContaining({ kind: 'hold' })]);
    expect(runtime.launches()).toHaveLength(1);
  });

  it('records an unknown provider as an invalid definition, once', async () => {
    await reconcile(assignment(agent({}, { provider: 'gemini' })), deps());
    expect(store.agent('agent-1')?.failure).toMatchObject({
      reason: 'definition_invalid',
      revision: 1,
    });
    expect(runtime.calls).toEqual([]);
    expect(await reconcile(assignment(agent({}, { provider: 'gemini' })), deps())).toEqual([]);
  });

  it('records an agent id that cannot be a directory name as invalid', async () => {
    await reconcile(assignment(agent({ agent_id: '../escape' })), deps());
    expect(store.agent('../escape')?.failure?.reason).toBe('definition_invalid');
    await reconcile({ revision: 2, agents: [] }, deps());
    expect(store.agent('../escape')).toBeNull();
    expect(runtime.calls).toEqual([]);
  });

  it('records a missing provider CLI, and retries on the next pass', async () => {
    missingProvider = true;
    await reconcile(assignment(agent()), deps());
    expect(store.agent('agent-1')?.failure?.reason).toBe('provider_not_installed');
    missingProvider = false;
    await reconcile(assignment(agent()), deps());
    expect(store.agent('agent-1')).toMatchObject({ appliedRevision: 1, failure: null });
  });

  it('records a key Management will not issue as not_assigned', async () => {
    credentialError = new ControllerApiError(403, 'not_assigned', 'not yours', false, null);
    await reconcile(assignment(agent()), deps());
    expect(store.agent('agent-1')?.failure).toMatchObject({ reason: 'not_assigned' });
    expect(runtime.launches()).toEqual([]);
  });

  it('records a launch that fails as internal, and carries on with the next agent', async () => {
    runtime.failNextLaunch = new Error('launcher exploded');
    await reconcile(assignment(agent(), agent({ agent_id: 'agent-2' }, { name: 'other' })), deps());
    expect(store.agent('agent-1')?.failure).toMatchObject({
      reason: 'internal',
      detail: 'launcher exploded',
    });
    expect(store.agent('agent-2')?.appliedRevision).toBe(1);
  });

  it('propagates a revoked controller instead of recording it on the agent', async () => {
    credentialError = new ControllerApiError(401, 'controller_revoked', 'revoked', false, null);
    await expect(reconcile(assignment(agent()), deps())).rejects.toMatchObject({
      code: 'controller_revoked',
    });
  });
});

describe('planReconcile', () => {
  it('holds an agent whose desired state it does not know', () => {
    const actions = planReconcile({
      assignment: assignment(agent({ desired_state: 'unknown' })),
      rows: [],
      observations: new Map([['agent-1', emptyObservation()]]),
      credentialsPresent: new Set(),
      nowMs: 0,
    });
    expect(actions).toEqual([expect.objectContaining({ kind: 'hold', agentId: 'agent-1' })]);
  });

  it('restarts a running watcher that is being turned off', () => {
    const actions = planReconcile({
      assignment: assignment(agent()),
      rows: [
        {
          agentId: 'agent-1',
          appliedRevision: 1,
          changedAt: '2026-01-01T00:00:00Z',
          failure: null,
          credentialsStale: false,
          credentialsRefetchedAt: null,
        },
      ],
      observations: new Map([
        [
          'agent-1',
          { ...emptyObservation(), alive: true, flags: { enabled: false, spawn: false } },
        ],
      ]),
      credentialsPresent: new Set(['agent-1']),
      nowMs: 0,
    });
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'start', restart: true, fetchCredentials: false }),
    ]);
  });
});
