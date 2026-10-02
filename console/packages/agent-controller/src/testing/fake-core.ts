import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Assignment, Operation, OperationResult, ReasonCode, StatusReport } from '../schemas';

type Recorded = {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
};

/**
 * A stand-in for the Management routes v1 controllers call, on a loopback
 * port, holding just enough state to answer them. Every value is a
 * placeholder.
 */
export class FakeCore {
  readonly controllerId = 'controller-1';
  credential = 'controller-credential-placeholder';
  enrollmentCode = 'enrollment-code-placeholder';
  tokenLifetimeMs = 60 * 60 * 1000;
  reportWithinS = 60;
  revoked = false;
  assignment: Assignment = { revision: 0, agents: [] };
  readonly requests: Recorded[] = [];
  readonly statusReports: StatusReport[] = [];
  readonly operations = new Map<string, Operation & { state: string }>();
  readonly results = new Map<string, OperationResult>();
  readonly credentialFetches: string[] = [];
  /** Answers the next request to a path with this, once. */
  readonly scripted: { method: string; path: string; status: number; body: unknown }[] = [];
  private readonly tokens = new Set<string>();
  private issued = 0;
  private readonly streams = new Set<ServerResponse>();
  private server: Server | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: { code: 'internal', message: String(error), retryable: true } })
        );
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const stream of this.streams) stream.destroy();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  get tokensIssued(): number {
    return this.issued;
  }

  /** Makes every token issued so far unacceptable, as a server restart with a new secret would. */
  expireTokens(): void {
    this.tokens.clear();
  }

  setAssignment(assignment: Assignment): void {
    this.assignment = assignment;
  }

  get streamCount(): number {
    return this.streams.size;
  }

  push(event: string, data: unknown): void {
    for (const stream of this.streams)
      stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  closeStreams(): void {
    for (const stream of this.streams) stream.end();
    this.streams.clear();
  }

  revoke(): void {
    this.revoked = true;
    this.push('credential.revoked', {});
  }

  addOperation(operation: Operation): void {
    this.operations.set(operation.id, { ...operation, state: 'pending' });
  }

  private refuse(
    res: ServerResponse,
    status: number,
    code: ReasonCode | string,
    retryable = false
  ) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code, message: `refused: ${code}`, retryable } }));
  }

  private json(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body: unknown = text ? JSON.parse(text) : null;
    const method = req.method ?? 'GET';
    this.requests.push({ method, path: url.pathname, headers: req.headers, body });

    const scripted = this.scripted.findIndex((s) => s.method === method && s.path === url.pathname);
    if (scripted !== -1) {
      const [entry] = this.scripted.splice(scripted, 1);
      if (entry!.body === null) {
        res.writeHead(entry!.status);
        res.end();
      } else this.json(res, entry!.status, entry!.body);
      return;
    }

    const base = `/v1/management/controllers/${this.controllerId}`;
    if (method === 'POST' && url.pathname === '/v1/management/controllers/enroll') {
      const proof = (body as { proof?: { code?: string } }).proof;
      if (proof?.code !== this.enrollmentCode)
        return this.refuse(res, 400, 'enrollment_code_invalid');
      return this.json(res, 201, { controller_id: this.controllerId, credential: this.credential });
    }
    if (method === 'POST' && url.pathname === `${base}/token`) {
      if (this.revoked) return this.refuse(res, 401, 'controller_revoked');
      if ((body as { credential?: string }).credential !== this.credential)
        return this.refuse(res, 401, 'invalid_credential');
      const token = `access-token-${++this.issued}`;
      this.tokens.add(token);
      return this.json(res, 200, {
        access_token: token,
        expires_at: new Date(Date.now() + this.tokenLifetimeMs).toISOString(),
      });
    }

    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (this.revoked) return this.refuse(res, 401, 'controller_revoked');
    if (!this.tokens.has(bearer)) return this.refuse(res, 401, 'token_expired', true);

    if (method === 'GET' && url.pathname === `/v1/controllers/${this.controllerId}/events`) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': keepalive\n\n');
      res.write(
        `event: connection_state\ndata: ${JSON.stringify({
          controller_id: this.controllerId,
          assignment_revision: this.assignment.revision,
          report_within_s: this.reportWithinS,
        })}\n\n`
      );
      this.streams.add(res);
      res.on('close', () => this.streams.delete(res));
      return;
    }
    if (method === 'GET' && url.pathname === `${base}/assignment`) {
      const etag = `"${this.assignment.revision}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
      return this.json(res, 200, this.assignment, { ETag: etag });
    }
    if (method === 'PUT' && url.pathname === `${base}/status`) {
      this.statusReports.push(body as StatusReport);
      return this.json(res, 200, {
        assignment_revision: this.assignment.revision,
        report_within_s: this.reportWithinS,
      });
    }
    if (method === 'GET' && url.pathname === `${base}/operations`) {
      return this.json(res, 200, {
        operations: [...this.operations.values()]
          .filter((operation) => operation.state === 'pending')
          .map(({ state: _state, ...operation }) => operation),
      });
    }
    const operation = url.pathname.match(
      /^\/v1\/management\/operations\/([^/]+)\/(claim|progress|result)$/
    );
    if (method === 'POST' && operation) {
      const entry = this.operations.get(decodeURIComponent(operation[1]!));
      if (!entry) return this.refuse(res, 404, 'not_found');
      if (operation[2] === 'claim') {
        if (entry.state === 'cancelled') return this.refuse(res, 410, 'cancelled');
        if (entry.state !== 'pending') return this.refuse(res, 409, 'already_claimed');
        entry.state = 'claimed';
        entry.lease_expires_at = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        const { state: _state, ...claimed } = entry;
        return this.json(res, 200, claimed);
      }
      if (operation[2] === 'result') {
        const result = body as OperationResult;
        this.results.set(entry.id, result);
        entry.state = result.outcome;
      }
      res.writeHead(204);
      res.end();
      return;
    }
    const credentials = url.pathname.match(new RegExp(`^${base}/agents/([^/]+)/credentials$`));
    if (method === 'POST' && credentials) {
      const agentId = decodeURIComponent(credentials[1]!);
      if (!this.assignment.agents.some((agent) => agent.agent_id === agentId))
        return this.refuse(res, 403, 'not_assigned');
      this.credentialFetches.push(agentId);
      return this.json(res, 200, {
        agent_id: agentId,
        api_key: `agent-key-placeholder-${agentId}-${this.credentialFetches.length}`,
      });
    }
    if (url.pathname.startsWith('/v1/management/controllers/') && !url.pathname.startsWith(base))
      return this.refuse(res, 403, 'forbidden');
    return this.refuse(res, 404, 'not_found');
  }
}
