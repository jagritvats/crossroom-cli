/**
 * A runner's configuration: `runner.yml` under the runner's home, which is
 * `PARLEY_RUNNER_HOME` or `~/.parley/runner`. It holds no secrets: the runner token, the keys and
 * every seat and ask token live in `runner.db` beside it (runner/store.ts), and a seat's brief is a
 * file in the seat's own repository that is never sent anywhere.
 *
 * ```yaml
 * relay: https://app.crossroom.dev
 * name: ci-box-02
 * cosign_as: org:example.com    # co-sign each room's head once it ends, as this organisation
 * seats:
 *   - label: payments-api
 *     dir: ~/src/payments-api
 *     checkout: worktree        # worktree (the default for git) | live
 *     ref: origin/main          # answers from this commit
 *     runtime: claude           # claude | codex | grok
 *     unconfined_reads: false   # must be `acknowledged` for codex or grok
 *     description: "Answers about payments-api: contracts, limits, error codes."
 *     brief_file: .parley/seat-brief.md
 *     deny: ["**\/.env*", "secrets/**"]
 *     secret_scan: true
 *     review: { paths: [], when_secret: hold, timeout_minutes: 120 }
 *     budget: { messages: 30, packets: 12, minutes: 20, concurrent: 3, per_hour: 10 }
 *     connections:              # grants another organisation may ask this seat through
 *       - { connection: conn_..., grant: ga_..., rooms_per_day: 5 }
 * ```
 *
 * Nothing a relay sends ever changes any of this: a job names a seat by its id, and everything
 * about how the seat runs (its directory, runtime, model, policy) is read from here.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextKind } from '@parley/shared';
import { SEAT_LABEL, type SeatPolicy, SeatPolicy as SeatPolicySchema, StandingRuntime } from '@parley/shared/runner';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { COSIGN_AS } from './cosign.js';

/** Where a runner keeps its configuration, its database and its jobs. */
export const runnerHome = (env: NodeJS.ProcessEnv = process.env) => env.PARLEY_RUNNER_HOME || path.join(os.homedir(), '.parley', 'runner');
export const configPath = (home: string) => path.join(home, 'runner.yml');
/** Every job's directory: `jobs/<jobId>/` holds `repo/`, `mcp.json` and `log`. */
export const jobsRoot = (home: string) => path.join(home, 'jobs');

/**
 * What a new seat denies unless its team says otherwise: the usual homes of secrets. A team adds
 * its own with `--deny` or in `runner.yml`, and `.parley/policy.yml` at the answering commit.
 */
export const DEFAULT_DENY: readonly string[] = [
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/secrets/**',
  '**/credentials*',
];
export const DEFAULT_BUDGET = { messages: 30, packets: 12, minutes: 20, concurrent: 3, per_hour: 10 } as const;
export const DEFAULT_REVIEW = { paths: [] as string[], kinds: [] as string[], when_secret: 'hold' as const, timeout_minutes: 120 };

const Budget = z
  .object({
    messages: z.number().int().min(1).max(500),
    packets: z.number().int().min(0).max(200),
    minutes: z.number().int().min(1).max(24 * 60),
    spend_usd: z.number().min(0).max(1000).optional(),
    concurrent: z.number().int().min(1).max(50),
    per_hour: z.number().int().min(1).max(500),
    per_day: z.number().int().min(1).max(5000).optional(),
  })
  .partial()
  .strict();

const Review = z
  .object({
    paths: z.array(z.string().min(1).max(300)).max(200),
    kinds: z.array(ContextKind).max(10),
    when_secret: z.enum(['hold', 'refuse']),
    timeout_minutes: z.number().int().min(1).max(7 * 24 * 60),
  })
  .partial()
  .strict();

const SeatConnection = z
  .object({
    connection: z.string().regex(/^conn_[A-Za-z0-9_-]{22}$/, 'a connection id is conn_ and 22 characters'),
    grant: z.string().regex(/^ga_[A-Za-z0-9_-]{16}$/, "a grant is its alias, ga_ and 16 characters, as the organisation's connections page shows it"),
    min_epoch: z.number().int().min(1).optional(),
    rooms_per_day: z.number().int().min(0).max(1000).optional(),
    asks_per_day: z.number().int().min(0).max(10_000).optional(),
    live_rooms: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const SeatConfig = z
  .object({
    label: z.string().regex(SEAT_LABEL, 'a label is lowercase letters, digits and hyphens, at most 40'),
    dir: z.string().min(1),
    checkout: z.enum(['worktree', 'live']).optional(),
    ref: z.string().min(1).max(200).optional(),
    runtime: StandingRuntime.default('claude'),
    model: z.string().min(1).max(80).optional(),
    unconfined_reads: z.union([z.literal(false), z.literal('acknowledged')]).default(false),
    description: z.string().max(300).default(''),
    brief_file: z.string().min(1).optional(),
    /** The team's policy file at the answering commit, read by the runner's policy check. */
    policy: z.string().min(1).optional(),
    deny: z.array(z.string().min(1).max(300)).max(200).default([...DEFAULT_DENY]),
    secret_scan: z.boolean().default(true),
    review: Review.optional(),
    budget: Budget.optional(),
    paused: z.boolean().default(false),
    /**
     * Notes between the calls the seat's account makes itself (runner/notes.ts):
     * on unless `off` (or `false`), which keeps none and gives none.
     */
    notes: z.union([z.enum(['on', 'off']), z.boolean()]).optional(),
    /**
     * The grants of the team's organisation this seat answers through, across a connection with
     * another organisation: a job across a connection is refused unless it names one of
     * these, at an epoch no older than `min_epoch`, under the stricter of its limits and these.
     */
    connections: z.array(SeatConnection).max(50).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.runtime !== 'claude' && s.unconfined_reads !== 'acknowledged')
      ctx.addIssue({
        code: 'custom',
        path: ['unconfined_reads'],
        message: `${s.runtime === 'codex' ? 'Codex' : 'Grok'} can read files outside the seat's checkout, so the seat needs unconfined_reads: acknowledged (or --unconfined-reads-ok). Claude Code is confined, and is the default.`,
      });
  });
export type SeatConfig = z.infer<typeof SeatConfig>;

export const RunnerConfig = z
  .object({
    relay: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//.test(u), 'the relay is an http(s) URL'),
    name: z.string().min(1).max(60),
    /**
     * Co-sign the head of each room this runner's seats were in, once it ends, as this organisation
     * (`org:<domain>` or `org:<organisation id>`): the organisation then vouches for this
     * runner's key by publishing it at `https://<domain>/.well-known/parley-keys.json`. Absent: none.
     */
    cosign_as: z.string().regex(COSIGN_AS, 'cosign_as is org:<domain> or org:<organisation id>').optional(),
    seats: z.array(SeatConfig).max(100).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.seats.forEach((s, i) => {
      if (seen.has(s.label)) ctx.addIssue({ code: 'custom', path: ['seats', i, 'label'], message: `two seats are labelled ${s.label}` });
      seen.add(s.label);
    });
  });
export type RunnerConfig = z.infer<typeof RunnerConfig>;

export class ConfigError extends Error {}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`).join('\n');

/** Read and check `runner.yml`. Null when there is none; a file that does not check throws, so a runner never starts on half a policy. */
export function loadConfig(home: string): RunnerConfig | null {
  const file = configPath(home);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${file} is not valid YAML: ${(e as Error).message.split('\n')[0]}`);
  }
  const r = RunnerConfig.safeParse(raw);
  if (!r.success) throw new ConfigError(`${file} does not check:\n${issues(r.error)}`);
  return r.data;
}

/** Write `runner.yml`, replacing it whole, after checking it. */
export function saveConfig(home: string, cfg: RunnerConfig): void {
  const r = RunnerConfig.safeParse(cfg);
  if (!r.success) throw new ConfigError(issues(r.error));
  mkdirSync(home, { recursive: true });
  const file = configPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `# Crossroom runner configuration. No secrets live here.\n${stringify(r.data)}`);
  renameSync(tmp, file);
}

/** `~` and relative paths, against the home directory and the config's own directory. */
export function seatDir(seat: Pick<SeatConfig, 'dir'>, home: string): string {
  const d = seat.dir === '~' || seat.dir.startsWith('~/') || seat.dir.startsWith('~\\') ? path.join(os.homedir(), seat.dir.slice(1)) : seat.dir;
  return path.resolve(home, d);
}

/** A seat's policy as the proxy enforces it, from its config. Fails closed: a policy that does not check throws. */
export function seatPolicy(seat: SeatConfig): SeatPolicy {
  const b = { ...DEFAULT_BUDGET, ...seat.budget };
  const r = { ...DEFAULT_REVIEW, ...seat.review };
  return SeatPolicySchema.parse({
    deny: seat.deny,
    secretScan: seat.secret_scan,
    review: { paths: r.paths, kinds: r.kinds, whenSecret: r.when_secret, timeoutMinutes: r.timeout_minutes },
    budget: {
      messages: b.messages,
      packets: b.packets,
      minutes: b.minutes,
      concurrent: b.concurrent,
      perHour: b.per_hour,
      ...(b.per_day !== undefined ? { perDay: b.per_day } : {}),
      ...(b.spend_usd !== undefined ? { spendUsd: b.spend_usd } : {}),
    },
  });
}

/** The seat's private brief, read from its own directory: never sent to the relay, and capped. */
export function seatBrief(seat: SeatConfig, home: string): string | null {
  if (!seat.brief_file) return null;
  const file = path.resolve(seatDir(seat, home), seat.brief_file);
  try {
    return readFileSync(file, 'utf8').slice(0, 20_000);
  } catch {
    return null;
  }
}

/**
 * The globs a command line gives for `--deny` or `--review`: every value the flag was given (it
 * may repeat), each split at its commas, except a comma inside braces,
 * which is a brace list's (`config/{prod,staging}/**` stays whole).
 */
export function globList(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    let depth = 0;
    let cur = '';
    for (const ch of v) {
      if (ch === '{') depth++;
      else if (ch === '}' && depth > 0) depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
  }
  return out.map((g) => g.trim()).filter(Boolean);
}

/**
 * Every value a flag was given, in order: `Args.values` for a flag given more than once (cli.ts's
 * `parseArgs`), else the one value `flags` holds.
 */
export function flagValues(args: { flags: Record<string, string | true>; values?: Record<string, string[]> }, name: string): string[] {
  const all = args.values?.[name];
  if (all?.length) return all;
  const v = args.flags[name];
  return typeof v === 'string' ? [v] : [];
}

/** A seat added from the command line (`crossroom runner add`), checked as the file would be. */
export function seatFromFlags(o: {
  label: string;
  dir: string;
  runtime?: string;
  model?: string;
  description?: string;
  briefFile?: string;
  deny?: string[];
  review?: string[];
  unconfinedOk?: boolean;
}): SeatConfig {
  const r = SeatConfig.safeParse({
    label: o.label,
    dir: o.dir,
    runtime: o.runtime ?? 'claude',
    ...(o.model ? { model: o.model } : {}),
    ...(o.description ? { description: o.description } : {}),
    ...(o.briefFile ? { brief_file: o.briefFile } : {}),
    deny: [...DEFAULT_DENY, ...(o.deny ?? [])],
    ...(o.review?.length ? { review: { paths: o.review } } : {}),
    unconfined_reads: o.unconfinedOk ? 'acknowledged' : false,
  });
  if (!r.success) throw new ConfigError(issues(r.error));
  return r.data;
}
