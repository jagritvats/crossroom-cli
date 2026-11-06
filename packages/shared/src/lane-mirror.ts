/**
 * Setting up a lane's tracker mirror and chat notices (`@parley/shared/lane-mirror`): what the web
 * app's Connect your tools dialog and `crossroom lane ci` both print. The mirror itself
 * (`crossroom lane mirror`) runs on the person's machine or in their CI, with their
 * own token: nothing here holds, asks for or sends a credential. It only writes text for the person
 * to copy: `.crossroom/lane-mirror.yml` (which the mirror's `loadMirrorConfig` reads), the commands
 * that run it, and the scheduled CI jobs, each naming the secret it needs.
 *
 * No zod, so the web app imports it as it is.
 */
import { LANE_STATES, type LaneState, type LaneVia } from './lane.js';

/** A tracker the mirror keeps an issue per item in. The same names as a lane item's `via`. */
export type MirrorProvider = LaneVia;
export const MIRROR_PROVIDERS: readonly MirrorProvider[] = ['github', 'linear', 'jira', 'azure'];

/** Where chat notices of what moved go. */
export type NotifyKind = 'slack' | 'teams';
export const NOTIFY_KINDS: readonly NotifyKind[] = ['slack', 'teams'];

/** An environment variable or CI secret, and where a person gets its value. */
export interface SecretNeed {
  name: string;
  what: string;
}

/** What the setup dialog says of each tracker, and what its settings take. */
export interface ProviderInfo {
  name: string;
  /** What `target` names, for its field's label. */
  targetLabel: string;
  targetPlaceholder: string;
  targetHint: string;
  /** A target as the mirror takes it, or why not. */
  targetProblem: (target: string) => string | null;
  /** Whether a `site` is needed (Jira), offered (Azure DevOps) or has no meaning. */
  site: 'required' | 'optional' | 'none';
  sitePlaceholder?: string;
  /** The token on the person's machine: the variables `crossroom lane mirror` reads. */
  token: SecretNeed[];
  /** Another way to give it, said beside the variables. */
  tokenAlso?: string;
  /** The lane states the mirror moves an issue to, and the tracker's word for each by default. */
  states: 'none' | 'optional' | 'required';
  defaultStates?: Readonly<Partial<Record<LaneState, string>>>;
  /** What `stateMap` names in this tracker. */
  stateWord?: string;
  /** What `trusted` takes here, for inbound. */
  trustedHint: string;
}

const LINEAR_STATES: Readonly<Record<LaneState, string>> = {
  open: 'Todo',
  working: 'In Progress',
  needs_info: 'Todo',
  fixed: 'In Review',
  answered: 'In Review',
  wont_fix: 'Canceled',
  closed: 'Done',
};
const AZURE_STATES: Readonly<Record<LaneState, string>> = {
  open: 'New',
  working: 'Active',
  needs_info: 'Active',
  fixed: 'Resolved',
  answered: 'Resolved',
  wont_fix: 'Removed',
  closed: 'Closed',
};

export const PROVIDER_INFO: Readonly<Record<MirrorProvider, ProviderInfo>> = {
  github: {
    name: 'GitHub Issues',
    targetLabel: 'Repository',
    targetPlaceholder: 'acme/api',
    targetHint: 'owner/repo: where the issues go.',
    targetProblem: (t) => (/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(t) ? null : 'Name it as owner/repo, such as acme/api.'),
    site: 'none',
    token: [{ name: 'GITHUB_TOKEN', what: 'A fine-grained token with Issues read and write on the repository.' }],
    tokenAlso: 'or sign in with gh auth login',
    states: 'none',
    trustedHint: 'GitHub user ids or logins. Without a list, anyone with push access is trusted.',
  },
  linear: {
    name: 'Linear',
    targetLabel: 'Team key',
    targetPlaceholder: 'ENG',
    targetHint: 'The key in front of the team’s issue numbers (ENG-12).',
    targetProblem: (t) => (/^[A-Za-z0-9_-]{1,20}$/.test(t) ? null : 'A team key is a short word, such as ENG.'),
    site: 'none',
    token: [{ name: 'LINEAR_API_KEY', what: 'Linear: Settings, Security and access, Personal API keys.' }],
    states: 'optional',
    defaultStates: LINEAR_STATES,
    stateWord: 'workflow state',
    trustedHint: 'Linear user ids or display names. Without a list, any member who is not a guest is trusted.',
  },
  jira: {
    name: 'Jira',
    targetLabel: 'Project key',
    targetPlaceholder: 'PROJ',
    targetHint: 'The key in front of the project’s issue numbers (PROJ-7).',
    targetProblem: (t) => (/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(t) ? null : 'A project key is letters and digits, such as PROJ.'),
    site: 'required',
    sitePlaceholder: 'https://acme.atlassian.net',
    token: [
      { name: 'JIRA_EMAIL', what: 'The email of the Atlassian account the token belongs to.' },
      { name: 'JIRA_API_TOKEN', what: 'id.atlassian.com, Security, API tokens.' },
    ],
    states: 'required',
    stateWord: 'transition',
    trustedHint: 'Atlassian accountIds. Jira can’t tell who may edit issues without admin rights, so list who to trust.',
  },
  azure: {
    name: 'Azure DevOps',
    targetLabel: 'Organization/project',
    targetPlaceholder: 'acme/Payments',
    targetHint: 'The organization and the project, as in dev.azure.com/acme/Payments.',
    targetProblem: (t) => (/^[^/\s]+\/[^/]+$/.test(t.trim()) ? null : 'Name it as organization/project.'),
    site: 'optional',
    sitePlaceholder: 'https://dev.azure.com',
    token: [{ name: 'AZURE_DEVOPS_PAT', what: 'A personal access token with Work Items read and write.' }],
    tokenAlso: 'or, in Azure Pipelines, the pipeline’s own SYSTEM_ACCESSTOKEN',
    states: 'optional',
    defaultStates: AZURE_STATES,
    stateWord: 'state',
    trustedHint: 'Azure DevOps user ids or unique names. Without a list, anyone who can write work items is trusted.',
  },
};

export const NOTIFY_INFO: Readonly<Record<NotifyKind, { name: string; env: SecretNeed }>> = {
  slack: { name: 'Slack', env: { name: 'CROSSROOM_SLACK_WEBHOOK', what: 'A Slack incoming webhook URL (hooks.slack.com) for the channel.' } },
  teams: { name: 'Microsoft Teams', env: { name: 'CROSSROOM_TEAMS_WEBHOOK', what: 'A Teams Workflows URL ("Post to a channel when a webhook request is received").' } },
};

/** The lane states a mirror moves an issue between, in the order a setup form lists them. */
export const MIRROR_STATES: readonly LaneState[] = LANE_STATES;

/**
 * Whether `site` is the vendor's own cloud, which a committed `.crossroom/lane-mirror.yml` may name
 * (the mirror's `loadMirrorConfig`): any other address comes from `--site` or
 * `CROSSROOM_TRACKER_SITE`, so an edit to the file can't send the token elsewhere.
 */
export function cloudSite(provider: string, site: string): boolean {
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const sub = (suffix: string) => h.endsWith(suffix) && label.test(h.slice(0, -suffix.length));
  if (provider === 'jira') return sub('.atlassian.net') || (h === 'api.atlassian.com' && /^\/ex\/jira\/[A-Za-z0-9-]+\/?$/.test(u.pathname));
  if (provider === 'azure') return h === 'dev.azure.com' || sub('.visualstudio.com');
  return false;
}

/** A mirror's settings as the setup form holds them. Only what differs from the mirror's defaults is written. */
export interface MirrorSetup {
  provider: MirrorProvider;
  target: string;
  /** Jira's site, or Azure DevOps' when it is not dev.azure.com. */
  site?: string;
  /** The label (an Azure tag) that marks an issue as the lane's. Default `crossroom`. */
  label?: string;
  /** Which items go out, from the side that runs the mirror: the other side's (default), its own, or all. */
  items?: 'theirs' | 'mine' | 'all';
  /** Mirror item bodies and note text, not only titles and states. */
  body?: boolean;
  /** Bring labelled issues and trusted comments in. */
  inbound?: boolean;
  /** Whose issues and comments come in, by an id nobody else can take. */
  trusted?: string[];
  /** Lane state to the tracker's word (a Jira transition, a Linear or Azure state). Empty entries are left out. */
  stateMap?: Partial<Record<LaneState, string>>;
}

/** Why a setup can't be written yet, or null when it can. */
export function setupProblem(s: MirrorSetup): string | null {
  const info = PROVIDER_INFO[s.provider];
  const target = s.target.trim();
  if (!target) return `Name the ${info.targetLabel.toLowerCase()}.`;
  const t = info.targetProblem(target);
  if (t) return t;
  const site = s.site?.trim() ?? '';
  if (info.site === 'required' && !site) return 'Name the Jira site, such as https://acme.atlassian.net.';
  if (site && !cloudSite(s.provider, site))
    return s.provider === 'jira'
      ? 'The site is Jira Cloud: https://<site>.atlassian.net. For Jira Data Center, leave it here and give the address as CROSSROOM_TRACKER_SITE where the mirror runs.'
      : 'The site is https://dev.azure.com or https://<organization>.visualstudio.com. For Azure DevOps Server, give the address as CROSSROOM_TRACKER_SITE where the mirror runs.';
  if (info.states === 'required' && !MIRROR_STATES.some((k) => s.stateMap?.[k]?.trim())) return 'Name the Jira transition for at least one lane state: the mirror never guesses one.';
  return null;
}

const RESERVED = /^(?:true|false|yes|no|on|off|null|y|n|~)$/i;

/** A value as a YAML scalar: plain where that reads the same, quoted (as JSON, which YAML reads) otherwise. */
export function yamlScalar(v: string): string {
  if (/^[A-Za-z_][A-Za-z0-9 ._/@-]*$/.test(v) && !/ $/.test(v) && !RESERVED.test(v)) return v;
  if (/^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._/-]*)?$/.test(v)) return v;
  return JSON.stringify(v);
}

/** `.crossroom/lane-mirror.yml` for a setup: committed with the repository, never holding a token. */
export function mirrorYaml(s: MirrorSetup): string {
  const lines = [
    `# Crossroom lane mirror: an issue in ${PROVIDER_INFO[s.provider].name} for each lane item, kept in step.`,
    '# Tokens come from the environment only, never this file.',
    `provider: ${s.provider}`,
    `target: ${yamlScalar(s.target.trim())}`,
  ];
  const site = s.site?.trim();
  if (site) lines.push(`site: ${yamlScalar(site.replace(/\/+$/, ''))}`);
  lines.push(`label: ${yamlScalar(s.label?.trim() || 'crossroom')}`);
  lines.push(`items: ${s.items ?? 'theirs'}`);
  lines.push(`body: ${s.body ? 'true' : 'false'}`);
  lines.push(`inbound: ${s.inbound ? 'true' : 'false'}`);
  const trusted = (s.trusted ?? []).map((t) => t.trim()).filter(Boolean);
  if (s.inbound && trusted.length) lines.push(`trusted: [${trusted.map((t) => (/^\d+$/.test(t) ? JSON.stringify(t) : yamlScalar(t))).join(', ')}]`);
  const states = MIRROR_STATES.filter((k) => s.stateMap?.[k]?.trim());
  if (s.provider !== 'github' && states.length) {
    lines.push('stateMap:');
    for (const k of states) lines.push(`  ${k}: ${yamlScalar(s.stateMap![k]!.trim())}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The variables the mirror (and notify) read where they run on the person's machine. */
export function localSecrets(provider: MirrorProvider | null, notify: NotifyKind | null): SecretNeed[] {
  return [...(provider ? PROVIDER_INFO[provider].token : []), ...(notify ? [NOTIFY_INFO[notify].env] : [])];
}

/** The commands that run the mirror and notify, in the repository of the side that runs them: a dry run first. */
export function mirrorCommands(o: { mirror?: boolean; notify: NotifyKind | null; every?: boolean }): string[] {
  const every = o.every ? ' --every 3600' : '';
  return [
    ...(o.mirror === false ? [] : ['crossroom lane mirror --dry-run', `crossroom lane mirror${every}`]),
    ...(o.notify ? [`crossroom lane notify${every}`] : []),
  ];
}

/** Where the CI recipes keep `crossroom`'s data (the mirror's and notify's state), relative to the workspace. */
export const CI_STATE_DIR = '.crossroom-lane-state';

export type CiKind = 'github' | 'azure';

/** What a CI job is given: the tracker it mirrors to, and the chat it posts to, either of them none. */
export interface CiOptions {
  provider: MirrorProvider | null;
  notify: NotifyKind | null;
}

/** The tracker's token in a GitHub Actions step's `env`. The workflow's own token for GitHub Issues. */
const GHA_TOKENS: Readonly<Record<MirrorProvider, string[]>> = {
  github: ['GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}'],
  linear: ['LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}'],
  jira: ['JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}', 'JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}'],
  azure: ['AZURE_DEVOPS_PAT: ${{ secrets.AZURE_DEVOPS_PAT }}'],
};
/** The same in an Azure Pipelines script's `env`: secret variables, or the pipeline's own token for Azure DevOps. */
const AZP_TOKENS: Readonly<Record<MirrorProvider, string[]>> = {
  github: ['GITHUB_TOKEN: $(GITHUB_TOKEN)'],
  linear: ['LINEAR_API_KEY: $(LINEAR_API_KEY)'],
  jira: ['JIRA_EMAIL: $(JIRA_EMAIL)', 'JIRA_API_TOKEN: $(JIRA_API_TOKEN)'],
  azure: ['SYSTEM_ACCESSTOKEN: $(System.AccessToken)'],
};

/** A scheduled GitHub Actions workflow that runs the mirror, and notify when its webhook secret is set. */
export function githubActionsWorkflow(o: CiOptions = { provider: 'github', notify: 'slack' }): string[] {
  const hook = o.notify ? NOTIFY_INFO[o.notify].env.name : null;
  return [
    '# .github/workflows/crossroom-lane.yml',
    'name: crossroom lane',
    'on:',
    '  schedule: [{ cron: "17 * * * 1-5" }]',
    '  workflow_dispatch: {}',
    o.provider === 'github' ? 'permissions: { contents: read, issues: write }' : 'permissions: { contents: read }',
    'concurrency: { group: crossroom-lane, cancel-in-progress: false }',
    'jobs:',
    '  mirror:',
    '    runs-on: ubuntu-latest',
    '    env:',
    `      PARLEY_DATA: \${{ github.workspace }}/${CI_STATE_DIR}`,
    ...(hook ? [`      ${hook}: \${{ secrets.${hook} }}`] : []),
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with: { fetch-depth: 100 }',
    '      - uses: actions/cache/restore@v4',
    '        with:',
    `          path: ${CI_STATE_DIR}`,
    '          key: crossroom-lane-${{ github.run_id }}',
    '          restore-keys: crossroom-lane-',
    '      - uses: actions/setup-node@v4',
    '        with: { node-version: 22 }',
    ...(o.provider
      ? [
          '      - run: npx --yes crossroom lane mirror',
          '        env:',
          '          CROSSROOM_LANE_LINK: ${{ secrets.CROSSROOM_LANE_LINK }}',
          ...GHA_TOKENS[o.provider].map((l) => `          ${l}`),
        ]
      : []),
    ...(hook
      ? ['      - run: npx --yes crossroom lane notify', `        if: env.${hook} != ''`, '        env:', '          CROSSROOM_LANE_LINK: ${{ secrets.CROSSROOM_LANE_LINK }}']
      : []),
    '      - uses: actions/cache/save@v4',
    '        if: always()',
    '        with:',
    `          path: ${CI_STATE_DIR}`,
    '          key: crossroom-lane-${{ github.run_id }}',
  ];
}

/** A scheduled Azure Pipelines job that runs the mirror, and notify when its webhook variable is set. */
export function azurePipeline(o: CiOptions = { provider: 'azure', notify: 'teams' }): string[] {
  const hook = o.notify ? NOTIFY_INFO[o.notify].env.name : null;
  return [
    '# azure-pipelines-crossroom-lane.yml',
    'trigger: none',
    'schedules:',
    '  - cron: "17 * * * 1-5"',
    '    branches: { include: [main] }',
    '    always: true',
    'pool: { vmImage: ubuntu-latest }',
    'variables:',
    `  PARLEY_DATA: $(Pipeline.Workspace)/${CI_STATE_DIR}`,
    'steps:',
    '  - checkout: self',
    '    fetchDepth: 100',
    '  - task: Cache@2',
    '    inputs:',
    "      key: '\"crossroom-lane\" | \"$(Build.BuildId)\"'",
    "      restoreKeys: '\"crossroom-lane\"'",
    '      path: $(PARLEY_DATA)',
    '  - task: NodeTool@0',
    "    inputs: { versionSpec: '22.x' }",
    ...(o.provider
      ? ['  - script: npx --yes crossroom lane mirror', '    env:', '      CROSSROOM_LANE_LINK: $(CROSSROOM_LANE_LINK)', ...AZP_TOKENS[o.provider].map((l) => `      ${l}`)]
      : []),
    ...(hook
      ? [
          '  - script: npx --yes crossroom lane notify',
          `    condition: and(succeeded(), ne(variables['${hook}'], ''))`,
          '    env:',
          '      CROSSROOM_LANE_LINK: $(CROSSROOM_LANE_LINK)',
          `      ${hook}: $(${hook})`,
        ]
      : []),
  ];
}

/** The secrets a CI job needs, by the names its recipe reads, beyond what the CI gives it already. */
export function ciSecrets(ci: CiKind, o: CiOptions): SecretNeed[] {
  const link: SecretNeed = { name: 'CROSSROOM_LANE_LINK', what: 'The lane link of the side whose repository runs the job.' };
  // GitHub Actions gives a workflow a token for its own repository's issues, and Azure Pipelines one for its project's work items.
  const tracker = !o.provider || ci === o.provider ? [] : PROVIDER_INFO[o.provider].token;
  return [link, ...tracker, ...(o.notify ? [NOTIFY_INFO[o.notify].env] : [])];
}

/** The CI recipes: a scheduled GitHub Actions workflow and an Azure Pipelines one, with every secret from the CI's store and the state kept between runs in the CI's cache. */
export function ciRecipes(): string {
  return [
    'Run the mirror (and, if you like, notify) on a schedule in CI. The lane link and every token are',
    "secrets: store them in the CI's secret store, never in the repository. CROSSROOM_LANE_LINK is the",
    'link of the side whose repository runs the workflow: `crossroom lane list` there prints it. Notify',
    'runs only when its webhook secret is set.',
    '',
    ...githubActionsWorkflow(),
    '',
    ...azurePipeline(),
    '',
    `The cache carries PARLEY_DATA (${CI_STATE_DIR}) from one run to the next: the mirror's and notify's`,
    'state: issue numbers, versions, the links already attached and digests of titles, never a token.',
    'A new key each run, restored by its prefix, keeps the latest. Azure saves the cache only after a job that',
    'succeeded. When the cache misses, the mirror finds each issue by its marker and takes what it',
    'already shows as done, and notify only notes where things stand, but comments copied in during the',
    'last day may be looked at again. The settings come from .crossroom/lane-mirror.yml, committed with',
    'no token in it.',
  ].join('\n');
}
