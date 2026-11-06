/**
 * `.parley/policy.yml`, version 1: a standing seat's policy as its team writes it in
 * the repository the seat answers from, read on the runner, and never from a pull request's head.
 *
 * ```yaml
 * version: 1
 * seat: payments-api
 * runtime: { cli: claude, model: sonnet, unconfined_reads: false, isolation: none }
 * checkout: { mode: worktree, ref: origin/main, allowed_refs: ["refs/pull/*\/head"] }
 * never_share: ["**\/.env*", "secrets/**", "config/prod/**"]
 * secret_scan: { enabled: true, extra_patterns: [{ name: acme-key, regex: "ACME-[A-Z0-9]{32}" }], allow_paths: ["test/fixtures/keys/**"] }
 * review: { paths: ["config/**"], kinds: [log], when_secret: hold, reviewers: team, timeout_minutes: 120 }
 * budget: { messages: 30, packets: 12, minutes: 20, spend_usd: 2.00, concurrent: 3, per_hour: 10, per_day: 50 }
 * may_ask: { ask_links: true, projects: [checkout-v2], teams: [orders], orgs: [] }
 * offers: [{ name: run_tests, description: "npm test, read-only sandbox", allow: "Bash(npm test:*)" }]
 * brief_file: .parley/seat-brief.md
 * effects: { allow: [{ kind: pr_comment, repos: [acme/payments-api] }] }
 * ledger: { keep_bodies: true, report: counts }   # none | counts | entries (paths, never bodies)
 * ```
 *
 * **Where it is read.** From the repository's default branch, never from the commit a job answers
 * from. A job may answer from a pull request's head (`checkout.allowed_refs`), and whoever opens a
 * pull request can change every file on it, this one included: read there, a line deleted from
 * `never_share` on the branch would be a deny list the branch's author had turned off. So the file
 * is read with git (`git ls-tree`, then `git cat-file blob`: no checkout, no filter, no textconv,
 * no hook) from the first of `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master` that
 * the seat's own directory has. Without `origin/HEAD` that is a guess, so when `runner.yml` answers
 * the seat from a branch of another name (`ref: origin/develop`) it fails closed and says to run
 * `git remote set-head origin --auto`, rather than read a branch that may not be the default. A
 * repository with no remote has no pull requests, and is read at its `HEAD`. One with a remote and
 * none of those refs fails closed, with a sentence saying to fetch its default branch. So does a
 * directory inside a repository git cannot read (another account's clone, say): it is not read on
 * disk as if it were none. A directory that is not in a repository is read as it stands on disk.
 * A live seat's file is named from its own directory, which may be a subdirectory of the
 * repository, since its agent runs there; any other seat's from the root, since its agent runs in
 * a checkout of the whole repository (`treePathOf`). The job's checkout is never consulted
 * (`policyFor` takes it only because the host's seam does).
 *
 * **What it may do.** Only tighten what `runner.yml` gives the seat: it is the second source of
 * `loadSeatPolicy` (runner/egress-policy.ts), which joins deny and review lists and extra secret
 * patterns, turns a scan on but never off, prefers `refuse` to `hold`, and takes the smaller of
 * every budget. `budget.concurrent`, `per_hour` and `per_day` are the dispatch check's
 * (`dispatchBudget`), the rest the egress check's. Its `runtime` and `seat` can only refuse a job
 * (the wrong seat, the wrong CLI, a CLI whose reads are not confined when the file says they must
 * be). Two keys are read and not applied, and `notes` says so: `secret_scan.allow_paths` would
 * loosen the scan, and `runtime.model` is the runner operator's to choose.
 *
 * **The ref a job answers from** (`answeringRef`): `runner.yml`'s `ref` when it names one, which must
 * then be one the file allows (`refAllowed`: the default branch it was read at, its `checkout.ref`,
 * or one of `checkout.allowed_refs`) whenever the file names either; otherwise the file's
 * `checkout.ref`; otherwise the directory's `HEAD`, as before version 1. A live seat answers from its
 * directory as it stands, and `checkout.mode: worktree` is how a file refuses one.
 *
 * **What else it says**, which the runner's other parts read from `RepoPolicy`: the ledger's report
 * level and whether it keeps bodies (runner/ledger-sync.ts, runner/review-service.ts), who reviews a
 * held packet, the `may_ask` entries (runner/grants.ts's grants, by id: `grantPrincipals`), the offers, the brief file and the effects
 * allowed. `effects:` is the `EffectsSection` (runner/effects/policy.ts), checked by its rules,
 * where every rule names its targets: the runner's effects loop reads it, for an effect on a
 * repository one of its seats answers from (`effectsSectionsFor`), as a source that can only
 * narrow the runner's own `effects.yml`.
 *
 * A file in the original shape (`deny`, `secret_scan: true`, `extra_secrets`, `review`,
 * `budget`) is still read as it was. Anything this cannot read fails closed with the reason, for
 * the team: YAML that does not parse, a key it does not know, a value out of range, a `seat` or a
 * `runtime` that does not match the seat, an offer in a form Claude Code's allowlist would never
 * match, a file larger than 64 KiB, or a policy file that is a link.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ContextKind } from '@parley/shared';
import { TRUSTED_VALUE } from '@parley/shared/playbook';
import { LINE_BREAK } from '@parley/shared/text';
import { GRANT_PRINCIPAL, type PolicySummary, SEAT_LABEL, type SeatPolicy, SeatBudget, StandingRuntime, WhenSecret } from '@parley/shared/runner';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { POLICY_YML_ENV, policyYmlOn } from './flags.js';
import { type SeatConfig, seatDir } from './config.js';
import { loadSeatPolicy, POLICY_FILE_MAX, PolicyFields, policyFieldsOf } from './egress-policy.js';
import { checkEffect, EffectsSection } from './effects/policy.js';
import type { EffectPayload } from './effects/wire.js';
import type { Checkout, CheckoutMode } from './worktree.js';

/** Where the file lives unless the seat's config names another (`policy:` in `runner.yml`). */
export const POLICY_PATH = '.parley/policy.yml';

/** What goes to the relay about a seat's outbound ledger (`ledger.report`). */
export const ReportLevel = z.enum(['none', 'counts', 'entries']);
export type ReportLevel = z.infer<typeof ReportLevel>;
/** Who decides a held packet (`review.reviewers`). Either way it is decided where the packet is: on the runner's page. */
export const Reviewers = z.enum(['team', 'runner']);
export type Reviewers = z.infer<typeof Reviewers>;

/** What a seat's ledger does when the file says nothing: counts to the team, bodies kept on the machine. */
export const DEFAULT_LEDGER: Readonly<{ keepBodies: boolean; report: ReportLevel }> = { keepBodies: true, report: 'counts' };

/** A policy file this runner will not use, with the reason in a sentence for the team. */
export class PolicyYmlError extends Error {}

// ---------------------------------------------------------------- the schema

const Glob = z.string().min(1).max(300);
const Globs = z.array(Glob).max(200);
/** A ref as a policy may name one: nothing git could read as an option, a range or a path spec. */
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/@^~{}-]{1,200}$/;
/** A ref glob: a ref with `*` (one segment) or `**` (any number) in it, at most four of them. */
const REF_GLOB = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/@*-]{1,200}$/;
/** A name in `may_ask`: a project's, a team's or an organisation's slug or id. */
const PRINCIPAL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * An offer's allowlist entry: a tool's bare name (`Read`), or a Bash rule in the colon form
 * (`Bash(npm test:*)`). Claude Code's `Bash(npm test *)` matches nothing and is denied with no
 * useful error, so it is refused here, with the fix.
 */
const ALLOW = /^(?:[A-Z][A-Za-z]{1,40}|Bash\([^()\s:][^():]{0,160}:\*\))$/;
/** A secret pattern's name: letters, digits, `_` and `-`, which the policy names `secret:<name>` with `-` as `_`. */
const SECRET_NAME = /^[a-z][a-z0-9_-]{0,39}$/;

export const PolicyYmlV1 = z
  .object({
    version: z.literal(1),
    seat: z.string().regex(SEAT_LABEL, 'seat is a label: lowercase letters, digits and hyphens').optional(),
    runtime: z
      .object({
        cli: StandingRuntime.optional(),
        model: z.string().min(1).max(80).optional(),
        unconfined_reads: z.boolean().optional(),
        isolation: z.literal('none').optional(),
      })
      .strict()
      .optional(),
    checkout: z
      .object({
        mode: z.enum(['worktree', 'live']).optional(),
        ref: z.string().regex(REF, 'a ref, such as origin/main').optional(),
        allowed_refs: z
          .array(
            z
              .string()
              .regex(REF_GLOB, 'a ref glob, such as refs/pull/*/head')
              .refine((g) => (g.match(/\*+/g) ?? []).length <= 4, 'at most four wildcards'),
          )
          .max(50)
          .optional(),
      })
      .strict()
      .optional(),
    never_share: Globs.optional(),
    secret_scan: z
      .object({
        enabled: z.boolean().optional(),
        extra_patterns: z
          .array(z.object({ name: z.string().regex(SECRET_NAME, 'a pattern name: lowercase letters, digits, _ and -'), regex: z.string().min(1).max(500) }).strict())
          .max(50)
          .optional(),
        allow_paths: Globs.optional(),
      })
      .strict()
      .optional(),
    review: z
      .object({
        paths: Globs.optional(),
        kinds: z.array(ContextKind).max(10).optional(),
        when_secret: WhenSecret.optional(),
        reviewers: Reviewers.optional(),
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
    may_ask: z
      .object({
        ask_links: z.boolean().optional(),
        projects: z.array(z.string().regex(PRINCIPAL_NAME)).max(50).optional(),
        teams: z.array(z.string().regex(PRINCIPAL_NAME)).max(50).optional(),
        orgs: z.array(z.string().regex(PRINCIPAL_NAME)).max(50).optional(),
      })
      .strict()
      .optional(),
    offers: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'an offer name: lowercase letters, digits and _'),
            description: z.string().min(1).max(200),
            allow: z.string().regex(ALLOW, 'a tool name, or a Bash rule in the colon form: Bash(npm test:*)').optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    brief_file: z
      .string()
      .min(1)
      .max(200)
      .refine((p) => !path.isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..'), 'a path inside the repository')
      .optional(),
    // runner/effects/policy.ts's own rules, so the runner never reads a repository's effects by a looser grammar
    // than its own `effects.yml`: every rule names its targets, and there is no "anywhere".
    effects: EffectsSection.optional(),
    ledger: z.object({ keep_bodies: z.boolean().optional(), report: ReportLevel.optional() }).strict().optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const offers = new Set<string>();
    for (const [i, o] of (p.offers ?? []).entries()) {
      if (offers.has(o.name)) ctx.addIssue({ code: 'custom', path: ['offers', i, 'name'], message: `two offers are called ${o.name}` });
      offers.add(o.name);
    }
  });
export type PolicyYmlV1 = z.infer<typeof PolicyYmlV1>;

/** Everything a policy file says, in the shape the runner's parts read it. */
export interface RepoPolicy {
  /** Where it was read: the ref as named, the commit it resolved to (null for a directory with no git), the file. Null when there is no file. */
  from: { ref: string; commit: string | null; file: string } | null;
  /** `v1` for a version 1 file, `h1` for one in the original shape, `none` for no file. */
  shape: 'v1' | 'h1' | 'none';
  /** What the file adds to the seat's policy, as `loadSeatPolicy`'s second source. */
  fields: PolicyFields;
  ledger: { keepBodies: boolean; report: ReportLevel };
  reviewers: Reviewers;
  checkout: { mode: CheckoutMode | null; ref: string | null; allowedRefs: string[] };
  mayAsk: { askLinks: boolean; projects: string[]; teams: string[]; orgs: string[] };
  offers: Array<{ name: string; description: string; allow: string | null }>;
  briefFile: string | null;
  /** The file's `effects:` section, or null where it has none, which narrows nothing. */
  effects: EffectsSection | null;
  /** What was read and not applied, in a sentence each, for `crossroom runner doctor` and the log. */
  notes: string[];
}

/** A job's whole policy: what the proxy enforces, what the relay is told, and what the file says. */
export interface JobPolicy {
  policy: SeatPolicy;
  summary: PolicySummary;
  repo: RepoPolicy;
}

const EMPTY: Omit<RepoPolicy, 'from' | 'shape' | 'fields'> = {
  ledger: { ...DEFAULT_LEDGER },
  reviewers: 'team',
  checkout: { mode: null, ref: null, allowedRefs: [] },
  mayAsk: { askLinks: true, projects: [], teams: [], orgs: [] },
  offers: [],
  briefFile: null,
  effects: null,
  notes: [],
};

const issuesOf = (e: z.ZodError) =>
  e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`)
    .join('; ');

/** A pattern name as `SeatPolicy.extraSecrets` takes it: `acme-key` is `acme_key`. */
const secretName = (n: string) => n.replace(/-/g, '_');

/** A version 1 file as the fields `loadSeatPolicy` merges, and the rest as `RepoPolicy`. */
function fromV1(p: PolicyYmlV1): Omit<RepoPolicy, 'from' | 'shape'> {
  const notes: string[] = [];
  if (p.secret_scan?.allow_paths?.length)
    notes.push("secret_scan.allow_paths is read and not applied: a repository's policy only tightens what runner.yml gives the seat, and allowing paths would loosen the scan.");
  if (p.runtime?.model) notes.push(`runtime.model (${p.runtime.model}) is read and not applied: the runner's operator chooses the model in runner.yml.`);
  // A grant names a project or a team by its id (`project:proj_<id>`, `team:team_<id>`): anything
  // else is granted nothing, which only narrows where the seat may be asked from, and is said.
  for (const [key, prefix, idPrefix] of [
    ['projects', 'project', 'proj_'],
    ['teams', 'team', 'team_'],
  ] as const) {
    const names = (p.may_ask?.[key] ?? []).filter((n) => !GRANT_PRINCIPAL.test(`${prefix}:${n}`));
    if (names.length)
      notes.push(
        `may_ask.${key} names ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' and more' : ''}, which ${names.length === 1 ? 'is not an id' : 'are not ids'} (${idPrefix}<id>): a grant names a ${prefix} by its id, so ${names.length === 1 ? 'it is' : 'they are'} granted nothing.`,
      );
  }
  if (p.may_ask?.orgs?.length) notes.push('may_ask.orgs is read and not applied: a grant names a project or a team, never a whole organisation.');
  const fields: PolicyFields = {
    version: 1,
    ...(p.never_share ? { deny: p.never_share } : {}),
    ...(p.secret_scan?.enabled !== undefined ? { secret_scan: p.secret_scan.enabled } : {}),
    ...(p.secret_scan?.extra_patterns?.length ? { extra_secrets: p.secret_scan.extra_patterns.map((e) => ({ name: secretName(e.name), regex: e.regex })) } : {}),
    ...(p.review
      ? {
          review: {
            ...(p.review.paths ? { paths: p.review.paths } : {}),
            ...(p.review.kinds ? { kinds: p.review.kinds } : {}),
            ...(p.review.when_secret ? { when_secret: p.review.when_secret } : {}),
            ...(p.review.timeout_minutes !== undefined ? { timeout_minutes: p.review.timeout_minutes } : {}),
          },
        }
      : {}),
    ...(p.budget ? { budget: p.budget } : {}),
  };
  return {
    fields,
    ledger: { keepBodies: p.ledger?.keep_bodies ?? DEFAULT_LEDGER.keepBodies, report: p.ledger?.report ?? DEFAULT_LEDGER.report },
    reviewers: p.review?.reviewers ?? EMPTY.reviewers,
    checkout: { mode: p.checkout?.mode ?? null, ref: p.checkout?.ref ?? null, allowedRefs: p.checkout?.allowed_refs ?? [] },
    mayAsk: {
      askLinks: p.may_ask?.ask_links ?? true,
      projects: p.may_ask?.projects ?? [],
      teams: p.may_ask?.teams ?? [],
      orgs: p.may_ask?.orgs ?? [],
    },
    offers: (p.offers ?? []).map((o) => ({ name: o.name, description: o.description, allow: o.allow ?? null })),
    briefFile: p.brief_file ?? null,
    effects: p.effects ?? null,
    notes,
  };
}

/** A file as read: what `RepoPolicy` says of it, and the version 1 file itself where it is one. */
type Parsed = Omit<RepoPolicy, 'from'> & { v1: PolicyYmlV1 | null };

function parse(text: string | null, name: string): Parsed {
  if (text === null) return { shape: 'none', fields: {}, ...structuredClone(EMPTY), v1: null };
  if (typeof text !== 'string') throw new PolicyYmlError(`${name} could not be read`);
  if (text.length > POLICY_FILE_MAX) throw new PolicyYmlError(`${name} is larger than ${POLICY_FILE_MAX / 1024} KiB`);
  let value: unknown;
  try {
    value = parseYaml(text, { maxAliasCount: 50, uniqueKeys: true, prettyErrors: false });
  } catch (e) {
    throw new PolicyYmlError(`${name} is not valid YAML: ${String((e as Error)?.message ?? e).split(LINE_BREAK)[0]!.slice(0, 200)}`);
  }
  if (value === null || value === undefined) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new PolicyYmlError(`${name} is not a mapping of keys to values`);
  const v1 = PolicyYmlV1.safeParse(value);
  if (v1.success) return { shape: 'v1', ...fromV1(v1.data), v1: v1.data };
  // The original shape, read as it always was. Both schemas are strict, so a version 1 file with a
  // typo in it is neither, and stays an error about version 1.
  const h1 = PolicyFields.safeParse(value);
  if (h1.success) return { shape: 'h1', fields: h1.data, ...structuredClone(EMPTY), v1: null };
  throw new PolicyYmlError(`${name}: ${issuesOf(v1.error)}`);
}

/**
 * A policy file's text, read. `name` says where it came from in any error. Null text is no file.
 * Throws `PolicyYmlError` for anything this will not use.
 */
export function parsePolicyYml(text: string | null, name: string): Omit<RepoPolicy, 'from'> {
  const { v1: _v1, ...rest } = parse(text, name);
  return rest;
}

// ---------------------------------------------------------------- the seat, against the file

/**
 * A version 1 file's `seat` and `runtime`, against the seat the runner is starting. Each can only
 * refuse the job: a file for another seat, another CLI, or confined reads the seat's CLI does not
 * have. And a `checkout.mode: worktree` the seat's config sets to `live` (a live directory shows an
 * agent the files a worktree leaves out).
 */
function checkSeat(v: PolicyYmlV1, seat: SeatConfig, name: string) {
  if (v.seat && v.seat !== seat.label) throw new PolicyYmlError(`${name} is the policy of the seat "${v.seat}", not "${seat.label}"; give each seat its own file (policy: in runner.yml)`);
  const cli = v.runtime?.cli;
  if (cli && cli !== seat.runtime) throw new PolicyYmlError(`${name} says this seat runs ${cli}, and runner.yml runs it with ${seat.runtime}`);
  if (v.runtime?.unconfined_reads === false && seat.runtime !== 'claude')
    throw new PolicyYmlError(`${name} says this seat's reads must be confined to its checkout, and ${seat.runtime}'s are not; run the seat with claude`);
  if (v.checkout?.mode === 'worktree' && seat.checkout === 'live')
    throw new PolicyYmlError(`${name} says this seat answers from a worktree, and runner.yml sets checkout: live`);
}

// ---------------------------------------------------------------- reading it from the default branch

/** The environment git runs with here: this process's, less Crossroom's own and anything that would point git elsewhere. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(parley_|git_dir$|git_work_tree$|git_index_file$|git_object_directory$|git_alternate_object_directories$|git_namespace$|git_ceiling_directories$)/i.test(k)) env[k] = v;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

const GIT_TIMEOUT_MS = 15_000;

/** git in `cwd`, its stdout, or null when it exits non-zero. Never through a shell. */
function gitOut(cwd: string, args: string[], maxBuffer = 1024 * 1024): string | null {
  try {
    return execFileSync('git', args, { cwd, env: gitEnv(), windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** The same, awaited: git runs as a process of its own, and the event loop goes on meanwhile. */
function gitOutAwaited(cwd: string, args: string[], maxBuffer = 1024 * 1024): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, env: gitEnv(), windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
    child.stdin?.end();
  });
}

/** A git call a reading of a repository asks for: `gitOut`'s arguments. */
interface GitCall {
  cwd: string;
  args: string[];
  maxBuffer?: number;
}

/**
 * A reading of a repository that asks for its git calls one at a time, so one copy of its steps
 * runs either blocking (`readNow`, for a caller that is synchronous) or awaited (`readAwaited`, for
 * one that must not hold the event loop while a handful of git processes run: the dispatch check
 * and the effects loop's repository policy, runner/connect.ts, beside every running job's egress
 * proxy and the heartbeat).
 */
type GitReading<T> = Generator<GitCall, T, string | null>;

function* git(cwd: string, args: string[], maxBuffer?: number): GitReading<string | null> {
  return yield { cwd, args, ...(maxBuffer !== undefined ? { maxBuffer } : {}) };
}

function readNow<T>(reading: GitReading<T>): T {
  let step = reading.next();
  while (!step.done) step = reading.next(gitOut(step.value.cwd, step.value.args, step.value.maxBuffer));
  return step.value;
}

async function readAwaited<T>(reading: GitReading<T>): Promise<T> {
  let step = reading.next();
  while (!step.done) step = reading.next(await gitOutAwaited(step.value.cwd, step.value.args, step.value.maxBuffer));
  return step.value;
}

/** Where a repository's default branch is looked for, in order. */
export const DEFAULT_BRANCH_REFS: readonly string[] = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'];

/**
 * The `.git` (a directory, or a worktree's file) of the repository `dir` is inside, looking up to
 * the root, or null when there is none. Git's own answer is not enough: a repository git refuses to
 * read (another account's clone, a format it does not know) answers like no repository at all.
 */
function gitMarker(dir: string): string | null {
  let d = path.resolve(dir);
  for (;;) {
    const marker = path.join(d, '.git');
    if (existsSync(marker)) return marker;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** A ref's full name in `dir` (`origin/main` is `refs/remotes/origin/main`), or null for a commit id or a ref it does not have. */
function* fullRefNameOf(dir: string, ref: string): GitReading<string | null> {
  if (typeof ref !== 'string' || !REF.test(ref)) return null;
  return (yield* git(dir, ['rev-parse', '--verify', '--quiet', '--symbolic-full-name', ref]))?.trim() || null;
}
const fullRefName = (dir: string, ref: string): string | null => readNow(fullRefNameOf(dir, ref));

/** A branch's own name, local or remote-tracking (`refs/remotes/origin/main` and `refs/heads/main` are `main`), or null for anything that is not a branch. */
function branchName(full: string | null): string | null {
  if (!full) return null;
  const local = /^refs\/heads\/(.+)$/.exec(full);
  if (local) return local[1]!;
  const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(full);
  return remote && remote[1] !== 'HEAD' ? remote[1]! : null;
}

/**
 * The ref and commit a repository's policy is read at: its default branch (`DEFAULT_BRANCH_REFS`),
 * or `HEAD` for a repository with no remote, which has no pull requests. Null when `dir` is not in a
 * git repository. Throws for one git cannot read, for one with a remote and no default branch here,
 * and, without `origin/HEAD`, when `answering` (the seat's `ref` in `runner.yml`) is a branch of
 * another name than the one guessed: the policy is never read at a branch that may not be the default.
 */
export function defaultBranch(dir: string, o: { answering?: string } = {}): { ref: string; commit: string } | null {
  return readNow(defaultBranchOf(dir, o));
}

function* defaultBranchOf(dir: string, o: { answering?: string } = {}): GitReading<{ ref: string; commit: string } | null> {
  const inside = (yield* git(dir, ['rev-parse', '--is-inside-work-tree']))?.trim();
  if (inside !== 'true') {
    const marker = existsSync(dir) ? gitMarker(dir) : null;
    if (!marker) return null;
    throw new PolicyYmlError(
      `${dir} is inside a git repository (${marker}) that git cannot read here, so its policy cannot be read from its default branch, and is never read from the directory instead; run git status there as this runner's user to see why (a repository another account owns needs git config --global --add safe.directory)`,
    );
  }
  for (const ref of DEFAULT_BRANCH_REFS) {
    const commit = (yield* git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))?.trim();
    if (!commit) continue;
    // A guess only matters where there is a remote whose default it guesses (and whose pull requests there are).
    const wanted = ref === DEFAULT_BRANCH_REFS[0] || !o.answering ? null : branchName(yield* fullRefNameOf(dir, o.answering));
    if (wanted && wanted !== branchName(ref) && (yield* git(dir, ['remote']))?.trim())
      throw new PolicyYmlError(
        `${dir} has no origin/HEAD, so its default branch is a guess (${ref.replace(/^refs\/(?:remotes|heads)\//, '')}), and runner.yml answers the seat from ${o.answering}; its policy is read only from the default branch, so run git remote set-head origin --auto there`,
      );
    return { ref, commit };
  }
  const remotes = (yield* git(dir, ['remote']))?.trim();
  if (remotes === '') {
    const commit = (yield* git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim();
    if (commit) return { ref: 'HEAD', commit };
    throw new PolicyYmlError(`${dir} has no commit yet, so there is no policy to read`);
  }
  throw new PolicyYmlError(
    `${dir} has a remote but no default branch this runner can find (origin/HEAD, origin/main, origin/master, main or master), so its policy cannot be read from it and never from another ref; run git fetch origin, or git remote set-head origin --auto`,
  );
}

/** A path inside the repository, as a policy file's may be named: relative, forward slashes, nothing that climbs out or reads as an option. */
function repoPath(file: string): string {
  const p = file.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (!p || p.length > 300 || p.startsWith('-') || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => s === '..' || s === ''))
    throw new PolicyYmlError(`${file} is not a path inside the repository`);
  return p;
}

/** A file's text at one commit, or null when the commit has no such path. Never a link, a directory or a submodule. */
export function fileAtCommit(dir: string, commit: string, file: string): string | null {
  return readNow(fileAtCommitOf(dir, commit, file));
}

function* fileAtCommitOf(dir: string, commit: string, file: string): GitReading<string | null> {
  const p = repoPath(file);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) throw new PolicyYmlError(`${commit} is not a commit id`);
  const entry = yield* git(dir, ['ls-tree', '-z', '--full-tree', commit, '--', p]);
  if (entry === null) throw new PolicyYmlError(`git could not list ${p} at ${commit.slice(0, 10)}`);
  const first = entry.split('\0').find((e) => e.length > 0);
  if (!first) return null;
  const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(first);
  if (!m || m[4] !== p) return null;
  if (m[1] === '120000') throw new PolicyYmlError(`${p} is a symbolic link at ${commit.slice(0, 10)}; a policy file must be a file`);
  if (m[2] !== 'blob') throw new PolicyYmlError(`${p} is not a file at ${commit.slice(0, 10)}`);
  const size = Number((yield* git(dir, ['cat-file', '-s', m[3]!]))?.trim());
  if (!Number.isFinite(size)) throw new PolicyYmlError(`git could not read ${p} at ${commit.slice(0, 10)}`);
  if (size > POLICY_FILE_MAX) throw new PolicyYmlError(`${p} is larger than ${POLICY_FILE_MAX / 1024} KiB`);
  const text = yield* git(dir, ['cat-file', 'blob', m[3]!], POLICY_FILE_MAX + 1024);
  if (text === null) throw new PolicyYmlError(`git could not read ${p} at ${commit.slice(0, 10)}`);
  return text;
}

/**
 * A file inside a directory that is not a repository, read as it stands, no further than the
 * policy's limit. Null when it is not there. A link is refused: it could name any file on the machine.
 */
function fileOnDisk(root: string, file: string): string | null {
  const full = path.resolve(root, repoPath(file));
  const within = path.relative(root, full);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new PolicyYmlError(`${file} is not inside the seat's directory`);
  if (!existsSync(full)) return null;
  const st = lstatSync(full);
  if (st.isSymbolicLink()) throw new PolicyYmlError(`${file} is a symbolic link; a policy file must be a file`);
  if (!st.isFile()) throw new PolicyYmlError(`${file} is not a file`);
  if (st.size > POLICY_FILE_MAX) throw new PolicyYmlError(`${file} is larger than ${POLICY_FILE_MAX / 1024} KiB`);
  return readFileSync(full, 'utf8');
}

/**
 * The seat's policy file, read from its repository's default branch (`defaultBranch`), with where
 * it was read. A directory that is not a repository is read on disk. A file the seat's config
 * names (`policy:`) must be there.
 */
export function readRepoPolicy(seat: SeatConfig, home: string): RepoPolicy {
  return readNow(repoPolicyOf(seat, home));
}

function* repoPolicyOf(seat: SeatConfig, home: string): GitReading<RepoPolicy> {
  const dir = seatDir(seat, home);
  const file = seat.policy ?? POLICY_PATH;
  const at = yield* defaultBranchOf(dir, seat.ref ? { answering: seat.ref } : {});
  const inTree = at ? yield* treePathOf(seat, dir, file) : file;
  const text = at ? yield* fileAtCommitOf(dir, at.commit, inTree) : fileOnDisk(dir, file);
  if (text === null && seat.policy) throw new PolicyYmlError(`${inTree} is named in runner.yml for the seat ${seat.label} but is not on ${at ? at.ref : 'disk'}`);
  const where = at ? `${inTree} at ${at.ref}` : file;
  const { v1, ...parsed } = parse(text, where);
  if (v1) checkSeat(v1, seat, where);
  return { ...parsed, from: text === null ? null : { ref: at?.ref ?? 'working directory', commit: at?.commit ?? null, file: inTree } };
}

/**
 * Where a seat's policy file is in its repository's tree. A live seat answers from its directory as
 * it stands, and its agent runs there, so its file is named from that directory, a subdirectory of
 * the repository or its root, as the original shape was read inside the directory the agent runs in: read from
 * the root instead, a live seat on `mono/payments` lost its own `mono/payments/.parley/policy.yml`,
 * deny list and all, and no error said so, since a missing file is no policy. Any other seat's agent
 * runs in a checkout of the whole repository, whose root the file is named from.
 */
function* treePathOf(seat: SeatConfig, dir: string, file: string): GitReading<string> {
  if (seat.checkout !== 'live') return file;
  const prefix = yield* git(dir, ['rev-parse', '--show-prefix']);
  if (prefix === null) throw new PolicyYmlError(`git could not say where ${dir} is in its repository, so its policy cannot be read`);
  return `${prefix.replace(/\r?\n$/, '')}${repoPath(file)}`;
}

/**
 * A job's whole policy: `runner.yml`'s entry for the seat, tightened by its policy file from the
 * default branch. Throws `PolicyYmlError`, which refuses the job, for anything that fails closed.
 */
export function loadJobPolicy(seat: SeatConfig, home: string): JobPolicy {
  return readNow(jobPolicyOf(seat, home));
}

function* jobPolicyOf(seat: SeatConfig, home: string): GitReading<JobPolicy> {
  const repo = yield* repoPolicyOf(seat, home);
  const where = repo.from ? `${repo.from.file} at ${repo.from.ref}` : (seat.policy ?? POLICY_PATH);
  const loaded = loadSeatPolicy([
    { name: `runner.yml (seat ${seat.label})`, value: policyFieldsOf(seat) },
    { name: where, value: repo.fields },
  ]);
  if (!loaded.ok) throw new PolicyYmlError(`the seat's policy does not check: ${loaded.error}`);
  return { policy: loaded.policy, summary: loaded.summary, repo };
}

/**
 * A job's policy as the runner should enforce it: from the default branch (`loadJobPolicy`),
 * whatever commit `checkout` is at. With the `policyYml` flag off, the original reading: the
 * repository's file in the job's own checkout, in the original shape, and nothing more said. Then a
 * call without the checkout throws rather than read the default branch: an approval checked again
 * under another policy than the one that held its packet would be refused, or let through, by it.
 */
export function jobPolicyFor(seat: SeatConfig, home: string, checkout?: Pick<Checkout, 'cwd'>): JobPolicy {
  if (!policyYmlOn()) {
    if (!checkout) throw new PolicyYmlError(`with ${POLICY_YML_ENV}=0 a job's policy is read from its own checkout, and none was given for the seat ${seat.label}`);
    const file = seat.policy ?? POLICY_PATH;
    const loaded = loadSeatPolicy([
      { name: `runner.yml (seat ${seat.label})`, value: policyFieldsOf(seat) },
      { name: file, text: fileOnDisk(checkout.cwd, file), required: !!seat.policy },
    ]);
    if (!loaded.ok) throw new PolicyYmlError(`the seat's policy does not check: ${loaded.error}`);
    return { policy: loaded.policy, summary: loaded.summary, repo: { from: null, shape: 'none', fields: {}, ...structuredClone(EMPTY) } };
  }
  return loadJobPolicy(seat, home);
}

/** The host's `policyFor` (`RunnerHostOptions.policyFor`), as `jobPolicyFor` decides it. */
export function policyFor(seat: SeatConfig, home: string, checkout?: Pick<Checkout, 'cwd'>): SeatPolicy {
  return jobPolicyFor(seat, home, checkout).policy;
}

/** The limits the dispatch check holds a seat to (runner/dispatch.ts `DispatchSeat.budget`). */
export type DispatchBudget = { concurrent: number; perHour: number; perDay?: number };

/**
 * The seat's dispatch limits: `runner.yml`'s, tightened by the file's `budget.concurrent`,
 * `per_hour` and `per_day` from the default branch, which only the dispatch check can enforce (the
 * egress check sees one job at a time). A file that cannot be read gives `runner.yml`'s alone,
 * since the job it would dispatch is refused anyway when its policy is read at the start. With the
 * `policyYml` flag off, `runner.yml`'s, as before version 1.
 */
export function dispatchBudget(seat: SeatConfig, home: string): DispatchBudget {
  return dispatchPolicy(seat, home).budget;
}

/**
 * What the dispatch check reads of a seat's policy, from one reading of the file: its limits
 * (`dispatchBudget`), and whether the seat takes asks through its own link (`may_ask.ask_links`,
 * on unless the file says false; `may_ask` grants are the other way in). A file that cannot be read
 * says nothing more than `runner.yml`, for the reason `dispatchBudget` gives.
 */
export function dispatchPolicy(seat: SeatConfig, home: string): { budget: DispatchBudget; askLinks: boolean } {
  return readNow(dispatchPolicyOf(seat, home));
}

/**
 * `dispatchPolicy`, read without holding the event loop: the same steps, each git call awaited. The
 * dispatch check reads it this way, once per job and before any of runner.db's transactions
 * (runner/connect.ts), since a seat's reading is several git processes.
 */
export function dispatchPolicyAwaited(seat: SeatConfig, home: string): Promise<{ budget: DispatchBudget; askLinks: boolean }> {
  return readAwaited(dispatchPolicyOf(seat, home));
}

function* dispatchPolicyOf(seat: SeatConfig, home: string): GitReading<{ budget: DispatchBudget; askLinks: boolean }> {
  const pick = (b: SeatPolicy['budget']): DispatchBudget => ({ concurrent: b.concurrent, perHour: b.perHour, ...(b.perDay !== undefined ? { perDay: b.perDay } : {}) });
  const own = () => {
    const loaded = loadSeatPolicy([{ name: `runner.yml (seat ${seat.label})`, value: policyFieldsOf(seat) }]);
    if (!loaded.ok) throw new PolicyYmlError(`the seat's policy does not check: ${loaded.error}`);
    return { budget: pick(loaded.policy.budget), askLinks: true };
  };
  if (!policyYmlOn()) return own();
  try {
    const job = yield* jobPolicyOf(seat, home);
    return { budget: pick(job.policy.budget), askLinks: job.repo.mayAsk.askLinks };
  } catch (e) {
    if (e instanceof PolicyYmlError) return own();
    throw e;
  }
}

/**
 * The ref a job of the seat answers from (`prepareCheckout`'s `ref`): `runner.yml`'s, which the file
 * must allow when it names `checkout.ref` or `checkout.allowed_refs`; otherwise the file's
 * `checkout.ref`; otherwise none, which is the directory's `HEAD`. Throws `PolicyYmlError`, which
 * refuses the job, for a ref the file does not allow. With the `policyYml` flag off, `runner.yml`'s.
 */
export function answeringRef(seat: SeatConfig, home: string): string | undefined {
  if (!policyYmlOn()) return seat.ref;
  const repo = readRepoPolicy(seat, home);
  const limited = repo.shape === 'v1' && (repo.checkout.ref !== null || repo.checkout.allowedRefs.length > 0);
  if (!seat.ref) return repo.checkout.ref ?? undefined;
  const dir = seatDir(seat, home);
  if (limited && !refAllowed(repo, seat.ref, (r) => fullRefName(dir, r))) {
    const where = repo.from ? `${repo.from.file} at ${repo.from.ref}` : POLICY_PATH;
    throw new PolicyYmlError(`runner.yml answers the seat ${seat.label} from ${seat.ref}, which ${where} does not allow (checkout.ref and checkout.allowed_refs)`);
  }
  return seat.ref;
}

// ---------------------------------------------------------------- what else the file allows

/** A ref glob as a regular expression: `*` one segment's worth, `**` anything; everything else literal. */
function refGlob(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else re += ch.replace(/[.+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Whether a job may answer from `ref`: the default branch the policy was read at, the file's own
 * `checkout.ref`, or a ref one of `checkout.allowed_refs` matches. A ref git could read as an
 * option or a range never may. `fullName` gives the name git knows a ref by (`origin/main` is
 * `refs/remotes/origin/main`), so a ref matches by either name.
 */
export function refAllowed(repo: RepoPolicy, ref: string, fullName: (ref: string) => string | null = () => null): boolean {
  if (typeof ref !== 'string' || !REF.test(ref)) return false;
  const names = new Set([ref, fullName(ref)].filter((n): n is string => !!n));
  const same = (other: string | null | undefined) => !!other && (names.has(other) || names.has(fullName(other) ?? ''));
  if (repo.from && same(repo.from.ref)) return true;
  if (same(repo.checkout.ref)) return true;
  return repo.checkout.allowedRefs.some((g) => [...names].some((n) => refGlob(g).test(n)));
}

/**
 * Whether the file alone allows a GitHub effect of this kind on this repository (`effects.allow`,
 * checked as the effects loop checks it). No section, or no rule, allows nothing.
 */
export function effectAllowed(repo: RepoPolicy, kind: string, target?: string | null): boolean {
  if (!repo.effects || !target) return false;
  return checkEffect({ kind, target: { repo: target } } as Pick<EffectPayload, 'kind' | 'target'>, [{ name: POLICY_PATH, section: repo.effects }]).ok;
}

/**
 * The GitHub repository (`owner/name`) a remote's URL names (`https://github.com/acme/api.git`,
 * `git@github.com:acme/api.git`, `ssh://git@host/acme/api`), or null for a local path or anything
 * else. The host is not read: this only finds which policies narrow an effect, so a match on the
 * path alone can only refuse more.
 */
export function githubRepoFromUrl(url: string): string | null {
  const m = /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?[^/\s]+\/|[^@\s/]+@[^:/\s]+:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!m || [m[1], m[2]].some((s) => s === '.' || s === '..')) return null;
  const repo = `${m[1]}/${m[2]}`;
  return TRUSTED_VALUE['trigger.repo'].test(repo) ? repo : null;
}

/** The repository a seat's directory has as `origin`, by `githubRepoFromUrl`, or null. */
export function githubRepoOf(dir: string): string | null {
  return readNow(githubRepoOfReading(dir));
}

function* githubRepoOfReading(dir: string): GitReading<string | null> {
  const url = (yield* git(dir, ['config', '--get', 'remote.origin.url']))?.trim();
  return url ? githubRepoFromUrl(url) : null;
}

/**
 * The `effects` sections of the policy of every seat whose repository is `repo` (`owner/name`,
 * compared without case), each read from that seat's default branch as a job's is: each a source
 * of the effects policy check, which can only narrow the runner's own `effects.yml`. A seat whose file
 * has no `effects:` narrows nothing. Throws `PolicyYmlError` for a file that does not read, which
 * refuses the effect (`policy_unreadable`) rather than post under half a policy.
 */
export function effectsSectionsFor(seats: readonly SeatConfig[], home: string, repo: string): EffectsSection[] {
  return readNow(effectsSectionsOf(seats, home, repo));
}

/**
 * `effectsSectionsFor`, read without holding the event loop: the same steps, each git call awaited.
 * The effects loop reads it this way for every GitHub effect (runner/connect.ts), since it asks
 * every configured seat's directory which repository it is, a git process each, beside every
 * running job's egress proxy and the heartbeat.
 */
export function effectsSectionsForAwaited(seats: readonly SeatConfig[], home: string, repo: string): Promise<EffectsSection[]> {
  return readAwaited(effectsSectionsOf(seats, home, repo));
}

function* effectsSectionsOf(seats: readonly SeatConfig[], home: string, repo: string): GitReading<EffectsSection[]> {
  const wanted = repo.toLowerCase();
  const out: EffectsSection[] = [];
  for (const seat of seats) {
    if ((yield* githubRepoOfReading(seatDir(seat, home)))?.toLowerCase() !== wanted) continue;
    const section = (yield* repoPolicyOf(seat, home)).effects;
    if (section) out.push(section);
  }
  return out;
}

/**
 * The grants a seat's policy asks for (`may_ask`; runner/grants.ts): `project:<id>`
 * for each project id and `team:<id>` for each team id, each once. A name that is not an id, and
 * `orgs`, are granted nothing (`notes` says so), since a grant names a project or a team by its id.
 */
export function grantPrincipals(repo: Pick<RepoPolicy, 'mayAsk'>): string[] {
  const out = [...repo.mayAsk.projects.map((p) => `project:${p}`), ...repo.mayAsk.teams.map((t) => `team:${t}`)].filter((p) => GRANT_PRINCIPAL.test(p));
  return [...new Set(out)];
}
