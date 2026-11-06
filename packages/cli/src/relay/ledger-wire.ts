/**
 * What a runner sends the relay to sync its outbound ledger, and the limits both sides hold it to.
 * The relay reads it; the runner's (runner/ledger-sync.ts) imports only this, so the
 * `crossroom` command carries the wire and none of the relay.
 */
import { ContextKind } from '@parley/shared';
import { JOB_ID, PolicyDecision } from '@parley/shared/runner';
import { z } from 'zod';

/** The most lines one sync may carry. */
export const LEDGER_LINES_MAX = 200;
/** The most lines kept for one job. The runner's own ledger keeps everything. */
export const LEDGER_ROWS_PER_JOB = 2000;
/** The most lines one read answers. */
export const LEDGER_PAGE_MAX = 500;
/** Syncs a runner may make at once, and how fast it earns another (one every two seconds). */
export const LEDGER_SYNC_BURST = 30;
export const LEDGER_SYNC_REFILL_MS = 2000;

/**
 * What a line may be about: the operations the runner's proxy decides (egress-types.ts `GatedOp`),
 * each of them, `record`'s queries included, so a team sees every call its agents' words went out
 * in (a test holds this list to the proxy's).
 */
export const LedgerOp = z.enum(['share_context', 'say', 'claim', 'position', 'request_context', 'decline_context', 'finish', 'join', 'record', 'work', 'submit', 'report', 'board_set', 'declare_tool', 'call_tool', 'tool_result', 'open_room', 'file', 'update', 'verify', 'autonomy']);
/** A rule's name, as `PolicyEventInput.rule` takes one: `deny`, `secret:aws_access_key`, `review:path`, `pass`. */
const RULE = /^[a-z_]+(:[a-z0-9_]+)?$/;

/**
 * One line of a runner's ledger, as it may reach the relay. Strict: there is no field for a body,
 * a title, a message, a reason or a detail, and a line that carries one is refused whole.
 */
export const LedgerLine = z
  .object({
    /** The row's id in the runner's own ledger (`runner.db` `outbound.id`). */
    row: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    jobId: z.string().regex(JOB_ID),
    at: z.iso.datetime(),
    op: LedgerOp,
    kind: ContextKind.nullable().optional(),
    bytes: z.number().int().min(0).max(10_000_000).nullable().optional(),
    decision: PolicyDecision,
    rule: z.string().max(64).regex(RULE).nullable().optional(),
    /** The report level the seat's policy gave this line: `counts` or `entries` (a `none` line is never sent). */
    level: z.enum(['counts', 'entries']),
    /** `entries` only: the label the room gave the packet. */
    packetLabel: z
      .string()
      .regex(/^X\d{1,6}$/)
      .nullable()
      .optional(),
    /** `entries` only: the source the packet cited. At most what `share_context` itself takes. */
    source: z.string().max(400).nullable().optional(),
  })
  .strict()
  .refine((l) => l.level === 'entries' || (l.packetLabel == null && l.source == null), {
    message: 'a line at the counts level carries no label and no source',
  });
export type LedgerLine = z.infer<typeof LedgerLine>;

/**
 * The most bytes of JSON a runner puts in one sync: half the relay's body limit for
 * `/api/runner`, so a batch of the longest lines, every character of a source escaped, still
 * fits (runner/ledger-sync.ts).
 */
export const LEDGER_SYNC_BYTES = 256 * 1024;

/**
 * `POST /api/runner/ledger`. `lines` may be empty: the answer says where the runner is to go on
 * from. `upTo` is the highest runner row the runner has judged, lines sent or not: rows its policy
 * gave no line (`ledger.report: none`) are passed for good, and never judged again under a later policy.
 */
export const LedgerSyncInput = z
  .object({ lines: z.array(LedgerLine).max(LEDGER_LINES_MAX), upTo: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() })
  .strict()
  .refine((i) => i.upTo === undefined || i.lines.every((l) => l.row <= i.upTo!), { message: 'upTo is at least the highest row sent' });
export type LedgerSyncInput = z.infer<typeof LedgerSyncInput>;
export interface LedgerSyncResult {
  ok: true;
  /** Lines kept now. */
  stored: number;
  /** The highest runner row the relay has been sent: the next sync starts after it. */
  highWater: number;
}
