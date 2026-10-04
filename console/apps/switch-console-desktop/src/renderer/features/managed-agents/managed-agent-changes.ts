import type {
  ManagedAgentChanges,
  ManagedAgentView,
} from '@shared/core/managed-agents/managed-agents';

/** The model option each provider takes, and its choices where they are a fixed set. */
export const MODEL_OPTION: Record<
  string,
  { key: string; label: string; choices: string[] | null }
> = {
  claude: {
    key: 'effort',
    label: 'Reasoning effort',
    choices: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  codex: {
    key: 'effort',
    label: 'Reasoning effort',
    choices: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  opencode: { key: 'variant', label: 'Variant', choices: null },
};

export type Draft = {
  displayName: string;
  iconUrl: string | null;
  machineId: string | null;
  provider: string;
  model: string;
  option: string;
  directory: string;
  isolated: boolean;
  autoApprove: boolean;
  instructions: string;
};

export function draftOf(agent: ManagedAgentView): Draft {
  const option = MODEL_OPTION[agent.definition.provider];
  return {
    displayName: agent.displayName ?? '',
    iconUrl: agent.iconUrl,
    machineId: agent.machine?.id ?? null,
    provider: agent.definition.provider,
    model: agent.definition.model ?? '',
    option: option ? (agent.definition.modelOptions[option.key] ?? '') : '',
    directory: agent.definition.directory ?? '',
    isolated: agent.definition.isolation === 'isolated',
    autoApprove: agent.definition.autoApprove,
    instructions: agent.definition.instructions,
  };
}

/** What changed between the server's copy and the draft, as the server takes it. */
export function changesOf(
  agent: ManagedAgentView,
  before: Draft,
  after: Draft
): ManagedAgentChanges {
  const definition: ManagedAgentChanges['definition'] = {};
  if (after.provider !== before.provider) definition.provider = after.provider;
  const model = after.model.trim() || null;
  if (model !== (before.model.trim() || null)) definition.model = model;
  const option = MODEL_OPTION[after.provider];
  const modelOptions: Record<string, string> =
    model === null
      ? {}
      : after.provider === before.provider
        ? { ...agent.definition.modelOptions }
        : {};
  if (option && model !== null) {
    delete modelOptions[option.key];
    if (after.option.trim()) modelOptions[option.key] = after.option.trim();
  }
  if (JSON.stringify(modelOptions) !== JSON.stringify(agent.definition.modelOptions))
    definition.modelOptions = modelOptions;
  const directory = after.directory.trim() || null;
  if (directory !== (before.directory.trim() || null)) definition.directory = directory;
  if (after.isolated !== before.isolated)
    definition.isolation = after.isolated ? 'isolated' : 'shared';
  if (after.autoApprove !== before.autoApprove) definition.autoApprove = after.autoApprove;
  if (after.instructions !== before.instructions) definition.instructions = after.instructions;
  return {
    definition,
    ...(after.machineId !== null && after.machineId !== before.machineId
      ? { machineId: after.machineId }
      : {}),
  };
}
