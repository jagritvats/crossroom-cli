/**
 * The runner's egress check, as its proxy (runner/proxy.ts) calls it and
 * runner/egress-policy.ts implements it.
 *
 * The proxy is the one place a runner enforces anything: every `tools/call` of `share_context`,
 * `say`, `claim`, `position`, `request_context`, `decline_context`, `finish` or `join` goes through
 * `check` before it is forwarded to the relay, and so does `record`, which a
 * project room offers its organisation's own standing seats and whose query is the agent's words
 * too. A refusal is answered to the agent as a tool error, a hold as a tool result saying it is
 * held for review, and neither is forwarded.
 */
import type { ContextKind } from '@parley/shared';
import type { PolicyVerdict, SeatPolicy } from '@parley/shared/runner';

/** The operations the proxy checks before they leave the machine. */
export type GatedOp = 'share_context' | 'say' | 'claim' | 'position' | 'request_context' | 'decline_context' | 'finish' | 'join' | 'record' | 'work' | 'submit' | 'report' | 'board_set' | 'declare_tool' | 'call_tool' | 'tool_result' | 'open_room' | 'file' | 'update' | 'verify' | 'autonomy';

/** One outbound call, with every field an agent could put text in. */
export interface OutboundCall {
  op: GatedOp;
  jobId: string;
  /** The seat label the job runs under. */
  label: string;
  args: Record<string, unknown>;
  /** For `share_context`: what it would share. */
  packet?: { kind: ContextKind; title: string; body: string; source: string | null };
}

/** What the seat has spent in this room so far, for the budget. */
export interface BudgetUsed {
  messages: number;
  packets: number;
  minutes: number;
  spendUsd?: number;
}

/** What only the runner knows: the job's deny-by-content index and its known secrets. */
export interface RunnerOnly {
  /**
   * Whether a line's key (`deniedLineKeys` in `@parley/shared/policy`, which builds the index's
   * keys too) is in a denied file and in no allowed one; `partial` past the index's bounds.
   */
  deniedLines?: { has(line: string): boolean; partial: boolean };
  /** Every token and secret value this runner must never let out, raw; encodings are the checker's. */
  knownSecrets?: readonly string[];
}

export interface EgressPolicy {
  /** Decide one call. Pure over its inputs; a policy that fails to parse never reaches here (it fails closed at load). */
  check(call: OutboundCall, policy: SeatPolicy, used: BudgetUsed, runner?: RunnerOnly): PolicyVerdict;
}
