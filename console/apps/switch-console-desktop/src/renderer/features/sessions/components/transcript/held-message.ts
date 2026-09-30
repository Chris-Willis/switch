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

const REFUSALS = {
  machine_stopped: 'The owner stopped the cloud machine. Start it in Your Agents, then send again.',
  machine_error: 'The cloud machine is in error. Retry it in Your Agents, then send again.',
  agent_stopped: 'This agent is stopped. Start it in Your Agents, then send again.',
  agent_crashed: 'This agent crashed. Retry it in Your Agents, then send again.',
};

/** What to tell the user about a refusal they have to act on before sending again. */
export function relayRefusal(code: keyof typeof REFUSALS): string {
  return REFUSALS[code];
}

/** What to tell the user when Switch will not relay a message until they act. */
export function relayRefusalText(error: unknown): string | null {
  const code = relayCode(error);
  return code !== undefined && Object.hasOwn(REFUSALS, code)
    ? REFUSALS[code as keyof typeof REFUSALS]
    : null;
}

/** What the composer says while it holds a message, by where the machine is. */
export function heldStatusText(machineAwake: boolean): string {
  return machineAwake
    ? 'The machine is awake. Connecting to the session, then your message is sent.'
    : 'Waking… about 1–2 min. Keep Switch Console open until the machine is awake.';
}

const heldBySession = new Map<string, HeldMessage>();

/**
 * Held messages by session, so one outlives its composer: leaving a session
 * while its machine wakes keeps the message, and it is held again on return.
 */
export const heldMessages = {
  get: (sessionId: string): HeldMessage | null => heldBySession.get(sessionId) ?? null,
  set(sessionId: string, held: HeldMessage | null): void {
    if (held) heldBySession.set(sessionId, held);
    else heldBySession.delete(sessionId);
  },
};

/**
 * Deliver a held message once. A command the client still holds is reconciled,
 * so a host that already recorded it is not sent it a second time.
 */
export function deliverHeld(client: SessionChatClient, held: HeldMessage): Promise<CommandStatus> {
  return client.hasPendingCommand()
    ? client.reconcile()
    : client.send(held.text, held.commandId, held.attachments);
}
