import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import { isRevoked } from './api';
import { errorMessage, type Logger } from './log';
import {
  assignmentChangedSchema,
  type ConnectionState,
  connectionStateSchema,
  credentialRevokedSchema,
  type OperationPending,
  operationPendingSchema,
} from './schemas';

export type SseItem =
  | { kind: 'comment'; text: string }
  | { kind: 'event'; event: string; data: string; id: string | null };

/**
 * Splits an SSE byte stream into events and comments. Comments are surfaced
 * rather than skipped because the server's `: keepalive` is how a silent but
 * healthy stream is told apart from a dead one.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseItem> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let event = '';
  let id: string | null = null;
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffered.slice(0, newline);
        const width = buffered.startsWith('\r\n', newline) ? 2 : 1;
        // A lone CR at the end of the buffer may be the first half of a CRLF.
        if (width === 1 && buffered[newline] === '\r' && newline === buffered.length - 1) break;
        buffered = buffered.slice(newline + width);
        if (line === '') {
          if (data.length)
            yield { kind: 'event', event: event || 'message', data: data.join('\n'), id };
          event = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) {
          yield { kind: 'comment', text: line.slice(1).trimStart() };
          continue;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') id = value;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export type NudgeEvent =
  | { type: 'connected'; state: ConnectionState }
  | { type: 'assignment.changed'; revision: number }
  | ({ type: 'operation.pending' } & OperationPending)
  | { type: 'credential.revoked' };

export type StreamOptions = {
  open: (signal: AbortSignal) => Promise<Response>;
  signal: AbortSignal;
  log: Logger;
  /** No byte for this long, keepalives included, and the stream is presumed dead. */
  idleTimeoutMs: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  /** Jitter source in [0, 1); injectable for tests. */
  random: () => number;
};

/** The schema for each SSE event type the nudge stream carries, by `event:` name. */
export const STREAM_FRAME_SCHEMAS: Record<string, z.ZodType> = {
  connection_state: connectionStateSchema,
  'assignment.changed': assignmentChangedSchema,
  'operation.pending': operationPendingSchema,
  'credential.revoked': credentialRevokedSchema,
};

class IdleTimeout extends Error {
  constructor(ms: number) {
    super(`No data on the event stream for ${Math.round(ms / 1000)} s.`);
  }
}

/**
 * The controller's nudge stream, reconnected for as long as `signal` lives.
 * Each reconnect starts with a fresh `connection_state`, on which the caller
 * resyncs fully: nothing missed while disconnected is replayed. Backoff grows
 * from `initialBackoffMs` to `maxBackoffMs` and resets once a connection is
 * confirmed. Ends after `credential.revoked`, whether it came as a frame or as
 * the server refusing to open the stream for a revoked controller.
 */
export async function* nudgeStream(options: StreamOptions): AsyncGenerator<NudgeEvent> {
  const { signal, log } = options;
  let backoff = options.initialBackoffMs;
  while (!signal.aborted) {
    const connection = new AbortController();
    const stop = () => connection.abort();
    signal.addEventListener('abort', stop, { once: true });
    let idle: ReturnType<typeof setTimeout> | null = null;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(
        () => connection.abort(new IdleTimeout(options.idleTimeoutMs)),
        options.idleTimeoutMs
      );
    };
    try {
      touch();
      const response = await options.open(connection.signal);
      const body = response.body;
      if (!body) throw new Error('The event stream has no body.');
      const aborted = new Promise<never>((_resolve, reject) => {
        const fail = () => reject(connection.signal.reason ?? new Error('aborted'));
        if (connection.signal.aborted) fail();
        connection.signal.addEventListener('abort', fail, { once: true });
      });
      aborted.catch(() => {});
      const items = parseSse(body);
      for (;;) {
        const next = await Promise.race([items.next(), aborted]);
        if (next.done) break;
        touch();
        const item = next.value;
        if (item.kind === 'comment') continue;
        const schema = STREAM_FRAME_SCHEMAS[item.event];
        if (!schema) {
          log.debug('Ignoring an event type this controller does not know', { event: item.event });
          continue;
        }
        let payload: unknown;
        try {
          payload = schema.parse(JSON.parse(item.data));
        } catch (error) {
          log.error('Dropped an event stream frame that does not match the protocol', {
            event: item.event,
            error: errorMessage(error),
          });
          continue;
        }
        if (item.event === 'connection_state') {
          backoff = options.initialBackoffMs;
          yield { type: 'connected', state: payload as ConnectionState };
        } else if (item.event === 'assignment.changed') {
          yield {
            type: 'assignment.changed',
            revision: (payload as { revision: number }).revision,
          };
        } else if (item.event === 'operation.pending') {
          yield { type: 'operation.pending', ...(payload as OperationPending) };
        } else if (item.event === 'credential.revoked') {
          yield { type: 'credential.revoked' };
          return;
        }
      }
      if (!signal.aborted) log.warn('The event stream ended; reconnecting.');
    } catch (error) {
      if (signal.aborted) return;
      if (isRevoked(error)) {
        yield { type: 'credential.revoked' };
        return;
      }
      const reason =
        connection.signal.reason instanceof IdleTimeout ? connection.signal.reason : error;
      log.warn('The event stream is down; reconnecting.', {
        error: errorMessage(reason),
        retryInMs: backoff,
      });
    } finally {
      if (idle) clearTimeout(idle);
      signal.removeEventListener('abort', stop);
      connection.abort();
    }
    const wait = Math.round(backoff * (0.5 + options.random() * 0.5));
    await delay(wait, undefined, { signal }).catch(() => {});
    backoff = Math.min(backoff * 2, options.maxBackoffMs);
  }
}
