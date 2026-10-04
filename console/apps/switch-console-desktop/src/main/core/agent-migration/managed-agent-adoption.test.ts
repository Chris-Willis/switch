import { describe, expect, it } from 'vitest';
import type { Agent } from '@shared/core/agents/agents';
import { isValidProviderId } from '@shared/core/providers/agent-provider-registry';
import {
  ManagedAgentAdoption,
  type ManagedAgentAdoptionDeps,
  type OwnMachine,
  type ServerManagedAgent,
} from './managed-agent-adoption';
import type { ManagedAgentRecord } from './managed-agents-store';

const THIS_COMPUTER: OwnMachine = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
  controllerId: 'controller-here',
  placement: { kind: 'this-computer', serverId: 'server-1' },
  sshHost: null,
  workspaceRoot: (name) => `/data/workspaces/${name}`,
  hostRoot: (id) => `/data/watchers/${id}`,
};

const BOX: OwnMachine = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
  controllerId: 'controller-box',
  placement: { kind: 'ssh-host', sshHost: 'box', serverId: 'server-1' },
  sshHost: 'box',
  workspaceRoot: null,
  hostRoot: (id) => `~/.local/state/watchers/${id}`,
};

function managed(overrides: Partial<ServerManagedAgent>): ServerManagedAgent {
  return {
    agentId: 'switch-1',
    name: 'yoda',
    controllerId: 'controller-here',
    provider: 'claude',
    directory: null,
    autoApprove: false,
    ...overrides,
  };
}

function harness(listed: ServerManagedAgent[], known: string[] = []) {
  const records = new Map<string, ManagedAgentRecord>();
  const rows: Parameters<ManagedAgentAdoptionDeps['createRow']>[0][] = [];
  const announced: string[] = [];
  let next = 0;
  const deps: ManagedAgentAdoptionDeps = {
    machines: async () => [THIS_COMPUTER, BOX],
    managed: async () => listed,
    knownSwitchAgentIds: async () => new Set(known),
    isProvider: isValidProviderId,
    store: {
      set: async (record) => void records.set(record.agentId, record),
      delete: async (agentId) => void records.delete(agentId),
    },
    createRow: async (input) => {
      expect(records.has(input.id)).toBe(true);
      rows.push(input);
      return { id: input.id, name: input.name } as Agent;
    },
    announce: async (agent) => void announced.push(agent.name),
    newId: () => `agent-${++next}`,
    now: () => Date.parse('2026-10-04T12:00:00Z'),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { adoption: new ManagedAgentAdoption(deps), records, rows, announced };
}

describe('ManagedAgentAdoption', () => {
  it('gives a row to a managed agent created elsewhere that runs on this computer, recorded as managed first', async () => {
    const { adoption, records, rows, announced } = harness([managed({})]);
    expect(await adoption.sync()).toBe(1);
    expect(rows).toEqual([
      {
        id: 'agent-1',
        serverId: 'server-1',
        workspaceId: 'workspace-1',
        sshHost: null,
        dir: '/data/workspaces/yoda',
        name: 'yoda',
        providerId: 'claude',
        switchAgentId: 'switch-1',
        autoApprove: false,
      },
    ]);
    expect(records.get('agent-1')).toMatchObject({
      controllerId: 'controller-here',
      placement: { kind: 'this-computer', serverId: 'server-1' },
      identities: [{ switchAgentId: 'switch-1', controllerRoot: '/data/watchers/switch-1' }],
    });
    expect(announced).toEqual(['yoda']);
  });

  it('uses the folder the definition names, on the SSH host it runs on', async () => {
    const { adoption, rows } = harness([
      managed({ controllerId: 'controller-box', directory: '/srv/yoda' }),
    ]);
    await adoption.sync();
    expect(rows[0]).toMatchObject({ sshHost: 'box', dir: '/srv/yoda' });
  });

  it('leaves out agents it already has, agents on other machines, and ones it cannot name a folder for', async () => {
    const { adoption, rows } = harness(
      [
        managed({ agentId: 'switch-known' }),
        managed({ agentId: 'switch-far', controllerId: 'controller-elsewhere' }),
        managed({ agentId: 'switch-unplaced', controllerId: null }),
        managed({ agentId: 'switch-box', controllerId: 'controller-box', directory: null }),
        managed({ agentId: 'switch-odd', provider: 'unknown' }),
      ],
      ['switch-known']
    );
    expect(await adoption.sync()).toBe(0);
    expect(rows).toEqual([]);
  });

  it('adds nothing twice when it is asked again', async () => {
    const { adoption, rows } = harness([managed({})]);
    await Promise.all([adoption.sync(), adoption.sync()]);
    expect(rows).toHaveLength(1);
  });
});
