/**
 * The runner's client for its relay: every call a `crossroom runner` makes, over the
 * wire contract in `@parley/shared/runner`.
 *
 * - **Runner routes** (`/api/runner/*`) take `Authorization: Bearer`: the `rt_` runner token for
 *   `register`, the `rs_` session for everything after. The session lives in memory only, for
 *   `RUNNER_SESSION_HOURS`, and dies with a relay restart, so a 401 on a session call registers
 *   again, once, and retries the call; concurrent callers share that one registration. A new
 *   registration ends the session before it, and the relay answers the calls still running on
 *   that one 410, so those are retried on the new session too. A 401 on
 *   `register` itself means the runner token is gone (revoked or expired), and that is the
 *   operator's to fix.
 * - **Seat routes** (`/api/seat`, `/api/seat/op/*`, `/api/seat/events`) take the seat token in
 *   `x-parley-seat`, never in a path or a query, so it stays out of every access log.
 *
 * **Only the relay it was configured with.** Every URL is that origin plus a fixed path; nothing a
 * relay answers, and nothing a job's payload names, ever becomes a URL here (the dispatch check
 * compares the payload's relay with this one and refuses the job otherwise). Redirects are errors,
 * so a credential never follows one to another origin. Plain `http:` is only for a relay on this
 * machine's loopback, unless the operator says otherwise (`allowHttp`), because every call carries
 * a token.
 *
 * **Fetch is the caller's.** The runner runs on the answering team's machine and talks to the relay
 * its operator named, loopback included, as the `crossroom` command does; it is not the server
 * fetching a URL someone else supplied, which is what the server's `safeFetch` is for. The
 * command (commands/runner.ts) passes the global `fetch`; tests pass a relay's own `request`.
 *
 * **Errors carry no secret.** Every message goes through `redactTokens` with every token the client
 * holds, plus whatever the caller names (`secrets`), so a relay that echoes a token back, or a
 * network error that quotes a request, cannot put one in a log.
 */
import {
  type DeclaredSeat,
  type GrantsInput,
  type GrantsResult,
  type HeartbeatInput,
  type HeartbeatResult,
  type HeldInput,
  JOB_ID,
  type JobUpdateInput,
  type JobUpdateResult,
  LeasedJob,
  type LeaseInput,
  LEASE_WAIT_S,
  type LinkInput,
  type MintRunnerTokenInput,
  type MintRunnerTokenResult,
  type PolicySummary,
  type RegisterInput,
  type RegisterResult,
  RUNNER_SESSION,
  RUNNER_TOKEN,
  type RunnerCapabilities,
  type RunnerControl,
  type SeatsInput,
  type SeatsResult,
  type StandingRuntime,
} from '@parley/shared/runner';
import type { SessionSnapshot } from '@parley/shared';
import { E2EE_ENVELOPES_HEADER } from '@parley/shared/e2ee';
import { z } from 'zod';
import type { LedgerSyncInput, LedgerSyncResult } from '../relay/ledger-wire.js';
import { askHash, redactTokens } from './keys.js';
import type { RunnerStore, SeatRow } from './store.js';

/** The one function the client calls to reach the relay: the global `fetch`, or a test's stand-in. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------- the relay's address

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return host === '::1';
}

export class RelayAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayAddressError';
  }
}

/**
 * A relay's address as the runner stores and compares it: its origin. Refuses anything with a
 * user, a password, a path, a query or a fragment (a relay is an origin, and an ask link pasted
 * here by mistake should say so), anything but https, and http off this machine's loopback unless
 * `allowHttp`.
 */
export function relayOrigin(url: string, o: { allowHttp?: boolean } = {}): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new RelayAddressError('The relay is an address like https://parley.example.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new RelayAddressError('The relay is an https:// address.');
  if (u.username || u.password) throw new RelayAddressError('The relay address carries no user or password.');
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash)
    throw new RelayAddressError('The relay is an address like https://parley.example, with no path: that looks like a link to something on it.');
  if (u.protocol === 'http:' && !o.allowHttp && !isLoopbackHost(u.hostname))
    throw new RelayAddressError('Every call to a relay carries a token, so a relay not on this machine must be https://.');
  return u.origin;
}

/** Whether two addresses have the same origin. False for anything that is not a URL at all; never throws. */
export function sameRelay(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- errors

export type RelayErrorKind =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'gone'
  | 'too_large'
  | 'rate_limited'
  | 'unavailable'
  | 'not_built'
  | 'rejected'
  | 'protocol';

export class RelayError extends Error {
  constructor(
    readonly kind: RelayErrorKind,
    /** The HTTP status, or 0 when there was no answer. */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }

  /** Worth trying again later: the relay did not answer, was busy, or said to slow down. */
  get transient(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'unavailable' || this.kind === 'rate_limited';
  }
}

function kindOf(status: number): RelayErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 410) return 'gone';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status === 501) return 'not_built';
  if (status >= 500) return 'unavailable';
  return 'rejected';
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------------------------------------------------------------- answers

const RegisterAnswer = z.looseObject({
  runnerId: z.string().min(1),
  session: z.string().regex(RUNNER_SESSION),
  sessionExpiresAt: z.string(),
  leaseWaitS: z.number(),
  heartbeatS: z.number(),
  relay: z.looseObject({ publicUrl: z.string(), version: z.string(), signingKey: z.string().nullable() }),
  limits: z.looseObject({ maxSeats: z.number() }),
});

const MintAnswer = z.looseObject({
  runnerId: z.string().min(1),
  runnerToken: z.string().regex(RUNNER_TOKEN),
  maxSeats: z.number(),
  expiresAt: z.string().nullable(),
});

const Control = z.looseObject({ paused: z.array(z.string()) });

const SeatsAnswer = z.looseObject({
  seats: z.array(
    z.looseObject({
      id: z.string().min(1),
      label: z.string(),
      state: z.enum(['active', 'paused', 'revoked']),
      askUrlBase: z.string(),
      rotated: z.boolean(),
      killed: z.number(),
    }),
  ),
});

const LeaseAnswer = z.looseObject({ jobs: z.array(z.unknown()), control: Control });

const JobUpdateAnswer = z.looseObject({
  ok: z.literal(true),
  job: z.looseObject({ id: z.string(), state: z.string(), reason: z.string().nullable() }),
  cancel: z.boolean().optional(),
});

const GrantsAnswer = z.looseObject({
  seat: z.string(),
  grants: z.array(z.looseObject({ principal: z.string() })),
  revoked: z.number(),
  missing: z.array(z.string()).optional(),
  dropped: z.array(z.string()).optional(),
  accounts: z.array(z.string()).optional(),
});

const HeartbeatAnswer = z.looseObject({ ok: z.literal(true), sessionExpiresAt: z.string(), control: Control, cancel: z.array(z.string()) });

const LedgerSyncAnswer = z.looseObject({ ok: z.literal(true), stored: z.number().int().min(0), highWater: z.number().int().min(0) });

const SeatPageAnswer = z.looseObject({
  snapshot: z.looseObject({
    viewer: z.literal('seat'),
    seat: z.string(),
    session: z.looseObject({ id: z.string(), status: z.string(), e2ee: z.boolean() }),
    participants: z.array(
      z.looseObject({
        id: z.string(),
        sessionId: z.string(),
        kind: z.string(),
        finishedAt: z.string().nullable(),
        leftAt: z.string().nullable(),
        standing: z.looseObject({ label: z.string() }).nullable().optional(),
      }),
    ),
  }),
  /** For a standing seat only: the project whose room it is (seat dispatch), or null. A relay before it sends none. */
  dispatchRoom: z.object({ project: z.string().nullable(), team: z.string().nullable() }).nullable().optional(),
});

/** What a lease handed over: the jobs that parse, and the ids of any that did not. */
export interface LeaseAnswer {
  jobs: LeasedJob[];
  control: RunnerControl;
  /** Jobs in the answer that are not a `LeasedJob`, by id where the id itself has the job-id shape. */
  malformed: string[];
}

/**
 * The seat page (`GET /api/seat`) as the dispatch check reads it: which seat and room the token
 * opens, and that seat as the room lists it. `snapshot` is the whole seat view, for the host.
 */
export interface SeatPage {
  participantId: string;
  sessionId: string;
  status: string;
  e2ee: boolean;
  seat: { id: string; sessionId: string; kind: string; finishedAt: string | null; leftAt: string | null; standingLabel: string | null } | null;
  /**
   * Where the relay says the room is, for a standing seat (`GET /api/seat`'s `dispatchRoom`): the
   * project a playbook's room belongs to, which a grant's principal must name (`GrantBook.check`).
   * Null when the relay said nothing: a grant job is then refused, never waved through.
   */
  dispatchRoom: { project: string | null; team: string | null } | null;
  snapshot: SessionSnapshot;
}

// ---------------------------------------------------------------- declaring seats

/** What the configuration says about one seat, beyond what the store holds. */
export interface SeatDeclarationSource {
  label: string;
  runtime: StandingRuntime;
  description: string;
  policy: PolicySummary;
  /** Paused in the configuration, as well as by `crossroom runner pause`. */
  paused?: boolean;
}

/**
 * One seat as `POST /api/runner/seats` declares it: its ask token by hash and epoch only (the
 * relay never holds the token), confined only for Claude Code (the relay forces it off
 * for the others anyway), paused if either the store or the configuration says so.
 */
export function declaredSeat(seat: SeatRow, conf: SeatDeclarationSource): DeclaredSeat {
  return {
    label: seat.label,
    runtime: conf.runtime,
    confined: conf.runtime === 'claude',
    description: conf.description,
    ask: { hash: askHash(seat.askToken), epoch: seat.askEpoch },
    paused: !!seat.pausedAt || !!conf.paused,
    policy: conf.policy,
  };
}

// ---------------------------------------------------------------- the client

export interface RelayClientOptions {
  /** The relay as configured, e.g. `https://app.crossroom.dev`. */
  relay: string;
  fetch: FetchLike;
  /** Plain http to a relay that is not on this machine. Off by default: every call carries a token. */
  allowHttp?: boolean;
  /** Per call, apart from a lease, which waits `waitS` longer. Default 20 s. */
  timeoutMs?: number;
  /** Anything else to scrub from error messages: the store's `knownSecrets`, typically. */
  secrets?: () => readonly string[];
}

interface CallOptions {
  body?: unknown;
  bearer?: string;
  seat?: string;
  /** The relay's admin token, in `x-parley-admin`: only `mint` sends one, and only when the operator gave it. */
  admin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  accept?: string;
  /** Ask the seat page for an end-to-end room as stored (`x-parley-e2ee: envelopes`). */
  e2eeEnvelopes?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** The most of an answer the client reads. A seat page of a long room is a few hundred kilobytes. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
/** Register again this long before the session would expire, rather than let a call find out. */
const SESSION_MARGIN_MS = 60_000;
const OP = /^[a-z_]{1,32}$/;

/**
 * The capabilities every relay reads. A relay from before `grantDispatch` and `approvedEffects`
 * parsed `RunnerCapabilities` strictly over these two keys, and answers 400 to a registration or a
 * heartbeat naming any other: the client then sends these alone, and so says nothing it takes that
 * such a relay would not send anyway.
 */
const baseCapabilities = (c: RunnerCapabilities | undefined): RunnerCapabilities | undefined => (c ? { os: c.os, clis: c.clis } : c);
const saysMore = (c: RunnerCapabilities | undefined) => !!c && Object.keys(c).some((k) => k !== 'os' && k !== 'clis');

export class RelayClient {
  /** The relay's origin: every URL this client builds starts with it. */
  readonly relay: string;
  private runnerToken: string | null = null;
  private registration: RegisterInput | null = null;
  private session: { token: string; expiresAt: number } | null = null;
  private registering: Promise<RegisterResult> | null = null;
  /** The relay refused the capabilities it does not know at the last registration: heartbeats send the base ones. */
  private baseCapsOnly = false;
  /** The relay's last answer to `register`: its limits, its intervals, its version. */
  registered: RegisterResult | null = null;

  constructor(private readonly o: RelayClientOptions) {
    this.relay = relayOrigin(o.relay, { allowHttp: o.allowHttp });
  }

  /** Every token this client holds, for scrubbing, plus the caller's. */
  private secrets(extra: readonly (string | undefined)[] = []): string[] {
    let theirs: readonly string[] = [];
    try {
      theirs = this.o.secrets?.() ?? [];
    } catch {
      // A store that cannot be read (closed, locked) still leaves the token shapes and our own tokens scrubbed.
    }
    return [this.runnerToken, this.session?.token, ...extra, ...theirs].filter((s): s is string => !!s);
  }

  private fail(kind: RelayErrorKind, status: number, message: string, extra: readonly (string | undefined)[] = []): RelayError {
    return new RelayError(kind, status, redactTokens(message, this.secrets(extra)));
  }

  /**
   * An answer's body as text, read no further than `MAX_ANSWER_BYTES`: a relay that answers without
   * end cannot fill the runner's memory.
   */
  private async bodyOf(res: Response, what: string, extra: readonly (string | undefined)[]): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ANSWER_BYTES) {
          await reader.cancel().catch(() => {});
          throw this.fail('protocol', res.status, `the relay's answer to ${what} is too large`, extra);
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof RelayError) throw e;
      throw this.fail('network', res.status, `the relay's answer to ${what} broke off`, extra);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** One request to the relay, its answer as JSON (or null for an empty one). */
  private async call(method: 'GET' | 'POST', path: string, c: CallOptions = {}): Promise<unknown> {
    const res = await this.send(method, path, c);
    const secret = [c.bearer, c.seat, c.admin];
    const text = await this.bodyOf(res, `${method} ${path}`, secret);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw this.fail('protocol', res.status, `the relay's answer to ${method} ${path} is not JSON`, secret);
    }
  }

  /** One request, answered 2xx, or a `RelayError` saying what the relay said, with nothing secret in it. */
  private async send(method: 'GET' | 'POST', path: string, c: CallOptions = {}): Promise<Response> {
    const secret = [c.bearer, c.seat, c.admin];
    const headers: Record<string, string> = { accept: c.accept ?? 'application/json' };
    if (c.body !== undefined) headers['content-type'] = 'application/json';
    if (c.bearer) headers.authorization = `Bearer ${c.bearer}`;
    if (c.seat) headers['x-parley-seat'] = c.seat;
    if (c.e2eeEnvelopes) headers[E2EE_ENVELOPES_HEADER] = 'envelopes';
    if (c.admin) headers['x-parley-admin'] = c.admin;
    const timeout = c.timeoutMs === 0 ? null : AbortSignal.timeout(c.timeoutMs ?? this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signals = [timeout, c.signal].filter((s): s is AbortSignal => !!s);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let res: Response;
    try {
      res = await this.o.fetch(`${this.relay}${path}`, {
        method,
        headers,
        ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
        redirect: 'error',
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (c.signal?.aborted) throw this.fail('aborted', 0, `${method} ${path} was stopped`, secret);
      if (timeout?.aborted) throw this.fail('timeout', 0, `the relay at ${this.relay} did not answer ${method} ${path} in time`, secret);
      // The global fetch refuses a redirect (`redirect: 'error'`) as a network error; it is not one.
      const cause = String((e as { cause?: { message?: unknown } })?.cause?.message ?? '');
      if (/redirect/i.test(cause)) throw this.fail('protocol', 0, `the relay answered ${method} ${path} with a redirect, which a runner never follows`, secret);
      throw this.fail('network', 0, `could not reach the relay at ${this.relay} (${clip(String((e as Error)?.message ?? e), 200)})`, secret);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw this.fail('protocol', res.status, `the relay answered ${method} ${path} with a redirect, which a runner never follows`, secret);
    }
    if (!res.ok) {
      let said = '';
      try {
        const j = JSON.parse((await this.bodyOf(res, `${method} ${path}`, secret)) || 'null');
        said = typeof j?.error === 'string' ? j.error : '';
      } catch {
        said = '';
      }
      throw this.fail(kindOf(res.status), res.status, `the relay answered ${method} ${path} with ${res.status}${said ? `: ${clip(said)}` : ''}`, secret);
    }
    return res;
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const r = schema.safeParse(value);
    if (!r.success) throw this.fail('protocol', 200, `the relay's answer to ${what} is not what a runner expects`);
    return r.data;
  }

  // -------------------------------------------------------------- tokens and registration

  /**
   * `POST /api/runner/tokens`: a new runner token, answered once (`crossroom runner init`). Anyone may
   * mint a self-served one; the wider scopes of `input` need the relay's admin token, which goes in
   * `x-parley-admin` and is scrubbed from any error like every other token.
   */
  async mint(input: MintRunnerTokenInput = {}, o: { adminToken?: string } = {}): Promise<MintRunnerTokenResult> {
    const out = await this.call('POST', '/api/runner/tokens', { body: input, ...(o.adminToken ? { admin: o.adminToken } : {}) });
    const r = this.parse(MintAnswer, out, 'POST /api/runner/tokens');
    return { runnerId: r.runnerId, runnerToken: r.runnerToken, maxSeats: r.maxSeats, expiresAt: r.expiresAt };
  }

  /**
   * `POST /api/runner/register` with the runner token: keys, capabilities, and a session. The
   * client keeps the token and the registration, to register again on its own when the session
   * lapses or the relay restarts.
   */
  async register(runnerToken: string, input: RegisterInput): Promise<RegisterResult> {
    if (!RUNNER_TOKEN.test(runnerToken)) throw this.fail('rejected', 0, 'that is not a runner token (rt_…)', [runnerToken]);
    this.runnerToken = runnerToken;
    this.registration = input;
    this.session = null;
    return await this.reregister();
  }

  /** Whether a session is held now, and until when. */
  get sessionExpiresAt(): string | null {
    return this.session ? new Date(this.session.expiresAt).toISOString() : null;
  }

  private reregister(): Promise<RegisterResult> {
    this.registering ??= (async () => {
      const token = this.runnerToken;
      const input = this.registration;
      if (!token || !input) throw this.fail('unauthorized', 0, 'this runner has not registered with its relay yet');
      // Every registration offers everything this runner takes first, so an upgraded relay hears it
      // at the next one (a restart or a renewal); a relay that refuses it is sent the base set.
      const send = (capabilities: RunnerCapabilities | undefined) =>
        this.call('POST', '/api/runner/register', { body: { ...input, capabilities }, bearer: token });
      let out: unknown;
      try {
        out = await send(input.capabilities);
        this.baseCapsOnly = false;
      } catch (e) {
        if (!(e instanceof RelayError) || e.status !== 400 || !saysMore(input.capabilities)) throw e;
        out = await send(baseCapabilities(input.capabilities));
        this.baseCapsOnly = true;
      }
      const r = this.parse(RegisterAnswer, out, 'POST /api/runner/register') as RegisterResult;
      const expiresAt = Date.parse(r.sessionExpiresAt);
      this.session = { token: r.session, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60_000 };
      // A rekey is asked for once: the next registration presents the keys it now holds as its own.
      if (input.rekey) this.registration = { ...input, rekey: undefined };
      this.registered = r;
      return r;
    })().finally(() => {
      this.registering = null;
    });
    return this.registering;
  }

  private async sessionToken(): Promise<string> {
    if (!this.session || this.session.expiresAt - Date.now() < SESSION_MARGIN_MS) await this.reregister();
    return this.session!.token;
  }

  /**
   * A call on the runner's session: registered first if need be, and sent once more after a 401,
   * or after a 410 that this client's own registration caused. The relay ends a runner's session
   * when it registers again, and refuses the calls still running on the old one with 410, before
   * they act: a lease parked when the session is renewed would otherwise fail as if the runner had
   * been revoked. A 410 with no new session here is a revocation, and is passed on.
   */
  private async onSession(method: 'POST', path: string, c: Omit<CallOptions, 'bearer'> & { bodyNow?: () => unknown } = {}): Promise<unknown> {
    const first = await this.sessionToken();
    // A body that depends on what a registration learned is made for each attempt, after it.
    const at = (bearer: string): CallOptions => ({ ...c, ...(c.bodyNow ? { body: c.bodyNow() } : {}), bearer });
    try {
      return await this.call(method, path, at(first));
    } catch (e) {
      if (!(e instanceof RelayError)) throw e;
      if (e.kind === 'unauthorized') {
        if (this.session?.token === first) this.session = null;
      } else if (e.kind === 'gone') {
        // The relay ends the old session before it answers the registration, so this can arrive first.
        await this.registering?.catch(() => {});
        if (!this.session || this.session.token === first) throw e;
      } else throw e;
      return await this.call(method, path, at(await this.sessionToken()));
    }
  }

  // -------------------------------------------------------------- the runner's routes

  /** `POST /api/runner/seats`: the whole list. The relay revokes any seat left out of it. */
  async declareSeats(input: SeatsInput): Promise<SeatsResult> {
    return this.parse(SeatsAnswer, await this.onSession('POST', '/api/runner/seats', { body: input }), 'POST /api/runner/seats') as SeatsResult;
  }

  /**
   * `POST /api/runner/lease`: parks at the relay for up to `waitS` (the relay's answer to `register`
   * says how long by default), and answers the jobs it was handed. Every job is parsed on its own:
   * one the runner cannot read is set aside by id, so the dispatch can refuse it, and does not cost
   * the others.
   */
  async lease(input: LeaseInput = {}, signal?: AbortSignal): Promise<LeaseAnswer> {
    const waitS = input.waitS ?? this.registered?.leaseWaitS ?? LEASE_WAIT_S.default;
    const out = await this.onSession('POST', '/api/runner/lease', { body: input, timeoutMs: waitS * 1000 + 15_000, ...(signal ? { signal } : {}) });
    const r = this.parse(LeaseAnswer, out, 'POST /api/runner/lease');
    const jobs: LeasedJob[] = [];
    const malformed: string[] = [];
    for (const j of r.jobs) {
      const p = LeasedJob.safeParse(j);
      if (p.success) jobs.push(p.data);
      else {
        const id = (j as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && JOB_ID.test(id)) malformed.push(id);
      }
    }
    // The whole control, read loosely: a team's runner also reads `rotate` and `stopBefore` (runner/fleet-control.ts).
    return { jobs, control: r.control as RunnerControl, malformed };
  }

  /**
   * `POST /api/runner/grants` (a team's runner): one seat's `may_ask` grants, declaratively
   * (runner/grants.ts `syncGrants` plans the body). New grants carry their tokens; the relay seals
   * them under the organisation key and keeps their hashes.
   */
  async uploadGrants(input: GrantsInput): Promise<GrantsResult> {
    const r = this.parse(GrantsAnswer, await this.onSession('POST', '/api/runner/grants', { body: input }), 'POST /api/runner/grants');
    return r as GrantsResult;
  }

  /** `POST /api/runner/links` (a team's runner): a seat's new ask link, after a rotation its team asked for. */
  async uploadLink(input: LinkInput): Promise<void> {
    await this.onSession('POST', '/api/runner/links', { body: input });
  }

  private jobPath(jobId: string, tail = ''): string {
    if (!JOB_ID.test(jobId)) throw this.fail('rejected', 0, 'that is not a job id');
    return `/api/runner/jobs/${jobId}${tail}`;
  }

  /**
   * `POST /api/runner/jobs/:id`: the runner's report on its own job. Writing the seat's plate
   * (`runnerState`) needs the seat's token as well, which the relay checks against the job.
   */
  async updateJob(jobId: string, update: JobUpdateInput, o: { seatToken?: string } = {}): Promise<JobUpdateResult> {
    const out = await this.onSession('POST', this.jobPath(jobId), { body: update, ...(o.seatToken ? { seat: o.seatToken } : {}) });
    return this.parse(JobUpdateAnswer, out, 'POST /api/runner/jobs/:id') as JobUpdateResult;
  }

  /** `POST /api/runner/heartbeat`: renews the leases of the jobs running here, and says which the relay withdrew. */
  async heartbeat(input: HeartbeatInput): Promise<HeartbeatResult> {
    // The base capabilities alone where the registration learned the relay refuses the rest, and once
    // more with them alone should a heartbeat be refused for them (a relay rolled back meanwhile).
    let sent: RunnerCapabilities | undefined;
    const body = (base: boolean) => () => {
      sent = base || this.baseCapsOnly ? baseCapabilities(input.capabilities) : input.capabilities;
      return { ...input, capabilities: sent };
    };
    let out: unknown;
    try {
      out = await this.onSession('POST', '/api/runner/heartbeat', { bodyNow: body(false) });
    } catch (e) {
      if (!(e instanceof RelayError) || e.status !== 400 || !saysMore(sent)) throw e;
      out = await this.onSession('POST', '/api/runner/heartbeat', { bodyNow: body(true) });
      this.baseCapsOnly = true;
    }
    return this.parse(HeartbeatAnswer, out, 'POST /api/runner/heartbeat') as HeartbeatResult;
  }

  /** `POST /api/runner/jobs/:id/held`: a packet held for review, or the team's decision on it. */
  async held(jobId: string, input: HeldInput, seatToken: string): Promise<unknown> {
    return await this.onSession('POST', this.jobPath(jobId, '/held'), { body: input, seat: seatToken });
  }

  /** `POST /api/runner/ledger`: the outbound ledger's content-free lines, at each seat's report level (runner/ledger-sync.ts). */
  async syncLedger(input: LedgerSyncInput): Promise<LedgerSyncResult> {
    return this.parse(LedgerSyncAnswer, await this.onSession('POST', '/api/runner/ledger', { body: input }), 'POST /api/runner/ledger') as LedgerSyncResult;
  }

  /**
   * A POST on the runner's session to one of the relay's runner routes, for a module with wire
   * types of its own (the effects loop, runner/effects/relay.ts): registered first if need be, sent
   * again as `onSession` does, and every error scrubbed. Only a path under `/api/runner/` goes.
   */
  async runnerCall(path: string, c: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (!/^\/api\/runner\/[a-z0-9/_-]+$/i.test(path)) throw this.fail('rejected', 0, 'a runner call goes to a runner route');
    return await this.onSession('POST', path, c);
  }

  // -------------------------------------------------------------- the seat's routes

  /**
   * `GET /api/seat` with the seat token: which seat of which room the token opens. It moves no
   * cursor and counts as no call from the seat's agent, so the dispatch check can read it before
   * anything starts. An end-to-end room is served as stored (`x-parley-e2ee: envelopes`): its
   * fields are ciphertext here, and only the ids, the status and the seat's row are read.
   */
  async seatPage(seatToken: string): Promise<SeatPage> {
    const out = await this.call('GET', '/api/seat', { seat: seatToken, e2eeEnvelopes: true });
    const r = this.parse(SeatPageAnswer, out, 'GET /api/seat');
    const s = r.snapshot;
    const me = s.participants.find((p) => p.id === s.seat) ?? null;
    return {
      participantId: s.seat,
      sessionId: s.session.id,
      status: s.session.status,
      e2ee: s.session.e2ee,
      seat: me
        ? { id: me.id, sessionId: me.sessionId, kind: me.kind, finishedAt: me.finishedAt, leftAt: me.leftAt, standingLabel: me.standing?.label ?? null }
        : null,
      dispatchRoom: r.dispatchRoom ? { project: r.dispatchRoom.project, team: r.dispatchRoom.team } : null,
      snapshot: s as unknown as SessionSnapshot,
    };
  }

  /** `GET /api/seat/op/status`: the seat's `status`, which moves nothing. */
  seatStatus(seatToken: string): Promise<unknown> {
    return this.call('GET', '/api/seat/op/status', { seat: seatToken });
  }

  /** `POST /api/seat/op/:op`: one of the seat's operations, as `/j/<token>/<op>?format=json` answers it, the token kept out of the path. */
  async seatOp(seatToken: string, op: string, args: Record<string, unknown> = {}, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    if (!OP.test(op)) throw this.fail('rejected', 0, 'that is not an operation');
    return await this.call('POST', `/api/seat/op/${op}`, { body: args, seat: seatToken, ...o });
  }

  /**
   * Declares every seat in `seats` (the configuration's, by label) from the store's rows, and
   * records the ids the relay gives them (`RunnerStore.noteDeclared`). A seat is declared by its ask
   * token's hash, never the token (`declaredSeat`), and a seat the configuration no longer has is
   * left out, which the relay treats as revoked.
   */
  async syncSeats(store: RunnerStore, seats: readonly SeatDeclarationSource[]): Promise<SeatsResult> {
    const declared: DeclaredSeat[] = [];
    for (const conf of seats) {
      const row = store.seat(conf.label);
      if (row) declared.push(declaredSeat(row, conf));
    }
    const result = await this.declareSeats({ seats: declared });
    store.noteDeclared(result.seats);
    return result;
  }

  /**
   * `GET /api/seat/events`: the seat's live stream, as the open `Response` for the caller to read.
   * It has no deadline of its own (a stream is meant to stay open); stop it with `signal`.
   */
  seatEvents(seatToken: string, o: { after?: number; signal?: AbortSignal } = {}): Promise<Response> {
    const after = Math.max(0, Math.trunc(o.after ?? 0));
    return this.send('GET', `/api/seat/events${after ? `?after=${after}` : ''}`, {
      seat: seatToken,
      accept: 'text/event-stream',
      timeoutMs: 0,
      ...(o.signal ? { signal: o.signal } : {}),
    });
  }
}
