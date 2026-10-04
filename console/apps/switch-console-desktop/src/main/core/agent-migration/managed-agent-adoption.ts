import type { Agent } from '@shared/core/agents/agents';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { MigrationLog } from './agent-migration-service';
import type { ManagedAgentRecord, ManagedPlacementRecord } from './managed-agents-store';

/** A machine this Console runs the controller of: this computer, or an SSH host. */
export type OwnMachine = {
  serverId: string;
  workspaceId: string;
  controllerId: string;
  placement: ManagedPlacementRecord;
  /** The SSH host it is, or null for this computer. */
  sshHost: string | null;
  /** Where its controller puts an agent's workspace when its definition names none; null when not known here. */
  workspaceRoot: ((name: string) => string) | null;
  /** Where its controller keeps an agent's host state. */
  hostRoot: (switchAgentId: string) => string;
};

/** A managed agent as the server lists it. */
export type ServerManagedAgent = {
  agentId: string;
  name: string;
  controllerId: string | null;
  provider: string;
  directory: string | null;
  autoApprove: boolean;
};

export type ManagedAgentAdoptionDeps = {
  /** This Console's machines: this computer and its SSH hosts, per server. */
  machines(): Promise<OwnMachine[]>;
  /** The managed agents of the signed-in user on a server. */
  managed(workspaceId: string): Promise<ServerManagedAgent[]>;
  /** The Switch agents this Console already has a row for. */
  knownSwitchAgentIds(): Promise<Set<string>>;
  isProvider(provider: string): provider is AgentProviderId;
  store: { set(record: ManagedAgentRecord): Promise<void>; delete(agentId: string): Promise<void> };
  /** Adds the agent's row, in a location for `sshHost` and `dir`. */
  createRow(input: {
    id: string;
    serverId: string;
    workspaceId: string;
    sshHost: string | null;
    dir: string;
    name: string;
    providerId: AgentProviderId;
    switchAgentId: string;
    autoApprove: boolean;
  }): Promise<Agent>;
  announce(agent: Agent): Promise<void>;
  newId(): string;
  now(): number;
  log: MigrationLog;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Shows in this Console the managed agents created somewhere else (from the
 * gateway, or by another agent) that run on one of its machines: each gets the
 * row and managed record a managed agent created here gets, so it is listed
 * with the others and its page says where it runs. Nothing is started: the
 * machine's controller already runs it.
 *
 * An agent on a machine this Console does not run the controller of has no
 * folder here, so it is not given a row.
 */
export class ManagedAgentAdoption {
  private running: Promise<number> | null = null;

  constructor(private readonly deps: ManagedAgentAdoptionDeps) {}

  /** One pass; a pass already under way is shared rather than run twice. */
  sync(): Promise<number> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<number> {
    const machines = await this.deps.machines();
    if (!machines.length) return 0;
    const known = await this.deps.knownSwitchAgentIds();
    let adopted = 0;
    const byWorkspace = new Map<string, OwnMachine[]>();
    for (const machine of machines)
      byWorkspace.set(machine.workspaceId, [
        ...(byWorkspace.get(machine.workspaceId) ?? []),
        machine,
      ]);
    for (const [workspaceId, own] of byWorkspace) {
      let listed: ServerManagedAgent[];
      try {
        listed = await this.deps.managed(workspaceId);
      } catch (error) {
        this.deps.log.warn('Could not list the managed agents to show them here', {
          workspaceId,
          error: message(error),
        });
        continue;
      }
      for (const agent of listed) {
        if (known.has(agent.agentId)) continue;
        const machine = own.find((candidate) => candidate.controllerId === agent.controllerId);
        if (!machine) continue;
        if (await this.adopt(agent, machine)) {
          known.add(agent.agentId);
          adopted += 1;
        }
      }
    }
    return adopted;
  }

  private async adopt(agent: ServerManagedAgent, machine: OwnMachine): Promise<boolean> {
    if (!this.deps.isProvider(agent.provider)) {
      this.deps.log.warn('A managed agent runs a provider this Console does not know; not shown', {
        switchAgentId: agent.agentId,
        provider: agent.provider,
      });
      return false;
    }
    const dir = agent.directory ?? machine.workspaceRoot?.(agent.name) ?? null;
    if (dir === null) {
      this.deps.log.warn(
        'A managed agent has no folder this Console can name on its host; not shown',
        {
          switchAgentId: agent.agentId,
          sshHost: machine.sshHost,
        }
      );
      return false;
    }
    const id = this.deps.newId();
    let row: Agent;
    try {
      // The record first, so nothing in Console starts a watcher of its own for it.
      await this.deps.store.set({
        agentId: id,
        workspaceId: machine.workspaceId,
        controllerId: machine.controllerId,
        placement: machine.placement,
        identities: [
          {
            switchAgentId: agent.agentId,
            slug: agent.name,
            subagent: null,
            credentialsStashed: false,
            controllerRoot: machine.hostRoot(agent.agentId),
          },
        ],
        movedAt: new Date(this.deps.now()).toISOString(),
      });
      row = await this.deps.createRow({
        id,
        serverId: machine.serverId,
        workspaceId: machine.workspaceId,
        sshHost: machine.sshHost,
        dir,
        name: agent.name,
        providerId: agent.provider,
        switchAgentId: agent.agentId,
        autoApprove: agent.autoApprove,
      });
    } catch (error) {
      this.deps.log.error('Could not show a managed agent created elsewhere', {
        switchAgentId: agent.agentId,
        error: message(error),
      });
      try {
        await this.deps.store.delete(id);
      } catch (cleanup) {
        this.deps.log.error('Could not forget the record of an agent that was not shown', {
          agentId: id,
          error: message(cleanup),
        });
      }
      return false;
    }
    this.deps.log.info('Showing a managed agent created elsewhere', {
      agentId: id,
      switchAgentId: agent.agentId,
      controllerId: machine.controllerId,
    });
    try {
      await this.deps.announce(row);
    } catch (error) {
      this.deps.log.error(
        'Showed a managed agent created elsewhere, but could not tell the app yet',
        {
          agentId: id,
          error: message(error),
        }
      );
    }
    return true;
  }
}
