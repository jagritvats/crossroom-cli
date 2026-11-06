/**
 * Rooms the command opens go into the signed-in account too, as the web's "Keep it longer?" puts a
 * browser's rooms there: `POST /api/account/rooms` with `{rooms: [{id, owner}]}`, the route that
 * checks each owner token against its room (`unlockAsOwner`) before wrapping it in the account's
 * custody. Then the room is on the Rooms page in any browser signed in to that account, and kept as long as the account holds it.
 *
 * - Only to the instance that issued the room, and only with the account's own credential for
 *   that instance: `CROSSROOM_API_KEY` when the instance it names (`--relay`, `CROSSROOM_URL`, else
 *   the hosted one) is the room's, else the token `crossroom login` kept for exactly that origin.
 *   A machine signed in nowhere, or elsewhere, sends nothing.
 * - Never fails the command. A refusal or a network failure is one line on stderr, and the room
 *   stays on this computer, where `crossroom rooms --keep` offers it again.
 * - `--no-keep`, or `CROSSROOM_KEEP=0`, keeps a room on this computer only.
 * - Like every request carrying a token, none follows a redirect, and nothing here prints a token.
 *
 * The route takes 50 rooms a request and 30 requests a minute an account on the relay, so
 * `rooms --keep` sends at most 50 at a time and stops at the first refusal.
 */
import { API_TOKEN } from '@parley/shared/accounts';
import type { AccountRoomsResult } from '@parley/shared/accounts';
import { type Args, type SavedRoom, savedRooms } from '../cli.js';
import { credentialFor, DEFAULT_RELAY, relayOrigin } from './credentials.js';
import { API_KEY_ENV, chosenInstance, type FetchLike, realFetch } from './relay-call.js';

/** `CROSSROOM_KEEP=0` (or `off`, `no`, `false`): never put a room this command opens into the account. */
export const KEEP_ENV = 'CROSSROOM_KEEP';
/** What the route takes in one request (`AccountRoomsInput`'s `.max(50)`). */
const KEEP_MAX = 50;
/** A room opened is already printed; the account's copy is not worth holding the command up long. */
const KEEP_TIMEOUT_MS = 8_000;

/** Whether this run keeps its rooms on this computer only. */
export function keepingOff(args: Args, env: NodeJS.ProcessEnv = process.env): boolean {
  if (args.flags['no-keep'] === true) return true;
  return /^(0|off|no|false)$/i.test(env[KEEP_ENV]?.trim() ?? '');
}

/** The host a room's instance answers on, for what is printed. */
const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * The account's credential for exactly the instance at `base`, or null. Never one for another
 * instance: an owner token goes only to the server that issued it.
 */
export function credentialForInstance(args: Args, base: string, env: NodeJS.ProcessEnv = process.env): { token: string; via: 'env' | 'login' } | null {
  let origin: string;
  try {
    origin = relayOrigin(base);
  } catch {
    return null;
  }
  const key = env[API_KEY_ENV]?.trim();
  if (key) {
    if (!API_TOKEN.test(key)) return null;
    let named: string;
    try {
      named = chosenInstance(args, DEFAULT_RELAY, env);
    } catch {
      return null;
    }
    return named === origin ? { token: key, via: 'env' } : null;
  }
  try {
    const held = credentialFor(origin);
    return held ? { token: held.token, via: 'login' } : null;
  } catch {
    return null;
  }
}

export type KeepOutcome = { ok: true; added: string[] } | { ok: false; why: string };

/** Put rooms on one instance into the account, 50 a request. Never throws. */
export async function keepRooms(base: string, token: string, rooms: readonly Pick<SavedRoom, 'id' | 'owner'>[], fetchImpl: FetchLike = realFetch): Promise<KeepOutcome> {
  const added: string[] = [];
  for (let i = 0; i < rooms.length; i += KEEP_MAX) {
    const chunk = rooms.slice(i, i + KEEP_MAX).map((r) => ({ id: r.id, owner: r.owner }));
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/account/rooms`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ rooms: chunk }),
        redirect: 'error',
        signal: AbortSignal.timeout(KEEP_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, why: (e as Error)?.name === 'TimeoutError' ? `${hostOf(base)} did not answer in time` : `${hostOf(base)} could not be reached` };
    }
    const body = (await res.json().catch(() => null)) as (Partial<AccountRoomsResult> & { error?: unknown }) | null;
    if (!res.ok) {
      const why =
        res.status === 401
          ? `${hostOf(base)} no longer knows this sign-in`
          : res.status === 429
            ? `${hostOf(base)} asked to slow down`
            : `${hostOf(base)} refused (${typeof body?.error === 'string' ? body.error.slice(0, 120) : `HTTP ${res.status}`})`;
      return added.length ? { ok: true, added } : { ok: false, why };
    }
    for (const id of Array.isArray(body?.added) ? body.added : []) if (typeof id === 'string') added.push(id);
  }
  return { ok: true, added };
}

/**
 * After a command: offer the rooms it opened to the signed-in account, a line on stderr for each
 * instance it had a sign-in for. Silent where this computer is signed in nowhere that matches.
 */
export async function keepOpened(args: Args, rooms: readonly SavedRoom[], say: (line: string) => void, o: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const env = o.env ?? process.env;
  if (!rooms.length || keepingOff(args, env)) return;
  for (const [base, group] of byInstance(rooms)) {
    const cred = credentialForInstance(args, base, env);
    if (!cred) continue;
    const r = await keepRooms(base, cred.token, group, o.fetchImpl);
    const host = hostOf(base);
    const one = group.length === 1;
    if (r.ok && r.added.length === group.length)
      say(`Kept in your account on ${host}: ${one ? 'it shows' : 'they show'} in Rooms in any browser signed in there. (--no-keep keeps a room here only.)`);
    else if (r.ok)
      say(`Kept ${r.added.length} of ${group.length} rooms in your account on ${host}; the rest are on this computer only. \`crossroom rooms --keep\` tries again.`);
    else say(`Not kept in your account (${r.why}); the room is on this computer only. \`crossroom rooms --keep\` tries again.`);
  }
}

function byInstance(rooms: readonly SavedRoom[]): Map<string, SavedRoom[]> {
  const out = new Map<string, SavedRoom[]>();
  for (const r of rooms) {
    let base: string;
    try {
      base = relayOrigin(r.base);
    } catch {
      continue;
    }
    out.set(base, [...(out.get(base) ?? []), r]);
  }
  return out;
}

/**
 * `crossroom rooms --keep`: every room this computer keeps the owner key for (the command's own and
 * crew rooms opened here, never a paired device's), put into the account on its own instance. The
 * lines to print, one an instance.
 */
export async function keepSaved(args: Args, o: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv; rooms?: SavedRoom[] } = {}): Promise<string[]> {
  const env = o.env ?? process.env;
  const rooms = (o.rooms ?? savedRooms()).filter((r) => r.pool !== 'crew-device');
  if (!rooms.length) return ['This computer keeps no rooms.'];
  const lines: string[] = [];
  for (const [base, group] of byInstance(rooms)) {
    const host = hostOf(base);
    const cred = credentialForInstance(args, base, env);
    const n = `${group.length} room${group.length === 1 ? '' : 's'}`;
    if (!cred) {
      lines.push(`${n} on ${host}: this computer is not signed in there. Run \`crossroom login --relay ${base}\`, then this again.`);
      continue;
    }
    const r = await keepRooms(base, cred.token, group, o.fetchImpl);
    if (!r.ok) lines.push(`${n} on ${host}: not kept (${r.why}).`);
    else {
      const gone = group.length - r.added.length;
      lines.push(
        `${r.added.length} of ${n} on ${host} kept in your account.${gone ? ` ${gone} could not be: deleted since, or no longer opened by the key kept here.` : ''}`,
      );
    }
  }
  return lines;
}
