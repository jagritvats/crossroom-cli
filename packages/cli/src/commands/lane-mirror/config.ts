/**
 * Where `crossroom lane mirror` reads its settings and its token.
 *
 * Settings: `.crossroom/lane-mirror.yml` in the repository (or `--config <file>`), then flags. The
 * file names the tracker and how lane words map to it; it never holds a token, and a `token` key in
 * it is refused, so one is never committed by mistake.
 *
 * ```yaml
 * provider: github          # github | linear | jira | azure
 * target: acme/api          # owner/repo | team key | project key | organization/project
 * site: https://acme.atlassian.net   # Jira Cloud, or https://dev.azure.com for Azure DevOps
 * browse: https://acme.atlassian.net # Jira, when site is api.atlassian.com/ex/jira/<cloudId>
 * label: crossroom          # marks an issue as the lane's, both ways
 * labels: [from-frontend]
 * items: theirs             # theirs | mine | all
 * body: false               # mirror item bodies and note text
 * inbound: false            # bring labelled issues and trusted comments in
 * withdrawOnClose: false
 * trailers: true            # read Fixes-Lane: L<n> from the default branch
 * kindMap: { bug: Bug }
 * stateMap: { fixed: Resolve, closed: Close }
 * trusted: []               # ids whose words come in, in place of the tracker's check
 * ```
 *
 * The file is committed, so anyone who can open a pull request can edit it. A `site` in it is taken
 * only when it is the vendor's own cloud (`https://<x>.atlassian.net` or `https://api.atlassian.com`
 * for Jira, `https://dev.azure.com` or `https://<x>.visualstudio.com` for Azure DevOps): a Jira Data
 * Center or Azure DevOps Server address comes from `--site` or `CROSSROOM_TRACKER_SITE`, so an edit
 * to the file can't send the token somewhere else.
 *
 * Tokens come from the environment only: `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`;
 * `LINEAR_API_KEY`; `JIRA_EMAIL` with `JIRA_API_TOKEN`; `AZURE_DEVOPS_PAT` or
 * `AZURE_DEVOPS_EXT_PAT`, else Azure Pipelines' `SYSTEM_ACCESSTOKEN`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LANE_KINDS, LANE_STATES } from '@parley/shared/lane';
import { cloudSite } from '@parley/shared/lane-mirror';
import { parse as parseYaml } from 'yaml';
import { Usage } from '../../cli.js';
import { azureAdapter } from './azure.js';
import { githubAdapter } from './github.js';
import { jiraAdapter } from './jira.js';
import { linearAdapter } from './linear.js';
import { type AdapterOptions, type MirrorConfig, PROVIDERS, type Provider, type TrackerAdapter } from './types.js';

export const CONFIG_FILE = path.join('.crossroom', 'lane-mirror.yml');

const KEYS = ['provider', 'target', 'site', 'browse', 'label', 'labels', 'items', 'body', 'inbound', 'withdrawOnClose', 'trailers', 'kindMap', 'stateMap', 'trusted'];

const strings = (v: unknown, what: string): string[] => {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  if (!list.every((x) => typeof x === 'string' || typeof x === 'number')) throw new Usage(`${what} is a list of names.`);
  return list.map((x) => String(x).trim()).filter(Boolean);
};

function map<K extends string>(v: unknown, keys: readonly K[], what: string): Partial<Record<K, string>> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Usage(`${what} maps ${keys.join(', ')} to names.`);
  const out: Partial<Record<K, string>> = {};
  for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
    if (!(keys as readonly string[]).includes(k)) throw new Usage(`${what} has no ${k}: it takes ${keys.join(', ')}.`);
    if (typeof w !== 'string' || !w.trim()) throw new Usage(`${what}.${k} is a name.`);
    out[k as K] = w.trim();
  }
  return out;
}

const bool = (v: unknown, dflt: boolean, what: string) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'boolean') throw new Usage(`${what} is true or false.`);
  return v;
};

/** Whether `site` is the vendor's own cloud, which a committed file may name (shared with the web app's setup dialog). */
export { cloudSite };

/** The settings for a run: the file (when there is one), then the flags given. */
export function loadMirrorConfig(cwd: string, flags: Record<string, string | true | undefined>, inGitRepo: boolean, env: NodeJS.ProcessEnv = process.env): MirrorConfig {
  const file = typeof flags.config === 'string' ? path.resolve(cwd, flags.config) : path.join(cwd, CONFIG_FILE);
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed = parseYaml(readFileSync(file, 'utf8')) as unknown;
    if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Usage(`${file} should hold settings, one per line.`);
    raw = (parsed ?? {}) as Record<string, unknown>;
    if (Object.keys(raw).some((k) => /token|secret|password|key$/i.test(k) && k !== 'kindMap'))
      throw new Usage(`${file} holds what looks like a credential. Tokens come from the environment only, never a file in the repository.`);
    const unknown = Object.keys(raw).filter((k) => !KEYS.includes(k));
    if (unknown.length) throw new Usage(`${file}: unknown setting ${unknown.join(', ')}. Settings: ${KEYS.join(', ')}.`);
  } else if (typeof flags.config === 'string') throw new Usage(`${file} does not exist.`);
  const pick = (k: string) => (typeof flags[k] === 'string' ? flags[k] : raw[k]);
  const provider = String(pick('provider') ?? '');
  if (!PROVIDERS.includes(provider as Provider)) throw new Usage(`Name a tracker: --provider ${PROVIDERS.join('|')}, or provider: in ${CONFIG_FILE}.`);
  const target = String(pick('target') ?? '').trim();
  if (!target) throw new Usage(`Name where issues go: --target (${provider === 'github' ? 'owner/repo' : provider === 'linear' ? 'a team key' : provider === 'jira' ? 'a project key' : 'organization/project'}).`);
  const items = String(pick('items') ?? 'theirs');
  if (!['theirs', 'mine', 'all'].includes(items)) throw new Usage('items is theirs, mine or all.');
  let site: string | undefined;
  if (typeof flags.site === 'string' && flags.site) site = flags.site;
  else if (env.CROSSROOM_TRACKER_SITE) site = env.CROSSROOM_TRACKER_SITE;
  else if (raw.site !== undefined && raw.site !== null && raw.site !== '') {
    if (typeof raw.site !== 'string' || !cloudSite(provider as Provider, raw.site))
      throw new Usage(
        `${file} names the site ${JSON.stringify(String(raw.site))}, which is not ${provider === 'azure' ? 'Azure DevOps cloud (https://dev.azure.com or https://<org>.visualstudio.com)' : provider === 'jira' ? 'Jira Cloud (https://<site>.atlassian.net)' : `a site ${provider} takes`}. A committed file may only name the vendor's own cloud, so an edit to it can't send your token elsewhere: give any other address with --site or CROSSROOM_TRACKER_SITE.`,
      );
    site = raw.site;
  }
  const browse = pick('browse');
  if (browse !== undefined && browse !== null && (typeof browse !== 'string' || !/^https:\/\/[^/\s]+\/?$/.test(browse))) throw new Usage('browse is an https address, such as https://acme.atlassian.net.');
  return {
    provider: provider as Provider,
    target,
    ...(site ? { site } : {}),
    ...(typeof browse === 'string' && browse ? { browse: browse.replace(/\/+$/, '') } : {}),
    label: String(pick('label') ?? 'crossroom').trim() || 'crossroom',
    labels: strings(raw.labels, 'labels'),
    items: items as MirrorConfig['items'],
    body: bool(raw.body, false, 'body'),
    inbound: flags.inbound === true || bool(raw.inbound, false, 'inbound'),
    withdrawOnClose: bool(raw.withdrawOnClose, false, 'withdrawOnClose'),
    trailers: bool(raw.trailers, inGitRepo, 'trailers') && inGitRepo,
    kindMap: map(raw.kindMap, LANE_KINDS, 'kindMap'),
    stateMap: map(raw.stateMap, LANE_STATES, 'stateMap'),
    trusted: strings(raw.trusted, 'trusted'),
  };
}

/** The person's own token for the tracker, from the environment. */
export function trackerToken(provider: Provider, env: NodeJS.ProcessEnv = process.env): Pick<AdapterOptions, 'token' | 'user'> {
  switch (provider) {
    case 'github': {
      const t = env.GITHUB_TOKEN || env.GH_TOKEN;
      if (t) return { token: t };
      try {
        const out = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (out) return { token: out };
      } catch {
        // No gh, or not signed in: said below.
      }
      throw new Usage('Set GITHUB_TOKEN (a fine-grained token with Issues read and write on the repository), or sign in with `gh auth login`.');
    }
    case 'linear':
      if (env.LINEAR_API_KEY) return { token: env.LINEAR_API_KEY };
      throw new Usage('Set LINEAR_API_KEY (Linear: Settings, Security and access, Personal API keys).');
    case 'jira':
      if (env.JIRA_API_TOKEN && env.JIRA_EMAIL) return { token: env.JIRA_API_TOKEN, user: env.JIRA_EMAIL };
      throw new Usage('Set JIRA_EMAIL and JIRA_API_TOKEN (id.atlassian.com, Security, API tokens).');
    case 'azure': {
      const pat = env.AZURE_DEVOPS_PAT || env.AZURE_DEVOPS_EXT_PAT;
      if (pat) return { token: pat };
      if (env.SYSTEM_ACCESSTOKEN) return { token: env.SYSTEM_ACCESSTOKEN, user: 'bearer' };
      throw new Usage('Set AZURE_DEVOPS_PAT (a personal access token with Work Items read and write), or run in Azure Pipelines with SYSTEM_ACCESSTOKEN.');
    }
  }
}

export function trackerFor(o: AdapterOptions): TrackerAdapter {
  switch (o.config.provider) {
    case 'github':
      return githubAdapter(o);
    case 'linear':
      return linearAdapter(o);
    case 'jira':
      return jiraAdapter(o);
    case 'azure':
      return azureAdapter(o);
  }
}
