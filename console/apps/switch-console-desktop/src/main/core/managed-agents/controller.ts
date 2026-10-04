import {
  AgentManagementUnavailableError,
  deleteAgent,
  deleteManagedAgent,
  fetchManagedAgents,
  fetchManagementControllers,
  setManagedAgentDesiredState,
} from '@main/core/switch-servers/gateway-client';
import { withReachableServerWorkspaceSession } from '@main/core/workspaces/workspace-session';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { createRPCController } from '@shared/lib/ipc/rpc';

/**
 * The signed-in user's managed agents on a server, as the server holds them:
 * every one, whatever machine it runs on. Console keeps no copy.
 */
export const managedAgentsController = createRPCController({
  /** Null when the server does not run agent management. */
  list: (serverId: string): Promise<ManagedAgentView[] | null> =>
    withReachableServerWorkspaceSession(serverId, async (server) => {
      let agents;
      let controllers;
      try {
        [agents, controllers] = await Promise.all([
          fetchManagedAgents(server),
          fetchManagementControllers(server),
        ]);
      } catch (error) {
        if (error instanceof AgentManagementUnavailableError) return null;
        throw error;
      }
      const machines = new Map(controllers.map((controller) => [controller.id, controller]));
      return agents.map((agent): ManagedAgentView => {
        const machine = agent.controllerId ? machines.get(agent.controllerId) : undefined;
        return {
          serverId,
          agentId: agent.agentId,
          name: agent.name,
          displayName: agent.displayName,
          iconUrl: agent.iconUrl,
          description: agent.description,
          machine: machine
            ? { id: machine.id, name: machine.name, kind: machine.kind, state: machine.state }
            : null,
          desiredState: agent.desiredState,
          revision: agent.revision,
          definition: {
            provider: agent.provider,
            model: agent.model,
            modelOptions: agent.modelOptions,
            instructions: agent.instructions,
            autoApprove: agent.autoApprove,
            directory: agent.directory,
            isolation: agent.isolation,
          },
          status: agent.status,
        };
      });
    }),

  /** Starts or stops it on its machine. */
  setDesiredState: (params: {
    serverId: string;
    agentId: string;
    desiredState: 'running' | 'stopped';
  }): Promise<void> =>
    withReachableServerWorkspaceSession(params.serverId, (server) =>
      setManagedAgentDesiredState(server, params.agentId, params.desiredState)
    ),

  /** Deletes the agent: its machine stops it, and it is gone from Switch. */
  remove: (params: { serverId: string; agentId: string }): Promise<void> =>
    withReachableServerWorkspaceSession(params.serverId, async (server) => {
      await deleteManagedAgent(server, params.agentId);
      await deleteAgent(server, params.agentId);
    }),
});
