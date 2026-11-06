/**
 * Review before sharing and the outbound ledger, fed by a running runner. The parts
 * (runner/ledger.ts, runner/review.ts, runner/page.ts) were once built and
 * left unfed: the host's proxy answered a held packet "held for review" and kept nothing, so
 * nothing could ever be approved. `ReviewService` is what the host plugs in, through the three
 * seams it already has (`RunnerHostOptions.egress`, `.policyFor`, `.onDecision`), and what the
 * runner's page acts through (`RunnerPageActions`).
 *
 * - **The policy** of a job is its seat's `runner.yml` entry tightened by `.parley/policy.yml` from
 *   the repository's default branch (runner/policy-yml.ts), never the commit the job answers from.
 * - **The check** (`egress`) is runner/egress-policy.ts's bounded one, and two rules on top that
 *   `EgressGate` has and the host's gate does not: a packet that would be held counts its pending
 *   holds against the packet budget, so an agent cannot fill its team's review queue past what the
 *   seat may share, and a hold this runner could not keep is a refusal. Budgets count what reached
 *   the room by the ledger too, so an approved packet counts.
 * - **Every decision** (`onDecision`) is a row of the ledger, and a hold keeps the whole call in
 *   `runner.db`'s `held` and tells the relay its shape (`POST /api/runner/jobs/:id/held`), again from
 *   `tick` until the relay takes it. With `ledger.keep_bodies: false`, no body stays in the ledger.
 * - **A held packet leaves only when a person approves it**, on the runner's page (`pageActions`) or
 *   by `approve`: checked again under the policy as it stands now (the job's deny-by-content index
 *   included, and with the `policyYml` flag off, read from the job's own checkout as the gate read
 *   it) with the review rules taken out, the relay told first, then replayed as it was held
 *   through the seat's own token (`POST /api/seat/op/share_context`). Nothing else here sends a
 *   held call: a refusal, an expiry (`tick`), a job that ended and a runner that restarted all
 *   leave it unsent, and a decided hold's call is wiped.
 * - **A hold's shape reaches the relay before its outcome**, or never: `tick` sends the shapes it
 *   still owes before it expires anything, a refusal waits for a shape on its way, and a hold
 *   decided before its shape went is never reported as held. A restarted runner owes the shape of
 *   every hold still waiting (the relay takes a shape it has once), so an approval after a restart
 *   still has a hold to stand on.
 * - **What came of a call** reaches the ledger and the agent through the host (`onForwarded`,
 *   `notesFor`): the label the room gave a packet the proxy let through, or the relay's refusal of
 *   it, and a line for each decision on the job's held packets (approved and under which label,
 *   refused with the person's reason, expired) added to the agent's next tool answer.
 * - **The ledger's level is the one a job's calls were checked under** (`levelOf`), remembered for
 *   the job when it first calls, so the policy changing later changes nothing already written.
 *   What this process keeps of a job's check (its policy, its deny-by-content index) goes when the
 *   job ends (`tick`).
 *
 * Nothing here logs a body, a title, a source or a token: every line goes through `redactTokens`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ContextKind } from '@parley/shared';
import { caseInsensitivePaths, POLICY_MESSAGES } from '@parley/shared/policy';
import { type HeldInput, JOB_ID, type PolicyVerdict, type SeatPolicy } from '@parley/shared/runner';
import { type HoldAction, type RunnerPageActions, type RunnerPageSource, runnerDbSource } from './page.js';
import { jobsRoot, type SeatConfig, seatDir } from './config.js';
import { egressPolicy, explainVerdict, type RunnerFacts } from './egress-policy.js';
import type { BudgetUsed, EgressPolicy, OutboundCall, RunnerOnly } from './egress-types.js';
import type { RunnerHostOptions } from './host.js';
import { redactTokens } from './keys.js';
import { type LedgerJob, OutboundLedger } from './ledger.js';
import { answeringRef, type JobPolicy, jobPolicyFor, type ReportLevel } from './policy-yml.js';
import { type HeldEntry, holdReasonOf, type ReviewDeps, ReviewError, ReviewQueue } from './review.js';
import type { Checkout } from './worktree.js';

/**
 * The checkout a job of `seat` answers from, as the host makes it (runner/host.ts): `repo/` in the
 * job's directory while it is there, else the seat's own directory (a live seat's checkout).
 */
export function jobCheckout(seat: SeatConfig, home: string, jobId: string): Pick<Checkout, 'cwd'> {
  if (!JOB_ID.test(jobId)) throw new Error('not a job id');
  const repo = path.join(jobsRoot(home), jobId, 'repo');
  return { cwd: existsSync(repo) ? repo : seatDir(seat, home) };
}

/** What the relay did with a call the proxy forwarded: the room's label for a packet it took, or its refusal. */
export type ForwardedResult = { ok: true; packetLabel?: string | null } | { ok: false; text?: string | null };

/** What the review adds to the host's options (`...review.hostOptions()` into `new RunnerHost`). */
export interface ReviewHostOptions extends Required<Pick<RunnerHostOptions, 'egress' | 'policyFor'>> {
  /** Every decision recorded; answers the ledger row, for `onForwarded`. */
  onDecision(jobId: string, call: OutboundCall, verdict: PolicyVerdict): number | undefined;
  /** The ref a job of the seat answers from (runner/policy-yml.ts `answeringRef`). Throwing refuses the job. */
  refFor(seat: SeatConfig): string | undefined;
  /** What the relay did with a call the proxy let through, onto its ledger row. */
  onForwarded(jobId: string, outboundId: number, result: ForwardedResult): void;
  /** The lines the job's agent is owed about its held packets, once each, for its next tool answer. */
  notesFor(jobId: string): string[];
}

/** The most jobs whose ledger level this process remembers; the oldest go first. */
const LEVELS_KEPT = 10_000;

/** A job as the review needs it: its room, its seat, and its seat's token while the job is live. */
export interface ReviewJob {
  id: string;
  sessionId: string;
  label: string;
  /** Null once the job has ended and the token is forgotten: a held packet of it can never leave. */
  seatToken: string | null;
  startedAt: string | null;
}

/** What the review needs of the relay, on the runner's session (`RelayClient.held`, `.seatOp`). */
export interface ReviewRelay {
  held(jobId: string, input: HeldInput, seatToken: string): Promise<unknown>;
  seatOp(seatToken: string, op: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ReviewServiceOptions {
  /** `runner.db`: the ledger's `outbound` and the review's `held`. */
  db: DatabaseSync;
  /** The runner's home, which `runner.yml`'s relative seat directories are read against. */
  home: string;
  /** The seats as configured now. */
  seats(): SeatConfig[];
  jobs(jobId: string): ReviewJob | null;
  /** Every token and secret the runner holds now, which no ledger row keeps and no source leaves with. */
  knownSecrets(): readonly string[];
  relay: ReviewRelay;
  /** The pure check (runner/egress-policy.ts's bounded one unless another is given). */
  egress?: EgressPolicy;
  /** A job's policy; `jobPolicyFor` (the default branch) unless another is given. */
  loadPolicy?(seat: SeatConfig, home: string, checkout?: Pick<Checkout, 'cwd'>): JobPolicy;
  /**
   * What only the runner knows about a job, for checking a held packet again when this process
   * never saw one of the job's calls (a restart, or `crossroom runner approve` from another process):
   * its deny-by-content index rebuilt from the job's checkout, and the names the checkout goes by.
   * Without it such an approval fails, rather than check the packet against less than the job had.
   */
  rebuildFacts?(job: ReviewJob): Promise<RunnerFacts | null>;
  now?: () => Date;
  log?(line: string): void;
}

/** What a held packet that the room would not take is told, as its refusal (only its agent reads it). */
export const HOLD_NOT_TAKEN = 'The room would not take the packet held for review (it ended, or has too many held), so it was not sent.';

/** The relay's last word on a hold's report: a 4xx that is not a timeout or a rate limit (review.ts's rule). */
const finalAnswer = (e: unknown) => {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
};

/** An error with the status a relay's refusal would carry, for `ReviewQueue`'s own rule about final answers. */
class Gone extends Error {
  readonly status = 410;
}

/** What the relay was told of a hold still waiting, rebuilt from runner.db: the same id, kind, size and rule class. */
function reportOf(h: HeldEntry): HeldInput | null {
  const why = holdReasonOf(h.rule);
  const kind = ContextKind.safeParse(h.kind);
  if (!why || !kind.success || !Number.isInteger(h.bytes) || h.bytes < 0) return null;
  return { holdId: h.id, kind: kind.data, bytes: h.bytes, why };
}

export class ReviewService {
  readonly ledger: OutboundLedger;
  readonly queue: ReviewQueue;
  /** The highest ledger row written before this process: `LedgerSync.startRow`, whose level nothing here knows. */
  readonly startRow: number;
  private readonly pure: EgressPolicy;
  private readonly load: NonNullable<ReviewServiceOptions['loadPolicy']>;
  /** The policy each seat was last started under: what `policyFor` answered the host. */
  private readonly byLabel = new Map<string, JobPolicy>();
  /** Per running job, the policy and runner facts its last call was checked against. Let go when the job ends (`tick`). */
  private readonly byJob = new Map<string, { policy: SeatPolicy; runner?: RunnerOnly }>();
  /** Per job, the ledger settings of the policy its calls were first checked under here. */
  private readonly levels = new Map<string, { report: ReportLevel; keepBodies: boolean }>();
  /** Holds whose shape the relay has not taken yet, by hold id. */
  private readonly unreported = new Map<string, { jobId: string; report: HeldInput }>();
  /** Hold reports on their way, by hold id. */
  private readonly sending = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;

  constructor(private readonly o: ReviewServiceOptions) {
    const now = o.now ?? (() => new Date());
    this.pure = o.egress ?? egressPolicy({ nocase: caseInsensitivePaths(process.platform) });
    this.load = o.loadPolicy ?? jobPolicyFor;
    this.ledger = new OutboundLedger(o.db, { now });
    this.queue = new ReviewQueue(o.db, this.ledger, this.pure, { now });
    this.startRow = Number((o.db.prepare('SELECT MAX(id) AS id FROM outbound').get() as { id: number | null }).id ?? 0);
    // A runner that stopped may not have told the relay of a hold's shape; told twice, it keeps one.
    for (const h of this.queue.pending()) {
      const report = reportOf(h);
      if (report) this.unreported.set(h.id, { jobId: h.jobId, report });
    }
  }

  private log(line: string) {
    this.o.log?.(redactTokens(line, [...this.o.knownSecrets()]));
  }

  // -------------------------------------------------------------- the host's seams

  /** What the runner host takes (`...review.hostOptions()` into `new RunnerHost`). */
  hostOptions(): ReviewHostOptions {
    return {
      egress: this.egress(),
      policyFor: (seat, checkout) => this.policyFor(seat, checkout),
      onDecision: (jobId, call, verdict) => this.onDecision(jobId, call, verdict),
      refFor: (seat) => answeringRef(seat, this.o.home),
      onForwarded: (jobId, outboundId, result) => this.onForwarded(jobId, outboundId, result),
      notesFor: (jobId) => this.notesFor(jobId),
    };
  }

  /** What the relay did with a call the proxy let through: the packet's label, or a refusal that drops the row's body. */
  onForwarded(jobId: string, outboundId: number, result: ForwardedResult): void {
    const job = this.o.jobs(jobId);
    const known = [...this.o.knownSecrets(), ...(job?.seatToken ? [job.seatToken] : [])];
    try {
      if (result.ok) this.ledger.settle(outboundId, { ok: true, packetLabel: result.packetLabel ?? null }, known);
      else this.ledger.settle(outboundId, { ok: false, detail: result.text ?? null }, known);
    } catch (e) {
      this.log(`job ${jobId.slice(0, 12)}…: what the relay did with a call could not be recorded (${(e as Error)?.message ?? e})`);
    }
  }

  /** What the job's agent is owed about its held packets (review.ts `takeNotes`); nothing when runner.db cannot say. */
  notesFor(jobId: string): string[] {
    try {
      return this.queue.takeNotes(jobId);
    } catch {
      return [];
    }
  }

  /** The job's policy, from the default branch; remembered for the seat, so its calls are read under what the file says. */
  policyFor(seat: SeatConfig, checkout?: Pick<Checkout, 'cwd'>): SeatPolicy {
    const j = this.load(seat, this.o.home, checkout);
    this.byLabel.set(seat.label, j);
    for (const n of j.repo.notes) this.log(`seat ${seat.label}: ${n}`);
    return j.policy;
  }

  /** What a job has used: the host's gate's counts, and what reached the room by the ledger (an approved packet included). */
  private usedOf(jobId: string, given: BudgetUsed): BudgetUsed {
    const job = this.o.jobs(jobId);
    const byLedger = this.ledger.used(jobId, { startedAt: job?.startedAt ?? null });
    return {
      ...given,
      messages: Math.max(given.messages, byLedger.messages),
      packets: Math.max(given.packets, byLedger.packets),
    };
  }

  /** Whether `queue.hold` could keep this call for this verdict. */
  private keepable(call: OutboundCall, v: Extract<PolicyVerdict, { ok: false }>): boolean {
    if (call.op !== 'share_context' || !holdReasonOf(v.rule)) return false;
    const kind = call.packet?.kind ?? (typeof call.args?.kind === 'string' ? call.args.kind : 'text');
    return ContextKind.safeParse(kind).success;
  }

  /** The host's check: the pure one, then the hold rules. It remembers what it checked each job's calls against. */
  egress(): EgressPolicy {
    return {
      check: (call, policy, used, runner) => {
        const jobId = call?.jobId;
        if (typeof jobId === 'string' && jobId) {
          this.byJob.set(jobId, { policy, ...(runner ? { runner } : {}) });
          // The ledger's level for the job: its seat's policy as it was started, from its first call on.
          const repo = this.byLabel.get(call.label)?.repo;
          if (repo && !this.levels.has(jobId)) this.remember(jobId, { report: repo.ledger.report, keepBodies: repo.ledger.keepBodies });
        }
        const counted = typeof jobId === 'string' && jobId ? this.usedOf(jobId, used) : used;
        const v = this.pure.check(call, policy, counted, runner);
        if (v.ok || v.action !== 'hold') return v;
        if (!this.keepable(call, v)) return { ok: false, action: 'refuse', rule: 'malformed', message: POLICY_MESSAGES.malformed };
        const pending = this.queue.pending({ jobId }).length;
        if (counted.packets + pending >= policy.budget.packets) return { ok: false, action: 'refuse', rule: 'budget:packets', message: POLICY_MESSAGES.budget('packets') };
        return v;
      },
    };
  }

  private remember(jobId: string, l: { report: ReportLevel; keepBodies: boolean }) {
    this.levels.set(jobId, l);
    if (this.levels.size > LEVELS_KEPT) this.levels.delete(this.levels.keys().next().value!);
  }

  /**
   * A job's ledger settings: those of the policy its calls were first checked under here, or, for a
   * job this process has not seen call (a hold of an earlier process decided here), its seat's
   * policy as it stands, read once for the seat. `none`, and no bodies, when this runner cannot tell.
   */
  private ledgerOf(jobId: string, label: string): { report: ReportLevel; keepBodies: boolean } {
    const known = this.levels.get(jobId);
    if (known) return known;
    let repo = this.byLabel.get(label)?.repo;
    if (!repo) {
      const seat = this.o.seats().find((s) => s.label === label);
      if (seat)
        try {
          const j = this.load(seat, this.o.home, jobCheckout(seat, this.o.home, jobId));
          this.byLabel.set(label, j);
          repo = j.repo;
        } catch {
          // A policy that does not read now says nothing.
        }
    }
    return repo ? { report: repo.ledger.report, keepBodies: repo.ledger.keepBodies } : { report: 'none', keepBodies: false };
  }

  /**
   * `ledger.report` for a job (`LedgerSync.levelOf`): the level of the policy its calls were checked
   * under, which a later change of the file does not change. Rows written before this process
   * started are `LedgerSync`'s to leave out (`startRow`).
   */
  levelOf(jobId: string, label: string): ReportLevel {
    return this.ledgerOf(jobId, label).report;
  }

  /** With `ledger.keep_bodies: false`, no body of the job stays in the ledger. */
  private dropBodies(jobId: string, label: string) {
    if (this.ledgerOf(jobId, label).keepBodies) return;
    this.o.db.prepare('UPDATE outbound SET body = NULL WHERE job_id = ? AND body IS NOT NULL').run(jobId);
  }

  /** Every decision: a ledger row, and for a hold, the call kept and its shape reported. Answers the row, for `onForwarded`. */
  onDecision(jobId: string, call: OutboundCall, verdict: PolicyVerdict): number | undefined {
    const job = this.o.jobs(jobId);
    if (!job) {
      this.log(`job ${jobId.slice(0, 12)}…: a call of a job this runner has no record of was not recorded`);
      return undefined;
    }
    const lj: LedgerJob = { id: jobId, sessionId: job.sessionId, label: job.label };
    const ctx = this.byJob.get(jobId);
    const known = [...this.o.knownSecrets(), ...(job.seatToken ? [job.seatToken] : [])];
    const detail = explainVerdict(call, verdict, { policy: ctx?.policy ?? null, ...(ctx?.runner ? { runner: ctx.runner as RunnerFacts } : {}) });
    const outboundId = this.ledger.record(lj, call, verdict, { detail, known });
    if (!verdict.ok && verdict.action === 'hold') {
      try {
        const minutes = ctx?.policy.review.timeoutMinutes ?? 60;
        const { holdId, report } = this.queue.hold(lj, call, verdict, { timeoutMinutes: minutes, outboundId });
        this.unreported.set(holdId, { jobId, report });
        void this.sendHold(holdId);
      } catch (e) {
        // The agent was told its packet is held; it is not kept, so it is not sent either.
        this.ledger.settle(outboundId, { ok: false, rule: 'malformed', detail: 'the hold could not be kept' }, known);
        this.log(`job ${jobId.slice(0, 12)}…: a held packet could not be kept for review (${(e as Error)?.message ?? e}); it was not sent`);
      }
    }
    this.dropBodies(jobId, job.label);
    return outboundId;
  }

  /**
   * Tell the relay a hold's shape. Kept for `tick` when the relay could not be reached; refused
   * here when the relay will never take it. A report already on its way is waited for, not sent
   * twice, so an approval made while the first report is in flight goes on once it lands. A hold
   * decided meanwhile (refused, expired) is never reported as held: the relay would keep it
   * waiting for good, since its outcome, told first, found nothing there to decide.
   */
  private sendHold(holdId: string): Promise<void> {
    const inFlight = this.sending.get(holdId);
    if (inFlight) return inFlight;
    const u = this.unreported.get(holdId);
    if (!u) return Promise.resolve();
    const h = this.queue.get(holdId);
    if (!h || h.decidedAt) {
      this.unreported.delete(holdId);
      return Promise.resolve();
    }
    const p = (async () => {
      try {
        const job = this.o.jobs(u.jobId);
        if (!job?.seatToken) throw new Gone('the job has ended');
        await this.o.relay.held(u.jobId, u.report, job.seatToken);
        this.unreported.delete(holdId);
      } catch (e) {
        if (!finalAnswer(e)) return;
        this.unreported.delete(holdId);
        await this.queue.refuse(holdId, HOLD_NOT_TAKEN, { report: (jobId, input) => this.report(jobId, input) }).catch(() => {});
        this.log(`a held packet was refused: the room would not take the hold (${(e as Error)?.message ?? e})`);
      }
    })().finally(() => {
      this.sending.delete(holdId);
    });
    this.sending.set(holdId, p);
    return p;
  }

  // -------------------------------------------------------------- decisions

  /** `POST /api/runner/jobs/:id/held` with the job's seat token; a job whose token is forgotten is a final answer. */
  private async report(jobId: string, input: HeldInput): Promise<void> {
    const job = this.o.jobs(jobId);
    if (!job?.seatToken) throw new Gone('the job has ended, so the relay cannot be told as its seat');
    await this.o.relay.held(jobId, input, job.seatToken);
  }

  private deps(facts: RunnerOnly | undefined): ReviewDeps {
    return {
      context: (jobId) => {
        const job = this.o.jobs(jobId);
        if (!job?.seatToken) return null;
        const seat = this.o.seats().find((s) => s.label === job.label);
        if (!seat) return null;
        // The policy as it stands now, read again where the gate read it (the default branch, or
        // with the policyYml flag off the job's own checkout): an approval is a person's, not a
        // change of deny list, and a policy that no longer reads refuses.
        let policy: SeatPolicy | null = null;
        try {
          policy = this.load(seat, this.o.home, jobCheckout(seat, this.o.home, jobId)).policy;
        } catch {
          policy = null;
        }
        const used = this.ledger.used(jobId, { startedAt: job.startedAt });
        const runner = { ...(facts ?? {}), knownSecrets: [...this.o.knownSecrets(), job.seatToken] };
        return { policy, used, runner };
      },
      report: (jobId, input) => this.report(jobId, input),
      replay: async (jobId, call) => {
        const job = this.o.jobs(jobId);
        if (!job?.seatToken) return { ok: false, text: 'the job has ended' };
        try {
          const out = (await this.o.relay.seatOp(job.seatToken, 'share_context', call.args)) as { data?: { label?: unknown } } | null;
          const label = typeof out?.data?.label === 'string' ? out.data.label : null;
          return { ok: true, packetLabel: label };
        } catch (e) {
          return { ok: false, text: redactTokens(String((e as Error)?.message ?? e), [job.seatToken]) };
        }
      },
    };
  }

  /** The runner facts to check a held packet of this job against again, or null when this process has none and cannot rebuild them. */
  private async factsFor(jobId: string): Promise<RunnerOnly | null> {
    const seen = this.byJob.get(jobId)?.runner;
    if (seen) return seen;
    const job = this.o.jobs(jobId);
    if (!job || !this.o.rebuildFacts) return null;
    try {
      return await this.o.rebuildFacts(job);
    } catch {
      return null;
    }
  }

  /**
   * Approve a held packet: checked again, the relay told, then replayed through the seat's token.
   * `failed` when the policy now refuses it, the room would not take it, or this process cannot
   * check it again; the log says which, and never what the packet said.
   */
  async approve(holdId: string): Promise<HoldAction> {
    const h = this.queue.get(holdId);
    if (!h) return { ok: false, code: 'unknown' };
    if (h.decidedAt) return { ok: false, code: 'decided' };
    const facts = await this.factsFor(h.jobId);
    if (!facts) {
      this.log(`a held packet of job ${h.jobId.slice(0, 12)}… could not be checked again here: approve it on the page of the runner that runs the job`);
      return { ok: false, code: 'failed' };
    }
    // Its shape must have reached the relay first, or the approval has nothing to stand on there.
    if (this.unreported.has(holdId)) await this.sendHold(holdId);
    if (this.unreported.has(holdId)) return { ok: false, code: 'failed' };
    try {
      const r = await this.queue.approve(holdId, this.deps(facts));
      this.dropBodies(h.jobId, h.label);
      if (r.ok) {
        this.log(`job ${h.jobId.slice(0, 12)}…: a held packet was approved and sent${r.packetLabel ? ` as ${r.packetLabel}` : ''}`);
        return { ok: true };
      }
      this.log(
        `job ${h.jobId.slice(0, 12)}…: a held packet was approved and not sent (${r.why === 'refused_by_policy' ? `the policy now refuses it: ${r.rule}` : r.why === 'job_over' ? 'the job is over' : 'the room did not take it'})`,
      );
      return { ok: false, code: 'failed' };
    } catch (e) {
      if (e instanceof ReviewError) return { ok: false, code: e.code === 'reason' ? 'failed' : e.code };
      this.log(`a held packet could not be approved: ${(e as Error)?.message ?? e}`);
      return { ok: false, code: 'failed' };
    }
  }

  /** Refuse a held packet with a reason only its agent reads; the relay hears `refused`. */
  async refuse(holdId: string, reason: string): Promise<HoldAction> {
    const h = this.queue.get(holdId);
    if (!h) return { ok: false, code: 'unknown' };
    // A shape on its way lands before the refusal is told; one not yet sent never goes.
    await this.sending.get(holdId);
    this.unreported.delete(holdId);
    try {
      await this.queue.refuse(holdId, reason, { report: (jobId, input) => this.report(jobId, input) });
      return { ok: true };
    } catch (e) {
      if (e instanceof ReviewError) return { ok: false, code: e.code === 'reason' ? 'failed' : e.code };
      this.log(`a held packet could not be refused: ${(e as Error)?.message ?? e}`);
      return { ok: false, code: 'failed' };
    }
  }

  /** The jobs whose checks this process still keeps (their policy and deny-by-content index): the running ones. */
  checkedJobs(): string[] {
    return [...this.byJob.keys()];
  }

  /** What the runner's page does with Approve and Refuse (runner/page.ts). */
  pageActions(): RunnerPageActions {
    return { approve: (id) => this.approve(id), refuse: (id, reason) => this.refuse(id, reason) };
  }

  /** What the runner's page shows: this runner's `runner.db`, read and never written (runner/page.ts). */
  pageSource(o: { name?: string | null } = {}): RunnerPageSource {
    return runnerDbSource(this.o.db, o);
  }

  /**
   * Send hold shapes the relay did not take, then expire what waited too long and tell the relay
   * what it has not heard: a shape first, so an outcome never reaches the relay before its hold.
   * And let go of what was kept for checking the calls of jobs that have ended.
   */
  tick(): Promise<void> {
    this.ticking ??= (async () => {
      for (const id of [...this.unreported.keys()]) await this.sendHold(id);
      try {
        await this.queue.expireDue({ report: (jobId, input) => this.report(jobId, input) });
      } catch (e) {
        this.log(`held packets could not be expired: ${(e as Error)?.message ?? e}`);
      }
      for (const id of [...this.byJob.keys()]) if (!this.o.jobs(id)?.seatToken) this.byJob.delete(id);
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** `tick` every `everyMs` (default 30 s) until `stop`. */
  start(everyMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), everyMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => {});
  }
}
