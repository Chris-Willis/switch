import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executionEnvironment,
  prepareSharedConfig,
  sessionServiceSkills,
  sharedConfigSchema,
} from './shared-config';

afterEach(() => vi.unstubAllEnvs());

it('preserves host and configured environment, including shell setup output', async () => {
  vi.stubEnv('SDK_CUSTOM_HOST_VALUE', 'from-host');
  vi.stubEnv('SDK_UNLISTED_VALUE', 'must-not-inherit');
  vi.stubEnv('SWITCH_API_TOKEN', 'discard-inherited-identity');
  const env = await executionEnvironment(
    process.cwd(),
    { SDK_CONFIGURED: 'configured' },
    'echo setup-output; export SDK_CUSTOM_SETUP="$SDK_CONFIGURED-from-setup"',
    ['SDK_CUSTOM_HOST_VALUE', 'PATH', 'HOME', 'SHELL']
  );
  expect(env.SDK_UNLISTED_VALUE).toBeUndefined();
  expect(env.SDK_CUSTOM_HOST_VALUE).toBe('from-host');
  expect(env.SDK_CUSTOM_SETUP).toBe('configured-from-setup');
  expect(env.SWITCH_API_TOKEN).toBeUndefined();
});

it('fails before provider startup if shell setup fails', async () => {
  await expect(executionEnvironment(process.cwd(), {}, 'false', [])).rejects.toThrow();
});

it('gives the provider the host’s own MCP server and no Switch identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
  try {
    const credentialsPath = join(root, 'credentials.json');
    await writeFile(
      credentialsPath,
      JSON.stringify({
        env: {
          SWITCH_API_ENDPOINT: 'https://switch.test',
          SWITCH_API_TOKEN: 'agent-token',
          SWITCH_AGENT_ID: 'agent',
        },
      })
    );
    const config = sharedConfigSchema.parse({
      session: {
        sessionId: 'session',
        agentId: 'agent',
        hostId: 'host',
        epoch: 'epoch',
        provider: 'claude',
        status: 'starting',
        connectivity: 'online',
        pendingRequestIds: [],
        capabilities: {
          input: 'queue',
          approvals: true,
          questions: true,
          interrupt: true,
          reset: false,
          compact: false,
          modelChange: false,
          attachmentMimeTypes: [],
        },
      },
      start: {
        provider: 'claude',
        input: {
          sessionId: 'session',
          cwd: root,
          runtimeMode: 'approval-required',
          env: { CONFIGURED: 'yes' },
          mcpServers: {},
        },
      },
      roomConnection: { connectionId: 'controller' },
      execution: { credentialsPath, inheritEnv: [], codexConfig: '', skill: '', context: '' },
    });
    const runtime = {
      transport: 'http' as const,
      url: 'http://127.0.0.1:4321/mcp',
      headers: { Authorization: 'Bearer per-session' },
    };
    const prepared = await prepareSharedConfig(root, config, runtime, []);
    expect(prepared.input.mcpServers).toEqual({ switch: runtime });
    expect(prepared.input.env).toEqual({ CONFIGURED: 'yes' });
    // The host itself still reports to Switch as the agent.
    expect(prepared).toMatchObject({ agentApiUrl: 'https://switch.test', token: 'agent-token' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('gives Codex the Switch skill as instructions, like the other providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
  try {
    const credentialsPath = join(root, 'credentials.json');
    await writeFile(
      credentialsPath,
      JSON.stringify({
        env: {
          SWITCH_API_ENDPOINT: 'https://switch.test',
          SWITCH_API_TOKEN: 'agent-token',
          SWITCH_AGENT_ID: 'agent',
        },
      })
    );
    const config = sharedConfigSchema.parse({
      session: {
        sessionId: 'session',
        agentId: 'agent',
        hostId: 'host',
        epoch: 'epoch',
        provider: 'codex',
        status: 'starting',
        connectivity: 'online',
        pendingRequestIds: [],
        capabilities: {
          input: 'queue',
          approvals: true,
          questions: true,
          interrupt: true,
          reset: false,
          compact: false,
          modelChange: false,
          attachmentMimeTypes: [],
        },
      },
      start: {
        provider: 'codex',
        input: {
          sessionId: 'session',
          cwd: root,
          runtimeMode: 'approval-required',
          env: { CONFIGURED: 'yes', CODEX_HOME: join(root, 'codex-source') },
          mcpServers: {},
        },
      },
      roomConnection: { connectionId: 'controller' },
      execution: {
        credentialsPath,
        inheritEnv: [],
        codexConfig: '',
        skill: '',
        context: 'Switch skill text',
      },
    });
    const runtime = {
      transport: 'http' as const,
      url: 'http://127.0.0.1:4321/mcp',
      headers: { Authorization: 'Bearer per-session' },
    };
    const prepared = await prepareSharedConfig(root, config, runtime, []);
    expect(prepared.input.systemContext).toBe('Switch skill text');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('agent definitions in the launch spec', () => {
  const base = (input: Record<string, unknown>, execution: Record<string, unknown> = {}) => ({
    session: {
      sessionId: 'session',
      agentId: 'agent',
      hostId: 'host',
      epoch: 'epoch',
      provider: 'claude',
      status: 'starting',
      connectivity: 'online',
      pendingRequestIds: [],
      capabilities: {
        input: 'queue',
        approvals: true,
        questions: true,
        interrupt: true,
        reset: false,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
    },
    start: {
      provider: 'claude',
      input: {
        sessionId: 'session',
        cwd: '/repo',
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
        ...input,
      },
    },
    execution: {
      credentialsPath: '/repo/.switch/agents/reviewer.json',
      inheritEnv: [],
      codexConfig: '',
      skill: '',
      context: '',
      ...execution,
    },
  });

  it('carries a definition handed over directly', () => {
    const config = sharedConfigSchema.parse(
      base({
        agentName: 'reviewer',
        agentDefinition: { description: 'Reviews diffs', prompt: 'Be careful.', maxTurns: 3 },
      })
    );
    expect(config.start.input.agentDefinition).toEqual({
      description: 'Reviews diffs',
      prompt: 'Be careful.',
      maxTurns: 3,
    });
  });

  it('still reads a session saved by a Console that named a definition file', () => {
    // Sessions relaunch from the spec they were saved with, so the old shape has
    // to keep parsing after the host is upgraded.
    const config = sharedConfigSchema.parse(
      base({}, { agentDefinition: { name: 'reviewer', path: '.claude/agents/reviewer.md' } })
    );
    expect(config.execution?.agentDefinition).toEqual({
      name: 'reviewer',
      path: '.claude/agents/reviewer.md',
    });
  });

  it('rejects a definition field the SDK would not understand', () => {
    expect(() =>
      sharedConfigSchema.parse(
        base({
          agentName: 'reviewer',
          agentDefinition: { description: 'd', prompt: 'p', color: 'blue' },
        })
      )
    ).toThrow();
  });
});

describe('the skills of the agent’s service grants', () => {
  const GITHUB_SKILL = {
    name: 'github',
    content: '---\nname: github\ndescription: d\n---\n\n# GitHub\n\nUse gh.\n',
  };
  const runtime = {
    transport: 'http' as const,
    url: 'http://127.0.0.1:4321/mcp',
    headers: { Authorization: 'Bearer per-session' },
  };

  async function configFor(root: string, provider: 'claude' | 'opencode') {
    const credentialsPath = join(root, 'credentials.json');
    await writeFile(
      credentialsPath,
      JSON.stringify({
        env: {
          SWITCH_API_ENDPOINT: 'https://switch.test',
          SWITCH_API_TOKEN: 'agent-token',
          SWITCH_AGENT_ID: 'agent',
        },
      })
    );
    return sharedConfigSchema.parse({
      session: {
        sessionId: 'session',
        agentId: 'agent',
        hostId: 'host',
        epoch: 'epoch',
        provider,
        status: 'starting',
        connectivity: 'online',
        pendingRequestIds: [],
        capabilities: {
          input: 'queue',
          approvals: true,
          questions: true,
          interrupt: true,
          reset: false,
          compact: false,
          modelChange: false,
          attachmentMimeTypes: [],
        },
      },
      start: {
        provider,
        input: {
          sessionId: 'session',
          cwd: root,
          runtimeMode: 'approval-required',
          env: {},
          mcpServers: {},
        },
      },
      roomConnection: { connectionId: 'controller' },
      execution: {
        credentialsPath,
        inheritEnv: [],
        codexConfig: '',
        skill: '',
        context: 'Switch skill text',
      },
    });
  }

  afterEach(() => vi.unstubAllGlobals());

  it('join the context, except for OpenCode, which loads them as files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
    try {
      const claude = await prepareSharedConfig(root, await configFor(root, 'claude'), runtime, [
        GITHUB_SKILL,
      ]);
      expect(claude.input.systemContext).toBe('Switch skill text\n\n# GitHub\n\nUse gh.');
      const opencode = await prepareSharedConfig(root, await configFor(root, 'opencode'), runtime, [
        GITHUB_SKILL,
      ]);
      expect(opencode.input.systemContext).toBe('Switch skill text');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('are read as the session starts, and a session starts without them when they cannot be', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-config-test-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = await configFor(root, 'claude');
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              grants: [
                {
                  service: 'github',
                  access: 'read',
                  tool_mode: 'allow',
                  tools: [],
                  resources: {},
                  skill: GITHUB_SKILL,
                },
              ],
            })
          )
      );
      vi.stubGlobal('fetch', fetchMock);
      expect(await sessionServiceSkills(config)).toEqual([GITHUB_SKILL]);
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        'https://switch.test/agents/agent/service-grants'
      );

      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async () => new Response('{}', { status: 503 }))
      );
      expect(await sessionServiceSkills(config)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
