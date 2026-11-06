/**
 * What a runner may post: the runner validates every effect against
 * `policy.effects.allow` before acting. Default deny: an effect is posted only when a rule of its
 * kind names its target, in every source of policy the runner has.
 *
 * The sources, each an `EffectsSection` (`{ allow: [...] }`):
 * - `effects.yml` under the runner's home, which the runner's operator writes on the runner's own
 *   machine. It is the base: without it, nothing is posted.
 * - the `effects` section of a repository's `.parley/policy.yml` on its default branch (runner/policy-yml.ts's
 *   reader), where a runner is given one. It can only narrow: an effect must be allowed there too.
 *
 * Nothing a relay sends can widen either: the effect names its kind and target, and the rules are
 * read here, on the runner. Where a post goes (the API host, the credentials) is never in the
 * effect at all (runner/effects/wire.ts).
 *
 * ```yaml
 * # effects.yml: what this runner may post for playbooks. Anything not listed is refused.
 * allow:
 *   - { kind: pr_comment, repos: [acme/payments-api] }
 *   - { kind: check_run, repos: ["acme/*"] }
 *   - { kind: slack_reply, channels: [C0123ABCD] }
 *   - { kind: linear_note, teams: [ENG] }
 *   - { kind: jira_note, projects: [PAY] }
 *   - { kind: pagerduty_note, services: [PABC123] }
 * watch:
 *   pull_requests: [acme/payments-api]   # polled every 60 s through the GitHub App
 * require_approval: [pr_comment, slack_reply]   # posted only as a person approved them at a gate
 * ```
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { LINE_BREAK } from '@parley/shared/text';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { EFFECT_KINDS, type EffectKindName, type EffectPayload, JIRA_ISSUE, LINEAR_ISSUE, PAGERDUTY_INCIDENT, SLACK_CHANNEL } from './wire.js';

/** `owner/repo`, or `owner/*` for every repository of one owner. */
const REPO_RULE = /^[A-Za-z0-9_.-]{1,100}\/(?:[A-Za-z0-9_.-]{1,100}|\*)$/;
const LINEAR_TEAM = /^[A-Z][A-Z0-9]{0,9}$/;
const JIRA_PROJECT = /^[A-Z][A-Z0-9_]{1,9}$/;
/** A Jira project key as a read names it (Jira allows one to fifty characters). */
const JIRA_READ_PROJECT = /^[A-Z][A-Z0-9_]{0,49}$/;
/** `org/project` or `org/*`: a project's name is anything but a slash or a control character, up to 64. */
const AZURE_PROJECT_RULE = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}\/(?:\*|[^/\x00-\x1f\x7f]{1,64})$/;

const list = (re: RegExp, what: string) => z.array(z.string().regex(re, what)).min(1).max(100);
const Repos = list(REPO_RULE, 'owner/repo, or owner/*');

/** One rule: a kind, and the targets of that kind it allows. Every rule names its targets; there is no "anywhere". */
export const AllowRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pr_comment'), repos: Repos }).strict(),
  z.object({ kind: z.literal('check_run'), repos: Repos }).strict(),
  z.object({ kind: z.literal('issue'), repos: Repos }).strict(),
  z.object({ kind: z.literal('slack_reply'), channels: list(SLACK_CHANNEL, "a Slack channel's id, such as C0123ABCD") }).strict(),
  z.object({ kind: z.literal('linear_note'), teams: list(LINEAR_TEAM, "a Linear team's key, such as ENG") }).strict(),
  z.object({ kind: z.literal('jira_note'), projects: list(JIRA_PROJECT, "a Jira project's key, such as PAY") }).strict(),
  z.object({ kind: z.literal('pagerduty_note'), services: list(PAGERDUTY_INCIDENT, "a PagerDuty service's id, such as PABC123") }).strict(),
  /**
   * Reading a tracker for a project (runner/reads.ts), never posting: GitHub repositories, Jira
   * projects (on the site `PARLEY_JIRA_SITE` names) and Azure DevOps projects (`org/project`, or
   * `org/*`, in the organization `PARLEY_AZURE_DEVOPS_ORG` names). At least one list.
   */
  z
    .object({
      kind: z.literal('tracker_read'),
      repos: Repos.optional(),
      jira: list(JIRA_READ_PROJECT, "a Jira project's key, such as PAY").optional(),
      azure: list(AZURE_PROJECT_RULE, 'an Azure DevOps organization/project, or organization/*').optional(),
    })
    .strict()
    .refine((r) => !!(r.repos || r.jira || r.azure), 'a tracker_read rule names repos, jira projects or azure projects'),
]);
export type AllowRule = z.infer<typeof AllowRule>;

/** The `effects:` section of a policy: what `.parley/policy.yml` v1 writes, and the body of `effects.yml`. */
export const EffectsSection = z.object({ allow: z.array(AllowRule).max(100) }).strict();
export type EffectsSection = z.infer<typeof EffectsSection>;

/** `effects.yml` under the runner's home. */
export const EffectsFile = z
  .object({
    version: z.literal(1).optional(),
    allow: z.array(AllowRule).max(100).default([]),
    /** Repositories whose pull requests the runner's GitHub App polls. */
    watch: z.object({ pull_requests: Repos.optional() }).strict().optional(),
    /**
     * Kinds this runner posts only when a person approved the effect at a gate:
     * an effect of one of them that arrives with no `approvedDigest` is refused `unapproved`. Off by
     * default, so a playbook with no gate posts as before.
     */
    require_approval: z
      .array(z.enum(EFFECT_KINDS as [EffectKindName, ...EffectKindName[]]))
      .max(EFFECT_KINDS.length)
      .optional(),
  })
  .strict();
export type EffectsFile = z.infer<typeof EffectsFile>;

export const EFFECTS_FILE = 'effects.yml';
export const EFFECTS_FILE_MAX = 64 * 1024;

export type LoadedEffects = { ok: true; file: EffectsFile | null } | { ok: false; error: string };

/**
 * `effects.yml`, read and checked. No file is `{ok: true, file: null}`, which allows nothing.
 * Anything wrong with it fails closed with the reason, for the operator: a runner never posts on
 * half a policy, and a misspelt key is a policy that allows nothing rather than one ignored.
 */
export function loadEffectsFile(home: string): LoadedEffects {
  const file = path.join(home, EFFECTS_FILE);
  if (!existsSync(file)) return { ok: true, file: null };
  try {
    if (statSync(file).size > EFFECTS_FILE_MAX) return { ok: false, error: `${EFFECTS_FILE} is larger than ${EFFECTS_FILE_MAX / 1024} KiB` };
    const raw = parseYaml(readFileSync(file, 'utf8'), { maxAliasCount: 0, uniqueKeys: true, prettyErrors: false });
    const r = EffectsFile.safeParse(raw ?? {});
    if (!r.success)
      return {
        ok: false,
        error: `${EFFECTS_FILE}: ${r.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`)
          .join('; ')}`,
      };
    return { ok: true, file: r.data };
  } catch (e) {
    return { ok: false, error: `${EFFECTS_FILE} could not be read: ${String((e as Error)?.message ?? e).split(LINE_BREAK)[0]!.slice(0, 200)}` };
  }
}

/** What only the service can say about a target, and a rule may need: a PagerDuty incident's service. */
export interface EffectFacts {
  pagerdutyService?: string;
}

export type EffectVerdictOnPolicy = { ok: true } | { ok: false; code: 'policy' | 'policy_unreadable'; rule: string };

const repoMatches = (rule: string, repo: string) => {
  const [ro, rr] = rule.toLowerCase().split('/') as [string, string];
  const [o, r] = repo.toLowerCase().split('/') as [string, string];
  return ro === o && (rr === '*' || rr === r);
};

/** Whether one rule allows this effect's target. */
function ruleAllows(rule: AllowRule, effect: Pick<EffectPayload, 'kind' | 'target'>, facts: EffectFacts): boolean {
  if (rule.kind !== effect.kind) return false;
  const t = effect.target as Record<string, unknown>;
  switch (rule.kind) {
    case 'pr_comment':
    case 'check_run':
    case 'issue':
      return typeof t.repo === 'string' && rule.repos.some((r) => repoMatches(r, t.repo as string));
    case 'slack_reply':
      return typeof t.channel === 'string' && rule.channels.includes(t.channel);
    case 'linear_note':
      return typeof t.issue === 'string' && LINEAR_ISSUE.test(t.issue) && rule.teams.includes(t.issue.slice(0, t.issue.indexOf('-')));
    case 'jira_note':
      return typeof t.issue === 'string' && JIRA_ISSUE.test(t.issue) && rule.projects.includes(t.issue.slice(0, t.issue.lastIndexOf('-')));
    case 'pagerduty_note':
      return !!facts.pagerdutyService && rule.services.includes(facts.pagerdutyService);
  }
}

/**
 * The sources a check reads, the base first: without the base (`effects.yml`, the runner
 * operator's), nothing is allowed, whatever a later source says, because a later source (a
 * repository's policy, which whoever can merge to its default branch writes) may only narrow.
 */
function sourcesOf<S extends { section: EffectsSection | null }>(sources: readonly S[]): S[] | null {
  const [base, ...later] = sources;
  if (!base?.section) return null;
  return [base, ...later.filter((s) => s.section)];
}

/**
 * Whether the runner may post this effect: the base source allows it, and so does every later
 * source there is. `rule` names what refused it (`effects.yml`, `.parley/policy.yml`), never a
 * target or a glob.
 */
export function checkEffect(
  effect: Pick<EffectPayload, 'kind' | 'target'>,
  sources: readonly { name: string; section: EffectsSection | null }[],
  facts: EffectFacts = {},
): EffectVerdictOnPolicy {
  const present = sourcesOf(sources);
  if (!present) return { ok: false, code: 'policy', rule: 'no_policy' };
  for (const s of present) if (!s.section!.allow.some((r) => ruleAllows(r, effect, facts))) return { ok: false, code: 'policy', rule: s.name };
  return { ok: true };
}

/** Whether every source has a rule for this kind at all, the base among them: the check before a service is asked anything about a target. */
export function kindAllowedAnywhere(kind: EffectKindName, sources: readonly { section: EffectsSection | null }[]): boolean {
  const present = sourcesOf(sources);
  return !!present && present.every((s) => s.section!.allow.some((r) => r.kind === kind));
}

// ---------------------------------------------------------------- reading a tracker

/** Where a read goes, as a `tracker_read` rule is written against it. */
export type ReadPlace = { provider: 'github'; repo: string } | { provider: 'jira'; project: string } | { provider: 'azure'; org: string; project: string };

/**
 * Whether `effects.yml` allows reading this place: a `tracker_read` rule names it. Only the base file
 * counts: a read is not a repository's effect, so a repository's own policy has no say. No file, or
 * no rule for that tracker, is `not_allowed`.
 */
export function checkTrackerRead(file: EffectsFile | null, place: ReadPlace): boolean {
  if (!file) return false;
  return file.allow.some((r) => {
    if (r.kind !== 'tracker_read') return false;
    if (place.provider === 'github') return !!r.repos?.some((x) => repoMatches(x, place.repo));
    if (place.provider === 'jira') return !!r.jira?.includes(place.project.toUpperCase());
    return !!r.azure?.some((x) => {
      const cut = x.indexOf('/');
      const project = x.slice(cut + 1);
      return x.slice(0, cut).toLowerCase() === place.org.toLowerCase() && (project === '*' || project.toLowerCase() === place.project.toLowerCase());
    });
  });
}
