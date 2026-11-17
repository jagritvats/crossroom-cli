/**
 * Whether this `crossroom` is older than an instance it talked to still serves as expected. Each
 * instance gives the oldest client it supports in `GET /api/features` (`client.min`). After a command
 * that named an instance, the client reads that, at most once a day per instance, and says on stderr
 * that it is time to update. It never refuses to run, never delays a command by more than a couple
 * of seconds, and stays quiet when the instance cannot be reached or says nothing.
 *
 * What it keeps: `<data>/client-check.json`, each instance's origin with when it was read, the
 * minimum it gave, and when it last failed to answer. Nothing is sent but the GET.
 */
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** How long one instance's answer is trusted before it is read again. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** The longest the check may hold a finished command. */
const CHECK_TIMEOUT_MS = 2000;
/**
 * How long an instance that did not answer is left alone. Without it every command waited out
 * the timeout while the instance was down.
 */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

const noted = new Set<string>();

/** An instance this command is talking to: checked once the command is done. */
export function noteInstance(base: string): void {
  try {
    noted.add(new URL(base).origin);
  } catch {
    // Not an address: nothing to check.
  }
}

/** The instances noted so far, for a test. */
export const notedInstances = (): string[] => [...noted];

const VERSION_SHAPE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * The numeric core of `1.2.3` or `1.2.3-beta.0`, as numbers; null for anything else (a `dev`
 * build). A pre-release is read by its core, so a 0.1.x beta still hears that 0.2.0 is the oldest
 * an instance supports.
 */
export function versionParts(v: string): [number, number, number] | null {
  const m = VERSION_SHAPE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `v` carries a pre-release tag (`0.3.0-beta.0`). */
export function isPrerelease(v: string): boolean {
  return Boolean(VERSION_SHAPE.exec(v.trim())?.[4]);
}

/**
 * Whether `have` is older than `min`, by numeric core: `0.3.0-beta.0` is not older than `0.2.0`,
 * `0.1.5-beta.1` is. On an equal core a pre-release comes before its release, as semver orders
 * them. False when either is not a version: no warning on a guess.
 */
export function olderThan(have: string, min: string): boolean {
  const a = versionParts(have);
  const b = versionParts(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return isPrerelease(have) && !isPrerelease(min);
}

/** How this `crossroom` was installed, read from where its script really lives. */
export type InstallKind = 'npx' | 'npm' | 'brew' | 'checkout' | 'unknown';

/** The script's real path with `/` separators, or null when it cannot be resolved. */
function realScript(script: string | undefined): string | null {
  if (!script) return null;
  try {
    return realpathSync(script).replace(/\\/g, '/');
  } catch {
    return null;
  }
}

/**
 * The source checkout a script was built in: `<root>/packages/cli/dist/<file>` beside a
 * `package.json` named `crossroom` and a `src` folder. An installed package has no `src`.
 */
function checkoutOf(real: string): { pkgDir: string; root: string } | null {
  if (real.includes('/node_modules/')) return null;
  const pkgDir = path.dirname(path.dirname(real));
  if (path.basename(path.dirname(real)) !== 'dist') return null;
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { name?: unknown };
    if (pkg.name !== 'crossroom' || !statSync(path.join(pkgDir, 'src')).isDirectory()) return null;
  } catch {
    return null;
  }
  return { pkgDir, root: path.resolve(pkgDir, '..', '..') };
}

export function installKind(script: string | undefined = process.argv[1]): InstallKind {
  const real = realScript(script);
  if (!real) return 'unknown';
  if (real.includes('/_npx/')) return 'npx';
  if (/\/(Cellar|homebrew|linuxbrew)\//i.test(real)) return 'brew';
  if (real.includes('/node_modules/crossroom/')) return 'npm';
  if (checkoutOf(real)) return 'checkout';
  return 'unknown';
}

/** The one line that says how to update this install. */
export function updateHint(version: string, script: string | undefined = process.argv[1]): string {
  const tag = isPrerelease(version) ? 'crossroom@beta' : 'crossroom';
  switch (installKind(script)) {
    case 'npx':
      return `Run the newest with: npx ${isPrerelease(version) ? tag : 'crossroom@latest'}`;
    case 'brew':
      return 'Update with: brew upgrade crossroom';
    case 'checkout': {
      const at = checkoutOf(realScript(script) ?? '');
      return `Update the checkout it runs from with git pull, then rebuild: ${rebuildCommand(at?.root ?? '<checkout>')}`;
    }
    default:
      return `Update with: npm install -g ${tag}`;
  }
}

/** The command that rebuilds the client in a checkout, its path quoted when it holds a space. */
function rebuildCommand(root: string): string {
  return `pnpm -C ${/\s/.test(root) ? `"${root}"` : root} --filter crossroom build`;
}

/**
 * A linked checkout whose build is older than its source: the version baked into the running
 * bundle differs from the `package.json` beside it. Reads two local files; no network.
 */
export function staleBuild(version: string, script: string | undefined = process.argv[1]): { built: string; source: string; rebuild: string } | null {
  if (!versionParts(version)) return null;
  const real = realScript(script);
  const at = real ? checkoutOf(real) : null;
  if (!at) return null;
  let source: unknown;
  try {
    source = (JSON.parse(readFileSync(path.join(at.pkgDir, 'package.json'), 'utf8')) as { version?: unknown }).version;
  } catch {
    return null;
  }
  if (typeof source !== 'string' || source === version) return null;
  return { built: version, source, rebuild: rebuildCommand(at.root) };
}

/** What `--version` and `doctor` say about a stale build, in one line. */
export function staleBuildLine(stale: { built: string; source: string; rebuild: string }): string {
  return `This crossroom was built as ${stale.built}; its checkout is now ${stale.source}. Rebuild it with: ${stale.rebuild}`;
}

/** Per origin: when its minimum was read (0 for never), the minimum, and when a read last failed. */
type Seen = Record<string, { at: number; min: string | null; failedAt?: number }>;

function readSeen(file: string): Seen {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Seen) : {};
  } catch {
    return {};
  }
}

export interface VersionCheck {
  version: string;
  dataDir: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** The running script, for how to update it; `process.argv[1]` by default. */
  script?: string;
  say: (line: string) => void;
}

/** Read each noted instance's minimum (or the day-old answer kept for it) and say if this client is older. */
export async function warnIfOutdated(o: VersionCheck): Promise<void> {
  if (!noted.size || !versionParts(o.version) || process.env.CROSSROOM_NO_VERSION_CHECK === '1') return;
  const file = path.join(o.dataDir, 'client-check.json');
  const now = (o.now ?? Date.now)();
  const seen = readSeen(file);
  let changed = false;
  for (const origin of noted) {
    let entry = seen[origin];
    const stale = !entry?.at || now - entry.at > CHECK_EVERY_MS;
    const resting = typeof entry?.failedAt === 'number' && now - entry.failedAt >= 0 && now - entry.failedAt < RETRY_AFTER_FAILURE_MS;
    if (stale && !resting) {
      const min = await readMin(origin, o.fetch ?? fetch);
      // An instance that did not answer is asked again after a rest: what it said before still stands.
      entry = min === undefined ? { at: entry?.at ?? 0, min: entry?.min ?? null, failedAt: now } : { at: now, min };
      seen[origin] = entry;
      changed = true;
    }
    if (entry?.min && olderThan(o.version, entry.min))
      o.say(`This crossroom is ${o.version}; ${new URL(origin).host} supports ${entry.min} and newer. ${updateHint(o.version, o.script)}`);
  }
  if (changed) {
    try {
      mkdirSync(o.dataDir, { recursive: true });
      writeFileSync(file, `${JSON.stringify(seen, null, 2)}\n`);
    } catch {
      // A read-only data directory only means the check runs again next time.
    }
  }
}

/** The instance's `client.min`: a version, null for none given, undefined when it could not be read. */
async function readMin(origin: string, f: typeof fetch): Promise<string | null | undefined> {
  try {
    const res = await f(`${origin}/api/features`, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { client?: { min?: unknown } } | null;
    const min = body?.client?.min;
    return typeof min === 'string' && versionParts(min) ? min : null;
  } catch {
    return undefined;
  }
}
