import { beforeEach, describe, expect, it } from 'vitest';
import type { TargetLookup } from './agent-migration-service';
import {
  type AddManagedAgentParams,
  type ManagedCreateOutcome,
  type NewManagedAgentDeps,
  NewManagedAgentService,
} from './new-managed-agent-service';

const PARAMS: AddManagedAgentParams = {
  sshHost: null,
  dir: '/work/pm',
  name: 'pm-agent',
  providerId: 'claude',
  serverId: 'server-1',
  description: 'Writes PRDs',
  displayName: 'PM',
  iconUrl: null,
  autoApprove: true,
  instructions: 'Be brief.',
  model: 'opus',
  entryPoint: 'sidebar',
};

const READY: TargetLookup = {
  display: { kind: 'this-computer', serverId: 'server-1', machineName: 'laptop' },
  target: {
    display: { kind: 'this-computer', serverId: 'server-1', machineName: 'laptop' },
    controllerId: 'controller-1',
    workspaceId: 'workspace-1',
    watcherRoot: (id) => `/data/watchers/${id}`,
  },
  blocker: null,
  canEnable: false,
  controller: { controllerId: 'controller-1', state: 'running' },
};

type Config = {
  lookup: TargetLookup;
  management: boolean;
  createOutcome: ManagedCreateOutcome;
};

type Harness = {
  deps: NewManagedAgentDeps;
  created: unknown[];
  set(patch: Partial<Config>): void;
};

function harness(): Harness {
  const config: Config = {
    lookup: READY,
    management: true,
    createOutcome: { kind: 'created', switchAgentId: 'switch-9' },
  };
  const created: unknown[] = [];
  return {
    created,
    set: (patch) => Object.assign(config, patch),
    deps: {
      workspaceFor: async () => 'workspace-1',
      machine: async () => config.lookup,
      managementAvailable: async () => config.management,
      create: async (_workspaceId, body) => {
        created.push(body);
        return config.createOutcome;
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    },
  };
}

describe('NewManagedAgentService.add', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('creates the agent on the server, running on the machine’s controller, and keeps nothing locally', async () => {
    const result = await new NewManagedAgentService(h.deps).add(PARAMS);

    expect(result).toEqual({
      kind: 'created',
      serverId: 'server-1',
      workspaceId: 'workspace-1',
      switchAgentId: 'switch-9',
    });
    expect(h.created).toEqual([
      {
        name: 'pm-agent',
        description: 'Writes PRDs',
        display_name: 'PM',
        icon_url: null,
        controller_id: 'controller-1',
        desired_state: 'running',
        definition: {
          provider: 'claude',
          model: 'opus',
          instructions: 'Be brief.',
          auto_approve: true,
          directory: '/work/pm',
        },
      },
    ]);
  });

  it('creates nothing when the machine cannot take the agent', async () => {
    h.set({
      lookup: {
        ...READY,
        target: null,
        blocker: 'This computer’s controller is not running (stopped).',
      },
    });
    const result = await new NewManagedAgentService(h.deps).add(PARAMS);
    expect(result).toEqual({
      kind: 'machine-unavailable',
      message: 'This computer’s controller is not running (stopped).',
    });
    expect(h.created).toEqual([]);
  });

  it('creates nothing on a machine enrolled for another workspace', async () => {
    h.set({ lookup: { ...READY, target: { ...READY.target!, workspaceId: 'workspace-2' } } });
    const result = await new NewManagedAgentService(h.deps).add(PARAMS);
    expect(result.kind).toBe('machine-unavailable');
    expect(h.created).toEqual([]);
  });

  it('says a name Switch already has is taken', async () => {
    h.set({ createOutcome: { kind: 'name-conflict' } });
    expect(await new NewManagedAgentService(h.deps).add(PARAMS)).toEqual({
      kind: 'name-conflict',
    });
  });

  it('shows a refusal in Switch’s words', async () => {
    h.set({
      createOutcome: { kind: 'refused', message: 'Claude Code is not logged in on laptop.' },
    });
    expect(await new NewManagedAgentService(h.deps).add(PARAMS)).toEqual({
      kind: 'error',
      message: 'Claude Code is not logged in on laptop.',
    });
  });

  it('refuses instructions longer than a managed agent takes, before creating anything', async () => {
    const result = await new NewManagedAgentService(h.deps).add({
      ...PARAMS,
      instructions: 'x'.repeat(33 * 1024),
    });
    expect(result.kind).toBe('error');
    expect(h.created).toEqual([]);
  });
});

describe('NewManagedAgentService.machineFor', () => {
  const ref = { serverId: 'server-1', workspaceId: 'workspace-1', sshHost: null };

  it('says Console runs the agent when the server has no agent management', async () => {
    const h = harness();
    h.set({ management: false });
    expect(await new NewManagedAgentService(h.deps).machineFor(ref)).toEqual({
      management: false,
    });
  });

  it('reports the machine and whether Console can turn it on', async () => {
    const h = harness();
    h.set({ lookup: { ...READY, target: null, blocker: 'Turn it on first.', canEnable: true } });
    expect(await new NewManagedAgentService(h.deps).machineFor(ref)).toEqual({
      management: true,
      target: READY.display,
      blocker: 'Turn it on first.',
      canEnable: true,
    });
  });

  it('refuses a machine enrolled for another workspace', async () => {
    const h = harness();
    h.set({ lookup: { ...READY, target: { ...READY.target!, workspaceId: 'workspace-2' } } });
    const machine = await new NewManagedAgentService(h.deps).machineFor(ref);
    expect(machine.management && machine.blocker).toMatch(/another workspace/);
  });
});
