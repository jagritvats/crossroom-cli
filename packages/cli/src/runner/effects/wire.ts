/**
 * Effects on runners (effects run only on runners): the wire between the relay,
 * which queues an effect a playbook asked for, and the team's runner, which posts it.
 *
 * The relay never posts anything and never holds a credential that could. It seals each
 * effect to one runner's X25519 key (`sealEffect`, runner/effects/seal.ts) and hands it over on
 * `POST /api/runner/effects/lease`; the runner opens it, checks it against its own policy
 * (`effects.yml`, runner/effects/policy.ts), posts it with credentials only it holds, and reports a
 * code on `POST /api/runner/effects/:id`. Nothing in a payload is ever a URL, a host or a
 * credential: where each kind posts is the runner's own configuration.
 *
 * Effects are at least once. The relay may hand the same effect over again (its lease ran out while
 * the runner was posting), so the runner deduplicates on the effect id: in its own store first, and
 * where the store cannot know (a crash between the post and the record), by the marker each post
 * carries (`effectMarker`).
 *
 * Pure: zod, the shared playbook patterns and node:crypto's hash (for `effectDigest`), so both
 * sides import it.
 */
import { createHash } from 'node:crypto';
import { JIRA_ISSUE, LINEAR_ISSUE, PAGERDUTY_INCIDENT, SLACK_CHANNEL, SLACK_THREAD, TRUSTED_VALUE } from '@parley/shared/playbook';
import { RunnerEvent, SlackReplyTarget } from '@parley/shared/runner';
import { z } from 'zod';

// The identifier patterns are the playbook contract's, which the relay checks a trigger's fields
// against on intake (`checkTriggerFields`): one definition, so the two sides never disagree.
export { JIRA_ISSUE, LINEAR_ISSUE, PAGERDUTY_INCIDENT, SLACK_CHANNEL };
/** A Slack message's timestamp, which names its thread (`SLACK_THREAD` in the playbook contract). */
export const SLACK_TS = SLACK_THREAD;

// ---------------------------------------------------------------- ids and limits

/** An effect's id: `eff_` and 22 characters of base64url, derived from its run's step (`effectIdFor`). */
export const EFFECT_ID = /^eff_[A-Za-z0-9_-]{22}$/;

/** What every post carries, so a runner that crashed between posting and recording finds it again. */
export const effectMarker = (effectId: string) => `<!-- parley-effect:${effectId} -->`;
/** The same, as plain text, for services that print an HTML comment as it stands (Linear, Jira, PagerDuty, Slack). */
export const effectTag = (effectId: string) => `parley-effect:${effectId}`;

/** The longest body an effect carries: under GitHub's comment limit (65,536) with room for the marker. */
export const EFFECT_TEXT_MAX = 60_000;
/** The longest sealed effect the relay queues and the runner opens. */
export const EFFECT_SEALED_MAX = 256 * 1024;
/** How long an effect stays worth posting. Older, the relay cancels it and the runner refuses it (`stale`). */
export const EFFECT_TTL_HOURS = 24;
/** How far ahead of the runner's clock an effect may say it was issued before it is refused (`future`). */
export const EFFECT_CLOCK_SKEW_MS = 5 * 60_000;
/** Leases one effect may take before the relay gives up on it (`failed:lease_exhausted`). */
export const EFFECT_MAX_ATTEMPTS = 6;
/** How long a leased effect is the runner's before the relay may hand it over again. */
export const EFFECT_LEASE_S = 120;
/** What a lease parks for, and its bounds, in seconds. */
export const EFFECT_LEASE_WAIT_S = { default: 45, min: 5, max: 50 } as const;
/** Effects one runner may have queued at once. Past it, the relay records the effect failed rather than queue it. */
export const EFFECTS_QUEUED_PER_RUNNER = 200;
/** Effect leases one runner may have parked at once. */
export const EFFECT_LEASES_PARKED_PER_RUNNER = 2;

// ---------------------------------------------------------------- targets

/** `owner/repo` as a trigger's field is checked, and never `.` or `..`, which a URL would read as a path step. */
const Repo = z
  .string()
  .regex(TRUSTED_VALUE['trigger.repo'])
  .refine((r) => r.split('/').every((s) => s !== '.' && s !== '..'), 'a repository is owner/name');
/** A check run needs the whole commit sha: 40 hex characters (SHA-1), or 64 (SHA-256). */
export const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// Slack's ids (a channel, `C…`, `G…`, `D…`, and a message timestamp, `1712345678.123456`), a
// Linear issue (`ENG-123`), a Jira issue (`PAY-42`) and a PagerDuty incident (`PT4KHLK`) are the
// playbook contract's patterns, re-exported above.

export const PrCommentTarget = z.object({ repo: Repo, number: z.number().int().min(1).max(2_147_483_647) }).strict();
export const CheckRunTarget = z.object({ repo: Repo, sha: z.string().regex(FULL_SHA) }).strict();
export const IssueTarget = z.object({ repo: Repo }).strict();
/**
 * A reply in a mention's thread; a slash command has no message to thread under, so its reply goes
 * to the channel. The same shape a runner's Slack event carries (`@parley/shared/runner`).
 */
export { SlackReplyTarget };
export const LinearNoteTarget = z.object({ issue: z.string().regex(LINEAR_ISSUE) }).strict();
export const JiraNoteTarget = z.object({ issue: z.string().regex(JIRA_ISSUE) }).strict();
export const PagerDutyNoteTarget = z.object({ incident: z.string().regex(PAGERDUTY_INCIDENT) }).strict();

/** Each kind's target, by kind: the only place an effect says where it goes, and never as a URL. */
export const TARGETS = {
  pr_comment: PrCommentTarget,
  check_run: CheckRunTarget,
  issue: IssueTarget,
  slack_reply: SlackReplyTarget,
  linear_note: LinearNoteTarget,
  jira_note: JiraNoteTarget,
  pagerduty_note: PagerDutyNoteTarget,
} as const;
export type EffectKindName = keyof typeof TARGETS;
export const EFFECT_KINDS = Object.keys(TARGETS) as EffectKindName[];
export type EffectTarget<K extends EffectKindName = EffectKindName> = z.infer<(typeof TARGETS)[K]>;

/** Which kinds post to GitHub, and so need the runner's GitHub App. */
export const GITHUB_KINDS: readonly EffectKindName[] = ['pr_comment', 'check_run', 'issue'];

// ---------------------------------------------------------------- the payload

export const EffectVerdict = z.enum(['pass', 'fail', 'neutral']);
export type EffectVerdict = z.infer<typeof EffectVerdict>;

const Common = {
  v: z.literal(1),
  /** The id the effect is queued under: the runner refuses a payload whose id is not its envelope's. */
  effectId: z.string().regex(EFFECT_ID),
  runnerId: z.string().min(1).max(64),
  verdict: EffectVerdict,
  /** The playbook's name (`PLAYBOOK_NAME`), for the check run's name and the title. */
  playbook: z.string().regex(/^[a-z0-9-]{1,40}$/),
  /** Crossroom's words, with trusted values only: an issue's title, a check run's title. */
  title: z.string().min(1).max(200),
  /** The body: the room's digest (already through `inline` and `quote`), or Crossroom's verdict line. */
  text: z.string().min(1).max(EFFECT_TEXT_MAX),
  /** The relay's public URL: the runner refuses an effect naming any relay but the one it registered with. */
  relay: z.string().url().max(512),
  issuedAt: z.string().datetime(),
  /**
   * Present when a person approved this effect at a gate: the `effectDigest` of exactly what they
   * read. The runner recomputes it over the payload and refuses a difference (`digest_mismatch`);
   * a kind its `effects.yml` lists under `require_approval` is refused without it (`unapproved`).
   */
  approvedDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
};

/** An effect as the runner opens it (`openEffect`). Sealed to its X25519 key; the relay keeps only the ciphertext. */
export const EffectPayload = z.discriminatedUnion('kind', [
  z.object({ ...Common, kind: z.literal('pr_comment'), target: PrCommentTarget }).strict(),
  z.object({ ...Common, kind: z.literal('check_run'), target: CheckRunTarget }).strict(),
  z.object({ ...Common, kind: z.literal('issue'), target: IssueTarget }).strict(),
  z.object({ ...Common, kind: z.literal('slack_reply'), target: SlackReplyTarget }).strict(),
  z.object({ ...Common, kind: z.literal('linear_note'), target: LinearNoteTarget }).strict(),
  z.object({ ...Common, kind: z.literal('jira_note'), target: JiraNoteTarget }).strict(),
  z.object({ ...Common, kind: z.literal('pagerduty_note'), target: PagerDutyNoteTarget }).strict(),
]);
export type EffectPayload = z.infer<typeof EffectPayload>;

// ---------------------------------------------------------------- what a gate approves

/** The parts of an effect a person approves at a gate: what it posts, where, and with which verdict. */
export interface EffectApprovalParts {
  kind: EffectKindName;
  target: Readonly<Record<string, string | number>>;
  verdict: EffectVerdict;
  title: string;
  text: string;
}

const EFFECT_DIGEST_DOMAIN = 'parley/effect-approval/v1';
const GATE_PAYLOAD_DOMAIN = 'parley/gate-payload/v1';

/** A target's fields in key order, so two encodings of one target digest alike. Targets are flat. */
const sortedTarget = (t: Readonly<Record<string, string | number>>) => Object.fromEntries(Object.keys(t).sort().map((k) => [k, t[k]]));

/**
 * The digest of one effect as a person approves it at a gate (sha256, lowercase hex): the relay
 * stores it when the gate opens and checks it again before posting, and the runner recomputes it
 * over the payload it opened (`approvedDigest`). One function on both sides, so they never disagree;
 * a test vector holds both to it. Over the kind, the target (keys sorted), the verdict,
 * the title and the text, each exactly as posted.
 */
export function effectDigest(p: EffectApprovalParts): string {
  const encoded = JSON.stringify([EFFECT_DIGEST_DOMAIN, p.kind, sortedTarget(p.target), p.verdict, p.title, p.text]);
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

/** The digest of a gate's whole payload (`run_steps.payload_digest`), which a decision names: each effect's step and digest, in step order. */
export function gatePayloadDigest(effects: readonly { idx: number; digest: string }[]): string {
  const ordered = [...effects].sort((a, b) => a.idx - b.idx).map((e) => [e.idx, e.digest]);
  return createHash('sha256').update(JSON.stringify([GATE_PAYLOAD_DOMAIN, ordered]), 'utf8').digest('hex');
}

// ---------------------------------------------------------------- results

/**
 * What became of an effect, as a code: `effects.result` holds `<state>:<code>` (`refused:policy`),
 * or `posted` alone. Never a sentence, so neither side's errors, paths or tokens cross in words.
 *
 * The runner: `posted`, `duplicate` (it had posted it already); refusals `bad_seal`,
 * `envelope_mismatch`, `wrong_relay`, `stale`, `future`, `policy`, `policy_unreadable`, `kind_off`
 * (a kind this runner does not post, such as Slack while it is dormant), `digest_mismatch` (an
 * approved effect whose payload is not what was approved), `unapproved` (a kind its `effects.yml`
 * requires approval for, arriving without one); failures `not_configured`,
 * `auth`, `forbidden`, `not_found`, `rejected`, `rate_limited`, `network`, `error`.
 * The relay: `lease_exhausted`, `runner_unknown`, `runner_not_allowed`, `queue_full`, `kind_off`,
 * `stale`, `room_deleted`, `e2ee_room` (a digest the relay cannot write, since it cannot read the
 * room), `runner_revoked`.
 */
export const EffectCode = z.enum([
  'posted',
  'duplicate',
  'bad_seal',
  'envelope_mismatch',
  'wrong_relay',
  'stale',
  'future',
  'policy',
  'policy_unreadable',
  'kind_off',
  'not_configured',
  'auth',
  'forbidden',
  'not_found',
  'rejected',
  'rate_limited',
  'network',
  'error',
  'lease_exhausted',
  'runner_unknown',
  'runner_not_allowed',
  'queue_full',
  'room_deleted',
  'e2ee_room',
  'runner_revoked',
  'digest_mismatch',
  'unapproved',
]);
export type EffectCode = z.infer<typeof EffectCode>;

/** The codes a runner reports for each state. */
export const RUNNER_POSTED: readonly EffectCode[] = ['posted', 'duplicate'];
export const RUNNER_REFUSALS: readonly EffectCode[] = [
  'bad_seal',
  'envelope_mismatch',
  'wrong_relay',
  'stale',
  'future',
  'policy',
  'policy_unreadable',
  'kind_off',
  'digest_mismatch',
  'unapproved',
];
export const RUNNER_FAILURES: readonly EffectCode[] = ['not_configured', 'auth', 'forbidden', 'not_found', 'rejected', 'rate_limited', 'network', 'error'];

/** `effects.result` as stored: `posted` for a plain post, `<state>:<code>` for anything else. */
export const resultOf = (state: 'posted' | 'refused' | 'failed' | 'cancelled', code: EffectCode) =>
  state === 'posted' && code === 'posted' ? 'posted' : `${state}:${code}`;

// ---------------------------------------------------------------- the routes

/** `POST /api/runner/effects/lease`: park for up to `waitS` for at most `max` effects. */
export const EffectLeaseInput = z
  .object({
    waitS: z.number().int().min(EFFECT_LEASE_WAIT_S.min).max(EFFECT_LEASE_WAIT_S.max).optional(),
    max: z.number().int().min(1).max(10).optional(),
  })
  .strict();
export type EffectLeaseInput = z.infer<typeof EffectLeaseInput>;

/** An effect as a lease hands it over. `payload` is the sealed string, opaque to the relay. */
export const LeasedEffect = z
  .object({
    id: z.string().regex(EFFECT_ID),
    kind: z.enum(EFFECT_KINDS as [EffectKindName, ...EffectKindName[]]),
    payload: z.string().min(1).max(EFFECT_SEALED_MAX),
    createdAt: z.string(),
    leaseUntil: z.string(),
  })
  .strict();
export type LeasedEffect = z.infer<typeof LeasedEffect>;
export interface EffectLeaseResult {
  effects: LeasedEffect[];
}

/** `POST /api/runner/effects/:id`: what the runner did with one of its effects. */
export const EffectReportInput = z
  .object({ state: z.enum(['posted', 'refused', 'failed']), code: EffectCode })
  .strict()
  .superRefine((r, ctx) => {
    const allowed = r.state === 'posted' ? RUNNER_POSTED : r.state === 'refused' ? RUNNER_REFUSALS : RUNNER_FAILURES;
    if (!allowed.includes(r.code)) ctx.addIssue({ code: 'custom', path: ['code'], message: `a ${r.state} effect names one of: ${allowed.join(', ')}` });
  });
export type EffectReportInput = z.infer<typeof EffectReportInput>;
export interface EffectReportResult {
  ok: true;
  effect: { id: string; state: string; result: string | null };
  /** The relay withdrew the effect meanwhile (its room deleted, say): do not post it. */
  cancel?: boolean;
}

/**
 * The one 404 for an effect this runner cannot see: no such effect, or another runner's. The same
 * words as a job's (`JOB_GONE`), on purpose: to a runner, an id that names nothing
 * of its own is one answer on every route, whether it looks like a job's or an effect's.
 */
export const EFFECT_GONE = 'no such job for this runner';

// ---------------------------------------------------------------- what a runner reports seeing

/**
 * An event a runner saw (`on: runner`): a pull request its GitHub App's poll found, a
 * slash command or a mention its Slack app received. The wire's one schema lives in
 * `@parley/shared/runner`, which the relay's trigger parses what it receives with.
 */
export { RunnerEvent };
