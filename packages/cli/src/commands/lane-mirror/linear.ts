/**
 * Linear for `crossroom lane mirror` (types.ts has the contract and the rules).
 *
 * - The token is the person's own personal API key, `LINEAR_API_KEY`, sent bare in `authorization`
 *   (Linear takes no `Bearer` for those). Every call is one POST to `/graphql`.
 * - `target` is a team key (`ENG`). An issue carries the lane's label and the marker on its own line
 *   in its description, so `find` asks for the team's issues whose description contains it and reads
 *   the marker back, archived ones included.
 * - Trusted means a member who is not a guest, unless the config lists people by id or display name
 *   (unique in a workspace), never by full name, which anyone may share.
 * - Labels are matched by name without regard to case (`eqIgnoreCase`), as Linear's own UI matches
 *   them. A lane label the team and workspace lack makes `find` and inbound blind: the adapter says so.
 * - Whether a new comment moves an issue's `updatedAt` (which `changes` filters on) is not stated in
 *   Linear's documentation; comments are read per changed issue, so one on an issue that did not
 *   otherwise change may wait until it does.
 * - States go through `stateMap` to the team's workflow states by name, case-insensitively. A name
 *   the team does not have is never guessed: `setState` throws and the issue stays where it is.
 * - Linear names nobody as an issue's closer, so `closedBy` is always null.
 */
import type { LaneKind, LaneState } from '@parley/shared/lane';
import {
  type AdapterOptions,
  type Changes,
  clip,
  type ExternalComment,
  type ExternalIssue,
  type IssueRef,
  type OutItem,
  type Person,
  parseMarker,
  type TrackerAdapter,
  TrackerError,
  trackerFetch,
} from './types.js';

const API = 'https://api.linear.app';
const PAGES = 10;
export const LINEAR_KIND_LABELS: Partial<Record<LaneKind, string>> = { bug: 'Bug', task: 'Feature', question: 'Question' };
export const LINEAR_STATES: Readonly<Record<LaneState, string>> = {
  open: 'Todo',
  working: 'In Progress',
  needs_info: 'Todo',
  fixed: 'In Review',
  answered: 'In Review',
  wont_fix: 'Canceled',
  closed: 'Done',
};

interface LnUser {
  id: string;
  name: string;
  displayName?: string | null;
  guest?: boolean | null;
}
interface LnState {
  id: string;
  name: string;
  type: string;
}
interface LnTeam {
  id: string;
  key: string;
  states: { nodes: LnState[] };
}
interface LnIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  updatedAt: string;
  state: { name: string; type: string } | null;
  labels: { nodes: Array<{ name: string }> };
  creator: LnUser | null;
}
interface LnComment {
  id: string;
  body: string | null;
  createdAt: string;
  user: LnUser | null;
}
interface Page<T> {
  nodes: T[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
}

const USER = 'id name displayName guest';
const ISSUE = `id identifier url title description updatedAt state { name type } labels(first: 25) { nodes { name } } creator { ${USER} }`;

const Q_TEAM = 'query LinearTeam($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key states(first: 100) { nodes { id name type } } } } }';
const Q_VIEWER = 'query LinearViewer { viewer { id } }';
const Q_LABELS = 'query LinearLabels($filter: IssueLabelFilter!) { issueLabels(filter: $filter, first: 100) { nodes { id name team { id } } } }';
const Q_FIND = `query LinearFind($team: ID!, $marker: String!) { issues(filter: { team: { id: { eq: $team } }, description: { contains: $marker } }, first: 50, includeArchived: true) { nodes { ${ISSUE} } } }`;
const Q_ISSUE = 'query LinearIssue($id: String!) { issue(id: $id) { id description } }';
const Q_CHANGES = `query LinearChanges($team: ID!, $label: String!, $since: DateTimeOrDuration!, $after: String) { issues(filter: { team: { id: { eq: $team } }, labels: { some: { name: { eqIgnoreCase: $label } } }, updatedAt: { gt: $since } }, first: 100, after: $after, includeArchived: true, orderBy: updatedAt) { nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } }`;
const Q_COMMENTS = `query LinearComments($id: String!, $since: DateTimeOrDuration!) { issue(id: $id) { comments(filter: { createdAt: { gt: $since } }, first: 100) { nodes { id body createdAt user { ${USER} } } } } }`;
const M_CREATE = `mutation LinearCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE} } } }`;
const M_UPDATE = 'mutation LinearUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }';
const M_COMMENT = 'mutation LinearComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }';
const M_LINK = 'mutation LinearLink($id: String!, $url: String!) { attachmentLinkURL(issueId: $id, url: $url) { success } }';

/** `YYYY-MM-DD` as the lane wrote the date, or null. */
export function linearDueDate(dueAt: string | null): string | null {
  if (!dueAt) return null;
  const m = /^\d{4}-\d{2}-\d{2}/.exec(dueAt);
  if (m) return m[0];
  const t = Date.parse(dueAt);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** The item's body, with its marker on a line of its own when the engine's text lacks it. */
const withMarker = (text: string, marker: string) => (parseMarker(text)?.marker === marker ? text : `${text}\n\n${marker}`.trimStart());

export function linearAdapter(o: AdapterOptions): TrackerAdapter {
  const cfg = o.config;
  if (!/^[A-Z][A-Z0-9_]{0,9}$/i.test(cfg.target)) throw new TrackerError(`target for Linear is a team key such as ENG, not "${cfg.target}".`);
  const teamKey = cfg.target.toUpperCase();
  const base = o.base ?? API;
  const fetcher = o.fetcher ?? fetch;
  const scrub = (s: string) => (o.token ? s.split(o.token).join('[the token]') : s);
  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };

  async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let body: unknown;
    try {
      body = (await trackerFetch(fetcher, base, '/graphql', { method: 'POST', headers: { authorization: o.token }, json: { query, variables } })).body;
    } catch (e) {
      if (e instanceof TrackerError) throw new TrackerError(scrub(e.message), e.status);
      throw e;
    }
    const b = (body && typeof body === 'object' ? body : {}) as { data?: T | null; errors?: Array<{ message?: string }> };
    if (Array.isArray(b.errors) && b.errors.length) {
      const said = b.errors.map((x) => String(x?.message ?? 'unknown error')).join('; ');
      throw new TrackerError(`Linear refused: ${clip(scrub(said), 300)}`);
    }
    if (!b.data) throw new TrackerError('Linear answered with no data.');
    return b.data;
  }

  let team: Promise<LnTeam> | undefined;
  function teamOf(): Promise<LnTeam> {
    team ??= gql<{ teams: Page<LnTeam> }>(Q_TEAM, { key: teamKey }).then((d) => {
      const t = d.teams.nodes.find((x) => x.key.toUpperCase() === teamKey) ?? d.teams.nodes[0];
      if (!t) throw new TrackerError(`Linear has no team with the key ${teamKey} that this key can see.`);
      return t;
    });
    // A failed lookup is asked again next time, not remembered.
    team.catch(() => {
      team = undefined;
    });
    return team;
  }

  /** Label names to ids: the team's own label first, then a workspace label. Names Linear lacks are skipped, never created. */
  const labelIds = new Map<string, string | null>();
  async function resolveLabels(names: string[]): Promise<string[]> {
    const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    const unknown = wanted.filter((n) => !labelIds.has(n.toLowerCase()));
    if (unknown.length) {
      const t = await teamOf();
      const filter = { or: unknown.map((n) => ({ name: { eqIgnoreCase: n } })) };
      const got = (await gql<{ issueLabels: Page<{ id: string; name: string; team: { id: string } | null }> }>(Q_LABELS, { filter })).issueLabels.nodes;
      for (const n of unknown) {
        const mine = got.filter((l) => l.name.toLowerCase() === n.toLowerCase() && (!l.team || l.team.id === t.id));
        const hit = mine.find((l) => l.team) ?? mine[0];
        labelIds.set(n.toLowerCase(), hit?.id ?? null);
      }
    }
    if (wanted.some((n) => n.toLowerCase() === cfg.label.toLowerCase()) && labelIds.get(cfg.label.toLowerCase()) === null)
      warn(`Linear has no label "${cfg.label}" in team ${teamKey} or the workspace: issues go out unlabelled, and inbound and finding an issue by its label can't work until the label exists.`);
    return [...new Set(wanted.map((n) => labelIds.get(n.toLowerCase())).filter((x): x is string => !!x))];
  }
  const labelsFor = (item: OutItem) => [cfg.label, ...cfg.labels, ...(cfg.kindMap[item.kind] ?? LINEAR_KIND_LABELS[item.kind] ?? '').split(',')];

  const person = (u: LnUser | null): Person => {
    if (!u) return { id: '', name: '(an integration)', trusted: false };
    const name = u.displayName || u.name;
    if (cfg.trusted.length) return { id: u.id, name, trusted: cfg.trusted.includes(u.id) || (!!u.displayName && cfg.trusted.includes(u.displayName)) };
    return { id: u.id, name, trusted: u.guest === false };
  };
  const ref = (i: LnIssue): IssueRef => ({ id: i.id, key: i.identifier, url: i.url });
  const issueOf = (i: LnIssue): ExternalIssue => {
    const body = i.description ?? '';
    return {
      ...ref(i),
      title: i.title,
      body,
      open: i.state?.type !== 'completed' && i.state?.type !== 'canceled',
      labels: i.labels.nodes.map((l) => l.name),
      author: person(i.creator),
      closedBy: null,
      marker: parseMarker(body)?.marker ?? null,
      updatedAt: i.updatedAt,
    };
  };

  let me: Promise<string> | undefined;
  function whoami(): Promise<string> {
    me ??= gql<{ viewer: { id: string } }>(Q_VIEWER).then((d) => d.viewer.id);
    me.catch(() => {
      me = undefined;
    });
    return me;
  }

  async function updateIssue(id: string, input: Record<string, unknown>) {
    const d = await gql<{ issueUpdate: { success: boolean } }>(M_UPDATE, { id, input });
    if (!d.issueUpdate?.success) throw new TrackerError('Linear did not update the issue.');
  }

  async function comment(r: IssueRef, text: string) {
    const d = await gql<{ commentCreate: { success: boolean } }>(M_COMMENT, { input: { issueId: r.id, body: text } });
    if (!d.commentCreate?.success) throw new TrackerError('Linear did not add the comment.');
  }

  return {
    provider: 'linear',
    warnings,
    whoami,
    async find(marker) {
      const t = await teamOf();
      const list = (await gql<{ issues: Page<LnIssue> }>(Q_FIND, { team: t.id, marker })).issues.nodes.filter((i) => parseMarker(i.description ?? '')?.marker === marker);
      let hit = list[0];
      if (list.length > 1) {
        const me = await whoami();
        hit = list.find((i) => i.creator?.id === me) ?? hit;
      }
      return hit ? issueOf(hit) : null;
    },
    async create(item) {
      const t = await teamOf();
      const input: Record<string, unknown> = {
        teamId: t.id,
        title: item.title,
        description: withMarker(item.body, item.marker),
        labelIds: await resolveLabels(labelsFor(item)),
        priority: item.priority,
      };
      const due = linearDueDate(item.dueAt);
      if (due) input.dueDate = due;
      const d = await gql<{ issueCreate: { success: boolean; issue: LnIssue | null } }>(M_CREATE, { input });
      if (!d.issueCreate?.success || !d.issueCreate.issue) throw new TrackerError('Linear did not create the issue.');
      return issueOf(d.issueCreate.issue);
    },
    async update(r, item) {
      await updateIssue(r.id, { title: item.title, description: withMarker(item.body, item.marker), priority: item.priority, dueDate: linearDueDate(item.dueAt) });
    },
    async setState(r, state) {
      const t = await teamOf();
      const name = cfg.stateMap[state] ?? LINEAR_STATES[state];
      const to = name ? t.states.nodes.find((s) => s.name.toLowerCase() === name.trim().toLowerCase()) : undefined;
      if (!to) throw new TrackerError(`Linear team ${teamKey} has no workflow state "${name ?? ''}" for the lane's state ${state}: name one in stateMap.${state}.`);
      await updateIssue(r.id, { stateId: to.id });
    },
    comment,
    async link(r, url) {
      try {
        const d = await gql<{ attachmentLinkURL: { success: boolean } }>(M_LINK, { id: r.id, url });
        if (d.attachmentLinkURL?.success) return;
      } catch (e) {
        if (!(e instanceof TrackerError)) throw e;
      }
      await comment(r, `Linked: ${url}`);
    },
    async mark(r, marker) {
      const i = (await gql<{ issue: { id: string; description: string | null } | null }>(Q_ISSUE, { id: r.id })).issue;
      if (!i) throw new TrackerError(`Linear has no issue ${r.key}.`);
      const text = i.description ?? '';
      if (parseMarker(text)?.marker === marker) return;
      await updateIssue(r.id, { description: withMarker(text, marker) });
    },
    async changes(from): Promise<Changes> {
      const started = Date.now();
      const since = from ?? new Date(started - 86_400_000).toISOString();
      const t = await teamOf();
      // Said once a run when the lane label is missing: the filter below then matches nothing.
      await resolveLabels([cfg.label]);
      const list: LnIssue[] = [];
      let after: string | null = null;
      // Linear documents no direction for `orderBy: updatedAt`, so when the cap stops the walk the
      // cursor can't be placed after what was read: it stays where it was.
      let next = new Date(started - 60_000).toISOString();
      for (let page = 0; ; page++) {
        const got: Page<LnIssue> = (await gql<{ issues: Page<LnIssue> }>(Q_CHANGES, { team: t.id, label: cfg.label, since, after })).issues;
        list.push(...got.nodes);
        if (!got.pageInfo?.hasNextPage || !got.pageInfo.endCursor) break;
        if (page === PAGES - 1) {
          next = since;
          warn(`Linear had more changed issues than ${PAGES * 100}; the cursor stays where it was until a run reads them all.`);
          break;
        }
        after = got.pageInfo.endCursor;
      }
      const comments: ExternalComment[] = [];
      // One query per issue: comments nested in the list would pass Linear's query complexity limit.
      for (const i of list) {
        const got = (await gql<{ issue: { comments: Page<LnComment> } | null }>(Q_COMMENTS, { id: i.id, since })).issue?.comments.nodes ?? [];
        if (got.length >= 100) {
          next = since;
          warn(`${i.identifier} has 100 or more new comments; the cursor stays where it was.`);
        }
        for (const c of got) comments.push({ id: c.id, issue: ref(i), body: c.body ?? '', author: person(c.user), createdAt: c.createdAt });
      }
      // A minute of overlap, as github.ts: what changed while this ran is read again next time.
      return { issues: list.map(issueOf), comments, cursor: next };
    },
  };
}
