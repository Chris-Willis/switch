/**
 * The skip check that lets a host's agents be brought up only when needed.
 *
 * Bringing one controller up is about a dozen SSH round trips whose usual
 * outcome is nothing — the watcher is already running the right build. This
 * decides that in advance, from one command per host.
 *
 * What these tests are really about is the asymmetry: wrongly deciding "needs
 * work" costs a redundant bring-up, which is what happens today anyway.
 * Wrongly deciding "current" leaves an agent off the air with nothing to
 * notice. So every uncertain case has to fall on the safe side, and that is
 * most of what is asserted here.
 */

import { expect, it, vi } from 'vitest';
import { listHostWatchers, watcherIsCurrent, type HostWatcherStatus } from './host-watchers';

const ENTRYPOINT = '/home/u/.local/state/switch/sdk-host/shared-host-abc123.mjs';
const BUNDLE_FILE = 'shared-host-abc123.mjs';
const want = { bundleFile: BUNDLE_FILE, enabled: true, spawn: true };

function status(overrides: Partial<HostWatcherStatus> = {}): HostWatcherStatus {
  return {
    agentId: 'switch-a1',
    root: '/home/u/.local/state/switch/sdk-watchers/hash',
    running: true,
    build: ENTRYPOINT,
    enabled: true,
    spawn: true,
    stoodDown: false,
    ...overrides,
  };
}

it('skips a watcher that is running the right build with the right flags', () => {
  expect(watcherIsCurrent(status(), want)).toBe(true);
});

it.each([
  ['the agent is not on the host at all', undefined],
  ['no supervisor is running', status({ running: false })],
  ['it runs a different build', status({ build: '/…/shared-host-old.mjs' })],
  ['its build is unknown', status({ build: null })],
  ['it has no watch flags yet', status({ enabled: null, spawn: null })],
  ['it is enabled but will not spawn', status({ spawn: false })],
  ['it is disabled', status({ enabled: false })],
  ['it stood down for another client', status({ stoodDown: true })],
])('brings up when %s', (_case, given) => {
  expect(watcherIsCurrent(given as HostWatcherStatus | undefined, want)).toBe(false);
});

it('does not skip when the flags we want differ from the ones it has', () => {
  // The bring-up writes watch.json, so "running the right build" alone is not
  // enough — skipping here would silently drop a change to what it may do.
  expect(watcherIsCurrent(status(), { ...want, spawn: false })).toBe(false);
});

it('reads every watcher on the host in one command, keyed by agent', async () => {
  const exec = vi.fn(async () => ({
    stdout: JSON.stringify([
      {
        agentId: 'switch-a1',
        root: '/r/1',
        running: true,
        build: ENTRYPOINT,
        enabled: true,
        spawn: true,
        stoodDown: false,
      },
      {
        agentId: 'switch-a2',
        root: '/r/2',
        running: false,
        build: null,
        enabled: null,
        spawn: null,
        stoodDown: false,
      },
    ]),
    stderr: '',
    exitCode: 0,
  }));

  const found = await listHostWatchers({ exec } as never);

  expect(exec).toHaveBeenCalledTimes(1);
  expect([...found.keys()].sort()).toEqual(['switch-a1', 'switch-a2']);
  expect(watcherIsCurrent(found.get('switch-a1'), want)).toBe(true);
  expect(watcherIsCurrent(found.get('switch-a2'), want)).toBe(false);
});

it('treats a host with no watchers as nothing to skip', async () => {
  const exec = vi.fn(async () => ({ stdout: '[]', stderr: '', exitCode: 0 }));

  const found = await listHostWatchers({ exec } as never);

  expect(found.size).toBe(0);
  expect(watcherIsCurrent(found.get('switch-a1'), want)).toBe(false);
});
