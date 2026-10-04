import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Server } from 'lucide-react';
import { useState } from 'react';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Switch } from '@renderer/lib/ui/switch';
import type { NewAgentMachine } from '@shared/core/agent-migration/agent-migration';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { newAgentMachineNotice } from './managed-run-location';

/** Under the run location: whether the new agent runs managed there, and turning the machine on when it cannot yet. */
export function ManagedRunLocationNotice({
  machine,
  label,
  sshHost,
  serverId,
  workspaceId,
  onEnabled,
}: {
  machine: NewAgentMachine;
  label: string;
  sshHost: string | null;
  serverId: string;
  workspaceId: string;
  onEnabled: () => void;
}) {
  const [enabling, setEnabling] = useState(false);
  const notice = newAgentMachineNotice(machine, { label, sshHost });

  if (notice.kind !== 'blocked')
    return (
      <p className="flex items-start gap-1.5 text-xs text-foreground-muted">
        {notice.kind === 'managed' && <Server className="mt-0.5 size-3.5 shrink-0" />}
        <span>{notice.text}</span>
      </p>
    );

  const enable = async () => {
    setEnabling(true);
    try {
      if (sshHost) await rpc.hostControllers.enable({ sshHost, serverId, workspaceId });
      else await rpc.embeddedController.enable({ serverId, workspaceId });
      onEnabled();
    } catch (error) {
      const { headline, detail } = describeFailure(
        error,
        sshHost ? `Could not make ${label} a machine.` : 'Could not turn on managed agents here.'
      );
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <span>{notice.text}</span>
        {notice.enable && (
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            disabled={enabling}
            onClick={() => void enable()}
          >
            {enabling ? 'Turning on…' : notice.enable.label}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The one provider setting a managed agent carries besides its instructions.
 * Suggestions come from the machine's own provider CLI, as in the Console-run
 * form; anything typed is passed as it is.
 */
export function ManagedModelField({
  providerId,
  sshHost,
  dir,
  value,
  onChange,
}: {
  providerId: AgentProviderId;
  sshHost: string | null;
  dir: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { data: catalogue } = useQuery({
    queryKey: ['agent-model-catalogue', providerId, sshHost ?? 'local', dir],
    queryFn: () => rpc.agents.modelCatalogue({ providerId, sshHost, dir }),
    enabled: !!dir.trim(),
    staleTime: 60000,
  });
  const listId = `managed-model-${providerId}`;
  return (
    <Field>
      <FieldLabel>Model</FieldLabel>
      <Input
        value={value}
        list={listId}
        placeholder="The provider’s default"
        onChange={(e) => onChange(e.target.value)}
      />
      {catalogue?.kind === 'available' && (
        <datalist id={listId}>
          {catalogue.models.map((model) => (
            <option key={model.id} value={model.id} />
          ))}
        </datalist>
      )}
      <FieldDescription>
        Set its reasoning effort and other provider settings on the agent’s page once it is created.
      </FieldDescription>
    </Field>
  );
}

/** Whether the new agent may create agents on the owner's machines, set as it is created. */
export function CanManageAgentsField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel>Can manage agents</FieldLabel>
        <Switch aria-label="Can manage agents" checked={checked} onCheckedChange={onChange} />
      </div>
      <FieldDescription>
        The agent can see your machines and managed agents, and create agents that run on your
        machines and belong to you. Agents it creates do not get this permission.
      </FieldDescription>
    </Field>
  );
}
