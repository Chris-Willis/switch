import { beforeEach, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
  operations: new Map<string, { id: string; session_id: string; action: string }>(),
  sessions: new Set<string>(),
  restarts: 0,
  loseNextResponse: false,
  refuseNext: null as { status: number; detail: string } | null,
  launches: [] as { request_id: string }[],
  machines: [] as { machine_id: string; revision: number }[],
  machineActions: [] as unknown[],
  relayClients: 0,
}));

const { FakeGatewayError } = vi.hoisted(() => ({
  FakeGatewayError: class extends Error {
    constructor(
      readonly kind: 'unauthorized' | 'http' | 'network',
      message: string,
      readonly status?: number,
      readonly detail?: string
    ) {
      super(message);
    }
  },
}));

vi.mock('@switch-console/agent-providers', () => ({
  CloudRelayClient: class {
    constructor() {
      server.relayClients += 1;
    }
  },
  CloudRelayError: class extends Error {},
  RELAY_TIMEOUT_MS: 1000,
}));

vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: async () => ({ id: 'server' }),
}));

vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError: FakeGatewayError,
  gatewayRequest: vi.fn(),
  gatewayFetch: vi.fn(
    async (_server: unknown, path: string, init: { method?: string; body?: unknown }) => {
      if (path === '/hosted-launches') return { json: async () => server.launches };
      if (path === '/hosted-machines') return { json: async () => ({ machines: server.machines }) };
      const [, kind, id, rest] = path.split('/');
      if (kind === 'hosted-launches' && rest === undefined)
        return { json: async () => server.launches.find((each) => each.request_id === id) };
      if (kind === 'hosted-machines') {
        const machine = server.machines.find((each) => each.machine_id === id)!;
        if (rest === undefined) return { json: async () => machine };
        server.machineActions.push(init.body);
        const started = {
          ...machine,
          desired_state: 'running',
          stop_reason: null,
          sleeping: false,
          revision: machine.revision + 1,
        };
        return { json: async () => ({ machine: started }) };
      }
      if (server.refuseNext) {
        const { status, detail } = server.refuseNext;
        server.refuseNext = null;
        throw new FakeGatewayError('http', `Switch gateway returned ${status}`, status, detail);
      }
      const body = init.body as { id: string; session_id: string; action: string };
      let operation = server.operations.get(body.id);
      if (!operation) {
        operation = body;
        server.operations.set(body.id, operation);
        if (body.action === 'start') server.sessions.add(body.session_id);
        else server.restarts += 1;
      }
      if (server.loseNextResponse) {
        server.loseNextResponse = false;
        throw new FakeGatewayError('network', 'Could not reach the gateway: socket hang up');
      }
      return { json: async () => ({ ...operation, state: 'applied', error: null }) };
    }
  ),
}));

const { listCloudAgents, runCloudSessionOperation, wakeCloudAgent } =
  await import('./cloud-control');

const agent = 'cloud:server:00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-0000000000aa';
const restartId = '00000000-0000-4000-8000-0000000000bb';

beforeEach(() => {
  server.operations.clear();
  server.sessions.clear();
  server.restarts = 0;
  server.loseNextResponse = false;
  server.refuseNext = null;
  server.launches = [];
  server.machines = [];
  server.machineActions = [];
  server.relayClients = 0;
});

const machineId = '3f1c2b4a-0000-4000-8000-000000000001';

function launch(requestId: string, overrides: Record<string, unknown>) {
  return {
    request_id: requestId,
    name: 'reviewer',
    provider: 'claude',
    state: 'ready',
    desired_state: 'running',
    revision: 1,
    agent_id: 'agent',
    error: null,
    error_code: null,
    sleeping: false,
    machine_id: null,
    process_state: null,
    process_restarts: 0,
    oom_kills: 0,
    ...overrides,
  };
}

function machine(overrides: Record<string, unknown>) {
  return {
    machine_id: machineId,
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

it('lists cloud agents from the launch list without asking any worker', async () => {
  server.launches = [
    launch('00000000-0000-4000-8000-000000000001', {}),
    launch('00000000-0000-4000-8000-000000000002', { sleeping: true, state: 'stopped' }),
  ];
  const agents = await listCloudAgents('server');
  expect(server.relayClients).toBe(0);
  expect(agents?.map((each) => [each.sessions, each.problem?.code ?? null])).toEqual([
    [null, null],
    [null, 'worker_sleeping'],
  ]);
});

it('attaches each launch’s machine and reads it first', async () => {
  server.machines = [machine({})];
  server.launches = [launch('00000000-0000-4000-8000-000000000001', { machine_id: machineId })];
  const [listed] = (await listCloudAgents('server'))!;
  expect(listed?.machine?.machine_id).toBe(machineId);
  expect(listed?.problem).toBeNull();
});

it.each([
  [
    'worker_sleeping',
    machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'idle', sleeping: true }),
    {},
    true,
  ],
  [
    'machine_stopped',
    machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' }),
    {},
    false,
  ],
  ['worker_waking', machine({ state: 'provisioning' }), {}, false],
  ['agent_stopped', machine({}), { desired_state: 'stopped', state: 'stopped' }, false],
  [
    'agent_crashed',
    machine({}),
    { state: 'error', error_code: 'agent_crashed', error: 'The agent crashed 5 times.' },
    false,
  ],
])('reports %s', async (code, onMachine, overrides, wakeAvailable) => {
  server.machines = [onMachine];
  server.launches = [
    launch('00000000-0000-4000-8000-000000000001', { machine_id: machineId, ...overrides }),
  ];
  const [listed] = (await listCloudAgents('server'))!;
  expect(listed?.problem).toMatchObject({ code, wakeAvailable });
});

it('wakes an agent by starting its machine at the machine’s revision', async () => {
  server.machines = [
    machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'idle', sleeping: true }),
  ];
  server.launches = [launch('00000000-0000-4000-8000-000000000001', { machine_id: machineId })];
  const woken = await wakeCloudAgent(agent);
  expect(server.machineActions).toEqual([{ action: 'start', revision: 4 }]);
  expect(woken).toMatchObject({ desired_state: 'running', revision: 5 });
});

it('does not start a machine already asked to run', async () => {
  server.machines = [machine({ state: 'provisioning' })];
  server.launches = [launch('00000000-0000-4000-8000-000000000001', { machine_id: machineId })];
  expect(await wakeCloudAgent(agent)).toMatchObject({ state: 'provisioning', revision: 4 });
  expect(server.machineActions).toEqual([]);
});

it('reports a start whose response was lost as unknown, and the same id again starts one session', async () => {
  server.loseNextResponse = true;
  const first = await runCloudSessionOperation(agent, sessionId, sessionId, 'start');
  expect(first.state).toBe('unknown');
  expect(await runCloudSessionOperation(agent, sessionId, sessionId, 'start')).toEqual({
    state: 'applied',
  });
  expect([...server.sessions]).toEqual([sessionId]);
});

it('reports a restart whose response was lost as unknown, and the same id again restarts once', async () => {
  server.loseNextResponse = true;
  expect((await runCloudSessionOperation(agent, sessionId, restartId, 'restart')).state).toBe(
    'unknown'
  );
  expect(await runCloudSessionOperation(agent, sessionId, restartId, 'restart')).toEqual({
    state: 'applied',
  });
  expect(server.restarts).toBe(1);
});

it('reports a refusal the server answered as a definite failure', async () => {
  server.refuseNext = { status: 409, detail: 'Start the cloud worker and wait until it is ready.' };
  expect(await runCloudSessionOperation(agent, sessionId, sessionId, 'start')).toEqual({
    state: 'failed',
    message: 'Start the cloud worker and wait until it is ready.',
  });
});

it('refuses a start whose operation id is not its session id', async () => {
  await expect(runCloudSessionOperation(agent, sessionId, restartId, 'start')).rejects.toThrow(
    /identified by its session id/
  );
});
