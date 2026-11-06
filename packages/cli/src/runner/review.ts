/**
 * Review before sharing: a packet the policy holds stays on the runner, in `runner.db`'s
 * `held` table, until a person on the answering team approves or refuses it, or its time runs out.
 *
 * - **Held.** The egress gate (egress-policy.ts) answers the agent "held for review by your team;
 *   carry on, it arrives if they approve", keeps the whole call here, and hands back the shape the
 *   relay is told (`POST /api/runner/jobs/:id/held`: an id, a kind, a size, a rule class), from
 *   which the room gets `context_held`. The packet itself never leaves the machine.
 * - **Approved.** The call is checked again, under the policy as it stands now with the review
 *   rules taken out: a person approved this packet, not a change of deny list, and not a budget
 *   that has since run out. If that passes, the relay is told first (`resolution: approved`), which
 *   is what lets the relay's own second line take a packet it would otherwise refuse for a
 *   hold-class secret, and then the call is replayed as it was held, through the
 *   seat's own token (`POST /api/seat/op/share_context`, by whoever wires `replay`).
 * - **Refused**, or **expired** unreviewed: the relay is told, the held call is wiped, and the agent
 *   is told why at its next tool call (`takeNotes`), in its team's own words. Those words stay on
 *   the machine: the relay hears only `refused` or `expired`. A report that does not reach the
 *   relay is sent again from the host's timer (`expireDue`, `reportDue`) until the relay takes it
 *   or answers that it has no such hold waiting.
 *
 * Every decision is also a row of the outbound ledger (ledger.ts), after the `held` row it answers.
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ContextKind } from '@parley/shared';
import { oneLine } from '@parley/shared/text';
import { type HeldInput, type HoldReason, type HoldResolution, type PolicyVerdict, SeatPolicy } from '@parley/shared/runner';
import type { BudgetUsed, EgressPolicy, OutboundCall, RunnerOnly } from './egress-types.js';
import { contentOf, type LedgerJob, type OutboundLedger } from './ledger.js';

/** What a person may write as the reason for refusing a held packet. */
export const REASON_MAX = 1000;

/** The most unreported resolutions `reportDue` sends in one call. */
export const REPORT_BATCH = 100;

/** Why a verdict held a call, as the relay records it (`packet_holds.why`): a rule class, never the path or the secret. */
export function holdReasonOf(rule: string): HoldReason | null {
  if (rule === 'review:path') return 'review_path';
  if (rule === 'review:kind') return 'review_kind';
  if (rule.startsWith('secret:')) return 'secret';
  return null;
}

export interface HeldEntry {
  id: string;
  outboundId: number;
  jobId: string;
  sessionId: string;
  label: string;
  /** The held call; `null` once decided, when it is wiped. */
  call: OutboundCall | null;
  /** The rule that held it (`review:path`, `secret:jwt`, ...). */
  rule: string;
  kind: string | null;
  bytes: number;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decision: HoldResolution | null;
  reason: string | null;
}

/** What approving, refusing and expiring need from the runner around this module. */
export interface ReviewDeps {
  /** The policy, counts and runner facts a job's calls are checked against now; null once the job is over. */
  context(jobId: string): { policy: SeatPolicy | null; used: BudgetUsed; runner?: RunnerOnly } | null;
  /**
   * `POST /api/runner/jobs/:id/held` for the job: a hold's shape, or its resolution. Rejects when
   * the relay did not take it. A rejection whose `status` is a 4xx other than 408 and 429 is the
   * relay's last word, and a resolution it answers is not sent again (`reportDue`).
   */
  report(jobId: string, input: HeldInput): Promise<void>;
  /** Send the held call to the room as it was held, through the seat's own token. */
  replay(jobId: string, call: OutboundCall): Promise<{ ok: boolean; text?: string; packetLabel?: string | null }>;
}

export class ReviewError extends Error {
  constructor(
    public readonly code: 'unknown' | 'decided' | 'expired' | 'reason',
    message: string,
  ) {
    super(message);
  }
}

export type ApproveResult =
  | { ok: true; packetLabel: string | null }
  | { ok: false; why: 'refused_by_policy'; rule: string; message: string }
  | { ok: false; why: 'job_over' }
  | { ok: false; why: 'not_taken'; text: string };

interface HeldRow {
  id: string;
  outbound_id: number;
  job_id: string;
  args_json: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decision: string | null;
  reason: string | null;
  session_id: string | null;
  label: string | null;
  rule: string | null;
  kind: string | null;
  bytes: number | null;
}

/** The review rules taken out: what a person's approval overrides, and nothing else. */
function withoutReview(policy: SeatPolicy | null): SeatPolicy | null {
  const p = SeatPolicy.safeParse(policy);
  if (!p.success) return policy;
  return { ...p.data, review: { ...p.data.review, paths: [], kinds: [] } };
}

/**
 * `held.reason` of a decided hold: the person's reason (or the policy's), the note its agent is to
 * get, and, for a refusal or an expiry, whether the relay has yet to hear of it (`unreported`), as
 * one JSON value, so all three outlive the process that decided (`crossroom runner approve` runs
 * apart from the runner whose agent is to be told, and whose timer tells the relay again).
 */
interface DecisionText {
  reason: string | null;
  note: string | null;
  unreported?: true;
}

function decisionText(raw: string | null): DecisionText {
  if (!raw) return { reason: null, note: null };
  try {
    const v = JSON.parse(raw) as { reason?: unknown; note?: unknown; unreported?: unknown };
    if (v && typeof v === 'object')
      return {
        reason: typeof v.reason === 'string' ? v.reason : null,
        note: typeof v.note === 'string' ? v.note : null,
        ...(v.unreported === true ? { unreported: true as const } : {}),
      };
  } catch {
    // A reason written as plain text.
  }
  return { reason: raw, note: null };
}

/**
 * Whether a failed report is the relay's last word, not to be sent again: a 4xx (the relay knows
 * no such hold waiting, since it heard of it already or never did, or the room is gone), other
 * than a timeout or a rate limit. Anything else (unreachable, a 5xx, no status at all) is tried again.
 */
function finalAnswer(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** How long a decision may go without its note before `takeNotes` gives up waiting for it. */
const NOTE_GRACE_MS = 60_000;

/** The note for a decision whose process died before writing its own: what was decided, and the reason if any. */
function fallbackNote(decision: string | null, reason: string | null): string {
  if (decision === 'approved') return 'Your team approved a packet that was held for review; check the room to see whether it arrived.';
  if (decision === 'expired') return 'A packet held for review expired before your team reviewed it, so it was not sent.';
  return `Your team refused a packet that was held for review${reason ? `: ${reason}` : '.'} Do not share it again.`;
}

const title = (call: OutboundCall | null) => oneLine(call?.packet?.title ?? (typeof call?.args?.title === 'string' ? call.args.title : '')).slice(0, 120);

export class ReviewQueue {
  private readonly now: () => Date;
  /**
   * Per job, the last decision whose note was handed over. The notes themselves are kept in
   * `held`, so a decision taken by another process on this machine (`crossroom runner approve`)
   * reaches the agent too. Decisions from before this queue was made are not handed over.
   */
  private readonly told = new Map<string, { at: string; row: number }>();
  private readonly since: string;
  private readonly busy = new Set<string>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly ledger: OutboundLedger,
    private readonly egress: EgressPolicy,
    o: { now?: () => Date } = {},
  ) {
    this.now = o.now ?? (() => new Date());
    this.since = this.now().toISOString();
  }

  /**
   * Keep a held call, under the ledger row `outboundId` that recorded the hold. Answers the hold's
   * id and what the relay is to be told. Only a packet can be held (`checkOutbound` refuses a hold
   * in any other call), and only for a rule with a `HoldReason`.
   */
  hold(job: LedgerJob, call: OutboundCall, verdict: PolicyVerdict, o: { timeoutMinutes: number; outboundId: number }): { holdId: string; report: HeldInput } {
    if (verdict.ok || verdict.action !== 'hold') throw new Error('only a held verdict is kept for review');
    const why = holdReasonOf(verdict.rule);
    if (call.op !== 'share_context' || !why) throw new Error(`a ${call.op} call cannot be held for ${verdict.rule}`);
    const c = contentOf(call);
    const kind = ContextKind.safeParse(c.kind);
    if (!kind.success) throw new Error('a held packet needs a kind the room knows');
    const report: HeldInput = { holdId: randomBytes(16).toString('base64url'), kind: kind.data, bytes: c.bytes, why };
    const created = this.now();
    const minutes = Number.isFinite(o.timeoutMinutes) && o.timeoutMinutes > 0 ? o.timeoutMinutes : 60;
    const stored: OutboundCall = { op: call.op, jobId: job.id, label: job.label, args: call.args ?? {}, ...(call.packet ? { packet: call.packet } : {}) };
    this.db
      .prepare('INSERT INTO held (id, outbound_id, job_id, args_json, created_at, expires_at) VALUES (?,?,?,?,?,?)')
      .run(report.holdId, o.outboundId, job.id, JSON.stringify(stored), created.toISOString(), new Date(created.getTime() + minutes * 60_000).toISOString());
    return { holdId: report.holdId, report };
  }

  get(holdId: string): HeldEntry | null {
    const r = this.row(holdId);
    return r ? this.entry(r) : null;
  }

  /** Calls waiting for a decision, oldest first: `crossroom runner held` and the local page. */
  pending(o: { jobId?: string; label?: string } = {}): HeldEntry[] {
    const rows = this.db
      .prepare(
        `SELECT h.*, o.session_id, o.label, o.rule, o.kind, o.bytes FROM held h LEFT JOIN outbound o ON o.id = h.outbound_id
         WHERE h.decided_at IS NULL ${o.jobId ? 'AND h.job_id = ?' : ''} ${o.label ? 'AND o.label = ?' : ''} ORDER BY h.created_at, h.rowid`,
      )
      .all(...[o.jobId, o.label].filter((x): x is string => !!x)) as unknown as HeldRow[];
    return rows.map((r) => this.entry(r));
  }

  /**
   * Approve a held call: check it again without the review rules, claim the decision, tell the
   * relay, replay it. A call the policy now refuses is refused instead, and the agent is told.
   * `report` failing gives the claim back, so the hold waits and the person can try again; nothing
   * is replayed without it.
   */
  async approve(holdId: string, deps: ReviewDeps): Promise<ApproveResult> {
    return await this.once(holdId, () => this.approveNow(holdId, deps));
  }

  private async approveNow(holdId: string, deps: ReviewDeps): Promise<ApproveResult> {
    const r = await this.open(holdId, deps);
    const call = this.callOf(r);
    const job = this.jobOf(r);
    const ctx = deps.context(r.job_id);
    if (!ctx) {
      await this.close(r, 'refused', 'the job is over', { rule: 'review:job_over' }, deps);
      return { ok: false, why: 'job_over' };
    }
    const policy = withoutReview(ctx.policy);
    let v = this.egress.check(call, policy as SeatPolicy, ctx.used, ctx.runner);
    // Still held: for a hold-class secret, which is what the person approved. Check the rest of
    // the policy without the secret patterns; the refuse-class ones had already passed, or this
    // would have been a refusal.
    if (!v.ok && v.action === 'hold' && policy) v = this.egress.check(call, { ...policy, secretScan: false }, ctx.used, ctx.runner);
    if (!v.ok) {
      await this.close(r, 'refused', `the policy now refuses it (${v.rule})`, { rule: v.rule }, deps);
      this.note(r.id, `Your team approved the packet held for review ("${title(call)}"), but it was not sent: ${v.message}`);
      return { ok: false, why: 'refused_by_policy', rule: v.rule, message: v.message };
    }
    // Claimed in runner.db before the relay hears of it: a refusal or an expiry from another
    // process on this machine (`crossroom runner refuse`, the host's own timer) cannot also decide it.
    if (!this.claim(r.id, 'approved', null)) throw new ReviewError('decided', 'that packet was decided meanwhile');
    try {
      await deps.report(r.job_id, { holdId: r.id, resolution: 'approved' });
    } catch (e) {
      this.unclaim(r.id);
      throw e;
    }
    const released = this.ledger.decide(job, call, 'released', { rule: r.rule ?? 'review:approved' });
    this.wipe(r.id);
    let sent: Awaited<ReturnType<ReviewDeps['replay']>>;
    try {
      sent = await deps.replay(r.job_id, call);
    } catch (e) {
      sent = { ok: false, text: (e as Error)?.message ?? 'the replay failed' };
    }
    if (!sent.ok) {
      this.ledger.settle(released, { ok: false, detail: sent.text ?? null });
      this.note(r.id, `Your team approved the packet held for review ("${title(call)}"), but the room did not take it: ${oneLine(sent.text ?? 'no answer').slice(0, 300)}`);
      return { ok: false, why: 'not_taken', text: sent.text ?? '' };
    }
    this.ledger.settle(released, { ok: true, packetLabel: sent.packetLabel ?? null });
    this.note(r.id, `Your team approved the packet held for review ("${title(call)}"); it is in the room now${sent.packetLabel ? ` as ${sent.packetLabel}` : ''}.`);
    return { ok: true, packetLabel: sent.packetLabel ?? null };
  }

  /** Refuse a held call with a reason, which only the agent reads. The relay hears `refused`. */
  async refuse(holdId: string, reason: string, deps: Pick<ReviewDeps, 'report'>): Promise<{ reported: boolean }> {
    const said = oneLine(typeof reason === 'string' ? reason : '').trim();
    if (!said || said.length > REASON_MAX) throw new ReviewError('reason', `a refusal needs a reason of 1 to ${REASON_MAX} characters, which the agent is told`);
    return await this.once(holdId, async () => {
      const r = await this.open(holdId, deps);
      const call = this.callOf(r);
      const reported = await this.close(r, 'refused', said, { rule: 'review:refused' }, deps);
      this.note(r.id, `Your team refused the packet held for review ("${title(call)}"): ${said} Do not share it again.`);
      return { reported };
    });
  }

  /**
   * Expire every held call past its time, then tell the relay again of each refusal and expiry it
   * has not heard of (`reportDue`), so the host's timer is what retries them. Answers how many
   * expired.
   */
  async expireDue(deps: Pick<ReviewDeps, 'report'>): Promise<number> {
    const t = this.now().toISOString();
    const due = this.db.prepare('SELECT id FROM held WHERE decided_at IS NULL AND expires_at <= ? ORDER BY expires_at, rowid').all(t) as { id: string }[];
    let n = 0;
    for (const { id } of due) {
      if (this.busy.has(id)) continue;
      const r = this.row(id);
      if (!r || r.decided_at) continue;
      try {
        await this.once(id, () => this.expire(r, deps));
        n++;
      } catch (e) {
        // Decided meanwhile, here or by another process: nothing left to expire.
        if (!(e instanceof ReviewError)) throw e;
      }
    }
    await this.reportDue(deps);
    return n;
  }

  /**
   * Tell the relay of every refusal and expiry whose report did not reach it (the relay was
   * unreachable, the room had just ended, the runner was offline). Until the relay hears, the room
   * shows the packet as held and the asker's agent waits for a packet that is not coming. Oldest
   * first, at most `REPORT_BATCH` a call, and none after the first that fails again: the relay is
   * still out of reach, and a tick of the host's timer should not wait on each. A relay's final
   * answer (`finalAnswer`: it knows no such hold waiting) ends the tries too. Answers how many the
   * relay took now.
   */
  async reportDue(deps: Pick<ReviewDeps, 'report'>): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT id, job_id, decision, reason FROM held WHERE decided_at IS NOT NULL AND decision IN ('refused', 'expired') AND reason LIKE '%"unreported":true%'
         ORDER BY decided_at, rowid LIMIT ${REPORT_BATCH}`,
      )
      .all() as { id: string; job_id: string; decision: 'refused' | 'expired'; reason: string | null }[];
    let n = 0;
    for (const r of rows) {
      if (this.busy.has(r.id) || !decisionText(r.reason).unreported) continue;
      let told: 'sent' | 'final' | 'failed';
      try {
        told = await this.once(r.id, () => this.tell(r.id, r.job_id, r.decision, deps));
      } catch (e) {
        if (!(e instanceof ReviewError)) throw e;
        continue;
      }
      if (told === 'failed') break;
      if (told === 'sent') n++;
    }
    return n;
  }

  /** What the job's agent is to be told about decisions since it was last told, once each. */
  takeNotes(jobId: string): string[] {
    const from = this.told.get(jobId) ?? { at: this.since, row: 0 };
    const rows = this.db
      .prepare(
        'SELECT rowid AS row, decided_at, decision, reason FROM held WHERE job_id = ? AND decided_at IS NOT NULL AND (decided_at > ? OR (decided_at = ? AND rowid > ?)) ORDER BY decided_at, rowid LIMIT 50',
      )
      .all(jobId, from.at, from.at, from.row) as { row: number; decided_at: string; decision: string | null; reason: string | null }[];
    const out: string[] = [];
    for (const r of rows) {
      const d = decisionText(r.reason);
      let note = d.note;
      if (note === null) {
        // A decision still under way (approved, not yet replayed) has no note yet: wait for it,
        // unless its process died on the way, which would hold back every later note too.
        if (this.now().getTime() - Date.parse(r.decided_at) < NOTE_GRACE_MS) break;
        note = fallbackNote(r.decision, d.reason);
      }
      out.push(note);
      this.told.set(jobId, { at: r.decided_at, row: Number(r.row) });
    }
    return out;
  }

  // ---------------- internals ----------------

  /**
   * One decision at a time per hold. A decision awaits the relay, so without this a second click on
   * Approve, or a refusal racing an approval, would find the hold still open and replay it twice.
   */
  private async once<T>(holdId: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(holdId)) throw new ReviewError('decided', 'that packet is being decided already');
    this.busy.add(holdId);
    try {
      return await fn();
    } finally {
      this.busy.delete(holdId);
    }
  }

  private row(holdId: string): HeldRow | null {
    if (typeof holdId !== 'string') return null;
    return (
      (this.db
        .prepare(
          'SELECT h.*, o.session_id, o.label, o.rule, o.kind, o.bytes FROM held h LEFT JOIN outbound o ON o.id = h.outbound_id WHERE h.id = ?',
        )
        .get(holdId) as HeldRow | undefined) ?? null
    );
  }

  /** A hold still waiting for a decision, or the reason it is not. One past its time is expired on the way. */
  private async open(holdId: string, deps: Pick<ReviewDeps, 'report'>): Promise<HeldRow> {
    const r = this.row(holdId);
    if (!r) throw new ReviewError('unknown', 'no held packet has that id');
    if (r.decided_at) throw new ReviewError('decided', `that packet was ${r.decision} already`);
    if (Date.parse(r.expires_at) <= this.now().getTime()) {
      await this.expire(r, deps);
      throw new ReviewError('expired', 'that packet waited too long for review, and expired');
    }
    return r;
  }

  private async expire(r: HeldRow, deps: Pick<ReviewDeps, 'report'>) {
    const call = this.callOf(r);
    await this.close(r, 'expired', 'nobody reviewed it in time', { rule: 'review:expired' }, deps);
    this.note(r.id, `The packet held for review ("${title(call)}") expired before your team reviewed it, so it was not sent.`);
  }

  /**
   * A hold that ends without its call being sent: claimed, wiped, in the ledger, and the relay told.
   * It is claimed as not yet reported, so a report that fails is sent again (`reportDue`). A hold
   * decided meanwhile, by this process or another, is left as it was. Answers whether the relay
   * heard it now.
   */
  private async close(r: HeldRow, resolution: Exclude<HoldResolution, 'approved'>, reason: string, o: { rule: string }, deps: Pick<ReviewDeps, 'report'>) {
    const call = this.callOf(r);
    if (!this.claim(r.id, resolution, reason, { unreported: true })) throw new ReviewError('decided', 'that packet was decided meanwhile');
    this.wipe(r.id);
    this.ledger.decide(this.jobOf(r), call, 'refused_after_review', { rule: o.rule, detail: reason });
    return (await this.tell(r.id, r.job_id, resolution, deps)) === 'sent';
  }

  /** Report a refusal or an expiry; it stops being due once the relay took it (`sent`) or gave its final answer (`final`). */
  private async tell(
    id: string,
    jobId: string,
    resolution: Exclude<HoldResolution, 'approved'>,
    deps: Pick<ReviewDeps, 'report'>,
  ): Promise<'sent' | 'final' | 'failed'> {
    try {
      await deps.report(jobId, { holdId: id, resolution });
    } catch (e) {
      if (!finalAnswer(e)) return 'failed';
      this.rewrite(id, { unreported: false });
      return 'final';
    }
    this.rewrite(id, { unreported: false });
    return 'sent';
  }

  /**
   * Take the decision on a hold, if nobody has: one UPDATE, so it is atomic across every process
   * that has runner.db open, and the one that changed the row is the one that decides.
   */
  private claim(id: string, decision: HoldResolution, reason: string | null, o: { unreported?: boolean } = {}): boolean {
    const text: DecisionText = { reason, note: null, ...(o.unreported ? { unreported: true as const } : {}) };
    const r = this.db
      .prepare('UPDATE held SET decided_at = ?, decision = ?, reason = ? WHERE id = ? AND decided_at IS NULL')
      .run(this.now().toISOString(), decision, JSON.stringify(text), id);
    return Number(r.changes) === 1;
  }

  /** Change the note or the reported mark of a decided hold, keeping the rest of its `held.reason`. */
  private rewrite(holdId: string, change: { note?: string; unreported?: boolean }) {
    const r = this.db.prepare('SELECT reason FROM held WHERE id = ?').get(holdId) as { reason: string | null } | undefined;
    if (!r) return;
    const d = decisionText(r.reason);
    const unreported = change.unreported ?? d.unreported === true;
    const text: DecisionText = { reason: d.reason, note: change.note ?? d.note, ...(unreported ? { unreported: true as const } : {}) };
    this.db.prepare('UPDATE held SET reason = ? WHERE id = ?').run(JSON.stringify(text), holdId);
  }

  /** Give back an approval the relay was never told of, so the hold waits again. */
  private unclaim(id: string) {
    this.db.prepare("UPDATE held SET decided_at = NULL, decision = NULL, reason = NULL WHERE id = ? AND decision = 'approved' AND args_json != '{}'").run(id);
  }

  /** The call is wiped once decided: approved, it is in the ledger's released row; otherwise it was never sent and is kept nowhere. */
  private wipe(id: string) {
    this.db.prepare("UPDATE held SET args_json = '{}' WHERE id = ?").run(id);
  }

  /** What the agent is told about a decided hold, kept with the decision until `takeNotes` hands it over. */
  private note(holdId: string, text: string) {
    this.rewrite(holdId, { note: text });
  }

  private callOf(r: HeldRow): OutboundCall {
    try {
      const c = JSON.parse(r.args_json) as OutboundCall;
      if (c && typeof c === 'object' && c.op) return c;
    } catch {
      // fall through
    }
    return { op: 'share_context', jobId: r.job_id, label: r.label ?? '', args: {} };
  }

  private jobOf(r: HeldRow): LedgerJob {
    return { id: r.job_id, sessionId: r.session_id ?? '', label: r.label ?? '' };
  }

  private entry(r: HeldRow): HeldEntry {
    const call = r.decided_at ? null : this.callOf(r);
    return {
      id: r.id,
      outboundId: Number(r.outbound_id),
      jobId: r.job_id,
      sessionId: r.session_id ?? '',
      label: r.label ?? '',
      call,
      rule: r.rule ?? '',
      kind: r.kind,
      bytes: Number(r.bytes ?? 0),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      decidedAt: r.decided_at,
      decision: (r.decision as HoldResolution | null) ?? null,
      reason: decisionText(r.reason).reason,
    };
  }
}
