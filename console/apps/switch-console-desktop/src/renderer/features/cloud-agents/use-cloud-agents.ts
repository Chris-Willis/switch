import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { rpc } from '@renderer/lib/ipc';

/**
 * The server's cloud agents and their workers' sessions, asked of each worker
 * over the relay. Not asked while signed out: the sidebar already says to sign in.
 *
 * `null` means the server has no cloud agents. It is not asked again until its
 * session or declared version changes, which is when it may have gained them.
 */
export function useCloudAgents(serverId: string | null) {
  const signedOut = switchRoomsStore.serversNotSignedIn.some((server) => server.id === serverId);
  const user = serverId === null ? null : (switchServersStore.statusFor(serverId)?.user ?? null);
  return useQuery({
    queryKey: ['cloud-agents', serverId, user?.id ?? null, user?.server?.version ?? null],
    queryFn: () => rpc.sdkHost.cloudAgents(serverId!),
    enabled: serverId !== null && !signedOut,
    refetchInterval: (query) => (query.state.data === null ? false : 5000),
    retry: false,
  });
}

/** Start a sleeping launch's worker again, then look again. */
export function useCloudWake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentKey: string) => rpc.sdkHost.cloudWake(agentKey),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['cloud-agents'] }),
  });
}
