import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setSessionCookie = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ BrowserWindow: vi.fn(), session: {} }));
vi.mock('@main/core/managed-switch-server/host/host-for-server', () => ({
  managedServerSecretsKey: vi.fn(),
}));
vi.mock('@main/core/managed-switch-server/secrets', () => ({ loadOrCreateSecrets: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('./servers-store', () => ({ getSessionCookie: vi.fn(), setSessionCookie }));

const { signup } = await import('./auth');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  gatewayUrl: 'https://switch.example.com',
  managed: false,
} as never;

const USER = { id: 'u1', name: 'ada', email: 'ada@example.com', role: 'user', server: null };

function response(status: number, body: unknown, cookies: string[] = []): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: cookies.map((cookie) => ['Set-Cookie', cookie] as [string, string]),
  });
}

const fetchMock = vi.fn<typeof fetch>();

describe('signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('creates the account and stores its session as a login does', async () => {
    fetchMock.mockResolvedValueOnce(
      response(201, { ...USER, machine: { status: 'starting', reason: null } }, [
        'switch_auth=SYNTHETIC-JWT; HttpOnly; Path=/',
      ])
    );

    const result = await signup(SERVER, { email: 'ada@example.com', password: 'correct-horse' });

    expect(result).toEqual({
      success: true,
      data: { user: USER, machine: { status: 'starting', reason: null } },
    });
    expect(setSessionCookie).toHaveBeenCalledWith('srv-1', 'SYNTHETIC-JWT');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://switch.example.com/gateway/auth/signup');
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'ada@example.com',
      password: 'correct-horse',
    });
  });

  it('sends a display name when one is given', async () => {
    fetchMock.mockResolvedValueOnce(
      response(201, { ...USER, machine: { status: 'unavailable', reason: 'None free.' } }, [
        'switch_auth=SYNTHETIC-JWT',
      ])
    );

    const result = await signup(SERVER, {
      email: 'ada@example.com',
      password: 'correct-horse',
      displayName: 'Ada',
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
      display_name: 'Ada',
    });
    expect(result.success && result.data.machine).toEqual({
      status: 'unavailable',
      reason: 'None free.',
    });
  });

  it('reports an existing email with the server’s explanation', async () => {
    fetchMock.mockResolvedValueOnce(response(409, { detail: 'Email already registered' }));

    const result = await signup(SERVER, { email: 'ada@example.com', password: 'correct-horse' });

    expect(result).toEqual({
      success: false,
      error: { kind: 'email_taken', message: 'Email already registered' },
    });
    expect(setSessionCookie).not.toHaveBeenCalled();
  });

  it('renders a validation refusal one sentence per field', async () => {
    fetchMock.mockResolvedValueOnce(
      response(422, {
        detail: [
          {
            type: 'string_too_short',
            loc: ['body', 'password'],
            msg: 'String should have at least 8 characters',
          },
          {
            type: 'value_error',
            loc: ['body', 'display_name'],
            msg: 'Value error, Too long.',
          },
        ],
      })
    );

    const result = await signup(SERVER, { email: 'ada@example.com', password: 'short' });

    expect(result).toEqual({
      success: false,
      error: {
        kind: 'invalid',
        message: 'Password: String should have at least 8 characters. Display name: Too long.',
      },
    });
  });

  it('fails without a session cookie rather than reporting a sign-in', async () => {
    fetchMock.mockResolvedValueOnce(
      response(201, { ...USER, machine: { status: 'starting', reason: null } })
    );

    const result = await signup(SERVER, { email: 'ada@example.com', password: 'correct-horse' });

    expect(result).toMatchObject({ success: false, error: { kind: 'failed' } });
    expect(setSessionCookie).not.toHaveBeenCalled();
  });
});
