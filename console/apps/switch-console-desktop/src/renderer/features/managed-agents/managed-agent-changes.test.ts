import { describe, expect, it } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { changesOf, draftOf } from './managed-agent-changes';

const AGENT: ManagedAgentView = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
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
    model: 'opus',
    advancedConfig: { effort: 'high' },
    instructions: 'Be brief.',
    autoApprove: false,
    directory: '/work/pm',
    isolation: 'shared',
  },
  status: null,
};

describe('changesOf', () => {
  it('sends only what changed', () => {
    const before = draftOf(AGENT);
    expect(changesOf(AGENT, before, { ...before, autoApprove: true, isolated: true })).toEqual({
      definition: { autoApprove: true, isolation: 'isolated' },
    });
    expect(changesOf(AGENT, before, before)).toEqual({ definition: {} });
  });

  it('sets the effort as the model option, and moves machines', () => {
    const before = draftOf(AGENT);
    expect(
      changesOf(AGENT, before, { ...before, option: 'max', machineId: 'controller-2' })
    ).toEqual({ definition: { advancedConfig: { effort: 'max' } }, machineId: 'controller-2' });
  });

  it('keeps the advanced configuration when the model goes back to the default', () => {
    const before = draftOf(AGENT);
    expect(changesOf(AGENT, before, { ...before, model: '' })).toEqual({
      definition: { model: null },
    });
  });

  it('drops the old provider’s options when the provider changes', () => {
    const before = draftOf(AGENT);
    expect(
      changesOf(AGENT, before, { ...before, provider: 'opencode', option: '', model: 'gpt' })
    ).toEqual({ definition: { provider: 'opencode', model: 'gpt', advancedConfig: {} } });
  });

  it('clears the directory to let the machine choose', () => {
    const before = draftOf(AGENT);
    expect(changesOf(AGENT, before, { ...before, directory: '  ' })).toEqual({
      definition: { directory: null },
    });
  });
});
