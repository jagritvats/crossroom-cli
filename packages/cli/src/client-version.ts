/**
 * Whether this `crossroom` is older than an instance it talked to still serves as expected. Each
 * instance gives the oldest client it supports in `GET /api/features` (`client.min`). After a command
 * that named an instance, the client reads that, at most once a day per instance, and says on stderr
 * that it is time to update. It never refuses to run, never delays a command by more than a couple
 * of seconds, and stays quiet when the instance cannot be reached or says nothing.
 *
 * What it keeps: `<data>/client-check.json`, each instance's origin with when it was read and the
 * minimum it gave. Nothing is sent but the GET.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** How long one instance's answer is trusted before it is read again. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** The longest the check may hold a finished command. */
const CHECK_TIMEOUT_MS = 2000;

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

/** `1.2.3` as numbers; null for anything else (a `dev` build, a pre-release tag). */
export function versionParts(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `have` is older than `min`. False when either is not a plain version: no warning on a guess. */
export function olderThan(have: string, min: string): boolean {
  const a = versionParts(have);
  const b = versionParts(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

type Seen = Record<string, { at: number; min: string | null }>;

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
    if (!entry || now - entry.at > CHECK_EVERY_MS) {
      const min = await readMin(origin, o.fetch ?? fetch);
      // An instance that did not answer is asked again next time: what it said before still stands.
      if (min !== undefined) {
        entry = { at: now, min };
        seen[origin] = entry;
        changed = true;
      }
    }
    if (entry?.min && olderThan(o.version, entry.min))
      o.say(`This crossroom is ${o.version}; ${new URL(origin).host} supports ${entry.min} and newer. Update with: npm install -g crossroom`);
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
