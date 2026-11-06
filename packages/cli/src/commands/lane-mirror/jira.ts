/**
 * Jira Cloud for `crossroom lane mirror` (types.ts has the contract and the rules).
 *
 * - The token is the person's own API token, `JIRA_API_TOKEN`, sent as basic auth with the account's
 *   e-mail (`JIRA_EMAIL`). The base is the config's `site`, `https://<site>.atlassian.net`, and only it,
 *   or for a scoped or service account's token `https://api.atlassian.com/ex/jira/<cloudId>`, whose
 *   path prefixes every request. There an issue's page is on `browse` (the real site), else on the
 *   site its `self` names when that is `*.atlassian.net`, else it has no address.
 * - An issue carries the marker twice: as a label (`markerTag`, since a Jira label takes no `:` or
 *   `/`), which `find` searches by JQL, and as a line in the description, which confirms it.
 * - Trusted means the account may edit issues in the project, as Jira's own permission search
 *   answers it (`EDIT_ISSUES`), unless the config lists accountIds. That search needs Administer
 *   Projects: a member's token gets 403 or an empty list, so nobody is trusted, and the adapter says
 *   so (`warnings`) rather than staying quiet.
 * - Workflows differ per project, so a lane state maps to a transition's name (`stateMap`). An
 *   unmapped state, or a transition the issue is not offered now, leaves the issue where it is.
 * - Descriptions and comments are ADF: a paragraph per blank-line block, lines joined by hard breaks,
 *   plain text only. Read back, ADF is flattened to plain text.
 */
import type { LaneKind, LaneState } from '@parley/shared/lane';
import { type AdfNode, adfText } from '@parley/shared/trackers';
import {
  type AdapterOptions,
  type Changes,
  type ExternalComment,
  type ExternalIssue,
  type IssueRef,
  markerTag,
  type OutItem,
  type Person,
  parseMarker,
  type TrackerAdapter,
  TrackerError,
  TrustCache,
  trackerFetch,
} from './types.js';

const PAGES = 10;
const FIELDS = ['summary', 'description', 'status', 'labels', 'creator', 'reporter', 'updated'];
/** What `user/permission/search` can't tell a member's token. */
export const JIRA_TRUST_WARNING = "Jira can't tell who may edit issues without admin rights: list trusted accountIds in `trusted`.";
export const JIRA_KIND_TYPES: Record<LaneKind, string> = { bug: 'Bug', task: 'Task', question: 'Task', heads_up: 'Task' };
/** Lane priority (1 urgent .. 4 low) to Jira's default scheme; 0 sends none. */
export const JIRA_PRIORITIES: Record<number, string> = { 1: 'Highest', 2: 'High', 3: 'Medium', 4: 'Low' };

interface JiraUser {
  accountId: string;
  displayName?: string;
}
interface JiraIssue {
  id: string;
  key: string;
  self?: string;
  fields: {
    summary?: string;
    description?: AdfNode | null;
    status?: { name?: string; statusCategory?: { key?: string } };
    labels?: string[];
    creator?: JiraUser | null;
    reporter?: JiraUser | null;
    updated?: string;
  };
}
interface JiraComment {
  id: string;
  author?: JiraUser | null;
  body?: AdfNode | null;
  created: string;
}
interface Transition {
  id: string;
  name: string;
  to?: { name?: string };
}

/** The engine's text as ADF: one paragraph per blank-line-separated block, its lines joined by hard breaks. */
export function toAdf(text: string): AdfNode {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((b) => b.replace(/^\n+|\n+$/g, ''))
    .filter((b) => b.trim() !== '');
  return {
    type: 'doc',
    version: 1,
    content: blocks.map((b) => {
      const content: AdfNode[] = [];
      b.split('\n').forEach((line, i) => {
        if (i > 0) content.push({ type: 'hardBreak' });
        // ADF refuses an empty text node.
        if (line) content.push({ type: 'text', text: line });
      });
      return { type: 'paragraph', content };
    }),
  };
}

/** ADF as plain text: see `adfText` in `@parley/shared/trackers`, shared with the work item reader. */
export { adfText };

/** A JQL string literal. */
export const jql = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** A Jira label takes no whitespace. */
const labelOf = (s: string) => s.trim().replace(/\s+/g, '-');

export function jiraAdapter(o: AdapterOptions): TrackerAdapter {
  const cfg = o.config;
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(cfg.target)) throw new TrackerError(`target for Jira is a project key such as PROJ, not "${cfg.target}".`);
  let base = o.base;
  if (!base) {
    let site: URL | null = null;
    try {
      site = cfg.site ? new URL(cfg.site) : null;
    } catch {
      site = null;
    }
    if (!site) throw new TrackerError('Jira needs the site, https://<site>.atlassian.net.');
    if (site.protocol !== 'https:') throw new TrackerError(`the Jira site must be https, not ${site.protocol.replace(':', '')}.`);
    // The path stays: api.atlassian.com/ex/jira/<cloudId> serves the API under it.
    base = `${site.origin}${site.pathname}`;
  }
  const root = base.replace(/\/+$/, '');
  const rootUrl = new URL(root);
  /** Every request's path under the base's own path, which an absolute `/rest/...` would drop. */
  const prefix = rootUrl.pathname.replace(/\/+$/, '');
  const gateway = rootUrl.hostname === 'api.atlassian.com';
  let browse: string | null = null;
  if (cfg.browse) {
    const b = new URL(cfg.browse);
    if (b.protocol !== 'https:') throw new TrackerError('browse is an https address.');
    browse = b.origin;
  }
  if (!o.user) throw new TrackerError("Jira needs the account's e-mail (JIRA_EMAIL) beside its API token.");
  const auth = `Basic ${Buffer.from(`${o.user}:${o.token}`).toString('base64')}`;
  const fetcher = o.fetcher ?? fetch;
  const project = cfg.target;
  const label = labelOf(cfg.label);
  const call = async <T>(path: string, init: RequestInit & { json?: unknown } = {}) =>
    (await trackerFetch(fetcher, rootUrl.origin, `${prefix}${path}`, { ...init, headers: { authorization: auth } })).body as T;
  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  const issuePath = (r: IssueRef | string) => `/rest/api/3/issue/${encodeURIComponent(typeof r === 'string' ? r : r.id)}`;

  const trust = new TrustCache();
  /** Lookups this run, and how many said yes: none of several means the token can't see the answer. */
  let asked = 0;
  let yes = 0;
  async function person(u: JiraUser | null | undefined): Promise<Person> {
    if (!u?.accountId) return { id: '', name: 'unknown', trusted: false };
    const id = u.accountId;
    const name = u.displayName ?? id;
    // An accountId only: a display name is anyone's to choose.
    if (cfg.trusted.length) return { id, name, trusted: cfg.trusted.includes(id) };
    let t = trust.get(id);
    if (t === undefined) {
      const q = new URLSearchParams({ permissions: 'EDIT_ISSUES', projectKey: project, accountId: id });
      try {
        const users = await call<JiraUser[]>(`/rest/api/3/user/permission/search?${q}`);
        t = Array.isArray(users) && users.some((x) => x?.accountId === id);
      } catch (e) {
        if (!(e instanceof TrackerError) || (e.status !== 404 && e.status !== 403)) throw e;
        if (e.status === 403) warn(JIRA_TRUST_WARNING);
        t = false;
      }
      trust.set(id, t);
      asked++;
      if (t) yes++;
    }
    return { id, name, trusted: t };
  }

  /** The issue's page: on the site, or with the API gateway on `browse` or the site its `self` names. */
  function pageOf(i: JiraIssue): string {
    if (browse) return `${browse}/browse/${i.key}`;
    if (!gateway) return `${root}/browse/${i.key}`;
    try {
      const self = new URL(i.self ?? '');
      if (self.protocol === 'https:' && /^[a-z0-9-]+\.atlassian\.net$/i.test(self.hostname)) return `${self.origin}/browse/${i.key}`;
    } catch {
      // No self, or not a URL: no page.
    }
    return '';
  }
  const ref = (i: JiraIssue): IssueRef => ({ id: i.id, key: i.key, url: pageOf(i) });
  async function issueOf(i: JiraIssue): Promise<ExternalIssue> {
    const f = i.fields ?? {};
    const body = adfText(f.description);
    const labels = f.labels ?? [];
    let marker = parseMarker(body)?.marker ?? null;
    for (const l of labels) marker ??= parseMarker(l)?.marker ?? null;
    return {
      ...ref(i),
      title: f.summary ?? '',
      body,
      open: f.status?.statusCategory?.key !== 'done',
      labels,
      author: await person(f.creator ?? f.reporter),
      closedBy: null,
      marker,
      updatedAt: f.updated ?? '',
    };
  }

  /** The issues a query finds, `pages` pages at most; `more` when the last page read was not the last. */
  async function searchAll(query: string, max: number, pages: number): Promise<{ issues: JiraIssue[]; more: boolean }> {
    const out: JiraIssue[] = [];
    let token: string | undefined;
    for (let page = 0; page < pages; page++) {
      const got = await call<{ issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>('/rest/api/3/search/jql', {
        method: 'POST',
        json: { jql: query, fields: FIELDS, maxResults: max, ...(token ? { nextPageToken: token } : {}) },
      });
      out.push(...(got?.issues ?? []));
      token = got?.nextPageToken;
      if (!token || got?.isLast) return { issues: out, more: false };
    }
    return { issues: out, more: true };
  }
  const search = async (query: string, max: number, pages: number) => (await searchAll(query, max, pages)).issues;

  let me: Promise<string> | undefined;
  function whoami(): Promise<string> {
    me ??= call<JiraUser>('/rest/api/3/myself').then((u) => String(u.accountId));
    me.catch(() => {
      me = undefined;
    });
    return me;
  }

  const read = (id: string) => call<JiraIssue>(`${issuePath(id)}?fields=${FIELDS.join(',')}`);

  /** The description, the marker line kept in it. */
  const describe = (item: OutItem) => toAdf(parseMarker(item.body)?.marker === item.marker ? item.body : `${item.body}\n\n${item.marker}`.trimStart());
  const dueOf = (item: OutItem) => (item.dueAt && /^\d{4}-\d{2}-\d{2}/.test(item.dueAt) ? item.dueAt.slice(0, 10) : null);

  /**
   * A write, tried again without `priority` or `duedate` when Jira answers 400 naming it: a project
   * whose screens leave a field out refuses the whole write for it. Jira names the field in `errors`
   * (`priority: …`), which errorText prints; a 400 that names neither, with a priority sent, is tried
   * once more without the priority, as before. Each field is dropped on its own.
   */
  async function withOptional<T>(fields: Record<string, unknown>, send: (f: Record<string, unknown>) => Promise<T>): Promise<T> {
    let f = { ...fields };
    for (let tries = 0; ; tries++) {
      try {
        return await send(f);
      } catch (e) {
        if (!(e instanceof TrackerError) || e.status !== 400 || tries >= 2) throw e;
        const named = ['priority', 'duedate'].filter((k) => k in f && new RegExp(`\\b${k}\\b`, 'i').test(e.message));
        const drop = named.length ? named : 'priority' in f ? ['priority'] : [];
        if (!drop.length) throw e;
        f = Object.fromEntries(Object.entries(f).filter(([k]) => !drop.includes(k)));
      }
    }
  }

  return {
    provider: 'jira',
    warnings,
    whoami,
    async find(marker) {
      const tag = markerTag(marker);
      const hits = (await search(`project = ${jql(project)} AND labels = ${jql(tag)}`, 10, 1)).filter(
        (i) => (i.fields?.labels ?? []).includes(tag) || parseMarker(adfText(i.fields?.description))?.marker === marker,
      );
      if (hits.length > 1) {
        // The one the mirror made, not one somebody gave the same label.
        const me = await whoami();
        const mine = hits.find((i) => (i.fields?.creator ?? i.fields?.reporter)?.accountId === me);
        if (mine) return issueOf(mine);
      }
      return hits[0] ? issueOf(hits[0]) : null;
    },
    async create(item) {
      const labels = [...new Set([label, ...cfg.labels.map(labelOf), markerTag(item.marker)].filter(Boolean))];
      const priority = JIRA_PRIORITIES[item.priority];
      const due = dueOf(item);
      const fields: Record<string, unknown> = {
        project: { key: project },
        summary: item.title,
        issuetype: { name: cfg.kindMap[item.kind] ?? JIRA_KIND_TYPES[item.kind] },
        description: describe(item),
        labels,
        ...(priority ? { priority: { name: priority } } : {}),
        ...(due ? { duedate: due } : {}),
      };
      const m = await withOptional(fields, (f) => call<{ id?: string; key?: string } | null>('/rest/api/3/issue', { method: 'POST', json: { fields: f } }));
      if (!m?.id) throw new TrackerError('Jira made the issue but did not say which.');
      return issueOf(await read(m.id));
    },
    async update(r, item, before) {
      const priority = JIRA_PRIORITIES[item.priority];
      const due = dueOf(item);
      // The due date only when it moved: a project whose screens lack it refuses every write that names it.
      const dueMoved = !before || (before.dueAt && /^\d{4}-\d{2}-\d{2}/.test(before.dueAt) ? before.dueAt.slice(0, 10) : null) !== due;
      const fields: Record<string, unknown> = {
        summary: item.title,
        description: describe(item),
        ...(dueMoved ? { duedate: due } : {}),
        ...(priority ? { priority: { name: priority } } : {}),
      };
      await withOptional(fields, (f) => call(issuePath(r), { method: 'PUT', json: { fields: f } }));
    },
    async setState(r, state: LaneState) {
      const name = cfg.stateMap[state];
      if (!name) throw new TrackerError(`no Jira transition is mapped for the lane state "${state}" (stateMap.${state}); ${r.key} stays where it is.`);
      const now = (await call<JiraIssue>(`${issuePath(r)}?fields=status`)).fields?.status?.name ?? '';
      const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
      const { transitions = [] } = await call<{ transitions?: Transition[] }>(`${issuePath(r)}/transitions`);
      const t = transitions.find((x) => same(x.name, name));
      if (t && now && same(t.to?.name, now)) return;
      if (!t) {
        // Already where the transition leads, when the transition is named after its status.
        if (now && same(now, name)) return;
        const offered = transitions.map((x) => x.name).join(', ') || 'none';
        throw new TrackerError(`the transition "${name}" (for the lane state "${state}") is not offered on ${r.key} now (it offers: ${offered}); it stays where it is.`);
      }
      await call(`${issuePath(r)}/transitions`, { method: 'POST', json: { transition: { id: t.id } } });
    },
    async comment(r, text) {
      await call(`${issuePath(r)}/comment`, { method: 'POST', json: { body: toAdf(text) } });
    },
    async link(r, url) {
      // globalId makes a second link to the same address update the first instead of adding another.
      await call(`${issuePath(r)}/remotelink`, { method: 'POST', json: { globalId: url, object: { url, title: url } } });
    },
    async mark(r, marker) {
      const tag = markerTag(marker);
      const i = await call<JiraIssue>(`${issuePath(r)}?fields=description,labels`);
      const hasLabel = (i.fields?.labels ?? []).includes(tag);
      const doc = i.fields?.description;
      const hasLine = parseMarker(adfText(doc))?.marker === marker;
      if (hasLabel && hasLine) return;
      const json: Record<string, unknown> = {};
      if (!hasLabel) json.update = { labels: [{ add: tag }] };
      if (!hasLine) {
        const line: AdfNode = { type: 'paragraph', content: [{ type: 'text', text: marker }] };
        json.fields = { description: doc?.type === 'doc' ? { ...doc, content: [...(doc.content ?? []), line] } : toAdf(marker) };
      }
      await call(issuePath(r), { method: 'PUT', json });
    },
    async changes(from): Promise<Changes> {
      const started = Date.now();
      const since = from ?? new Date(started - 86_400_000).toISOString();
      const sinceMs = Date.parse(since);
      // Relative minutes, not a date: JQL reads a date in the account's own time zone, which would
      // skip what changed in the hours between it and UTC for anyone west of Greenwich. The "-<N>m"
      // form is what Jira's own search box accepts; the REST documentation does not state it for
      // `updated`, so it is unconfirmed there.
      const minutes = Math.max(1, Math.ceil((started - (Number.isFinite(sinceMs) ? sinceMs : started - 86_400_000)) / 60_000));
      const found = await searchAll(`project = ${jql(project)} AND labels = ${jql(label)} AND updated >= "-${minutes}m" ORDER BY updated ASC`, 100, PAGES);
      const list = found.issues;
      asked = 0;
      yes = 0;
      let next = new Date(started - 60_000).toISOString();
      if (found.more) {
        // Oldest first, so what was not read is newer than the last issue read: start there next time.
        const last = Date.parse(list.at(-1)?.fields?.updated ?? '');
        next = Number.isFinite(last) ? new Date(last).toISOString() : since;
        warnings.push(`Jira had more changed issues than ${PAGES} pages; the rest are read on the next run.`);
      }
      const issues: ExternalIssue[] = [];
      const comments: ExternalComment[] = [];
      for (const i of list) {
        issues.push(await issueOf(i));
        // Newest first, so the walk stops at the first comment the cursor has already seen.
        const fresh: JiraComment[] = [];
        for (let page = 0, startAt = 0; page < PAGES; page++) {
          const q = new URLSearchParams({ orderBy: '-created', maxResults: '100', startAt: String(startAt) });
          const got = await call<{ comments?: JiraComment[]; total?: number }>(`${issuePath(i.key)}/comment?${q}`);
          const list = got?.comments ?? [];
          let older = false;
          for (const c of list) {
            if (Date.parse(c.created) > sinceMs) fresh.push(c);
            else older = true;
          }
          startAt += list.length;
          if (older || list.length === 0 || (got?.total !== undefined && startAt >= got.total)) break;
          if (page === PAGES - 1) {
            // Newest first: the comments not read are the older ones, so the cursor stays where it was.
            next = since;
            warnings.push(`${i.key} has more new comments than ${PAGES} pages; the rest are read on the next run.`);
          }
        }
        fresh.sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
        for (const c of fresh) comments.push({ id: String(c.id), issue: ref(i), body: adfText(c.body), author: await person(c.author), createdAt: c.created });
      }
      if (asked > 1 && yes === 0) warn(JIRA_TRUST_WARNING);
      // A minute of overlap: what changed while this ran is read again next time, and the engine
      // skips what it already copied.
      return { issues, comments, cursor: next };
    },
  };
}
