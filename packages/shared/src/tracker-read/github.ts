/**
 * A GitHub issue or pull request, read through a getter on `https://api.github.com` (tracker-read/io.ts):
 * the item, its latest comments, and its timeline's cross-references (pull requests and issues that
 * mention it, and the commit that closed it). A pull request is served at the issues endpoint too,
 * with a `pull_request` key. The milestone stands for the iteration, its due date as the end.
 *
 * A repository is also searched (`searchGithub`, one page of the search API's list) and asked what
 * it offers a filter (`listMilestones`, `listLabels`).
 */
import {
  criteriaFromText,
  latestComments,
  TRACKER_LIMITS as L,
  type TrackerLink,
  trackerDate,
  trackerLine,
  trackerLink,
  trackerText,
  uniqueLinks,
} from '../trackers.js';
import { arr, besides, num, obj, type ReadOptions, readAt, str, TrackerAnswerError, type TrackerIo, type TrackerRead, BRIEF_CHARS as MAX_BRIEF_CHARS, REPO, cursorNumber, OPTIONS_MAX, pageSizeOf, TrackerQueryError, type TrackerOption, type TrackerSearchItem, type TrackerSearchPage } from './io.js';
import { compileFilter, type TrackerFilter } from './filter.js';

export interface GithubItemRef {
  /** `owner/name`, as the address spells it. */
  repo: string;
  number: number;
  kind: 'issue' | 'pull';
}

const NUMBER_MAX = 2_147_483_647;

/** `owner/repo#n`, the id an item is deduped on: lower-cased, since GitHub reads repository names without case. */
export const externalIdOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/**
 * The reference a GitHub issue or pull request URL names, or null for anything else: only
 * `https://github.com/<owner>/<repo>/(issues|pull)/<n>`, no other host, no credentials, no port. The
 * repository is checked by the pattern a webhook's `repo` field is held to.
 */
export function parseGithubUrl(raw: string): GithubItemRef | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'github.com' && u.hostname !== 'www.github.com')) return null;
  if (u.username || u.password || u.port) return null;
  const parts = u.pathname.split('/');
  // ['', owner, repo, issues|pull, n, ...]: a tab such as /files or /commits after the number is fine.
  const [, owner, name, what, n] = parts;
  if (!owner || !name || !n || (what !== 'issues' && what !== 'pull')) return null;
  const repo = `${owner}/${name}`;
  if (!REPO.test(repo) || repo.split('/').some((s) => s === '.' || s === '..')) return null;
  if (!/^[0-9]{1,10}$/.test(n)) return null;
  const number = Number(n);
  if (number < 1 || number > NUMBER_MAX) return null;
  return { repo, number, kind: what === 'pull' ? 'pull' : 'issue' };
}

/** The item's own page. */
export const githubItemUrl = (ref: GithubItemRef) => `https://github.com/${ref.repo}/${ref.kind === 'pull' ? 'pull' : 'issues'}/${ref.number}`;

const COMMENTS_PAGE = 100;
const LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
const SHA = /^[0-9a-f]{7,40}$/;

const loginOf = (v: unknown): string | null => {
  const l = str(obj(v).login);
  return LOGIN.test(l) ? l : null;
};

/** `/repos/<owner>/<repo>/issues/<n>`, each part escaped. */
export const issuePath = (repo: string, n: number) => `/repos/${repo.split('/').map(encodeURIComponent).join('/')}/issues/${n}`;

const stateOfIssue = (j: Record<string, unknown>): string => {
  const pr = obj(j.pull_request);
  if (typeof pr.merged_at === 'string' && pr.merged_at !== '') return 'merged';
  return j.state === 'closed' ? 'closed' : 'open';
};

/** Read one issue or pull request; `raw` is its JSON when a search already answered it. */
export async function readGithubItem(io: TrackerIo, ref: GithubItemRef, o: ReadOptions, raw?: unknown): Promise<TrackerRead> {
  const j = obj(raw ?? (await io.get(issuePath(ref.repo, ref.number))));
  if (typeof j.number !== 'number' || j.number !== ref.number) throw new TrackerAnswerError('GitHub answered for another item.');
  const isPull = Object.keys(obj(j.pull_request)).length > 0;
  const body = trackerText(str(j.body), MAX_BRIEF_CHARS);
  const count = Math.max(0, Math.min(1_000_000, Math.trunc(num(j.comments) ?? 0)));
  const [comments, links] = await Promise.all([count ? commentsOf(io, ref, count) : Promise.resolve([]), linksOf(io, ref)]);
  const milestone = obj(j.milestone);
  const mName = trackerLine(milestone.title, L.word * 2);
  const assignee = loginOf(j.assignee) ?? arr(j.assignees).map(loginOf).find((x) => x !== null) ?? null;
  return {
    title: trackerLine(j.title, 200) || `${ref.repo}#${ref.number}`,
    body,
    criteria: criteriaFromText(body),
    author: loginOf(j.user),
    snapshot: {
      key: trackerLine(`${ref.repo}#${ref.number}`, L.key),
      type: isPull ? 'Pull request' : 'Issue',
      state: stateOfIssue(j),
      assignee,
      iteration: mName ? { name: mName, path: '', start: null, end: trackerDate(milestone.due_on) } : null,
      labels: arr(j.labels)
        .map((l) => trackerLine(typeof l === 'string' ? l : obj(l).name, L.label))
        .filter(Boolean)
        .slice(0, L.labels),
      priority: '',
      points: null,
      links,
      comments,
      commentCount: count,
      updatedAt: trackerDate(j.updated_at),
      readAt: readAt(o),
      readBy: o.readBy,
    },
  };
}

/** The latest comments: GitHub lists them oldest first, so the last page, and the one before when it is short. */
function commentsOf(io: TrackerIo, ref: GithubItemRef, count: number) {
  return besides([], async () => {
    const last = Math.max(1, Math.ceil(count / COMMENTS_PAGE));
    const page = async (p: number) => arr(await io.get(`${issuePath(ref.repo, ref.number)}/comments?per_page=${COMMENTS_PAGE}&page=${p}`));
    let got = await page(last);
    if (got.length < L.comments && last > 1) got = [...(await besides([] as unknown[], () => page(last - 1))), ...got];
    return latestComments(got.map((c) => ({ author: loginOf(obj(c).user), at: obj(c).created_at, text: obj(c).body })));
  });
}

/** What the timeline says links here: the commit that closed it, then pull requests and issues that mention it. */
function linksOf(io: TrackerIo, ref: GithubItemRef): Promise<TrackerLink[]> {
  return besides([], async () => {
    const events = arr(await io.get(`${issuePath(ref.repo, ref.number)}/timeline?per_page=100`));
    const closing: (TrackerLink | null)[] = [];
    const mentions: (TrackerLink | null)[] = [];
    const here = ref.repo.toLowerCase();
    for (const raw of events) {
      const e = obj(raw);
      const sha = str(e.commit_id);
      if ((e.event === 'closed' || e.event === 'referenced') && SHA.test(sha)) {
        // A commit in another repository says so in its own URL; GitHub's API address is rebuilt as the page.
        const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/commits\/[0-9a-f]{7,40}$/.exec(str(e.commit_url));
        const repo = m ? m[1]! : ref.repo;
        (e.event === 'closed' ? closing : mentions).push(
          trackerLink('commit', e.event === 'closed' ? 'Closed by' : 'Referenced by', `https://github.com/${repo}/commit/${sha}`, `${repo.toLowerCase() === here ? '' : `${repo} `}commit ${sha.slice(0, 7)}`),
        );
        continue;
      }
      if (e.event !== 'cross-referenced') continue;
      const issue = obj(obj(e.source).issue);
      const n = num(issue.number);
      const url = str(issue.html_url);
      if (n === null || !/^https:\/\/github\.com\//.test(url)) continue;
      const pr = obj(issue.pull_request);
      const isPull = Object.keys(pr).length > 0;
      const repo = str(obj(issue.repository).full_name) || /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(url)?.[1] || '';
      const name = `${repo && repo.toLowerCase() !== here ? repo : ''}#${n}`;
      const state = typeof pr.merged_at === 'string' && pr.merged_at ? 'merged' : str(issue.state);
      mentions.push(trackerLink(isPull ? 'pull_request' : 'work_item', 'Mentioned in', url, `${name} ${str(issue.title)}`, state));
    }
    // Newest mentions first: a long timeline keeps what happened lately.
    return uniqueLinks([...closing, ...mentions.reverse()]);
  });
}

// ---------------------------------------------------------------- a repository, searched

/** A repository, by its address or any page in it: `https://github.com/<owner>/<repo>[/...]`. */
export function parseGithubRepo(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') || u.username || u.password || u.port) return null;
  const [owner, repo] = u.pathname.split('/').filter(Boolean);
  if (!owner || !repo || !/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return null;
  return `${owner}/${repo.replace(/\.git$/, '')}`;
}

export const GITHUB_DEFAULT_QUERY = 'is:open';
export const GITHUB_NO_SPRINT = 'GitHub has no sprints. Name a milestone in --query instead, such as --query \'is:open milestone:"Sprint 7"\'.';
export const NOT_A_GITHUB_REPO = 'That is not the address of a GitHub repository (https://github.com/<owner>/<repo>).';

/** What a search of one repository takes; `where` is the repository's address. */
export interface GithubSearch {
  where: string;
  query?: string | null;
  filter?: TrackerFilter | null;
  sprint?: 'current' | null;
  cursor?: string | null;
  pageSize?: number;
  /** Add `is:issue` when the condition names no kind: a search's default. A sync takes pull requests too (`false`). */
  issuesOnly?: boolean;
}

/** The search's own condition: the filter compiled (its `raw` part the person's own), else the query, else open items. */
export function githubCondition(o: Pick<GithubSearch, 'query' | 'filter' | 'sprint'>): string {
  if (o.sprint === 'current') throw new TrackerQueryError(GITHUB_NO_SPRINT);
  // A filter is the whole condition: one that picks every state (open and closed) means no `is:` at all.
  if (o.filter) return compileFilter('github', o.filter);
  return o.query?.trim() || GITHUB_DEFAULT_QUERY;
}

const NAMES_KIND = /(^|\s)-?(is:(issue|pr|pull-request)|type:(issue|pr))(\s|$)/i;

/** A search's item: the list's fields only. */
function listedGithub(repo: string, j: Record<string, unknown>): TrackerSearchItem | null {
  const n = num(j.number);
  if (n === null || !Number.isSafeInteger(n) || n < 1 || n > NUMBER_MAX) return null;
  const isPull = Object.keys(obj(j.pull_request)).length > 0;
  const ref: GithubItemRef = { repo, number: n, kind: isPull ? 'pull' : 'issue' };
  return {
    url: githubItemUrl(ref),
    key: trackerLine(`${repo}#${n}`, L.key),
    title: trackerLine(j.title, 200) || `${repo}#${n}`,
    state: stateOfIssue(j),
    type: isPull ? 'Pull request' : 'Issue',
    iteration: trackerLine(obj(j.milestone).title, L.word * 2) || null,
    assignee: loginOf(j.assignee) ?? arr(j.assignees).map(loginOf).find((x) => x !== null) ?? null,
    updatedAt: trackerDate(j.updated_at),
  };
}

/**
 * One page of the issues (and, with `issuesOnly: false`, pull requests) a search picks in one
 * repository, newest change first: `GET /search/issues`, `page` and `per_page`. The cursor is the
 * next page's number; GitHub's search stops at 1,000 results. `raws` is each item's JSON, which a
 * sync reads whole without asking for it again.
 */
export async function searchGithubRaw(io: TrackerIo, o: GithubSearch): Promise<TrackerSearchPage & { raws: Record<string, unknown>[]; repo: string }> {
  const repo = parseGithubRepo(o.where);
  if (!repo) throw new TrackerQueryError(NOT_A_GITHUB_REPO);
  const cond = githubCondition(o);
  const kind = o.issuesOnly !== false && !NAMES_KIND.test(cond) ? ' is:issue' : '';
  const per = pageSizeOf(o.pageSize);
  const page = Math.max(1, cursorNumber(o.cursor, 1, Math.floor(1000 / per)));
  const got = obj(await io.get(`/search/issues?q=${encodeURIComponent(`repo:${repo}${kind}${cond ? ` ${cond}` : ''}`)}&sort=updated&order=desc&per_page=${per}&page=${page}`));
  const raws = arr(got.items).map(obj).slice(0, per);
  const items = raws.map((r) => listedGithub(repo, r)).filter((x): x is TrackerSearchItem => x !== null);
  const total = num(got.total_count);
  const seen = (page - 1) * per + raws.length;
  const next = raws.length === per && (total === null || seen < Math.min(total, 1000)) && page * per < 1000 ? String(page + 1) : null;
  return { items, next, total: total === null ? null : Math.max(0, Math.trunc(total)), raws, repo };
}

export async function searchGithub(io: TrackerIo, o: GithubSearch): Promise<TrackerSearchPage> {
  const { items, next, total } = await searchGithubRaw(io, o);
  return { items, next, total };
}

// ---------------------------------------------------------------- what a repository offers

const repoPathOf = (where: string) => {
  const repo = parseGithubRepo(where);
  if (!repo) throw new TrackerQueryError(NOT_A_GITHUB_REPO);
  return `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;
};

/** The repository's open milestones, soonest due first: what a GitHub filter names as a sprint (`milestone:"…"`). */
export async function listMilestones(io: TrackerIo, where: string): Promise<TrackerOption[]> {
  const got = arr(await io.get(`${repoPathOf(where)}/milestones?state=open&sort=due_on&direction=asc&per_page=${OPTIONS_MAX}`));
  return got
    .map(obj)
    .map((m): TrackerOption => ({ value: trackerLine(m.title, L.word * 2), name: trackerLine(m.title, L.word * 2), start: null, end: trackerDate(m.due_on) }))
    .filter((m) => m.value)
    .slice(0, OPTIONS_MAX);
}

/** The repository's labels. */
export async function listLabels(io: TrackerIo, where: string): Promise<TrackerOption[]> {
  const got = arr(await io.get(`${repoPathOf(where)}/labels?per_page=${OPTIONS_MAX}`));
  return got
    .map(obj)
    .map((l): TrackerOption => {
      const detail = trackerLine(l.description, 200);
      return { value: trackerLine(l.name, L.label), name: trackerLine(l.name, L.label), ...(detail ? { detail } : {}) };
    })
    .filter((l) => l.value)
    .slice(0, OPTIONS_MAX);
}
