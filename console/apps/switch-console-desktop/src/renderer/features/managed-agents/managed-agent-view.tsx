import { useQueryClient } from '@tanstack/react-query';
import { Bot, Play, Square, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import { managedAgentLabel, managedAgentState } from './managed-agent-state';
import { MANAGED_AGENTS_KEY, useManagedAgents } from './use-managed-agents';

type ManagedAgentParams = { serverId: string; agentId: string; name: string };

const ManagedAgentTitlebar = observer(function ManagedAgentTitlebar() {
  const { params } = useParams('managedAgent');
  const { navigate } = useNavigate();
  return (
    <ServerSectionTitlebar
      serverId={params.serverId}
      icon={Bot}
      label="Your Agents"
      item={{ label: params.name }}
      onSectionClick={() => navigate('serverAgents', { serverId: params.serverId })}
    />
  );
});

const ManagedAgentPanel = observer(function ManagedAgentPanel() {
  const { params } = useParams('managedAgent');
  const agents = useManagedAgents(params.serverId);
  const agent = agents.data?.find((listed) => listed.agentId === params.agentId);
  if (agents.error)
    return (
      <ServerPage title={params.name} description="">
        <p role="alert" className="text-sm text-destructive">
          {failureText(agents.error, 'The agent could not be read from its server.')}
        </p>
      </ServerPage>
    );
  if (agents.data === null)
    return (
      <ServerPage title={params.name} description="">
        <p role="alert" className="text-sm text-destructive">
          This server no longer runs managed agents.
        </p>
      </ServerPage>
    );
  if (!agents.data)
    return (
      <ServerPage title={params.name} description="Loading…">
        {null}
      </ServerPage>
    );
  if (!agent)
    return (
      <ServerPage title={params.name} description="">
        <p role="alert" className="text-sm text-destructive">
          This agent is no longer on its Switch server.
        </p>
      </ServerPage>
    );
  return <ManagedAgentDetail agent={agent} />;
});

function ManagedAgentDetail({ agent }: { agent: ManagedAgentView }) {
  const label = managedAgentLabel(agent);
  const state = managedAgentState(agent);
  const queryClient = useQueryClient();
  const { navigate } = useNavigate();
  const confirm = useShowModal('confirmActionModal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (what: string, run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
    } catch (failure) {
      setError(failureText(failure, `${what} failed.`));
    } finally {
      setBusy(false);
    }
  };
  const setDesiredState = (desiredState: 'running' | 'stopped') =>
    act(desiredState === 'running' ? 'Starting it' : 'Stopping it', () =>
      rpc.managedAgents.setDesiredState({
        serverId: agent.serverId,
        agentId: agent.agentId,
        desiredState,
      })
    );
  const remove = () =>
    confirm({
      title: `Delete ${label}?`,
      description: `Its machine stops it and it is deleted from Switch, for every room it is in.`,
      confirmLabel: 'Delete',
      onSuccess: () =>
        void act('Deleting it', async () => {
          await rpc.managedAgents.remove({ serverId: agent.serverId, agentId: agent.agentId });
          navigate('serverAgents', { serverId: agent.serverId });
        }),
    });

  const definition = agent.definition;
  const options = Object.entries(definition.modelOptions);
  const machine = agent.machine
    ? `${agent.machine.name}${agent.machine.state === 'online' ? '' : ` (${agent.machine.state})`}`
    : 'None';

  return (
    <ServerPage
      title={label}
      description={agent.description}
      action={
        <div className="flex items-center gap-2">
          {agent.desiredState === 'running' ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void setDesiredState('stopped')}
            >
              <Square className="size-4" />
              Stop
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void setDesiredState('running')}
            >
              <Play className="size-4" />
              Start
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={remove}>
            <Trash2 className="size-4" />
            Delete
          </Button>
        </div>
      }
    >
      <div className="flex items-center gap-4">
        <AgentAvatar name={label} iconUrl={agent.iconUrl} size={56} />
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{agent.name}</div>
          <div
            className={`text-sm ${state.tone === 'problem' ? 'text-destructive' : 'text-foreground-muted'}`}
          >
            {state.label}
            {state.detail ? ` — ${state.detail}` : ''}
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <Field label="Provider">
          {providerDisplayName(definition.provider) ?? definition.provider}
        </Field>
        <Field label="Model">{definition.model ?? 'Provider default'}</Field>
        {options.length > 0 && (
          <Field label="Model options">
            {options.map(([key, value]) => `${key}: ${value}`).join(', ')}
          </Field>
        )}
        <Field label="Machine">{machine}</Field>
        <Field label="Directory">{definition.directory ?? 'Chosen by the machine'}</Field>
        <Field label="Runs">
          {definition.isolation === 'isolated'
            ? 'In a process of its own'
            : 'In its machine’s controller'}
        </Field>
        <Field label="Tool calls">
          {definition.autoApprove ? 'Approved automatically' : 'Asked for approval'}
        </Field>
        <Field label="Instructions">
          {definition.instructions ? (
            <pre className="font-sans whitespace-pre-wrap">{definition.instructions}</pre>
          ) : (
            'None'
          )}
        </Field>
      </dl>
    </ServerPage>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-foreground-muted">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
}

export const managedAgentView = {
  WrapView: ({ children }: ManagedAgentParams & { children: ReactNode }) => <>{children}</>,
  TitlebarSlot: ManagedAgentTitlebar,
  MainPanel: ManagedAgentPanel,
  canActivate: (params: unknown): GuardResult => {
    const value = (params ?? {}) as Partial<Record<keyof ManagedAgentParams, unknown>>;
    if (
      typeof value.serverId !== 'string' ||
      typeof value.agentId !== 'string' ||
      typeof value.name !== 'string'
    )
      return { ok: false, redirect: 'home', discardParams: true };
    return { ok: true };
  },
} satisfies ViewDefinition<ManagedAgentParams>;
