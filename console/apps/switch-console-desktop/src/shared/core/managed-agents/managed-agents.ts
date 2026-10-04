/**
 * An agent whose configuration lives on its Switch server: what it is, the
 * machine it runs on, and how it is doing there. The server is the source of
 * truth; Console keeps no copy.
 */
export type ManagedAgentView = {
  serverId: string;
  /** The workspace it is registered in, for its server-held settings such as who can address it. */
  workspaceId: string;
  /** The Switch agent id. */
  agentId: string;
  name: string;
  displayName: string | null;
  iconUrl: string | null;
  description: string;
  /** The machine it is placed on, or null when it is placed on none. */
  machine: ManagedMachine | null;
  desiredState: 'running' | 'stopped';
  revision: number;
  definition: {
    provider: string;
    model: string | null;
    /** The provider's options for the model (`effort`, `variant`). */
    modelOptions: Record<string, string>;
    instructions: string;
    autoApprove: boolean;
    /** The working directory on its machine; null for a workspace the machine chooses. */
    directory: string | null;
    isolation: 'shared' | 'isolated';
  };
  /** What its machine last reported for it, or null before it has. */
  status: {
    process: string;
    attached: boolean;
    reason: string | null;
    detail: string | null;
  } | null;
};

/** A machine a managed agent can be placed on. */
export type ManagedMachine = {
  id: string;
  name: string;
  kind: string;
  state: 'online' | 'unknown' | 'revoked';
};

/** The settings a managed agent's page changes; a field left out stays as the server holds it. */
export type ManagedAgentChanges = {
  definition: Partial<ManagedAgentView['definition']>;
  /** Moves it to another of the owner's machines. */
  machineId?: string;
};
