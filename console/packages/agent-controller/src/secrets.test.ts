import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTROLLER_CREDENTIAL, FileSecretStore } from './secrets';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-secrets-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FileSecretStore', () => {
  it('stores each secret in an owner-only file in an owner-only directory', async () => {
    const store = new FileSecretStore(join(dir, 'secrets'));
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBeNull();
    await store.set(CONTROLLER_CREDENTIAL, 'credential-placeholder');
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBe('credential-placeholder');
    expect(statSync(join(dir, 'secrets', CONTROLLER_CREDENTIAL)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'secrets')).mode & 0o777).toBe(0o700);
    await store.set(CONTROLLER_CREDENTIAL, 'replaced');
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBe('replaced');
    await store.delete(CONTROLLER_CREDENTIAL);
    await store.delete(CONTROLLER_CREDENTIAL);
    expect(await store.get(CONTROLLER_CREDENTIAL)).toBeNull();
  });

  it('refuses a secret file other users can read', async () => {
    const store = new FileSecretStore(join(dir, 'secrets'));
    await store.set(CONTROLLER_CREDENTIAL, 'credential-placeholder');
    chmodSync(join(dir, 'secrets', CONTROLLER_CREDENTIAL), 0o644);
    await expect(store.get(CONTROLLER_CREDENTIAL)).rejects.toThrow(/readable by other users/);
  });

  it('says at startup that no keychain protects the credential', () => {
    expect(new FileSecretStore(join(dir, 'secrets')).startupWarning()).toMatch(/No OS keychain/);
  });

  it('refuses a name that could leave its directory', async () => {
    const store = new FileSecretStore(join(dir, 'secrets'));
    await expect(store.set('../escape', 'x')).rejects.toThrow(/Invalid secret name/);
  });
});
