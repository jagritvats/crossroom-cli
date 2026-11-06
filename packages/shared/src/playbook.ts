/**
 * Playbooks: the whole YAML grammar as zod, the variables it may use, and the shapes
 * of its runs, triggers and effects as the routes and the builder carry them.
 *
 * What the grammar can never express, by construction: a step that runs code, calls a URL or calls
 * a model. `then` takes three step types (`gate`, `effect`, `chain`) and nothing else, every object
 * is strict, so an unknown key is refused rather than ignored, and effects run only on a team's
 * runner, which checks each against its own policy (`effects.allow`) before acting. The relay
 * holds no GitHub or Slack credential and posts nothing.
 *
 * Variables: trusted ones (`${trigger.number}`, `${trigger.repo}`, `${trigger.head_sha}`,
 * `${trigger.base_ref}`, `${item.<field>}`, `${run.id}`) are each validated by a pattern when a
 * trigger's event comes in (`TRUSTED_VALUE`), so they may appear in a title, a brief, a claim or a
 * seat. A pull request's branch and its author's login (`${trigger.head_ref}`, `${trigger.author}`)
 * are matched by a pattern too, but on a fork they are words a stranger chose, which a pattern
 * limits in characters and never in meaning: they may appear only in `seats[].ref`, where the
 * runner's REF check applies, and as `packets[].from`, fenced. Untrusted ones (a pull request's
 * title and body, a manual input) may appear only as `packets[].from`, where they reach the room as
 * a fenced owner packet, never in the brief. Only those five template fields take variables at all:
 * a `${` anywhere else is refused, since every other field is used as written.
 *
 * Seats: each `room.seats[]` names a standing seat (`seat`), the ref it reads at (`ref`), and
 * optionally what it is in the room for (`role`: one line, at most `ROLE_MAX`, used as written) and
 * whether it leads the room (`lead`, one seat at most). A team's standing seat seated with no role
 * takes its team's own description as its role, marked as the team's words.
 *
 * What the grammar cannot see alone, the server's engine enforces:
 * how deep chains go (`CHAIN_DEPTH_MAX`), how many rooms a run and its chains open
 * (`ROOMS_PER_RUN_MAX`), how many runs a playbook starts in an hour (`RUNS_PER_PLAYBOOK_PER_HOUR`),
 * and webhooks' order of checks. The grammar refuses the loops one file shows: a playbook that
 * chains to itself, and a `room_end` trigger naming its own playbook.
 *
 * Pure: zod and nothing from Node. `parsePlaybook` reads YAML with `yaml`; the web app imports
 * from here with `import type` only, and the builder parses through the server's dry run.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ClaimStatus } from './index.js';
import { parseFactQuery } from './record.js';
import { LINE_BREAK, ROLE_MAX, ROOM_SEATS_LIMIT, SUBROOM_MODES } from './text.js';

// ---------------------------------------------------------------- names and limits

export const PLAYBOOK_NAME = /^[a-z0-9-]{1,40}$/;
/** Fan-out's hard cap, whatever a playbook asks. */
export const FAN_OUT_MAX = 20;
export const FAN_OUT_DEFAULT = 10;
/**
 * Seats in a playbook's room: at least two, and up to one per seat letter (`ROOM_SEATS_LIMIT`) in the
 * grammar; a run is held to the instance's own cap as the create route is (`seatLimitRefusal`). An incident room past two still needs the `incidentSeats` flag.
 */
export const PLAYBOOK_SEATS = 2;
export const INCIDENT_SEATS_MAX = 6;
/** The shortest interval a schedule may fire at. */
export const SCHEDULE_MIN_MINUTES = 15;
/** Claims a playbook's room may register, like an ask's (`OWNER_CLAIMS_MAX`). */
export const PLAYBOOK_CLAIMS_MAX = 10;
export const PLAYBOOK_PACKETS_MAX = 10;
export const PLAYBOOK_STEPS_MAX = 10;
/** A webhook's deliveries per trigger per minute, inside the app. */
export const WEBHOOK_PER_MINUTE = 60;
/** How far a generic webhook's `t=` may be from now. */
export const WEBHOOK_TOLERANCE_S = 300;
/** The generic webhook's signature header: `t=<unix>,v1=<hex HMAC-SHA256(secret, t + '.' + body)>`. */
export const GENERIC_SIGNATURE_HEADER = 'x-parley-signature';
/**
 * The one 404 body of `POST /api/hooks/:triggerId` for an unknown trigger, a disabled playbook and
 * a bad signature alike, so a stranger cannot tell which trigger ids exist.
 */
export const HOOK_GONE = 'no such hook';

// ---------------------------------------------------------------- variables

/** `${a.b}` in a template. Names are lowercase words joined by dots. */
export const VARIABLE = /\$\{([a-z_]+(?:\.[a-z_]+)*)\}/g;
/** Trusted variables, validated on intake, usable anywhere a template is. `item.*` is any field of a fan-out item. */
export const TRUSTED_VARIABLES = ['trigger.number', 'trigger.repo', 'trigger.head_sha', 'trigger.base_ref', 'run.id'] as const;
/**
 * A pull request's branch and its author's login: matched by `TRUSTED_VALUE` on intake, but chosen
 * by whoever opened the pull request, a stranger on a fork (`owner-says/support-claim-1` is a valid
 * branch name). Usable only in `seats[].ref`, where the runner checks a ref before it checks one
 * out, and as `packets[].from`, fenced. Never in a title, a brief, a claim or a seat's name.
 */
export const REF_ONLY_VARIABLES = ['trigger.head_ref', 'trigger.author'] as const;
/** Untrusted fields, usable only as `packets[].from`: `trigger.title`, `trigger.body`, and `input.<name>` of a manual trigger. */
export const UNTRUSTED_FIELDS = ['trigger.title', 'trigger.body'] as const;

/** The pattern each value a trigger's event carries must match when it comes in; a value that does not is refused, never escaped. */
export const TRUSTED_VALUE: Readonly<Record<(typeof TRUSTED_VARIABLES)[number] | (typeof REF_ONLY_VARIABLES)[number] | 'item', RegExp>> = {
  'trigger.number': /^[0-9]{1,10}$/,
  'trigger.repo': /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/,
  'trigger.head_sha': /^[0-9a-f]{7,64}$/,
  'trigger.head_ref': /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/,
  'trigger.base_ref': /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/,
  'trigger.author': /^[A-Za-z0-9-]{1,39}(\[bot\])?$/,
  'run.id': /^run_[A-Za-z0-9_-]{22}$/,
  item: /^[A-Za-z0-9._:/-]{1,80}$/,
};

/** Whether a variable may appear in a trusted place (a title, a brief, a claim, a seat's name). */
export const isTrustedVariable = (name: string) => (TRUSTED_VARIABLES as readonly string[]).includes(name) || /^item\.[a-z_]+$/.test(name);
/** Whether a variable may appear in `seats[].ref`: a trusted one, or a pull request's branch or author (`REF_ONLY_VARIABLES`). */
export const isRefVariable = (name: string) => isTrustedVariable(name) || (REF_ONLY_VARIABLES as readonly string[]).includes(name);

/** The variables a template uses, in order. */
export function variablesIn(template: string): string[] {
  return [...template.matchAll(VARIABLE)].map((m) => m[1]!);
}

// ---------------------------------------------------------------- the grammar

const Template = (max: number) => z.string().min(1).max(max);
/**
 * A seat's role (`room.seats[].role`): one line the playbook's author wrote for what the seat is in
 * the room for, at most `ROLE_MAX`. Used as written (no variables), printed to every seat.
 */
const Role = z
  .string()
  .min(1)
  .max(ROLE_MAX)
  .refine((r) => !LINE_BREAK.test(r), 'a role is one line');
const Verdict = z.enum(['pass', 'fail', 'neutral']);
export type Verdict = z.infer<typeof Verdict>;
const Glob = z.string().min(1).max(200);
/** A claim, by its 1-based index in `room.claims`: claims are sealed, so a playbook names them by number. */
const ClaimRef = z.number().int().min(1).max(PLAYBOOK_CLAIMS_MAX);

/** The five fields' ranges, as cron reads them: day of the week 0 to 7, both 0 and 7 Sunday. */
const CRON_FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const;
/** The most days each month ever has (February's leap day included), for "a date that never occurs". */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * The values one field names, or null when it is not in the subset: a list of `*`, a number, a
 * range `a-b` with a ≤ b, each optionally with a step `/n` (n ≥ 1; `a/n` is `a-<max>/n`), every
 * number inside the field's range. A step of 0 would loop an evaluator forever, and a reversed
 * range names nothing.
 */
function cronValues(text: string, f: { min: number; max: number }): Set<number> | null {
  if (!text || text.length > 40) return null;
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(?:(\*)|([0-9]{1,2})(?:-([0-9]{1,2}))?)(?:\/([0-9]{1,2}))?$/.exec(part);
    if (!m) return null;
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    const lo = m[1] ? f.min : Number(m[2]);
    const hi = m[1] ? f.max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? f.max : lo;
    if (step < 1 || lo < f.min || hi > f.max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * Whether a 5-field cron expression is in the subset a schedule may use, and can never fire twice
 * within `SCHEDULE_MIN_MINUTES`:
 * - its minute field is one number, a list of numbers at least that far apart (around the hour
 *   too), or `*\/n` with n at least that and dividing 60. Anything else (a range, a bare `*`) is
 *   refused;
 * - every field is a list of `*`, numbers, ranges and steps inside its range (`cronValues`): no
 *   step of 0, no reversed range, no names;
 * - it names a date that occurs: with the day of the month restricted and the day of the week `*`,
 *   some month it names has one of those days (never only the 30th or 31st of February). When both
 *   are restricted, cron fires on a day matching either, so a weekday always comes round.
 * The server's scheduler evaluates it in its time zone. What is wrong
 * with one it refuses is `cronProblem`'s answer.
 */
export function cronIsSparse(expr: string): boolean {
  return cronProblem(expr) === null;
}

/** What `cronProblem` answers, one sentence for each way a cron is refused. */
export const CRON_PROBLEMS = {
  shape: 'a cron is five fields (minute hour day-of-month month day-of-week) of numbers, ranges, * and steps of at least 1, each inside its field',
  never: 'this schedule never fires: no month it names has that day',
  dense: `a schedule may fire at most every ${SCHEDULE_MIN_MINUTES} minutes`,
} as const;

/**
 * Why `cronIsSparse` refuses a cron, in words its author can act on (`CRON_PROBLEMS`), or null when
 * it takes it: not five fields of the subset, a date that never occurs, or a minute field that could
 * fire more often than every `SCHEDULE_MIN_MINUTES`. The grammar and the server's scheduler
 * both say this, so a save never calls a date that never occurs too frequent.
 */
export function cronProblem(expr: string): string | null {
  if (typeof expr !== 'string') return CRON_PROBLEMS.shape;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every((f) => /^[0-9*/,-]{1,40}$/.test(f))) return CRON_PROBLEMS.shape;
  const values = fields.map((f, i) => cronValues(f, CRON_FIELDS[i]!));
  if (values.some((v) => v === null || v.size === 0)) return CRON_PROBLEMS.shape;
  const [, , dom, month] = values as Set<number>[];
  if (!fields[2]!.startsWith('*') && fields[4]!.startsWith('*') && ![...month!].some((mo) => [...dom!].some((d) => d <= MONTH_DAYS[mo - 1]!)))
    return CRON_PROBLEMS.never;
  const minute = fields[0]!;
  const step = /^\*\/([0-9]{1,2})$/.exec(minute);
  if (step) {
    const n = Number(step[1]);
    return n >= SCHEDULE_MIN_MINUTES && n < 60 && 60 % n === 0 ? null : CRON_PROBLEMS.dense;
  }
  if (!/^[0-9]{1,2}(,[0-9]{1,2})*$/.test(minute)) return CRON_PROBLEMS.dense;
  const ms = [...new Set(minute.split(',').map(Number))].sort((a, b) => a - b);
  if (ms.some((m) => m > 59)) return CRON_PROBLEMS.shape;
  if (ms.length === 1) return null;
  for (let i = 0; i < ms.length; i++) {
    const next = i + 1 < ms.length ? ms[i + 1]! : ms[0]! + 60;
    if (next - ms[i]! < SCHEDULE_MIN_MINUTES) return CRON_PROBLEMS.dense;
  }
  return null;
}

const WebhookOn = z
  .object({
    provider: z.enum(['github', 'generic']),
    events: z.array(z.string().regex(/^[a-z_]{1,40}$/)).min(1).max(10),
    actions: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(20).optional(),
    filter: z
      .object({ repo: z.string().regex(TRUSTED_VALUE['trigger.repo']).optional(), base: z.string().max(200).optional(), paths: z.array(Glob).max(20).optional() })
      .strict()
      .optional(),
  })
  .strict();
const ScheduleOn = z
  .object({
    cron: z.string().superRefine((cron, ctx) => {
      const problem = cronProblem(cron);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
    timezone: z
      .string()
      .regex(/^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/, 'an IANA time zone, such as Europe/London')
      .default('UTC'),
  })
  .strict();
const RunnerOn = z
  .object({
    event: z.enum(['github.pull_request', 'slack.command', 'slack.mention']),
    repo: z.string().regex(TRUSTED_VALUE['trigger.repo']).optional(),
    paths: z.array(Glob).max(20).optional(),
    command: z.string().regex(/^\/[a-z0-9-]{1,32}$/).optional(),
  })
  .strict();
const RoomEndOn = z
  .object({
    project: z.string().min(1).max(80),
    playbook: z.string().regex(PLAYBOOK_NAME).optional(),
    claim_status: z.array(ClaimStatus).max(4).optional(),
  })
  .strict();
const ManualInput = z
  .object({ type: z.enum(['string', 'number', 'boolean']), max: z.number().int().min(1).max(20_000).optional(), required: z.boolean().default(false) })
  .strict();
const ManualOn = z.object({ inputs: z.record(z.string().regex(/^[a-z_]{1,32}$/), ManualInput).default({}) }).strict();

/** `on:` names exactly one trigger. */
export const PlaybookOn = z.union([
  z.object({ webhook: WebhookOn }).strict(),
  z.object({ schedule: ScheduleOn }).strict(),
  z.object({ runner: RunnerOn }).strict(),
  z.object({ room_end: RoomEndOn }).strict(),
  z.object({ manual: ManualOn }).strict(),
]);
export type PlaybookOn = z.infer<typeof PlaybookOn>;

const FanOut = z
  .object({
    over: z.enum(['consumers', 'seats', 'list']),
    items: z
      .array(z.object({ name: z.string().regex(TRUSTED_VALUE.item), seat: z.string().regex(TRUSTED_VALUE.item) }).strict())
      .max(FAN_OUT_MAX)
      .optional(),
    max: z.number().int().min(1).max(FAN_OUT_MAX).default(FAN_OUT_DEFAULT),
  })
  .strict();

/**
 * A packet the room opens with, as the owner's (fenced): a field of the trigger a stranger may have
 * chosen (a pull request's title, body, branch or author), a manual input, or facts from the record.
 */
const Packet = z.union([
  z
    .object({
      from: z.string().regex(/^(trigger\.(title|body|head_ref|author)|input\.[a-z_]{1,32})$/, 'trigger.title, trigger.body, trigger.head_ref, trigger.author or input.<name>'),
    })
    .strict(),
  z
    .object({
      facts: z
        .object({
          // Refused here as the search would refuse it (`FactQuery.refused`), so a playbook never
          // opens a room whose facts packet is either an error or, searched without the term, the
          // project's newest facts instead of the ones it asked for.
          query: z
            .string()
            .max(500)
            .superRefine((q, ctx) => {
              const refused = parseFactQuery(q).refused;
              if (refused) ctx.addIssue({ code: 'custom', message: refused });
            }),
          max: z.number().int().min(1).max(5).default(5),
        })
        .strict(),
    })
    .strict(),
]);

const Room = z
  .object({
    title: Template(200),
    template: z.enum(['incident']).optional(),
    seats: z
      .array(z.object({ seat: Template(120), ref: Template(200).optional(), role: Role.optional(), lead: z.literal(true).optional() }).strict())
      .min(PLAYBOOK_SEATS)
      .max(ROOM_SEATS_LIMIT),
    // The room's optional tools, as the create route takes them (`CreateSessionInput`).
    board: z.boolean().optional(),
    typed_tools: z.boolean().optional(),
    subrooms: z.enum(SUBROOM_MODES).optional(),
    brief: Template(20_000),
    claims: z.array(Template(500)).max(PLAYBOOK_CLAIMS_MAX).default([]),
    packets: z.array(Packet).max(PLAYBOOK_PACKETS_MAX).default([]),
    budget: z.object({ messages: z.number().int().min(2).max(500).optional(), minutes: z.number().int().min(1).max(1440).optional() }).strict().optional(),
  })
  .strict();

const Wait = z
  .object({
    until: z.union([z.literal('ended'), z.object({ claim: ClaimRef, status: z.array(ClaimStatus).min(1).max(4) }).strict()]),
    timeout_minutes: z.number().int().min(1).max(1440).default(30),
  })
  .strict();

const Outcome = z.object({ claim: ClaimRef, status: ClaimStatus }).strict();
const Result = z.object({ fail: Outcome.optional(), pass: Outcome.optional(), else: z.literal('neutral').default('neutral') }).strict();

/** What an effect may be: each one posted by a team's runner under its policy's `effects.allow`, never by the relay. */
export const EffectKind = z.enum(['pr_comment', 'check_run', 'issue', 'slack_reply', 'linear_note', 'jira_note', 'pagerduty_note']);
export type EffectKind = z.infer<typeof EffectKind>;

const GateStep = z
  .object({
    who: z.union([z.enum(['owner', 'project']), z.string().regex(/^team:[A-Za-z0-9_-]{1,64}$/)]),
    when: z.array(Verdict).min(1).max(3),
    timeout_hours: z.number().int().min(1).max(168).default(24),
    on_timeout: z.enum(['skip', 'fail', 'pass']).default('skip'),
  })
  .strict();
const EffectStep = z
  .object({
    kind: EffectKind,
    runner: z.string().min(1).max(64),
    body: z.enum(['digest', 'verdict_line']).default('verdict_line'),
    when: z.array(Verdict).min(1).max(3),
  })
  .strict();
const ChainStep = z
  .object({
    playbook: z.string().regex(PLAYBOOK_NAME),
    when: z.array(Verdict).min(1).max(3),
    with: z.object({ facts: z.literal('from_run').optional() }).strict().optional(),
  })
  .strict();
/** The three step types. There is no other, and there will be none that runs code, calls a URL or calls a model. */
export const PlaybookStep = z.union([
  z.object({ gate: GateStep }).strict(),
  z.object({ effect: EffectStep }).strict(),
  z.object({ chain: ChainStep }).strict(),
]);
export type PlaybookStep = z.infer<typeof PlaybookStep>;

/** A playbook, as its YAML is read (`parsePlaybook`). */
export const PlaybookSpec = z
  .object({
    name: z.string().regex(PLAYBOOK_NAME),
    version: z.literal(1),
    description: z.string().max(500).optional(),
    on: PlaybookOn,
    fan_out: FanOut.optional(),
    room: Room,
    wait: Wait.optional(),
    result: Result.optional(),
    then: z.array(PlaybookStep).max(PLAYBOOK_STEPS_MAX).default([]),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    // Variables: trusted only, wherever a template is; a pull request's branch and author only in a
    // seat's ref. Untrusted text reaches a room only as `packets[].from`.
    type Template = { path: (string | number)[]; text: string; ref: boolean };
    const templates: Template[] = [
      { path: ['room', 'title'], text: spec.room.title, ref: false },
      { path: ['room', 'brief'], text: spec.room.brief, ref: false },
      ...spec.room.claims.map((c, i): Template => ({ path: ['room', 'claims', i], text: c, ref: false })),
      ...spec.room.seats.flatMap((s, i): Template[] => [
        { path: ['room', 'seats', i, 'seat'], text: s.seat, ref: false },
        ...(s.ref ? [{ path: ['room', 'seats', i, 'ref'], text: s.ref, ref: true }] : []),
      ]),
    ];
    for (const { path, text, ref } of templates) {
      for (const v of variablesIn(text)) {
        if (ref ? !isRefVariable(v) : !isTrustedVariable(v))
          issue(
            path,
            (REF_ONLY_VARIABLES as readonly string[]).includes(v)
              ? `\${${v}} is a name a stranger chose (a fork's branch, its author's login): use it only in seats[].ref, or as packets[].from, where it arrives fenced`
              : (UNTRUSTED_FIELDS as readonly string[]).includes(v) || v.startsWith('input.')
                ? `\${${v}} is text a stranger chose: use it only as packets[].from, where it arrives fenced`
                : `\${${v}} is not a variable a playbook has`,
          );
        if (v.startsWith('item.') && !spec.fan_out) issue(path, `\${${v}} needs fan_out`);
      }
      // A `$` that is not a well-formed variable is refused, so a typo never reaches a room as text.
      if (text.replace(VARIABLE, '').includes('${')) issue(path, 'a ${ with no well-formed variable after it');
    }
    // Every other string is used as written (a facts query, a runner's name, a filter, the
    // description): a `${` there, well formed or not, would be substituted by nobody or by someone
    // guessing, so it is refused wherever it is.
    const templated = new Set(templates.map((t) => t.path.join('.')));
    const walk = (v: unknown, path: (string | number)[]): void => {
      if (typeof v === 'string') {
        if (v.includes('${') && !templated.has(path.join('.')))
          issue(path, 'only room.title, room.brief, room.claims, room.seats[].seat and room.seats[].ref take variables; this field is used as written');
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
    };
    walk(spec, []);
    // Loops one file shows: a chain back to itself, and a room_end trigger that its own rooms'
    // ends would fire. Longer ones, and chains through other playbooks, are the engine's
    // (its limits on chain depth, rooms per run and runs per playbook an hour).
    spec.then.forEach((step, i) => {
      if ('chain' in step && step.chain.playbook === spec.name)
        issue(['then', i, 'chain', 'playbook'], 'a playbook may not chain to itself: every run would start another');
    });
    if ('room_end' in spec.on && spec.on.room_end.playbook === spec.name)
      issue(['on', 'room_end', 'playbook'], 'a room_end trigger may not name its own playbook: the end of every room it opens would start it again');
    // Seats: two to six, the schema's bounds. An incident room past two is the engine's to refuse
    // while the incidentSeats flag is off (`seatLimitRefusal`), since a flag can change after a save.
    // A room has one lead at most, as the create route holds it.
    if (spec.room.seats.filter((s) => s.lead).length > 1) issue(['room', 'seats'], 'a room has at most one lead seat');
    // Claims are referenced by index, and must exist.
    const claims = spec.room.claims.length;
    const refs: [(string | number)[], number][] = [];
    if (spec.wait && typeof spec.wait.until === 'object') refs.push([['wait', 'until', 'claim'], spec.wait.until.claim]);
    if (spec.result?.fail) refs.push([['result', 'fail', 'claim'], spec.result.fail.claim]);
    if (spec.result?.pass) refs.push([['result', 'pass', 'claim'], spec.result.pass.claim]);
    for (const [path, n] of refs) if (n > claims) issue(path, `claim ${n} is not one of the room's ${claims} claim(s)`);
    // A list fan-out names its items; the others take theirs from the trigger.
    if (spec.fan_out?.over === 'list' && !spec.fan_out.items?.length) issue(['fan_out', 'items'], 'over: list needs items');
    // Manual inputs used as packets must be declared.
    const inputs = 'manual' in spec.on ? Object.keys(spec.on.manual.inputs) : [];
    spec.room.packets.forEach((p, i) => {
      if ('from' in p && p.from.startsWith('input.') && !inputs.includes(p.from.slice(6)))
        issue(['room', 'packets', i, 'from'], `${p.from} is not one of the manual trigger's inputs`);
      if ('from' in p && p.from.startsWith('trigger.') && !('webhook' in spec.on || 'runner' in spec.on))
        issue(['room', 'packets', i, 'from'], `${p.from} comes from a webhook or runner trigger`);
    });
  });
export type PlaybookSpec = z.infer<typeof PlaybookSpec>;

export type ParsedPlaybook = { ok: true; spec: PlaybookSpec } | { ok: false; errors: string[] };

/** Read a playbook's YAML and check it against the grammar. Never throws: every problem is one line in `errors`. */
export function parsePlaybook(source: string): ParsedPlaybook {
  if (source.length > 64 * 1024) return { ok: false, errors: ['a playbook is at most 64 KiB'] };
  let doc: unknown;
  try {
    doc = parseYaml(source, { maxAliasCount: 0 });
  } catch (e) {
    return { ok: false, errors: [`not YAML: ${(e as Error).message.split('\n')[0]}`] };
  }
  const r = PlaybookSpec.safeParse(doc);
  if (r.success) return { ok: true, spec: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`) };
}

// ---------------------------------------------------------------- runs, triggers and effects

export const TriggerKind = z.enum(['webhook', 'schedule', 'runner', 'room_end', 'manual']);
export type TriggerKind = z.infer<typeof TriggerKind>;
export const RunState = z.enum(['queued', 'running', 'waiting', 'gated', 'done', 'failed', 'cancelled']);
export type RunState = z.infer<typeof RunState>;
export const StepState = z.enum(['queued', 'running', 'waiting', 'done', 'skipped', 'failed']);
export type StepState = z.infer<typeof StepState>;
export const EffectState = z.enum(['queued', 'leased', 'posted', 'refused', 'failed', 'cancelled']);
export type EffectState = z.infer<typeof EffectState>;

/** A Slack channel's id, and a message's timestamp that names its thread: what a `slack_reply` effect answers in. */
export const SLACK_CHANNEL = /^[CGD][A-Z0-9]{8,20}$/;
export const SLACK_THREAD = /^[0-9]{9,11}\.[0-9]{6}$/;
/** What a `linear_note`, `jira_note` and `pagerduty_note` effect is addressed by: a Linear issue (`ENG-123`), a Jira issue (`PAY-42`), a PagerDuty incident (`PT4KHLK`). */
export const LINEAR_ISSUE = /^[A-Z][A-Z0-9]{0,9}-[0-9]{1,9}$/;
export const JIRA_ISSUE = /^[A-Z][A-Z0-9_]{1,9}-[0-9]{1,9}$/;
export const PAGERDUTY_INCIDENT = /^[A-Z0-9]{6,20}$/;

/** The fields a trigger's event is reduced to on intake. Nothing else is kept, and never the raw payload. */
export interface TriggerFields {
  number?: string;
  repo?: string;
  head_sha?: string;
  head_ref?: string;
  base_ref?: string;
  author?: string;
  /** Untrusted: fenced, and only ever a packet. */
  title?: string;
  body?: string;
  /** A manual trigger's inputs, untrusted. */
  inputs?: Record<string, string | number | boolean>;
  /**
   * Where a runner's Slack command or mention is answered (a `slack_reply` effect's target):
   * ids Slack assigned, kept only when each matches `SLACK_CHANNEL` and `SLACK_THREAD`. Never a
   * variable: it names where an effect goes, and is never text in a room.
   */
  slack?: { channel: string; thread?: string };
  /**
   * The issue or incident a vendor note answers on (a `linear_note`, `jira_note` or
   * `pagerduty_note` effect's target), as an alerting system's or an issue tracker's webhook
   * carries it: kept only when it matches `LINEAR_ISSUE`, `JIRA_ISSUE` or `PAGERDUTY_INCIDENT`.
   * Never a variable, like `slack`.
   */
  linear_issue?: string;
  jira_issue?: string;
  pagerduty_incident?: string;
}

/** `PUT /api/projects/:p/playbooks/:n` (a project editor): the YAML, kept verbatim so comments survive. */
export const SavePlaybookInput = z.object({ yaml: z.string().min(1).max(64 * 1024), enabled: z.boolean().optional() }).strict();
export type SavePlaybookInput = z.infer<typeof SavePlaybookInput>;
export interface PlaybookView {
  id: string;
  name: string;
  version: number;
  enabled: boolean;
  source: 'builder' | 'repo';
  updatedBy: string;
  updatedAt: string;
  /** The YAML as saved, for a reader of the project. */
  yaml: string;
  /** Webhook triggers: the URL to register; the secret is shown once, on the save that made it. */
  hooks: Array<{ triggerId: string; url: string; secret?: string }>;
}
/** `POST /api/projects/:p/playbooks/:n/dry-run`: what a run would do for an event, writing nothing (row counts prove it). */
export const DryRunInput = z.object({ fields: z.record(z.string(), z.unknown()).default({}), yaml: z.string().max(64 * 1024).optional() }).strict();
export type DryRunInput = z.infer<typeof DryRunInput>;
export interface DryRunResult {
  ok: boolean;
  errors: string[];
  rooms: Array<{ item: number; title: string; seats: string[]; claims: string[]; packets: number }>;
  gates: Array<{ who: string; when: Verdict[] }>;
  effects: Array<{ kind: EffectKind; runner: string; when: Verdict[] }>;
}
/** `POST /api/projects/:p/playbooks/:n/run` (a project editor): a manual trigger's inputs. Opens rooms, so under the edge's create limit. */
export const ManualRunInput = z.object({ inputs: z.record(z.string(), z.union([z.string().max(20_000), z.number(), z.boolean()])).default({}) }).strict();
export type ManualRunInput = z.infer<typeof ManualRunInput>;
export interface RunView {
  id: string;
  playbook: string;
  version: number;
  state: RunState;
  dryRun: boolean;
  startedAt: string;
  endedAt: string | null;
  result: Verdict | null;
  rooms: string[];
}

/**
 * The builder's one answer, 404, for a playbook its project does not hold (`GET`, `PUT`, `DELETE`
 * and the dry run of `/api/projects/:p/playbooks/:n`), by which the page knows to open a new one.
 */
export const PLAYBOOK_GONE = 'no such playbook in this project';

// ---------------------------------------------------------------- a playbook's runs

/** A run's id: `run_` and 22 characters of base64url. */
export const RUN_ID = /^run_[A-Za-z0-9_-]{22}$/;
/**
 * The one answer, 404, of `/api/projects/:p/playbooks/:n/runs/:r` and its cancel and retry, for a
 * run that playbook does not hold: no such run, or another playbook's, alike.
 */
export const RUN_GONE = 'no such run of this playbook';
/** `GET /api/projects/:p/playbooks/:n/runs` (a reader): the playbook's runs, newest first. */
export interface RunsResult {
  runs: RunView[];
}
/**
 * Why a playbook room's seat was left open rather than dispatched to a team's standing seat
 * by the relay: no grant for the project, more than one granted seat with the label,
 * the seat or its team paused, a runner with no X25519 key, a runner too old to take a grant, the
 * seat at its live-room limit, or an end-to-end project (which dispatch does not seat).
 */
export const SeatOpenCode = z.enum(['ungranted', 'ambiguous', 'paused', 'runner_unready', 'runner_outdated', 'busy', 'e2ee_project']);
export type SeatOpenCode = z.infer<typeof SeatOpenCode>;
/** One seat of a run's room, as the runs view shows its dispatch: ids and codes, never what the seat said. */
export interface RunSeatView {
  slot: number;
  /** The plan's seat label (`seats[].seat`). */
  seat: string;
  /**
   * `open`: left for a person to fill, with `code` saying why when dispatch looked at it; `queued`,
   * `leased`, `running`, `done`, `failed`, `refused`, `cancelled`: the standing seat's start job, as
   * the relay holds it (`runner_jobs.state`), with the runner's reason code in `code`.
   */
  dispatch: 'open' | 'queued' | 'leased' | 'running' | 'done' | 'failed' | 'refused' | 'cancelled';
  code: string | null;
  /** The team whose standing seat took it, by id; null for an open seat. */
  teamId: string | null;
}
/** One step of a run's item. */
export interface RunStepView {
  idx: number;
  /** `room | wait | gate | effect | chain`. */
  kind: string;
  state: StepState;
  /** A code Crossroom chose (`opened`, a verdict, `approved`, `room_gone`), never a sentence. */
  result: string | null;
  startedAt: string | null;
  endedAt: string | null;
  dueAt: string | null;
  /** A gate waiting, and on whom, as the caller sees it (as `PendingGateView.waitsOn`); null otherwise. */
  waitsOn: 'you' | 'your_team' | 'someone_else' | null;
  /** A waiting gate's reference (`GATE_REF`), for its text and its decision; null otherwise. */
  gate: string | null;
  /** The worker gave up on this step's job (it ran out of attempts): a retry may take it up again. */
  dead: boolean;
}
/** An effect a run asked for, as the effects home holds it: its kind, state and result code, never its text. */
export interface RunEffectView {
  idx: number;
  item: number;
  kind: EffectKind;
  state: EffectState;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}
/** One fan-out item of a run: its room (null until made, or once deleted), its seats and its steps. */
export interface RunItemView {
  item: number;
  sessionId: string | null;
  seats: RunSeatView[];
  steps: RunStepView[];
}
/** `GET /api/projects/:p/playbooks/:n/runs/:r` (a reader): one run, every item and step. */
export interface RunDetailView extends RunView {
  trigger: TriggerKind;
  items: RunItemView[];
  effects: RunEffectView[];
  /** Whether the caller may cancel it, or retry a step of it (an editor of the project). */
  canEdit: boolean;
}
/**
 * `POST /api/projects/:p/playbooks/:n/runs/:r/retry` (an editor): take up again a step whose job
 * died, in a failed run. Rooms again, so under the edge's create limit.
 */
export const RetryStepInput = z
  .object({ idx: z.number().int().min(0).max(99), item: z.number().int().min(0).max(FAN_OUT_MAX - 1) })
  .strict();
export type RetryStepInput = z.infer<typeof RetryStepInput>;
export interface RunActionResult {
  ok: true;
  run: RunView;
}

/** A gate step's reference: `<run>:<step>:<item>`, what the inbox's `gate` item names and a decision's path takes. */
export const GATE_REF = /^run_[A-Za-z0-9_-]{22}:[0-9]{1,2}:[0-9]{1,2}$/;
/** The one answer, 404, for a gate that does not wait on the caller now, whatever the reason. */
export const GATE_GONE = 'no such gate waiting on you';
/** What the person a gate waits on decides: its next step goes ahead, or its item stops there. */
export const GateDecision = z.enum(['approved', 'rejected']);
export type GateDecision = z.infer<typeof GateDecision>;
/**
 * `POST /api/projects/:p/gates/:g` (whoever the gate waits on): approve or refuse a gate that waits.
 * `digest` is the `GatePayloadView.digest` the person read: optional here, required by the route for
 * a gate that guards effects, and refused with 409 `GATE_PAYLOAD_CHANGED` when it is not the gate's
 * payload now.
 */
export const GateDecisionInput = z
  .object({
    decision: GateDecision,
    digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export type GateDecisionInput = z.infer<typeof GateDecisionInput>;
/** The 409 of a decision whose `digest` is not the gate's payload now: read it again, then decide. */
export const GATE_PAYLOAD_CHANGED = 'what this gate guards changed since you read it; read it again before deciding';
/** One effect a gate guards, as it was rendered when the gate opened: exactly what an approval lets the runner post. */
export interface GatePayloadEffect {
  /** The effect's step in the item. */
  idx: number;
  kind: EffectKind;
  /** Where it posts, as the effect's target names it (a repository and number, a channel): never a URL. */
  target: Record<string, string | number>;
  verdict: Verdict;
  title: string;
  /** The body, exactly as it would be posted. Agents' words, through the digest's `inline` and `quote`. */
  text: string;
  /** `effectDigest` of the above (runner/effects/wire.ts). */
  digest: string;
}
/**
 * `GET /api/projects/:p/gates/:g` (whoever the gate waits on; each read audited): the gate and what
 * it guards. `effects` is empty, and `digest` null, for a gate that guards none, whose decision then
 * names no digest. `unrenderable` says why a gate that guards effects shows none: `e2ee`, a room this
 * server cannot read.
 */
export interface GatePayloadView {
  gate: PendingGateView;
  effects: GatePayloadEffect[];
  digest: string | null;
  /** Times an approval of this gate lapsed because what it guards changed before posting. */
  lapses: number;
  unrenderable: 'e2ee' | null;
}
export interface GateDecisionResult {
  ok: true;
  decision: GateDecision;
}
/**
 * A gate that waits for a person, as `GET /api/projects/:p/gates` lists it: pointers and times,
 * never anything the run started with. A reader of the project sees every gate its playbooks wait
 * at, with its room; any other member of the organisation only the gates that wait on it.
 */
export interface PendingGateView {
  ref: string;
  runId: string;
  /** Its playbook's name. */
  playbook: string;
  startedAt: string;
  /** When it stops waiting, and its playbook's `on_timeout` applies. */
  dueAt: string | null;
  /** The verdict it asks about. */
  verdict: Verdict | null;
  /** The room it follows, for a reader of the project; null for anyone else. */
  sessionId: string | null;
  /** Who it waits on, as the caller sees it. */
  waitsOn: 'you' | 'your_team' | 'someone_else';
  /** Whether the caller may approve or refuse it. */
  mine: boolean;
}
export interface PendingGatesResult {
  gates: PendingGateView[];
}

/** `session_created.payload.playbook`: which run made the room. Sealed; `publicEvent` strips it. */
export interface PlaybookOrigin {
  runId: string;
  name: string;
}
