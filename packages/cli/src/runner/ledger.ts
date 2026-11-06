/**
 * The runner's outbound ledger: one row in `runner.db`'s `outbound` table for every
 * gated call the egress proxy saw, whatever the policy decided. It lives on the answering team's
 * machine and is theirs: `crossroom runner ledger` and the runner's local page read it, and the relay
 * only ever hears the content-free part (`policyEvents`: an operation, a rule's name, a decision).
 *
 * What a row keeps depends on what happened to the call:
 * - `sent` and `released`: the title, the source and the body, since they left the machine anyway;
 * - `held`: its shape only, because the call itself waits in `held` (review.ts) until a person
 *   decides, and a hold may be for a secret in the title;
 * - `refused` and `refused_after_review`: never the body, and no title or source when the rule is
 *   about a secret or a denied file's lines, or when either field carries anything a secret pattern
 *   or the runner's known secrets would match. A ledger that copied what it refused would be one
 *   more file holding the secret.
 *
 * Every row keeps the call's size and sha256 whatever was decided, so a team can still tell two
 * refusals of the same packet apart without the packet.
 *
 * Append-only, except `settle`, which records what the relay did with a call the proxy let through
 * (the same call, a moment later). A decision on a held call is a row of its own (`released`,
 * `refused_after_review`), so the ledger reads as what happened, in order.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hasKnownSecret, scanSecrets } from '@parley/shared/policy';
import { PolicyDecision, PolicyEventInput, type PolicyVerdict } from '@parley/shared/runner';
import type { BudgetUsed, GatedOp, OutboundCall } from './egress-types.js';

/** The job a call belongs to, as the ledger names it. */
export interface LedgerJob {
  id: string;
  sessionId: string;
  /** The seat label the job runs under. */
  label: string;
}

/** One row of the ledger, as `crossroom runner ledger --json` prints it. */
export interface OutboundEntry {
  id: number;
  at: string;
  jobId: string;
  sessionId: string;
  label: string;
  op: string;
  toSeat: string | null;
  packetLabel: string | null;
  kind: string | null;
  title: string | null;
  source: string | null;
  bytes: number | null;
  sha256: string | null;
  decision: PolicyDecision;
  rule: string | null;
  detail: string | null;
  body: string | null;
}

/** The rule a call the policy let through is recorded under (`PolicyEventInput.rule` needs one). */
export const PASS_RULE = 'pass';
/** The rule of a call the runner let through and the relay did not take (its second line, or the room). */
export const RELAY_RULE = 'relay';

/** What counts against a budget: calls that reached the room. */
const COUNTED: readonly PolicyDecision[] = ['sent', 'released'];
/** The operations the `messages` budget counts (as `checkOutbound` does). */
const MESSAGE_OPS: readonly GatedOp[] = ['say', 'claim', 'position', 'request_context', 'decline_context'];

/** Rules whose refusal says the call's own text is what must not be kept. */
const CONTENT_RULE = /^(?:secret(?::|$)|deny:content$)/;

const MAX_DETAIL = 500;
const MAX_TO = 64;

/**
 * What a call carries, as the ledger stores it: for a packet, its title, source, kind and body; for
 * anything else, its string arguments as one JSON object (keys sorted), which is also what its size
 * and digest are of. `bytes` of a packet is the body's UTF-8 length, the number the server
 * stores for a packet and the relay's hold binding compares.
 */
export function contentOf(call: OutboundCall): {
  body: string;
  bytes: number;
  sha256: string;
  title: string | null;
  source: string | null;
  kind: string | null;
  to: string | null;
} {
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  let body: string;
  let title: string | null = null;
  let source: string | null = null;
  let kind: string | null = null;
  if (call.op === 'share_context') {
    body = call.packet?.body ?? str(args.body) ?? '';
    title = call.packet?.title ?? str(args.title);
    source = call.packet ? call.packet.source : str(args.source);
    // As `share_context` itself defaults it on the server.
    kind = call.packet?.kind ?? str(args.kind) ?? 'text';
  } else {
    const fields: Record<string, string> = Object.create(null);
    for (const k of Object.keys(args).sort()) {
      const v = args[k];
      if (typeof v === 'string') fields[k] = v;
      else if (Array.isArray(v)) fields[k] = JSON.stringify(v.filter((x) => typeof x === 'string'));
    }
    body = JSON.stringify(fields);
  }
  return {
    body,
    bytes: Buffer.byteLength(body, 'utf8'),
    sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    title,
    source,
    kind,
    to: str(args.to),
  };
}

/** Whether a text may be written to the ledger: no known secret in any form, and nothing any secret pattern matches. */
export function keepable(text: string | null | undefined, known: readonly string[] = []): boolean {
  if (text == null || text === '') return true;
  try {
    return !hasKnownSecret(text, known) && scanSecrets(text).length === 0;
  } catch {
    return false;
  }
}

const decisionOf = (v: PolicyVerdict): PolicyDecision => (v.ok ? 'sent' : v.action === 'hold' ? 'held' : 'refused');

export class OutboundLedger {
  private readonly now: () => Date;

  constructor(
    private readonly db: DatabaseSync,
    o: { now?: () => Date } = {},
  ) {
    this.now = o.now ?? (() => new Date());
  }

  /**
   * One gated call and what the policy said about it. `known` is the runner's known secrets, so no
   * field that carries one is written; `detail` is the runner's own explanation (never sent anywhere).
   */
  record(job: LedgerJob, call: OutboundCall, verdict: PolicyVerdict, o: { detail?: string | null; known?: readonly string[] } = {}): number {
    const known = o.known ?? [];
    const c = contentOf(call);
    const decision = decisionOf(verdict);
    const rule = verdict.ok ? PASS_RULE : verdict.rule;
    const keep = (t: string | null) => (keepable(t, known) ? t : null);
    let title: string | null = null;
    let source: string | null = null;
    let body: string | null = null;
    if (decision === 'sent') {
      title = c.title;
      source = c.source;
      body = c.body;
    } else if (decision === 'refused' && !CONTENT_RULE.test(rule)) {
      title = keep(c.title);
      source = keep(c.source);
    }
    const to = c.to === null ? null : keep(c.to.slice(0, MAX_TO));
    const r = this.db
      .prepare(
        `INSERT INTO outbound (at, job_id, session_id, label, op, to_seat, kind, title, source, bytes, sha256, decision, rule, detail, body)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        this.now().toISOString(),
        job.id,
        job.sessionId,
        job.label,
        call.op,
        to,
        c.kind,
        title,
        source,
        c.bytes,
        c.sha256,
        decision,
        rule,
        this.detail(o.detail, known),
        body,
      );
    return Number(r.lastInsertRowid);
  }

  /**
   * What the relay did with a call the proxy forwarded. Taken: the packet's label, if the answer
   * named one. Not taken: the row becomes `refused` under `RELAY_RULE`, its body dropped (it never
   * reached the room), with the relay's answer as detail.
   */
  settle(
    id: number,
    result: { ok: true; packetLabel?: string | null } | { ok: false; detail?: string | null; rule?: string },
    known: readonly string[] = [],
  ) {
    if (result.ok) {
      const label = typeof result.packetLabel === 'string' && /^X\d{1,6}$/.test(result.packetLabel) ? result.packetLabel : null;
      if (label) this.db.prepare('UPDATE outbound SET packet_label = ? WHERE id = ?').run(label, id);
      return;
    }
    // Also a hold the runner could not keep (egress-policy.ts), which then left nothing behind.
    this.db
      .prepare(
        "UPDATE outbound SET decision = 'refused', rule = ?, detail = ?, body = NULL, packet_label = NULL WHERE id = ? AND decision IN ('sent', 'released', 'held')",
      )
      .run(result.rule ?? RELAY_RULE, this.detail(result.detail, known), id);
  }

  /**
   * A person's decision on a held call, or what came of it, as a row of its own. `released` keeps
   * the call's content, since it is about to leave; `refused_after_review` keeps its shape only.
   */
  decide(
    job: LedgerJob,
    call: OutboundCall,
    decision: Extract<PolicyDecision, 'released' | 'refused_after_review'>,
    o: { rule: string; detail?: string | null; known?: readonly string[] },
  ): number {
    const known = o.known ?? [];
    const c = contentOf(call);
    const released = decision === 'released';
    const r = this.db
      .prepare(
        `INSERT INTO outbound (at, job_id, session_id, label, op, to_seat, kind, title, source, bytes, sha256, decision, rule, detail, body)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        this.now().toISOString(),
        job.id,
        job.sessionId,
        job.label,
        call.op,
        c.to === null ? null : c.to.slice(0, MAX_TO),
        c.kind,
        released ? c.title : null,
        released ? c.source : null,
        c.bytes,
        c.sha256,
        decision,
        o.rule,
        this.detail(o.detail, known),
        released ? c.body : null,
      );
    return Number(r.lastInsertRowid);
  }

  /**
   * What a job has used of its budget: messages and packets that reached the room, minutes since
   * it started (its first ledger row when the caller does not know), and what it cost where the
   * runner can count that.
   */
  used(jobId: string, o: { startedAt?: string | null; spendUsd?: number | null } = {}): BudgetUsed {
    const inList = (xs: readonly string[]) => xs.map(() => '?').join(',');
    const count = (ops: readonly string[]) =>
      Number(
        (
          this.db
            .prepare(`SELECT COUNT(*) AS n FROM outbound WHERE job_id = ? AND op IN (${inList(ops)}) AND decision IN (${inList(COUNTED)})`)
            .get(jobId, ...ops, ...COUNTED) as { n: number }
        ).n,
      );
    const first = (this.db.prepare('SELECT MIN(at) AS at FROM outbound WHERE job_id = ?').get(jobId) as { at: string | null }).at;
    const since = Date.parse(o.startedAt ?? first ?? '');
    const minutes = Number.isFinite(since) ? Math.max(0, Math.floor((this.now().getTime() - since) / 60_000)) : 0;
    const used: BudgetUsed = { messages: count(MESSAGE_OPS), packets: count(['share_context']), minutes };
    if (typeof o.spendUsd === 'number' && Number.isFinite(o.spendUsd) && o.spendUsd >= 0) used.spendUsd = o.spendUsd;
    return used;
  }

  get(id: number): OutboundEntry | null {
    const r = this.db.prepare('SELECT * FROM outbound WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? mapRow(r) : null;
  }

  /** Newest first: `crossroom runner ledger [--seat] [--since] [--json]` and the local page. */
  list(o: { label?: string; jobId?: string; since?: string; limit?: number } = {}): OutboundEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.label) {
      where.push('label = ?');
      args.push(o.label);
    }
    if (o.jobId) {
      where.push('job_id = ?');
      args.push(o.jobId);
    }
    if (o.since) {
      where.push('at >= ?');
      args.push(o.since);
    }
    const limit = Math.max(1, Math.min(10_000, Math.floor(o.limit ?? 200)));
    const sql = `SELECT * FROM outbound ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map(mapRow);
  }

  /**
   * The content-free lines a runner reports for a job (`JobUpdateInput.policy`, at most 100 a
   * report), after the ledger row `afterId`: an operation, a rule's name, a decision. Nothing else
   * of a row ever leaves the machine. A row whose rule the relay's schema would not take is left out.
   */
  policyEvents(jobId: string, afterId = 0, max = 100): Array<{ id: number; event: PolicyEventInput }> {
    const rows = this.db
      .prepare('SELECT id, op, rule, decision FROM outbound WHERE job_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(jobId, afterId, Math.max(1, Math.min(100, max))) as { id: number; op: string; rule: string | null; decision: string }[];
    const out: Array<{ id: number; event: PolicyEventInput }> = [];
    for (const r of rows) {
      const parsed = PolicyEventInput.safeParse({ op: r.op, rule: r.rule ?? PASS_RULE, decision: r.decision });
      if (parsed.success) out.push({ id: Number(r.id), event: parsed.data });
    }
    return out;
  }

  private detail(text: string | null | undefined, known: readonly string[]): string | null {
    if (!text) return null;
    const t = text.slice(0, MAX_DETAIL);
    return keepable(t, known) ? t : '[withheld: it quoted what the policy refused]';
  }
}

function mapRow(r: Record<string, unknown>): OutboundEntry {
  const s = (v: unknown) => (v == null ? null : String(v));
  const decision = PolicyDecision.safeParse(r.decision);
  return {
    id: Number(r.id),
    at: String(r.at),
    jobId: String(r.job_id),
    sessionId: String(r.session_id),
    label: String(r.label),
    op: String(r.op),
    toSeat: s(r.to_seat),
    packetLabel: s(r.packet_label),
    kind: s(r.kind),
    title: s(r.title),
    source: s(r.source),
    bytes: r.bytes == null ? null : Number(r.bytes),
    sha256: s(r.sha256),
    decision: decision.success ? decision.data : 'refused',
    rule: s(r.rule),
    detail: s(r.detail),
    body: s(r.body),
  };
}
