import { setTimeout as delay } from 'node:timers/promises';
import {
  CloudRelayClient,
  CloudRelayError,
  RELAY_TIMEOUT_MS,
} from '@switch-console/agent-providers';
import type { Attachment, Session } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import {
  AgentManagementUnavailableError,
  fetchManagedAgents,
  fetchManagementControllers,
  GatewayError,
  gatewayFetch,
  gatewayRequest,
  type ManagedAgent,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { withServerWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { KV } from '@main/db/kv';
import {
  type CloudAgent,
  cloudAgentKey,
  cloudAgentPhase,
  type CloudAgentTarget,
  cloudControllerAgentKey,
  type CloudLaunch,
  cloudLaunchSchema,
  type CloudMachine,
  cloudMachineSchema,
  type CloudOperation,
  type CloudOperationOutcome,
  cloudOperationSchema,
  type CloudRelayProblem,
  type CloudSessions,
  parseCloudAgentKey,
} from '@shared/core/cloud-agents/cloud-agents';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Console's reach into a cloud agent's worker, through its Switch server.
 *
 * A sidecar is reached over SSH on its control port; a cloud worker accepts no
 * connection, so the same control messages go through the server's relay for
 * the launch. One relay client per launch, made on first use and again after
 * it closes. Transcripts stay on the worker: every snapshot, list and event
 * is asked of it through the relay.
 *
 * A launch whose agent is a managed agent on the owner's cloud machine
 * controller (kind `ec2`) is run by that controller, not by a worker: it is
 * keyed by the agent and relayed through the agent's control routes, which
 * take the same messages and answer the same way.
 */

export function isCloudAgent(agentId: string): boolean {
  return parseCloudAgentKey(agentId) !== null;
}

function targetOf(agentId: string): CloudAgentTarget {
  const key = parseCloudAgentKey(agentId);
  if (!key) throw new Error(`${agentId} is not a cloud agent.`);
  return key;
}

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Where Switch relays for a cloud agent, relative to the gateway. */
export function cloudRelayBasePath(target: CloudAgentTarget): string {
  if (target.kind === 'launch') return launchPath(target.requestId, '/relay');
  if (!AGENT_ID.test(target.agentId))
    throw new Error(`${JSON.stringify(target.agentId)} is not a Switch agent id.`);
  return `/management/agents/${target.agentId}/control`;
}

async function requireCloudServer(serverId: string): Promise<void> {
  if (!(await getServer(serverId)))
    throw new Error('The Switch server for this cloud agent was removed.');
}

/**
 * Run `fn` against the cloud agent's server with its workspace's tenant
 * selected: launches, machines and their operations belong to a tenant, so a
 * call that went out under another one would answer for that one instead.
 * One lease per request, never around a wait, so a workspace switch is not
 * held up by a long poll.
 */
async function onCloudServer<T>(
  serverId: string,
  fn: (server: SwitchServer) => Promise<T>
): Promise<T> {
  await requireCloudServer(serverId);
  return withServerWorkspaceSession(serverId, fn);
}

function launchPath(requestId: string, rest = ''): string {
  return `/hosted-launches/${encodeURIComponent(requestId)}${rest}`;
}

function machinePath(machineId: string, rest = ''): string {
  return `/hosted-machines/${encodeURIComponent(machineId)}${rest}`;
}

const clients = new Map<string, CloudRelayClient>();

/**
 * The sessions last read from each cloud agent's worker, by agent key, kept
 * across restarts: while its machine is stopped, asleep or waking they stay
 * listed beside why, since opening one is how its user wakes it.
 */
const lastSessions = new KV<Record<string, Session[]>>('cloud-sessions');
const KEEPS_LAST_SESSIONS = new Set(['machine_stopped', 'worker_sleeping', 'worker_waking']);

/** The relay client for this cloud agent's worker, made if there is none. */
export async function cloudControl(agentId: string): Promise<CloudRelayClient> {
  const existing = clients.get(agentId);
  if (existing && !existing.isClosed) return existing;
  const target = targetOf(agentId);
  const { serverId } = target;
  await requireCloudServer(serverId);
  const client = new CloudRelayClient(
    (path, init) =>
      withServerWorkspaceSession(serverId, (server) =>
        gatewayRequest(server, path, {
          authenticated: true,
          method: init.method,
          body: init.body,
          signal: init.signal,
        })
      ),
    cloudRelayBasePath(target),
    { retryMs: 20_000, timeoutMs: RELAY_TIMEOUT_MS }
  );
  client.onClose(() => {
    if (clients.get(agentId) === client) clients.delete(agentId);
  });
  clients.set(agentId, client);
  return client;
}

/**
 * The server's launches, or null when it has no launch list at all: a Core
 * without cloud agents answers the route with 404.
 */
export async function listCloudLaunches(server: SwitchServer): Promise<CloudLaunch[] | null> {
  let response: Response;
  try {
    response = await gatewayFetch(server, '/hosted-launches', { authenticated: true });
  } catch (error) {
    if (error instanceof GatewayError && error.kind === 'http' && error.status === 404) return null;
    throw error;
  }
  return z.array(cloudLaunchSchema).parse(await response.json());
}

/**
 * The caller's cloud machines. Unlike the launch list, a 404 here is not read
 * as "no cloud agents": a server that lists launches but not machines is one
 * this Console does not match.
 */
export async function listCloudMachines(server: SwitchServer): Promise<CloudMachine[]> {
  const response = await gatewayFetch(server, '/hosted-machines', { authenticated: true });
  return z.object({ machines: z.array(cloudMachineSchema) }).parse(await response.json()).machines;
}

/** The caller's cloud machines, or null when the server has no cloud agents. */
export async function listServerCloudMachines(serverId: string): Promise<CloudMachine[] | null> {
  return onCloudServer(serverId, async (server) => {
    if ((await listCloudLaunches(server)) === null) return null;
    return listCloudMachines(server);
  });
}

/**
 * The caller's managed agents that a cloud machine's controller runs, by
 * agent id: those placed on one of their `ec2` controllers. Empty when the
 * server has no agent management or the caller has no cloud machine
 * controller, which is every launch still run by its worker.
 */
export async function listControllerCloudAgents(
  server: SwitchServer
): Promise<Map<string, ManagedAgent & { controllerId: string }>> {
  let controllers;
  try {
    controllers = await fetchManagementControllers(server);
  } catch (error) {
    if (error instanceof AgentManagementUnavailableError) return new Map();
    throw error;
  }
  const cloud = new Set(
    controllers.filter((controller) => controller.kind === 'ec2').map((each) => each.id)
  );
  if (cloud.size === 0) return new Map();
  const placed = new Map<string, ManagedAgent & { controllerId: string }>();
  for (const agent of await fetchManagedAgents(server))
    if (agent.controllerId !== null && cloud.has(agent.controllerId))
      placed.set(agent.agentId, { ...agent, controllerId: agent.controllerId });
  return placed;
}

/**
 * Why a launch's worker cannot be asked, machine first, or null when it can.
 * Read the way the server answers a read-only relay, which reports a sleeping
 * machine whatever the launch's own state.
 */
function launchProblem(
  launch: CloudLaunch,
  machine: CloudMachine | null
): CloudRelayProblem | null {
  if (launch.desired_state === 'deleted')
    return {
      code: 'worker_not_attached',
      message: 'The cloud agent is being removed.',
      wakeAvailable: false,
    };
  const phase = cloudAgentPhase(launch, machine);
  if (phase === 'machine_stopped')
    return {
      code: 'machine_stopped',
      message: 'The owner stopped the cloud machine.',
      wakeAvailable: false,
    };
  if (phase === 'machine_error')
    return {
      code: 'machine_error',
      message: machine?.error ?? 'The cloud machine is in error.',
      wakeAvailable: false,
    };
  if (machine ? machine.sleeping : launch.sleeping)
    return {
      code: 'worker_sleeping',
      message: 'The cloud machine is asleep.',
      wakeAvailable: phase === 'sleeping',
    };
  if (phase === 'waking')
    return {
      code: 'worker_waking',
      message: 'The cloud machine is starting.',
      wakeAvailable: false,
    };
  if (launch.desired_state === 'stopped')
    return { code: 'agent_stopped', message: 'The agent is stopped.', wakeAvailable: false };
  if (launch.state === 'error' && launch.error_code === 'agent_crashed')
    return {
      code: 'agent_crashed',
      message: launch.error ?? 'The agent crashed.',
      wakeAvailable: false,
    };
  if (launch.state !== 'ready' && launch.state !== 'running')
    return {
      code: 'worker_not_attached',
      message: `The cloud worker is ${launch.state}${launch.error ? `: ${launch.error}` : '.'}`,
      wakeAvailable: false,
    };
  return null;
}

/**
 * Why a launch its cloud machine's controller runs cannot be asked, or null
 * when it can. The machine says first, as for a worker's launch; the agent's
 * own state is the managed agent's, which its controller reports, since the
 * launch's is no longer reported once a controller runs it.
 */
function controllerAgentProblem(
  launch: CloudLaunch,
  machine: CloudMachine | null,
  agent: ManagedAgent
): CloudRelayProblem | null {
  if (launch.desired_state === 'deleted')
    return {
      code: 'worker_not_attached',
      message: 'The cloud agent is being removed.',
      wakeAvailable: false,
    };
  if (machine?.state === 'error')
    return {
      code: 'machine_error',
      message: machine.error ?? 'The cloud machine is in error.',
      wakeAvailable: false,
    };
  if (machine?.desired_state === 'stopped' && machine.stop_reason === 'owner')
    return {
      code: 'machine_stopped',
      message: 'The owner stopped the cloud machine.',
      wakeAvailable: false,
    };
  if (agent.desiredState === 'stopped')
    return { code: 'agent_stopped', message: 'The agent is stopped.', wakeAvailable: false };
  if (machine?.sleeping)
    return {
      code: 'worker_sleeping',
      message: 'The cloud machine is asleep.',
      wakeAvailable: true,
    };
  if (
    machine?.desired_state === 'running' &&
    ['queued', 'provisioning', 'stopping', 'stopped', 'retained'].includes(machine.state)
  )
    return {
      code: 'worker_waking',
      message: 'The cloud machine is starting.',
      wakeAvailable: false,
    };
  if (agent.status?.process === 'crashed' || agent.status?.process === 'failed')
    return {
      code: 'agent_crashed',
      message: agent.status.detail ?? 'The agent crashed.',
      wakeAvailable: false,
    };
  return null;
}

/**
 * The server's cloud agents, read from the launch and machine lists, or null
 * when the server has no cloud agents. A launch whose worker cannot be asked
 * says why; the sessions of one that can are asked of its worker by
 * `listCloudSessions`, only for the agents being looked at.
 */
export async function listCloudAgents(serverId: string): Promise<CloudAgent[] | null> {
  const listed = await onCloudServer(serverId, listCloudLaunches);
  if (listed === null) return null;
  const launches = listed.filter(
    (launch) =>
      launch.state !== 'deleted' &&
      (launch.desired_state !== 'deleted' || launch.state === 'deleting')
  );
  const controllerAgents = await onCloudServer(serverId, listControllerCloudAgents);
  const runBy = (launch: CloudLaunch) =>
    launch.agent_id === null ? undefined : controllerAgents.get(launch.agent_id);
  const keyOf = (launch: CloudLaunch) => {
    const agent = runBy(launch);
    return agent
      ? cloudControllerAgentKey(serverId, agent.agentId)
      : cloudAgentKey(serverId, launch.request_id);
  };
  const stored = await lastSessions.getAll();
  const keys = new Set(launches.map(keyOf));
  for (const key of Object.keys(stored))
    if (parseCloudAgentKey(key)?.serverId === serverId && !keys.has(key))
      await lastSessions.del(key);
  if (launches.length === 0) return [];
  const machines = new Map(
    (await onCloudServer(serverId, listCloudMachines)).map((machine) => [
      machine.machine_id,
      machine,
    ])
  );
  return launches.map((launch): CloudAgent => {
    const machine = launch.machine_id === null ? null : (machines.get(launch.machine_id) ?? null);
    const agent = runBy(launch);
    const key = keyOf(launch);
    const problem = agent
      ? controllerAgentProblem(launch, machine, agent)
      : launchProblem(launch, machine);
    return {
      key,
      launch,
      machine,
      controllerId: agent?.controllerId ?? null,
      sessions: problem && KEEPS_LAST_SESSIONS.has(problem.code) ? (stored[key] ?? null) : null,
      problem,
    };
  });
}

/**
 * A cloud agent's sessions, asked of its worker over the relay. A worker that
 * cannot be asked is reported with the relay's code rather than as no sessions,
 * beside the sessions last read while its machine is down.
 */
export async function listCloudSessions(agentId: string): Promise<CloudSessions> {
  let sessions: Session[];
  try {
    sessions = await (await cloudControl(agentId)).list();
  } catch (error) {
    const problem: CloudRelayProblem =
      error instanceof CloudRelayError
        ? {
            code: error.relayCode,
            message: error.message,
            wakeAvailable: error.wakeAvailable,
          }
        : {
            code: 'failed',
            message: error instanceof Error ? error.message : String(error),
            wakeAvailable: false,
          };
    return {
      sessions: KEEPS_LAST_SESSIONS.has(problem.code) ? await lastSessions.get(agentId) : null,
      problem,
    };
  }
  await lastSessions.set(agentId, sessions);
  return { sessions, problem: null };
}

/**
 * Start the machine a sleeping cloud agent runs on. Only a machine that went to
 * sleep idle is woken: one its owner stopped is started from its card. A
 * machine already asked to run is returned as it is, so a second wake does not
 * bump its revision, and a wake that loses the revision race to another one is
 * the machine waking.
 */
export async function wakeCloudAgent(agentId: string): Promise<CloudMachine> {
  const target = targetOf(agentId);
  const { serverId } = target;
  const launch = await launchOfTarget(target);
  if (launch.machine_id === null)
    throw new Error(`The cloud agent ${launch.name} has no machine to start.`);
  const machineId = launch.machine_id;
  const read = async () =>
    cloudMachineSchema.parse(
      await onCloudServer(serverId, async (server) =>
        (await gatewayFetch(server, machinePath(machineId), { authenticated: true })).json()
      )
    );
  const machine = await read();
  if (machine.desired_state === 'running') return machine;
  if (!machine.sleeping)
    throw new Error(
      machine.desired_state === 'stopped' && machine.stop_reason === 'owner'
        ? 'The owner stopped the cloud machine, so a message does not wake it. Start the machine in Your Agents.'
        : `The cloud machine is ${machine.desired_state}, so it cannot be woken.`
    );
  try {
    return z.object({ machine: cloudMachineSchema }).parse(
      await onCloudServer(serverId, async (server) =>
        (
          await gatewayFetch(server, machinePath(machineId, '/lifecycle'), {
            authenticated: true,
            method: 'POST',
            body: { action: 'start', revision: machine.revision },
          })
        ).json()
      )
    ).machine;
  } catch (error) {
    if (!(error instanceof GatewayError && error.kind === 'http' && error.status === 409))
      throw error;
    const now = await read();
    if (now.desired_state === 'running') return now;
    throw error;
  }
}

/**
 * The launch a cloud agent key names. One keyed by its agent is the launch
 * that agent was created by: the machine the controller runs on is its.
 */
async function launchOfTarget(target: CloudAgentTarget): Promise<CloudLaunch> {
  if (target.kind === 'launch')
    return cloudLaunchSchema.parse(
      await onCloudServer(target.serverId, async (server) =>
        (await gatewayFetch(server, launchPath(target.requestId), { authenticated: true })).json()
      )
    );
  const launch = (await onCloudServer(target.serverId, listCloudLaunches))?.find(
    (each) => each.agent_id === target.agentId && each.desired_state !== 'deleted'
  );
  if (!launch)
    throw new Error(
      `The cloud agent ${target.agentId} has no launch on its Switch server, so there is no cloud machine to start.`
    );
  return launch;
}

const OPERATION_WAIT_MS = 180_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A refusal the server answered, so it holds no operation for this request. */
function isDefiniteRefusal(error: unknown): error is GatewayError {
  return (
    error instanceof GatewayError &&
    (error.kind === 'unauthorized' ||
      (error.kind === 'http' && error.status !== undefined && error.status < 500))
  );
}

/**
 * Ask the worker to start a new session (`start`) or run an existing one
 * again (`restart`), and wait until it says it has. `operationId` is the
 * attempt's identity: after an `unknown` outcome, ask again with the same id
 * and the server returns the operation it already holds instead of queueing
 * another. A start's id is its session id.
 */
export async function runCloudSessionOperation(
  agentId: string,
  sessionId: string,
  operationId: string,
  action: 'start' | 'restart'
): Promise<CloudOperationOutcome> {
  if (action === 'start' && operationId !== sessionId)
    throw new Error('A cloud session start is identified by its session id.');
  const target = targetOf(agentId);
  if (target.kind === 'agent')
    return {
      state: 'failed',
      message: `Switch cannot ${action} a session yet for a cloud agent its cloud machine's controller runs.`,
      code: 'unsupported',
    };
  const { serverId, requestId } = target;
  let operation: CloudOperation;
  try {
    operation = cloudOperationSchema.parse(
      await onCloudServer(serverId, async (server) =>
        (
          await gatewayFetch(server, launchPath(requestId, '/sessions'), {
            authenticated: true,
            method: 'POST',
            body: { id: operationId, session_id: sessionId, action },
          })
        ).json()
      )
    );
  } catch (error) {
    if (isDefiniteRefusal(error))
      return { state: 'failed', message: error.detail ?? error.message, code: error.code ?? null };
    return {
      state: 'unknown',
      message: `The server did not confirm the session ${action}: ${errorMessage(error)}`,
    };
  }
  const deadline = Date.now() + OPERATION_WAIT_MS;
  try {
    while (operation.state === 'queued' || operation.state === 'claimed') {
      if (Date.now() >= deadline)
        return {
          state: 'unknown',
          message: `The cloud worker has not confirmed the session ${action} yet.`,
        };
      await delay(1000);
      operation = cloudOperationSchema.parse(
        await onCloudServer(serverId, async (server) =>
          (
            await gatewayFetch(
              server,
              launchPath(requestId, `/sessions/${encodeURIComponent(operationId)}`),
              { authenticated: true }
            )
          ).json()
        )
      );
    }
  } catch (error) {
    return {
      state: 'unknown',
      message: `The session ${action} could not be followed: ${errorMessage(error)}`,
    };
  }
  if (operation.state === 'applied') return { state: 'applied' };
  if (operation.state === 'failed')
    return {
      state: 'failed',
      message: operation.error ?? `The session ${action} failed.`,
      code: null,
    };
  return { state: 'unknown', message: `The outcome of the session ${action} is unknown.` };
}

/** Stage a file on the session's worker for the next message to name. */
export async function uploadCloudAttachment(
  agentId: string,
  sessionId: string,
  file: { name: string; mimeType: string; data: string }
): Promise<Attachment> {
  return (await cloudControl(agentId)).uploadAttachment(sessionId, {
    name: file.name,
    mimeType: file.mimeType,
    data: Buffer.from(file.data, 'base64'),
  });
}
