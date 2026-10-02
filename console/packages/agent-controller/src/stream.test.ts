import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControllerApiError } from './api';
import { silentLogger } from './log';
import { type NudgeEvent, nudgeStream, parseSse, type SseItem } from './stream';

function streamOf(chunks: string[], keepOpen = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!keepOpen) controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseItem[]> {
  const items: SseItem[] = [];
  for await (const item of parseSse(body)) items.push(item);
  return items;
}

describe('parseSse', () => {
  it('reads events, comments and multi-line data', async () => {
    expect(
      await collect(
        streamOf([': keepalive\n\n', 'event: a\ndata: {"x":1}\n\n', 'data: line1\ndata: line2\n\n'])
      )
    ).toEqual([
      { kind: 'comment', text: 'keepalive' },
      { kind: 'event', event: 'a', data: '{"x":1}', id: null },
      { kind: 'event', event: 'message', data: 'line1\nline2', id: null },
    ]);
  });

  it('handles CRLF, fields without a space, and frames split across chunks', async () => {
    expect(
      await collect(streamOf(['event:b\r', '\ndata:{"y"', ':2}\r\nid: 7\r\n', '\r\n']))
    ).toEqual([{ kind: 'event', event: 'b', data: '{"y":2}', id: '7' }]);
  });

  it('drops a trailing frame the stream never finished', async () => {
    expect(await collect(streamOf(['event: c\ndata: {}\n']))).toEqual([]);
  });
});

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const connected = sse('connection_state', {
  controller_id: 'controller-1',
  assignment_revision: 1,
  report_within_s: 60,
});

function options(open: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal) {
  return {
    open,
    signal,
    log: silentLogger,
    idleTimeoutMs: 200,
    initialBackoffMs: 5,
    maxBackoffMs: 20,
    random: () => 0,
  };
}

async function take(stream: AsyncGenerator<NudgeEvent>, count: number): Promise<NudgeEvent[]> {
  const events: NudgeEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (events.length === count) break;
  }
  return events;
}

describe('nudgeStream', () => {
  it('emits typed frames and skips unknown or malformed ones', async () => {
    const stop = new AbortController();
    const body = [
      connected,
      sse('assignment.changed', { revision: 2 }),
      sse('agent.event', { agent_id: 'a' }),
      sse('operation.pending', { operation_id: 'op-1', kind: 'agent.restart' }),
      sse('operation.pending', { operation_id: 'op-2', kind: 'provider.recheck', agent_id: null }),
    ];
    const events = await take(
      nudgeStream(options(async () => new Response(streamOf(body, true)), stop.signal)),
      3
    );
    stop.abort();
    expect(events).toEqual([
      {
        type: 'connected',
        state: { controller_id: 'controller-1', assignment_revision: 1, report_within_s: 60 },
      },
      { type: 'assignment.changed', revision: 2 },
      { type: 'operation.pending', operation_id: 'op-2', kind: 'provider.recheck', agent_id: null },
    ]);
  });

  it('reconnects after the stream ends, and after a failed open', async () => {
    const stop = new AbortController();
    let opens = 0;
    const events = await take(
      nudgeStream(
        options(async () => {
          opens++;
          if (opens === 2) throw new TypeError('fetch failed');
          return new Response(streamOf([connected]));
        }, stop.signal)
      ),
      2
    );
    stop.abort();
    expect(events.map((event) => event.type)).toEqual(['connected', 'connected']);
    expect(opens).toBe(3);
  });

  it('reconnects when nothing arrives within the idle timeout', async () => {
    const stop = new AbortController();
    let opens = 0;
    const started = Date.now();
    const events = await take(
      nudgeStream(
        options(async () => {
          opens++;
          return new Response(streamOf([connected], true));
        }, stop.signal)
      ),
      2
    );
    stop.abort();
    expect(events.map((event) => event.type)).toEqual(['connected', 'connected']);
    expect(opens).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it('ends on credential.revoked, sent as a frame', async () => {
    const stop = new AbortController();
    const events: NudgeEvent[] = [];
    for await (const event of nudgeStream(
      options(
        async () => new Response(streamOf([connected, sse('credential.revoked', {})], true)),
        stop.signal
      )
    ))
      events.push(event);
    expect(events.map((event) => event.type)).toEqual(['connected', 'credential.revoked']);
  });

  it('ends on credential.revoked, when the server refuses to open the stream', async () => {
    const stop = new AbortController();
    const events: NudgeEvent[] = [];
    for await (const event of nudgeStream(
      options(async () => {
        throw new ControllerApiError(401, 'controller_revoked', 'revoked', false, null);
      }, stop.signal)
    ))
      events.push(event);
    expect(events).toEqual([{ type: 'credential.revoked' }]);
  });

  it('stops when its signal fires', async () => {
    const stop = new AbortController();
    const iterator = nudgeStream(
      options(async () => new Response(streamOf([connected], true)), stop.signal)
    );
    expect((await iterator.next()).value).toMatchObject({ type: 'connected' });
    const next = iterator.next();
    stop.abort();
    expect(await next).toEqual({ done: true, value: undefined });
  });

  const fixture = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'core',
    'tests',
    'switch_core',
    'fixtures',
    'agent_controllers',
    'stream_frames.json'
  );

  it.skipIf(!existsSync(fixture))('reads every frame in Core’s stream fixture', async () => {
    const frames = JSON.parse(readFileSync(fixture, 'utf8')) as { event: string; data: unknown }[];
    const stop = new AbortController();
    const events: NudgeEvent[] = [];
    for await (const event of nudgeStream(
      options(
        async () =>
          new Response(
            streamOf(
              frames.map((frame) => sse(frame.event, frame.data)),
              true
            )
          ),
        stop.signal
      )
    ))
      events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      'connected',
      'assignment.changed',
      'operation.pending',
      'credential.revoked',
    ]);
  });
});
