import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Sqlite from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControllerStore, STORE_SCHEMA_VERSION } from './store';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-store-'));
  path = join(dir, 'controller.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const assignment = {
  revision: 3,
  agents: [
    {
      agent_id: 'agent-1',
      revision: 2,
      desired_state: 'running' as const,
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
    },
  ],
};

describe('ControllerStore', () => {
  it('migrates a new file to the current schema version', () => {
    const store = ControllerStore.open(path);
    expect(store.schemaVersion()).toBe(STORE_SCHEMA_VERSION);
    store.close();
  });

  it('refuses a file written by a newer controller', () => {
    const store = ControllerStore.open(path);
    store.close();
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof Sqlite;
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => ControllerStore.open(path)).toThrow(/newer than this controller understands/);
  });

  it('keeps the identity across reopening, and clears a revocation on re-enrollment', () => {
    const store = ControllerStore.open(path);
    expect(store.identity()).toBeNull();
    const identity = {
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'build-box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    };
    store.saveIdentity(identity);
    store.markRevoked('2026-01-02T00:00:00.000Z');
    store.close();
    const reopened = ControllerStore.open(path);
    expect(reopened.identity()).toEqual(identity);
    expect(reopened.revokedAt()).toBe('2026-01-02T00:00:00.000Z');
    reopened.saveIdentity({ ...identity, controllerId: 'controller-2' });
    expect(reopened.revokedAt()).toBeNull();
    reopened.close();
  });

  it('caches the assignment with its ETag', () => {
    const store = ControllerStore.open(path);
    expect(store.cachedAssignment()).toBeNull();
    store.saveAssignment(assignment, '"3"', '2026-01-01T00:00:00.000Z');
    expect(store.cachedAssignment()).toEqual({ assignment, etag: '"3"' });
    store.saveAssignment({ revision: 4, agents: [] }, null, '2026-01-01T00:00:01.000Z');
    expect(store.cachedAssignment()).toEqual({
      assignment: { revision: 4, agents: [] },
      etag: null,
    });
    store.close();
  });

  it('records applied revisions and local failures per agent', () => {
    const store = ControllerStore.open(path);
    store.recordFailure(
      'agent-1',
      { revision: 1, reason: 'provider_not_installed', detail: 'no claude' },
      '2026-01-01T00:00:00.000Z'
    );
    expect(store.agent('agent-1')).toMatchObject({
      appliedRevision: null,
      failure: { revision: 1, reason: 'provider_not_installed', detail: 'no claude' },
    });
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:01.000Z');
    expect(store.agent('agent-1')).toMatchObject({ appliedRevision: 1, failure: null });
    store.recordFailure(
      'agent-1',
      { revision: 2, reason: 'internal', detail: 'boom' },
      '2026-01-01T00:00:02.000Z'
    );
    expect(store.agent('agent-1')).toMatchObject({ appliedRevision: 1, failure: { revision: 2 } });
    expect(store.agents().map((row) => row.agentId)).toEqual(['agent-1']);
    store.deleteAgent('agent-1');
    expect(store.agent('agent-1')).toBeNull();
    store.close();
  });

  it('tracks a refused key until a new one is fetched', () => {
    const store = ControllerStore.open(path);
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:00.000Z');
    store.markCredentialsStale('agent-1', '2026-01-01T00:00:01.000Z');
    expect(store.agent('agent-1')).toMatchObject({
      credentialsStale: true,
      credentialsRefetchedAt: null,
    });
    store.recordCredentialsFetched('agent-1', '2026-01-01T00:00:02.000Z', true);
    expect(store.agent('agent-1')).toMatchObject({
      credentialsStale: false,
      credentialsRefetchedAt: '2026-01-01T00:00:02.000Z',
    });
    store.recordCredentialsFetched('agent-1', '2026-01-01T00:00:03.000Z', false);
    expect(store.agent('agent-1')?.credentialsRefetchedAt).toBe('2026-01-01T00:00:02.000Z');
    store.close();
  });

  it('counts restarts in a window', () => {
    const store = ControllerStore.open(path);
    const now = 10_000_000;
    store.recordRestart('agent-1', now - 11 * 60 * 1000);
    store.recordRestart('agent-1', now - 5 * 60 * 1000);
    store.recordRestart('agent-1', now);
    store.recordRestart('agent-2', now);
    expect(store.restartsSince('agent-1', now - 10 * 60 * 1000)).toBe(2);
    store.deleteAgent('agent-1');
    expect(store.restartsSince('agent-1', 0)).toBe(0);
    store.close();
  });

  it('hands out a status seq that only grows, and never falls below the clock', () => {
    const store = ControllerStore.open(path);
    const first = store.nextStatusSeq(1_000);
    const second = store.nextStatusSeq(1_000);
    const third = store.nextStatusSeq(500);
    expect(first).toBe(1_000);
    expect(second).toBe(1_001);
    expect(third).toBe(1_002);
    store.close();
    const reopened = ControllerStore.open(path);
    expect(reopened.nextStatusSeq(0)).toBe(1_003);
    expect(reopened.nextStatusSeq(5_000)).toBe(5_000);
    reopened.close();
  });
});
