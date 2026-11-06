/**
 * The contract between `crossroom lane mirror`'s engine (engine.ts) and the trackers it mirrors a
 * lane to: GitHub Issues (github.ts), Linear (linear.ts), Jira Cloud (jira.ts) and Azure DevOps
 * Boards (azure.ts).
 *
 * The rules every adapter keeps:
 * - It runs on the person's machine or their CI, with their own token. The hosted Crossroom never
 *   holds a tracker credential, and nothing here sends one anywhere but the tracker's API host.
 * - Every request goes to the one API host the adapter was built for, over https (a loopback
 *   `http:` base only when a test passes one), with `redirect: 'error'`, through `trackerFetch`.
 * - Nothing a lane holds as a credential leaves it: never a seat link, an owner link or a room id.
 *   An issue carries the lane's marker (`mirrorMarker`), a digest of the room id, which names the
 *   item to the mirror and to nobody else.
 * - Every write is found before it is made (`find(marker)` before `create`), so a run that died
 *   between the tracker's write and the mirror's state file makes no second issue.
 * - The lane is the authority. A tracker never moves an item, except the one opt-in rule
 *   (`withdrawOnClose`), and what comes in is a trusted person's words only (`Person.trusted`).
 */
import { createHash } from 'node:crypto';
import type { LaneKind, LaneState, LaneVia } from '@parley/shared/lane';

export type Provider = LaneVia;
export const PROVIDERS: readonly Provider[] = ['github', 'linear', 'jira', 'azure'];

export interface MirrorConfig {
  provider: Provider;
  /**
   * Where issues go. github: `owner/repo`; linear: a team key (`ENG`); jira: a project key
   * (`PROJ`); azure: `organization/project`.
   */
  target: string;
  /**
   * jira: `https://<site>.atlassian.net`, or `https://api.atlassian.com/ex/jira/<cloudId>` for a
   * scoped token. azure: the organization's host, `https://dev.azure.com` by default. Any other host
   * comes from `--site` or `CROSSROOM_TRACKER_SITE`, never the committed file (config.ts).
   */
  site?: string;
  /** jira: where people read an issue, `https://<site>.atlassian.net`, when `site` is the API gateway. */
  browse?: string;
  /** The label (an Azure tag) that marks an issue as the lane's, both ways. Default `crossroom`. */
  label: string;
  /** More labels every mirrored issue gets. */
  labels: string[];
  /** Which items go out: the ones the other side filed (default, the work this side does), this side's, or all. */
  items: 'theirs' | 'mine' | 'all';
  /** Mirror an item's body and its notes' text, not only its title and state. Off by default (thin). */
  body: boolean;
  /** Bring labelled issues and trusted comments in (P2a). */
  inbound: boolean;
  /** A close in the tracker by a trusted person withdraws an item this side filed that is still `open`. Off by default. */
  withdrawOnClose: boolean;
  /** Read `Fixes-Lane: L<n>` trailers from the default branch's commits. On by default inside a git repository. */
  trailers: boolean;
  /**
   * Lane kind to the tracker's word: a label on GitHub and Linear, an issue type on Jira, a work item
   * type on Azure DevOps. Each adapter has its defaults.
   */
  kindMap: Partial<Record<LaneKind, string>>;
  /**
   * Lane state to the tracker's: a workflow state on Linear and Azure DevOps, a transition's name on
   * Jira. A state with no mapping is never guessed: the adapter leaves the issue where it is and
   * says so (`TrackerError`). GitHub only opens and closes.
   */
  stateMap: Partial<Record<LaneState, string>>;
  /**
   * People whose issues and comments come in, in place of the tracker's own check, by an identifier
   * nobody else can take: GitHub a numeric id or login, Linear an id or display name (unique in a
   * workspace), Jira an accountId, Azure DevOps an id or unique name. Never a full or display name.
   */
  trusted: string[];
}

/** An issue, as the engine keeps it in its state file. */
export interface IssueRef {
  /** The tracker's own id (GitHub's issue number, Linear's uuid, Jira's id, Azure's work item id). */
  id: string;
  /** What a person reads: `#12`, `ENG-3`, `PROJ-7`, `1234`. */
  key: string;
  /** The issue's page. */
  url: string;
}

/** Who wrote something in the tracker, and whether the mirror may copy it into the lane. */
export interface Person {
  id: string;
  name: string;
  /** May write to the repository or project (GitHub: push access; Linear: not a guest; Jira: may edit issues; Azure: a project member, which anyone who can write is). */
  trusted: boolean;
}

export interface ExternalIssue extends IssueRef {
  title: string;
  /** As the tracker holds it, hidden text not yet stripped: the engine strips it (`stripHidden`). */
  body: string;
  open: boolean;
  labels: string[];
  author: Person;
  /** Who closed it, when it is closed and the tracker says. */
  closedBy: Person | null;
  /** The lane marker the issue carries, or null. */
  marker: string | null;
  updatedAt: string;
}

export interface ExternalComment {
  id: string;
  issue: IssueRef;
  body: string;
  author: Person;
  createdAt: string;
}

/** One lane item, as it goes out. Composed by the engine; nothing in it is a credential. */
export interface OutItem {
  marker: string;
  /** `L3`. */
  label: string;
  kind: LaneKind;
  state: LaneState;
  title: string;
  /** Markdown the engine composed: a header line, the body when the config mirrors it, the marker line. Jira's adapter turns it into ADF, Azure's into HTML. */
  body: string;
  priority: number;
  dueAt: string | null;
}

export interface Changes {
  issues: ExternalIssue[];
  comments: ExternalComment[];
  /** Pass back on the next call. */
  cursor: string;
}

export interface TrackerAdapter {
  readonly provider: Provider;
  /** What the adapter noticed and the person should hear (a label the tracker dropped, a cap reached); the engine moves them into the run's summary. */
  readonly warnings?: string[];
  /** The account the token acts as: its own issues and comments are skipped on the way in. */
  whoami(): Promise<string>;
  /** The issue carrying `marker`, open or closed, or null. Of several, the one `whoami()` wrote. */
  find(marker: string): Promise<ExternalIssue | null>;
  /** A new issue for `item`, with the config's labels and `item.marker` where `find` looks. */
  create(item: OutItem): Promise<ExternalIssue>;
  /**
   * The title, the body when the config mirrors it, priority and due date where the tracker has them.
   * `before` is what the mirror last wrote, when it knows: an adapter may leave unchanged fields out.
   */
  update(ref: IssueRef, item: OutItem, before?: { priority: number; dueAt: string | null }): Promise<void>;
  /** Move the issue to where the lane item stands (closed or open on GitHub; `stateMap` elsewhere). */
  setState(ref: IssueRef, state: LaneState): Promise<void>;
  comment(ref: IssueRef, text: string): Promise<void>;
  /** Attach a link (a pull request) where the tracker has a place for one, else as a comment. */
  link(ref: IssueRef, url: string): Promise<void>;
  /** Put `marker` on an issue that came in (P2a), where `find` looks. */
  mark(ref: IssueRef, marker: string): Promise<void>;
  /** Issues carrying the config's `label` that changed after `cursor` (null: the last day), and comments on them after it. */
  changes(cursor: string | null): Promise<Changes>;
}

/** What an adapter is built with. `fetcher` and `base` are for tests; `base` may be `http:` only on the loopback. */
export interface AdapterOptions {
  config: MirrorConfig;
  token: string;
  /** Jira's account e-mail, for its basic auth. */
  user?: string;
  fetcher?: typeof fetch;
  base?: string;
}

export class TrackerError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** The lane's key in trackers: a digest of its room id, so an issue names the lane to the mirror alone. */
export const laneKey = (roomId: string) => createHash('sha256').update(`crossroom-lane|${roomId}`).digest('hex').slice(0, 12);

export const MARKER_PREFIX = 'crossroom-lane:';

/** `crossroom-lane:<key>/L<n>`. */
export const mirrorMarker = (key: string, n: number) => `${MARKER_PREFIX}${key}/L${n}`;

const MARKER = /crossroom-lane[:\-_]([0-9a-f]{12})[/\-_]L(\d{1,6})\b/g;

/**
 * The last marker in a text or a tag, in either of its spellings. The mirror and `mark` put theirs
 * at the end, so a marker quoted earlier in an issue (pasted from another one) never names it.
 */
export function parseMarker(s: string): { key: string; n: number; marker: string } | null {
  let m: RegExpExecArray | null = null;
  for (const x of s.matchAll(MARKER)) m = x;
  return m ? { key: m[1]!, n: Number(m[2]), marker: mirrorMarker(m[1]!, Number(m[2])) } : null;
}

/** The marker as a label or tag, where `:` and `/` are not welcome (Jira labels, Azure tags): `crossroom-lane-<key>-L<n>`. */
export const markerTag = (marker: string) => marker.replace(/[^A-Za-z0-9_-]/g, '-');

/**
 * Characters a reader never sees: C0 and C1 but tab and line feed, soft hyphen, zero-width, bidi and
 * other format characters, variation selectors, and the tag characters (U+E0000 to U+E007F), which
 * spell text no screen shows. Built from code points with the `u` flag (a literal U+2028
 * ends a regex, and an astral range needs `u`).
 */
const HIDDEN = new RegExp(
  `[${[
    [0x00, 0x08],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0xad, 0xad],
    [0x61c, 0x61c],
    [0x180e, 0x180e],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x2060, 0x206f],
    [0xfe00, 0xfe0f],
    [0xfeff, 0xfeff],
    [0xfff9, 0xfffb],
    [0xe0000, 0xe007f],
    [0xe0100, 0xe01ef],
  ]
    .map(([a, b]) => (a === b ? `\\u{${a!.toString(16)}}` : `\\u{${a!.toString(16)}}-\\u{${b!.toString(16)}}`))
    .join('')}]`,
  'gu',
);

/** A markdown link reference definition, `[label]: target`, which GitHub and CommonMark render as nothing (`[//]: # (do X)`). */
const LINK_DEFINITION = /^ {0,3}\[[^\]\n]*\]:.*$/gm;

/**
 * What a tracker's text loses on its way into the lane (P2a): HTML comments, link reference
 * definitions, zero-width, bidirectional and tag characters, variation selectors, and every other
 * control but tab and line feed. Instructions hidden from a person reading the issue must not reach
 * an agent reading the item. The passes repeat until the text stops changing, so a control inside
 * `<!--` can't put a comment back together once it is removed.
 */
export function stripHidden(s: string): string {
  let prev: string;
  let out = s.replace(/\r\n?/g, '\n');
  do {
    prev = out;
    out = out.replace(HIDDEN, '').replace(/<!--[\s\S]*?(-->|$)/g, '').replace(LINK_DEFINITION, '');
  } while (out !== prev);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** A tracker's display name as the lane may print it: nothing hidden, one line, at most 80 units. */
export const shownName = (s: string) => clip(stripHidden(s).replace(/\s+/g, ' ').trim(), 80) || 'someone';

/** Whom a tracker's trust check said yes or no to, remembered for an hour: a revoked right counts within the hour. */
export class TrustCache {
  private readonly m = new Map<string, { t: boolean; until: number }>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttl = 3_600_000,
  ) {}
  get(id: string): boolean | undefined {
    const e = this.m.get(id);
    if (!e) return undefined;
    if (e.until <= this.now()) {
      this.m.delete(id);
      return undefined;
    }
    return e.t;
  }
  set(id: string, t: boolean) {
    this.m.set(id, { t, until: this.now() + this.ttl });
  }
}

/** Text cut to `max` UTF-16 units, never between the halves of a surrogate pair. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return `${s.slice(0, end)}…`;
}

/** The longest a rate-limited request waits before its one retry. */
const RETRY_WAIT_MAX_MS = 60_000;

/**
 * How long a refusal asks to be waited out, or null when it is no rate limit: a 429, or a 403 that
 * carries `Retry-After` or `X-RateLimit-Remaining: 0` (GitHub's primary and secondary limits).
 * `Retry-After` in seconds or as a date; else GitHub's `X-RateLimit-Reset`; else a second.
 */
export function rateLimitWait(status: number, h: Headers, now = Date.now()): number | null {
  const after = h.get('retry-after');
  const exhausted = h.get('x-ratelimit-remaining') === '0';
  if (status !== 429 && !(status === 403 && (after !== null || exhausted))) return null;
  let ms = 1000;
  if (after !== null) {
    const secs = Number(after);
    ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(after) - now;
  } else if (h.get('x-ratelimit-reset')) ms = Number(h.get('x-ratelimit-reset')) * 1000 - now;
  if (!Number.isFinite(ms)) ms = 1000;
  return Math.min(Math.max(ms, 0), RETRY_WAIT_MAX_MS);
}

/**
 * Every request an adapter makes: to `base`'s own host only, https unless `base` is a loopback
 * `http:` address a test gave, never following a redirect, bounded in time. A rate-limit refusal is
 * waited out (at most a minute) and tried once more. A tracker's error text is clipped and never
 * carries the token, which goes in a header and is never echoed.
 */
export async function trackerFetch(
  fetcher: typeof fetch,
  base: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const root = new URL(base);
  const url = new URL(path, root);
  if (url.host !== root.host) throw new TrackerError(`refused a request to ${url.host}: only ${root.host} is called`);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new TrackerError('refused a request that is not https');
  const { json, headers, ...rest } = init;
  const h = new Headers(headers);
  if (json !== undefined && !h.has('content-type')) h.set('content-type', 'application/json');
  h.set('accept', h.get('accept') ?? 'application/json');
  h.set('user-agent', 'crossroom-lane-mirror');
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetcher(url.toString(), {
        ...rest,
        headers: h,
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      const cause = (e as { cause?: Error }).cause;
      throw new TrackerError(`${root.host} did not answer: ${clip(cause?.message ?? (e as Error).message, 200)}`);
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const wait = attempt === 0 ? rateLimitWait(res.status, res.headers) : null;
      if (wait !== null) {
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new TrackerError(`${root.host} answered ${res.status}: ${clip(errorText(body), 300)}`, res.status);
    }
    return { status: res.status, body, headers: res.headers };
  }
}

/**
 * A tracker's refusal in words: GitHub and Azure say `message`, Jira `errorMessages` and an
 * `errors` object by field, Linear an `errors` list. Empty parts are skipped, so a Jira field error
 * is never read as nothing.
 */
export function errorText(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body ?? '');
  const b = body as { message?: unknown; errorMessages?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof b.message === 'string' && b.message) parts.push(b.message);
  if (Array.isArray(b.errorMessages)) parts.push(...b.errorMessages.filter((x): x is string => typeof x === 'string' && !!x));
  if (Array.isArray(b.errors)) parts.push(...b.errors.map((x) => (x && typeof x === 'object' ? String((x as { message?: unknown }).message ?? '') : String(x))).filter(Boolean));
  else if (b.errors && typeof b.errors === 'object') parts.push(...Object.entries(b.errors).map(([k, v]) => `${k}: ${String(v)}`));
  return parts.length ? parts.join('; ') : JSON.stringify(body);
}
