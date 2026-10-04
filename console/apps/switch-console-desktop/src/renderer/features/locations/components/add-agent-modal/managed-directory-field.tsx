import { useQuery } from '@tanstack/react-query';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { LocalDirectorySelector } from './local-directory-selector';

/**
 * Where a managed agent works on its machine. Optional: left empty, the
 * machine makes it a workspace of its own. On this computer the folder is
 * picked with the system dialog and the default is shown, since Console knows
 * where this computer's controller keeps its workspaces; on another machine it
 * is a path typed for that machine.
 */
export function ManagedDirectoryField({
  serverId,
  machine,
  machineLabel,
  agentName,
  value,
  onChange,
}: {
  serverId: string;
  machine: OwnedMachine;
  machineLabel: string;
  agentName: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const thisComputer = machine.local?.kind === 'this-computer';
  const fallback = useQuery({
    queryKey: ['managed-default-workspace', serverId, agentName],
    queryFn: () => rpc.embeddedController.defaultWorkspace({ serverId, name: agentName }),
    enabled: thisComputer && agentName !== '',
  });

  if (!thisComputer)
    return (
      <Field>
        <FieldLabel>Directory</FieldLabel>
        <Input
          value={value}
          placeholder="A fresh workspace"
          onChange={(e) => onChange(e.target.value)}
        />
        <FieldDescription>
          A full path on {machineLabel}. Leave it empty and the machine makes a fresh workspace.
        </FieldDescription>
      </Field>
    );

  const defaultPath = fallback.data ?? null;
  return (
    <Field>
      <FieldLabel>Directory</FieldLabel>
      <LocalDirectorySelector
        title="Choose the agent's working directory"
        message="The agent runs its sessions here."
        path={value}
        onPathChange={onChange}
        placeholder={defaultPath ?? 'A fresh workspace'}
      />
      <FieldDescription>
        {value !== '' ? (
          <>
            The agent works in this folder.{' '}
            <button
              type="button"
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              onClick={() => onChange('')}
            >
              Use the default
            </button>
          </>
        ) : fallback.error ? (
          failureText(fallback.error, 'The default folder could not be worked out.')
        ) : defaultPath ? (
          `By default the agent works in ${defaultPath}.`
        ) : (
          'By default this computer makes the agent a workspace of its own.'
        )}
      </FieldDescription>
    </Field>
  );
}
