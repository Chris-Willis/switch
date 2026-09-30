import { expect, it } from 'vitest';
import {
  cloudAgentPhase,
  type CloudLaunch,
  cloudLaunchSchema,
  type CloudMachine,
  cloudMachineSchema,
} from './cloud-agents';

const idleSleeping = JSON.parse(
  '{"machine_id":"3f1c2b4a-0000-4000-8000-000000000001","state":"stopped","desired_state":"stopped","stop_reason":"idle","sleeping":true,"revision":5,"instance_type":"c7i.2xlarge","error":null,"error_code":null,"retain_until":null,"heartbeat_at":"2026-01-01T00:00:00Z","disk":{"total_bytes":214748364800,"available_bytes":204010946560},"memory":{"total_bytes":17179869184,"available_bytes":12884901888},"agents":["req-0000000000000001"]}'
) as unknown;

const launch: CloudLaunch = cloudLaunchSchema.parse({
  request_id: '00000000-0000-4000-8000-000000000001',
  name: 'reviewer',
  provider: 'claude',
  state: 'ready',
  desired_state: 'running',
  revision: 3,
  agent_id: '3f1c2b4a-0000-4000-8000-0000000000a1',
  error: null,
  error_code: null,
  sleeping: false,
  machine_id: '3f1c2b4a-0000-4000-8000-000000000001',
  process_state: 'running',
  process_restarts: 0,
  oom_kills: 0,
});

function machine(overrides: Partial<CloudMachine>): CloudMachine {
  return {
    ...cloudMachineSchema.parse(idleSleeping),
    state: 'ready',
    desired_state: 'running',
    stop_reason: null,
    sleeping: false,
    ...overrides,
  };
}

it('parses the idle-sleeping machine summary', () => {
  expect(cloudMachineSchema.parse(idleSleeping)).toEqual(idleSleeping);
});

it('parses a launch summary with its machine and process', () => {
  expect(launch).toMatchObject({
    machine_id: '3f1c2b4a-0000-4000-8000-000000000001',
    process_state: 'running',
    process_restarts: 0,
    oom_kills: 0,
  });
  expect(
    cloudLaunchSchema.parse({ ...launch, machine_id: null, process_state: null })
  ).toMatchObject({ machine_id: null, process_state: null });
});

it('refuses a machine in a state it does not know', () => {
  expect(() =>
    cloudMachineSchema.parse({ ...(idleSleeping as object), state: 'hibernating' })
  ).toThrow();
});

it.each([
  ['an idle-sleeping machine', cloudMachineSchema.parse(idleSleeping), 'sleeping'],
  [
    'a machine its owner stopped',
    machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' }),
    'machine_stopped',
  ],
  ['a machine on its way up', machine({ state: 'provisioning' }), 'waking'],
  ['a ready machine', machine({}), null],
] as const)('reads %s', (_name, onMachine, phase) => {
  expect(cloudAgentPhase(launch, onMachine)).toBe(phase);
});

it('reads a launch without a machine from the launch', () => {
  expect(
    cloudAgentPhase({ ...launch, machine_id: null, sleeping: true, state: 'stopped' }, null)
  ).toBe('sleeping');
});
