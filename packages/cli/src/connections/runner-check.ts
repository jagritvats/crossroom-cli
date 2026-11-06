/**
 * The guest runner's own check of a job that came across a connection (a grant's limits
 * are checked at the host's create, at the guest relay's dispatch, and on the guest runner). Pure:
 * it reads what it is handed and writes nothing, so the runner's dispatch check (runner/dispatch.ts)
 * can call it inside the transaction that reserves the job, beside its checks 4 and 7.
 *
 * Why a third check. The host's relay and the guest's are each the other side's to run, and on one
 * relay they are one process: neither the host's count nor the relay's is the guest team's own. The
 * guest runner trusts neither. It takes a job across a connection only when:
 * 1. its own configuration lists the grant the job names under that very seat (`seat.connections`),
 *    so a relay can never seat the team's agent in a room across a connection the team never agreed
 *    to, whatever it seals (`grant_refused`), and the job names the connection the configuration
 *    names, at an epoch no older than the one the configuration last saw (`grant_refused`);
 * 2. the rooms it took through that grant today, and those still running, are under the stricter
 *    of the grant's limits as the job states them and as its own configuration does (`rate_limited`).
 * The counts are the runner's own (`load`, from runner.db), never the relay's.
 *
 * The job states its connection in `StartSeatPayload.connection` (in place of an ask token), and a
 * seat lists the grants it answers through under `connections` in runner.yml (runner/config.ts).
 * runner/dispatch.ts calls this at check 4 for the grant and the epoch, and again at check 7, in the
 * transaction that reserves the job, against `RunnerStore.grantLoad`.
 */
import type { GrantLimits } from '@parley/shared/connections';
import type { RunnerReason } from '@parley/shared/runner';

/** What a job says about the connection it came across (`StartSeatPayload.connection`). */
export interface JobConnection {
  /** The connection's id (`conn_...`). */
  id: string;
  /** The grant's alias, as the other side was shown it (`ga_...`). */
  grant: string;
  /** The connection's epoch when the job was dispatched. */
  epoch: number;
  /** The grant's limits as the relay holds them. */
  limits: GrantLimits;
}

/** One grant a seat takes jobs through, as the runner's own configuration lists it under the seat. */
export interface SeatConnectionGrant {
  connection: string;
  grant: string;
  /** The team's own ceiling, whatever the relay says the grant allows. */
  limits?: GrantLimits;
  /** The lowest epoch the team accepts: a connection revoked and made again starts above it. */
  minEpoch?: number;
}

/** What the runner has taken through one grant: its own counts, from its own store. */
export interface GrantLoad {
  /** Jobs accepted through the grant in the last 24 hours. */
  today: number;
  /** Of those, the ones still running. */
  live: number;
}

/** The stricter of two limits, where either is set. */
function stricter(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** The limits a job is held to: each the stricter of the job's and the configuration's. */
export function effectiveLimits(job: GrantLimits, conf: GrantLimits | undefined): GrantLimits {
  const out: GrantLimits = {};
  const rooms = stricter(job.roomsPerDay, conf?.roomsPerDay);
  const asks = stricter(job.asksPerDay, conf?.asksPerDay);
  const live = stricter(job.liveRooms, conf?.liveRooms);
  if (rooms !== undefined) out.roomsPerDay = rooms;
  if (asks !== undefined) out.asksPerDay = asks;
  if (live !== undefined) out.liveRooms = live;
  return out;
}

/**
 * The runner's verdict on a job across a connection: null to go on with its other checks, or the
 * reason to refuse it with. A job that names no connection is not this check's (an ask link's).
 */
export function checkConnectionJob(
  job: JobConnection | undefined,
  seatGrants: readonly SeatConnectionGrant[] | undefined,
  load: GrantLoad,
): Extract<RunnerReason, 'grant_refused' | 'rate_limited'> | null {
  if (!job) return null;
  const conf = (seatGrants ?? []).find((g) => g.grant === job.grant);
  if (!conf || conf.connection !== job.id) return 'grant_refused';
  if (!Number.isInteger(job.epoch) || job.epoch < (conf.minEpoch ?? 1)) return 'grant_refused';
  const limits = effectiveLimits(job.limits, conf.limits);
  if (limits.roomsPerDay !== undefined && load.today >= limits.roomsPerDay) return 'rate_limited';
  if (limits.asksPerDay !== undefined && load.today >= limits.asksPerDay) return 'rate_limited';
  if (limits.liveRooms !== undefined && load.live >= limits.liveRooms) return 'rate_limited';
  return null;
}

/** A job the runner holds, as far as a grant's load goes: which grant it came through, when, and whether it is still running. */
export interface HeldConnectionJob {
  grant: string | null;
  receivedAt: string;
  live: boolean;
}

/** The runner's load on one grant, from the jobs it holds: those through the grant in the last 24 hours, and those still running. */
export function loadOf(jobs: readonly HeldConnectionJob[], grant: string, now: number): GrantLoad {
  const since = now - 24 * 60 * 60_000;
  let today = 0;
  let live = 0;
  for (const j of jobs) {
    if (j.grant !== grant) continue;
    const at = Date.parse(j.receivedAt);
    if (Number.isFinite(at) && at > since) today++;
    if (j.live) live++;
  }
  return { today, live };
}
