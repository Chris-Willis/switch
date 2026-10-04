import type { RepoAgentField } from '@switch-console/core/agents/plugins';
import type { AdvancedConfigValue } from '@switch-console/plugins/agents';
import {
  attributesFromForm,
  emptyForm,
  formFromAttributes,
  type FormState,
} from '@renderer/features/locations/components/agent-definition-fields';
import type {
  AdvancedConfigField,
  ManagedAgentChanges,
  ManagedAgentView,
} from '@shared/core/managed-agents/managed-agents';

/**
 * The model, a definition field of its own rather than part of the provider's
 * advanced configuration, shown first among it. Keyed `model` because that is
 * the key the model catalogue and a variant field's `modelField` name.
 */
export const MODEL_FIELD: RepoAgentField = { key: 'model', label: 'Model', type: 'text' };

export const DIRECTORY_FIELD: RepoAgentField = {
  key: 'definition-directory',
  label: 'Directory',
  type: 'text',
  placeholder: 'Chosen by the machine',
  help: 'The working directory, absolute on its machine. Leave it empty and the machine makes a fresh workspace.',
};

export const OWN_PROCESS_FIELD: RepoAgentField = {
  key: 'definition-own-process',
  label: 'Run in its own process',
  type: 'boolean',
  help: 'Isolated from the other agents on its machine, instead of inside the machine’s controller.',
};

/** Every field the managed agent page's Advanced configuration shows, in order. */
export function managedAdvancedFields(schema: AdvancedConfigField[]): RepoAgentField[] {
  return [MODEL_FIELD, DIRECTORY_FIELD, OWN_PROCESS_FIELD, ...schema];
}

/**
 * The advanced configuration the form holds, as a definition carries it:
 * unset fields left out rather than sent empty, which the server refuses.
 */
export function advancedConfigFromForm(
  fields: AdvancedConfigField[],
  form: FormState
): Record<string, AdvancedConfigValue> {
  const config: Record<string, AdvancedConfigValue> = {};
  for (const [key, value] of Object.entries(attributesFromForm(fields, form))) {
    if (value === null || value === '' || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    config[key] = value;
  }
  return config;
}

/** A managed agent's page as edited: its identity, and its definition as one form. */
export type Draft = {
  displayName: string;
  description: string;
  iconUrl: string | null;
  instructions: string;
  autoApprove: boolean;
  /** The model, directory and isolation, and every field of the provider's schema. */
  form: FormState;
};

export function draftOf(agent: ManagedAgentView, schema: AdvancedConfigField[]): Draft {
  return {
    displayName: agent.displayName ?? '',
    description: agent.description,
    iconUrl: agent.iconUrl,
    instructions: agent.definition.instructions,
    autoApprove: agent.definition.autoApprove,
    form: {
      ...emptyForm(schema),
      ...formFromAttributes(schema, agent.definition.advancedConfig),
      [MODEL_FIELD.key]: agent.definition.model ?? '',
      [DIRECTORY_FIELD.key]: agent.definition.directory ?? '',
      [OWN_PROCESS_FIELD.key]: agent.definition.isolation === 'isolated',
    },
  };
}

/** What a save sends: the definition and machine to the server, and the identity fields one by one. */
export type ManagedAgentEdit = {
  changes: ManagedAgentChanges;
  displayName?: string | null;
  description?: string;
  iconUrl?: string | null;
};

/**
 * What changed between the saved draft and the edited one, as the server takes
 * it. The advanced configuration goes as a whole replacement when any of its
 * fields changed; a key the schema does not name is kept, so the server judges
 * it rather than Console dropping it unseen.
 */
export function editOf(
  agent: ManagedAgentView,
  schema: AdvancedConfigField[],
  before: Draft,
  after: Draft
): ManagedAgentEdit {
  const definition: ManagedAgentChanges['definition'] = {};
  const model = String(after.form[MODEL_FIELD.key] ?? '').trim() || null;
  if (model !== (String(before.form[MODEL_FIELD.key] ?? '').trim() || null))
    definition.model = model;
  const directory = String(after.form[DIRECTORY_FIELD.key] ?? '').trim() || null;
  if (directory !== (String(before.form[DIRECTORY_FIELD.key] ?? '').trim() || null))
    definition.directory = directory;
  const isolated = after.form[OWN_PROCESS_FIELD.key] === true;
  if (isolated !== (before.form[OWN_PROCESS_FIELD.key] === true))
    definition.isolation = isolated ? 'isolated' : 'shared';
  const advancedConfig = advancedConfigFromForm(schema, after.form);
  if (
    JSON.stringify(advancedConfig) !== JSON.stringify(advancedConfigFromForm(schema, before.form))
  ) {
    const known = new Set(schema.map((field) => field.key));
    const unknown = Object.entries(agent.definition.advancedConfig).filter(
      ([key]) => !known.has(key)
    );
    definition.advancedConfig = { ...Object.fromEntries(unknown), ...advancedConfig };
  }
  if (after.autoApprove !== before.autoApprove) definition.autoApprove = after.autoApprove;
  if (after.instructions !== before.instructions) definition.instructions = after.instructions;

  const edit: ManagedAgentEdit = { changes: { definition } };
  const displayName = after.displayName.trim() || null;
  if (displayName !== (before.displayName.trim() || null)) edit.displayName = displayName;
  if (after.description.trim() !== before.description.trim())
    edit.description = after.description.trim();
  if (after.iconUrl !== before.iconUrl) edit.iconUrl = after.iconUrl;
  return edit;
}

export function editIsEmpty(edit: ManagedAgentEdit): boolean {
  return (
    Object.keys(edit.changes.definition).length === 0 &&
    edit.changes.machineId === undefined &&
    edit.displayName === undefined &&
    edit.description === undefined &&
    edit.iconUrl === undefined
  );
}
