/**
 * `@parley/shared/tracker-read`: the readers of GitHub, Azure DevOps and Jira, as pure functions over a
 * getter (`TrackerIo`), zod-free and Node-free so the relay, a team's runner, the `crossroom` command
 * and the web app all run the same code:
 * - `readGithubItem`, `readAzureWorkItem`, `readJiraIssue`: one item, whole (comments, links, sprint);
 * - `searchItems`: one page of a project's list, cheap (no comments, links or timeline), by a filter
 *   (`compileFilter`) or a condition in the tracker's own language;
 * - `syncItems`: every item a condition picks, up to a limit, each read whole;
 * - `trackerOptions`: what a place offers a filter (projects, teams, sprints, types, states, labels).
 *
 * Who reads decides who is asked: the getter carries the credential or none, and is bound to one
 * tracker's origin (`trackerOrigin`). A reader never sees a token.
 */
import { azureExternalId, azureItemUrl, parseAzureWorkItemUrl } from '../azure-devops.js';
import { parseJiraIssueUrl, type TrackerProvider } from '../trackers.js';
import {
  AZURE_API,
  type AzureCache,
  azureIds,
  listAzureIterations,
  listAzureProjects,
  listAzureTeams,
  listAzureTypesAndStates,
  NOT_AN_AZURE_PROJECT,
  parseAzureOrg,
  parseAzureProject,
  projectPath,
  readAzureWorkItem,
  searchAzure,
} from './azure.js';
import type { TrackerFilter } from './filter.js';
import { externalIdOf, type GithubItemRef, githubItemUrl, listLabels, listMilestones, NOT_A_GITHUB_REPO, parseGithubRepo, parseGithubUrl, readGithubItem, searchGithub, searchGithubRaw } from './github.js';
import { arr, obj, type ReadOptions, TrackerQueryError, type TrackerIo, type TrackerOption, type TrackerRead, type TrackerSearchPage } from './io.js';
import {
  JIRA_PROJECT_KEY,
  jiraApiOf,
  jiraCondition,
  jiraJql,
  jiraProjectOf,
  listJiraBoards,
  listJiraProjects,
  listJiraSprints,
  listJiraStatuses,
  NOT_A_JIRA_PLACE,
  parseJiraWhere,
  readJiraIssue,
  searchJira,
} from './jira.js';

export * from './azure.js';
export * from './filter.js';
export * from './github.js';
export * from './io.js';
export * from './jira.js';
/** `TrackerRead` under a name that doesn't meet `@parley/shared/work`'s (a read through a runner). */
export type { TrackerRead as TrackerItemRead } from './io.js';

// ---------------------------------------------------------------- where a getter goes

/**
 * The origin a getter for this place is bound to: GitHub's API, Azure DevOps, or the Jira site the
 * address names. Null for an address that names no place of that tracker. `anyHost` lets a Jira
 * address name a self-managed site.
 */
export function trackerOrigin(provider: TrackerProvider, where: string, o: { anyHost?: boolean } = {}): string | null {
  if (provider === 'github') return parseGithubRepo(where) || parseGithubUrl(where) ? 'https://api.github.com' : null;
  if (provider === 'azure') return parseAzureOrg(where) ? 'https://dev.azure.com' : null;
  const w = parseJiraWhere(where, o) ?? parseJiraIssueUrl(where, o);
  return w ? w.site : null;
}

/** The tracker a place's address belongs to, by its host. */
export function providerOf(where: string): TrackerProvider | null {
  let host: string;
  try {
    host = new URL(where.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'github.com' || host === 'www.github.com') return 'github';
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) return 'azure';
  return parseJiraWhere(where, { anyHost: true }) || parseJiraIssueUrl(where, { anyHost: true }) ? 'jira' : null;
}

// ---------------------------------------------------------------- one page

export interface SearchInput {
  provider: TrackerProvider;
  /** A repository, a project or a board, by its address. */
  where: string;
  query?: string | null;
  /** Wins over `query`; its `raw` part rides inside it. */
  filter?: TrackerFilter | null;
  sprint?: 'current' | null;
  /** An Azure DevOps team, for the current sprint. */
  team?: string | null;
  cursor?: string | null;
  /** Default 25, at most 100. */
  pageSize?: number;
  /** A Jira address may name a self-managed site. */
  anyHost?: boolean;
}

/** One page of the items a filter or a condition picks in one place, newest change first. */
export function searchItems(io: TrackerIo, o: SearchInput): Promise<TrackerSearchPage> {
  if (o.provider === 'github') return searchGithub(io, o);
  if (o.provider === 'azure') return searchAzure(io, o);
  return searchJira(io, o);
}

// ---------------------------------------------------------------- every item, read whole

export interface SyncInput extends Omit<SearchInput, 'cursor' | 'pageSize'> {
  /** At most this many, up to 1,000. */
  limit: number;
  readBy: ReadOptions['readBy'];
  now?: () => Date;
}

export interface Synced {
  url: string;
  externalId: string;
  read: TrackerRead;
}

export interface SyncResult {
  items: Synced[];
  /** More matched than `limit`. */
  more: boolean;
  /** Jira: the project a board named. */
  project?: string;
}

const AZURE_BATCH = 200;
const JIRA_ISSUE = /^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9}$/;

/**
 * Every item a filter or a condition picks, newest change first, at most `limit`, each read whole as an
 * import reads it: page by page through the search (GitHub's pages hand their items' JSON to the
 * reader; Azure DevOps reads the query's ids in batches of 200 with their relations; Jira lists keys,
 * then reads each issue). A sync takes pull requests too, where a search defaults to issues.
 */
export async function syncItems(io: TrackerIo, o: SyncInput): Promise<SyncResult> {
  const limit = Math.min(Math.max(Math.trunc(o.limit), 1), 1000);
  const ro = { readBy: o.readBy, ...(o.now ? { now: o.now } : {}) };
  if (o.provider === 'github') {
    const repo = parseGithubRepo(o.where);
    if (!repo) throw new TrackerQueryError(NOT_A_GITHUB_REPO);
    const per = Math.min(100, limit);
    const items: Synced[] = [];
    let total: number | null = null;
    let cursor: string | null = '1';
    while (cursor && items.length < limit) {
      const page = await searchGithubRaw(io, { ...o, cursor, pageSize: per, issuesOnly: false });
      total = page.total ?? total;
      for (const raw of page.raws) {
        if (items.length >= limit) break;
        const n = raw.number;
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) continue;
        const ref: GithubItemRef = { repo, number: n, kind: Object.keys(obj(raw.pull_request)).length ? 'pull' : 'issue' };
        items.push({ url: githubItemUrl(ref), externalId: externalIdOf(repo, n), read: await readGithubItem(io, ref, ro, raw) });
      }
      cursor = page.next;
    }
    return { items, more: total !== null ? total > limit : cursor !== null };
  }
  if (o.provider === 'azure') {
    const at = parseAzureProject(o.where);
    if (!at) throw new TrackerQueryError(NOT_AN_AZURE_PROJECT);
    const ids = await azureIds(io, at, { ...o, top: limit + 1 });
    const want = ids.slice(0, limit);
    const items: Synced[] = [];
    const cache: AzureCache = new Map();
    for (let k = 0; k < want.length; k += AZURE_BATCH) {
      const got = obj(await io.get(`${projectPath(at.org, at.project)}/_apis/wit/workitems?ids=${want.slice(k, k + AZURE_BATCH).join(',')}&$expand=relations&errorPolicy=omit&${AZURE_API}`));
      for (const raw of arr(got.value)) {
        const id = obj(raw).id;
        if (typeof id !== 'number') continue;
        // An item is named by the project it lives in, which the query keeps to this one.
        const ref = { org: at.org, project: at.project, id };
        const read = await readAzureWorkItem(io, ref, { ...ro, cache }, raw);
        items.push({ url: azureItemUrl(at.org, at.project, id), externalId: azureExternalId(at.org, at.project, id), read });
      }
    }
    return { items, more: ids.length > limit };
  }
  if (!io.post) throw new TrackerQueryError('This reader cannot run a query.');
  const where = parseJiraWhere(o.where, { anyHost: o.anyHost === true });
  if (!where) throw new TrackerQueryError(NOT_A_JIRA_PLACE);
  const api = jiraApiOf(where.site);
  const project = await jiraProjectOf(io, where);
  const jql = jiraJql(project, jiraCondition(o), !o.filter && o.sprint === 'current');
  const keys: string[] = [];
  if (api === '3') {
    let next: string | undefined;
    for (let page = 0; page < 20; page++) {
      const got = obj(await io.post('/rest/api/3/search/jql', { jql, maxResults: Math.min(100, limit + 1 - keys.length), fields: ['key'], ...(next ? { nextPageToken: next } : {}) }));
      for (const i of arr(got.issues)) if (typeof obj(i).key === 'string') keys.push(obj(i).key as string);
      next = typeof got.nextPageToken === 'string' ? got.nextPageToken : undefined;
      if (keys.length > limit || !next || got.isLast === true) break;
    }
  } else {
    for (let startAt = 0; keys.length <= limit; ) {
      const got = obj(await io.post('/rest/api/2/search', { jql, startAt, maxResults: Math.min(100, limit + 1 - keys.length), fields: ['key'] }));
      const page = arr(got.issues).flatMap((i) => (typeof obj(i).key === 'string' ? [obj(i).key as string] : []));
      keys.push(...page);
      startAt += page.length;
      if (!page.length || (typeof got.total === 'number' && startAt >= got.total)) break;
    }
  }
  const host = new URL(where.site).hostname;
  const items: Synced[] = [];
  for (const raw of keys.slice(0, limit)) {
    const key = raw.toUpperCase();
    if (!JIRA_ISSUE.test(key)) continue;
    const read = await readJiraIssue(io, { site: where.site, key }, { ...ro, api });
    items.push({ url: `${where.site}/browse/${key}`, externalId: `${host}/${key}`, read });
  }
  return { items, more: keys.length > limit, project };
}

// ---------------------------------------------------------------- one item, read whole

/** Read the one item an address names, and how it is deduped. Throws `TrackerQueryError` for an address that names no item. */
export async function readItem(io: TrackerIo, provider: TrackerProvider, url: string, o: ReadOptions & { anyHost?: boolean }): Promise<Synced> {
  const ro = { readBy: o.readBy, ...(o.now ? { now: o.now } : {}) };
  if (provider === 'github') {
    const ref = parseGithubUrl(url);
    if (!ref) throw new TrackerQueryError('That is not the address of a GitHub issue or pull request.');
    return { url: githubItemUrl(ref), externalId: externalIdOf(ref.repo, ref.number), read: await readGithubItem(io, ref, ro) };
  }
  if (provider === 'azure') {
    const ref = parseAzureWorkItemUrl(url);
    if (!ref) throw new TrackerQueryError('That is not the address of an Azure DevOps work item.');
    return { url: ref.url, externalId: ref.externalId, read: await readAzureWorkItem(io, ref, ro) };
  }
  const ref = parseJiraIssueUrl(url, { anyHost: o.anyHost === true });
  if (!ref) throw new TrackerQueryError('That is not the address of a Jira issue.');
  return { url: ref.url, externalId: ref.externalId, read: await readJiraIssue(io, ref, { ...ro, api: jiraApiOf(ref.site) }) };
}

// ---------------------------------------------------------------- whether an item is in a place

/**
 * Whether the item `url` names is in the place `where` names: the same repository (GitHub, without
 * case), the same organization and project (Azure DevOps), the same site and, where the place names
 * one, the same project (Jira). What a report from a saved sync is held to.
 */
export function itemInWhere(provider: TrackerProvider, where: string, url: string): boolean {
  if (provider === 'github') {
    const repo = parseGithubRepo(where);
    const ref = parseGithubUrl(url);
    return !!repo && !!ref && ref.repo.toLowerCase() === repo.toLowerCase();
  }
  if (provider === 'azure') {
    const at = parseAzureProject(where);
    const ref = parseAzureWorkItemUrl(url);
    return !!at && !!ref && ref.org.toLowerCase() === at.org.toLowerCase() && ref.project.toLowerCase() === at.project.toLowerCase();
  }
  const w = parseJiraWhere(where, { anyHost: true });
  const ref = parseJiraIssueUrl(url, { anyHost: true });
  if (!w || !ref || new URL(w.site).hostname !== new URL(ref.site).hostname) return false;
  return w.project === null || ref.key.slice(0, ref.key.lastIndexOf('-')) === w.project;
}

/** Whether `url` names one item of this tracker. */
export function isItemUrl(provider: TrackerProvider, url: string): boolean {
  if (provider === 'github') return parseGithubUrl(url) !== null;
  if (provider === 'azure') return parseAzureWorkItemUrl(url) !== null;
  return parseJiraIssueUrl(url, { anyHost: true }) !== null;
}

// ---------------------------------------------------------------- what a place offers

/**
 * What a filter can be built from, by tracker:
 * - GitHub (`where` a repository): `milestones`, `labels`;
 * - Azure DevOps: `projects` (`where` the organization), `teams`, `types` (types and states), and
 *   `iterations` (`where` a project, with `team` or a board's address naming one);
 * - Jira: `projects` (`where` the site or any address on it), `boards`, `statuses` (types and
 *   states), and `sprints` (`where` a board, or a project whose first board is asked).
 */
export const OPTION_KINDS = {
  github: ['milestones', 'labels'],
  azure: ['projects', 'teams', 'iterations', 'types'],
  jira: ['projects', 'boards', 'sprints', 'statuses'],
} as const satisfies Record<TrackerProvider, readonly string[]>;
export type OptionKind = (typeof OPTION_KINDS)[TrackerProvider][number];

export interface OptionsInput {
  provider: TrackerProvider;
  what: OptionKind;
  where: string;
  team?: string | null;
  anyHost?: boolean;
}

export interface TrackerOptions {
  options: TrackerOption[];
  /** For `types` and `statuses`: the states beside the types in `options`. */
  states?: TrackerOption[];
}

export const NOT_AN_OPTION = 'That tracker offers no such list.';

const jiraSite = (where: string, anyHost: boolean): string => {
  const w = parseJiraWhere(where, { anyHost }) ?? parseJiraIssueUrl(where, { anyHost });
  if (w) return w.site;
  try {
    const u = new URL(where);
    if (u.protocol === 'https:' && !u.username && !u.password && !u.port && (anyHost || /\.atlassian\.net$/i.test(u.hostname))) return `https://${u.hostname.toLowerCase()}`;
  } catch {
    // not a URL
  }
  throw new TrackerQueryError(NOT_A_JIRA_PLACE);
};

/** One list a place offers a filter, bounded at 100. */
export async function trackerOptions(io: TrackerIo, o: OptionsInput): Promise<TrackerOptions> {
  if (!(OPTION_KINDS[o.provider] as readonly string[]).includes(o.what)) throw new TrackerQueryError(NOT_AN_OPTION);
  if (o.provider === 'github') return { options: o.what === 'labels' ? await listLabels(io, o.where) : await listMilestones(io, o.where) };
  if (o.provider === 'azure') {
    if (o.what === 'projects') {
      const org = parseAzureOrg(o.where);
      if (!org) throw new TrackerQueryError(NOT_AN_AZURE_PROJECT);
      return { options: await listAzureProjects(io, org) };
    }
    const at = parseAzureProject(o.where);
    if (!at) throw new TrackerQueryError(NOT_AN_AZURE_PROJECT);
    if (o.what === 'teams') return { options: await listAzureTeams(io, at.org, at.project) };
    if (o.what === 'types') {
      const ts = await listAzureTypesAndStates(io, at.org, at.project);
      return { options: ts.types, states: ts.states };
    }
    const team = o.team?.trim() || at.team;
    if (!team) throw new TrackerQueryError("A team's iterations: choose the team.");
    return { options: await listAzureIterations(io, at.org, at.project, team) };
  }
  const site = jiraSite(o.where, o.anyHost === true);
  const api = jiraApiOf(site);
  if (o.what === 'projects') return { options: await listJiraProjects(io, api) };
  const where = parseJiraWhere(o.where, { anyHost: o.anyHost === true });
  if (!where) throw new TrackerQueryError(NOT_A_JIRA_PLACE);
  if (o.what === 'sprints') {
    let board = where.board;
    if (board === null) {
      const boards = await listJiraBoards(io, where.project!);
      const first = boards.find((b) => b.detail === 'scrum') ?? boards[0];
      if (!first) return { options: [] };
      board = Number(first.value);
    }
    return { options: await listJiraSprints(io, board) };
  }
  const project = await jiraProjectOf(io, where);
  if (!JIRA_PROJECT_KEY.test(project)) throw new TrackerQueryError(NOT_A_JIRA_PLACE);
  if (o.what === 'boards') return { options: await listJiraBoards(io, project) };
  const st = await listJiraStatuses(io, api, project);
  return { options: st.types, states: st.states };
}

