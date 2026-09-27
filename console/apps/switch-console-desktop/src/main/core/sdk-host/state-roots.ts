import { READ_JSON } from './remote-json';

/**
 * Which entries under `sdk-watchers` and `sdk-sessions` are state roots.
 *
 * Several readers find an agent's root by listing one of those directories and
 * reading every entry's `config.json`. Earlier builds staged each launch's
 * configuration in a scratch directory beside the roots (`.launch-*`, and
 * before that `launch-*`), and one left behind by an interrupted launch holds
 * either a half-written file or a complete copy of an agent's configuration.
 * Read as a root, the first breaks the listing and the second makes the agent
 * look like it has two competing watchers. A root is named by a hash, so
 * neither prefix can belong to one.
 */
export function isStateRootName(name: string): boolean {
  return !name.startsWith('.') && !name.startsWith('launch-');
}

/** `isStateRoot(name)` for scripts run with `node -e` on an execution host. */
export const IS_STATE_ROOT = String.raw`
const isStateRoot = (name) => !name.startsWith('.') && !name.startsWith('launch-');
`;

/**
 * How long a launch's staged configuration may sit before it is taken for one
 * a launch abandoned. A launch reads it within seconds; the hour is margin.
 */
export const STALE_LAUNCH_MS = 60 * 60 * 1000;

/**
 * Makes a private directory to stage one launch's configuration in, and prints
 * its path. It lives in `sdk-launch`, beside `sdk-watchers` and `sdk-sessions`
 * rather than inside either, so no reader of those directories ever meets it.
 *
 * A launch removes its own directory when it finishes, but not one whose SSH
 * connection dropped first. Each staged file carries the agent's credentials,
 * so every launch also removes what abandoned launches left: in `sdk-launch`,
 * and in the directory this root sits in, from the builds that staged there.
 *
 * Arguments: the state root being launched, and the staleness threshold in ms.
 */
export const MAKE_LAUNCH_DIR = String.raw`
const fs = require('node:fs'), path = require('node:path');
const [root, staleArg] = process.argv.slice(1);
const cutoff = Date.now() - Number(staleArg);
const sweep = (directory, abandoned) => {
  let names;
  try { names = fs.readdirSync(directory); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const name of names) {
    if (!abandoned(name)) continue;
    const entry = path.join(directory, name);
    let stat;
    try { stat = fs.statSync(entry); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (stat.mtimeMs < cutoff) fs.rmSync(entry, { recursive: true, force: true });
  }
};
const kind = path.dirname(root);
const staging = path.join(path.dirname(kind), 'sdk-launch');
fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
sweep(staging, () => true);
sweep(kind, (name) => name.startsWith('.launch-') || name.startsWith('launch-'));
console.log(fs.mkdtempSync(path.join(staging, 'launch-')));
`;

/**
 * Prints the state root for a key, under `sdk-watchers` or `sdk-sessions`. A
 * watcher saved under an earlier key is adopted rather than stranded, which is
 * why the watchers directory is listed; two roots claiming one agent are an
 * error rather than a guess.
 *
 * Arguments: the root's key, the directory kind, and the agent identity.
 */
export const RESOLVE_STATE_ROOT = String.raw`${READ_JSON}${IS_STATE_ROOT}
const fs = require('node:fs'), path = require('node:path');
const [key, kind, identity] = process.argv.slice(1);
const base = path.join(require('node:os').homedir(), '.local', 'state', 'switch', kind);
let root = path.join(base, key);
if (kind === 'sdk-watchers' && fs.existsSync(base)) {
  const matches = fs.readdirSync(base).filter(isStateRoot).filter((name) => {
    try { return readJson(path.join(base, name, 'config.json')).session.agentId === identity; }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  });
  if (matches.length > 1) throw new Error('Competing saved watchers require explicit cleanup.');
  if (matches.length) root = path.join(base, matches[0]);
}
console.log(root);
`;
