/**
 * The standing runner's wire contract: every body and answer of
 * `/api/runner/*`, `/api/ask` and `/api/seat/op/*`, and the codes, reasons and constant sentences
 * the relay and a `crossroom runner` both read.
 *
 * Enum-like values are string unions validated here in code, never CHECK constraints in SQL,
 * because the job kinds and the reasons grow and a CHECK would force a table rebuild.
 *
 * Pure: zod and nothing from Node. The web app may import from here with `import type` only,
 * because a value import would pull zod into the browser bundle.
 */
import { z } from 'zod';
import { GrantLimits } from './connections.js';
import { ContextKind } from './index.js';
import { SLACK_CHANNEL, SLACK_THREAD, TRUSTED_VALUE } from './playbook.js';
import type { LaneTally } from './lane.js';

// ---------------------------------------------------------------- credentials

/** A runner token, minted once by `POST /api/runner/tokens` and stored on the relay as its hash. */
export const RUNNER_TOKEN_PREFIX = 'rt_';
/** A runner's session credential from `POST /api/runner/register`: 32 random bytes, in memory for 12 h. */
export const RUNNER_SESSION_PREFIX = 'rs_';
/** How long a runner session lasts before the runner registers again. */
export const RUNNER_SESSION_HOURS = 12;
/**
 * The one 401 body for every runner route, whatever was wrong with the credential: unknown,
 * expired, revoked, of the wrong kind, or absent. Two different answers would tell a stranger
 * which tokens once existed.
 */
export const RUNNER_REFUSED = 'not a Crossroom runner, or no longer one';
/** The one 404 body for an ask link that opens nothing: unknown, rotated, revoked, or its runner gone. */
export const ASK_GONE = 'This ask link does not open anything any more. Ask whoever gave it to you for a fresh one.';
/** The header an ask token travels in. Never a query string: a query ends up in access logs. */
export const ASK_HEADER = 'x-parley-ask';

/** A token as the runner mints it: its prefix, then 24 random bytes in base64url. */
export const RUNNER_TOKEN = /^rt_[A-Za-z0-9_-]{32}$/;
export const RUNNER_SESSION = /^rs_[A-Za-z0-9_-]{43}$/;

// ---------------------------------------------------------------- limits

/** Seats one self-served runner token may hold; the admin token can mint more (`MintRunnerTokenInput`). */
export const DEFAULT_MAX_SEATS = 2;
/** Self-served runner tokens one network may mint in a day. */
export const MINTS_PER_NETWORK_PER_DAY = 5;
/** The instance's cap on runners, from `PARLEY_MAX_RUNNERS`, when the environment does not set it. */
export const DEFAULT_MAX_RUNNERS = 500;
/** What a lease parks for by default, and its bounds, in seconds. The upper bound stays under `WAIT_MAX_S`. */
export const LEASE_WAIT_S = { default: 45, min: 5, max: 50 } as const;
/** How often a runner heartbeats, in seconds. */
export const HEARTBEAT_S = 30;
/** How long a leased job is the runner's before the relay may lease it again, in seconds. */
export const LEASE_S = 90;
/** Leases a job may take before it fails with `lease_exhausted`. */
export const MAX_ATTEMPTS = 5;
/** A runner silent this long is `lost`: its leased jobs past their lease go back to the queue. */
export const RUNNER_LOST_MINUTES = 3;
/** A runner silent this long is revoked with its seats, and their ask links die. */
export const RUNNER_ABANDONED_DAYS = 14;
/** Owner-registered claims one room may hold (`POST /api/sessions/:id/claims`, the server's `createOwnerClaim`). */
export const OWNER_CLAIMS_MAX = 10;
/** Claims an ask may register with its room (`AskInput.claims`). */
export const ASK_CLAIMS_MAX = 3;

// ---------------------------------------------------------------- jobs

/**
 * What the relay can ask a runner to do: start an agent in a standing seat of a room an ask just
 * opened (`start_seat`), or check a fact's sources again in the seat's checkout (`recheck`),
 * which names no room and no participant. `runner_jobs.kind` has no CHECK,
 * so kinds can be added. A runner that predates a kind cannot parse its lease entry, sets it aside
 * as malformed and refuses it as `bad_seal` (runner/client.ts `lease`): it never runs it.
 */
export const JobKind = z.enum(['start_seat', 'recheck']);
export type JobKind = z.infer<typeof JobKind>;

/**
 * A job's state on the relay.
 * - `queued`: waiting for a lease.
 * - `leased`: handed to the runner, which has `LEASE_S` to say it started.
 * - `running`: the runner's agent is in the room. A lost runner's running jobs stay put: it
 *   resumes them itself.
 * - `done`, `failed`, `refused` (the runner's dispatch check said no), `cancelled` (the relay
 *   withdrew it: rotation, revocation, the room deleted).
 */
export const JobState = z.enum(['queued', 'leased', 'running', 'done', 'failed', 'refused', 'cancelled']);
export type JobState = z.infer<typeof JobState>;
/** The states a runner may report (`JobUpdateInput.state`); the relay sets the others. */
export const RunnerReportedState = z.enum(['running', 'done', 'failed', 'refused']);
export type RunnerReportedState = z.infer<typeof RunnerReportedState>;

/**
 * A job's id: `job_` and 16 random bytes in base64url (`newJobId` in the client's jobseal.ts).
 * Random, never derived from the room, because a job row outlives its room with the room's ids
 * nulled. Chosen by whoever seals the job, before sealing, since the seal binds it (`jobAad`).
 */
export const JOB_ID = /^job_[A-Za-z0-9_-]{22}$/;

/**
 * Why a job was refused, failed or cancelled: a code, never a sentence, so neither side's
 * errors, paths or policy ever cross in words. `runner_jobs.reason` stores one of these.
 *
 * The runner's dispatch check, in its order: `bad_seal`, `envelope_mismatch`,
 * `wrong_relay`, `unknown_seat`, `seat_paused`, `ask_unknown`, `ask_retired`, `ask_epoch`,
 * `replayed_job`, `replayed_seat`, `stale`, `future`, `rate_limited`, `seat_mismatch`.
 * The run: `cli_missing`, `signed_out`, `limited`, `budget_spent`, `error`.
 * The relay: `lease_exhausted`, `rotated`, `revoked`, `room_deleted`, `room_ended`, `rekeyed`.
 */
export const RunnerReason = z.enum([
  'bad_seal',
  'envelope_mismatch',
  'wrong_relay',
  'unknown_seat',
  'seat_paused',
  'ask_unknown',
  'ask_retired',
  'ask_epoch',
  'replayed_job',
  'replayed_seat',
  'stale',
  'future',
  'rate_limited',
  'seat_mismatch',
  'cli_missing',
  'signed_out',
  'limited',
  'budget_spent',
  'error',
  'lease_exhausted',
  'rotated',
  'revoked',
  'room_deleted',
  'room_ended',
  'rekeyed',
  // A dispatch whose `may_ask` grant this runner did not mint for that seat and that room (runner/grants.ts).
  'grant_refused',
]);
export type RunnerReason = z.infer<typeof RunnerReason>;

/**
 * What a standing seat's plate says, as a code. The relay turns each into the
 * constant sentence in `RUNNER_NOTES` and stores only that, so the answering team's errors and
 * paths never reach the asker.
 */
export const RunnerNoteCode = z.enum(['starting', 'thinking', 'waiting', 'idle', 'signed_out', 'limited', 'budget_spent', 'refused', 'stopped', 'error']);
export type RunnerNoteCode = z.infer<typeof RunnerNoteCode>;

/** The sentence each code shows, and the runner state (`Participant.runnerState`) it sets. */
export const RUNNER_NOTES: Readonly<Record<RunnerNoteCode, { state: 'idle' | 'starting' | 'thinking' | 'waiting' | 'stopped' | 'error'; note: string }>> = {
  starting: { state: 'starting', note: "The answering team's runner is starting its agent." },
  thinking: { state: 'thinking', note: "The answering team's agent is working." },
  waiting: { state: 'waiting', note: "The answering team's agent is waiting for the room." },
  idle: { state: 'idle', note: "The answering team's agent is idle until something happens here." },
  signed_out: { state: 'error', note: "The answering team's agent is signed out of its CLI; they have been told." },
  limited: { state: 'error', note: "The answering team's agent hit a usage limit; it may come back later." },
  budget_spent: { state: 'stopped', note: "This seat has used its team's budget for one room, so it stopped." },
  refused: { state: 'stopped', note: "The answering team's runner declined this job." },
  stopped: { state: 'stopped', note: "The answering team's runner stopped this seat's agent." },
  error: { state: 'error', note: "The answering team's runner hit an error; they have been told." },
};

/** A `may_ask` grant token as a runner mints it: `sg_` and 32 random bytes in base64url. Never stored whole by the runner. */
export const GRANT_TOKEN_PREFIX = 'sg_';
export const GRANT_TOKEN = /^sg_[A-Za-z0-9_-]{43}$/;
/** Who a grant lets dispatch into a seat: a project's rooms, or a team's. Ids only, never names. */
export const GRANT_PRINCIPAL = /^(?:project:proj_|team:team_)[A-Za-z0-9_-]{22}$/;

/** A grant as a dispatch into a project's (or a team's) room would carry it. */
export const DispatchGrant = z.object({ principal: z.string().regex(GRANT_PRINCIPAL), token: z.string().regex(GRANT_TOKEN) }).strict();
export type DispatchGrant = z.infer<typeof DispatchGrant>;

/**
 * An account's own agents (calls from a room the account holds into a side room). An account id as
 * the directory makes it (`acct_` and base64url), and the grant subject that lets a standing seat be
 * called into rooms that account holds: `account:<accountId>`, in `seat_grants` beside the runner's
 * own `project:` and `team:` grants. The account grants it from its personal workspace; the runner
 * mints no token for it, and learns it from its grants' sync (`GrantsResult.accounts`).
 */
export const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{1,64}$/;
export const ACCOUNT_PRINCIPAL_PREFIX = 'account:';
export const accountPrincipal = (accountId: string) => `${ACCOUNT_PRINCIPAL_PREFIX}${accountId}`;
/** A call's id (`agent_calls.id`): `call_` and 22 base64url characters. */
export const CALL_ID = /^call_[A-Za-z0-9_-]{22}$/;
/** How a granted seat takes a call: the account approves each one first (`ask`, the default), or it joins when asked (`join`). */
export const AgentCallMode = z.enum(['ask', 'join']);
export type AgentCallMode = z.infer<typeof AgentCallMode>;
/**
 * What a call job carries: the account whose grant lets the seat in, and the call it answers.
 * `direct`: the account itself made the call, from outside any room (`crossroom call`, the
 * account's own connector), never an agent seated in one of its rooms. The runner keeps notes
 * between such calls only. A runner from before it parses this strictly
 * and would refuse the job as `bad_seal`, so the relay sets it only for a runner that declared
 * `RunnerCapabilities.callNotes`.
 */
export const DispatchCall = z
  .object({ accountId: z.string().regex(ACCOUNT_ID), callId: z.string().regex(CALL_ID), direct: z.literal(true).optional() })
  .strict();
export type DispatchCall = z.infer<typeof DispatchCall>;

/**
 * A job as the runner opens it (`openJob` in the client's jobseal.ts). Sealed to the runner's X25519
 * key: the relay keeps only the ciphertext and `sha(seatToken)`, so a copy of its database cannot
 * take a standing seat. It never carries a directory, a command, a flag, a model, a prompt or a
 * policy: those are the runner's own configuration.
 */
export const StartSeatPayload = z
  .object({
    v: z.literal(1),
    /** The id the job is queued under (`JobQueue.enqueue`): the runner refuses a payload whose id is not its envelope's. */
    jobId: z.string().regex(JOB_ID),
    runnerId: z.string().min(1).max(64),
    kind: z.literal('start_seat'),
    seatId: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(64),
    participantId: z.string().min(1).max(64),
    /** The standing participant's invite token: the only copy the relay ever had, forgotten on commit. */
    seatToken: z.string().min(16).max(128),
    /** The ask token that opened the room, and its epoch, so the runner can prove the ask was one it issued. */
    ask: z.object({ token: z.string().min(16).max(128), epoch: z.number().int().min(0) }).strict().optional(),
    /**
     * Or, for a room across a connection, which connection and grant let it in, at which
     * epoch, under which limits: the runner takes it only through a grant its own configuration lists
     * for the seat (connections/runner-check.ts).
     */
    connection: z
      .object({ id: z.string().min(1).max(64), grant: z.string().min(1).max(64), epoch: z.number().int().min(1), limits: GrantLimits })
      .strict()
      .optional(),
    /**
     * Or, for a room a project's playbook opened (seat dispatch), the
     * `may_ask` grant the runner minted for that project: the runner takes the job only when its own
     * grant book holds this principal and token for the seat (`GrantBook.check`), and only into a
     * room the seat page says is that project's. A runner without `RunnerCapabilities.grantDispatch`
     * refuses it as `bad_seal`, so the relay never sends one there.
     */
    grant: DispatchGrant.optional(),
    /**
     * Or, for a side room an agent called the seat into from a room its account holds (an account's
     * own agents), the account whose grant lets it in and the call: the runner takes the job only
     * when the seat holds a live `account:<accountId>` grant as its last grants' sync told it
     * (`GrantBook.checkCall`). A runner without `RunnerCapabilities.accountCalls` refuses it as
     * `bad_seal`, so the relay opens no call room for one.
     */
    call: DispatchCall.optional(),
    /** The relay's public URL: the runner refuses a job naming any relay but the one it registered with. */
    relay: z.string().url().max(512),
    issuedAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (p) => [p.ask, p.connection, p.grant, p.call].filter((x) => x !== undefined).length === 1,
    'a job carries exactly one of an ask token, a connection, a grant or a call',
  );
export type StartSeatPayload = z.infer<typeof StartSeatPayload>;

// ---------------------------------------------------------------- re-checking a fact

export const RecheckSource = z
  .object({
    /** The source's position in the fact's sources, which the report answers by. */
    idx: z.number().int().min(0).max(63),
    packet: z.string().min(1).max(16),
    source: z.string().min(1).max(2000),
    kind: ContextKind,
    body: z.string().max(60_000),
  })
  .strict();
export type RecheckSource = z.infer<typeof RecheckSource>;

/** What a `recheck` job asks a standing seat's runner to check, inside its `RecheckPayload`. */
export const RecheckRequest = z
  .object({
    v: z.literal(1),
    kind: z.literal('recheck'),
    factId: z.string().min(1).max(64),
    label: z.string().min(1).max(16),
    sources: z.array(RecheckSource).min(1).max(8),
  })
  .strict();
export type RecheckRequest = z.infer<typeof RecheckRequest>;

export const RecheckStatus = z.enum(['checked', 'partial', 'differs', 'not_found', 'unchecked']);
export type RecheckStatus = z.infer<typeof RecheckStatus>;

/** What the runner reports back (`JobUpdateInput.recheck`): counts and a commit, never a line of the file. */
export const RecheckReport = z
  .object({
    factId: z.string().min(1).max(64),
    results: z
      .array(
        z
          .object({
            idx: z.number().int().min(0).max(63),
            status: RecheckStatus,
            found: z.number().int().min(0).max(100_000).optional(),
            of: z.number().int().min(0).max(100_000).optional(),
            commit: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type RecheckReport = z.infer<typeof RecheckReport>;

/**
 * A `recheck` job as the runner opens it (`openRecheckJob` in the client's jobseal.ts), sealed to
 * its X25519 key like a `start_seat` job, under an AAD that names the kind, so neither kind's
 * payload opens as the other. It carries no token: the runner checks the seat is its own, the
 * relay is its own and the job is fresh, and reads only what that seat already let out (its
 * outbound ledger, runner/recheck.ts).
 */
export const RecheckPayload = z
  .object({
    v: z.literal(1),
    jobId: z.string().regex(JOB_ID),
    runnerId: z.string().min(1).max(64),
    kind: z.literal('recheck'),
    seatId: z.string().min(1).max(64),
    relay: z.string().url().max(512),
    issuedAt: z.string().datetime(),
    request: RecheckRequest,
  })
  .strict();
export type RecheckPayload = z.infer<typeof RecheckPayload>;

/** A job as a lease hands it over. `payload` is the sealed `j1.` string, opaque to the relay. */
export const LeasedJob = z
  .object({
    id: z.string().regex(JOB_ID),
    kind: JobKind,
    standingSeatId: z.string(),
    sessionId: z.string().nullable(),
    participantId: z.string().nullable(),
    payload: z.string(),
    createdAt: z.string(),
    leaseUntil: z.string(),
  })
  .strict();
export type LeasedJob = z.infer<typeof LeasedJob>;

// ---------------------------------------------------------------- policy

export const WhenSecret = z.enum(['hold', 'refuse']);
export type WhenSecret = z.infer<typeof WhenSecret>;

/** Budgets per room unless named otherwise. `concurrent`, `perHour` and `perDay` are rooms. */
export const SeatBudget = z
  .object({
    messages: z.number().int().min(1).max(500),
    packets: z.number().int().min(0).max(200),
    minutes: z.number().int().min(1).max(24 * 60),
    spendUsd: z.number().min(0).max(1000).optional(),
    concurrent: z.number().int().min(1).max(50),
    perHour: z.number().int().min(1).max(500),
    perDay: z.number().int().min(1).max(5000).optional(),
  })
  .strict();
export type SeatBudget = z.infer<typeof SeatBudget>;

/** A secret pattern the team adds to `SECRET_PATTERNS` (policy.ts), by name. */
export const ExtraSecret = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), regex: z.string().min(1).max(500) }).strict();

/**
 * A standing seat's whole policy, as the runner reads it from the seat's config and its
 * `.parley/policy.yml` at the answering commit. The runner enforces it first, in its egress proxy.
 */
export const SeatPolicy = z
  .object({
    /** Globs of paths no packet may come from or name (picomatch, matched case-insensitively on Windows). */
    deny: z.array(z.string().min(1).max(300)).max(200),
    secretScan: z.boolean(),
    extraSecrets: z.array(ExtraSecret).max(50).optional(),
    review: z
      .object({
        paths: z.array(z.string().min(1).max(300)).max(200),
        kinds: z.array(ContextKind).max(10),
        whenSecret: WhenSecret,
        timeoutMinutes: z.number().int().min(1).max(7 * 24 * 60),
      })
      .strict(),
    budget: SeatBudget,
  })
  .strict();
export type SeatPolicy = z.infer<typeof SeatPolicy>;

/**
 * The part of a seat's policy the relay holds, for its second line (`beforeShare`, in rooms that
 * are not end-to-end) and its limits on asks. Sent with every `POST /api/runner/seats`.
 */
export const PolicySummary = z
  .object({
    deny: SeatPolicy.shape.deny,
    secretScan: z.boolean(),
    budget: SeatBudget.pick({ messages: true, packets: true, minutes: true, concurrent: true, perHour: true }),
  })
  .strict();
export type PolicySummary = z.infer<typeof PolicySummary>;

/** What the outbound check decides about one call (`checkOutbound`, policy.ts). */
export type PolicyVerdict = { ok: true } | { ok: false; action: 'refuse' | 'hold'; rule: string; message: string };

/** Which line decided: the runner's proxy, or the relay's `beforeShare`. `policy_events.line`. */
export const PolicyLine = z.enum(['runner', 'relay']);
export type PolicyLine = z.infer<typeof PolicyLine>;

/** What happened to one outbound call, in the runner's ledger and in `policy_events.decision`. */
export const PolicyDecision = z.enum(['sent', 'refused', 'held', 'released', 'refused_after_review']);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

/**
 * One content-free line of what the policy did, as a runner reports it (`JobUpdateInput.policy`).
 * `rule` is a rule's name (`deny`, `secret:aws_access_key`, `review:path`, `budget:packets`), never
 * the glob or the text that matched.
 */
export const PolicyEventInput = z
  .object({ op: z.string().regex(/^[a-z_]{1,32}$/), rule: z.string().regex(/^[a-z_]+(:[a-z0-9_]+)?$/).max(64), decision: PolicyDecision })
  .strict();
export type PolicyEventInput = z.infer<typeof PolicyEventInput>;

// ---------------------------------------------------------------- holds

/** Why a packet is held for review: a rule class, never the path or the secret. `packet_holds.why`. */
export const HoldReason = z.enum(['review_path', 'review_kind', 'secret']);
export type HoldReason = z.infer<typeof HoldReason>;
/** How a hold ended. `packet_holds.resolution`. */
export const HoldResolution = z.enum(['approved', 'refused', 'expired']);
export type HoldResolution = z.infer<typeof HoldResolution>;
export const HOLD_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** `POST /api/runner/jobs/:id/held`: a packet held, or the team's decision on it. */
export const HeldInput = z.union([
  z.object({ holdId: z.string().regex(HOLD_ID), kind: ContextKind, bytes: z.number().int().min(0).max(10_000_000), why: HoldReason }).strict(),
  z.object({ holdId: z.string().regex(HOLD_ID), resolution: HoldResolution }).strict(),
]);
export type HeldInput = z.infer<typeof HeldInput>;

// ---------------------------------------------------------------- the runner's routes

/** `POST /api/runner/tokens`. Anyone may send `{}`; the other fields need the admin token. */
export const MintRunnerTokenInput = z
  .object({
    name: z.string().min(1).max(60).optional(),
    maxSeats: z.number().int().min(1).max(100).optional(),
    expiresAt: z.string().datetime().optional(),
    /** CIDRs the token may register from. */
    networks: z.array(z.string().min(3).max(64)).max(20).optional(),
  })
  .strict();
export type MintRunnerTokenInput = z.infer<typeof MintRunnerTokenInput>;
/** Answered once: the relay keeps only the token's hash. */
export interface MintRunnerTokenResult {
  runnerId: string;
  runnerToken: string;
  maxSeats: number;
  expiresAt: string | null;
}

export const CliHealth = z.enum(['ok', 'signed_out', 'limited', 'unknown']);
export type CliHealth = z.infer<typeof CliHealth>;
/** The runtimes a standing seat may use. Antigravity stays `hostedBlocked` (SECURITY.md, the runner table). */
export const StandingRuntime = z.enum(['claude', 'codex', 'grok']);
export type StandingRuntime = z.infer<typeof StandingRuntime>;

export const RunnerCapabilities = z
  .object({
    os: z.string().max(40),
    clis: z
      .array(
        z
          .object({ id: StandingRuntime, version: z.string().max(40).nullable(), available: z.boolean(), health: CliHealth })
          .strict(),
      )
      .max(10),
    /**
     * The runner takes a `StartSeatPayload.grant` (seat dispatch from a project's playbook). Absent on
     * a runner from before it, which refuses such a job: the relay then leaves the seat open as
     * `runner_outdated` rather than send one.
     */
    grantDispatch: z.boolean().optional(),
    /**
     * The runner reads an effect's `approvedDigest` (a gate's bound approval). A runner from before
     * it parses effects strictly and would refuse one carrying it as `bad_seal`, so the relay sends
     * such a runner the approved text without the digest, as it did before.
     */
    approvedEffects: z.boolean().optional(),
    /**
     * The runner takes a `StartSeatPayload.call` (an account's own agent called into a side room),
     * and reads `GrantsResult.accounts`. A runner from before it would refuse such a job as
     * `bad_seal` and fail its grants' answer, so the relay opens no call room for it and leaves
     * `accounts` out of its grants' answer.
     */
    accountCalls: z.boolean().optional(),
    /**
     * The runner reads `DispatchCall.direct` and keeps notes between the calls its account made
     * itself. A runner from before it parses `call` strictly, so the relay
     * marks no job `direct` for it.
     */
    callNotes: z.boolean().optional(),
    /**
     * The runner reads trackers for a project (`POST /api/runner/reads/lease`,
     * runner/reads-wire.ts in the client): a member's read of one item, or a saved sync. A runner from before it
     * never leases reads, so the relay queues none for it and says why.
     */
    trackerReads: z.boolean().optional(),
  })
  .strict();
export type RunnerCapabilities = z.infer<typeof RunnerCapabilities>;

/** `POST /api/runner/register`, with `Authorization: Bearer rt_…`. Keys are raw public keys in base64url. */
export const RegisterInput = z
  .object({
    name: z.string().min(1).max(60),
    version: z.string().min(1).max(40),
    publicKeys: z.object({ x25519: z.string().regex(/^[A-Za-z0-9_-]{43}$/), ed25519: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
    capabilities: RunnerCapabilities,
    /** Replace the stored keys. Without it, keys that differ answer 409; with it, queued jobs are cancelled (`rekeyed`). */
    rekey: z.boolean().optional(),
  })
  .strict();
export type RegisterInput = z.infer<typeof RegisterInput>;
export interface RegisterResult {
  runnerId: string;
  session: string;
  sessionExpiresAt: string;
  leaseWaitS: number;
  heartbeatS: number;
  relay: { publicUrl: string; version: string; signingKey: string | null };
  limits: { maxSeats: number };
}

/** An ask token's hash as the runner declares it: sha256 hex of the token it minted. The relay never holds the token. */
export const AskDeclaration = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), epoch: z.number().int().min(0) }).strict();

export const SEAT_LABEL = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** One standing seat as the runner declares it. */
export const DeclaredSeat = z
  .object({
    label: z.string().regex(SEAT_LABEL),
    runtime: StandingRuntime,
    /** Claude Code with `--restricted` only. The relay forces 0 for Codex and Grok. */
    confined: z.boolean(),
    /** Shown on the ask page to whoever holds the link. The runner operator's words, not a secret. */
    description: z.string().max(300),
    ask: AskDeclaration,
    paused: z.boolean(),
    policy: PolicySummary,
  })
  .strict();
export type DeclaredSeat = z.infer<typeof DeclaredSeat>;

/** `POST /api/runner/seats`: the whole list, declaratively. A seat left out is revoked. */
export const SeatsInput = z.object({ seats: z.array(DeclaredSeat).max(100) }).strict();
export type SeatsInput = z.infer<typeof SeatsInput>;
export const StandingSeatState = z.enum(['active', 'paused', 'revoked']);
export type StandingSeatState = z.infer<typeof StandingSeatState>;
export interface SeatsResult {
  seats: Array<{
    id: string;
    label: string;
    state: StandingSeatState;
    /** `<publicUrl>/ask/`: the runner appends the token it minted. */
    askUrlBase: string;
    /** The epoch moved: the old ask link is dead and its rooms' seat tokens were replaced. */
    rotated: boolean;
    /** Seat tokens of an older epoch this call killed, in every room they still opened, live or ended. */
    killed: number;
  }>;
}

/** `POST /api/runner/lease`: park for up to `waitS` for at most `max` jobs. */
export const LeaseInput = z
  .object({
    waitS: z.number().int().min(LEASE_WAIT_S.min).max(LEASE_WAIT_S.max).optional(),
    max: z.number().int().min(1).max(5).optional(),
  })
  .strict();
export type LeaseInput = z.infer<typeof LeaseInput>;
/**
 * What the relay tells a runner on every lease and heartbeat: which of its seats are paused, and,
 * for a runner in a team's fleet, what its team asks of it. A runner
 * reads the team's fields loosely (runner/fleet-control.ts), so an older relay that sends none asks
 * for nothing.
 */
export interface RunnerControl {
  paused: string[];
  /** Standing seat ids whose team asked for a new ask link the runner has not declared yet: the runner mints it. */
  rotate?: string[];
  /**
   * The team's last stop-all, a stamp on the relay's clock, sent only while it is later than the
   * runner's last registration. A stamp the runner has not acted on stops every agent it runs.
   */
  stopBefore?: string | null;
}
export interface LeaseResult {
  jobs: LeasedJob[];
  control: RunnerControl;
}

/**
 * `POST /api/runner/jobs/:id`. Writing seat state (`runnerState`) also needs the seat's own token
 * in `x-parley-seat`, so a runner session alone cannot write into a room. A `recheck` job's report
 * is its state and `recheck`, nothing else.
 */
export const JobUpdateInput = z
  .object({
    state: RunnerReportedState.optional(),
    reason: RunnerReason.optional(),
    runnerState: z.object({ note: RunnerNoteCode }).strict().optional(),
    cost: z
      .object({ usd: z.number().min(0).max(10_000).optional(), tokensIn: z.number().int().min(0).optional(), tokensOut: z.number().int().min(0).optional() })
      .strict()
      .optional(),
    policy: z.array(PolicyEventInput).max(100).optional(),
    /** A `recheck` job's report, with `state: 'done'`: accepted once, and only on that runner's own recheck job. */
    recheck: RecheckReport.optional(),
  })
  .strict();
export type JobUpdateInput = z.infer<typeof JobUpdateInput>;
export interface JobUpdateResult {
  ok: true;
  job: { id: string; state: JobState; reason: RunnerReason | null };
  /** The relay withdrew the job meanwhile: stop its agent. */
  cancel?: boolean;
}

/** `POST /api/runner/heartbeat`: renews the leases of the jobs listed as running. */
export const HeartbeatInput = z.object({ capabilities: RunnerCapabilities.optional(), running: z.array(z.string().regex(JOB_ID)).max(100) }).strict();
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;
export interface HeartbeatResult {
  ok: true;
  sessionExpiresAt: string;
  control: RunnerControl;
  /** Jobs the runner listed that the relay withdrew: stop their agents. */
  cancel: string[];
}

// ---------------------------------------------------------------- a team's fleet

// The grant token, its principal and `DispatchGrant` are above `StartSeatPayload`, which carries one.
/** Grants one seat may hold at once. */
export const GRANTS_PER_SEAT = 20;

/**
 * One grant in `POST /api/runner/grants`: a new one with its token, or one the relay holds already
 * by its hash (sha256 hex of the token).
 */
export const GrantEntry = z.union([
  z.object({ principal: z.string().regex(GRANT_PRINCIPAL), token: z.string().regex(GRANT_TOKEN) }).strict(),
  z.object({ principal: z.string().regex(GRANT_PRINCIPAL), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
]);
export type GrantEntry = z.infer<typeof GrantEntry>;
/** `POST /api/runner/grants` (a team runner's session): one seat's grants, declaratively. A principal left out is revoked. */
export const GrantsInput = z.object({ seat: z.string().regex(SEAT_LABEL), grants: z.array(GrantEntry).max(GRANTS_PER_SEAT) }).strict();
export type GrantsInput = z.infer<typeof GrantsInput>;
export interface GrantsResult {
  seat: string;
  /** The grants the relay holds for the seat now, of those the call listed. */
  grants: Array<{ principal: string }>;
  /** Grants the relay held that the call did not keep, revoked by it. */
  revoked: number;
  /** Listed by a hash the relay does not hold (the seat was declared anew, say): the runner mints each again. */
  missing?: string[];
  /** Naming no live project or team of the runner's organisation: never stored. */
  dropped?: string[];
  /**
   * The accounts whose rooms may call the seat in (live `account:<id>` grants, which the account
   * makes, not the runner), as account ids. Sent only to a runner that declared
   * `RunnerCapabilities.accountCalls`; the runner keeps the list whole until the next sync.
   */
  accounts?: string[];
}

/**
 * `POST /api/runner/links` (a team runner's session): a seat's ask link after a rotation its team
 * asked for (`RunnerControl.rotate`). The relay takes only the seat's current token, and seals it
 * under the organisation key for the team's maintainers.
 */
export const LinkInput = z.object({ seat: z.string().regex(SEAT_LABEL), askToken: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) }).strict();
export type LinkInput = z.infer<typeof LinkInput>;

/** Where a dispatch's room is, as the seat page would tell the runner: its project, and the team whose rooms it is; each null for none. */
export interface DispatchRoom {
  project: string | null;
  team: string | null;
}

// ---------------------------------------------------------------- ask links

/** `GET /api/ask` with `x-parley-ask`: what the page shows before anyone asks. No side effect. */
export interface AskInfo {
  label: string;
  description: string;
  runtime: StandingRuntime;
  /** False for Codex and Grok: the page says the seat's reads are not confined. */
  confined: boolean;
  online: boolean;
  lastSeenAt: string | null;
  paused: boolean;
}

/** `POST /api/ask` with `x-parley-ask`, Origin-checked. */
export const AskInput = z
  .object({
    question: z.string().min(3).max(2000),
    title: z.string().min(1).max(120).optional(),
    /** The asker's seat name. `Asker` when left out. */
    name: z.string().min(1).max(60).optional(),
    /** Owner-registered claims for the room (the consumer check's verdict source). */
    claims: z.array(z.string().min(3).max(500)).max(ASK_CLAIMS_MAX).optional(),
  })
  .strict();
export type AskInput = z.infer<typeof AskInput>;

/** 201. The asker's owner token and seat A only: seat B's token exists only sealed to the runner's key. */
export interface AskResult<Session = unknown, AskerSeat = unknown> {
  session: Session;
  ownerToken: string;
  ownerUrl: string;
  participants: [AskerSeat];
  standing: { label: string; runtime: StandingRuntime; confined: boolean; online: boolean };
}

/** The asker's seat name when the ask gives none, and the standing seat's (`<label> (standing)`). */
export const ASKER_NAME = 'Asker';
export const standingSeatName = (label: string) => `${label} (standing)`;

/**
 * The ask brief the relay writes after the question, in these words. `%LABEL%` is
 * the seat's label.
 */
export const ASK_BRIEF_TAIL = [
  'Seat B is %LABEL%, a standing seat: an agent the team that owns this repository runs on its own machine.',
  'It answers from that code, shares excerpts with their sources, and its team\'s policy may hold or refuse a',
  'packet. Seat A asked. Register a claim for anything the files can settle; finish once A has its answer.',
].join('\n');

/** An ask room's shared brief: the question, then the relay's words (`ASK_BRIEF_TAIL`). */
export const askBrief = (question: string, label: string) => `${question}\n\n${ASK_BRIEF_TAIL.replace('%LABEL%', label)}`;

/**
 * An ask room's brief taken apart again, for the standing seat's briefing, which fences the
 * question (the asker is a stranger to the answering team) and prints the relay's words after the
 * fence. A brief not in `askBrief`'s shape is all question, with no words of the relay's.
 */
export function splitAskBrief(brief: string, label: string): { question: string; tail: string } {
  for (const words of [ASK_BRIEF_TAIL, CALL_BRIEF_TAIL]) {
    const tail = words.replace('%LABEL%', label);
    if (brief.endsWith(`\n\n${tail}`)) return { question: brief.slice(0, -(tail.length + 2)), tail };
  }
  return { question: brief, tail: '' };
}

/**
 * The words the relay writes after an agent's call in a side room's brief (an account's own
 * agents). `%LABEL%` is the called seat's label. The seat's briefing fences what seat A wrote and
 * prints these after the fence, as for an ask (`splitAskBrief`).
 */
export const CALL_BRIEF_TAIL = [
  'Seat B is %LABEL%, a standing seat: an agent the owner of this room runs on their own machine. Seat A',
  "is another of the owner's agents, which called it in from a room the owner holds. Work with A on what",
  'it asked, share excerpts with their sources, and finish once A has what it came for: the recap goes back.',
].join('\n');

/** A side room's shared brief: why seat A called, what it brought, then the relay's words (`CALL_BRIEF_TAIL`). */
export const callBrief = (why: string, brief: string | null | undefined, label: string) =>
  `${brief?.trim() ? `${why.trim()}\n\n${brief.trim()}` : why.trim()}\n\n${CALL_BRIEF_TAIL.replace('%LABEL%', label)}`;

// ---------------------------------------------------------------- owner claims and the dashboard

/** `POST /api/sessions/:id/claims`, owner only, live rooms only, at most `OWNER_CLAIMS_MAX`. */
export const OwnerClaimInput = z.object({ text: z.string().min(3).max(500) }).strict();
export type OwnerClaimInput = z.infer<typeof OwnerClaimInput>;

/** `POST /api/dashboard`: the rooms this browser holds, each with its owner token. A wrong token means the room is absent. */
export const DashboardInput = z
  .object({ rooms: z.array(z.object({ id: z.string().min(1).max(64), owner: z.string().min(1).max(128) }).strict()).max(50) })
  .strict();
export type DashboardInput = z.infer<typeof DashboardInput>;
/**
 * One room on the strip, from columns that are never sealed, so it needs no key: no title (the
 * browser already has each room's from its lookup) and nothing a participant wrote.
 */
export interface DashboardRoom {
  id: string;
  status: 'open' | 'active' | 'ended';
  attention: { yourTurn: number; waitingFor: string[]; lastActivityAt: string; lane?: LaneTally };
  standing?: { label: string; online: boolean };
}

// ---------------------------------------------------------------- the consumer check

/** An environment-variable name: `.parley/consumers.yml` names each ask link by the secret that holds it. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,99}$/;

/**
 * `.parley/consumers.yml`. The ask link itself is never in the file: a literal link in a public
 * repository would let anyone ask the team's seat, so anything shaped like one is refused.
 */
export const ConsumersFile = z
  .object({
    version: z.literal(1),
    consumers: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
            ask_secret: z.string().regex(SECRET_NAME, 'ask_secret names the Actions secret that holds the ask link, never the link'),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    /** `${pr}` and `${consumer}` are filled in per consumer. */
    question: z.string().min(3).max(2000),
  })
  .strict()
  .refine((f) => !JSON.stringify(f).includes('/ask/'), { message: 'consumers.yml holds a literal ask link; put it in a secret and name the secret' });
export type ConsumersFile = z.infer<typeof ConsumersFile>;

/** A consumer check's verdict from claim C1's status: established fails, ruled out passes. */
export type ConsumerVerdict = 'breaks' | 'safe' | 'neutral';

// ---------------------------------------------------------------- what a runner reports seeing

/** `owner/repo` as a trigger's field is checked, and never `.` or `..`, which a URL would read as a path step. */
export const EventRepo = z
  .string()
  .regex(TRUSTED_VALUE['trigger.repo'])
  .refine((r) => r.split('/').every((s) => s !== '.' && s !== '..'), 'a repository is owner/name');

/** Where a Slack command or mention is answered: a channel, and the message whose thread it goes in (a slash command has none). */
export const SlackReplyTarget = z.object({ channel: z.string().regex(SLACK_CHANNEL), thread: z.string().regex(SLACK_THREAD).optional() }).strict();
export type SlackReplyTarget = z.infer<typeof SlackReplyTarget>;

/**
 * A runner's own id for an event: printable ASCII, since a pull request's is `<repo>#<number>@<head
 * sha>` and a Slack event's is Slack's own. The relay keeps only a digest of it.
 */
export const RUNNER_EVENT_ID = /^[!-~]{1,200}$/;

/**
 * An event a team's runner saw (`on: runner`), `POST /api/runner/events`: a pull
 * request its GitHub App's poll found, a slash command or a mention its Slack app received. Only
 * what identifies it and what the person wrote. The one schema of the wire: the runner parses what
 * it sends with it (runner/effects/poll.ts and slack.ts), and the relay what it receives as a
 * playbook trigger, so the two cannot drift into a refusal the runner
 * would retry every pass. The relay's trigger keeps the whitelisted fields and fences the words.
 */
export const RunnerEvent = z.discriminatedUnion('event', [
  z
    .object({
      event: z.literal('github.pull_request'),
      /** `<repo>#<number>@<head sha>`: the same pull request at the same commit is one event. */
      id: z.string().regex(RUNNER_EVENT_ID),
      repo: EventRepo,
      number: z.number().int().min(1),
      head_sha: z.string().regex(TRUSTED_VALUE['trigger.head_sha']),
      head_ref: z.string().regex(TRUSTED_VALUE['trigger.head_ref']),
      base_ref: z.string().regex(TRUSTED_VALUE['trigger.base_ref']),
      author: z.string().regex(TRUSTED_VALUE['trigger.author']),
      /** Untrusted: a stranger's words, fenced by the relay. */
      title: z.string().max(1000),
      body: z.string().max(20_000),
      /**
       * The paths the pull request changes, for a trigger's `paths` filter: at most 3000, as
       * GitHub lists them. Absent, a trigger that filters on paths reads it as a miss.
       */
      paths: z.array(z.string().min(1).max(500)).max(3000).optional(),
    })
    .strict(),
  z
    .object({
      event: z.enum(['slack.command', 'slack.mention']),
      /** Slack's own id for the delivery (`envelope_id`, or a mention's `event_id`). */
      id: z.string().regex(RUNNER_EVENT_ID),
      /** `/parley`, for a slash command. */
      command: z.string().regex(/^\/[a-z0-9-]{1,32}$/).optional(),
      /** Untrusted: what the person typed, and nothing else of theirs. */
      text: z.string().max(4000),
      slack: SlackReplyTarget,
    })
    .strict(),
]);
export type RunnerEvent = z.infer<typeof RunnerEvent>;
