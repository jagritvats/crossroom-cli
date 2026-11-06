/**
 * Issue trackers a work item can mirror: GitHub, Azure DevOps and Jira, read one way. Zod-free, so
 * the web imports it; the schemas that check what arrives over the wire are in `work.ts`
 * (`TrackerSnapshotSchema`, `ReportedImportInput`).
 *
 * A mirrored item keeps what the tracker says about it in `source.snapshot` (`TrackerSnapshot`): its
 * key, type and state, its sprint or iteration, labels, priority and points, its links to pull
 * requests and other items, and its latest comments. Its acceptance criteria become the work item's
 * own criteria. All of it is the tracker's text, a stranger's: stored sealed, shown as text, never
 * read as an instruction. Every list and string here is bounded by `TRACKER_LIMITS`, and a reader
 * clips to them before anything is sent, so a report never fails on a long field.
 *
 * Who read it: `crossroom` (the relay, without a token, which only a public project allows),
 * `account` (the person's own `crossroom` command or agent, with their own access, which never
 * reaches Crossroom: the account's word, and the item says so), or `runner` (a team's runner, on the
 * team's machine, with the credentials its operator gave it, asked by a member from the web, the API
 * or an agent, or on a saved sync's schedule).
 */

export type TrackerProvider = 'github' | 'azure' | 'jira';
export const TRACKER_PROVIDERS: readonly TrackerProvider[] = ['github', 'azure', 'jira'];

/** How the web app and the commands name a tracker to a person. */
export const TRACKER_WORD: Readonly<Record<TrackerProvider, string>> = { github: 'GitHub', azure: 'Azure DevOps', jira: 'Jira' };

export const TRACKER_LIMITS = {
  key: 120,
  word: 60,
  person: 120,
  labels: 20,
  label: 60,
  links: 50,
  linkTitle: 200,
  url: 2000,
  comments: 20,
  comment: 2000,
  criteria: 30,
  criterion: 400,
  iterationPath: 200,
} as const;

export type TrackerLinkKind = 'pull_request' | 'work_item' | 'commit' | 'branch' | 'web';
export const TRACKER_LINK_KINDS: readonly TrackerLinkKind[] = ['pull_request', 'work_item', 'commit', 'branch', 'web'];

/** A link the tracker holds: a pull request, another item, a commit, a branch, or a page. */
export interface TrackerLink {
  kind: TrackerLinkKind;
  /** The tracker's word for it, as it stands: "Parent", "Child", "Related", "blocks", "Fixed by", "mentioned in". */
  relation: string;
  /** https only; a link that is not is dropped. */
  url: string;
  /** What it is called: the other item's key and title, a pull request's title. */
  title: string;
  /** Its state where the tracker says (open, merged, Done); empty when it doesn't. */
  state: string;
}

export interface TrackerComment {
  /** A display name; shown only, never matched to an account. */
  author: string | null;
  at: string | null;
  text: string;
}

/** A sprint (Jira), an iteration (Azure DevOps) or a milestone (GitHub). */
export interface TrackerIteration {
  name: string;
  /** Azure DevOps' iteration path (`Project\Sprint 12`); empty elsewhere. */
  path: string;
  start: string | null;
  end: string | null;
}

export interface TrackerSnapshot {
  /** The item's own name in its tracker: `PROJ-12`, `#42`, `acme/shop#12`. */
  key: string;
  /** Bug, Task, User Story, Issue, Pull request... */
  type: string;
  /** The tracker's state word: Active, In Progress, open, closed, merged. */
  state: string;
  assignee: string | null;
  iteration: TrackerIteration | null;
  labels: string[];
  priority: string;
  /** Story points or effort, where the tracker keeps them. */
  points: number | null;
  links: TrackerLink[];
  /** The latest comments, oldest first, at most `TRACKER_LIMITS.comments`. */
  comments: TrackerComment[];
  /** How many comments the item has in all (the list may hold fewer). */
  commentCount: number;
  /** When the tracker says it last changed, if it says. */
  updatedAt: string | null;
  /** When Crossroom was told, and who read it. */
  readAt: string;
  readBy: 'crossroom' | 'account' | 'runner';
}

// ---------------------------------------------------------------- bounding

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** One line: every control and line break blanked, spaces collapsed, cut at `max` without splitting a pair. */
export function trackerLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const flat = v
    .replace(/[\r\n\u0085\u2028\u2029\t]+/g, ' ')
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cut(flat, max).trim();
}

/** Text that keeps its lines: controls other than line feeds dropped, line ends made LF, cut at `max`. */
export function trackerText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const t = v
    .replace(/\r\n?|\u0085|\u2028|\u2029/g, '\n')
    .replace(CONTROL, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length > max ? `${cut(t, max - 1)}\u2026` : t;
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

/** An https address as the URL parser writes it, or null: no credentials, nothing else. */
export function trackerUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > TRACKER_LIMITS.url) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.href.length <= TRACKER_LIMITS.url ? u.href : null;
  } catch {
    return null;
  }
}

/** A link, bounded, or null when its address isn't https. */
export function trackerLink(kind: TrackerLinkKind, relation: unknown, url: unknown, title: unknown, state: unknown = ''): TrackerLink | null {
  const u = trackerUrl(url);
  if (!u || !TRACKER_LINK_KINDS.includes(kind)) return null;
  return {
    kind,
    relation: trackerLine(relation, TRACKER_LIMITS.word) || 'Related',
    url: u,
    title: trackerLine(title, TRACKER_LIMITS.linkTitle) || u,
    state: trackerLine(state, TRACKER_LIMITS.word),
  };
}

/** Links, one per address (the first relation kept), at most `TRACKER_LIMITS.links`. */
export function uniqueLinks(links: readonly (TrackerLink | null)[]): TrackerLink[] {
  const seen = new Set<string>();
  const out: TrackerLink[] = [];
  for (const l of links) {
    if (!l || seen.has(l.url)) continue;
    seen.add(l.url);
    out.push(l);
    if (out.length >= TRACKER_LIMITS.links) break;
  }
  return out;
}

/** The latest comments, oldest first, each bounded. */
export function latestComments(all: readonly { author?: unknown; at?: unknown; text?: unknown }[]): TrackerComment[] {
  return all
    .slice(-TRACKER_LIMITS.comments)
    .map((c) => ({
      author: trackerLine(c.author, TRACKER_LIMITS.person) || null,
      at: typeof c.at === 'string' && !Number.isNaN(Date.parse(c.at)) ? new Date(c.at).toISOString() : null,
      text: trackerText(c.text, TRACKER_LIMITS.comment),
    }))
    .filter((c) => c.text !== '');
}

/** A date the tracker gave, as ISO, or null. */
export const trackerDate = (v: unknown): string | null => (typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

// ---------------------------------------------------------------- acceptance criteria

const LIST_ITEM = /^\s*(?:[-*+\u2022]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;
const AC_HEADING = /^\s*(?:#{1,6}\s*|\*\*|__)?\s*(?:acceptance criteria|definition of done|done when)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const HEADING = /^\s*(?:#{1,6}\s+\S|\*\*[^*]+\*\*\s*:?\s*$)/;

/** A field that holds only criteria (Azure DevOps' Acceptance Criteria, a Jira field so named): one per list item, or per line. */
export function criteriaFromField(text: string): string[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const items = lines.some((l) => LIST_ITEM.test(l)) ? lines.flatMap((l) => (LIST_ITEM.test(l) ? [LIST_ITEM.exec(l)![1]!] : [])) : lines;
  return boundCriteria(items);
}

/**
 * The criteria a description lists under an "Acceptance criteria" (or "Definition of done") heading:
 * the list items right below it, until the list ends. Empty when there is no such heading.
 */
export function criteriaFromText(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((l) => AC_HEADING.test(l));
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) {
      if (out.length) {
        // A blank line ends the list unless another item follows.
        const next = lines.slice(i + 1).find((x) => x.trim());
        if (!next || !LIST_ITEM.test(next)) break;
      }
      continue;
    }
    const m = LIST_ITEM.exec(l);
    if (m) out.push(m[1]!);
    else if (HEADING.test(l) || out.length) break;
  }
  return boundCriteria(out);
}

function boundCriteria(items: readonly string[]): string[] {
  return items
    .map((c) => trackerLine(c, TRACKER_LIMITS.criterion))
    .filter(Boolean)
    .slice(0, TRACKER_LIMITS.criteria);
}

// ---------------------------------------------------------------- Jira addresses

export interface JiraIssueRef {
  /** `https://<host>`, lower-cased. */
  site: string;
  /** `PROJ-12`, upper-cased. */
  key: string;
  /** `<host>/<KEY>`: what an imported Jira issue is deduped on. */
  externalId: string;
  /** `https://<host>/browse/<KEY>`. */
  url: string;
}

const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,49}-[1-9][0-9]{0,9}$/;

/** Jira Cloud's own hosts, which the relay may read without a token. */
export const isJiraCloudHost = (host: string) => /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/.test(host.toLowerCase());

/**
 * The issue a Jira address names: `/browse/<KEY>`, or a board, backlog or search page with
 * `selectedIssue=<KEY>`. https only, no credentials, no port. By default only Jira Cloud's
 * `*.atlassian.net`; `anyHost` takes a self-managed site's address too (the `crossroom` command,
 * which reads it with the person's own token).
 */
export function parseJiraIssueUrl(raw: string, o: { anyHost?: boolean } = {}): JiraIssueRef | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!isJiraCloudHost(host) && !(o.anyHost && /^[a-z0-9.-]{1,253}$/.test(host) && host.includes('.'))) return null;
  const m = /(?:^|\/)browse\/([^/?#]+)\/?$/.exec(u.pathname);
  let key = m ? safeDecode(m[1]!) : u.searchParams.get('selectedIssue');
  if (!key || !JIRA_KEY.test(key)) return null;
  key = key.toUpperCase();
  return { site: `https://${host}`, key, externalId: `${host}/${key}`, url: `https://${host}/browse/${key}` };
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/** Whether an address looks like a Jira issue at all (so the import box offers it). */
export const looksLikeJiraUrl = (raw: string) => parseJiraIssueUrl(raw) !== null;

/**
 * The environment variables a person's own Jira credentials are read from (as the lanes' mirror reads
 * them): `JIRA_EMAIL` with `JIRA_API_TOKEN` for Jira Cloud, `JIRA_PAT` (a bearer token) for a
 * self-managed site. `JIRA_SITE` (`https://jira.example.com`) names the one site a token may go to: a
 * self-managed site's address can be anything, so the command sends `JIRA_PAT` only where it names.
 */
export const JIRA_TOKEN_ENV = { email: 'JIRA_EMAIL', token: 'JIRA_API_TOKEN', pat: 'JIRA_PAT', site: 'JIRA_SITE' } as const;

/** The environment variables a person's own GitHub token is read from, in order. */
export const GITHUB_TOKEN_ENV = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;

// ---------------------------------------------------------------- Jira's document format

/** A node of Atlassian Document Format, Jira Cloud's rich text (descriptions, comments, some fields). */
export interface AdfNode {
  type: string;
  version?: number;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

const ADF_INLINE_PARENTS = new Set(['paragraph', 'heading', 'codeBlock']);
const ADF_LINE_LISTS = new Set(['bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem']);

/**
 * ADF as plain text: text kept, hard breaks as line feeds, blocks separated by a blank line, list
 * items one a line. Shared by the lanes' Jira mirror and the work item reader. With `lists`, a list
 * item starts with "- " (or its number), so `criteriaFromText` can find the list under a heading.
 */
export function adfText(node: AdfNode | null | undefined, o: { lists?: boolean } = {}): string {
  const walk = (n: AdfNode | null | undefined, depth: number): string => {
    if (!n || typeof n !== 'object' || depth > 64) return '';
    switch (n.type) {
      case 'text':
        return typeof n.text === 'string' ? n.text : '';
      case 'hardBreak':
        return '\n';
      case 'mention':
      case 'emoji':
        return String(n.attrs?.text ?? n.attrs?.shortName ?? '');
      case 'inlineCard':
      case 'blockCard':
        return String(n.attrs?.url ?? '');
    }
    const kids = Array.isArray(n.content) ? n.content : [];
    if (ADF_INLINE_PARENTS.has(n.type)) return kids.map((k) => walk(k, depth + 1)).join('');
    const parts = kids.map((k) => walk(k, depth + 1)).filter((s) => s !== '');
    if (o.lists && (n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'taskList'))
      return parts.map((t, k) => `${n.type === 'orderedList' ? `${k + 1}.` : '-'} ${t.replace(/\n+/g, ' ')}`).join('\n');
    return parts.join(ADF_LINE_LISTS.has(n.type) ? '\n' : '\n\n');
  };
  return walk(node, 0);
}

// ---------------------------------------------------------------- reads through a team's runner

/** What a tracker read is for: one item by its address, or a saved sync's query. */
export type TrackerReadKind = 'item' | 'sync';
/** `queued` until the runner leases it, `done` with counts, `failed` or `refused` with a reason. */
export type TrackerReadState = 'queued' | 'running' | 'done' | 'failed' | 'refused';

/** How often a saved sync runs, in hours. */
export const SYNC_EVERY_HOURS = [1, 2, 4, 8, 24] as const;
export type SyncEveryHours = (typeof SYNC_EVERY_HOURS)[number];

/** The most items one read reports, and one report call carries. */
export const TRACKER_READ_ITEMS_MAX = 1000;
export const TRACKER_REPORT_BATCH_MAX = 50;
/** The most saved syncs a project keeps. */
export const TRACKER_SYNCS_MAX = 20;

/**
 * Why a runner refused or failed a read, in words a person reads: the runner names the code, the
 * relay never makes one up. `not_configured`: the runner has no credential for that tracker;
 * `not_allowed`: its effects.yml doesn't allow reading there; `not_found`: the tracker has no such
 * item or the credential can't see it; `tracker_error`: the tracker refused or failed.
 */
export const TRACKER_READ_CODES = ['not_configured', 'not_allowed', 'not_found', 'tracker_error', 'expired', 'cancelled'] as const;
export type TrackerReadCode = (typeof TRACKER_READ_CODES)[number];
export const TRACKER_READ_CODE_WORDS: Readonly<Record<TrackerReadCode, string>> = {
  not_configured: "The runner has no credential for this tracker. Its operator sets one in the runner's environment.",
  not_allowed: "The runner's effects.yml does not allow reading from there. Its operator adds a tracker_read entry for it.",
  not_found: "The tracker has no such item, or the runner's credential can't see it.",
  tracker_error: 'The tracker refused or failed. Try again later.',
  expired: 'No runner picked the read up in time. Check that the runner is online.',
  cancelled: 'Cancelled.',
};
