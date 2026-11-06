/**
 * The dispatch check: whether this runner starts an agent for a job its
 * relay leased it. The runner starts nothing unless **all** of these hold, in this order, and
 * reports every other job `refused` with the reason of the first check it failed:
 *
 * 1. The payload opens (`openJob`) under this runner's X25519 key and the AAD of this runner, the
 *    lease's job id and its kind. (`bad_seal`)
 * 2. The payload's runner, id, kind, seat, room and participant are the lease's, and its relay is
 *    the one this runner registered with. (`envelope_mismatch`, `wrong_relay`)
 * 3. Its seat is one of this runner's, configured now and not paused. A seat removed from the config
 *    is unknown. (`unknown_seat`, `seat_paused`)
 * 4. `sha256(ask.token)` is an ask token this runner minted for that seat, not retired, at the
 *    payload's epoch, and the seat's policy takes asks through its link (`may_ask.ask_links`).
 *    (`ask_unknown`, `ask_retired`, `ask_epoch`, `grant_refused`) Or, for a job across a connection
 *    between organisations, which carries no ask token: the seat's configuration lists the grant it
 *    names on that connection, at an epoch no older than it accepts (connections/runner-check.ts).
 *    (`grant_refused`) Or, for a job a project's playbook dispatched (seat dispatch
 *    on the relay), which carries a `may_ask` grant instead: this runner minted that
 *    grant for that seat and that very principal, and the relay holds it live (`GrantBook.check`).
 *    (`grant_refused`) Or, for a side room an agent called the seat into from a room its account
 *    holds (an account's own agents), which carries the account and the call instead: the relay
 *    said at the seat's last grants' sync that the account holds a live grant to it
 *    (`GrantBook.checkCall`; a call naming an account the book lacks syncs the seat's grants once
 *    first, so a grant made since the runner started counts). (`grant_refused`)
 * 5. The job id is new here, and so is its seat of its room. (`replayed_job`, `replayed_seat`)
 * 6. It was issued within the last 24 hours and no more than 5 minutes ahead of this clock.
 *    (`stale`, `future`)
 * 7. The seat's local limits hold: `concurrent` live jobs, and `per_hour` and `per_day` taken; for
 *    a job across a connection, the grant's too, the stricter of the job's and the configuration's,
 *    from this runner's own count of the jobs it took through that grant. (`rate_limited`)
 * 8. `GET /api/seat` with the payload's seat token answers that very participant of that very room,
 *    a standing seat under this seat's label, in a live room that is not end-to-end, and not
 *    finished or left. (`seat_mismatch`) For a job with a grant, the room the page puts it in
 *    (`dispatchRoom`) is in the project the grant names; a page that names no project refuses it.
 *    (`grant_refused`, check 4's reason: the grant does not open this room)
 *
 * What each check stops. The seal (1) is not a signature: anyone with the runner's public key can
 * seal a job to it, so it proves only that the job was made for this runner. The ask token (4) is
 * what proves the room came from a link this runner issued, at an epoch it has not rotated away
 * from; the relay holds only its hash, but the asker holds the token, so it alone proves nothing
 * about the room either. The seat page (8) is what proves the relay really holds a live standing
 * seat for this token, in the room the job names: only a relay that made that room can answer it.
 * Replays (5) and age (6) stop an old job, leased again or copied, from starting a second agent.
 *
 * A payload never carries a directory, a command, a flag, a model, a prompt or a policy: those are
 * all this runner's own configuration, so there is nothing in a job to check them against.
 *
 * Checks 5 and 7 and the reservation that follows them run in one transaction, and the job is held
 * as `checking` while check 8 reads the seat page, so two leases of one job, or of two jobs past a
 * limit, cannot both pass. A seat page the relay could not answer (a network error, a 5xx, a 429)
 * refuses nothing: the reservation is dropped and the job comes back when its lease runs out.
 * Checks 3 and 4 are made again in the transaction that accepts the job, because reading the seat
 * page takes a while: a seat paused, removed or rotated in that time (`crossroom runner pause` in
 * another process, say) refuses the job rather than start it for a link that is already dead.
 *
 * A job id this runner already holds is looked up before anything else. That job is this runner's
 * whatever has changed about its seat since (paused, taken out of the configuration, rekeyed), so a
 * lease of it again is a replay and never a refusal of a job that may be running here.
 */
import type { DispatchRoom, LeasedJob, RunnerReason, SeatBudget } from '@parley/shared/runner';
import { checkConnectionJob, type SeatConnectionGrant } from '../connections/runner-check.js';
import { JobSealError, openJob } from '../jobseal.js';
import { RelayError, type SeatPage, sameRelay } from './client.js';
import { type GrantBook, projectOf } from './grants.js';
import { askHash, redactTokens } from './keys.js';
import type { JobRow, RunnerStore, SeatRow } from './store.js';

/** The reasons the dispatch check refuses a job for, each with the check that gives it. */
export const DISPATCH_CHECKS = {
  bad_seal: 1,
  envelope_mismatch: 2,
  wrong_relay: 2,
  unknown_seat: 3,
  seat_paused: 3,
  ask_unknown: 4,
  ask_retired: 4,
  ask_epoch: 4,
  grant_refused: 4,
  replayed_job: 5,
  replayed_seat: 5,
  stale: 6,
  future: 6,
  rate_limited: 7,
  seat_mismatch: 8,
} as const satisfies Partial<Record<RunnerReason, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8>>;
export type DispatchRefusal = keyof typeof DISPATCH_CHECKS;

/** How old a job may be when it arrives, and how far ahead of this runner's clock. */
export const ISSUED_MAX_AGE_MS = 24 * 60 * 60_000;
export const ISSUED_MAX_AHEAD_MS = 5 * 60_000;

/** One seat as this runner's configuration has it now (runner.yml): the check's view of it. */
export interface DispatchSeat {
  label: string;
  /** The local rate limits, from the seat's policy budget. */
  budget: Pick<SeatBudget, 'concurrent' | 'perHour' | 'perDay'>;
  /** Paused in the configuration, as well as by `crossroom runner pause` (the store's `paused_at`). */
  paused?: boolean;
  /**
   * False when the seat's policy file takes no asks through the seat's own link (`may_ask.ask_links:
   * false`, runner/policy-yml.ts), so a job an ask link opened is refused at check 4. The same rule
   * as `GrantBook.check` for a job with no grant (runner/grants.ts); no payload carries a grant yet.
   */
  askLinks?: boolean;
  /** The grants this seat answers through across a connection (runner.yml `connections`). None: it takes no such job. */
  connections?: readonly SeatConnectionGrant[];
}

/** A job that passed: what the host needs to start its agent. The seat token goes to the egress proxy only. */
export interface AcceptedJob {
  id: string;
  kind: LeasedJob['kind'];
  label: string;
  seatId: string;
  sessionId: string;
  participantId: string;
  seatToken: string;
  /** '' for a job across a connection or through a grant. */
  askHash: string;
  /** The grant's principal a job came through: `project:<id>` for a playbook's, `account:<id>` for a call, or null. */
  grantPrincipal: string | null;
  relay: string;
  issuedAt: string;
}

export type DispatchVerdict =
  | { ok: true; job: AcceptedJob }
  | {
      ok: false;
      reason: DispatchRefusal;
      check: (typeof DISPATCH_CHECKS)[DispatchRefusal];
      /** For a replayed job id: the job this runner already holds under it. */
      known?: JobRow;
    }
  /** The seat page could not be read: nothing refused, nothing kept; the job comes back after its lease. */
  | { ok: false; retry: true; why: string };

export interface DispatchContext {
  store: RunnerStore;
  /**
   * The seats configured now. A seat in the store but not here has been removed. A function is
   * asked again when the job is accepted, so a configuration reloaded during check 8 counts.
   */
  seats: readonly DispatchSeat[] | (() => readonly DispatchSeat[]);
  /** `GET /api/seat` with a seat token (`RelayClient.seatPage`). */
  readSeat: (seatToken: string) => Promise<SeatPage>;
  /**
   * Whether the host holds a runner key its job's route opens end-to-end rooms with
   * (runner/e2ee-egress.ts). Absent or false: a seat in an end-to-end room is refused, as before.
   */
  e2ee?: boolean;
  /**
   * The `may_ask` grants this runner minted, as hashes (runner/grants.ts): a job carrying a grant is
   * taken only through one of them. Absent: every such job is refused (`grant_refused`).
   */
  grants?: GrantBook;
  /**
   * Sync one seat's grants with the relay again (runner/grants.ts `syncGrants`), for a call naming an
   * account the book does not hold: a grant the account made after the runner started. Asked at
   * most once per job; a failure leaves the book as it was, and the call is refused.
   */
  refreshGrants?: (label: string) => Promise<void>;
  now?: () => number;
}

const refuse = (reason: DispatchRefusal, known?: JobRow): DispatchVerdict => ({ ok: false, reason, check: DISPATCH_CHECKS[reason], ...(known ? { known } : {}) });

type Payload = ReturnType<typeof openJob>;

/**
 * Checks 3 and 4 against the store and the configuration as they are now: the seat the payload
 * names, configured and not paused, and an ask token this runner minted for it, live, at the
 * payload's epoch, a grant across a connection the seat's configuration lists, or a `may_ask`
 * grant this runner minted for that seat and principal. Made once before the reservation and
 * again when the job is accepted.
 *
 * `room` is where the seat page put the room (check 8's `dispatchRoom`), for a grant job: absent
 * before the page is read, when only the grant itself is checked (the project it names stands in,
 * so a token this runner never minted is refused before anything is reserved); null once a page
 * that named no project was read, which refuses it.
 */
function seatAndAsk(
  store: RunnerStore,
  seats: DispatchContext['seats'],
  p: Pick<Payload, 'seatId' | 'ask' | 'connection' | 'grant' | 'call'>,
  grants?: GrantBook,
  room?: DispatchRoom | null,
): { seat: SeatRow; conf: DispatchSeat; hash: string; principal: string | null } | DispatchRefusal {
  const seat = store.seatById(p.seatId);
  const conf = seat ? (typeof seats === 'function' ? seats() : seats).find((s) => s.label === seat.label) : undefined;
  if (!seat || !conf) return 'unknown_seat';
  if (seat.pausedAt || conf.paused) return 'seat_paused';
  if (p.connection) {
    // The grant and the epoch here; its limits against this runner's own count in check 7.
    if (checkConnectionJob({ ...p.connection, limits: {} }, conf.connections, { today: 0, live: 0 }) === 'grant_refused') return 'grant_refused';
    return { seat, conf, hash: '', principal: null };
  }
  if (p.call) {
    // An account's own agent: the account must hold a live grant to this seat, as the relay said at its last sync.
    if (!grants) return 'grant_refused';
    const v = grants.checkCall(seat.label, p.call);
    if (!v.ok) return 'grant_refused';
    return { seat, conf, hash: '', principal: v.principal };
  }
  if (p.grant) {
    if (!grants) return 'grant_refused';
    const where = room === undefined ? { project: projectOf(p.grant.principal), team: null } : room;
    const v = grants.check(seat.label, p.grant, where ? { room: where } : {});
    if (!v.ok || v.principal !== p.grant.principal) return 'grant_refused';
    return { seat, conf, hash: '', principal: v.principal };
  }
  if (!p.ask) return 'ask_unknown';
  const hash = askHash(p.ask.token);
  const ask = store.askToken(hash);
  if (!ask || ask.label !== seat.label) return 'ask_unknown';
  if (ask.retiredAt) return 'ask_retired';
  if (ask.epoch !== p.ask.epoch) return 'ask_epoch';
  // A live ask token this runner minted, for a seat whose team takes no asks through its link.
  if (conf.askLinks === false) return 'grant_refused';
  return { seat, conf, hash, principal: null };
}

/** Whether the seat page describes exactly the seat the job is for. */
function seatPageFits(page: SeatPage, want: { sessionId: string; participantId: string; label: string }, e2ee: boolean): boolean {
  const s = page.seat;
  return (
    page.participantId === want.participantId &&
    page.sessionId === want.sessionId &&
    page.status !== 'ended' &&
    (!page.e2ee || e2ee) &&
    !!s &&
    s.id === want.participantId &&
    s.sessionId === want.sessionId &&
    s.kind === 'standing' &&
    s.finishedAt === null &&
    s.leftAt === null &&
    s.standingLabel === want.label
  );
}

/** Runs the check on one leased job. Starts nothing and reports nothing: `dispatchLeased` does both. */
export async function checkDispatch(leased: LeasedJob, ctx: DispatchContext): Promise<DispatchVerdict> {
  const { store } = ctx;
  const now = ctx.now?.() ?? Date.now();
  const id = store.requireIdentity();

  // 5, first: a job id this runner holds is its own, however its seat or its keys changed since.
  // Nothing starts for it either way; `dispatchLeased` reports it only if it was refused before.
  const held = store.job(leased.id);
  if (held) return refuse('replayed_job', held);

  // 1 and 2: the seal, and the payload's own ids against the lease's. Only a seat's job is checked
  // here: a recheck goes to runner/recheck.ts, and any other kind is one this check cannot read.
  if (leased.kind !== 'start_seat') return refuse('bad_seal');
  let p: ReturnType<typeof openJob>;
  try {
    p = openJob(leased.payload, id.x25519Private, { runnerId: id.runnerId, jobId: leased.id, kind: leased.kind });
  } catch (e) {
    if (e instanceof JobSealError) return refuse(e.reason);
    return refuse('bad_seal');
  }
  if (p.seatId !== leased.standingSeatId || p.sessionId !== leased.sessionId || p.participantId !== leased.participantId) return refuse('envelope_mismatch');
  if (!sameRelay(p.relay, id.relay)) return refuse('wrong_relay');

  // A call naming an account the book does not hold: the grant may be newer than the last sync.
  if (p.call && ctx.grants && ctx.refreshGrants) {
    const label = store.seatById(p.seatId)?.label;
    if (label && !ctx.grants.accounts(label).includes(p.call.accountId))
      try {
        await ctx.refreshGrants(label);
      } catch {
        /* the book stays as it was, and check 4 refuses */
      }
  }

  // 3 and 4: a seat configured here, not paused, and an ask token this runner minted for it.
  const found = seatAndAsk(store, ctx.seats, p, ctx.grants);
  if (typeof found === 'string') return refuse(found);
  const { seat, conf, hash, principal } = found;

  // 5 to 7, and the reservation, in one transaction.
  const grant = p.connection?.grant ?? null;
  const row = {
    id: leased.id,
    label: seat.label,
    sessionId: p.sessionId,
    participantId: p.participantId,
    askHash: hash,
    grant,
    principal,
    // The account itself made the call: kept, so a job resumed after a restart still keeps notes.
    direct: p.call?.direct === true,
    receivedAt: new Date(now).toISOString(),
  };
  const early = store.tx((): DispatchVerdict | null => {
    const known = store.job(leased.id);
    if (known) return refuse('replayed_job', known);
    if (store.jobFor(p.sessionId, p.participantId)) return refuse('replayed_seat');

    const issued = Date.parse(p.issuedAt);
    const why: DispatchRefusal | null =
      !Number.isFinite(issued) || now - issued > ISSUED_MAX_AGE_MS
        ? 'stale'
        : issued - now > ISSUED_MAX_AHEAD_MS
          ? 'future'
          : store.liveCount(seat.label) >= conf.budget.concurrent ||
              store.takenSince(seat.label, new Date(now - 60 * 60_000).toISOString()) >= conf.budget.perHour ||
              (conf.budget.perDay !== undefined && store.takenSince(seat.label, new Date(now - 24 * 60 * 60_000).toISOString()) >= conf.budget.perDay)
            ? 'rate_limited'
            : p.connection && grant !== null
              ? checkConnectionJob(p.connection, conf.connections, store.grantLoad(grant, new Date(now - 24 * 60 * 60_000).toISOString()))
              : null;
    if (why) {
      store.recordRefused(row, why);
      return refuse(why);
    }
    store.reserveJob(row);
    return null;
  });
  if (early) return early;

  // 8: the seat page, read back with the seat token.
  let page: SeatPage;
  try {
    page = await ctx.readSeat(p.seatToken);
  } catch (e) {
    if (e instanceof RelayError && (e.transient || e.kind === 'aborted')) {
      store.releaseJob(leased.id);
      return { ok: false, retry: true, why: redactTokens(e.message, [p.seatToken, ...(p.ask ? [p.ask.token] : []), ...(p.grant ? [p.grant.token] : [])]) };
    }
    store.refuseJob(leased.id, 'seat_mismatch');
    return refuse('seat_mismatch');
  }
  if (!seatPageFits(page, { sessionId: p.sessionId, participantId: p.participantId, label: seat.label }, ctx.e2ee === true)) {
    store.refuseJob(leased.id, 'seat_mismatch');
    return refuse('seat_mismatch');
  }
  // A grant opens only a room the seat page puts in the project it names: the page is the relay
  // that made the room speaking, where the grant's principal is only what the job says.
  if (p.grant && typeof seatAndAsk(store, ctx.seats, p, ctx.grants, page.dispatchRoom) === 'string') {
    store.refuseJob(leased.id, 'grant_refused');
    return refuse('grant_refused');
  }
  // 3 and 4 again, in the transaction that accepts: the seat page took a while to read.
  const late = store.tx((): DispatchRefusal | null => {
    const again = seatAndAsk(store, ctx.seats, p, ctx.grants, p.grant ? page.dispatchRoom : undefined);
    const why = typeof again === 'string' ? again : again.seat.label !== seat.label ? 'unknown_seat' : null;
    if (why) store.refuseJob(leased.id, why);
    else store.acceptJob(leased.id, p.seatToken);
    return why;
  });
  if (late) return refuse(late);
  return {
    ok: true,
    job: {
      id: leased.id,
      kind: leased.kind,
      label: seat.label,
      seatId: p.seatId,
      sessionId: p.sessionId,
      participantId: p.participantId,
      seatToken: p.seatToken,
      askHash: hash,
      grantPrincipal: principal,
      relay: id.relay,
      issuedAt: p.issuedAt,
    },
  };
}

/** What the dispatcher needs from the relay client: its report on a job. */
export interface DispatchReporter {
  updateJob(jobId: string, update: { state: 'refused'; reason: RunnerReason }): Promise<unknown>;
}

export interface DispatchOptions extends DispatchContext {
  relay: DispatchReporter;
  /** Starts the accepted job's agent. Called for a job that passed every check, and for nothing else. */
  start: (job: AcceptedJob) => void | Promise<void>;
  /** One line per job, already scrubbed of every token the runner holds. */
  log?: (line: string) => void;
}

export interface DispatchOutcome {
  id: string;
  verdict: DispatchVerdict;
  /** Whether the refusal reached the relay. A refusal it did not hear comes back after the lease. */
  reported?: boolean;
  /** An accepted job whose `start` threw, and why (scrubbed). */
  startError?: string;
}

/**
 * The runner's handling of one lease: every job through `checkDispatch`, then `start` for the jobs
 * that passed and a `refused` report for the rest, with the reason as a code (never words: the
 * relay shows the asker a constant sentence for it).
 *
 * Two refusals are reported differently. A job id this runner already refused is reported again with
 * the first reason, since the relay evidently did not hear it. A job id it holds as accepted or
 * running is not reported at all: that job is this runner's, and its host reports on it. Jobs the
 * lease could not parse (`malformed`) are refused as `bad_seal` by id.
 */
export async function dispatchLeased(jobs: readonly LeasedJob[], o: DispatchOptions & { malformed?: readonly string[] }): Promise<DispatchOutcome[]> {
  const secrets = (): string[] => {
    try {
      return o.store.knownSecrets();
    } catch {
      return [];
    }
  };
  const log = (line: string) => o.log?.(redactTokens(line, secrets()));
  const report = async (id: string, reason: RunnerReason): Promise<boolean> => {
    try {
      await o.relay.updateJob(id, { state: 'refused', reason });
      return true;
    } catch (e) {
      log(`job ${id}: could not tell the relay it was refused (${e instanceof Error ? e.message : String(e)})`);
      return false;
    }
  };

  const out: DispatchOutcome[] = [];
  for (const id of o.malformed ?? []) {
    log(`job ${id}: refused, bad_seal (the lease did not hold a job this runner can read)`);
    out.push({ id, verdict: refuse('bad_seal'), reported: await report(id, 'bad_seal') });
  }
  for (const job of jobs) {
    let verdict: DispatchVerdict;
    try {
      verdict = await checkDispatch(job, o);
    } catch (e) {
      // Not a refusal: the runner itself could not check (its store, its identity). Nothing starts.
      log(`job ${job.id}: not checked (${e instanceof Error ? e.message : String(e)})`);
      out.push({ id: job.id, verdict: { ok: false, retry: true, why: 'the runner could not check this job' } });
      continue;
    }
    if (verdict.ok) {
      log(`job ${job.id}: accepted for ${verdict.job.label}`);
      try {
        await o.start(verdict.job);
        out.push({ id: job.id, verdict });
      } catch (e) {
        // The job stays accepted here, for the host to retry or give up on; the next jobs still run.
        const why = e instanceof Error ? e.message : String(e);
        log(`job ${job.id}: accepted, but its agent did not start (${why})`);
        out.push({ id: job.id, verdict, startError: redactTokens(why, [verdict.job.seatToken, ...secrets()]) });
      }
    } else if ('retry' in verdict) {
      log(`job ${job.id}: left for the next lease (${verdict.why})`);
      out.push({ id: job.id, verdict });
    } else if (verdict.reason === 'replayed_job' && verdict.known && verdict.known.state !== 'refused') {
      log(`job ${job.id}: leased again while this runner holds it (${verdict.known.state}); nothing new starts`);
      out.push({ id: job.id, verdict });
    } else {
      const reason = (verdict.reason === 'replayed_job' && verdict.known?.refusedReason ? verdict.known.refusedReason : verdict.reason) as RunnerReason;
      log(`job ${job.id}: refused, ${reason} (check ${DISPATCH_CHECKS[reason as DispatchRefusal] ?? verdict.check})`);
      out.push({ id: job.id, verdict, reported: await report(job.id, reason) });
    }
  }
  return out;
}
