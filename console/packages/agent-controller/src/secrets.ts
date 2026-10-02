import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** The one secret v1 keeps: the long-lived controller credential (`swcc_…`). */
export const CONTROLLER_CREDENTIAL = 'controller-credential';

/**
 * Where the controller keeps secrets. v1 ships only a file backend; an OS
 * keychain backend slots in behind the same interface.
 */
export interface SecretStore {
  /** Names the backend in logs and `status`. */
  readonly description: string;
  /** Logged once when the controller starts, for a backend with a caveat worth stating. */
  startupWarning(): string | null;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const NAME = /^[a-z0-9-]+$/;

/**
 * One file per secret under `dir`, owner-only (0600) in an owner-only
 * directory. The values are plaintext on disk; anyone who can read the
 * controller user's files can read them.
 */
export class FileSecretStore implements SecretStore {
  readonly description: string;

  constructor(private readonly dir: string) {
    this.description = `plaintext files in ${dir} (mode 0600)`;
  }

  startupWarning(): string {
    return `No OS keychain backend is in use: the controller credential is stored as a plaintext file in ${this.dir}, readable by this user only.`;
  }

  async get(name: string): Promise<string | null> {
    const path = this.path(name);
    let value: string;
    try {
      value = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (process.platform !== 'win32') {
      const mode = (await stat(path)).mode & 0o777;
      if (mode & 0o077)
        throw new Error(
          `The secret file ${path} is readable by other users (mode ${mode.toString(8)}). Treat the credential as exposed: revoke this controller and enroll again, or run chmod 600 on it if you are sure it was not read.`
        );
    }
    return value.trim();
  }

  async set(name: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.dir, 0o700);
    const path = this.path(name);
    const temporary = `${path}.${randomUUID()}`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  }

  async delete(name: string): Promise<void> {
    await unlink(this.path(name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private path(name: string): string {
    if (!NAME.test(name)) throw new Error(`Invalid secret name '${name}'.`);
    return join(this.dir, name);
  }
}
