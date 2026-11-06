/**
 * The runner's outbound ledger, synced to its team: each row of `runner.db`'s
 * `outbound` as the one content-free line the relay takes (`POST /api/runner/ledger`),
 * at the report level the seat's policy gives it (`ledger.report`):
 * - `none`: nothing leaves;
 * - `counts`: when, which job, the operation, the kind and size, the decision and the rule's name;
 * - `entries`: that, the packet's label and the source it cited.
 *
 * A line is built field by field from the row's columns, never from the row as a whole, so the
 * title, the body and the runner's own detail (which names paths and globs) cannot reach it, and a
 * source is sent only at `entries` and only when no secret pattern or known secret matches it
 * (`keepable`). The relay's schema refuses any other field as well.
 *
 * The relay keeps each row once (`runners.ledger_row`) and says how far it has been sent, so the
 * cursor here is only in memory: the first sync asks, and a sync whose answer was lost is sent
 * again and stores nothing twice. Every sync also says how far the runner has judged (`upTo`), so
 * a row its level gave no line is passed on the relay too, and never judged again. Rows go in
 * order of their id, and a row is sent once it is `minAgeMs` old, which gives the proxy's record of
 * what the relay did with a call (`OutboundLedger.settle`) time to land first; the rows after a
 * row too young wait with it, so none is ever passed over. A sync holds at most `LEDGER_LINES_MAX`
 * lines and `LEDGER_SYNC_BYTES` of JSON, and a line is checked against the relay's own schema
 * before it goes: a batch the relay would refuse would be refused on every tick after.
 *
 * **The level is the one the row was written under.** A seat's policy can change between a row
 * and its sync, so the level comes from the policy the job's calls were checked against in this
 * process (`levelOf`, runner/review-service.ts). A row written before this process started
 * (`startRow`: a runner that died with rows unsynced, or could not reach the relay as it stopped)
 * has no level this process can know, so none of it is sent; the runner's own ledger keeps it.
 * `flush`, as the runner stops, sends everything without waiting out `minAgeMs`.
 */
import type { DatabaseSync } from 'node:sqlite';
import { ContextKind } from '@parley/shared';
import { JOB_ID, PolicyDecision } from '@parley/shared/runner';
import { LedgerLine, LedgerOp, LEDGER_LINES_MAX, LEDGER_SYNC_BYTES, type LedgerSyncInput, type LedgerSyncResult } from '../relay/ledger-wire.js';
import { keepable } from './ledger.js';
import type { ReportLevel } from './policy-yml.js';

/** What the sync needs of the relay client (`RelayClient.syncLedger`, on the runner's session). */
export interface LedgerSyncClient {
  syncLedger(input: LedgerSyncInput): Promise<LedgerSyncResult>;
}

export interface LedgerSyncOptions {
  db: DatabaseSync;
  client: LedgerSyncClient;
  /** The report level a job's rows were written under; `none` for one this runner cannot tell. */
  levelOf(jobId: string, label: string): ReportLevel;
  /** The highest row written before this runner process started (`ReviewService.startRow`): none of those is sent. */
  startRow?: number;
  /** Every token and secret this runner holds: a source carrying one is never sent. */
  knownSecrets?(): readonly string[];
  /** How old a row must be before it is sent. Default 5 s. */
  minAgeMs?: number;
  /** Lines sent at a time, and rows read at a time; at most `LEDGER_LINES_MAX`. */
  batch?: number;
  now?: () => Date;
  log?(line: string): void;
}

interface OutboundRow {
  id: number;
  at: string;
  job_id: string;
  label: string;
  op: string;
  packet_label: string | null;
  kind: string | null;
  source: string | null;
  bytes: number | null;
  decision: string;
  rule: string | null;
}

const RULE = /^[a-z_]+(:[a-z0-9_]+)?$/;

/** One row as the line the relay takes at `level`, or null when nothing of it may go (level `none`, or a row the relay would not read). */
export function lineOf(r: OutboundRow, level: ReportLevel, known: readonly string[] = []): LedgerLine | null {
  if (level === 'none') return null;
  const op = LedgerOp.safeParse(r.op);
  const decision = PolicyDecision.safeParse(r.decision);
  if (!op.success || !decision.success || !JOB_ID.test(r.job_id) || !Number.isFinite(Date.parse(r.at))) return null;
  const kind = r.kind === null ? null : ContextKind.safeParse(r.kind).success ? (r.kind as ContextKind) : null;
  const rule = r.rule && r.rule.length <= 64 && RULE.test(r.rule) ? r.rule : null;
  const bytes = typeof r.bytes === 'number' && Number.isInteger(r.bytes) && r.bytes >= 0 && r.bytes <= 10_000_000 ? r.bytes : null;
  const line: LedgerLine = { row: Number(r.id), jobId: r.job_id, at: new Date(Date.parse(r.at)).toISOString(), op: op.data, kind, bytes, decision: decision.data, rule, level };
  if (level === 'entries') {
    if (r.packet_label && /^X\d{1,6}$/.test(r.packet_label)) line.packetLabel = r.packet_label;
    if (r.source && keepable(r.source, known)) line.source = r.source.slice(0, 400);
  }
  // Checked as the relay will check it: a line it would refuse would refuse every sync after.
  return LedgerLine.safeParse(line).success ? line : null;
}

/** A line's share of a sync's body: its JSON, and the comma after it. */
const sizeOf = (l: LedgerLine) => Buffer.byteLength(JSON.stringify(l), 'utf8') + 1;
/** The body around the lines: `{"lines":[`, `],"upTo":`, the number and `}`. */
const ENVELOPE_BYTES = 64;

export class LedgerSync {
  private cursor: number | null = null;
  private busy: Promise<{ sent: number; stored: number }> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

  constructor(private readonly o: LedgerSyncOptions) {
    this.now = o.now ?? (() => new Date());
  }

  /** Where the relay has been sent up to, as far as this process knows; null before the first sync. */
  get sentUpTo(): number | null {
    return this.cursor;
  }

  /**
   * Send every row old enough that the relay has not been sent, in batches. One run at a time: a
   * call while one runs waits for it. Rejects when the relay did not take a batch; the next run
   * goes on from the last one it did take.
   */
  run(o: { minAgeMs?: number } = {}): Promise<{ sent: number; stored: number }> {
    this.busy ??= this.runNow(o).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  /** As the runner stops: once any run under way is done, everything, however young (no call will settle now). */
  async flush(): Promise<{ sent: number; stored: number }> {
    await this.busy?.catch(() => {});
    return await this.run({ minAgeMs: 0 });
  }

  private async runNow(o: { minAgeMs?: number }): Promise<{ sent: number; stored: number }> {
    const { db, client } = this.o;
    const batch = Math.max(1, Math.min(LEDGER_LINES_MAX, this.o.batch ?? LEDGER_LINES_MAX));
    if (this.cursor === null) this.cursor = Math.max(0, Number((await client.syncLedger({ lines: [] })).highWater) || 0);
    const now = this.now().getTime();
    const cutoff = now - (o.minAgeMs ?? this.o.minAgeMs ?? 5000);
    const levels = new Map<string, ReportLevel>();
    const levelOf = (r: OutboundRow): ReportLevel => {
      // Written before this process: under a policy it cannot know.
      if (this.o.startRow !== undefined && Number(r.id) <= this.o.startRow) return 'none';
      const k = `${r.job_id}\0${r.label}`;
      if (!levels.has(k)) {
        let l: ReportLevel = 'none';
        try {
          l = this.o.levelOf(r.job_id, r.label);
        } catch {
          // A seat whose policy cannot be read now sends nothing.
          l = 'none';
        }
        levels.set(k, l);
      }
      return levels.get(k)!;
    };
    let sent = 0;
    let stored = 0;
    let lines: LedgerLine[] = [];
    let bytes = ENVELOPE_BYTES;
    /** The highest row judged so far: sent as a line, or passed. */
    let judged = this.cursor;
    const send = async () => {
      if (judged <= this.cursor!) return;
      const r = await client.syncLedger({ lines, upTo: judged });
      sent += lines.length;
      stored += r.stored;
      this.cursor = judged;
      lines = [];
      bytes = ENVELOPE_BYTES;
    };
    read: for (;;) {
      const rows = db
        .prepare('SELECT id, at, job_id, label, op, packet_label, kind, source, bytes, decision, rule FROM outbound WHERE id > ? ORDER BY id LIMIT ?')
        .all(judged, batch) as unknown as OutboundRow[];
      if (!rows.length) break;
      const known = this.o.knownSecrets?.() ?? [];
      for (const r of rows) {
        const at = Date.parse(r.at);
        // Too young for what the relay did with it to be in it yet; one stamped ahead of now (a
        // clock set back since) cannot be told, and goes. The rows after it wait with it.
        if (at > cutoff && at <= now) break read;
        const line = lineOf(r, levelOf(r), known);
        if (line) {
          const size = sizeOf(line);
          if (lines.length >= batch || (lines.length > 0 && bytes + size > LEDGER_SYNC_BYTES)) await send();
          lines.push(line);
          bytes += size;
        }
        judged = Number(r.id);
      }
      if (rows.length < batch) break;
    }
    await send();
    return { sent, stored };
  }

  /** Sync every `everyMs` (default a minute) until `stop`. A failure is logged and tried at the next tick. */
  start(everyMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.run().catch((e) => this.o.log?.(`the outbound ledger could not be synced to the relay: ${(e as Error)?.message ?? e}`));
    }, everyMs);
  }

  /** Stop the timer, and wait for a run in progress. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.busy?.catch(() => {});
  }
}
