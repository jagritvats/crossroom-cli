/**
 * An Azure DevOps work item, read through a getter on `https://dev.azure.com` (tracker-read/io.ts): the item
 * with its relations (`$expand=relations`, which returns every field), the related items' titles in one
 * batch, its iteration's dates from the classification node, and its latest comments.
 *
 * - Relations: Parent, Child, Related, Predecessor, Successor (and any other work item link) as
 *   work item links named by Azure DevOps' own word; an `ArtifactLink` to a pull request, a commit or
 *   a branch as a link to its page in the project's repository; a `Hyperlink` as a page.
 * - Acceptance criteria from `Microsoft.VSTS.Common.AcceptanceCriteria`, else from the description.
 * - The iteration is `System.IterationPath`: its last segment the name, the path kept. The project's
 *   root iteration is no iteration.
 * - Points are story points, else effort, else size.
 */
import { azureItemUrl, fromHtml } from '../azure-devops.js';
import { checkCondition, compileFilter, type TrackerFilter } from './filter.js';
import {
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
  uniqueLinks,
} from '../trackers.js';
import { arr, besides, num, obj, pointsOf, type ReadOptions, readAt, str, TrackerAnswerError, type TrackerIo, type TrackerRead, BRIEF_CHARS as MAX_BRIEF_CHARS, cursorNumber, OPTIONS_MAX, pageSizeOf, TrackerQueryError, type TrackerOption, type TrackerSearchItem, type TrackerSearchPage } from './io.js';

export interface AzureItemRef {
  /** The organization, lower-cased. */
  org: string;
  /** The project, as written. */
  project: string;
  id: number;
}

export const AZURE_API = 'api-version=7.1';
/** The comments API is still a preview (as the lanes' mirror uses it). */
export const AZURE_COMMENTS_API = 'api-version=7.1-preview.4';
const SITE = 'https://dev.azure.com';
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const enc = encodeURIComponent;
/** `/<org>/<project>`, each part escaped. */
export const projectPath = (org: string, project: string) => `/${enc(org)}/${enc(project)}`;
/** One item's own path, with its relations. */
export const itemPath = (ref: AzureItemRef) => `${projectPath(ref.org, ref.project)}/_apis/wit/workitems/${ref.id}?$expand=relations&${AZURE_API}`;

/** An HTML field as text, without the HTML comments `fromHtml` keeps for the lanes' mirror. */
const htmlText = (html: unknown) =>
  fromHtml(str(html))
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .trim();

const person = (v: unknown): string => (v && typeof v === 'object' ? str(obj(v).displayName) : str(v));

/** A cache a sync shares across items, so an iteration's dates are asked once. */
export type AzureCache = Map<string, Promise<{ start: string | null; end: string | null }>>;

/** Read one work item; `raw` is its JSON (with relations) when a batch already answered it. */
export async function readAzureWorkItem(io: TrackerIo, ref: AzureItemRef, o: ReadOptions & { cache?: AzureCache }, raw?: unknown): Promise<TrackerRead> {
  const j = obj(raw ?? (await io.get(itemPath(ref))));
  if (j.id !== ref.id) throw new TrackerAnswerError('Azure DevOps answered for another item.');
  const f = obj(j.fields);
  const body = trackerText(htmlText(f['System.Description']) || htmlText(f['Microsoft.VSTS.TCM.ReproSteps']), MAX_BRIEF_CHARS);
  const ac = htmlText(f['Microsoft.VSTS.Common.AcceptanceCriteria']);
  const count = num(f['System.CommentCount']);
  const [links, iteration, comments] = await Promise.all([
    linksOf(io, ref, arr(j.relations)),
    iterationOf(io, ref, str(f['System.IterationPath']), o.cache),
    count === 0 ? Promise.resolve({ comments: [], total: 0 }) : commentsOf(io, ref),
  ]);
  const priority = f['Microsoft.VSTS.Common.Priority'];
  return {
    title: trackerLine(f['System.Title'], 200) || `${ref.org}/${ref.project}#${ref.id}`,
    body,
    criteria: ac ? criteriaFromField(ac) : criteriaFromText(body),
    snapshot: {
      key: trackerLine(`#${ref.id}`, L.key),
      type: trackerLine(f['System.WorkItemType'], L.word),
      state: trackerLine(f['System.State'], L.word),
      assignee: trackerLine(person(f['System.AssignedTo']), L.person) || null,
      iteration,
      labels: str(f['System.Tags'])
        .split(';')
        .map((t) => trackerLine(t, L.label))
        .filter(Boolean)
        .slice(0, L.labels),
      priority: trackerLine(typeof priority === 'number' ? String(priority) : priority, L.word),
      points: pointsOf(f['Microsoft.VSTS.Scheduling.StoryPoints']) ?? pointsOf(f['Microsoft.VSTS.Scheduling.Effort']) ?? pointsOf(f['Microsoft.VSTS.Scheduling.Size']),
      links,
      comments: comments.comments,
      commentCount: Math.min(1_000_000, Math.max(Math.trunc(count ?? 0), comments.total, comments.comments.length)),
      updatedAt: trackerDate(f['System.ChangedDate']),
      readAt: readAt(o),
      readBy: o.readBy,
    },
  };
}

const RELATION_WORDS: Record<string, string> = {
  'System.LinkTypes.Hierarchy-Reverse': 'Parent',
  'System.LinkTypes.Hierarchy-Forward': 'Child',
  'System.LinkTypes.Related': 'Related',
  'System.LinkTypes.Dependency-Reverse': 'Predecessor',
  'System.LinkTypes.Dependency-Forward': 'Successor',
  'System.LinkTypes.Duplicate-Forward': 'Duplicate',
  'System.LinkTypes.Duplicate-Reverse': 'Duplicate of',
};

/** The item's relations as links, the related items named by a batch read where it answers. */
async function linksOf(io: TrackerIo, ref: AzureItemRef, relations: unknown[]): Promise<TrackerLink[]> {
  const base = `${SITE}${projectPath(ref.org, ref.project)}`;
  const items: { id: number; relation: string }[] = [];
  const others: (TrackerLink | null)[] = [];
  for (const raw of relations.slice(0, 500)) {
    const r = obj(raw);
    const rel = str(r.rel);
    const url = str(r.url);
    const name = str(obj(r.attributes).name);
    const wi = /\/_apis\/wit\/workItems\/([0-9]{1,10})$/i.exec(url);
    if (wi && rel !== 'ArtifactLink' && rel !== 'Hyperlink') {
      items.push({ id: Number(wi[1]), relation: name || RELATION_WORDS[rel] || rel.replace(/^.*\./, '') });
      continue;
    }
    if (rel === 'Hyperlink') {
      others.push(trackerLink('web', 'Hyperlink', url, str(obj(r.attributes).comment)));
      continue;
    }
    if (rel !== 'ArtifactLink') continue;
    const art = /^vstfs:\/\/\/Git\/(PullRequestId|Commit|Ref)\/(.+)$/i.exec(url);
    if (!art) continue;
    let parts: string[];
    try {
      parts = decodeURIComponent(art[2]!).split('/');
    } catch {
      continue;
    }
    const [, repo, ...rest] = parts;
    const what = rest.join('/');
    if (!repo || !GUID.test(repo) || !what) continue;
    const git = `${base}/_git/${repo}`;
    const kind = art[1]!.toLowerCase();
    if (kind === 'pullrequestid' && /^[0-9]{1,10}$/.test(what)) others.push(trackerLink('pull_request', name || 'Pull Request', `${git}/pullrequest/${what}`, `Pull request ${what}`));
    else if (kind === 'commit' && /^[0-9a-f]{7,40}$/i.test(what)) others.push(trackerLink('commit', name || 'Fixed in Commit', `${git}/commit/${what}`, `Commit ${what.slice(0, 7)}`));
    else if (kind === 'ref' && what.startsWith('GB') && what.length > 2) others.push(trackerLink('branch', name || 'Branch', `${git}?version=${enc(what)}`, `Branch ${what.slice(2)}`));
  }
  const wanted = [...new Map(items.map((i) => [i.id, i])).values()].slice(0, L.links);
  const named = new Map<number, Record<string, unknown>>();
  if (wanted.length)
    await besides(undefined, async () => {
      const got = obj(
        await io.get(
          `/${enc(ref.org)}/_apis/wit/workitems?ids=${wanted.map((w) => w.id).join(',')}&fields=System.Title,System.State,System.WorkItemType,System.TeamProject&errorPolicy=omit&${AZURE_API}`,
        ),
      );
      for (const v of arr(got.value)) {
        const id = num(obj(v).id);
        if (id !== null) named.set(id, obj(obj(v).fields));
      }
    });
  const itemLinks = wanted.map(({ id, relation }) => {
    const f = named.get(id);
    const proj = f ? str(f['System.TeamProject']) : '';
    const url = proj ? `${SITE}/${enc(ref.org)}/${enc(proj)}/_workitems/edit/${id}` : `${SITE}/${enc(ref.org)}/_workitems/edit/${id}`;
    const title = f ? `#${id} ${str(f['System.Title'])}` : `#${id}`;
    return trackerLink('work_item', relation, url, title, f ? f['System.State'] : '');
  });
  return uniqueLinks([...itemLinks, ...others]);
}

/** The iteration the item is in, its dates from the classification node where Azure DevOps answers. */
async function iterationOf(io: TrackerIo, ref: AzureItemRef, path: string, cache?: AzureCache): Promise<TrackerIteration | null> {
  const segs = path.split('\\').filter((s) => s.trim() !== '');
  // The project's root iteration is where an item sits until someone plans it.
  if (segs.length < 2) return null;
  const name = trackerLine(segs.at(-1), L.word * 2);
  if (!name) return null;
  const nodePath = `${projectPath(ref.org, ref.project)}/_apis/wit/classificationnodes/Iterations/${segs.slice(1).map(enc).join('/')}?${AZURE_API}`;
  const ask = () =>
    besides({ start: null, end: null }, async () => {
      const a = obj(obj(await io.get(nodePath)).attributes);
      return { start: trackerDate(a.startDate), end: trackerDate(a.finishDate) };
    });
  let dates: Promise<{ start: string | null; end: string | null }>;
  if (cache) {
    dates = cache.get(nodePath) ?? ask();
    cache.set(nodePath, dates);
  } else dates = ask();
  const d = await dates;
  return { name, path: trackerLine(path, L.iterationPath), start: d.start, end: d.end };
}

/** The latest comments, newest asked first and given back oldest first. */
function commentsOf(io: TrackerIo, ref: AzureItemRef) {
  return besides({ comments: [] as ReturnType<typeof latestComments>, total: 0 }, async () => {
    const got = obj(await io.get(`${projectPath(ref.org, ref.project)}/_apis/wit/workItems/${ref.id}/comments?$top=${L.comments}&order=desc&${AZURE_COMMENTS_API}`));
    const list = arr(got.comments)
      .slice(0, L.comments)
      .reverse()
      .map((c) => ({ author: person(obj(c).createdBy), at: obj(c).createdDate, text: htmlText(obj(c).text) }));
    return { comments: latestComments(list), total: Math.max(0, Math.trunc(num(got.totalCount) ?? list.length)) };
  });
}

// ---------------------------------------------------------------- a project, searched

export interface AzureWhere {
  org: string;
  project: string;
  /** The team a board, backlog or sprint address names; only then is there a current iteration to ask for. */
  team?: string;
}

const nameOk = (s: string) => !!s && s.length <= 64 && s.trim() === s && !/[\\/]/.test(s) && ![...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const decode = (s: string | undefined): string | null => {
  if (!s) return null;
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/** An organization, by its address: `https://dev.azure.com/<org>[/...]` or `https://<org>.visualstudio.com[/...]`. */
export function parseAzureOrg(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const org = host === 'dev.azure.com' ? u.pathname.split('/').filter(Boolean)[0] : /^([a-z0-9][a-z0-9-]{0,49})\.visualstudio\.com$/.exec(host)?.[1];
  return org && /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(org) ? org.toLowerCase() : null;
}

/**
 * An Azure DevOps project, by an address in it: `https://dev.azure.com/<org>/<project>[/...]` or
 * `https://<org>.visualstudio.com/<project>[/...]`. A board (`_boards/board/t/<team>/...`), a backlog
 * or a sprint page (`_backlogs/backlog/<team>`, `_sprints/<view>/<team>`) also gives the team.
 */
export function parseAzureProject(raw: string): AzureWhere | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  let org: string | undefined;
  let rest: string[];
  if (host === 'dev.azure.com') [org, ...rest] = segs;
  else {
    org = /^([a-z0-9][a-z0-9-]{0,49})\.visualstudio\.com$/.exec(host)?.[1];
    rest = segs;
  }
  const [proj, area, view, ...after] = rest;
  if (!org || !proj || !/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(org) || proj.startsWith('_')) return null;
  const project = decode(proj);
  if (project === null || !nameOk(project)) return null;
  let teamRaw: string | undefined;
  if (area === '_boards' && view === 'board' && after[0] === 't') teamRaw = after[1];
  else if ((area === '_backlogs' && view === 'backlog') || area === '_sprints') teamRaw = after[0];
  const team = decode(teamRaw);
  return { org: org.toLowerCase(), project, ...(team && nameOk(team) ? { team } : {}) };
}

/** What `sync` and a search ask for when given no condition: everything not yet finished. */
export const AZURE_DEFAULT_QUERY = "[System.State] NOT IN ('Closed', 'Done', 'Removed')";
export const NOT_AN_AZURE_PROJECT = 'That is not the address of an Azure DevOps project (https://dev.azure.com/<organization>/<project>).';
/** The most ids one WIQL query is asked for: a search pages through these. */
export const WIQL_TOP = 1000;

export interface AzureSearch {
  where: string;
  query?: string | null;
  filter?: TrackerFilter | null;
  sprint?: 'current' | null;
  team?: string | null;
  cursor?: string | null;
  pageSize?: number;
  /** How many ids the WIQL asks for: a sync asks for its limit and one more. */
  top?: number;
}

/** The WIQL a search runs, and the path it is posted to (a team's context for `@CurrentIteration`). */
export function azureWiql(at: AzureWhere, o: Pick<AzureSearch, 'query' | 'filter' | 'sprint' | 'team'>): { path: string; query: string } {
  const team = o.team?.trim() || at.team || null;
  const cond = o.filter ? compileFilter('azure', o.filter, { project: at.project, team }) : (o.query?.trim() ? checkCondition(o.query) : '') || AZURE_DEFAULT_QUERY;
  // Without a filter, `sprint: current` is the team's own iteration, read in the team's context.
  const sprint = !o.filter && o.sprint === 'current' && !!team;
  const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project${cond ? ` AND (${cond})` : ''}${sprint ? ' AND [System.IterationPath] = @CurrentIteration' : ''} ORDER BY [System.ChangedDate] DESC`;
  const scope = sprint ? `${projectPath(at.org, at.project)}/${enc(team!)}` : projectPath(at.org, at.project);
  return { path: `${scope}/_apis/wit/wiql`, query };
}

/** The ids a WIQL query picks, newest change first, at most `top`. */
export async function azureIds(io: TrackerIo, at: AzureWhere, o: AzureSearch): Promise<number[]> {
  if (!io.post) throw new TrackerQueryError('This reader cannot run a query.');
  const { path, query } = azureWiql(at, o);
  const top = Math.min(Math.max(Math.trunc(o.top ?? WIQL_TOP), 1), 20_000);
  const r = obj(await io.post(`${path}?$top=${top}&${AZURE_API}`, { query }));
  return arr(r.workItems)
    .map((w) => num(obj(w).id))
    .filter((id): id is number => id !== null && Number.isSafeInteger(id) && id >= 1 && id <= 2_147_483_647);
}

const LIST_FIELDS = ['System.Title', 'System.State', 'System.WorkItemType', 'System.IterationPath', 'System.AssignedTo', 'System.ChangedDate'].join(',');

/**
 * One page of the work items a WIQL condition (or a filter compiled to one) picks in a project, newest
 * change first: the query's ids (`$top` 1,000), then one batch read of the page's ids, their list
 * fields only. The cursor is an offset into the ids; the query runs again for every page, so an item
 * that changed meanwhile may move between pages.
 */
export async function searchAzure(io: TrackerIo, o: AzureSearch): Promise<TrackerSearchPage> {
  const at = parseAzureProject(o.where);
  if (!at) throw new TrackerQueryError(NOT_AN_AZURE_PROJECT);
  const ids = await azureIds(io, at, o);
  const per = pageSizeOf(o.pageSize);
  const offset = cursorNumber(o.cursor, 0, ids.length);
  const want = ids.slice(offset, offset + per);
  const byId = new Map<number, Record<string, unknown>>();
  if (want.length) {
    const got = obj(await io.get(`${projectPath(at.org, at.project)}/_apis/wit/workitems?ids=${want.join(',')}&fields=${LIST_FIELDS}&errorPolicy=omit&${AZURE_API}`));
    for (const v of arr(got.value)) {
      const id = num(obj(v).id);
      if (id !== null) byId.set(id, obj(obj(v).fields));
    }
  }
  const items: TrackerSearchItem[] = [];
  for (const id of want) {
    const f = byId.get(id);
    if (!f) continue;
    const segs = str(f['System.IterationPath']).split('\\').filter((s) => s.trim() !== '');
    items.push({
      url: azureItemUrl(at.org, at.project, id),
      key: `#${id}`,
      title: trackerLine(f['System.Title'], 200) || `#${id}`,
      state: trackerLine(f['System.State'], L.word),
      type: trackerLine(f['System.WorkItemType'], L.word),
      iteration: segs.length >= 2 ? trackerLine(segs.at(-1), L.word * 2) || null : null,
      assignee: trackerLine(person(f['System.AssignedTo']), L.person) || null,
      updatedAt: trackerDate(f['System.ChangedDate']),
    });
  }
  const end = offset + want.length;
  return { items, next: end < ids.length ? String(end) : null, total: ids.length < WIQL_TOP ? ids.length : null };
}

// ---------------------------------------------------------------- what an organization and a project offer

const optionLine = (v: unknown, max: number = L.word * 2) => trackerLine(v, max);

/** The organization's projects. */
export async function listAzureProjects(io: TrackerIo, org: string): Promise<TrackerOption[]> {
  const got = obj(await io.get(`/${enc(org)}/_apis/projects?$top=${OPTIONS_MAX}&${AZURE_API}`));
  return arr(got.value)
    .map(obj)
    .map((p): TrackerOption => {
      const detail = optionLine(p.description, 200);
      return { value: optionLine(p.name, 64), name: optionLine(p.name, 64), ...(detail ? { detail } : {}) };
    })
    .filter((p) => p.value)
    .slice(0, OPTIONS_MAX);
}

/** A project's teams. */
export async function listAzureTeams(io: TrackerIo, org: string, project: string): Promise<TrackerOption[]> {
  const got = obj(await io.get(`/${enc(org)}/_apis/projects/${enc(project)}/teams?$top=${OPTIONS_MAX}&${AZURE_API}`));
  return arr(got.value)
    .map(obj)
    .map((t): TrackerOption => ({ value: optionLine(t.name, 64), name: optionLine(t.name, 64) }))
    .filter((t) => t.value)
    .slice(0, OPTIONS_MAX);
}

/** A team's iterations, the current one first, then the future ones, then the past ones, each with its dates; `value` is the iteration's path. */
export async function listAzureIterations(io: TrackerIo, org: string, project: string, team: string): Promise<TrackerOption[]> {
  const got = obj(await io.get(`${projectPath(org, project)}/${enc(team)}/_apis/work/teamsettings/iterations?${AZURE_API}`));
  const rank = (frame: string) => (frame === 'current' ? 0 : frame === 'future' ? 1 : 2);
  return arr(got.value)
    .map(obj)
    .map((i) => {
      const a = obj(i.attributes);
      const frame = str(a.timeFrame).toLowerCase();
      return {
        frame,
        opt: {
          value: trackerLine(i.path, L.iterationPath) || optionLine(i.name),
          name: optionLine(i.name),
          start: trackerDate(a.startDate),
          end: trackerDate(a.finishDate),
          current: frame === 'current',
        } as TrackerOption,
      };
    })
    .filter((x) => x.opt.value)
    .sort((a, b) => rank(a.frame) - rank(b.frame) || (a.frame === 'past' ? -1 : 1) * String(a.opt.start ?? '').localeCompare(String(b.opt.start ?? '')))
    .map((x) => x.opt)
    .slice(0, OPTIONS_MAX);
}

/** A project's work item types, and every state any of them has. */
/** Azure DevOps types every process has that are not work a person brings in. */
const NOT_WORK_TYPES = /^(Test (Case|Plan|Suite)|Shared (Steps|Parameter)|Code Review (Request|Response)|Feedback (Request|Response))$/i;

export async function listAzureTypesAndStates(io: TrackerIo, org: string, project: string): Promise<{ types: TrackerOption[]; states: TrackerOption[] }> {
  const got = obj(await io.get(`${projectPath(org, project)}/_apis/wit/workitemtypes?${AZURE_API}`));
  const types: TrackerOption[] = [];
  const states = new Map<string, TrackerOption>();
  for (const raw of arr(got.value).slice(0, 200)) {
    const t = obj(raw);
    if (t.isDisabled === true) continue;
    const name = optionLine(t.name);
    // Test management and review types live beside work items in every process, and nobody imports them as work.
    if (!name || NOT_WORK_TYPES.test(name)) continue;
    if (types.length < OPTIONS_MAX) types.push({ value: name, name });
    for (const s of arr(t.states).slice(0, 50)) {
      const sn = optionLine(obj(s).name);
      if (sn && !states.has(sn.toLowerCase()) && states.size < OPTIONS_MAX) {
        const detail = optionLine(obj(s).category);
        states.set(sn.toLowerCase(), { value: sn, name: sn, ...(detail ? { detail } : {}) });
      }
    }
  }
  return { types, states: [...states.values()] };
}
