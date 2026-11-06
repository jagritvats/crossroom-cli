/**
 * A Jira issue, read through a getter on the Jira site (tracker-read/io.ts): the issue with its field names
 * and schemas (`expand=names,schema,renderedFields`), its remote links, and its latest comments.
 *
 * - API version 3 on Jira Cloud (rich text as ADF), 2 on a self-managed site (Data Center or Server,
 *   rich text as wiki markup, read with its lists and headings made plain).
 * - Custom fields are found by what they are, never by an id, since each site numbers its own: the
 *   sprint by its schema (`com.pyxis.greenhopper.jira:gh-sprint`; the active sprint, else the latest),
 *   story points by a field named "Story Points" or "Story point estimate", acceptance criteria by a
 *   field named "Acceptance Criteria", else from a list under such a heading in the description.
 * - Links: issue links (by Jira's own inward and outward words), the parent, subtasks, and remote
 *   links (a pull request where its address says so, else a page).
 */
import {
  type AdfNode,
  adfText,
  criteriaFromField,
  criteriaFromText,
  latestComments,
  TRACKER_LIMITS as L,
  type TrackerIteration,
  type TrackerLink,
  trackerDate,
  trackerLine,
  trackerLink,
  trackerText,
  isJiraCloudHost,
  uniqueLinks,
} from '../trackers.js';
import { checkCondition, compileFilter, type TrackerFilter } from './filter.js';
import { arr, besides, num, obj, pointsOf, type ReadOptions, readAt, str, TrackerAnswerError, type TrackerIo, type TrackerRead, BRIEF_CHARS as MAX_BRIEF_CHARS, cursorNumber, OPTIONS_MAX, pageSizeOf, TrackerQueryError, type TrackerOption, type TrackerSearchItem, type TrackerSearchPage } from './io.js';

export interface JiraItemRef {
  /** `https://<host>`. */
  site: string;
  /** `PROJ-12`. */
  key: string;
}

/** `3` on Jira Cloud, `2` on a self-managed site. */
export type JiraApi = '2' | '3';

export const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';
const POINTS_NAME = /^(story points?|story point estimate)$/i;
const AC_NAME = /^acceptance criteria$/i;
const KEY = /^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9}$/;

/** `/rest/api/<v>/issue/<KEY>`. */
export const jiraIssuePath = (api: JiraApi, key: string) => `/rest/api/${api}/issue/${encodeURIComponent(key)}`;

/**
 * Jira's wiki markup (a self-managed site's rich text), made plain enough to read and to find a list
 * in: `h3. Title` as `### Title`, `* item` and `# item` as list items, `{code}` and `{noformat}` fences dropped.
 */
export function wikiText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => {
      const h = /^\s*h([1-6])\.\s+(.*)$/.exec(l);
      if (h) return `${'#'.repeat(Number(h[1]))} ${h[2]}`;
      const bullet = /^\s*[*-]+\s+(.*)$/.exec(l);
      if (bullet) return `- ${bullet[1]}`;
      const numbered = /^\s*#+\s+(.*)$/.exec(l);
      if (numbered) return `1. ${numbered[1]}`;
      return /^\s*\{(?:code|noformat)(?::[^}]*)?\}\s*$/.test(l) ? '' : l;
    })
    .join('\n');
}

/** Rich text as Jira answers it: ADF (version 3) or wiki markup (version 2), as text. */
const richText = (v: unknown): string => {
  if (v && typeof v === 'object') return adfText(v as AdfNode, { lists: true });
  return typeof v === 'string' ? wikiText(v) : '';
};

/** A sprint as Jira answers it: an object (Cloud, recent Data Center) or the string an older Data Center prints. */
function sprintOf(v: unknown): { name: string; state: string; start: string | null; end: string | null } | null {
  if (typeof v === 'string') {
    const m = /\[(.*)\]\s*$/.exec(v);
    if (!m) return null;
    const pairs = new Map<string, string>();
    for (const part of m[1]!.split(/,(?=[a-zA-Z]+=)/)) {
      const eq = part.indexOf('=');
      if (eq > 0) pairs.set(part.slice(0, eq), part.slice(eq + 1));
    }
    const date = (k: string) => (pairs.get(k) && pairs.get(k) !== '<null>' ? trackerDate(pairs.get(k)) : null);
    return { name: pairs.get('name') ?? '', state: (pairs.get('state') ?? '').toLowerCase(), start: date('startDate'), end: date('endDate') };
  }
  const s = obj(v);
  if (!Object.keys(s).length) return null;
  return { name: str(s.name), state: str(s.state).toLowerCase(), start: trackerDate(s.startDate), end: trackerDate(s.endDate) };
}

/** The active sprint, else the latest one listed. */
function iterationOf(value: unknown): TrackerIteration | null {
  const all = arr(value)
    .map(sprintOf)
    .filter((s): s is NonNullable<ReturnType<typeof sprintOf>> => s !== null && trackerLine(s.name, 1) !== '');
  const pick = all.find((s) => s.state === 'active') ?? all.at(-1);
  if (!pick) return null;
  return { name: trackerLine(pick.name, L.word * 2), path: '', start: pick.start, end: pick.end };
}

/** Read one issue. */
export async function readJiraIssue(io: TrackerIo, ref: JiraItemRef, o: ReadOptions & { api: JiraApi }, raw?: unknown): Promise<TrackerRead> {
  const j = obj(raw ?? (await io.get(`${jiraIssuePath(o.api, ref.key)}?expand=names,schema,renderedFields`)));
  const key = str(j.key).toUpperCase();
  if (!KEY.test(key)) throw new TrackerAnswerError('Jira answered with something that is not an issue.');
  const f = obj(j.fields);
  const names = obj(j.names);
  const schema = obj(j.schema);
  const idsNamed = (re: RegExp) => Object.keys(names).filter((id) => re.test(str(names[id]).trim()));
  const sprintId = Object.keys(schema).find((id) => str(obj(schema[id]).custom) === SPRINT_SCHEMA) ?? idsNamed(/^sprint$/i)[0];
  const pointsId = idsNamed(POINTS_NAME).find((id) => pointsOf(f[id]) !== null);
  const acId = idsNamed(AC_NAME).find((id) => f[id] !== null && f[id] !== undefined && f[id] !== '');

  const body = trackerText(richText(f.description), MAX_BRIEF_CHARS);
  const ac = acId ? trackerText(richText(f[acId]), 20_000) : '';
  const commentField = obj(f.comment);
  const shown = arr(commentField.comments);
  const total = Math.max(0, Math.trunc(num(commentField.total) ?? shown.length));
  const [remote, comments] = await Promise.all([remoteLinks(io, ref, o.api), commentsOf(io, ref, o.api, shown, total)]);

  const issueLink = (relation: string, other: unknown): TrackerLink | null => {
    const it = obj(other);
    const k = str(it.key).toUpperCase();
    if (!KEY.test(k)) return null;
    const of = obj(it.fields);
    return trackerLink('work_item', relation, `${ref.site}/browse/${k}`, `${k} ${str(of.summary)}`, obj(of.status).name);
  };
  const links: (TrackerLink | null)[] = [];
  if (f.parent) links.push(issueLink('Parent', f.parent));
  for (const raw of arr(f.issuelinks)) {
    const l = obj(raw);
    const t = obj(l.type);
    if (l.outwardIssue) links.push(issueLink(str(t.outward) || str(t.name), l.outwardIssue));
    else if (l.inwardIssue) links.push(issueLink(str(t.inward) || str(t.name), l.inwardIssue));
  }
  for (const s of arr(f.subtasks)) links.push(issueLink('Subtask', s));

  return {
    title: trackerLine(f.summary, 200) || key,
    body,
    criteria: ac ? criteriaFromField(ac) : criteriaFromText(body),
    snapshot: {
      key: trackerLine(key, L.key),
      type: trackerLine(obj(f.issuetype).name, L.word),
      state: trackerLine(obj(f.status).name, L.word),
      assignee: trackerLine(obj(f.assignee).displayName, L.person) || null,
      iteration: sprintId ? iterationOf(f[sprintId]) : null,
      labels: arr(f.labels)
        .map((l) => trackerLine(l, L.label))
        .filter(Boolean)
        .slice(0, L.labels),
      priority: trackerLine(obj(f.priority).name, L.word),
      points: pointsId ? pointsOf(f[pointsId]) : null,
      links: uniqueLinks([...links, ...remote]),
      comments,
      commentCount: Math.min(1_000_000, Math.max(total, comments.length)),
      updatedAt: trackerDate(f.updated),
      readAt: readAt(o),
      readBy: o.readBy,
    },
  };
}

const PULL_URL = /\/(?:pull|pull-requests|merge_requests|pullrequest)\/[0-9]+(?:[/?#]|$)/i;

/** Remote links: a pull request where its address says so, else a page. */
function remoteLinks(io: TrackerIo, ref: JiraItemRef, api: JiraApi): Promise<(TrackerLink | null)[]> {
  return besides([], async () =>
    arr(await io.get(`${jiraIssuePath(api, ref.key)}/remotelink`))
      .slice(0, 200)
      .map((raw) => {
        const r = obj(raw);
        const target = obj(r.object);
        const url = str(target.url);
        const pull = PULL_URL.test(url) || /pullrequest/i.test(str(obj(r.application).type));
        const resolved = obj(target.status).resolved;
        return trackerLink(pull ? 'pull_request' : 'web', str(r.relationship) || (pull ? 'Pull request' : 'Web link'), url, str(target.title), resolved === true ? 'resolved' : '');
      }),
  );
}

/** The latest comments: those the issue carried when it holds them all, else the newest asked for. */
function commentsOf(io: TrackerIo, ref: JiraItemRef, api: JiraApi, shown: unknown[], total: number) {
  const of = (list: unknown[]) => latestComments(list.map((c) => ({ author: obj(obj(c).author).displayName, at: obj(c).created, text: richText(obj(c).body) })));
  if (shown.length >= total) return Promise.resolve(of(shown));
  return besides(of(shown), async () => {
    const got = obj(await io.get(`${jiraIssuePath(api, ref.key)}/comment?orderBy=-created&maxResults=${L.comments}`));
    return of(arr(got.comments).slice(0, L.comments).reverse());
  });
}

// ---------------------------------------------------------------- a project or a board, searched

export interface JiraWhere {
  /** `https://<host>`. */
  site: string;
  /** The project's key, when the address names one. */
  project: string | null;
  /** The board's id, when the address is a board. */
  board: number | null;
}

export const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,49}$/;
export const NOT_A_JIRA_PLACE = 'That is not the address of a Jira project or board (https://<site>/browse/KEY, or a board).';
export const JIRA_BOARD_NO_PROJECT = 'Jira does not say which project that board is in. Give the project\'s address instead.';

/** Version 3 on Jira Cloud, 2 on a self-managed site. */
export const jiraApiOf = (site: string): JiraApi => (isJiraCloudHost(new URL(site).hostname) ? '3' : '2');

/**
 * A Jira project or board, by an address in it: `/browse/KEY`, `/jira/software/(c/)projects/KEY/...`,
 * `/projects/KEY`, a board (`.../boards/12`), or `?projectKey=KEY` / `?rapidView=12`. https, no
 * credentials, no port; Jira Cloud's hosts, or any host with `anyHost`.
 */
export function parseJiraWhere(raw: string, o: { anyHost?: boolean } = {}): JiraWhere | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!isJiraCloudHost(host) && !(o.anyHost && /^[a-z0-9.-]{1,253}$/.test(host) && host.includes('.'))) return null;
  const segs = u.pathname.split('/').filter(Boolean);
  let project: string | null = null;
  const browse = segs.indexOf('browse');
  // `/browse/KEY-12` names an issue, not a place: it fails the key's pattern below.
  if (browse >= 0 && segs[browse + 1]) project = segs[browse + 1]!.toUpperCase();
  const projects = segs.indexOf('projects');
  if (!project && projects >= 0 && segs[projects + 1]) project = segs[projects + 1]!.toUpperCase();
  if (!project) project = u.searchParams.get('projectKey')?.toUpperCase() ?? null;
  if (project && !JIRA_PROJECT_KEY.test(project)) return null;
  const boards = segs.indexOf('boards');
  const boardRaw = boards >= 0 ? segs[boards + 1] : u.searchParams.get('rapidView');
  const board = boardRaw && /^[0-9]{1,10}$/.test(boardRaw) ? Number(boardRaw) : null;
  if (!project && board === null) return null;
  return { site: `https://${host}`, project, board };
}

export const JIRA_DEFAULT_QUERY = 'statusCategory != Done';

const jqlLiteral = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The JQL a sync or a search runs: the condition, kept to one project, with the open sprint when asked. */
export const jiraJql = (project: string, q: string, sprint: boolean) => `project = ${jqlLiteral(project)}${q ? ` AND (${q})` : ''}${sprint ? ' AND sprint in openSprints()' : ''} ORDER BY updated DESC`;

/** The project a place names, asking the agile API for a board's. */
export async function jiraProjectOf(io: TrackerIo, where: JiraWhere): Promise<string> {
  if (where.project) return where.project;
  if (where.board === null) throw new TrackerQueryError(NOT_A_JIRA_PLACE);
  const b = obj(await io.get(`/rest/agile/1.0/board/${where.board}`));
  const k = str(obj(b.location).projectKey).toUpperCase();
  if (!JIRA_PROJECT_KEY.test(k)) throw new TrackerQueryError(JIRA_BOARD_NO_PROJECT);
  return k;
}

export interface JiraSearch {
  where: string;
  query?: string | null;
  filter?: TrackerFilter | null;
  sprint?: 'current' | null;
  cursor?: string | null;
  pageSize?: number;
  /** Read a self-managed site's address too (the command and a runner); the relay reads Jira Cloud only. */
  anyHost?: boolean;
}

/** The condition a search runs: the filter compiled, else the query, else what isn't done. */
export function jiraCondition(o: Pick<JiraSearch, 'query' | 'filter'>): string {
  if (o.filter) return compileFilter('jira', o.filter);
  return (o.query?.trim() ? checkCondition(o.query) : '') || JIRA_DEFAULT_QUERY;
}

const LIST_FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'updated', 'sprint'];
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9}$/;

/** An issue as a search lists it. The sprint is any field holding sprints (`sprint` where the site takes the name, else the custom field it answered). */
function listedJira(site: string, raw: unknown): TrackerSearchItem | null {
  const j = obj(raw);
  const key = str(j.key).toUpperCase();
  if (!ISSUE_KEY.test(key)) return null;
  const f = obj(j.fields);
  let iteration: string | null = null;
  for (const v of Object.values(f)) {
    if (!Array.isArray(v) || !v.length) continue;
    const first = obj(v[0]);
    if (typeof v[0] === 'string' ? /\[.*\bname=/.test(v[0] as string) : 'boardId' in first || ('state' in first && 'name' in first && 'id' in first && 'startDate' in first)) {
      iteration = iterationOf(v)?.name ?? null;
      break;
    }
  }
  return {
    url: `${site}/browse/${key}`,
    key,
    title: trackerLine(f.summary, 200) || key,
    state: trackerLine(obj(f.status).name, L.word),
    type: trackerLine(obj(f.issuetype).name, L.word),
    iteration,
    assignee: trackerLine(obj(f.assignee).displayName, L.person) || null,
    updatedAt: trackerDate(f.updated),
  };
}

/**
 * One page of the issues a JQL condition (or a filter compiled to one) picks in one project, newest
 * change first. Jira Cloud: `POST /rest/api/3/search/jql`, the cursor its `nextPageToken`, no total.
 * A self-managed site: `POST /rest/api/2/search`, the cursor `startAt`, with Jira's total.
 */
export async function searchJira(io: TrackerIo, o: JiraSearch): Promise<TrackerSearchPage> {
  if (!io.post) throw new TrackerQueryError('This reader cannot run a query.');
  const where = parseJiraWhere(o.where, { anyHost: o.anyHost === true });
  if (!where) throw new TrackerQueryError(NOT_A_JIRA_PLACE);
  const project = await jiraProjectOf(io, where);
  const jql = jiraJql(project, jiraCondition(o), !o.filter && o.sprint === 'current');
  const per = pageSizeOf(o.pageSize);
  if (jiraApiOf(where.site) === '3') {
    const token = o.cursor && /^[A-Za-z0-9_=+/.-]{1,512}$/.test(o.cursor) ? o.cursor : undefined;
    const got = obj(await io.post('/rest/api/3/search/jql', { jql, maxResults: per, fields: LIST_FIELDS, ...(token ? { nextPageToken: token } : {}) }));
    const items = arr(got.issues)
      .slice(0, per)
      .map((i) => listedJira(where.site, i))
      .filter((x): x is TrackerSearchItem => x !== null);
    const next = typeof got.nextPageToken === 'string' && got.isLast !== true && /^[A-Za-z0-9_=+/.-]{1,512}$/.test(got.nextPageToken) ? got.nextPageToken : null;
    return { items, next, total: null };
  }
  const startAt = cursorNumber(o.cursor, 0);
  const got = obj(await io.post('/rest/api/2/search', { jql, startAt, maxResults: per, fields: LIST_FIELDS }));
  const issues = arr(got.issues).slice(0, per);
  const items = issues.map((i) => listedJira(where.site, i)).filter((x): x is TrackerSearchItem => x !== null);
  const total = num(got.total);
  const end = startAt + issues.length;
  return { items, next: issues.length === per && (total === null || end < total) ? String(end) : null, total: total === null ? null : Math.max(0, Math.trunc(total)) };
}

// ---------------------------------------------------------------- what a site and a project offer

/** The site's projects (`/project/search` on Jira Cloud, `/project` on a self-managed site). */
export async function listJiraProjects(io: TrackerIo, api: JiraApi): Promise<TrackerOption[]> {
  const got = await io.get(api === '3' ? `/rest/api/3/project/search?maxResults=${OPTIONS_MAX}&orderBy=name` : '/rest/api/2/project');
  const list = Array.isArray(got) ? got : arr(obj(got).values);
  return list
    .slice(0, OPTIONS_MAX)
    .map(obj)
    .map((p): TrackerOption => ({ value: str(p.key).toUpperCase(), name: trackerLine(p.name, L.word * 2) || str(p.key) }))
    .filter((p) => JIRA_PROJECT_KEY.test(p.value));
}

/** A project's boards, through the agile API. */
export async function listJiraBoards(io: TrackerIo, project: string): Promise<TrackerOption[]> {
  const got = obj(await io.get(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}&maxResults=50`));
  return arr(got.values)
    .map(obj)
    .map((b) => ({ id: num(b.id), name: trackerLine(b.name, L.word * 2), type: trackerLine(b.type, L.word) }))
    .filter((b) => b.id !== null && Number.isSafeInteger(b.id) && b.id > 0)
    .map((b): TrackerOption => ({ value: String(b.id), name: b.name || `Board ${b.id}`, ...(b.type ? { detail: b.type } : {}) }));
}

/** A board's active and future sprints, the active first, with their dates. */
export async function listJiraSprints(io: TrackerIo, board: number): Promise<TrackerOption[]> {
  const got = obj(await io.get(`/rest/agile/1.0/board/${board}/sprint?state=active,future&maxResults=${OPTIONS_MAX}`));
  return arr(got.values)
    .map(obj)
    .map((s): TrackerOption => {
      const state = str(s.state).toLowerCase();
      return { value: trackerLine(s.name, L.word * 2), name: trackerLine(s.name, L.word * 2), start: trackerDate(s.startDate), end: trackerDate(s.endDate), current: state === 'active', detail: trackerLine(state, L.word) };
    })
    .filter((s) => s.value)
    .sort((a, b) => Number(b.current) - Number(a.current))
    .slice(0, OPTIONS_MAX);
}

/** A project's issue types and every status any of them has (`/project/<KEY>/statuses`). */
export async function listJiraStatuses(io: TrackerIo, api: JiraApi, project: string): Promise<{ types: TrackerOption[]; states: TrackerOption[] }> {
  const got = arr(await io.get(`/rest/api/${api}/project/${encodeURIComponent(project)}/statuses`));
  const types: TrackerOption[] = [];
  const states = new Map<string, TrackerOption>();
  for (const raw of got.slice(0, 100)) {
    const t = obj(raw);
    const name = trackerLine(t.name, L.word);
    if (name && types.length < OPTIONS_MAX) types.push({ value: name, name });
    for (const s of arr(t.statuses).slice(0, 100)) {
      const sn = trackerLine(obj(s).name, L.word);
      if (sn && !states.has(sn.toLowerCase()) && states.size < OPTIONS_MAX) {
        const detail = trackerLine(obj(obj(s).statusCategory).name, L.word);
        states.set(sn.toLowerCase(), { value: sn, name: sn, ...(detail ? { detail } : {}) });
      }
    }
  }
  return { types, states: [...states.values()] };
}
