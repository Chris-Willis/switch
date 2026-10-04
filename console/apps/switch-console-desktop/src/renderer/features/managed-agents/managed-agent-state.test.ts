import { describe, expect, it } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { managedAgentState } from './managed-agent-state';

const AGENT: ManagedAgentView = {
  serverId: 'server-1',
  agentId: 'agent-1',
  name: 'pm-agent',
  displayName: null,
  iconUrl: null,
  description: '',
  machine: { id: 'controller-1', name: 'laptop', kind: 'console', state: 'online' },
  desiredState: 'running',
  revision: 1,
  definition: {
    provider: 'claude',
    model: null,
    modelOptions: {},
    instructions: '',
    autoApprove: false,
    directory: null,
    isolation: 'shared',
  },
  status: { process: 'running', attached: true, reason: null, detail: null },
};

describe('managedAgentState', () => {
  it('is running once its machine says it runs and is connected', () => {
    expect(managedAgentState(AGENT)).toEqual({ label: 'Running', tone: 'ok', detail: null });
  });

  it('is connecting while it runs but has not connected to Switch', () => {
    expect(
      managedAgentState({ ...AGENT, status: { ...AGENT.status!, attached: false } }).label
    ).toBe('Connecting');
  });

  it('is starting before its machine reports it', () => {
    expect(managedAgentState({ ...AGENT, status: null }).label).toBe('Starting');
  });

  it('says why it failed, in its machine’s words', () => {
    expect(
      managedAgentState({
        ...AGENT,
        status: { process: 'failed', attached: false, reason: 'crash_loop', detail: 'Exited 1' },
      })
    ).toEqual({ label: 'Failed', tone: 'problem', detail: 'Exited 1' });
  });

  it('is stopping until its machine stops it, then stopped', () => {
    expect(managedAgentState({ ...AGENT, desiredState: 'stopped' }).label).toBe('Stopping');
    expect(managedAgentState({ ...AGENT, desiredState: 'stopped', status: null }).label).toBe(
      'Stopped'
    );
  });

  it('says its machine is offline or gone rather than guessing at the agent', () => {
    expect(
      managedAgentState({ ...AGENT, machine: { ...AGENT.machine!, state: 'unknown' } }).label
    ).toBe('Machine offline');
    expect(
      managedAgentState({ ...AGENT, machine: { ...AGENT.machine!, state: 'revoked' } }).label
    ).toBe('Machine removed');
    expect(managedAgentState({ ...AGENT, machine: null }).label).toBe('No machine');
  });
});
