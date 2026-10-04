import { observer } from 'mobx-react-lite';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { SidebarMenuButton } from '../sidebar/sidebar-primitives';
import { managedAgentLabel, managedAgentState } from './managed-agent-state';
import { useManagedAgents, withoutLocalRows } from './use-managed-agents';

/**
 * The active server's managed agents that Console has no row for: every one
 * the server lists, whatever machine it runs on and wherever it was created.
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
  const shown = agents.data ? withoutLocalRows(serverId, agents.data) : [];
  if (shown.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-[2px]" aria-label="Managed agents">
      {shown.map((agent) => (
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
  const state = managedAgentState(agent);
  return (
    <SidebarMenuButton
      isActive={currentView === 'managedAgent' && params.agentId === agent.agentId}
      onClick={() =>
        navigate('managedAgent', { serverId: agent.serverId, agentId: agent.agentId, name: label })
      }
    >
      <AgentAvatar name={label} iconUrl={agent.iconUrl} size={14} className="shrink-0" />
      <span className="truncate">{label}</span>
      <span
        className={`ml-auto text-xs ${state.tone === 'problem' ? 'text-foreground-destructive' : 'text-foreground-muted'}`}
      >
        {state.label}
      </span>
    </SidebarMenuButton>
  );
});
