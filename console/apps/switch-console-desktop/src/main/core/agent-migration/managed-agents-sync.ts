import { randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import { agentEvents } from '@main/core/agents/agent-events';
import { createAgent } from '@main/core/agents/createAgent';
import { getAgents } from '@main/core/agents/getAgents';
import {
  embeddedControllerDataDir,
  embeddedControllerService,
} from '@main/core/embedded-controller/embedded-controllers';
import { hostControllerService } from '@main/core/host-controllers/host-controllers';
import { ensureLocation } from '@main/core/locations/store';
import { fetchManagedAgents } from '@main/core/switch-servers/gateway-client';
import { getServer, listServers } from '@main/core/switch-servers/servers-store';
import { withReachableWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { log } from '@main/lib/logger';
import { isValidProviderId } from '@shared/core/providers/agent-provider-registry';
import { basenameFromAnyPath } from '@shared/path-name';
import { ManagedAgentAdoption, type OwnMachine } from './managed-agent-adoption';
import { deleteManagedAgentRecord, setManagedAgentRecord } from './managed-agents-store';

async function ownMachines(): Promise<OwnMachine[]> {
  const machines: OwnMachine[] = [];
  for (const server of await listServers()) {
    const overview = await embeddedControllerService.overview(server.id, null);
    const enrollment = overview.enrollment;
    if (!enrollment || overview.phase.kind === 'removed') continue;
    const dataDir = embeddedControllerDataDir(server.id);
    machines.push({
      serverId: server.id,
      workspaceId: enrollment.workspaceId,
      controllerId: enrollment.controllerId,
      placement: { kind: 'this-computer', serverId: server.id },
      sshHost: null,
      workspaceRoot: (name) => join(dataDir, 'workspaces', name),
      hostRoot: (switchAgentId) => join(dataDir, 'watchers', switchAgentId),
    });
  }
  for (const record of await hostControllerService.enrolled())
    machines.push({
      serverId: record.serverId,
      workspaceId: record.workspaceId,
      controllerId: record.controllerId,
      placement: { kind: 'ssh-host', sshHost: record.sshHost, serverId: record.serverId },
      sshHost: record.sshHost,
      // `~/`-relative on the host, which a Console location cannot be.
      workspaceRoot: null,
      hostRoot: (switchAgentId) => posix.join(record.dataDir, 'watchers', switchAgentId),
    });
  return machines;
}

export const managedAgentAdoption = new ManagedAgentAdoption({
  machines: ownMachines,
  managed: (workspaceId) => withReachableWorkspaceSession(workspaceId, fetchManagedAgents),
  knownSwitchAgentIds: async () =>
    new Set(
      (await getAgents())
        .map((agent) => agent.switchAgentId)
        .filter((id): id is string => id !== null)
    ),
  isProvider: isValidProviderId,
  store: { set: setManagedAgentRecord, delete: deleteManagedAgentRecord },
  createRow: async (input) => {
    const server = await getServer(input.serverId);
    if (!server) throw new Error(`No Switch server with id ${input.serverId}`);
    const location = await ensureLocation({
      sshHost: input.sshHost,
      dir: input.dir,
      name: basenameFromAnyPath(input.dir) ?? input.name,
    });
    return createAgent({
      id: input.id,
      locationId: location.id,
      name: input.name,
      providerId: input.providerId,
      switchAgentId: input.switchAgentId,
      apiEndpoint: server.apiUrl,
      workspaceId: input.workspaceId,
      autoApprove: input.autoApprove,
      providerConfig: null,
    });
  },
  announce: async (agent) => {
    agentEvents._emit('agent:created', agent, 'unknown');
  },
  newId: randomUUID,
  now: Date.now,
  log: {
    info: (message, fields) => log.info(message, { event: 'managed_agent_adoption', ...fields }),
    warn: (message, fields) => log.warn(message, { event: 'managed_agent_adoption', ...fields }),
    error: (message, fields) => log.error(message, { event: 'managed_agent_adoption', ...fields }),
  },
});

/** How often the Console looks for managed agents created elsewhere on its machines. */
export const MANAGED_AGENT_SYNC_MS = 15_000;
