import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AddressingPolicyRow } from '@renderer/features/locations/components/settings-view/sections/addressing-policy-settings-section';
import { CanManageAgentsRow } from '@renderer/features/locations/components/settings-view/sections/can-manage-agents-settings-section';
import { AgentIconPicker } from '@renderer/lib/components/agent-icon-picker';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Switch } from '@renderer/lib/ui/switch';
import { Textarea } from '@renderer/lib/ui/textarea';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import { changesOf, type Draft, draftOf, MODEL_OPTION } from './managed-agent-changes';
import { MANAGED_AGENTS_KEY } from './use-managed-agents';

/** The providers a managed agent can run, as Switch's definition names them. */
const PROVIDERS = ['claude', 'codex', 'opencode', 'antigravity', 'cursor'] as const;

const DEFAULT = '__default__';

/**
 * A managed agent's settings, read from its server and saved back to it. The
 * server checks the result against the agent's machine and refuses it whole,
 * so a save either lands entirely or changes nothing.
 */
export function ManagedAgentSettings({ agent }: { agent: ManagedAgentView }) {
  const queryClient = useQueryClient();
  const [base, setBase] = useState(() => draftOf(agent));
  const [draft, setDraft] = useState(base);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const machines = useQuery({
    queryKey: [MANAGED_AGENTS_KEY, agent.serverId, 'machines'],
    queryFn: () => rpc.managedAgents.machines(agent.serverId),
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const option = MODEL_OPTION[draft.provider];

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const changes = changesOf(agent, base, draft);
      if (Object.keys(changes.definition).length > 0 || changes.machineId !== undefined)
        await rpc.managedAgents.update({
          serverId: agent.serverId,
          agentId: agent.agentId,
          changes,
        });
      const displayName = draft.displayName.trim() || null;
      if (displayName !== (base.displayName.trim() || null))
        await rpc.workspaces.updateAgentDisplayName({
          workspaceId: agent.workspaceId,
          agentId: agent.agentId,
          displayName,
        });
      if (draft.iconUrl !== base.iconUrl)
        await rpc.workspaces.updateAgentIcon({
          workspaceId: agent.workspaceId,
          agentId: agent.agentId,
          iconUrl: draft.iconUrl,
        });
      setBase(draft);
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
      void queryClient.invalidateQueries({ queryKey: ['workspace-agents', agent.workspaceId] });
    } catch (failure) {
      setError(failureText(failure, 'The settings could not be saved. Nothing changed.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FieldGroup>
      <div className="flex items-center gap-4">
        <AgentIconPicker
          serverId={agent.serverId}
          name={agent.name}
          iconUrl={draft.iconUrl}
          onChange={(iconUrl) => set('iconUrl', iconUrl)}
          size={56}
        />
        <Field className="flex-1">
          <FieldLabel>Display name</FieldLabel>
          <Input
            value={draft.displayName}
            placeholder={agent.name}
            onChange={(e) => set('displayName', e.target.value)}
          />
        </Field>
      </div>

      <Field>
        <FieldLabel>Machine</FieldLabel>
        <Select value={draft.machineId ?? ''} onValueChange={(id) => set('machineId', String(id))}>
          <SelectTrigger className="w-full">
            <SelectValue>
              {machines.data?.find((m) => m.id === draft.machineId)?.name ??
                agent.machine?.name ??
                'None'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(machines.data ?? []).map((machine) => (
              <SelectItem key={machine.id} value={machine.id}>
                {machine.name}
                {machine.state === 'online' ? '' : ` (${machine.state})`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {machines.error && (
          <FieldDescription className="text-destructive">
            {failureText(machines.error, 'Your machines could not be listed.')}
          </FieldDescription>
        )}
      </Field>

      <Field>
        <FieldLabel>Directory</FieldLabel>
        <Input
          value={draft.directory}
          placeholder="Chosen by the machine"
          onChange={(e) => set('directory', e.target.value)}
        />
        <FieldDescription>The working directory, absolute on its machine.</FieldDescription>
      </Field>

      <Field>
        <FieldLabel>Provider</FieldLabel>
        <Select
          value={draft.provider}
          onValueChange={(next) =>
            setDraft((current) => ({ ...current, provider: String(next), option: '' }))
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue>{providerDisplayName(draft.provider) ?? draft.provider}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((provider) => (
              <SelectItem key={provider} value={provider}>
                {providerDisplayName(provider) ?? provider}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel>Model</FieldLabel>
        <Input
          value={draft.model}
          placeholder="The provider’s default"
          onChange={(e) => set('model', e.target.value)}
        />
      </Field>

      {option && (
        <Field>
          <FieldLabel>{option.label}</FieldLabel>
          {option.choices ? (
            <Select
              value={draft.option || DEFAULT}
              disabled={!draft.model.trim()}
              onValueChange={(next) => set('option', next === DEFAULT ? '' : String(next))}
            >
              <SelectTrigger className="w-full">
                <SelectValue>{draft.option || 'The model’s default'}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>The model’s default</SelectItem>
                {option.choices.map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {choice}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={draft.option}
              disabled={!draft.model.trim()}
              placeholder="The model’s default"
              onChange={(e) => set('option', e.target.value)}
            />
          )}
          {!draft.model.trim() && (
            <FieldDescription>Name a model to set this; it applies to that model.</FieldDescription>
          )}
        </Field>
      )}

      <Toggle
        label="Bypass permissions"
        description="Run its sessions without permission prompts."
        checked={draft.autoApprove}
        onChange={(checked) => set('autoApprove', checked)}
      />
      <Toggle
        label="Run in its own process"
        description="Isolated from the other agents on its machine, instead of inside the machine’s controller."
        checked={draft.isolated}
        onChange={(checked) => set('isolated', checked)}
      />

      <Field>
        <FieldLabel>System prompt</FieldLabel>
        <Textarea
          rows={6}
          value={draft.instructions}
          placeholder="None"
          onChange={(e) => set('instructions', e.target.value)}
        />
      </Field>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(base);
            setError(null);
          }}
        >
          Discard
        </Button>
      </div>

      <AddressingPolicyRow
        workspaceId={agent.workspaceId}
        serverId={agent.serverId}
        agentId={agent.agentId}
        agentName={agent.name}
        showName={false}
      />
      <CanManageAgentsRow
        workspaceId={agent.workspaceId}
        agentId={agent.agentId}
        agentName={null}
      />
    </FieldGroup>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel>{label}</FieldLabel>
        <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
      </div>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}
