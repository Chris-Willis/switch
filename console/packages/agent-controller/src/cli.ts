#!/usr/bin/env node
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import packageJson from '../package.json' with { type: 'json' };
import { ControllerApiError, enroll, normalizeServerUrl } from './api';
import { DEFAULT_TIMING, runController } from './controller';
import {
  adoptIdentity,
  CREDENTIAL_STDIN_TIMEOUT_MS,
  readCredential,
  resolveSharedHostBundle,
  workspaceSharedHostBundle,
} from './handover';
import { createLogger, errorMessage } from './log';
import { dataLayout, ensureDataDir, resolveDataDir } from './paths';
import { definitionProblem } from './reconcile';
import { emptyObservation, SharedHostRuntime } from './runtime';
import { CONTROLLER_CREDENTIAL, FileSecretStore, MemorySecretStore } from './secrets';
import { contractPlatform, mapAgentProcess, PathProviderLocator } from './status';
import { ControllerStore } from './store';

export const VERSION: string = packageJson.version;

/** The process ends with this when the server revoked the controller. */
export const EXIT_REVOKED = 3;
/** The process ends with this when another instance of the controller took its stream over. */
export const EXIT_TAKEN_OVER = 4;
const EXIT_USAGE = 2;

const USAGE = `Usage: switch-agent-controller <command> [options]

Commands:
  enroll --server <agent-bridge-url> --code <code> [--name <name>] [--data-dir <dir>]
      Enroll this machine with a one-time code from Switch.
  run [--data-dir <dir>] [--shared-host-bundle <path>]
      [--controller-id <id> --server <agent-bridge-url> [--name <name>]]
      [--credential-stdin]
      Run the agents assigned to this machine and report their status.
      --controller-id and --server adopt an identity enrolled elsewhere when
      the data directory holds none. --credential-stdin reads the controller
      credential from stdin and keeps it in memory only.
  status [--data-dir <dir>] [--shared-host-bundle <path>]
      Show this controller's identity and its agents, from local state only.

The data directory defaults to SWITCH_CONTROLLER_DATA_DIR, then the OS default.
The shared host bundle defaults to SWITCH_CONTROLLER_SHARED_HOST_BUNDLE, then
the one built in the workspace.
Log level: SWITCH_CONTROLLER_LOG_LEVEL (debug, info, warn, error; default info).
`;

class UsageError extends Error {}

function bundlePath(flag: string | undefined): string {
  return resolveSharedHostBundle(flag, process.env, workspaceSharedHostBundle);
}

async function openState(dataDirFlag: string | undefined) {
  const dataDir = resolveDataDir(dataDirFlag);
  await ensureDataDir(dataDir);
  const layout = dataLayout(dataDir);
  return {
    dataDir,
    layout,
    store: ControllerStore.open(layout.database),
    secrets: new FileSecretStore(layout.secrets),
  };
}

async function enrollCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: 'string' },
      code: { type: 'string' },
      name: { type: 'string' },
      'data-dir': { type: 'string' },
    },
    strict: true,
  });
  if (!values.server) throw new UsageError('enroll needs --server <agent-bridge-url>.');
  if (!values.code) throw new UsageError('enroll needs --code <code>.');
  const server = normalizeServerUrl(values.server);
  const name = values.name ?? hostname();
  const { dataDir, store, secrets } = await openState(values['data-dir']);
  try {
    const existing = store.identity();
    if (existing && !store.revokedAt())
      throw new Error(
        `${dataDir} already belongs to controller ${existing.controllerId} on ${existing.server}. Use another --data-dir, or remove that directory to enroll this machine afresh.`
      );
    const enrolled = await enroll(fetch, server, {
      proof: { kind: 'enrollment_code', code: values.code },
      controller: { kind: 'daemon', name, platform: contractPlatform(), version: VERSION },
    });
    await secrets.set(CONTROLLER_CREDENTIAL, enrolled.credential);
    store.saveIdentity({
      controllerId: enrolled.controller_id,
      server,
      name,
      enrolledAt: new Date().toISOString(),
    });
    process.stdout.write(
      `Enrolled as controller ${enrolled.controller_id} ("${name}") on ${server}.\nData: ${dataDir}\nStart it with: switch-agent-controller run${values['data-dir'] ? ` --data-dir ${dataDir}` : ''}\n`
    );
    process.stderr.write(`Warning: ${secrets.startupWarning()}\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function runCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string' },
      'shared-host-bundle': { type: 'string' },
      'controller-id': { type: 'string' },
      server: { type: 'string' },
      name: { type: 'string' },
      'credential-stdin': { type: 'boolean' },
    },
    strict: true,
  });
  const controllerId = values['controller-id'];
  if ((controllerId === undefined) !== (values.server === undefined))
    throw new UsageError('--controller-id and --server adopt an identity together; pass both.');
  if (values.name !== undefined && controllerId === undefined)
    throw new UsageError('--name names an identity adopted with --controller-id and --server.');
  const log = createLogger({
    level: process.env.SWITCH_CONTROLLER_LOG_LEVEL,
    write: (line) => process.stderr.write(line),
  });
  const credential = values['credential-stdin']
    ? await readCredential(process.stdin, CREDENTIAL_STDIN_TIMEOUT_MS)
    : null;
  const sharedHostBundle = bundlePath(values['shared-host-bundle']);
  const { dataDir, layout, store, secrets: fileSecrets } = await openState(values['data-dir']);
  const secrets =
    credential === null
      ? fileSecrets
      : new MemorySecretStore({ [CONTROLLER_CREDENTIAL]: credential }, 'handed over on stdin');
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      log.info(
        `Received ${signal}; stopping. The agents keep running until a controller says otherwise.`
      );
      stop.abort();
    });
  try {
    if (controllerId !== undefined && values.server !== undefined) {
      const adopted = adoptIdentity(
        store,
        {
          controllerId,
          server: values.server,
          name: values.name ?? hostname(),
          now: new Date(),
        },
        dataDir
      );
      if (adopted === 'adopted')
        log.info('Adopted an identity enrolled elsewhere', { controllerId, dataDir });
    }
    const exit = await runController(
      {
        store,
        secrets,
        runtime: new SharedHostRuntime({ layout, bundlePath: sharedHostBundle }),
        locator: new PathProviderLocator(process.env.PATH),
        fetch,
        log,
        dataDir,
        version: VERSION,
        now: Date.now,
        random: Math.random,
        timing: DEFAULT_TIMING,
      },
      stop.signal
    );
    return exit === 'revoked' ? EXIT_REVOKED : exit === 'taken_over' ? EXIT_TAKEN_OVER : 0;
  } finally {
    store.close();
  }
}

async function statusCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { 'data-dir': { type: 'string' }, 'shared-host-bundle': { type: 'string' } },
    strict: true,
  });
  const { dataDir, layout, store, secrets } = await openState(values['data-dir']);
  try {
    const out: string[] = [`Data directory: ${dataDir}`];
    const identity = store.identity();
    if (!identity) {
      out.push('Not enrolled.');
      process.stdout.write(`${out.join('\n')}\n`);
      return 1;
    }
    out.push(
      `Controller:     ${identity.controllerId} ("${identity.name}")`,
      `Server:         ${identity.server}`,
      `Enrolled at:    ${identity.enrolledAt}`,
      `Secret store:   ${secrets.description}`
    );
    const relayPort = store.relayPort();
    out.push(
      `Relay:          ${relayPort === null ? 'never started' : `http://127.0.0.1:${relayPort} (where agents were last pointed)`}`
    );
    const revokedAt = store.revokedAt();
    if (revokedAt) out.push(`Revoked at:     ${revokedAt}`);
    else if (!(await secrets.get(CONTROLLER_CREDENTIAL)))
      out.push('Credential:     not in this data directory (missing, or handed over at run time)');
    const cached = store.cachedAssignment();
    if (!cached) {
      out.push('Assignment:     not pulled yet');
      process.stdout.write(`${out.join('\n')}\n`);
      return 0;
    }
    out.push(
      `Assignment:     revision ${cached.assignment.revision}, ${cached.assignment.agents.length} agent(s)`
    );
    const runtime = new SharedHostRuntime({
      layout,
      bundlePath: bundlePath(values['shared-host-bundle']),
    });
    for (const entry of cached.assignment.agents) {
      const row = store.agent(entry.agent_id);
      const observation = definitionProblem(entry)
        ? emptyObservation()
        : await runtime.observe(entry.agent_id);
      // Whether events flow is the running controller's to know; this reads only disk.
      const mapped = mapAgentProcess({
        assignment: entry,
        row,
        observation,
        relayAttached: false,
        nowMs: Date.now(),
      });
      out.push(
        '',
        `  ${entry.definition.name} (${entry.agent_id})`,
        `    provider ${entry.definition.provider}, desired ${entry.desired_state}, revision ${entry.revision}, applied ${row?.appliedRevision ?? 'never'}`,
        `    ${mapped.process}${mapped.reason ? ` [${mapped.reason}]` : ''}${mapped.detail ? `: ${mapped.detail}` : ''}`
      );
    }
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  } finally {
    store.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'enroll':
        return await enrollCommand(rest);
      case 'run':
        return await runCommand(rest);
      case 'status':
        return await statusCommand(rest);
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        process.stdout.write(USAGE);
        return command === undefined ? EXIT_USAGE : 0;
      case '--version':
        process.stdout.write(`${VERSION}\n`);
        return 0;
      default:
        throw new UsageError(`Unknown command '${command}'.`);
    }
  } catch (error) {
    if (
      error instanceof UsageError ||
      (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    ) {
      process.stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    if (error instanceof ControllerApiError)
      process.stderr.write(`switch-agent-controller: ${error.code}: ${error.message}\n`);
    else process.stderr.write(`switch-agent-controller: ${errorMessage(error)}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
