import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { errorMessage, type Logger } from './log';

/**
 * The controller's local relay: what each managed agent's agent host uses as
 * `SWITCH_API_ENDPOINT` for its calls to Switch, on a loopback port, with a
 * token minted here for each agent.
 *
 * Each agent host runs in the controller's process and hears its events from the
 * controller stream (`AgentHub`), so the relay serves no event stream and no
 * connection bookkeeping. Every call is forwarded to Switch with the
 * controller's access token, the agent named in `X-Switch-Agent-Id`, and the
 * calling session's room in `X-Switch-Room-Id`.
 */

/** Every token the relay mints starts with this, which tells it apart from a Switch credential. */
export const RELAY_TOKEN_PREFIX = 'swlr_';

/** Where a call goes. */
export interface Forwarder {
  forward(
    req: IncomingMessage,
    res: ServerResponse,
    target: { agentId: string; roomId: string | null; path: string }
  ): Promise<void>;
}

export type RelayDeps = {
  log: Logger;
  forwarder: Forwarder;
  /** The room a call for the agent is made in, from the calling session, or null. */
  roomFor: (agentId: string, sessionId: string | null) => string | null;
};

class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown
  ) {
    super(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function header(req: Pick<IncomingMessage, 'headers'>, name: string): string | null {
  const value = req.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return text ? text : null;
}

/** The agent's own connection, which Switch holds through the controller stream instead. */
const CONNECTION_ROUTE = /^\/agents\/[^/]+\/(events|connection\/[^/]+)$/;
/** The prefixes forwarded to Switch. Anything else, the management routes above all, stays here. */
const FORWARDED = /^\/(agents\/[^/]+\/.+|agent-sessions\/.+|sessions\/.+|version|health)$/;
/** `/agents/<segment>/...` routes whose segment is not an agent. */
const AGENTLESS_SEGMENTS = new Set(['rooms', 'feature-flags']);

export class LocalRelay {
  private server: Server | null = null;
  private port = 0;
  private readonly sockets = new Set<Socket>();
  private readonly tokens = new Map<string, string>();
  private readonly tokenOf = new Map<string, string>();
  private ready = false;

  constructor(private readonly deps: RelayDeps) {}

  /** Listens on 127.0.0.1: on `preferredPort` when it is free, so running agent hosts find it again. */
  async start(preferredPort: number | null): Promise<number> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.deps.log.error('The relay failed a request', {
          path: req.url,
          error: errorMessage(error),
        });
        if (!res.headersSent) this.send(res, 500, { detail: errorMessage(error) });
        else res.destroy();
      });
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    try {
      await listen(preferredPort ?? 0);
    } catch (error) {
      if (preferredPort === null || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE')
        throw error;
      this.deps.log.warn(
        'The relay port the agents were given is taken; using a new one. Running agents are restarted to pick it up.',
        { port: preferredPort }
      );
      await listen(0);
    }
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  get endpoint(): string {
    if (!this.server) throw new Error('The relay is not listening.');
    return `http://127.0.0.1:${this.port}`;
  }

  /** Stops serving. */
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Unknown tokens are told to retry (503) until this is called: right after
   * a restart an agent host can reach the relay before the controller has read
   * back its token, and a 401 would stop it for good.
   */
  setReady(): void {
    this.ready = true;
  }

  // -- Agents and tokens ------------------------------------------------------

  /** Accepts `token` for the agent, replacing any token it had. */
  register(agentId: string, token: string): void {
    const previous = this.tokenOf.get(agentId);
    if (previous) this.tokens.delete(previous);
    const hash = hashToken(token);
    this.tokens.set(hash, agentId);
    this.tokenOf.set(agentId, hash);
  }

  /** A new token for the agent, replacing any it had. */
  mint(agentId: string): string {
    const token = `${RELAY_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.register(agentId, token);
    return token;
  }

  isRegistered(agentId: string, token: string): boolean {
    return this.tokenOf.get(agentId) === hashToken(token);
  }

  /** Forgets the agent: its token stops working. */
  unregister(agentId: string): void {
    const hash = this.tokenOf.get(agentId);
    if (hash) this.tokens.delete(hash);
    this.tokenOf.delete(agentId);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? '';
    if (!raw.startsWith('/') || raw.startsWith('//'))
      return this.send(res, 400, { detail: 'The relay serves origin-form paths only.' });
    const url = new URL(raw, 'http://relay.invalid');
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const agentId = token ? this.tokens.get(hashToken(token)) : undefined;
    if (!agentId) {
      if (!this.ready)
        return this.send(res, 503, {
          detail: 'The agents controller is starting; retry in a moment.',
        });
      return this.send(res, 401, {
        detail:
          'This token is not one the agents controller issued, or its agent is no longer assigned to this machine.',
      });
    }
    try {
      if (CONNECTION_ROUTE.test(url.pathname))
        throw new HttpRefusal(
          404,
          `The agents controller holds this agent's connection to Switch itself; it does not serve ${url.pathname}.`
        );
      this.checkForwardable(url, raw, agentId);
      await this.deps.forwarder.forward(req, res, {
        agentId,
        roomId: this.deps.roomFor(agentId, header(req, 'x-switch-session-id')),
        path: `${url.pathname}${url.search}`,
      });
    } catch (error) {
      if (!(error instanceof HttpRefusal)) throw error;
      this.send(res, error.status, { detail: error.detail });
    }
  }

  private checkForwardable(url: URL, raw: string, agentId: string): void {
    const rawPath = raw.split('?')[0]!;
    if (/%2f|%5c/i.test(rawPath) || !FORWARDED.test(url.pathname))
      throw new HttpRefusal(404, `The agents controller does not relay ${url.pathname}.`);
    const segment = /^\/agents\/([^/]+)\//.exec(url.pathname)?.[1];
    if (segment === undefined) return;
    const named = decodeURIComponent(segment);
    if (named !== agentId && !AGENTLESS_SEGMENTS.has(named))
      throw new HttpRefusal(403, `authenticated as agent ${agentId}, not ${named}`);
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }
}
