import { ControllerApiError, isRevoked } from './api';
import { ReasonedError } from './errors';
import { errorMessage, type Logger } from './log';
import { isSafeSegment } from './paths';
import { type AgentObservation, type AgentRuntime, emptyObservation } from './runtime';
import {
  type AgentAssignment,
  type AgentCredentials,
  type Assignment,
  isProvider,
  type Provider,
  type ReasonCode,
} from './schemas';
import { isCredentialFailure } from './status';
import type { AgentRow, ControllerStore } from './store';
import { buildWatcherTemplate } from './template';

/** How long after replacing a refused agent key the controller waits before doing it again. */
export const CREDENTIAL_REFETCH_INTERVAL_MS = 10 * 60 * 1000;

export type StartAction = {
  kind: 'start';
  agentId: string;
  entry: AgentAssignment;
  restart: boolean;
  replaceIdentity: boolean;
  fetchCredentials: boolean;
  /** The key is being replaced because Switch refused the old one, not because there was none. */
  automaticRefetch: boolean;
  clearTakenOver: boolean;
  /** Counted in `restarts_10m`: anything but the first start of an agent here. */
  relaunch: boolean;
  why: string;
};

export type Action =
  | StartAction
  /** `write` is false when nothing is running and the watcher is already off: only the record moves. */
  | { kind: 'stop'; agentId: string; revision: number; write: boolean }
  | { kind: 'remove'; agentId: string }
  | { kind: 'invalid'; agentId: string; revision: number; detail: string; stop: boolean }
  | { kind: 'hold'; agentId: string; why: string };

/** Why an assigned agent cannot be applied on this machine as defined, or null when it can. */
export function definitionProblem(entry: AgentAssignment): string | null {
  if (!isSafeSegment(entry.agent_id))
    return `The agent id '${entry.agent_id}' cannot be used as a directory name.`;
  if (!isProvider(entry.definition.provider))
    return `This controller does not run the provider '${entry.definition.provider}'.`;
  if (entry.definition.directory === null && !isSafeSegment(entry.definition.name))
    return `The agent name '${entry.definition.name}' cannot be used as a workspace directory name; set a directory.`;
  return null;
}

/**
 * Decides what to do for each agent, from the assignment, what was applied,
 * and what is running. Pure: it reads nothing and changes nothing.
 *
 * Running agents are started when never applied or when their revision moved
 * (a restart, so the new definition takes effect), and started again when
 * their watcher is gone without a recorded failure (a reboot, say). A watcher
 * that failed, or stood down because another client took its connection,
 * stays down until a new revision or an explicit restart, with one exception:
 * a key Switch refused is replaced and the watcher relaunched, at most once
 * every ten minutes. A revision older than the one applied is refused.
 */
export function planReconcile(input: {
  assignment: Assignment;
  rows: AgentRow[];
  observations: Map<string, AgentObservation>;
  credentialsPresent: Set<string>;
  nowMs: number;
}): Action[] {
  const actions: Action[] = [];
  const rows = new Map(input.rows.map((row) => [row.agentId, row]));
  const assigned = new Set<string>();
  for (const entry of input.assignment.agents) {
    const agentId = entry.agent_id;
    assigned.add(agentId);
    const row = rows.get(agentId) ?? null;
    const observation = input.observations.get(agentId);
    if (!observation) throw new Error(`No observation of agent ${agentId} to reconcile against.`);
    const applied = row?.appliedRevision ?? null;
    const problem = definitionProblem(entry);
    if (problem) {
      if (row?.failure?.revision !== entry.revision || observation.alive)
        actions.push({
          kind: 'invalid',
          agentId,
          revision: entry.revision,
          detail: problem,
          stop: observation.alive,
        });
      continue;
    }
    if (applied !== null && applied > entry.revision) {
      actions.push({
        kind: 'hold',
        agentId,
        why: `revision ${entry.revision} is older than the applied revision ${applied}`,
      });
      continue;
    }
    if (entry.desired_state === 'unknown') {
      actions.push({
        kind: 'hold',
        agentId,
        why: 'the desired state is not one this controller knows',
      });
      continue;
    }
    if (entry.desired_state === 'stopped') {
      const off = observation.flags === null || observation.flags.enabled === false;
      if (observation.alive || !off) {
        if (observation.flags?.enabled !== false || applied !== entry.revision)
          actions.push({ kind: 'stop', agentId, revision: entry.revision, write: true });
      } else if (applied !== entry.revision)
        actions.push({ kind: 'stop', agentId, revision: entry.revision, write: false });
      continue;
    }
    const hasCredentials = input.credentialsPresent.has(agentId);
    const base = {
      kind: 'start' as const,
      agentId,
      entry,
      fetchCredentials: !hasCredentials || (row?.credentialsStale ?? false),
      automaticRefetch: false,
      relaunch: applied !== null || observation.configured !== null,
    };
    if (applied === null || applied < entry.revision) {
      // The working directory is resolved when starting, and compared there too.
      const replaceIdentity =
        observation.configured !== null &&
        observation.configured.provider !== entry.definition.provider;
      actions.push({
        ...base,
        restart: observation.configured !== null,
        replaceIdentity,
        clearTakenOver: true,
        why: applied === null ? 'not applied yet' : `revision ${applied} → ${entry.revision}`,
      });
      continue;
    }
    if (observation.alive) {
      if (observation.flags?.enabled === false)
        actions.push({
          ...base,
          restart: true,
          replaceIdentity: false,
          clearTakenOver: false,
          why: 'its watcher is being turned off',
        });
      continue;
    }
    if (observation.takenOver) continue;
    if (observation.failure) {
      const refetchedAt = row?.credentialsRefetchedAt
        ? Date.parse(row.credentialsRefetchedAt)
        : null;
      if (
        isCredentialFailure(observation.failure) &&
        (refetchedAt === null || input.nowMs - refetchedAt >= CREDENTIAL_REFETCH_INTERVAL_MS)
      )
        actions.push({
          ...base,
          fetchCredentials: true,
          automaticRefetch: true,
          restart: false,
          replaceIdentity: false,
          clearTakenOver: false,
          why: 'Switch refused its key',
        });
      continue;
    }
    actions.push({
      ...base,
      restart: false,
      replaceIdentity: false,
      clearTakenOver: false,
      why: 'its watcher is not running',
    });
  }
  for (const row of input.rows)
    if (!assigned.has(row.agentId)) actions.push({ kind: 'remove', agentId: row.agentId });
  return actions;
}

export type ReconcileDeps = {
  store: ControllerStore;
  runtime: AgentRuntime;
  /** Fetches (and so rotates) an agent's API key. */
  fetchCredentials: (agentId: string) => Promise<AgentCredentials>;
  /** The agent bridge URL written into each agent's credentials. */
  server: string;
  binaryPath: (provider: Provider) => Promise<string | null>;
  now: () => number;
  log: Logger;
};

function reasonFor(error: unknown): ReasonCode {
  if (error instanceof ReasonedError) return error.reason;
  if (error instanceof ControllerApiError && error.code === 'not_assigned') return 'not_assigned';
  return 'internal';
}

export type StartFailure = { reason: ReasonCode; detail: string };

/**
 * Starts or restarts one agent at its assigned revision. A failure is recorded
 * on the agent and returned, not thrown; only a revoked controller throws.
 */
export async function startAgent(
  action: StartAction,
  deps: ReconcileDeps
): Promise<StartFailure | null> {
  const { agentId, entry } = action;
  const definition = entry.definition;
  const nowMs = deps.now();
  const now = new Date(nowMs).toISOString();
  try {
    const provider = definition.provider;
    if (!isProvider(provider))
      throw new ReasonedError('definition_invalid', `Unknown provider '${provider}'.`);
    if (action.fetchCredentials) {
      const credentials = await deps.fetchCredentials(agentId);
      await deps.runtime.writeCredentials(agentId, {
        endpoint: deps.server,
        apiKey: credentials.api_key,
      });
      deps.store.recordCredentialsFetched(agentId, now, action.automaticRefetch);
    }
    const cwd = await deps.runtime.workingDirectory(definition.name, definition.directory);
    const binaryPath = await deps.binaryPath(provider);
    if (!binaryPath)
      throw new ReasonedError(
        'provider_not_installed',
        `The ${provider} CLI was not found on this machine's PATH.`
      );
    const template = buildWatcherTemplate({
      agentId,
      provider,
      definition,
      cwd,
      credentialsPath: deps.runtime.credentialsPath(agentId),
      binaryPath,
    });
    const observation = await deps.runtime.observe(agentId);
    const replaceIdentity =
      action.replaceIdentity ||
      (observation.configured !== null &&
        (observation.configured.provider !== provider || observation.configured.cwd !== cwd));
    await deps.runtime.launch(agentId, template, {
      spawn: definition.auto_session,
      restart: action.restart || replaceIdentity,
      replaceIdentity,
      clearTakenOver: action.clearTakenOver,
    });
    deps.store.recordApplied(agentId, entry.revision, now);
    if (action.relaunch) deps.store.recordRestart(agentId, nowMs);
    deps.log.info('Started agent', { agentId, revision: entry.revision, why: action.why });
    return null;
  } catch (error) {
    if (isRevoked(error)) throw error;
    const reason = reasonFor(error);
    const detail = errorMessage(error);
    deps.store.recordFailure(agentId, { revision: entry.revision, reason, detail }, now);
    deps.log.error('Could not start agent', {
      agentId,
      revision: entry.revision,
      reason,
      error: detail,
    });
    return { reason, detail };
  }
}

/** Carries out one action. Per-agent failures are recorded on the agent and logged. */
export async function executeAction(action: Action, deps: ReconcileDeps): Promise<void> {
  const now = new Date(deps.now()).toISOString();
  switch (action.kind) {
    case 'start':
      await startAgent(action, deps);
      return;
    case 'stop':
      if (action.write) await deps.runtime.stop(action.agentId, { wait: false });
      deps.store.recordApplied(action.agentId, action.revision, now);
      deps.log.info('Stopped agent', { agentId: action.agentId, revision: action.revision });
      return;
    case 'remove':
      // An id that was never safe to put in a path never got a watcher or a key.
      if (isSafeSegment(action.agentId)) {
        await deps.runtime.stop(action.agentId, { wait: false });
        await deps.runtime.deleteCredentials(action.agentId);
      }
      deps.store.deleteAgent(action.agentId);
      deps.log.info('Agent is no longer assigned here; stopped it and deleted its key', {
        agentId: action.agentId,
      });
      return;
    case 'invalid':
      if (action.stop) await deps.runtime.stop(action.agentId, { wait: false });
      deps.store.recordFailure(
        action.agentId,
        { revision: action.revision, reason: 'definition_invalid', detail: action.detail },
        now
      );
      deps.log.error('Agent definition cannot be applied', {
        agentId: action.agentId,
        detail: action.detail,
      });
      return;
    case 'hold':
      deps.log.warn('Leaving agent as it is', { agentId: action.agentId, why: action.why });
      return;
  }
}

/** Observes every agent, plans, and carries the plan out in order. */
export async function reconcile(assignment: Assignment, deps: ReconcileDeps): Promise<Action[]> {
  const observations = new Map<string, AgentObservation>();
  const credentialsPresent = new Set<string>();
  for (const entry of assignment.agents) {
    if (definitionProblem(entry)) {
      observations.set(entry.agent_id, emptyObservation());
      continue;
    }
    observations.set(entry.agent_id, await deps.runtime.observe(entry.agent_id));
    if (await deps.runtime.hasCredentials(entry.agent_id)) credentialsPresent.add(entry.agent_id);
  }
  const actions = planReconcile({
    assignment,
    rows: deps.store.agents(),
    observations,
    credentialsPresent,
    nowMs: deps.now(),
  });
  for (const action of actions) {
    try {
      await executeAction(action, deps);
    } catch (error) {
      if (isRevoked(error)) throw error;
      deps.log.error('Reconcile step failed', {
        agentId: action.agentId,
        action: action.kind,
        error: errorMessage(error),
      });
    }
  }
  return actions;
}
