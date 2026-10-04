import { useQuery } from '@tanstack/react-query';
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
 * Without the agents the server manages. An agent moved to managed from here
 * keeps a row in Console, but the server is what runs it now, so it is shown
 * the way every managed agent is, from the server, rather than twice or as a
 * Console agent with a room watcher that no longer runs here.
 */
export function withoutManaged<T extends { switchAgentId: string | null }>(
  agents: T[],
  managed: ManagedAgentView[] | null | undefined
): T[] {
  if (!managed) return agents;
  const ids = new Set(managed.map((agent) => agent.agentId));
  return agents.filter((agent) => agent.switchAgentId === null || !ids.has(agent.switchAgentId));
}
