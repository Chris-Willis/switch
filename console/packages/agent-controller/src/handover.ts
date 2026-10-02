import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeServerUrl } from './api';
import type { ControllerStore } from './store';

/**
 * What a parent process hands a controller it starts, for one that was
 * enrolled by someone else (Switch Console enrolls through its signed-in
 * session): the identity on the command line, the credential on stdin, and
 * where the shared-host bundle is when the controller is not run from the
 * workspace.
 */

export const SHARED_HOST_BUNDLE_ENV = 'SWITCH_CONTROLLER_SHARED_HOST_BUNDLE';

/** How long `--credential-stdin` waits for the parent to write and close stdin. */
export const CREDENTIAL_STDIN_TIMEOUT_MS = 10_000;

type CredentialSource = AsyncIterable<Buffer | string> & { isTTY?: boolean };

/**
 * The controller credential, read from `input` to its end. The parent writes
 * it and closes the pipe; nothing about it touches the disk or the
 * environment, so the watchers and sessions this controller starts never
 * inherit it.
 */
export async function readCredential(input: CredentialSource, timeoutMs: number): Promise<string> {
  if (input.isTTY)
    throw new Error(
      '--credential-stdin reads the credential from a pipe that the parent process writes and closes; stdin is a terminal.'
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `No credential arrived on stdin within ${timeoutMs / 1000} s: the parent process must write it and close the pipe.`
          )
        ),
      timeoutMs
    );
  });
  const read = (async () => {
    let text = '';
    for await (const chunk of input) text += typeof chunk === 'string' ? chunk : chunk.toString();
    return text;
  })();
  try {
    const credential = (await Promise.race([read, timeout])).trim();
    if (!credential) throw new Error('stdin closed without a credential.');
    if (/\s/.test(credential)) throw new Error('The credential read from stdin is not one token.');
    return credential;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Seeds the store with an identity enrolled elsewhere, so `run` can start
 * without `enroll`. A store that already holds this identity is left as it
 * is; one that holds another is refused, as `enroll` refuses it, because its
 * cached assignment and cursors belong to that other controller.
 */
export function adoptIdentity(
  store: ControllerStore,
  input: { controllerId: string; server: string; name: string; now: Date },
  dataDir: string
): 'adopted' | 'unchanged' {
  const server = normalizeServerUrl(input.server);
  const existing = store.identity();
  if (existing) {
    if (existing.controllerId === input.controllerId && existing.server === server)
      return 'unchanged';
    throw new Error(
      `${dataDir} already belongs to controller ${existing.controllerId} on ${existing.server}, not ${input.controllerId} on ${server}. Use another --data-dir, or remove that directory first.`
    );
  }
  store.saveIdentity({
    controllerId: input.controllerId,
    server,
    name: input.name,
    enrolledAt: input.now.toISOString(),
  });
  return 'adopted';
}

/**
 * The agent-providers shared-host bundle the controller runs its agents with:
 * `--shared-host-bundle`, then `SWITCH_CONTROLLER_SHARED_HOST_BUNDLE`, then the
 * one built in the workspace. A packaged parent names its own copy, since a
 * bundled controller has no workspace to resolve it from.
 */
export function resolveSharedHostBundle(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  workspaceDefault: () => string
): string {
  const named = flag ?? env[SHARED_HOST_BUNDLE_ENV];
  if (named) {
    const path = resolve(named);
    if (!existsSync(path)) throw new Error(`The shared host bundle ${path} does not exist.`);
    return path;
  }
  const path = workspaceDefault();
  if (!existsSync(path))
    throw new Error(
      `The shared host bundle is missing at ${path}. Build the workspace packages first (pnpm -r --filter './packages/**' run build), or name one with --shared-host-bundle.`
    );
  return path;
}

/** The bundle as built in the workspace, resolved through the package's exports. */
export function workspaceSharedHostBundle(): string {
  return fileURLToPath(import.meta.resolve('@switch-console/agent-providers/shared-host-daemon'));
}
