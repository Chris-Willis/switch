import { describe, expect, it } from 'vitest';
import type { CloudAgent, CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import { cloudAgentState, cloudHoldBlocker } from './cloud-agent-state';

function machine(overrides: Partial<CloudMachine>): CloudMachine {
  return {
    machine_id: '3f1c2b4a-0000-4000-8000-000000000001',
    state: 'ready',
    desired_state: 'running',
    stop_reason: null,
    sleeping: false,
    revision: 4,
    instance_type: null,
    error: null,
    error_code: null,
    retain_until: null,
    heartbeat_at: null,
    disk: null,
    memory: null,
    agents: [],
    ...overrides,
  };
}

function agent(
  launch: Partial<CloudAgent['launch']>,
  onMachine: CloudMachine | null = machine({})
): CloudAgent {
  return {
    key: 'cloud:server:launch',
    launch: {
      request_id: '00000000-0000-4000-8000-000000000001',
      name: 'reviewer',
      provider: 'claude',
      state: 'ready',
      desired_state: 'running',
      revision: 3,
      agent_id: 'agent',
      error: null,
      error_code: null,
      sleeping: false,
      machine_id: onMachine?.machine_id ?? null,
      process_state: 'running',
      process_restarts: 0,
      oom_kills: 0,
      ...launch,
    },
    machine: onMachine,
    controller: null,
    sessions: null,
    problem: null,
  };
}

describe('a cloud agent on a machine in error', () => {
  it('reads as a machine error, not as ready', () => {
    expect(cloudAgentState(agent({}, machine({ state: 'error' })))).toEqual({
      label: 'machine error',
      tone: 'bad',
    });
  });
});

describe('a cloud agent on its way up', () => {
  it('reads as starting when only the agent starts on a ready machine', () => {
    expect(cloudAgentState(agent({ state: 'provisioning', process_state: 'starting' }))).toEqual({
      label: 'starting…',
      tone: 'busy',
    });
  });

  it('reads as waking while its machine starts', () => {
    expect(cloudAgentState(agent({}, machine({ state: 'provisioning' })))).toEqual({
      label: 'waking…',
      tone: 'busy',
    });
  });
});

describe('why a held message will not be delivered', () => {
  it.each([
    [
      'a sleeping machine',
      agent(
        {},
        machine({ desired_state: 'stopped', stop_reason: 'idle', sleeping: true, state: 'stopped' })
      ),
    ],
    ['a machine on its way up', agent({}, machine({ state: 'provisioning' }))],
    ['a ready machine', agent({})],
  ])('is nothing on %s', (_name, onAgent) => {
    expect(cloudHoldBlocker(onAgent)).toBeNull();
  });

  it.each([
    [
      'the owner stopped the machine',
      agent({}, machine({ desired_state: 'stopped', stop_reason: 'owner', state: 'stopped' })),
      'The owner stopped the cloud machine.',
    ],
    [
      'the machine is in error',
      agent({}, machine({ state: 'error' })),
      'The cloud machine is in error.',
    ],
    [
      'the machine needs attention',
      agent({}, machine({ state: 'error', error_code: 'machine_needs_attention' })),
      'Contact your server administrator.',
    ],
    [
      'the agent was stopped elsewhere',
      agent({ desired_state: 'stopped', state: 'stopping' }, machine({ state: 'provisioning' })),
      'This agent is stopped.',
    ],
    [
      'the agent crashed',
      agent({ state: 'error', error_code: 'agent_crashed', process_state: 'crashed' }),
      'This agent crashed.',
    ],
    [
      'the agent could not start',
      agent({ state: 'error', error_code: 'identity_failed' }),
      'This agent could not start.',
    ],
    [
      'the agent timed out connecting',
      agent({ state: 'error', error_code: 'worker_attach_timeout' }),
      'This agent could not start.',
    ],
    [
      'the agent lost its credential',
      agent({ state: 'error', error_code: 'agent_key_missing' }),
      'Remove it in Your Agents and create it again.',
    ],
    [
      'the agent is being removed',
      agent({ desired_state: 'deleted' }),
      'This agent is being removed.',
    ],
  ])('says so when %s', (_name, onAgent, text) => {
    expect(cloudHoldBlocker(onAgent)).toContain(text);
  });
});

describe('a cloud agent its machine’s controller runs', () => {
  const controller: NonNullable<CloudAgent['controller']> = {
    controllerId: 'cloud-controller',
    desiredState: 'running',
    process: 'running',
    detail: null,
  };
  function controllerRun(
    launch: Partial<CloudAgent['launch']>,
    overrides: Partial<NonNullable<CloudAgent['controller']>> = {},
    onMachine: CloudMachine = machine({})
  ): CloudAgent {
    return { ...agent(launch, onMachine), controller: { ...controller, ...overrides } };
  }

  it.each([
    ['queued', { state: 'queued' }],
    ['provisioning', { state: 'provisioning', process_state: 'starting' as const }],
    [
      'in error',
      { state: 'error', error_code: 'agent_crashed', process_state: 'crashed' as const },
    ],
    ['stopped', { state: 'stopped', desired_state: 'stopped' as const }],
  ])('reads as ready with its launch left %s', (_name, launch) => {
    expect(cloudAgentState(controllerRun(launch))).toBeNull();
    expect(cloudHoldBlocker(controllerRun(launch))).toBeNull();
  });

  it('reads as waking while its machine starts', () => {
    expect(
      cloudAgentState(controllerRun({ state: 'queued' }, {}, machine({ state: 'provisioning' })))
    ).toEqual({ label: 'waking…', tone: 'busy' });
  });

  it('reads its managed agent stopped or crashed', () => {
    expect(cloudAgentState(controllerRun({}, { desiredState: 'stopped' }))).toEqual({
      label: 'stopped',
      tone: 'idle',
    });
    expect(cloudHoldBlocker(controllerRun({}, { desiredState: 'stopped' }))).toContain(
      'This agent is stopped.'
    );
    expect(cloudAgentState(controllerRun({}, { process: 'crashed' }))).toEqual({
      label: 'crashed',
      tone: 'bad',
    });
    expect(cloudHoldBlocker(controllerRun({}, { process: 'failed' }))).toContain(
      'This agent crashed.'
    );
  });
});
