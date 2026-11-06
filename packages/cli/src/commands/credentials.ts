/**
 * The API tokens `crossroom login` keeps, one per relay, in `~/.parley/credentials.json`
 * (`CredentialsFile` in `@parley/shared/accounts`; `PARLEY_DATA` moves it with the rest).
 *
 * A token here acts for its account on that relay: it opens every room the account holds. So:
 * - the file is written whole, to a new file made `0600` and then renamed over the old one, so it
 *   is never readable by anyone else, not even for a moment, and never half written (on Windows
 *   the mode means nothing; the file sits in the user's own profile, as `cli-rooms.json` does);
 * - a token travels only as an `Authorization` header to the relay it was issued by, and is never
 *   printed, logged, put in a URL, or handed to another process in its arguments or environment;
 * - a relay is its origin, and a plain-http one is accepted only on this machine's loopback, since
 *   the token would otherwise cross the network in the clear.
 *
 * Other commands read a relay's token with `credentialFor`.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { API_TOKEN, type CredentialsFile } from '@parley/shared/accounts';
import { dataDir, Usage } from '../cli.js';
// The relay `crossroom login` and `crossroom logout` mean when none is named: the one a runner does.
import { DEFAULT_RELAY } from './instance.js';

export { DEFAULT_RELAY };

export const credentialsPath = () => path.join(dataDir(), 'credentials.json');

/** This machine's own loopback: the one place a plain-http relay is accepted. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The relay a user named, as the origin a token is keyed by: `app.crossroom.dev`,
 * `https://app.crossroom.dev/` and `https://app.crossroom.dev/account` are all
 * `https://app.crossroom.dev`. Throws `Usage` for anything else.
 */
export function relayOrigin(raw: string): string {
  const typed = raw.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    throw new Usage(`--relay must be a Crossroom's address, like ${DEFAULT_RELAY}; got "${raw}".`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Usage(`--relay must be an https address, like ${DEFAULT_RELAY}; got "${raw}".`);
  if (u.username || u.password) throw new Usage('--relay must not carry a user name or a password.');
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname))
    throw new Usage(`Not signing in to ${u.origin} over plain http: the token would cross the network unencrypted. Use its https address.`);
  return u.origin;
}

type Entry = CredentialsFile[string];

const isEntry = (v: unknown): v is Entry => {
  const e = v as Partial<Entry> | null;
  return !!e && typeof e === 'object' && typeof e.token === 'string' && API_TOKEN.test(e.token) && typeof e.accountId === 'string' && typeof e.createdAt === 'string';
};

/**
 * Every relay this machine is signed in to. No file is an empty one. A file that is not one this
 * command wrote is refused rather than overwritten, since it may hold a token for another relay.
 */
export function readCredentials(file = credentialsPath()): CredentialsFile {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Usage(`${file} is not a credentials file Crossroom wrote. Move it aside, then run this again.`);
  const out: CredentialsFile = {};
  for (const [relay, entry] of Object.entries(raw)) if (isEntry(entry)) out[relay] = { token: entry.token, accountId: entry.accountId, createdAt: entry.createdAt };
  return out;
}

/** Write the file whole: a fresh `0600` file, renamed over the old one. */
export function writeCredentials(creds: CredentialsFile, file = credentialsPath()) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  // `wx`: made here, now, with this mode, never an existing file someone else could read.
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(creds, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}

/** The token this machine holds for a relay (any address `relayOrigin` reads), or null. */
export function credentialFor(relay: string, file = credentialsPath()): Entry | null {
  return readCredentials(file)[relayOrigin(relay)] ?? null;
}
