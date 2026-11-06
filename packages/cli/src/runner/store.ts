/**
 * The runner's own database, `runner.db` (its tables are R0 and R1 in
 * runner/migrations). It lives on the answering team's machine, under `~/.parley/runner/` or
 * `PARLEY_RUNNER_HOME`, and holds that team's secrets, which is why nothing in it ever goes to the
 * relay but hashes and public keys:
 * - the one `identity` row: the relay's origin, this runner's id and `rt_` token, and its keys;
 * - each configured seat's relay id, current ask token and epoch (`seats`), and every ask token it
 *   ever minted, by hash, with when it was retired (`ask_tokens`);
 * - the jobs the dispatch check looked at (`jobs`), with each accepted job's seat token.
 *
 * **Who may read it.** On POSIX the directory is made 0700 and the file (and SQLite's `-wal` and
 * `-shm` beside it, which take the database file's mode) 0600, before SQLite ever writes a byte:
 * the file is created empty with that mode and only then opened, and a file found with a wider mode
 * is narrowed. On Windows a file under the user's profile is already the user's alone, and modes
 * mean nothing there.
 *
 * **Tokens it keeps, and for how long.** The runner token for as long as the identity; each seat's
 * current ask token until it is rotated or the seat removed (a retired token keeps only its hash);
 * a job's seat token from the moment the job passes the dispatch check, and never for a job it
 * refused. `forgetSeatToken` drops one once a job's room is over for good. `secure_delete` is on
 * (sqlite-open.ts), so a dropped token is overwritten in the file rather than left in its free pages.
 *
 * The outbound ledger and held packets (`outbound`, `held`) are runner/ledger.ts's and runner/review.ts's, over `store.db`.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { RUNNER_TOKEN, SEAT_LABEL, type StandingSeatState } from '@parley/shared/runner';
import { openSqlite } from '../sqlite-open.js';
import { askHash, checkRunnerKeys, newAskToken, newRunnerKeys, type RunnerKeys } from './keys.js';
import { RUNNER_STEPS } from './migrations/index.js';

// ---------------------------------------------------------------- where it lives

/** The runner's home: `PARLEY_RUNNER_HOME`, or `~/.parley/runner`. */
export function runnerHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.PARLEY_RUNNER_HOME?.trim();
  return set ? path.resolve(set) : path.join(os.homedir(), '.parley', 'runner');
}

/** Everything under the runner's home: this database, the config (which holds no secret), per-job directories. */
export const runnerPaths = (home: string = runnerHome()) => ({
  home,
  db: path.join(home, 'runner.db'),
  config: path.join(home, 'runner.yml'),
  jobs: path.join(home, 'jobs'),
});

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;
const POSIX = process.platform !== 'win32';

/**
 * Makes `file` exist with mode 0600 (and its directory 0700 when this creates it) before anything
 * writes to it. An existing directory keeps its mode: `PARLEY_RUNNER_HOME` may name one the user
 * shares, and the files in it are what must be private.
 */
export function preparePrivateFile(file: string): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    if (POSIX) chmodSync(dir, PRIVATE_DIR_MODE);
  }
  try {
    closeSync(openSync(file, 'wx', PRIVATE_FILE_MODE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  if (POSIX) chmodSync(file, PRIVATE_FILE_MODE);
}

// ---------------------------------------------------------------- rows

export interface RunnerIdentity extends RunnerKeys {
  /** The relay's origin (`https://parley.example`): the only relay this runner's jobs may name. */
  relay: string;
  runnerId: string;
  runnerToken: string;
  createdAt: string;
}

export interface SeatRow {
  label: string;
  /** The relay's id for this seat, once `POST /api/runner/seats` answered it. */
  seatId: string | null;
  /** The current ask token: the one the seat's ask link carries. */
  askToken: string;
  askEpoch: number;
  pausedAt: string | null;
  registeredAt: string | null;
  rotatedAt: string | null;
}

export interface AskTokenRow {
  hash: string;
  label: string;
  epoch: number;
  createdAt: string;
  retiredAt: string | null;
}

/**
 * A job's state on this runner:
 * - `checking`: the dispatch check reserved it and is reading the seat page back (check 8);
 * - `accepted`: it passed, and the host may start its agent;
 * - `running`, then `done`, `failed` or `cancelled` (the relay withdrew it), as the host reports;
 * - `refused`: the dispatch check said no, and `refusedReason` says which check.
 */
export type LocalJobState = 'checking' | 'accepted' | 'running' | 'done' | 'failed' | 'refused' | 'cancelled';
export const LIVE_JOB_STATES: readonly LocalJobState[] = ['checking', 'accepted', 'running'];

export interface JobRow {
  id: string;
  label: string;
  sessionId: string;
  participantId: string;
  /** Null for a job this runner refused, or once forgotten. */
  seatToken: string | null;
  /** '' for a job that came across a connection, which no ask token opened. */
  askHash: string;
  /** The grant's alias a job across a connection names, or null for one an ask link opened. */
  grant: string | null;
  /** The `may_ask` grant's principal (`project:<id>`) a job a playbook dispatched named, or null. Never its token. */
  grantPrincipal: string | null;
  /** The account itself made the call this job answers (`DispatchCall.direct`): its seat keeps notes between such calls. */
  directCall: boolean;
  state: LocalJobState;
  refusedReason: string | null;
  resumeId: string | null;
  commitSha: string | null;
  workdir: string | null;
  receivedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  costUsd: number | null;
}

/** One note a seat keeps between the calls its account made itself. */
export interface SeatNoteRow {
  jobId: string;
  at: string;
  text: string;
}

/** How many notes a seat keeps: the last few, oldest dropped first. */
export const SEAT_NOTES_KEPT = 5;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const identityOf = (r: any): RunnerIdentity => ({
  relay: String(r.relay),
  runnerId: String(r.runner_id),
  runnerToken: String(r.runner_token),
  x25519Private: String(r.x25519_private),
  x25519Public: String(r.x25519_public),
  ed25519Private: String(r.ed25519_private),
  ed25519Public: String(r.ed25519_public),
  createdAt: String(r.created_at),
});

const seatOf = (r: any): SeatRow => ({
  label: String(r.label),
  seatId: str(r.seat_id),
  askToken: String(r.ask_token),
  askEpoch: Number(r.ask_epoch),
  pausedAt: str(r.paused_at),
  registeredAt: str(r.registered_at),
  rotatedAt: str(r.rotated_at),
});

const askOf = (r: any): AskTokenRow => ({
  hash: String(r.hash),
  label: String(r.label),
  epoch: Number(r.epoch),
  createdAt: String(r.created_at),
  retiredAt: str(r.retired_at),
});

const jobOf = (r: any): JobRow => ({
  id: String(r.id),
  label: String(r.label),
  sessionId: String(r.session_id),
  participantId: String(r.participant_id),
  seatToken: r.seat_token ? String(r.seat_token) : null,
  askHash: String(r.ask_hash),
  grant: str(r.grant_alias),
  grantPrincipal: str(r.grant_principal),
  directCall: Number(r.direct_call ?? 0) === 1,
  state: String(r.state) as LocalJobState,
  refusedReason: str(r.refused_reason),
  resumeId: str(r.resume_id),
  commitSha: str(r.commit_sha),
  workdir: str(r.workdir),
  receivedAt: String(r.received_at),
  startedAt: str(r.started_at),
  endedAt: str(r.ended_at),
  costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
});

const nowIso = () => new Date().toISOString();

export class RunnerStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerStoreError';
  }
}

// ---------------------------------------------------------------- the store

export class RunnerStore {
  private depth = 0;
  private cached: RunnerIdentity | null | undefined;

  private constructor(
    readonly db: DatabaseSync,
    readonly file: string,
  ) {}

  /** Opens (creating it private first) and migrates a runner database. `:memory:` for tests. */
  static open(file: string = runnerPaths().db): RunnerStore {
    if (file !== ':memory:') preparePrivateFile(file);
    const db = openSqlite(file, RUNNER_STEPS);
    if (file !== ':memory:' && POSIX) for (const side of [`${file}-wal`, `${file}-shm`]) if (existsSync(side)) chmodSync(side, PRIVATE_FILE_MODE);
    return new RunnerStore(db, file);
  }

  close(): void {
    this.db.close();
  }

  /**
   * `fn` in one `BEGIN IMMEDIATE` transaction, so a check and the write it guards cannot interleave
   * with another process on the same file. Nested calls join the outer transaction.
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  // -------------------------------------------------------------- identity

  /** This runner's identity, its keys checked against each other, or null before `crossroom runner init`. */
  identity(): RunnerIdentity | null {
    if (this.cached !== undefined) return this.cached;
    const r = this.db.prepare('SELECT * FROM identity WHERE id = 1').get();
    const id = r ? identityOf(r) : null;
    if (id) checkRunnerKeys(id);
    this.cached = id;
    return id;
  }

  /** The identity, or a refusal that says what to run. */
  requireIdentity(): RunnerIdentity {
    const id = this.identity();
    if (!id) throw new RunnerStoreError('This runner has no identity yet. Run `crossroom runner init --relay <url>` first.');
    return id;
  }

  /**
   * The identity a fresh runner token gives (`POST /api/runner/tokens`), with new keys. Refuses when
   * there is one already: replacing it would orphan every seat declared under it, so that is a
   * deliberate `forgetIdentity` first.
   */
  createIdentity(o: { relay: string; runnerId: string; runnerToken: string }, keys: RunnerKeys = newRunnerKeys()): RunnerIdentity {
    if (!RUNNER_TOKEN.test(o.runnerToken)) throw new RunnerStoreError('That is not a runner token (rt_…).');
    if (!o.runnerId || o.runnerId.length > 64) throw new RunnerStoreError('That is not a runner id.');
    let origin: string;
    try {
      origin = new URL(o.relay).origin;
    } catch {
      origin = '';
    }
    if (origin !== o.relay) throw new RunnerStoreError('The relay is stored as its origin, like https://parley.example.');
    checkRunnerKeys(keys);
    return this.tx(() => {
      if (this.db.prepare('SELECT 1 FROM identity WHERE id = 1').get()) throw new RunnerStoreError('This runner already has an identity.');
      this.db
        .prepare(
          `INSERT INTO identity (id, relay, runner_id, runner_token, x25519_private, x25519_public, ed25519_private, ed25519_public, created_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(o.relay, o.runnerId, o.runnerToken, keys.x25519Private, keys.x25519Public, keys.ed25519Private, keys.ed25519Public, nowIso());
      this.cached = undefined;
      return this.requireIdentity();
    });
  }

  /**
   * New keys for the same runner (`crossroom runner rekey`), registered next with `rekey: true`. Jobs
   * already sealed to the old key no longer open, and the relay cancels its queued ones (`rekeyed`).
   */
  rekey(keys: RunnerKeys = newRunnerKeys()): RunnerIdentity {
    checkRunnerKeys(keys);
    this.requireIdentity();
    this.db
      .prepare('UPDATE identity SET x25519_private = ?, x25519_public = ?, ed25519_private = ?, ed25519_public = ? WHERE id = 1')
      .run(keys.x25519Private, keys.x25519Public, keys.ed25519Private, keys.ed25519Public);
    this.cached = undefined;
    return this.requireIdentity();
  }

  /** Drops the identity (a revoked runner, or a move to another relay). Seats and their ask tokens stay. */
  forgetIdentity(): void {
    this.db.prepare('DELETE FROM identity WHERE id = 1').run();
    this.cached = undefined;
  }

  // -------------------------------------------------------------- seats and ask tokens

  seats(): SeatRow[] {
    return (this.db.prepare('SELECT * FROM seats ORDER BY label').all() as any[]).map(seatOf);
  }

  seat(label: string): SeatRow | null {
    const r = this.db.prepare('SELECT * FROM seats WHERE label = ?').get(label);
    return r ? seatOf(r) : null;
  }

  /** The seat a relay id names, or null: the lookup the dispatch check's step 3 starts from. */
  seatById(seatId: string): SeatRow | null {
    const r = this.db.prepare('SELECT * FROM seats WHERE seat_id = ?').get(seatId);
    return r ? seatOf(r) : null;
  }

  private mintAsk(label: string, epoch: number, at: string): string {
    const token = newAskToken();
    this.db.prepare('INSERT INTO ask_tokens (hash, label, epoch, created_at) VALUES (?, ?, ?, ?)').run(askHash(token), label, epoch, at);
    return token;
  }

  /**
   * A new seat with its first ask token. Its epoch starts above any this label ever had, so a label
   * removed and added again never reuses an epoch an old link was issued under.
   */
  addSeat(label: string): SeatRow {
    if (!SEAT_LABEL.test(label)) throw new RunnerStoreError('A seat label is lower-case letters, digits and dashes, like payments-api.');
    return this.tx(() => {
      if (this.seat(label)) throw new RunnerStoreError(`There is a seat called ${label} already.`);
      const last = this.db.prepare('SELECT MAX(epoch) AS e FROM ask_tokens WHERE label = ?').get(label) as any;
      const epoch = last?.e === null || last?.e === undefined ? 0 : Number(last.e) + 1;
      const at = nowIso();
      const token = this.mintAsk(label, epoch, at);
      this.db.prepare('INSERT INTO seats (label, ask_token, ask_epoch) VALUES (?, ?, ?)').run(label, token, epoch);
      return this.seat(label)!;
    });
  }

  /**
   * `crossroom runner rotate <label>`: a new ask token at the next epoch, the old one retired (its hash
   * kept, so a job for it is refused as `ask_retired` rather than `ask_unknown`). The relay kills the
   * old epoch's seat tokens when the seats are declared next (`SeatsResult.killed`).
   */
  rotateAsk(label: string): { seat: SeatRow; retiredHash: string } {
    return this.tx(() => {
      const seat = this.seat(label);
      if (!seat) throw new RunnerStoreError(`There is no seat called ${label}.`);
      const at = nowIso();
      const retiredHash = askHash(seat.askToken);
      this.db.prepare('UPDATE ask_tokens SET retired_at = ? WHERE label = ? AND retired_at IS NULL').run(at, label);
      const epoch = seat.askEpoch + 1;
      const token = this.mintAsk(label, epoch, at);
      this.db.prepare('UPDATE seats SET ask_token = ?, ask_epoch = ?, rotated_at = ? WHERE label = ?').run(token, epoch, at, label);
      return { seat: this.seat(label)!, retiredHash };
    });
  }

  /**
   * Take back a rotation the relay refused (`rotateAsk`, then a declaration answered with a
   * refusal, which the relay takes whole or not at all): the seat's token as it was before, live
   * again, and the token minted for the rotation gone, since no link ever carried it. Nothing is
   * changed unless the seat still holds exactly the token that rotation minted, at the next epoch.
   * Answers whether it took the rotation back.
   */
  restoreAsk(label: string, before: Pick<SeatRow, 'askToken' | 'askEpoch' | 'rotatedAt'>): boolean {
    return this.tx(() => {
      const seat = this.seat(label);
      if (!seat || seat.askEpoch !== before.askEpoch + 1 || seat.askToken === before.askToken) return false;
      const minted = this.askToken(askHash(seat.askToken));
      const old = this.askToken(askHash(before.askToken));
      if (!minted || minted.retiredAt || !old || old.label !== label || old.epoch !== before.askEpoch) return false;
      this.db.prepare('DELETE FROM ask_tokens WHERE hash = ?').run(minted.hash);
      this.db.prepare('UPDATE ask_tokens SET retired_at = NULL WHERE hash = ?').run(old.hash);
      this.db.prepare('UPDATE seats SET ask_token = ?, ask_epoch = ?, rotated_at = ? WHERE label = ?').run(before.askToken, before.askEpoch, before.rotatedAt, label);
      return true;
    });
  }

  setPaused(label: string, paused: boolean): SeatRow {
    const r = this.db.prepare('UPDATE seats SET paused_at = ? WHERE label = ?').run(paused ? nowIso() : null, label);
    if (!Number(r.changes)) throw new RunnerStoreError(`There is no seat called ${label}.`);
    return this.seat(label)!;
  }

  /**
   * `crossroom runner remove <label>`: the seat goes, and every ask token it had is retired. Its notes
   * go too: a seat added again under the label may answer from another directory, for another purpose.
   */
  removeSeat(label: string): void {
    this.tx(() => {
      this.db.prepare('UPDATE ask_tokens SET retired_at = ? WHERE label = ? AND retired_at IS NULL').run(nowIso(), label);
      this.db.prepare('DELETE FROM seats WHERE label = ?').run(label);
      this.db.prepare('DELETE FROM seat_notes WHERE label = ?').run(label);
    });
  }

  /**
   * The relay's ids for the seats it answered (`SeatsResult.seats`). A live seat under a label this
   * runner does not have, or an id given to two labels, is refused whole: the dispatch check maps a
   * job to a seat by that id, so it must name exactly one.
   *
   * `revoked` is how the relay answers a seat left out of the declaration (removed here, or taken
   * out of the configuration). A label removed here needs nothing more. A seat still here keeps no
   * id, so no job can name it, and gets a new ask token at the next epoch, because the relay
   * retired the old one's hash for good: declared again as it was, the seat would be refused
   * (`askTaken`), and with it the whole declaration.
   */
  noteDeclared(seats: readonly { id: string; label: string; state?: StandingSeatState }[], at: string = nowIso()): void {
    const live = seats.filter((s) => s.state !== 'revoked');
    if (new Set(live.map((s) => s.id)).size !== live.length) throw new RunnerStoreError('The relay gave two seats the same id.');
    this.tx(() => {
      for (const s of seats) {
        const have = !!this.seat(s.label);
        if (s.state === 'revoked') {
          if (!have) continue;
          this.db.prepare('UPDATE seats SET seat_id = NULL WHERE label = ?').run(s.label);
          this.rotateAsk(s.label);
          continue;
        }
        if (!have) throw new RunnerStoreError(`The relay answered for a seat this runner does not have (${s.label}).`);
        this.db.prepare('UPDATE seats SET seat_id = NULL WHERE seat_id = ? AND label != ?').run(s.id, s.label);
        this.db.prepare('UPDATE seats SET seat_id = ?, registered_at = ? WHERE label = ?').run(s.id, at, s.label);
      }
    });
  }

  /** An ask token this runner minted, by its hash, retired or not. */
  askToken(hash: string): AskTokenRow | null {
    const r = this.db.prepare('SELECT * FROM ask_tokens WHERE hash = ?').get(hash);
    return r ? askOf(r) : null;
  }

  // -------------------------------------------------------------- jobs

  job(id: string): JobRow | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return r ? jobOf(r) : null;
  }

  /** The job this runner already holds for one seat of one room, if any: one job per standing participant. */
  jobFor(sessionId: string, participantId: string): JobRow | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE session_id = ? AND participant_id = ?').get(sessionId, participantId);
    return r ? jobOf(r) : null;
  }

  jobs(o: { label?: string; states?: readonly LocalJobState[]; limit?: number } = {}): JobRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (o.label) {
      where.push('label = ?');
      args.push(o.label);
    }
    if (o.states?.length) {
      where.push(`state IN (${o.states.map(() => '?').join(', ')})`);
      args.push(...o.states);
    }
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY received_at DESC, id LIMIT ${Math.max(1, Math.min(10_000, Math.trunc(o.limit ?? 500)))}`;
    return (this.db.prepare(sql).all(...args) as any[]).map(jobOf);
  }

  /** A seat's jobs in `checking`, `accepted` or `running`: what `concurrent` counts. */
  liveCount(label: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE label = ? AND state IN ('checking', 'accepted', 'running')").get(label) as any;
    return Number(r.c);
  }

  /** A seat's jobs received since `since` that it did not refuse: what `per_hour` and `per_day` count. */
  takenSince(label: string, since: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE label = ? AND state != 'refused' AND received_at >= ?").get(label, since) as any;
    return Number(r.c);
  }

  /**
   * A grant's jobs here, for a job across a connection (connections/runner-check.ts): those received
   * since `since` that this runner did not refuse, and those still live.
   */
  grantLoad(grant: string, since: string): { today: number; live: number } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(state != 'refused' AND received_at >= ?), 0) AS today, COALESCE(SUM(state IN ('checking', 'accepted', 'running')), 0) AS live
           FROM jobs WHERE grant_alias = ?`,
      )
      .get(since, grant) as any;
    return { today: Number(r.today), live: Number(r.live) };
  }

  /** Reserve a job while its seat page is read back (dispatch check 8). The seat token is not stored yet. */
  reserveJob(j: {
    id: string;
    label: string;
    sessionId: string;
    participantId: string;
    askHash: string;
    grant?: string | null;
    principal?: string | null;
    direct?: boolean;
    receivedAt: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO jobs (id, label, session_id, participant_id, seat_token, ask_hash, grant_alias, grant_principal, direct_call, state, received_at) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, 'checking', ?)",
      )
      .run(j.id, j.label, j.sessionId, j.participantId, j.askHash, j.grant ?? null, j.principal ?? null, j.direct === true ? 1 : 0, j.receivedAt);
  }

  /** A reserved job passed: from now on this runner holds its seat token. */
  acceptJob(id: string, seatToken: string): void {
    const r = this.db.prepare("UPDATE jobs SET state = 'accepted', seat_token = ? WHERE id = ? AND state = 'checking'").run(seatToken, id);
    if (!Number(r.changes)) throw new RunnerStoreError('That job is not waiting on its check.');
  }

  /** A job the check refused after it was reserved or recorded: its seat token is never kept. */
  refuseJob(id: string, reason: string, at: string = nowIso()): void {
    this.db.prepare("UPDATE jobs SET state = 'refused', refused_reason = ?, seat_token = '', ended_at = ? WHERE id = ?").run(reason, at, id);
  }

  /**
   * Remember a refused job that opened and named a live ask token of this runner's (checks 6 and 7),
   * so that the same job leased again is a replay. Its seat token is not kept.
   */
  recordRefused(
    j: { id: string; label: string; sessionId: string; participantId: string; askHash: string; grant?: string | null; principal?: string | null; receivedAt: string },
    reason: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (id, label, session_id, participant_id, seat_token, ask_hash, grant_alias, grant_principal, state, refused_reason, received_at, ended_at)
         VALUES (?, ?, ?, ?, '', ?, ?, ?, 'refused', ?, ?, ?)`,
      )
      .run(j.id, j.label, j.sessionId, j.participantId, j.askHash, j.grant ?? null, j.principal ?? null, reason, j.receivedAt, j.receivedAt);
  }

  /** Drop a reservation whose check could not finish (the relay did not answer): the next lease checks it again. */
  releaseJob(id: string): void {
    this.db.prepare("DELETE FROM jobs WHERE id = ? AND state = 'checking'").run(id);
  }

  /** At boot: reservations a process left behind mid-check. Only the one process that runs the seats may call it. */
  releaseUnchecked(): number {
    return Number(this.db.prepare("DELETE FROM jobs WHERE state = 'checking'").run().changes);
  }

  markRunning(id: string, o: { workdir?: string; commitSha?: string; at?: string } = {}): void {
    this.db
      .prepare(
        "UPDATE jobs SET state = 'running', started_at = COALESCE(started_at, ?), workdir = COALESCE(?, workdir), commit_sha = COALESCE(?, commit_sha) WHERE id = ? AND state IN ('accepted', 'running')",
      )
      .run(o.at ?? nowIso(), o.workdir ?? null, o.commitSha ?? null, id);
  }

  markEnded(id: string, state: 'done' | 'failed' | 'cancelled', o: { costUsd?: number; at?: string } = {}): void {
    this.db
      .prepare("UPDATE jobs SET state = ?, ended_at = ?, cost_usd = COALESCE(?, cost_usd) WHERE id = ? AND state IN ('accepted', 'running')")
      .run(state, o.at ?? nowIso(), o.costUsd ?? null, id);
  }

  setResumeId(id: string, resumeId: string | null): void {
    this.db.prepare('UPDATE jobs SET resume_id = ? WHERE id = ?').run(resumeId, id);
  }

  /** Drop a job's seat token once nothing will use it again. */
  forgetSeatToken(id: string): void {
    this.db.prepare("UPDATE jobs SET seat_token = '' WHERE id = ?").run(id);
  }

  // -------------------------------------------------------------- notes between calls

  /**
   * Keep what a seat's agent wrote as it finished a call its account made itself (`noteText` in
   * runner/notes.ts made `text` already): one note per job, and only the seat's last `keep`.
   */
  addSeatNote(label: string, jobId: string, text: string, o: { at?: string; keep?: number } = {}): void {
    const keep = Math.max(1, Math.trunc(o.keep ?? SEAT_NOTES_KEPT));
    this.tx(() => {
      this.db.prepare('INSERT OR IGNORE INTO seat_notes (label, job_id, at, text) VALUES (?, ?, ?, ?)').run(label, jobId, o.at ?? nowIso(), text);
      this.db
        .prepare('DELETE FROM seat_notes WHERE label = ? AND id NOT IN (SELECT id FROM seat_notes WHERE label = ? ORDER BY id DESC LIMIT ?)')
        .run(label, label, keep);
    });
  }

  /** A seat's notes, oldest first, as kept. */
  seatNotes(label: string): SeatNoteRow[] {
    return (this.db.prepare('SELECT job_id, at, text FROM seat_notes WHERE label = ? ORDER BY id').all(label) as any[]).map((r) => ({
      jobId: String(r.job_id),
      at: String(r.at),
      text: String(r.text),
    }));
  }

  /** `crossroom agents notes <label> --forget`: every note of the seat gone. Answers how many. */
  forgetSeatNotes(label: string): number {
    return Number(this.db.prepare('DELETE FROM seat_notes WHERE label = ?').run(label).changes);
  }

  /** Note that the relay called a room end to end (runner/e2ee-egress.ts). Kept for good: a room never stops being end to end. */
  noteE2eeRoom(sessionId: string, at: string = nowIso()): void {
    this.db.prepare('INSERT OR IGNORE INTO e2ee_rooms (session_id, seen_at) VALUES (?, ?)').run(sessionId, at);
  }

  /** Whether the relay has ever called this room end to end to this runner. */
  isE2eeRoom(sessionId: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM e2ee_rooms WHERE session_id = ?').get(sessionId) !== undefined;
  }

  /**
   * Every secret this runner holds that must never leave it in a packet or a log line: its runner
   * token, both private keys (the X25519 one opens every job ever sealed to this runner, and each
   * job holds a seat token and an ask token), every seat's current ask token, and every seat token
   * it still keeps. The raw values, as `runner.db` stores them, for `redactTokens` and the
   * known-secret scan (`RunnerOnly.knownSecrets`), which does the encodings.
   */
  knownSecrets(): string[] {
    const out = new Set<string>();
    const id = this.identity();
    if (id) for (const s of [id.runnerToken, id.x25519Private, id.ed25519Private]) out.add(s);
    for (const r of this.db.prepare("SELECT ask_token AS t FROM seats WHERE ask_token IS NOT NULL AND ask_token != ''").all() as any[]) out.add(String(r.t));
    for (const r of this.db.prepare("SELECT seat_token AS t FROM jobs WHERE seat_token != ''").all() as any[]) out.add(String(r.t));
    return [...out];
  }
}
