import { useQuery } from '@tanstack/react-query';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { rpc } from '@renderer/lib/ipc';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

export const MANAGED_AGENTS_KEY = 'managed-agents';

/**
 * The signed-in user's managed agents on the server, as the server holds them,
 * whatever machine each runs on. `null` means the server runs no agent
 * management.
 */
export function useManagedAgents(serverId: string | null) {
  const signedIn = serverId !== null && switchServersStore.isConnected(serverId);
  const user = serverId === null ? null : (switchServersStore.statusFor(serverId)?.user ?? null);
  return useQuery({
    queryKey: [MANAGED_AGENTS_KEY, serverId, user?.id ?? null],
    queryFn: () => rpc.managedAgents.list(serverId!),
    enabled: signedIn,
    refetchInterval: (query) => (query.state.data === null ? false : 5000),
    retry: false,
  });
}

/**
 * The managed agents Console has no row for. An agent moved to managed from
 * here keeps its row, which already shows it, so it is not listed twice.
 */
export function withoutLocalRows(serverId: string, agents: ManagedAgentView[]): ManagedAgentView[] {
  const local = new Set(agentsStore.agentsOnServer(serverId).map((agent) => agent.switchAgentId));
  return agents.filter((agent) => !local.has(agent.agentId));
}
