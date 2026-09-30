import type {
  Attachment,
  CommandStatus,
  SessionChatClient,
} from '@switch-console/shared/session-v1';
import { RpcError } from '@shared/lib/ipc/rpc-error';

/** A message the composer keeps while the cloud machine it goes to wakes up. */
export type HeldMessage = { commandId: string; text: string; attachments: Attachment[] };

function relayCode(error: unknown): string | undefined {
  return error instanceof RpcError && error.code === 'CloudRelayError'
    ? error.stringField('relayCode')
    : undefined;
}

/** Switch refused the message before it reached the worker, and is starting the machine. */
export function isWakingError(error: unknown): boolean {
  return relayCode(error) === 'worker_waking';
}

const REFUSALS: Record<string, string> = {
  machine_stopped: 'The owner stopped the cloud machine. Start it in Your Agents, then send again.',
  agent_stopped: 'This agent is stopped. Start it in Your Agents, then send again.',
  agent_crashed: 'This agent crashed. Retry it in Your Agents, then send again.',
};

/** What to tell the user when Switch will not relay a message until they act. */
export function relayRefusalText(error: unknown): string | null {
  const code = relayCode(error);
  return code === undefined ? null : (REFUSALS[code] ?? null);
}

/**
 * Deliver a held message once. A command the client still holds is reconciled,
 * so a host that already recorded it is not sent it a second time.
 */
export function deliverHeld(client: SessionChatClient, held: HeldMessage): Promise<CommandStatus> {
  return client.hasPendingCommand()
    ? client.reconcile()
    : client.send(held.text, held.commandId, held.attachments);
}
