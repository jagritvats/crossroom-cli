/**
 * `crossroom wait <seat link> [--for <seconds>] [--json]`: a seat's `wait`, made again and again
 * until something arrives worth reading, the room ends, or `--for` runs out.
 *
 * An agent holding a seat used to make the call by hand with curl every 45 to 90 seconds, and a
 * deploy or network blip in between answered 502, or the edge's plain `404 page not found`, which
 * read like the room was gone. This command does the loop and the retries:
 *
 * - **What it prints** on a delivery is the seat's own `wait` text, fenced for agents as always:
 *   the call goes out as `?format=json` and the answer is rendered with the server's own renderer
 *   (`renderWait`, as `crossroom op` does), so an empty answer can be told apart and asked again
 *   without moving anything. `--json` prints the server's JSON answer as it came.
 * - **How long.** `--for` defaults to `WAIT_FOR_DEFAULT_S` and takes at most `WAIT_FOR_MAX_S`, under
 *   the 120 s after which Claude Code moves a shell command to the background. Running out prints
 *   the last empty answer and a line saying to run it again, and exits 0.
 * - **What it retries**, quietly, with backoff: no answer at all, 502, 503, 504 and the CDN's 52x,
 *   and an answer that is not Crossroom's (the edge's `404 page not found`, its rate limit's bare
 *   429). Crossroom's own refusals (401 for a revoked link, its `Not a Crossroom seat link` 404, 409
 *   for an ended room, 410 for a replaced link) end the command with that refusal and exit 1.
 * - **A hang-up rewinds.** The server puts its delivery cursor back when the caller of a `wait`
 *   hangs up (hangup.ts), so Ctrl-C or SIGTERM aborts the request in flight rather than leaving it
 *   to the process's exit. Every pause is a ref'd timer: an unref'd one lets Node exit under
 *   cli-main.ts's top-level await.
 * - **Where.** An https link, or http on this machine's loopback; no request follows a redirect.
 *   An end-to-end room's link (`#e=`) is the seat helper's, and the room is asked about with a
 *   `status` (a GET that moves nothing) before the first `wait`, so a link whose key was left off
 *   never takes a delivery it cannot read. Nothing it prints holds more of the link than its origin.
 */
import { helperCommand } from '@parley/shared/e2ee';
import { linkOfPrompt } from '@parley/shared/deeplink';
import { NOT_FOUND } from '@parley/shared/protocol';
import { renderWait, type WaitData } from '@parley/shared/render';
import { type Args, Usage } from '../cli.js';
import { JoinUsage, parseSeatLink } from '../runner/join.js';
import { isLoopbackHost } from './credentials.js';
import { registerCommand } from './index.js';

/** How long the command waits when `--for` names nothing, and the most it may name. */
export const WAIT_FOR_DEFAULT_S = 100;
export const WAIT_FOR_MAX_S = 110;
/** The least `--for` may name, and the least one server `wait` parks for (its floor). */
const WAIT_FOR_MIN_S = 5;
/** The most one server `wait` is asked for: under the hosted edge's 100 s to a first byte. */
const CALL_MAX_S = 85;
/** How long past its parking time one call may take before it counts as unanswered. */
const CALL_SLACK_MS = 10_000;
/** The pauses between retries, doubling up to the last. */
const BACKOFF_MS = [1000, 2000, 4000, 8000];

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface WaitOptions {
  /** Seconds to keep waiting for, already bounded. */
  forS?: number;
  json?: boolean;
  fetchImpl?: Fetch;
  /** Aborted to stop at once (Ctrl-C): the request in flight is aborted too. */
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The command to run again, as its text names it: `crossroom op wait` for a seat held through `crossroom op`. */
  again?: string;
}

export interface WaitResult {
  code: number;
  out: string;
  err: string;
}

/** Thrown when the caller stopped the command. */
class Stopped extends Error {}

/** A ref'd pause that ends early when `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The seat's address without its token's trailing slash or any fragment, and its origin. */
export function waitTarget(raw: string): { base: string; origin: string } {
  const given = linkOfPrompt(raw) ?? raw.trim();
  if (/#(?:.*&)?e=/.test(given))
    throw new Usage(
      `That seat is in an end-to-end encrypted room, which only Crossroom's seat helper can read. Wait with it instead, using the full link:\n  ${helperCommand('<your full seat link, including #e=...>', 'wait')}`,
    );
  let parsed: { relay: string; token: string };
  try {
    parsed = parseSeatLink(given);
  } catch (e) {
    if (e instanceof JoinUsage) throw new Usage(e.message);
    throw e;
  }
  const u = new URL(parsed.relay);
  if (u.username || u.password) throw new Usage('A seat link carries no user name or password.');
  if (u.protocol !== 'https:' && !isLoopbackHost(u.hostname)) throw new Usage('A seat link is https, or plain http on this computer only (localhost or 127.x).');
  return { base: `${parsed.relay}/j/${parsed.token}`, origin: u.origin };
}

/** One call's outcome: an answer to read, a blip to retry, or Crossroom's own refusal. */
type Attempt =
  | { kind: 'answer'; body: { ok: true; e2ee?: boolean; data: unknown } & Record<string, unknown> }
  | { kind: 'blip'; why: string }
  | { kind: 'refused'; status: number; message: string };

const BLIP_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

async function attempt(fetchImpl: Fetch, url: string, init: RequestInit, timeoutMs: number, stop: AbortSignal | undefined): Promise<Attempt> {
  if (stop?.aborted) throw new Stopped();
  const ctl = new AbortController();
  const onStop = () => ctl.abort();
  stop?.addEventListener('abort', onStop, { once: true });
  // A ref'd timer of its own: AbortSignal.timeout's is unref'd.
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(url, { ...init, redirect: 'error', signal: ctl.signal });
      text = await res.text();
    } catch (e) {
      if (stop?.aborted) throw new Stopped();
      return { kind: 'blip', why: ctl.signal.aborted ? 'no answer in time' : `no answer (${(e as Error).message || 'network error'})` };
    }
    if (BLIP_STATUS.has(res.status)) return { kind: 'blip', why: `HTTP ${res.status}` };
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const b = body as { ok?: unknown; error?: unknown; data?: unknown } | null;
    if (b && typeof b === 'object' && b.ok === true && 'data' in b) return { kind: 'answer', body: b as never };
    if (b && typeof b === 'object' && b.ok === false)
      return { kind: 'refused', status: res.status, message: typeof b.error === 'string' && b.error ? b.error : `HTTP ${res.status}` };
    // Crossroom's own answer for a path under /j that names no seat is this text, not JSON.
    if (text === NOT_FOUND.seatLink || text.startsWith(NOT_FOUND.seatLink.trimEnd())) return { kind: 'refused', status: res.status, message: text.trim() };
    // Anything else that is not Crossroom's JSON came from something in front of it: the edge's
    // `404 page not found` while a deploy swaps containers, its rate limit's bare 429, a CDN page.
    if (res.status === 404 || res.status === 408 || res.status === 429 || res.status >= 500 || res.ok) return { kind: 'blip', why: `HTTP ${res.status}, not Crossroom's answer` };
    return { kind: 'refused', status: res.status, message: `Unexpected answer (HTTP ${res.status}).` };
  } finally {
    clearTimeout(timer);
    stop?.removeEventListener('abort', onStop);
  }
}

/** An answer worth handing back: something arrived, the room ended, or the server says the seat may stop. */
function worthReporting(d: WaitData): boolean {
  return d.events.length > 0 || d.status === 'ended' || d.lane === true || (d.invited?.length ?? 0) > 0 || (d.teamAnswer?.length ?? 0) > 0;
}

export async function waitSeat(link: string, o: WaitOptions = {}): Promise<WaitResult> {
  const { base, origin } = waitTarget(link);
  const forS = o.forS ?? WAIT_FOR_DEFAULT_S;
  const fetchImpl: Fetch = o.fetchImpl ?? ((u, i) => fetch(u, i));
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? pause;
  const again = o.again ?? '`crossroom wait`';
  const started = now();
  const deadline = started + forS * 1000;
  const waited = () => Math.round((now() - started) / 1000);

  let lastBlip = '';
  let blips = 0;
  let lastEmpty: { body: Record<string, unknown>; data: WaitData } | null = null;
  // Wait out a blip, then say whether there is time for another call.
  const backOff = async (why: string): Promise<boolean> => {
    lastBlip = why;
    const ms = Math.min(BACKOFF_MS[Math.min(blips, BACKOFF_MS.length - 1)]!, Math.max(0, deadline - now()));
    blips++;
    await sleep(ms, o.signal);
    if (o.signal?.aborted) throw new Stopped();
    return deadline - now() >= WAIT_FOR_MIN_S * 1000;
  };
  const refused = (a: { status: number; message: string }): WaitResult => ({
    code: 1,
    out: o.json ? JSON.stringify({ ok: false, status: a.status, error: a.message }) : '',
    err: `Crossroom at ${origin} refused the wait (HTTP ${a.status}): ${a.message}`,
  });

  try {
    // First a status, which moves nothing: the token is checked, and an end-to-end room is found
    // before any `wait` hands this seat a delivery it could not read.
    for (;;) {
      const a = await attempt(fetchImpl, `${base}/status?format=json`, { method: 'GET' }, 15_000, o.signal);
      if (a.kind === 'refused') return refused(a);
      if (a.kind === 'answer') {
        if (a.body.e2ee === true)
          return {
            code: 1,
            out: '',
            err: `This seat's room is end-to-end encrypted, and the link has no key. Wait with Crossroom's seat helper and the full link you were given:\n  ${helperCommand('<your full seat link, including #e=...>', 'wait')}`,
          };
        blips = 0;
        break;
      }
      if (!(await backOff(a.why))) return unreachable();
    }
    // The first wait is made however little time the status left: `--for 5` still asks once.
    for (let asked = false; ; asked = true) {
      const left = Math.max(deadline - now(), asked ? 0 : WAIT_FOR_MIN_S * 1000);
      if (left < WAIT_FOR_MIN_S * 1000) break;
      const secs = Math.max(WAIT_FOR_MIN_S, Math.min(CALL_MAX_S, Math.floor(left / 1000)));
      const callMs = Math.min(secs * 1000 + CALL_SLACK_MS, left + 5000);
      const a = await attempt(
        fetchImpl,
        `${base}/wait?format=json`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeout_seconds: secs }) },
        callMs,
        o.signal,
      );
      if (a.kind === 'refused') return refused(a);
      if (a.kind === 'blip') {
        if (!(await backOff(a.why))) break;
        continue;
      }
      blips = 0;
      lastBlip = '';
      const data = a.body.data as WaitData;
      if (worthReporting(data)) return { code: 0, out: o.json ? JSON.stringify(a.body) : renderWait(data), err: '' };
      lastEmpty = { body: a.body, data };
    }
  } catch (e) {
    if (e instanceof Stopped) return { code: 130, out: '', err: 'Stopped. Anything the room had for this seat is still waiting for it.' };
    throw e;
  }
  return lastEmpty ? nothingYet(lastEmpty) : unreachable();

  function nothingYet(last: { body: Record<string, unknown>; data: WaitData }): WaitResult {
    const secs = waited();
    if (o.json) return { code: 0, out: JSON.stringify({ ...last.body, data: { ...last.data, secs }, again: true }), err: '' };
    const blip = lastBlip ? ` Crossroom did not answer the last call (${lastBlip}); nothing for your seat is lost.` : '';
    return { code: 0, out: `${renderWait({ ...last.data, secs })}\n\nNothing yet.${blip} Run the same ${again} command again.`, err: '' };
  }

  function unreachable(): WaitResult {
    const secs = waited();
    const why = lastBlip || 'no answer';
    if (o.json) return { code: 0, out: JSON.stringify({ ok: false, again: true, unreachable: true, waited: secs, error: why }), err: '' };
    return {
      code: 0,
      out: `(no answer from ${origin} for ${secs}s: ${why}) That is usually a deploy or a network blip, not the room ending: the room and anything waiting for your seat are kept. Run the same ${again} command again.`,
      err: '',
    };
  }
}

/** `--for` as a number of seconds within the bounds, or a `Usage` naming them. */
export function waitFor(raw: string | undefined): number {
  if (raw === undefined) return WAIT_FOR_DEFAULT_S;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isFinite(n) || n < WAIT_FOR_MIN_S || n > WAIT_FOR_MAX_S)
    throw new Usage(`--for takes a whole number of seconds from ${WAIT_FOR_MIN_S} to ${WAIT_FOR_MAX_S}, under the 120 s after which an agent's shell may move a command to the background.`);
  return n;
}

registerCommand({
  name: 'wait',
  topic: 'plugin',
  usage: 'crossroom wait <seat link> [--for <seconds>] [--json]',
  summary: "a seat's wait, asked again until something arrives; blips retried quietly",
  order: 112,
  async run(args: Args, say) {
    const link = args.positional[0];
    if (!link) throw new Usage('Usage: crossroom wait <seat link> [--for <seconds>] [--json]');
    const given = args.flags.for;
    if (given === true) throw new Usage('--for takes a number of seconds.');
    const forS = waitFor(given);
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const r = await waitSeat(link, { forS, json: args.flags.json === true, signal: ctl.signal });
      if (r.out) console.log(r.out.replace(/\n$/, ''));
      if (r.err) say(r.err.replace(/\n$/, ''));
      return r.code;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  },
});
