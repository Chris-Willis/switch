import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptIdentity,
  readCredential,
  resolveSharedHostBundle,
  SHARED_HOST_BUNDLE_ENV,
} from './handover';
import { ControllerStore } from './store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-handover-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pipeOf(...chunks: string[]): PassThrough {
  const pipe = new PassThrough();
  for (const chunk of chunks) pipe.write(chunk);
  pipe.end();
  return pipe;
}

describe('readCredential', () => {
  it('reads the credential the parent wrote, to the end of the pipe', async () => {
    expect(await readCredential(pipeOf('swcc_abc', 'def\n'), 1_000)).toBe('swcc_abcdef');
  });

  it('refuses an empty pipe, a terminal, and more than one token', async () => {
    await expect(readCredential(pipeOf(''), 1_000)).rejects.toThrow(/without a credential/);
    const terminal = Object.assign(pipeOf('swcc_x'), { isTTY: true });
    await expect(readCredential(terminal, 1_000)).rejects.toThrow(/terminal/);
    await expect(readCredential(pipeOf('swcc_a swcc_b'), 1_000)).rejects.toThrow(/not one token/);
  });

  it('gives up on a parent that never closes the pipe', async () => {
    const open = new PassThrough();
    open.write('swcc_partial');
    await expect(readCredential(open, 20)).rejects.toThrow(/within/);
    open.destroy();
  });
});

describe('adoptIdentity', () => {
  it('seeds an empty store, keeps a matching one, and refuses another controller', () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    try {
      const input = {
        controllerId: 'controller-1',
        server: 'https://switch.example.com/',
        name: 'laptop',
        now: new Date('2026-01-01T00:00:00Z'),
      };
      expect(adoptIdentity(store, input, dir)).toBe('adopted');
      expect(store.identity()).toEqual({
        controllerId: 'controller-1',
        server: 'https://switch.example.com',
        name: 'laptop',
        enrolledAt: '2026-01-01T00:00:00.000Z',
      });
      expect(adoptIdentity(store, { ...input, name: 'renamed' }, dir)).toBe('unchanged');
      expect(store.identity()?.name).toBe('laptop');
      expect(() => adoptIdentity(store, { ...input, controllerId: 'controller-2' }, dir)).toThrow(
        /already belongs to controller controller-1/
      );
      expect(() =>
        adoptIdentity(store, { ...input, server: 'https://other.example.com' }, dir)
      ).toThrow(/already belongs/);
    } finally {
      store.close();
    }
  });

  it('refuses a plain-http server that is not loopback', () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    try {
      expect(() =>
        adoptIdentity(
          store,
          { controllerId: 'c', server: 'http://switch.example.com', name: 'n', now: new Date() },
          dir
        )
      ).toThrow(/https/);
      expect(store.identity()).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('resolveSharedHostBundle', () => {
  it('takes the flag, then the environment, then the workspace build', () => {
    const flagged = join(dir, 'flagged.mjs');
    const env = join(dir, 'env.mjs');
    const workspace = join(dir, 'workspace.mjs');
    for (const path of [flagged, env, workspace]) writeFileSync(path, '');
    const fromWorkspace = () => workspace;
    expect(resolveSharedHostBundle(flagged, { [SHARED_HOST_BUNDLE_ENV]: env }, fromWorkspace)).toBe(
      flagged
    );
    expect(
      resolveSharedHostBundle(undefined, { [SHARED_HOST_BUNDLE_ENV]: env }, fromWorkspace)
    ).toBe(env);
    expect(resolveSharedHostBundle(undefined, {}, fromWorkspace)).toBe(workspace);
  });

  it('fails loud on a bundle that is not there', () => {
    expect(() => resolveSharedHostBundle(join(dir, 'missing.mjs'), {}, () => '')).toThrow(
      /does not exist/
    );
    expect(() => resolveSharedHostBundle(undefined, {}, () => join(dir, 'none.mjs'))).toThrow(
      /missing at/
    );
  });
});
