/**
 * Azure DevOps Boards for `crossroom lane mirror` (types.ts has the contract and the rules).
 *
 * - The token is the person's own: a PAT from `AZURE_DEVOPS_PAT` or `AZURE_DEVOPS_EXT_PAT`, sent as
 *   basic auth with an empty user, or, with `user: 'bearer'`, Azure Pipelines' `System.AccessToken`
 *   as a bearer token. A PAT needs Work Items read and write on the one organization.
 * - A work item carries the lane's tag (`crossroom` by default) and the marker twice: as a tag
 *   (`markerTag`, since a tag can't hold `:` or `/`) and as a line of its description. `find` asks
 *   WIQL for the tag and confirms it on the item it reads back.
 * - Trusted means a project member, which anyone who can write a work item is, unless the config
 *   lists people by an identity's id or unique name (never a display name, which anyone may share).
 * - The lane's kind picks the work item type on create; its state is a `System.State` value from
 *   `stateMap`, else the Agile process's names for the item's type (a Bug has Resolved, a Task
 *   does not). A state Azure refuses is never guessed at. A Bug's form shows Repro Steps rather than
 *   the description, so a Bug gets the body in both.
 * - A legacy `https://<org>.visualstudio.com` site names the organization in its host, so no
 *   `/<org>` goes before its paths.
 * - Unconfirmed: whether a new comment moves a work item's `System.ChangedDate` (which `changes`
 *   filters on), and whether `connectionData`'s `authenticatedUser.id` is the id work items carry
 *   in `System.CreatedBy`. If either is not so, a comment on an otherwise unchanged item waits for
 *   its next change, and the mirror's own items are judged by trust like anyone's.
 */
import { fromHtml } from '@parley/shared/azure-devops';
import type { LaneKind, LaneState } from '@parley/shared/lane';
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
  trackerFetch,
} from './types.js';

const SITE = 'https://dev.azure.com';
const V = 'api-version=7.1';
const V_COMMENTS = 'api-version=7.1-preview.4';
const BATCH = 200;
const PAGES = 10;
const DONE = ['closed', 'removed', 'done'];

export const AZURE_KIND_TYPES: Readonly<Record<LaneKind, string>> = { bug: 'Bug', task: 'Task', question: 'Task', heads_up: 'Task' };
/** The Agile process's Bug states. A Scrum or Basic project sets `stateMap`. */
export const AZURE_STATES: Readonly<Record<LaneState, string>> = {
  open: 'New',
  working: 'Active',
  needs_info: 'Active',
  fixed: 'Resolved',
  answered: 'Resolved',
  wont_fix: 'Removed',
  closed: 'Closed',
};
/** The Agile process's Task (and every other type's) states: no Resolved, so fixed and answered stay Active. */
export const AZURE_TASK_STATES: Readonly<Record<LaneState, string>> = {
  open: 'New',
  working: 'Active',
  needs_info: 'Active',
  fixed: 'Active',
  answered: 'Active',
  wont_fix: 'Removed',
  closed: 'Closed',
};
/** The default state for a lane state on a work item of `type`. */
export const azureState = (type: string, state: LaneState) => (type.trim().toLowerCase() === 'bug' ? AZURE_STATES : AZURE_TASK_STATES)[state];

const F = {
  title: 'System.Title',
  description: 'System.Description',
  tags: 'System.Tags',
  state: 'System.State',
  priority: 'Microsoft.VSTS.Common.Priority',
  due: 'Microsoft.VSTS.Scheduling.DueDate',
  repro: 'Microsoft.VSTS.TCM.ReproSteps',
  type: 'System.WorkItemType',
} as const;

type Identity = { id?: string; displayName?: string; uniqueName?: string } | string | null | undefined;
interface AzItem {
  id: number;
  fields: Record<string, unknown>;
  relations?: Array<{ rel: string; url: string }> | null;
  _links?: { html?: { href?: string } };
}
interface AzComment {
  id?: number;
  commentId?: number;
  text?: string;
  createdBy?: Identity;
  createdDate: string;
  isDeleted?: boolean;
}
interface PatchOp {
  op: 'add';
  path: string;
  value: unknown;
}

/** Text as Azure's HTML fields hold it: escaped, line breaks as `<br>`. */
export const toHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n|\r|\n/g, '<br>');

/** An HTML field as plain text: see `fromHtml` in `@parley/shared/azure-devops`, shared with the work item import. */
export { fromHtml };

/** A WIQL string literal: single quotes doubled. */
const wiqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

const tagsOf = (v: unknown) =>
  typeof v === 'string'
    ? v
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

function checkTag(t: string, what: string) {
  if (!t.trim() || /[;,]/.test(t)) throw new TrackerError(`${what} "${t}" can't be an Azure DevOps tag: a tag is not empty and holds no ";" or ",".`);
}

export function azureAdapter(o: AdapterOptions): TrackerAdapter {
  const cfg = o.config;
  const t = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([^/\\]+)$/.exec(cfg.target);
  const projectName = t?.[2]?.trim() ?? '';
  if (!t || !projectName || [...projectName].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))
    throw new TrackerError(`target for Azure DevOps is organization/project, not "${cfg.target}".`);
  const org = t[1]!;
  checkTag(cfg.label, 'The label');
  for (const l of cfg.labels) checkTag(l, 'The label');

  const base = (o.base ?? cfg.site ?? SITE).replace(/\/+$/, '');
  let prefix: string;
  try {
    prefix = new URL(base).pathname.replace(/\/+$/, '');
  } catch {
    throw new TrackerError(`site for Azure DevOps is an https address, not "${base}".`);
  }
  const fetcher = o.fetcher ?? fetch;
  // A legacy https://<org>.visualstudio.com host already names the organization.
  const legacy = /\.visualstudio\.com$/i.test(new URL(base).hostname);
  const orgPath = legacy ? prefix : `${prefix}/${encodeURIComponent(org)}`;
  const proj = `${orgPath}/${encodeURIComponent(projectName)}`;
  const auth = o.user === 'bearer' ? `Bearer ${o.token}` : `Basic ${Buffer.from(`:${o.token}`).toString('base64')}`;

  const call = async <T>(path: string, init: RequestInit & { json?: unknown } = {}) =>
    (await trackerFetch(fetcher, base, path, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: auth } })).body as T;
  const patch = (path: string, method: 'POST' | 'PATCH', ops: PatchOp[]) =>
    call<AzItem>(path, { method, json: ops, headers: { 'content-type': 'application/json-patch+json' } });
  const add = (field: string, value: unknown): PatchOp => ({ op: 'add', path: `/fields/${field}`, value });

  const person = (u: Identity): Person => {
    let r: { id?: string; displayName?: string; uniqueName?: string } = {};
    if (typeof u === 'string') {
      // An older shape: "Display Name <unique name>".
      const m = /^(.*?)\s*<([^>]+)>$/.exec(u);
      r = m ? { id: m[2], displayName: m[1] || m[2], uniqueName: m[2] } : { id: u, displayName: u, uniqueName: u };
    } else if (u) r = u;
    const id = r.id ?? r.uniqueName ?? '';
    // An id or a unique name: a display name is anyone's to choose.
    const names = [r.id, r.uniqueName].filter((x): x is string => !!x);
    const trusted = cfg.trusted.length ? names.some((x) => cfg.trusted.includes(x)) : id !== '';
    return { id, name: r.displayName ?? r.uniqueName ?? id, trusted };
  };

  const ref = (i: AzItem): IssueRef => ({ id: String(i.id), key: String(i.id), url: `${base}${legacy ? '' : `/${encodeURIComponent(org)}`}/${encodeURIComponent(projectName)}/_workitems/edit/${i.id}` });
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  function issueOf(i: AzItem): ExternalIssue {
    const f = i.fields;
    const body = fromHtml(str(f[F.description]));
    const labels = tagsOf(f[F.tags]);
    const open = !DONE.includes(str(f[F.state]).toLowerCase());
    const closer = f['Microsoft.VSTS.Common.ClosedBy'] as Identity;
    let marker = parseMarker(body)?.marker ?? null;
    for (const l of labels) marker ??= parseMarker(l)?.marker ?? null;
    return {
      ...ref(i),
      title: str(f[F.title]),
      body,
      open,
      labels,
      author: person(f['System.CreatedBy'] as Identity),
      closedBy: !open && closer ? person(closer) : null,
      marker,
      updatedAt: str(f['System.ChangedDate']),
    };
  }

  async function wiql(where: string, timePrecision = false): Promise<number[]> {
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ${where} ORDER BY [System.ChangedDate] DESC`;
    const r = await call<{ workItems?: Array<{ id: number }> }>(`${proj}/_apis/wit/wiql?${V}${timePrecision ? '&timePrecision=true' : ''}`, {
      method: 'POST',
      json: { query },
    });
    return (r.workItems ?? []).map((w) => w.id).filter((id) => Number.isSafeInteger(id));
  }

  /** The work items, read whole, `BATCH` at a time; one deleted since the query is left out. */
  async function items(ids: number[]): Promise<AzItem[]> {
    const out: AzItem[] = [];
    for (let k = 0; k < ids.length; k += BATCH) {
      const r = await call<{ value?: Array<AzItem | null> }>(`${proj}/_apis/wit/workitems?ids=${ids.slice(k, k + BATCH).join(',')}&$expand=all&errorPolicy=omit&${V}`);
      for (const i of r.value ?? []) if (i) out.push(i);
    }
    return out;
  }

  const item = (id: string, query: string) => call<AzItem>(`${proj}/_apis/wit/workitems/${encodeURIComponent(id)}?${query}&${V}`);

  /** Priority and due date, where the lane has them. */
  const schedule = (it: OutItem): PatchOp[] => {
    const ops: PatchOp[] = [];
    if (Number.isInteger(it.priority) && it.priority >= 1 && it.priority <= 4) ops.push(add(F.priority, it.priority));
    const due = it.dueAt ? new Date(it.dueAt) : null;
    if (due && !Number.isNaN(due.getTime())) ops.push(add(F.due, due.toISOString()));
    return ops;
  };
  /**
   * The optional fields a 400 refuses (TF51535, "Cannot find field"): the ones it names, or all of
   * them when it names none. Null when the refusal is not about a missing field.
   */
  const refusedFields = (e: unknown, optional: PatchOp[]): PatchOp[] | null => {
    if (!(e instanceof TrackerError) || e.status !== 400) return null;
    const named = optional.filter((op) => e.message.includes(op.path.slice('/fields/'.length)));
    if (named.length) return named;
    return /TF51535|cannot find field/i.test(e.message) ? optional : null;
  };

  /** A write with its optional fields (priority, due date, repro steps), made again without each one the process lacks. */
  async function write(path: string, method: 'POST' | 'PATCH', ops: PatchOp[], optional: PatchOp[]): Promise<AzItem> {
    let extra = optional;
    for (;;) {
      try {
        return await patch(path, method, [...ops, ...extra]);
      } catch (e) {
        const drop = extra.length ? refusedFields(e, extra) : null;
        if (!drop) throw e;
        extra = extra.filter((op) => !drop.includes(op));
      }
    }
  }
  const isBug = (kind: LaneKind) => typeFor(kind).toLowerCase() === 'bug';
  /** A Bug's form shows Repro Steps, not the description. */
  const repro = (it: OutItem): PatchOp[] => (isBug(it.kind) ? [add(F.repro, toHtml(it.body))] : []);

  const typeFor = (kind: LaneKind) => {
    const name = cfg.kindMap[kind]?.trim() || AZURE_KIND_TYPES[kind];
    if (!name) throw new TrackerError(`no Azure DevOps work item type for the lane kind ${kind}: set kindMap.${kind}.`);
    return name;
  };

  const warnings: string[] = [];
  let me: Promise<string> | undefined;
  function whoami(): Promise<string> {
    me ??= (async () => {
      const r = await call<{ authenticatedUser?: { id?: string } }>(`${orgPath}/_apis/connectionData`);
      const id = r.authenticatedUser?.id;
      if (!id) throw new TrackerError('Azure DevOps did not say who the token acts as.');
      return id;
    })();
    me.catch(() => {
      me = undefined;
    });
    return me;
  }
  return {
    provider: 'azure',
    warnings,
    whoami,
    async find(marker) {
      const tag = markerTag(marker);
      const ids = await wiql(`[System.Tags] CONTAINS ${wiqlString(tag)}`);
      if (!ids.length) return null;
      const hits = (await items(ids)).filter(
        (i) => tagsOf(i.fields[F.tags]).some((l) => l.toLowerCase() === tag.toLowerCase()) || parseMarker(fromHtml(str(i.fields[F.description])))?.marker === marker,
      );
      if (hits.length > 1) {
        const mine = await whoami();
        const found = hits.map(issueOf).find((x) => x.author.id === mine);
        if (found) return found;
      }
      return hits[0] ? issueOf(hits[0]) : null;
    },
    async create(it) {
      const tags = [...new Set([cfg.label, ...cfg.labels, markerTag(it.marker)])].join('; ');
      const ops = [add(F.title, it.title), add(F.description, toHtml(it.body)), add(F.tags, tags)];
      const made = await write(`${proj}/_apis/wit/workitems/$${encodeURIComponent(typeFor(it.kind))}?${V}`, 'POST', ops, [...schedule(it), ...repro(it)]);
      return issueOf(made);
    },
    async update(r, it) {
      await write(`${proj}/_apis/wit/workitems/${encodeURIComponent(r.id)}?${V}`, 'PATCH', [add(F.title, it.title), add(F.description, toHtml(it.body))], [...schedule(it), ...repro(it)]);
    },
    async setState(r, state: LaneState) {
      const now = await item(r.id, `fields=${F.state},${F.type}`);
      const target = cfg.stateMap[state]?.trim() || azureState(str(now.fields[F.type]), state);
      if (!target) throw new TrackerError(`no Azure DevOps state for the lane state ${state}: set stateMap.${state}. The work item stays where it is.`);
      if (str(now.fields[F.state]).toLowerCase() === target.toLowerCase()) return;
      try {
        await patch(`${proj}/_apis/wit/workitems/${encodeURIComponent(r.id)}?${V}`, 'PATCH', [add(F.state, target)]);
      } catch (e) {
        if (!(e instanceof TrackerError) || e.status !== 400) throw e;
        throw new TrackerError(
          `Azure DevOps refused the state "${target}" for work item ${r.id} (lane state ${state}); it stays where it is. Set stateMap.${state} to a state its type allows. ${e.message}`,
          400,
        );
      }
    },
    async comment(r, text) {
      await call(`${proj}/_apis/wit/workItems/${encodeURIComponent(r.id)}/comments?format=html&${V_COMMENTS}`, { method: 'POST', json: { text: toHtml(text) } });
    },
    async link(r, url) {
      const now = await item(r.id, '$expand=relations');
      if ((now.relations ?? []).some((x) => x.rel === 'Hyperlink' && x.url === url)) return;
      await patch(`${proj}/_apis/wit/workitems/${encodeURIComponent(r.id)}?${V}`, 'PATCH', [{ op: 'add', path: '/relations/-', value: { rel: 'Hyperlink', url } }]);
    },
    async mark(r, marker) {
      const now = await item(r.id, `fields=${F.tags},${F.description}`);
      const tag = markerTag(marker);
      const tags = tagsOf(now.fields[F.tags]);
      const description = str(now.fields[F.description]);
      const ops: PatchOp[] = [];
      if (!tags.some((l) => l.toLowerCase() === tag.toLowerCase())) ops.push(add(F.tags, [...tags, tag].join('; ')));
      if (parseMarker(fromHtml(description))?.marker !== marker) ops.push(add(F.description, description ? `${description}<br><br>${toHtml(marker)}` : toHtml(marker)));
      if (ops.length) await patch(`${proj}/_apis/wit/workitems/${encodeURIComponent(r.id)}?${V}`, 'PATCH', ops);
    },
    async changes(cursor): Promise<Changes> {
      const started = Date.now();
      const from = new Date(cursor ?? started - 86_400_000);
      if (Number.isNaN(from.getTime())) throw new TrackerError(`the mirror's cursor "${cursor}" is not a time.`);
      // Rebuilt from the parsed time, so nothing but a timestamp ever reaches the query.
      const since = from.toISOString();
      const ids = await wiql(`[System.Tags] CONTAINS ${wiqlString(cfg.label)} AND [System.ChangedDate] > ${wiqlString(since)}`, true);
      const got = await items(ids);
      const issues = got.map(issueOf);
      const comments: ExternalComment[] = [];
      for (const i of got) {
        const r = ref(i);
        let token = '';
        for (let page = 0; page < PAGES; page++) {
          const q = `$top=200&order=asc${token ? `&continuationToken=${encodeURIComponent(token)}` : ''}&${V_COMMENTS}`;
          const list = await call<{ comments?: AzComment[]; continuationToken?: string | null }>(`${proj}/_apis/wit/workItems/${i.id}/comments?${q}`);
          for (const c of list.comments ?? []) {
            const cid = c.id ?? c.commentId;
            if (cid === undefined || c.isDeleted || !(new Date(c.createdDate).getTime() > from.getTime())) continue;
            comments.push({ id: String(cid), issue: r, body: fromHtml(c.text ?? ''), author: person(c.createdBy), createdAt: c.createdDate });
          }
          token = list.continuationToken ?? '';
          if (!token) break;
        }
      }
      // A minute of overlap: what changed while this ran is read again next time, and the engine
      // skips what it already copied.
      return { issues, comments, cursor: new Date(started - 60_000).toISOString() };
    },
  };
}
