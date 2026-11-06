/**
 * A `recheck` job on the runner (the relay asks for it): checking a fact's sources again in a
 * checkout of the seat's repository, and reporting counts and a commit, never a line of a file.
 *
 * The runner runs nothing for a recheck unless **all** of these hold, in this order, and reports
 * every other one `refused` with the reason of the first that failed, as the dispatch check does
 * for a seat's job (runner/dispatch.ts):
 * 1. The payload opens (`openRecheckJob`) under this runner's X25519 key and the AAD of this
 *    runner, the lease's job id and the kind `recheck`. A `start_seat` payload never opens as one.
 *    (`bad_seal`, `envelope_mismatch`)
 * 2. Its seat is the lease's, the lease names no room and no participant, and its relay is the one
 *    this runner registered with. (`envelope_mismatch`, `wrong_relay`)
 * 3. Its seat is one of this runner's, configured now and not paused. (`unknown_seat`, `seat_paused`)
 * 4. It was issued within the last 24 hours and no more than 5 minutes ahead of this clock.
 *    (`stale`, `future`)
 * 5. This runner has run fewer than `RECHECKS_PER_HOUR` rechecks in the last hour. (`rate_limited`)
 *
 * **What it reads.** A recheck carries a source and a packet body, both of the relay's choosing,
 * and the seal does not say who made it. Unchecked, a recheck would answer "are these lines in this
 * file?" for any lines and any file of the team's repository. So a source is read only when this
 * seat's own outbound ledger (`runner.db` `outbound`, runner/ledger.ts) holds a packet the seat let
 * out (`sent`, or `released` after review) with that very source and a body of that sha256: a
 * recheck tells the relay only whether what the seat already shared still stands. Every other
 * source is reported `unchecked`, unread.
 *
 * **Where.** In `<home>/jobs/<jobId>/repo`, a checkout of the seat's directory at the ref a new job
 * of the seat answers from (`refFor`, else `seat.ref`), made as a seat's job's is
 * (runner/worktree.ts `prepareCheckout`), and removed with its directory once the report is sent,
 * whatever came of it. A runner that dies meanwhile leaves the directory to the next boot's sweep.
 * Each source is read on its own, the event loop let go between them, since each may run git for a
 * few seconds.
 *
 * A runner that predates the kind never gets here: its client cannot parse the lease entry and
 * refuses it by id as `bad_seal` (runner/client.ts `lease`).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { JobUpdateInput, LeasedJob, RecheckPayload, RecheckReport, RunnerReason } from '@parley/shared/runner';
import { JobSealError, openRecheckJob } from '../jobseal.js';
import { runRecheck } from '../record/recheck-run.js';
import { sameRelay } from './client.js';
import { type SeatConfig, seatDir } from './config.js';
import { ISSUED_MAX_AGE_MS, ISSUED_MAX_AHEAD_MS } from './dispatch.js';
import type { RunnerStore } from './store.js';
import { type Checkout, prepareCheckout, removeJobDir } from './worktree.js';

/** Rechecks one runner runs in an hour, over all its seats. A relay asking for more is refused `rate_limited`. */
export const RECHECKS_PER_HOUR = 60;

/** Why a recheck was refused: the dispatch check's reasons that apply to a job naming no room. */
export type RecheckRefusal = Extract<
  RunnerReason,
  'bad_seal' | 'envelope_mismatch' | 'wrong_relay' | 'unknown_seat' | 'seat_paused' | 'stale' | 'future' | 'rate_limited'
>;

/** What a recheck needs of the runner's store. */
export interface RecheckStore {
  requireIdentity(): { runnerId: string; x25519Private: string; relay: string };
  seatById(seatId: string): { label: string; pausedAt: string | null } | null;
  /** Whether the seat let out a packet with this source and a body of this sha256 (hex): sent, or released after review. */
  letOut(label: string, source: string, bodySha256: string): boolean;
}

/** The store's side of a recheck, over runner.db: its identity, its seats and its outbound ledger. */
export function recheckStoreOf(store: RunnerStore): RecheckStore {
  const sent = store.db.prepare(
    "SELECT 1 AS ok FROM outbound WHERE label = ? AND op = 'share_context' AND decision IN ('sent', 'released') AND sha256 = ? AND source = ? LIMIT 1",
  );
  return {
    requireIdentity: () => store.requireIdentity(),
    seatById: (seatId) => store.seatById(seatId),
    letOut: (label, source, sha) => sent.get(label, sha, source) !== undefined,
  };
}

/** What a recheck needs of the host: the seats as configured now, where jobs go, and the relay. */
export interface RecheckEnv {
  home: string;
  seats(): readonly SeatConfig[];
  /** The ref a new job of the seat answers from; `seat.ref` when absent. Throwing fails the recheck. */
  refFor?(seat: SeatConfig): string | undefined;
  /** `POST /api/runner/jobs/:id`. */
  report(jobId: string, update: JobUpdateInput): Promise<unknown>;
  /** Takes one recheck from this hour's allowance, answering false when none is left. */
  allow?(): boolean;
  now?(): number;
  /** One line for the operator: never a source, a body or a path the relay sent. */
  log?(line: string): void;
}

export type RecheckVerdict = { ok: true; payload: RecheckPayload; seat: SeatConfig } | { ok: false; reason: RecheckRefusal };

/** Checks 1 to 4 on one leased recheck. Reads nothing of the team's files and reports nothing. */
export function checkRecheck(leased: LeasedJob, store: RecheckStore, env: Pick<RecheckEnv, 'seats' | 'now'>): RecheckVerdict {
  const refuse = (reason: RecheckRefusal): RecheckVerdict => ({ ok: false, reason });
  if (leased.kind !== 'recheck') return refuse('envelope_mismatch');
  const id = store.requireIdentity();
  let p: RecheckPayload;
  try {
    p = openRecheckJob(leased.payload, id.x25519Private, { runnerId: id.runnerId, jobId: leased.id, kind: 'recheck' });
  } catch (e) {
    return refuse(e instanceof JobSealError ? e.reason : 'bad_seal');
  }
  if (p.seatId !== leased.standingSeatId || leased.sessionId !== null || leased.participantId !== null) return refuse('envelope_mismatch');
  if (!sameRelay(p.relay, id.relay)) return refuse('wrong_relay');
  const row = store.seatById(p.seatId);
  const seat = row ? env.seats().find((s) => s.label === row.label) : undefined;
  if (!row || !seat) return refuse('unknown_seat');
  if (row.pausedAt || seat.paused) return refuse('seat_paused');
  const now = env.now?.() ?? Date.now();
  const issued = Date.parse(p.issuedAt);
  if (!Number.isFinite(issued) || now - issued > ISSUED_MAX_AGE_MS) return refuse('stale');
  if (issued - now > ISSUED_MAX_AHEAD_MS) return refuse('future');
  return { ok: true, payload: p, seat };
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

export type RecheckOutcome =
  | { ok: true; report: RecheckReport; read: number }
  | { ok: false; reason: RecheckRefusal | 'error' }
  /** The report did not reach the relay: the job comes back after its lease, to be checked again. */
  | { ok: false; unreported: true };

/**
 * One leased recheck, start to end: the checks, then each source the seat let out read in a
 * checkout at its answering ref, then the report. Never throws.
 */
export async function runRecheckJob(leased: LeasedJob, store: RecheckStore, env: RecheckEnv): Promise<RecheckOutcome> {
  const short = `${leased.id.slice(0, 12)}…`;
  const log = (line: string) => env.log?.(`recheck ${short}: ${line}`);
  const send = async (update: JobUpdateInput): Promise<boolean> => {
    try {
      await env.report(leased.id, update);
      return true;
    } catch (e) {
      log(`the relay did not take its report (${e instanceof Error ? e.name : 'error'}); it comes back after its lease`);
      return false;
    }
  };
  let v: RecheckVerdict;
  try {
    v = checkRecheck(leased, store, env);
  } catch {
    // The runner could not check (its store, its identity): nothing read, nothing refused.
    log('not checked; left for the next lease');
    return { ok: false, unreported: true };
  }
  if (v.ok && env.allow && !env.allow()) v = { ok: false, reason: 'rate_limited' };
  if (!v.ok) {
    log(`refused, ${v.reason}`);
    return (await send({ state: 'refused', reason: v.reason })) ? v : { ok: false, unreported: true };
  }
  const { payload, seat } = v;
  const req = payload.request;
  const results: RecheckReport['results'] = req.sources.map((s) => ({ idx: s.idx, status: 'unchecked', commit: null }));
  // Only what this seat already let out, with that source and that body: anything else stays unread.
  const ours = req.sources.filter((s) => store.letOut(seat.label, s.source, sha256(s.body)));
  if (ours.length) {
    const jobDir = path.join(env.home, 'jobs', leased.id);
    let checkout: Checkout | null = null;
    try {
      if (existsSync(jobDir)) await removeJobDir(jobDir);
      mkdirSync(jobDir, { recursive: true });
      checkout = await prepareCheckout({ dir: seatDir(seat, env.home), jobDir, mode: seat.checkout, ref: env.refFor ? env.refFor(seat) : seat.ref });
      for (const s of ours) {
        const [r] = runRecheck(checkout.cwd, { ...req, sources: [s] }, checkout.commit ?? undefined).results;
        const at = results.findIndex((x) => x.idx === s.idx);
        if (r && at >= 0) results[at] = r;
        await breathe();
      }
    } catch (e) {
      log(`could not check out ${seat.label} (${e instanceof Error ? e.name : 'error'})`);
      await removeJobDir(jobDir, checkout).catch(() => {});
      return (await send({ state: 'failed', reason: 'error' })) ? { ok: false, reason: 'error' } : { ok: false, unreported: true };
    }
    await removeJobDir(jobDir, checkout).catch((e) => log(`could not remove its directory (${(e as Error).name})`));
  }
  const report: RecheckReport = { factId: req.factId, results };
  log(`${seat.label}: ${req.sources.length} source(s), ${ours.length} the seat let out, read`);
  return (await send({ state: 'done', recheck: report })) ? { ok: true, report, read: ours.length } : { ok: false, unreported: true };
}

/** `RECHECKS_PER_HOUR`, in memory: a sliding hour of the rechecks this process ran. */
export function hourlyAllowance(max = RECHECKS_PER_HOUR, now: () => number = Date.now): () => boolean {
  const taken: number[] = [];
  return () => {
    const t = now();
    while (taken.length && t - taken[0]! >= 3_600_000) taken.shift();
    if (taken.length >= max) return false;
    taken.push(t);
    return true;
  };
}
