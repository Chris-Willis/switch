import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

export type ManagedAgentState = {
  label: string;
  tone: 'ok' | 'busy' | 'idle' | 'problem';
  /** Why, in the machine's words, when it reported a reason. */
  detail: string | null;
};

/** How a managed agent is doing, from what the server says of it and of its machine. */
export function managedAgentState(agent: ManagedAgentView): ManagedAgentState {
  const status = agent.status;
  const detail = status?.detail ?? status?.reason ?? null;
  if (!agent.machine) return { label: 'No machine', tone: 'problem', detail: null };
  if (agent.machine.state === 'revoked')
    return { label: 'Machine removed', tone: 'problem', detail: null };
  if (agent.desiredState === 'stopped') {
    const stillUp =
      status && ['pending', 'starting', 'running', 'stopping'].includes(status.process);
    return stillUp
      ? { label: 'Stopping', tone: 'busy', detail: null }
      : { label: 'Stopped', tone: 'idle', detail: null };
  }
  if (agent.machine.state !== 'online')
    return { label: 'Machine offline', tone: 'problem', detail: null };
  if (!status) return { label: 'Starting', tone: 'busy', detail: null };
  switch (status.process) {
    case 'running':
      return status.attached
        ? { label: 'Running', tone: 'ok', detail: null }
        : { label: 'Connecting', tone: 'busy', detail };
    case 'crashed':
    case 'failed':
      return { label: 'Failed', tone: 'problem', detail };
    case 'pending':
    case 'starting':
    case 'stopped':
      return { label: 'Starting', tone: 'busy', detail };
    default:
      return { label: status.process, tone: 'busy', detail };
  }
}

export function managedAgentLabel(agent: ManagedAgentView): string {
  return agent.displayName || agent.name;
}
