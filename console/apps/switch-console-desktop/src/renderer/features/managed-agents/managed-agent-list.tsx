import { CirclePause, Loader2, Server, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { isValidProviderId } from '@shared/core/providers/agent-provider-registry';
import { SidebarAgentRow } from '../sidebar/agent-row';
import { managedAgentLabel, managedAgentState } from './managed-agent-state';
import { useManagedAgents } from './use-managed-agents';

/**
 * The active server's managed agents: every one the server lists, whatever
 * machine it runs on and wherever it was created, in the same rows as the
 * agents this Console runs.
 */
export const ManagedAgentList = observer(function ManagedAgentList() {
  const serverId = switchServersStore.activeServerId;
  const agents = useManagedAgents(serverId);
  if (serverId === null) return null;
  if (agents.error)
    return (
      <div role="alert" className="px-3 py-2 text-xs text-foreground-destructive">
        {failureText(agents.error, 'Managed agents could not be listed.')}
      </div>
    );
  if (!agents.data?.length) return null;
  return (
    <div className="flex flex-col gap-[2px]" aria-label="Managed agents">
      {agents.data.map((agent) => (
        <ManagedAgentRow key={agent.agentId} agent={agent} />
      ))}
    </div>
  );
});

const ManagedAgentRow = observer(function ManagedAgentRow({ agent }: { agent: ManagedAgentView }) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('managedAgent');
  const label = managedAgentLabel(agent);
  const provider = agent.definition.provider;
  return (
    <SidebarAgentRow
      label={label}
      iconUrl={agent.iconUrl}
      providerId={isValidProviderId(provider) ? provider : null}
      isActive={currentView === 'managedAgent' && params.agentId === agent.agentId}
      depth={0}
      onOpen={() =>
        navigate('managedAgent', { serverId: agent.serverId, agentId: agent.agentId, name: label })
      }
      marks={
        <Tooltip>
          <TooltipTrigger>
            <Server className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
          </TooltipTrigger>
          <TooltipContent>
            Managed · runs on {agent.machine?.name ?? 'no machine'}
            {agent.definition.directory ? ` · ${agent.definition.directory}` : ''}
          </TooltipContent>
        </Tooltip>
      }
      status={<ManagedAgentStateIndicator agent={agent} />}
      actions={null}
    />
  );
});

/** Nothing while the agent runs; otherwise what it is doing, and why on hover. */
function ManagedAgentStateIndicator({ agent }: { agent: ManagedAgentView }) {
  const state = managedAgentState(agent);
  if (state.tone === 'ok') return null;
  const Icon =
    state.tone === 'busy' ? Loader2 : state.tone === 'idle' ? CirclePause : TriangleAlert;
  return (
    <Tooltip>
      <TooltipTrigger>
        <Icon
          aria-label={state.label}
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            state.tone === 'problem' ? 'text-foreground-destructive' : 'text-foreground-muted',
            state.tone === 'busy' && 'animate-spin'
          )}
        />
      </TooltipTrigger>
      <TooltipContent>
        {state.label}
        {state.detail ? `: ${state.detail}` : ''}
      </TooltipContent>
    </Tooltip>
  );
}
