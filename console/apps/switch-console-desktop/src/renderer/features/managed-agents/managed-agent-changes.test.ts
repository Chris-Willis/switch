import { describe, expect, it } from 'vitest';
import type {
  AdvancedConfigField,
  ManagedAgentView,
} from '@shared/core/managed-agents/managed-agents';
import {
  advancedConfigFromForm,
  DIRECTORY_FIELD,
  draftOf,
  editIsEmpty,
  editOf,
  MODEL_FIELD,
  OWN_PROCESS_FIELD,
} from './managed-agent-changes';

const SCHEMA: AdvancedConfigField[] = [
  {
    key: 'effort',
    label: 'Effort',
    type: 'select',
    options: [
      { value: '', label: 'Inherit' },
      { value: 'high', label: 'high' },
      { value: 'max', label: 'max' },
    ],
  },
  { key: 'tools', label: 'Tools', type: 'list' },
  { key: 'maxTurns', label: 'Max turns', type: 'number' },
  { key: 'background', label: 'Always run in background', type: 'boolean' },
];

const AGENT: ManagedAgentView = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'pm-agent',
  displayName: null,
  iconUrl: null,
  description: 'Writes PRDs',
  machine: { id: 'controller-1', name: 'laptop', kind: 'console', state: 'online' },
  desiredState: 'running',
  revision: 1,
  definition: {
    provider: 'claude',
    model: 'opus',
    advancedConfig: { effort: 'high', tools: ['Read'] },
    instructions: 'Be brief.',
    autoApprove: false,
    directory: '/work/pm',
    isolation: 'shared',
  },
  status: null,
};

describe('editOf', () => {
  it('sends nothing when nothing changed', () => {
    const before = draftOf(AGENT, SCHEMA);
    expect(editIsEmpty(editOf(AGENT, SCHEMA, before, before))).toBe(true);
  });

  it('sends only the definition fields that changed', () => {
    const before = draftOf(AGENT, SCHEMA);
    const after = {
      ...before,
      autoApprove: true,
      form: { ...before.form, [OWN_PROCESS_FIELD.key]: true, [MODEL_FIELD.key]: ' sonnet ' },
    };
    expect(editOf(AGENT, SCHEMA, before, after)).toEqual({
      changes: { definition: { autoApprove: true, isolation: 'isolated', model: 'sonnet' } },
    });
  });

  it('replaces the whole advanced configuration when one of its fields changed', () => {
    const before = draftOf(AGENT, SCHEMA);
    const after = { ...before, form: { ...before.form, effort: 'max', maxTurns: '12' } };
    expect(editOf(AGENT, SCHEMA, before, after).changes.definition).toEqual({
      advancedConfig: { effort: 'max', tools: ['Read'], maxTurns: 12 },
    });
  });

  it('leaves a cleared field out rather than sending it empty', () => {
    const before = draftOf(AGENT, SCHEMA);
    const after = { ...before, form: { ...before.form, effort: '', tools: '' } };
    expect(editOf(AGENT, SCHEMA, before, after).changes.definition).toEqual({
      advancedConfig: {},
    });
  });

  it('keeps a key the schema does not name, for the server to judge', () => {
    const agent = {
      ...AGENT,
      definition: { ...AGENT.definition, advancedConfig: { effort: 'high', legacy: 'x' } },
    };
    const before = draftOf(agent, SCHEMA);
    const after = { ...before, form: { ...before.form, effort: 'max' } };
    expect(editOf(agent, SCHEMA, before, after).changes.definition.advancedConfig).toEqual({
      legacy: 'x',
      effort: 'max',
    });
  });

  it('clears the model and the directory to leave them to the provider and the machine', () => {
    const before = draftOf(AGENT, SCHEMA);
    const after = {
      ...before,
      form: { ...before.form, [MODEL_FIELD.key]: '', [DIRECTORY_FIELD.key]: '  ' },
    };
    expect(editOf(AGENT, SCHEMA, before, after).changes.definition).toEqual({
      model: null,
      directory: null,
    });
  });

  it('sends the display name, description and icon on their own', () => {
    const before = draftOf(AGENT, SCHEMA);
    const after = { ...before, displayName: ' PM ', description: 'Writes specs', iconUrl: 'x.png' };
    expect(editOf(AGENT, SCHEMA, before, after)).toEqual({
      changes: { definition: {} },
      displayName: 'PM',
      description: 'Writes specs',
      iconUrl: 'x.png',
    });
  });
});

describe('advancedConfigFromForm', () => {
  it('drops unset values of every type', () => {
    expect(
      advancedConfigFromForm(SCHEMA, { effort: '', tools: ' ', maxTurns: '', background: false })
    ).toEqual({});
    expect(
      advancedConfigFromForm(SCHEMA, {
        effort: 'high',
        tools: 'Read, Grep',
        maxTurns: '3',
        background: true,
      })
    ).toEqual({ effort: 'high', tools: ['Read', 'Grep'], maxTurns: 3, background: true });
  });
});
