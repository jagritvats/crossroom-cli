/**
 * The runner's first line: what its egress proxy (runner/proxy.ts) asks before a
 * gated tool call leaves the machine, and what it does with the answer.
 *
 * - `egressPolicy()` is the contract's `EgressPolicy` (runner/egress-types.ts): a proxy call as the
 *   policy library's `Outbound`, checked by `checkOutbound` (`@parley/shared/policy`) with what only
 *   the runner knows: the job's deny-by-content index (denied-lines.ts), its known secrets
 *   (`collectKnownSecrets`), the checkout's name and whether its file system ignores case.
 * - `EgressGate` is what the proxy calls: check, record in the outbound ledger (ledger.ts), keep a
 *   held packet for review (review.ts), and forward only what passed. `run` does all of it around
 *   the proxy's own forwarding function, so a refused or held call can never reach it.
 * - `loadSeatPolicy` reads a seat's policy from its `runner.yml` entry and the repository's
 *   `.parley/policy.yml` at the answering commit. Anything it cannot read fails closed: the seat
 *   gets no policy, and every gated call is refused until its team fixes the file.
 *
 * Nothing here talks to the network or the relay. The relay hears only what the ledger's
 * `policyEvents` give (an operation, a rule's name, a decision) and a hold's shape.
 */
import { createContext, Script } from 'node:vm';
import { ContextKind } from '@parley/shared';
import {
  checkOutbound,
  deniedLineKeys,
  deniedPaths,
  hasKnownSecret,
  KNOWN_SECRET_MIN,
  type Outbound,
  pathsNamedIn,
  POLICY_MESSAGES,
  type RunnerContext,
  SECRET_PATTERNS,
  scanSecrets,
} from '@parley/shared/policy';
import { type HeldInput, type PolicySummary, PolicySummary as PolicySummarySchema, type PolicyVerdict, SeatBudget, SeatPolicy, WhenSecret } from '@parley/shared/runner';
import { LINE_BREAK } from '@parley/shared/text';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { BudgetUsed, EgressPolicy, GatedOp, OutboundCall, RunnerOnly } from './egress-types.js';
import type { LedgerJob, OutboundLedger } from './ledger.js';
import type { ReviewQueue } from './review.js';

// ---------------------------------------------------------------- the call, as the policy reads it

/** Every operation the proxy checks before forwarding: eight of the ten, in `TOOL_NAMES` order, then `record` and a project room's `work`, `submit` and `report`. */
export const GATED_OPS: readonly GatedOp[] = ['join', 'say', 'request_context', 'decline_context', 'share_context', 'claim', 'position', 'finish', 'record', 'work', 'submit', 'report', 'board_set', 'declare_tool', 'call_tool', 'tool_result', 'open_room', 'file', 'update', 'verify', 'autonomy'];
export const isGatedOp = (op: unknown): op is GatedOp => typeof op === 'string' && (GATED_OPS as readonly string[]).includes(op);

/** The most string fields, and the deepest nesting, a call may carry and still be read. */
const MAX_FIELDS = 200;
const MAX_DEPTH = 4;

/**
 * A proxy call as the policy's `Outbound`: every string anywhere in its arguments as a field (a
 * nested one as `evidence.0`), numbers and booleans left out, since they carry no words. A packet
 * the proxy parsed out of the call is read too, and where it says something the arguments do not,
 * both are checked (`packet.body`), so the two can never disagree to get a body past the check.
 * Throws for a call too deep or too wide to read, which the policy refuses as `malformed`.
 */
export function outboundOf(call: OutboundCall): Outbound {
  // No prototype: an argument named `__proto__` (an own key of parsed JSON) is a field like any
  // other, where a plain object would drop the assignment and the check would never see it.
  const fields: Record<string, string> = Object.create(null);
  let n = 0;
  // Never over another field: a literal key `evidence.0` and the first item of `evidence` would
  // otherwise share a name, and only one of the two would be checked.
  const put = (key: string, v: string) => {
    if (++n > MAX_FIELDS) throw new Error('too many fields');
    let k = key;
    for (let i = 2; k in fields; i++) k = `${key}#${i}`;
    fields[k] = v;
  };
  const walk = (v: unknown, key: string, depth: number) => {
    if (typeof v === 'string') {
      put(key, v);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    if (depth >= MAX_DEPTH) throw new Error('nested too deep');
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
    for (const [k, x] of entries) walk(x, key ? `${key}.${k}` : k, depth + 1);
  };
  const args = call.args;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments are not an object');
  walk(args, '', 0);
  const p = call.packet;
  if (p) {
    for (const k of ['title', 'body', 'source'] as const) {
      const v = p[k];
      if (typeof v === 'string' && v && fields[k] !== v) put(fields[k] === undefined ? k : `packet.${k}`, v);
    }
  }
  const source = typeof p?.source === 'string' && p.source ? p.source : typeof args.source === 'string' && args.source ? args.source : null;
  const kind = call.op === 'share_context' ? (p?.kind ?? (typeof args.kind === 'string' ? args.kind : 'text')) : undefined;
  return { op: call.op, fields, source, ...(kind ? { kind } : {}) };
}

// ---------------------------------------------------------------- a bound on the checks' time

/**
 * How long the runner's checks of one call may take. A call a team's own policy lets through takes
 * well under a tenth of this: 200 globs against a 4,000-character source take about 80 ms.
 */
export const EGRESS_CHECK_MS = 500;

/**
 * The least time `withinTime` gives a check, whatever bound its caller asked for. It is 0, so the
 * bounds here and on the relay stand, and nothing in the product changes it. Only the end-to-end
 * scenario tests raise it: in the relay, which they run in process, and in every
 * `crossroom` process they start. The bound is wall-clock time,
 * and a machine busy with their processes can deschedule one for longer than half a second. A call
 * refused as `malformed` then reads as a wrong policy in a test that is about the policy. The
 * bounds themselves are tested where they are set, at their real values.
 */
export const checkFloor = { ms: 0 };

const boundedContext = createContext(Object.create(null));
const boundedCall = new Script('run()');
let boundedDepth = 0;

/**
 * `fn()`, stopped after `ms` milliseconds. The checks' globs compile to regular expressions
 * (picomatch), and a glob such as `*a*a*a*a*a*a*b`, a `**` after a `**`, or a brace list after
 * another backtracks for as long as its input allows: seconds for a source of 30 characters, and
 * the checks run on the relay's one event loop and in the runner's proxy. `vm`'s timeout
 * terminates the isolate's JavaScript, a regular expression in the middle of backtracking
 * included, and a `try` in the checks cannot catch it. What `fn` was doing is dropped: the checks
 * are pure. Answers `ok: false` when `fn` was stopped (`timedOut`) or threw, which every caller
 * refuses. A call made inside another runs under the outer one's bound. No bound is shorter than
 * `checkFloor.ms`.
 */
export function withinTime<T>(ms: number, fn: () => T): { ok: true; value: T } | { ok: false; timedOut: boolean } {
  if (boundedDepth) {
    try {
      return { ok: true, value: fn() };
    } catch {
      return { ok: false, timedOut: false };
    }
  }
  boundedDepth++;
  (boundedContext as { run?: () => T }).run = fn;
  try {
    return { ok: true, value: boundedCall.runInContext(boundedContext, { timeout: Math.max(ms, checkFloor.ms) }) as T };
  } catch (e) {
    return { ok: false, timedOut: (e as { code?: unknown } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' };
  } finally {
    (boundedContext as { run?: unknown }).run = undefined;
    boundedDepth--;
  }
}

/** Verdicts given because the checks ran out of time, with the bound they ran past, so the ledger's detail can say so. */
const outOfTime = new WeakMap<PolicyVerdict, number>();

/** `malformed` for a call whose checks did not finish within `ms`: it could not be checked, so it is not sent. */
export function tooSlow(ms: number): PolicyVerdict {
  const v: PolicyVerdict = { ok: false, action: 'refuse', rule: 'malformed', message: POLICY_MESSAGES.malformed };
  outOfTime.set(v, ms);
  return v;
}

// ---------------------------------------------------------------- the contract's check

/**
 * What only the runner knows, as the contract's `RunnerOnly` carries it, plus how its checkout
 * names paths: the directory's name (`payments-api/config/x.yml` is `config/x.yml`) and whether
 * paths ignore case there (`caseInsensitivePaths(process.platform)`). A proxy that gives neither
 * gets the factory's defaults.
 */
export interface RunnerFacts extends RunnerOnly {
  repo?: string;
  /**
   * Every other name the checkout's top goes by in a path an agent cites (the runner host's
   * `RunnerCheckout.repos`: `repo`, the job's directory, and the team's own name for it). The check
   * runs once per name and the most severe verdict stands, so more names can only deny more.
   */
  repos?: readonly string[];
  nocase?: boolean;
}

/** What a seat is told when its deny-by-content index stopped at its bounds (denied-lines.ts). */
export const PARTIAL_MESSAGE =
  "Refused: your team's policy could not index every file it keeps private, so nothing leaves this seat until its team narrows the deny list.";

export interface EgressOptions {
  repo?: string;
  nocase?: boolean;
  /**
   * What a partial deny-by-content index means. `refuse` (the default): every call is refused
   * while the index is partial, `finish` and `join` included, since any text an agent sends could
   * quote a denied file the index never read (a finish summary is printed in the minutes). The
   * runner host should not start a job on a partial index at all under `refuse`. `accept`: the
   * calls are checked against what the index did read, and the ledger's detail says it was
   * partial. Only a seat configured for it should get `accept`.
   */
  onPartial?: 'refuse' | 'accept';
  /** How long one call's checks may take before the call is refused as `malformed` (`EGRESS_CHECK_MS`). */
  checkMs?: number;
}

const refused = (rule: string, message: string): PolicyVerdict => ({ ok: false, action: 'refuse', rule, message });
/** How bad a verdict is: a refusal outranks a hold, which outranks a pass. */
const severity = (v: PolicyVerdict): 0 | 1 | 2 => (v.ok ? 0 : v.action === 'refuse' ? 2 : 1);

/** The contract's `EgressPolicy`: `checkOutbound` over the proxy's call, failing closed on anything it cannot read. */
export function egressPolicy(o: EgressOptions = {}): EgressPolicy {
  const onPartial = o.onPartial ?? 'refuse';
  return {
    check(call: OutboundCall, policy: SeatPolicy, used: BudgetUsed, runner?: RunnerOnly): PolicyVerdict {
      if (!SeatPolicy.safeParse(policy).success) return refused('policy', POLICY_MESSAGES.policy);
      if (!call || typeof call !== 'object' || !isGatedOp(call.op)) return refused('malformed', POLICY_MESSAGES.malformed);
      let out: Outbound;
      try {
        out = outboundOf(call);
      } catch {
        return refused('malformed', POLICY_MESSAGES.malformed);
      }
      const facts = (runner ?? {}) as RunnerFacts;
      if (facts.deniedLines?.partial && onPartial === 'refuse') return refused('deny:partial', PARTIAL_MESSAGE);
      const ctx: RunnerContext = {
        ...(facts.deniedLines ? { deniedLines: facts.deniedLines } : {}),
        ...(facts.knownSecrets ? { knownSecrets: facts.knownSecrets } : {}),
        nocase: facts.nocase ?? o.nocase ?? false,
      };
      const names = [...new Set([facts.repo ?? o.repo, ...(facts.repos ?? [])].filter((n): n is string => !!n))];
      const ms = o.checkMs ?? EGRESS_CHECK_MS;
      // Every name inside the one time bound: a call is decided in `ms` whatever its checkout is called.
      const done = withinTime(ms, () => {
        let worst: PolicyVerdict | null = null;
        for (const repo of names.length ? names : [undefined]) {
          const v = checkOutbound(out, policy, used, repo ? { ...ctx, repo } : ctx);
          if (!worst || severity(v) > severity(worst)) worst = v;
          if (severity(worst) === 2) break;
        }
        return worst!;
      });
      if (done.ok) return done.value;
      return done.timedOut ? tooSlow(ms) : refused('policy', POLICY_MESSAGES.policy);
    },
  };
}

// ---------------------------------------------------------------- known secrets

/** A variable whose value the runner treats as a secret it must never let out. */
const SECRET_ENV = /KEY|TOKEN|SECRET|PASS/i;
/** Named like a secret and never one: the programs git and ssh run to ask for a password. */
const NOT_SECRET_ENV = /ASKPASS/i;
const TRIVIAL = /^(?:true|false|yes|no|on|off|none|null|\d{1,12})$/i;

/**
 * Every value the runner must never let out, raw (`checkOutbound` tries the encodings): the
 * runner's own token and session, every live seat and ask token it holds, and the value of every
 * environment variable named like a key, a token, a secret or a password. Values shorter than
 * `KNOWN_SECRET_MIN`, and plain flags and numbers, are left out: they would match ordinary text.
 */
export function collectKnownSecrets(o: { tokens?: readonly (string | null | undefined)[]; env?: Readonly<Record<string, string | undefined>> }): string[] {
  const out = new Set<string>();
  for (const t of o.tokens ?? []) if (typeof t === 'string' && t.length >= KNOWN_SECRET_MIN) out.add(t);
  for (const [name, value] of Object.entries(o.env ?? {})) {
    if (typeof value !== 'string' || value.length < KNOWN_SECRET_MIN || TRIVIAL.test(value.trim())) continue;
    if (SECRET_ENV.test(name) && !NOT_SECRET_ENV.test(name)) out.add(value);
  }
  return [...out];
}

// ---------------------------------------------------------------- the seat's policy

/** A glob list as a policy file writes it. */
const Globs = z.array(z.string().min(1).max(300)).max(200);

/**
 * A seat's policy as `runner.yml` and `.parley/policy.yml` write it: snake_case, every key optional,
 * nothing else allowed. An unknown key fails the whole policy rather than being ignored, because a
 * misspelt `deny_list:` that was ignored would be a deny list that denies nothing.
 */
export const PolicyFields = z
  .object({
    version: z.literal(1).optional(),
    deny: Globs.optional(),
    secret_scan: z.boolean().optional(),
    extra_secrets: z
      .array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), regex: z.string().min(1).max(500) }).strict())
      .max(50)
      .optional(),
    review: z
      .object({
        paths: Globs.optional(),
        kinds: z.array(ContextKind).max(10).optional(),
        when_secret: WhenSecret.optional(),
        timeout_minutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
      })
      .strict()
      .optional(),
    budget: z
      .object({
        messages: SeatBudget.shape.messages.optional(),
        packets: SeatBudget.shape.packets.optional(),
        minutes: SeatBudget.shape.minutes.optional(),
        spend_usd: z.number().min(0).max(1000).optional(),
        concurrent: SeatBudget.shape.concurrent.optional(),
        per_hour: SeatBudget.shape.perHour.optional(),
        per_day: z.number().int().min(1).max(5000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PolicyFields = z.infer<typeof PolicyFields>;

/** The keys of a `runner.yml` seat entry that are policy (`policyFieldsOf`). */
export const POLICY_KEYS = ['deny', 'secret_scan', 'extra_secrets', 'review', 'budget'] as const;

/** A seat entry's policy keys, and nothing else of it (its label, directory, runtime...). */
export function policyFieldsOf(seat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of POLICY_KEYS) if (seat[k] !== undefined) out[k] = seat[k];
  return out;
}

/**
 * Denied whatever the team writes: git's own directory, which holds the remotes' URLs (with any
 * credentials in them), hooks and the object store. A name without a `/`, so it matches `.git` at
 * any depth and everything under it, and not `.github` or `.gitignore`.
 */
export const FLOOR_DENY: readonly string[] = ['.git'];

/** What a seat gets for anything neither its config nor its policy file says. */
export const DEFAULT_POLICY: SeatPolicy = {
  deny: [...FLOOR_DENY],
  secretScan: true,
  review: { paths: [], kinds: [], whenSecret: 'hold', timeoutMinutes: 120 },
  budget: { messages: 30, packets: 12, minutes: 20, concurrent: 3, perHour: 10 },
};

/** The largest policy file read; past it the policy fails closed. */
export const POLICY_FILE_MAX = 64 * 1024;

/** Where a part of a seat's policy comes from: an object already parsed (a `runner.yml` entry), or a file's text. */
export type PolicySource =
  | { name: string; value: unknown }
  | {
      name: string;
      /** The file's text at the answering commit; `null` when it is not there. */
      text: string | null;
      /** The seat's config names this file, so its absence fails closed rather than meaning "no file". */
      required?: boolean;
    };

export type LoadedPolicy = { ok: true; policy: SeatPolicy; summary: PolicySummary } | { ok: false; error: string };

const issuesOf = (e: z.ZodError) =>
  e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`)
    .join('; ');

/**
 * A glob as the policy keeps it: `/` for every `\` (a team editing on Windows writes
 * `config\prod\**`, which picomatch would read as escapes and match nothing), trimmed. An exception
 * (`!secrets/README.md`) is refused: picomatch reads a leading `!` as "everything but", which would
 * deny every path the seat has, and the policy has no allow list.
 */
function normaliseGlob(g: string): { ok: true; glob: string } | { ok: false; error: string } {
  const glob = g.trim().replace(/\\/g, '/');
  if (!glob) return { ok: false, error: 'an empty glob' };
  if (glob.startsWith('!')) return { ok: false, error: `"${glob}" is an exception; a deny or review list has no exceptions, so name only what to deny` };
  return { ok: true, glob };
}

/**
 * Read and merge a seat's policy from its sources, in order. The first is the base: the seat's
 * `runner.yml` entry (pass `{ value: {} }` when it says nothing), which the runner's operator writes
 * on the runner's own machine, and which may loosen the defaults (`DEFAULT_POLICY`) as well as
 * tighten them. Every later source, the repository's `.parley/policy.yml` at the answering commit,
 * only tightens: whoever can merge to that ref can change the file, and must not be able to turn a
 * seat's scan off or raise its budget. So deny and review lists and extra secrets are joined, a
 * later `secret_scan: true` turns the scan on and a later `false` changes nothing,
 * `when_secret: refuse` beats `hold`, and each budget and the review timeout take the smaller
 * number. `FLOOR_DENY` is always denied.
 *
 * Fails closed with the reason, for the team, on: YAML that does not parse (or holds a key twice,
 * or too many aliases), a key the schema does not know, a value out of range, a glob with an
 * exception or one picomatch cannot compile, an extra secret whose regex does not compile or whose
 * name is a built-in pattern's (the scan would keep only one of the two), a file the config names
 * that is missing, or a file larger than `POLICY_FILE_MAX`.
 */
export function loadSeatPolicy(sources: readonly PolicySource[]): LoadedPolicy {
  const parts: PolicyFields[] = [];
  for (const s of sources) {
    let value: unknown;
    if ('text' in s) {
      if (s.text === null) {
        if (s.required) return { ok: false, error: `${s.name} is named in the seat's config but is not in the checkout` };
        // A file that is not there says nothing, and keeps its place: the first source stays the base.
        parts.push({});
        continue;
      }
      if (typeof s.text !== 'string') return { ok: false, error: `${s.name} could not be read` };
      if (s.text.length > POLICY_FILE_MAX) return { ok: false, error: `${s.name} is larger than ${POLICY_FILE_MAX / 1024} KiB` };
      try {
        value = parseYaml(s.text, { maxAliasCount: 50, uniqueKeys: true, prettyErrors: false });
      } catch (e) {
        return { ok: false, error: `${s.name} is not valid YAML: ${String((e as Error)?.message ?? e).split(LINE_BREAK)[0]!.slice(0, 200)}` };
      }
    } else value = s.value;
    if (value === null || value === undefined) value = {};
    const parsed = PolicyFields.safeParse(value);
    if (!parsed.success) return { ok: false, error: `${s.name}: ${issuesOf(parsed.error)}` };
    parts.push(parsed.data);
  }

  const globs = (list: readonly string[], where: string): { ok: true; globs: string[] } | { ok: false; error: string } => {
    const out = new Set<string>();
    for (const g of list) {
      const n = normaliseGlob(g);
      if (!n.ok) return { ok: false, error: `${where}: ${n.error}` };
      out.add(n.glob);
    }
    try {
      // Compiles every glob (picomatch with `strictBrackets`): one that cannot compile throws here, not on the first packet.
      deniedPaths(['parley-policy-probe'], [...out]);
    } catch {
      return { ok: false, error: `${where}: a glob does not compile` };
    }
    return { ok: true, globs: [...out] };
  };

  const deny = globs([...FLOOR_DENY, ...parts.flatMap((p) => p.deny ?? [])], 'deny');
  if (!deny.ok) return deny;
  const reviewPaths = globs(
    parts.flatMap((p) => p.review?.paths ?? []),
    'review.paths',
  );
  if (!reviewPaths.ok) return reviewPaths;

  const builtIn = new Set(SECRET_PATTERNS.map((p) => p.name));
  const extras = new Map<string, { name: string; regex: string }>();
  for (const e of parts.flatMap((p) => p.extra_secrets ?? [])) {
    if (builtIn.has(e.name)) return { ok: false, error: `extra_secrets: "${e.name}" is a built-in pattern's name; give yours a name of its own` };
    try {
      new RegExp(e.regex);
    } catch {
      return { ok: false, error: `extra_secrets: the regex of "${e.name}" does not compile` };
    }
    const prior = extras.get(e.name);
    if (prior && prior.regex !== e.regex) return { ok: false, error: `extra_secrets: "${e.name}" is given two different regexes` };
    extras.set(e.name, e);
  }

  // The first source is the base: the runner operator's config over the defaults, which it may
  // loosen as well as tighten. Every later source (the repository's file, which whoever can merge
  // to the answering ref can change) only tightens what the base says or leaves to the defaults.
  const [base = {}, ...later] = parts;
  const d = DEFAULT_POLICY;
  const bb = base.budget ?? {};
  let secretScan = base.secret_scan ?? d.secretScan;
  let whenSecret = base.review?.when_secret ?? d.review.whenSecret;
  let timeoutMinutes = base.review?.timeout_minutes ?? d.review.timeoutMinutes;
  const budget: Record<'messages' | 'packets' | 'minutes' | 'concurrent' | 'perHour', number> & { spendUsd?: number; perDay?: number } = {
    messages: bb.messages ?? d.budget.messages,
    packets: bb.packets ?? d.budget.packets,
    minutes: bb.minutes ?? d.budget.minutes,
    concurrent: bb.concurrent ?? d.budget.concurrent,
    perHour: bb.per_hour ?? d.budget.perHour,
    ...(bb.spend_usd !== undefined ? { spendUsd: bb.spend_usd } : {}),
    ...(bb.per_day !== undefined ? { perDay: bb.per_day } : {}),
  };
  const tighter = (a: number | undefined, x: number | undefined) => (x === undefined ? a : a === undefined ? x : Math.min(a, x));
  for (const p of later) {
    if (p.secret_scan === true) secretScan = true;
    if (p.review?.when_secret === 'refuse') whenSecret = 'refuse';
    timeoutMinutes = tighter(timeoutMinutes, p.review?.timeout_minutes)!;
    const pb = p.budget ?? {};
    budget.messages = tighter(budget.messages, pb.messages)!;
    budget.packets = tighter(budget.packets, pb.packets)!;
    budget.minutes = tighter(budget.minutes, pb.minutes)!;
    budget.concurrent = tighter(budget.concurrent, pb.concurrent)!;
    budget.perHour = tighter(budget.perHour, pb.per_hour)!;
    const spend = tighter(budget.spendUsd, pb.spend_usd);
    if (spend !== undefined) budget.spendUsd = spend;
    const perDay = tighter(budget.perDay, pb.per_day);
    if (perDay !== undefined) budget.perDay = perDay;
  }
  const policy = {
    deny: deny.globs,
    secretScan,
    ...(extras.size ? { extraSecrets: [...extras.values()] } : {}),
    review: { paths: reviewPaths.globs, kinds: [...new Set(parts.flatMap((p) => p.review?.kinds ?? []))], whenSecret, timeoutMinutes },
    budget,
  };
  const checked = SeatPolicy.safeParse(policy);
  if (!checked.success) return { ok: false, error: `the merged policy: ${issuesOf(checked.error)}` };
  return { ok: true, policy: checked.data, summary: summaryOf(checked.data) };
}

/** The part of a seat's policy the relay holds for its second line (`DeclaredSeat.policy`). */
export function summaryOf(policy: SeatPolicy): PolicySummary {
  const { messages, packets, minutes, concurrent, perHour } = policy.budget;
  return PolicySummarySchema.parse({ deny: policy.deny, secretScan: policy.secretScan, budget: { messages, packets, minutes, concurrent, perHour } });
}

// ---------------------------------------------------------------- what the ledger says about a verdict

/**
 * The runner's own words for why a call was refused or held, for the ledger's `detail`: which path
 * and which glob, which field, which line, how much of a budget. Never the text that matched, and
 * never sent anywhere: the agent is told the policy's fixed sentence, the relay a rule's name.
 */
export function explainVerdict(call: OutboundCall, verdict: PolicyVerdict, ctx: { policy: SeatPolicy | null; policyError?: string | null; runner?: RunnerFacts; used?: BudgetUsed }): string | null {
  if (verdict.ok) return null;
  const slow = outOfTime.get(verdict);
  if (slow !== undefined) return `the checks did not finish within ${slow} ms, so the call was not sent (a glob, or a source full of wildcards, too costly to match)`;
  // It matches again what the check matched, under the same bound.
  const said = withinTime(EGRESS_CHECK_MS, () => explainNow(call, verdict, ctx));
  return said.ok ? said.value : null;
}

function explainNow(call: OutboundCall, verdict: Extract<PolicyVerdict, { ok: false }>, ctx: Parameters<typeof explainVerdict>[2]): string | null {
  try {
    const rule = verdict.rule;
    const policy = ctx.policy;
    const facts = ctx.runner ?? {};
    if (rule === 'policy') return ctx.policyError ? `the seat's policy could not be read: ${ctx.policyError}` : "the seat's policy could not be read";
    if (rule === 'malformed') return 'the call could not be read';
    if (rule === 'deny:partial') return 'the deny-by-content index stopped at its bounds, so the seat refuses what could quote an unread denied file';
    const out = outboundOf(call);
    const sources = [out.source, out.fields.source].filter((s): s is string => !!s);
    const named = [...new Set(sources.flatMap(pathsNamedIn))];
    const whichGlob = (globs: readonly string[]) => {
      for (const g of globs) {
        const hit = deniedPaths(named, [g], facts.repo, { nocase: facts.nocase });
        if (hit.length) return `names ${hit[0]}, which "${g}" covers`;
      }
      return null;
    };
    if (rule === 'deny' && policy) return whichGlob(policy.deny);
    if (rule === 'review:path' && policy) return whichGlob(policy.review.paths);
    if (rule === 'review:kind') return `its kind is ${out.kind ?? 'text'}`;
    if (rule === 'deny:content' && facts.deniedLines) {
      for (const [field, text] of Object.entries(out.fields)) {
        const lines = text.split(LINE_BREAK);
        for (let i = 0; i < lines.length; i++) if (deniedLineKeys(lines[i]!).some((k) => facts.deniedLines!.has(k))) return `line ${i + 1} of ${field} is a line of a denied file`;
      }
    }
    if (rule === 'secret:known') {
      for (const [field, text] of Object.entries(out.fields)) if (hasKnownSecret(text, facts.knownSecrets ?? [])) return `${field} holds a token or secret this runner keeps`;
    }
    if (rule.startsWith('secret:')) {
      const name = rule.slice('secret:'.length);
      for (const [field, text] of Object.entries(out.fields)) if (scanSecrets(text, policy?.extraSecrets).some((f) => f.name === name)) return `${field} matches ${name}`;
    }
    if (rule.startsWith('budget:') && policy && ctx.used) {
      const which = rule.slice('budget:'.length);
      const used = { packets: ctx.used.packets, messages: ctx.used.messages, minutes: ctx.used.minutes, spend: ctx.used.spendUsd ?? 0 }[which];
      const of = { packets: policy.budget.packets, messages: policy.budget.messages, minutes: policy.budget.minutes, spend: policy.budget.spendUsd }[which];
      if (used !== undefined && of !== undefined) return `used ${used} of ${of} ${which}`;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the gate the proxy calls

/** A job as the gate sees it: the ledger's names, and what its budget is counted from. */
export interface GateJob extends LedgerJob {
  startedAt?: string | null;
  /** What the job has cost so far, where the runner can count it. */
  spendUsd?: number | null;
}

/** What a job's calls are checked against: its policy (null when it failed to load, which refuses everything) and the runner's facts. */
export interface GateContext {
  policy: SeatPolicy | null;
  /** Why the policy failed to load, for the ledger. */
  policyError?: string | null;
  runner?: RunnerFacts;
}

export type GateDecision =
  | { forward: true; outboundId: number }
  | { forward: false; outboundId: number; isError: true; rule: string; text: string; exhausted: boolean }
  | { forward: false; outboundId: number; isError: false; rule: string; text: string; hold: { holdId: string; report: HeldInput } };

/** What the proxy's forwarding did: the relay took the call (and named the packet), or it did not. */
export interface ForwardResult {
  ok: boolean;
  text?: string;
  packetLabel?: string | null;
}

export type GateOutcome =
  | { forwarded: true; outboundId: number; result: ForwardResult; notes: string[] }
  | (Extract<GateDecision, { forward: false }> & { forwarded: false; notes: string[]; reported?: boolean });

/** Rules after which the seat can do nothing more in the room but finish: its time or its money is spent (`budget_spent`). */
const EXHAUSTING = new Set(['budget:minutes', 'budget:spend']);

export class EgressGate {
  private readonly egress: EgressPolicy;

  constructor(
    private readonly o: {
      ledger: OutboundLedger;
      review: ReviewQueue;
      egress?: EgressPolicy;
      /** `POST /api/runner/jobs/:id/held` with a hold's shape. Without it, `run` leaves reporting to the caller. */
      report?: (jobId: string, input: HeldInput) => Promise<void>;
    },
  ) {
    this.egress = o.egress ?? egressPolicy();
  }

  /**
   * Decide one call and record it. A refusal is answered to the agent as a tool error with the
   * policy's fixed sentence; a hold as an ordinary result saying it is held; either way nothing is
   * forwarded. Pending holds count against the packet budget, so an agent cannot fill its team's
   * review queue past what the seat may share.
   */
  check(job: GateJob, call: OutboundCall, ctx: GateContext): GateDecision {
    const { ledger, review } = this.o;
    const used = ledger.used(job.id, { startedAt: job.startedAt, spendUsd: job.spendUsd });
    let verdict = this.egress.check(call, ctx.policy as SeatPolicy, used, ctx.runner);
    const policy = SeatPolicy.safeParse(ctx.policy).success ? ctx.policy : null;
    if (!verdict.ok && verdict.action === 'hold' && policy && used.packets + review.pending({ jobId: job.id }).length >= policy.budget.packets)
      verdict = refused('budget:packets', POLICY_MESSAGES.budget('packets'));
    const known = ctx.runner?.knownSecrets ?? [];
    const detail = explainVerdict(call, verdict, { ...ctx, used });
    const partial = ctx.runner?.deniedLines?.partial && verdict.ok ? 'checked against a partial deny-by-content index' : null;
    const outboundId = ledger.record(job, call, verdict, { detail: detail ?? partial, known });
    if (verdict.ok) return { forward: true, outboundId };
    if (verdict.action === 'hold' && policy) {
      try {
        const hold = review.hold(job, call, verdict, { timeoutMinutes: policy.review.timeoutMinutes, outboundId });
        return { forward: false, outboundId, isError: false, rule: verdict.rule, text: verdict.message, hold };
      } catch {
        // A hold this runner cannot keep (a kind the room does not know) is a refusal: nothing
        // leaves on a hold that is not kept.
        verdict = refused('malformed', POLICY_MESSAGES.malformed);
        ledger.settle(outboundId, { ok: false, rule: 'malformed', detail: 'the hold could not be kept' });
      }
    }
    const rule = verdict.ok ? 'policy' : verdict.rule;
    const text = verdict.ok ? POLICY_MESSAGES.policy : verdict.message;
    return { forward: false, outboundId, isError: true, rule, text, exhausted: EXHAUSTING.has(rule) };
  }

  /** What the relay did with a forwarded call. */
  settle(outboundId: number, result: ForwardResult, ctx?: GateContext) {
    const known = ctx?.runner?.knownSecrets ?? [];
    if (result.ok) this.o.ledger.settle(outboundId, { ok: true, packetLabel: result.packetLabel ?? null }, known);
    else this.o.ledger.settle(outboundId, { ok: false, detail: result.text ?? null }, known);
  }

  /**
   * The whole round for one call: decide, forward only what passed, settle the ledger, report a
   * hold's shape. `forward` is the proxy's own function to the relay, and is never called for a
   * refused or held call. Notes the job's agent is owed (a decision on an earlier hold) come back
   * with the outcome, for the proxy to add to what it answers.
   */
  async run(job: GateJob, call: OutboundCall, ctx: GateContext, forward: () => Promise<ForwardResult>): Promise<GateOutcome> {
    const notes = () => {
      try {
        return this.o.review.takeNotes(job.id);
      } catch {
        return [];
      }
    };
    let d: GateDecision;
    try {
      d = this.check(job, call, ctx);
    } catch {
      // The gate could not decide or could not record (runner.db locked, say): nothing leaves on
      // a decision that was not made. `outboundId` -1: no ledger row could be written.
      return { forward: false, forwarded: false, outboundId: -1, isError: true, rule: 'policy', text: POLICY_MESSAGES.policy, exhausted: false, notes: [] };
    }
    if (!d.forward) {
      if (!d.isError && this.o.report) {
        let reported = true;
        try {
          await this.o.report(job.id, d.hold.report);
        } catch {
          reported = false;
        }
        return { ...d, forwarded: false, reported, notes: notes() };
      }
      return { ...d, forwarded: false, notes: notes() };
    }
    let result: ForwardResult;
    try {
      result = await forward();
    } catch (e) {
      result = { ok: false, text: (e as Error)?.message ?? 'the relay could not be reached' };
    }
    try {
      this.settle(d.outboundId, result, ctx);
    } catch {
      // The call reached the relay whatever the ledger can still write: answer what the relay
      // said, or the agent would retry a packet the room already holds.
    }
    return { forwarded: true, outboundId: d.outboundId, result, notes: notes() };
  }
}
