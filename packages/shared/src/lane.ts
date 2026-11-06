/**
 * Lanes (`@parley/shared/lane`): a room between two sides that
 * are rarely online together. Either side files an item (a bug, a task, a question, a heads-up) with
 * the evidence it already holds; the other side's agent works it later, when its person opens a
 * session, asks, or runs a scheduled pass, and writes back; the side that filed it checks the result
 * and closes it, or sends it back.
 *
 * Crossroom runs no agent here. The agent each person already runs does the work, with its own tools
 * and permissions; Crossroom keeps the items and tells each side what needs it. A seat's autonomy is
 * what its pass document asks of that agent, not something Crossroom can enforce.
 *
 * No zod, so the web app imports it as it is.
 */

export const LANE_KINDS = ['bug', 'task', 'question', 'heads_up'] as const;
export type LaneKind = (typeof LANE_KINDS)[number];

/**
 * Where an item stands. The side that did not file it works it (`working`, then `fixed`, `answered`,
 * `wont_fix` or `needs_info`); the side that filed it adds what was asked (`needs_info` back to
 * `open`) and checks the outcome (`verify`: `closed`, or `open` again).
 */
export const LANE_STATES = ['open', 'working', 'needs_info', 'fixed', 'answered', 'wont_fix', 'closed'] as const;
export type LaneState = (typeof LANE_STATES)[number];

/** What the worker may move an item to with `update`. */
export const WORKER_STATES = ['working', 'needs_info', 'fixed', 'answered', 'wont_fix'] as const;
/** The states that wait on the filer's check. */
export const DONE_STATES: readonly LaneState[] = ['fixed', 'answered', 'wont_fix'];

/**
 * How far a side's agent goes with an item, when its pass runs. `pr` (the default): fix it in a
 * worktree of its own, run the tests, push a branch and open a pull request, never merging. `branch`:
 * the same up to a local commit. `read`: diagnose and answer, editing nothing.
 */
export const LANE_AUTONOMY = ['pr', 'branch', 'read'] as const;
export type LaneAutonomy = (typeof LANE_AUTONOMY)[number];
export const DEFAULT_AUTONOMY: LaneAutonomy = 'pr';
export const isLaneAutonomy = (v: unknown): v is LaneAutonomy => typeof v === 'string' && (LANE_AUTONOMY as readonly string[]).includes(v);

export const LANE_KIND_WORDS: Readonly<Record<LaneKind, string>> = { bug: 'bug', task: 'task', question: 'question', heads_up: 'heads-up' };
export const LANE_STATE_WORDS: Readonly<Record<LaneState, string>> = {
  open: 'open',
  working: 'being worked',
  needs_info: 'needs more from the filer',
  fixed: 'fixed, to verify',
  answered: 'answered, to verify',
  wont_fix: "won't fix, to verify",
  closed: 'closed',
};
export const AUTONOMY_WORDS: Readonly<Record<LaneAutonomy, string>> = {
  pr: 'fix it and open a pull request',
  branch: 'fix it on a local branch',
  read: 'diagnose and answer only',
};

export const LANE_TITLE_MAX = 200;
export const LANE_BODY_MAX = 20_000;
export const LANE_EXPECT_MAX = 2_000;
export const LANE_CITE_MAX = 500;
export const LANE_NOTE_MAX = 4_000;
export const LANE_REF_MAX = 500;
/** Items a lane holds in all, closed ones included. */
export const LANE_ITEMS_MAX = 500;
/** Writes (file, update, verify) one seat makes in a lane: each is an event in the record. */
export const LANE_WRITES_PER_SEAT = 3_000;
/** How many closed items a listing shows. */
export const LANE_CLOSED_SHOWN = 10;
/** Links an item carries (an issue, a pull request, a dashboard), and how long each may be. */
export const LANE_LINKS_MAX = 5;
export const LANE_LINK_MAX = 500;
/** A `dedupe` key as a caller gives it; only its HMAC under the room's key is stored. */
export const LANE_DEDUPE_MAX = 200;
/** How many notes an item's history shows, newest last. */
export const LANE_NOTES_SHOWN = 20;
/** Messages a lane allows: as many as any room may have. Items never count against it. */
export const LANE_MAX_MESSAGES = 500;

/** An item's label: `L` and its number in its lane. */
export const laneLabel = (n: number) => `L${n}`;

/** An item's number from what a caller wrote (`L7`, `l7`, `7`), or null. */
export function laneNumber(id: string | number | undefined | null): number | null {
  if (typeof id === 'number') return Number.isSafeInteger(id) && id > 0 ? id : null;
  const m = /^\s*[Ll]?(\d{1,6})\s*$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Priority, on Linear's scale so a mirror maps it one to one: 0 none, 1 urgent, 2 high, 3 medium,
 * 4 low. Plain metadata, like `kind`.
 */
export const LANE_PRIORITIES = [0, 1, 2, 3, 4] as const;
export type LanePriority = (typeof LANE_PRIORITIES)[number];
export const LANE_PRIORITY_WORDS: Readonly<Record<LanePriority, string>> = { 0: 'no priority', 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };

/** A priority from what a caller wrote (`2`, `high`, `p1`), or null when it names none. */
export function lanePriority(v: unknown): LanePriority | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  const named = (Object.entries(LANE_PRIORITY_WORDS) as [string, string][]).find(([, w]) => w === s || (s === 'none' && w === 'no priority'));
  if (named) return Number(named[0]) as LanePriority;
  const m = /^p?([0-4])$/.exec(s);
  return m ? (Number(m[1]) as LanePriority) : null;
}

/**
 * Where an item or a note came in from, when a person's tracker carried it (P2): the mirror files a
 * labelled issue and copies a trusted person's comment, and says so with `via`. Crossroom prints it
 * in its own words, outside the fence, so neither side's agent mistakes a third party's text for
 * the other side's.
 */
export const LANE_VIA = ['github', 'linear', 'jira', 'azure'] as const;
export type LaneVia = (typeof LANE_VIA)[number];
export const LANE_VIA_WORDS: Readonly<Record<LaneVia, string>> = { github: 'a GitHub issue', linear: 'a Linear issue', jira: 'a Jira issue', azure: 'an Azure DevOps work item' };
export const isLaneVia = (v: unknown): v is LaneVia => typeof v === 'string' && (LANE_VIA as readonly string[]).includes(v);

/**
 * Paths on a Crossroom host that carry a credential in the path itself: a seat link and its
 * operations (`/j/<token>`), a seat's MCP endpoint (`/mcp/<token>`, not `/mcp/start` or
 * `/mcp/connect`), the hooks (`/api/hook/...`) and ask links (`/ask/<token>`). Matched at the start of
 * the decoded path, so a repository path that merely contains `/j/` is not refused.
 */
const TOKEN_PATH = /^\/(?:j\/[^/]+|mcp\/(?!start\/?$|connect\/?$)[^/]+|api\/hook\/|ask\/[^/]+)/i;

/** A path as a router reads it: percent-decoding repeated until it stops changing. */
function decodedPath(p: string): string {
  let cur = p;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return cur;
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/**
 * Why a link may not go on an item, or null when it may. Links reach trackers and the recap, so a
 * link that may carry a credential is refused: a path that carries a Crossroom token (`TOKEN_PATH`,
 * read decoded, as the router reads it), any fragment holding `=` (the owner, room, share, guest and
 * pairing keys all travel as `#name=value`, and each parser reads it differently), a user name or a
 * password. https only. A fragment without `=` (`#L10`, `#issuecomment-1`) stays.
 */
export function laneLinkProblem(raw: string): string | null {
  const s = raw.trim();
  if (!s) return 'A link is empty.';
  if (s.length > LANE_LINK_MAX) return `A link is at most ${LANE_LINK_MAX} characters.`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return `${s.slice(0, 80)} is not a link.`;
  }
  if (u.protocol !== 'https:') return 'Links are https only.';
  if (u.username || u.password) return 'A link may not carry a user name or password.';
  if (decodedPath(u.hash).includes('=')) return 'That link carries a value in its fragment, which may be a key. Link the page without the part after #.';
  if (TOKEN_PATH.test(decodedPath(u.pathname))) return 'That link carries a Crossroom token (a seat, MCP, hook or ask link), which is a credential. Never put one on an item.';
  return null;
}

/**
 * Links as a caller lists them: an array, or text separated by whitespace, or by commas that come
 * before another `https://` (a comma inside a URL stays). Each is checked; the first problem is the answer.
 */
export function laneLinks(v: unknown): { links: string[]; problem: string | null } {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/\s+|,(?=\s*https?:\/\/)/i) : [];
  const links = [...new Set(raw.map((x) => x.trim()).filter(Boolean))];
  for (const l of links) {
    const p = laneLinkProblem(l);
    if (p) return { links: [], problem: p };
  }
  // Stored as the URL parser writes it: `<`, `>`, quotes and spaces percent-encoded, so the recap can
  // print each as an autolink no character of it can break out of.
  return { links: [...new Set(links.map((l) => new URL(l).href))], problem: null };
}

/**
 * A due date from what a caller wrote, as ISO, or null for none; `undefined` when it is not one.
 * Strict: `YYYY-MM-DD` (the end of that day, UTC) or a full ISO time with `Z` or an offset, and a real
 * calendar date. `Date.parse` alone takes `Nov 3` and `1` as dates in 2001 and rolls `02-30` into March.
 */
export function laneDue(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (s === 'none') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(s);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return undefined;
  const t = Date.parse(s.length === 10 ? `${s}T23:59:59.000Z` : s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Whether an open item is past its due date at `now`. */
export const isOverdue = (i: Pick<LaneItem, 'dueAt' | 'state'>, now = Date.now()) => !!i.dueAt && i.state !== 'closed' && Date.parse(i.dueAt) < now;

/** What needs a side, in the order to work it: overdue first, then by priority (urgent first, none last), then oldest. */
export function laneOrder<T extends Pick<LaneItem, 'dueAt' | 'state' | 'priority' | 'n'>>(items: T[], now = Date.now()): T[] {
  const rank = (p: number) => (p === 0 ? 5 : p);
  return [...items].sort((a, b) => Number(isOverdue(b, now)) - Number(isOverdue(a, now)) || rank(a.priority) - rank(b.priority) || a.n - b.n);
}

/** One line of an item's history. `by` is a seat's letter, or `owner`. */
export interface LaneNote {
  by: string;
  from: LaneState | null;
  to: LaneState;
  note: string;
  ref: string;
  at: string;
  /** Copied in from a tracker by a mirror (P2), when it was. */
  via?: LaneVia;
}

/** An item, opened. Every text field is a participant's words. */
export interface LaneItem {
  id: string;
  n: number;
  kind: LaneKind;
  state: LaneState;
  title: string;
  body: string;
  expect: string;
  cite: string;
  /** The latest branch, commit or pull request the worker named. */
  ref: string;
  /** Packet labels the filer cited, checked when it filed. */
  evidence: string[];
  /** Issues, pull requests and pages either side linked, checked (`laneLinkProblem`), at most `LANE_LINKS_MAX`. */
  links: string[];
  priority: LanePriority;
  /** When the filer needs it by, ISO, or null. */
  dueAt: string | null;
  /** Filed from a person's tracker by a mirror, when it was (P2). */
  via: LaneVia | null;
  /** The seat that filed it, by letter. */
  filedBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Its history, newest last, when one item is read. */
  notes?: LaneNote[];
  /** The latest note, in a listing. */
  last?: LaneNote | null;
}

/** `items`: the lane as this seat reads it, or one item whole. */
export interface LaneItemsData {
  /** This seat's letter. */
  me: string;
  autonomy: LaneAutonomy;
  /** Items that wait on this seat. */
  needs: LaneItem[];
  /** Items that wait on the other side. Empty with `needs=me`. */
  waiting: LaneItem[];
  /** The latest `LANE_CLOSED_SHOWN` closed items. Empty with `needs=me`. */
  closed: LaneItem[];
  counts: { open: number; closed: number; overdue?: number };
  /** With `id`: that item, with its history, or null when the lane has none by that number. */
  item?: LaneItem | null;
  /** The `since` the call gave, when it gave one. */
  since?: string;
  needsOnly?: true;
}

/** `file`: Crossroom's words only. */
export interface LaneFiledData {
  id: string;
  kind: LaneKind;
  /** The `dedupe` key matched an item still open, so nothing was filed: `id` is that item. */
  duplicate?: true;
}

/** `autonomy`: a side set its own pass's level. */
export interface LaneSettingsData {
  side: string;
  autonomy: LaneAutonomy;
  previous: LaneAutonomy;
}

/** `update` and `verify`. */
export interface LaneUpdatedData {
  id: string;
  from: LaneState;
  to: LaneState;
  version: number;
  /** Who moved it, as the rules saw them. */
  role: LaneRole;
  /** `verify`'s verdict. */
  verdict?: 'ok' | 'reopen';
  /** `update` changed nothing: the item already had every link, priority and due date given. */
  unchanged?: true;
}

/** `pass`: everything an agent needs to run this seat's pass now, and to schedule the next. */
export interface LanePassData {
  me: string;
  /** The other side's chosen name and letter. */
  other: { name: string; letter: string; joined: boolean };
  autonomy: LaneAutonomy;
  /** Items that wait on this seat, each with its latest note. */
  needs: LaneItem[];
  /** Items waiting on the other side, counted. */
  waiting: number;
  /** The seat link, for curl recipes; null over MCP, where the operations are tools. */
  seatUrl: string | null;
  /** Run by a schedule (`scheduled=1`): no schedule block, no offers to a user who isn't there. */
  scheduled?: true;
}

/** What a lane seat's `join` adds: the lane at a glance, in place of a meeting's briefing. */
export interface LaneJoinData {
  autonomy: LaneAutonomy;
  other: { name: string; letter: string; joined: boolean };
  needs: LaneItem[];
  waiting: number;
  closed: number;
}

/** Whether `item` waits on the seat `me` (a letter): what `items needs=me` lists. */
export function needsSide(item: Pick<LaneItem, 'state' | 'filedBy'>, me: string): boolean {
  if (item.state === 'closed') return false;
  if (item.filedBy === me) return item.state === 'needs_info' || DONE_STATES.includes(item.state);
  return item.state === 'open' || item.state === 'working';
}

/**
 * What the room lists say of a lane (`RoomAttention.lane`, the dashboard strip's too): its items not
 * closed, how many wait on each side by seat letter (`needsSide`), and how many are overdue. Counted
 * from plain columns, so the lists read it with no key.
 */
export interface LaneTally {
  open: number;
  waiting: Record<string, number>;
  overdue: number;
}

/** A lane's tally from its items, `filedBy` a seat letter of its two sides. */
export function tallyLane(items: readonly Pick<LaneItem, 'state' | 'filedBy' | 'dueAt'>[], now = Date.now()): LaneTally {
  const waiting: Record<string, number> = {};
  let open = 0;
  let overdue = 0;
  for (const i of items) {
    if (i.state === 'closed') continue;
    open++;
    if (isOverdue(i, now)) overdue++;
    const on = ['A', 'B'].find((l) => needsSide(i, l));
    if (on) waiting[on] = (waiting[on] ?? 0) + 1;
  }
  return { open, waiting, overdue };
}

/** A tally said in a room list's chips: open items, the sides they wait on, overdue ones. */
export function tallyWords(t: LaneTally): { tone: 'faint' | 'mark' | 'bad'; text: string; title: string }[] {
  if (!t.open) return [{ tone: 'faint', text: 'nothing open', title: 'Every item in this lane is closed.' }];
  const out: { tone: 'faint' | 'mark' | 'bad'; text: string; title: string }[] = [
    { tone: 'faint', text: `${t.open} open`, title: `${t.open} ${t.open === 1 ? 'item is' : 'items are'} not closed yet.` },
  ];
  for (const [side, n] of Object.entries(t.waiting).sort())
    if (n)
      out.push({
        tone: 'mark',
        text: `${n} for side ${side}`,
        title: `${n} ${n === 1 ? 'item waits' : 'items wait'} on side ${side}: to work, or to check and close.`,
      });
  if (t.overdue) out.push({ tone: 'bad', text: `${t.overdue} overdue`, title: `${t.overdue} open ${t.overdue === 1 ? 'item is' : 'items are'} past due.` });
  return out;
}

export type LaneRole = 'filer' | 'worker' | 'owner';

/**
 * Why `role` may not move an item from `from` to `to` with `update`, or null when it may. The same
 * state with a note is a comment, which either side may leave on an item still open.
 */
export function updateProblem(role: LaneRole, from: LaneState, to: LaneState): string | null {
  if (from === 'closed' && role !== 'owner') return 'That item is closed. File a new one if there is more to do.';
  if (from === to) return null;
  if (role === 'owner') return null;
  if (role === 'worker') {
    if ((WORKER_STATES as readonly string[]).includes(to)) return null;
    return `You are working this item, so you move it to ${WORKER_STATES.join(', ')}. The side that filed it closes it, with verify.`;
  }
  if (to === 'closed') return null;
  if (from === 'needs_info' && to === 'open') return null;
  return 'You filed this item: answer what was asked (state=open, with a note), withdraw it (state=closed, with a note), or check the outcome with verify.';
}

/** Why the filer may not `verify` an item in `state`, or null when it may. */
export function verifyProblem(state: LaneState): string | null {
  if (DONE_STATES.includes(state)) return null;
  if (state === 'closed') return 'That item is closed already.';
  return 'Nothing to verify yet: the other side has not said it is fixed, answered or not to be fixed.';
}

/** Where a pass's worktrees go, beside the repository: one folder a scheduled run is given (`--add-dir`). */
export const LANE_WORKTREES = '../.crossroom-worktrees';

/** The pass's instruction to an agent that is not running one: what to type, whatever runs it. */
export const passPrompt = (passUrl: string) => `Work this Crossroom lane: ${passUrl}`;

/**
 * How to run a seat's pass on a schedule, with whatever the person already has. Crossroom installs
 * nothing: each line is for the agent or the person to set up. `<repo>` is left for the agent to
 * fill in, since the server never knows where the repository lives (`crossroom lane schedule` fills
 * it, and the test command, in).
 *
 * Every line runs the pass as `<link>/pass?scheduled=1`: a run nobody watches gets the pass without
 * the schedule block and the lines that offer things to a user, about a third of it.
 */
export function scheduleLines(passUrl: string, curl: string, autonomy: LaneAutonomy = DEFAULT_AUTONOMY): string[] {
  const prompt = passPrompt(passUrl.includes('?') ? passUrl : `${passUrl}?scheduled=1`);
  // What the pass asks of the agent, and no more: a read pass edits nothing, a branch pass pushes nothing.
  const tools =
    autonomy === 'read'
      ? `--allowedTools "${curl}" "Bash(git log:*)" "Bash(git show:*)" "Bash(git diff:*)"`
      : `--permission-mode acceptEdits --allowedTools "${curl}" "Bash(git:*)" ${autonomy === 'pr' ? '"Bash(gh pr create:*)" "Bash(gh pr view:*)" ' : ''}"Bash(<your test command>:*)"`;
  // A headless run edits only inside its own directory and those it is given: the pass's worktrees
  // live in one folder beside the repository, made before the run and handed to it with --add-dir.
  const dir = autonomy === 'read' ? '' : ` --add-dir ${LANE_WORKTREES}`;
  const claude = `claude -p "${prompt}"${dir} ${tools}`;
  const made = autonomy === 'read' ? '' : `mkdir -p ${LANE_WORKTREES} && `;
  const madeWin = autonomy === 'read' ? '' : `(if not exist ${LANE_WORKTREES.replace('/', '\\')} mkdir ${LANE_WORKTREES.replace('/', '\\')}) && `;
  return [
    `- Your agent app's own scheduled tasks (Claude Code, Codex): a daily task with the prompt "${prompt}", in the repository${autonomy === 'read' ? '' : `, allowed to edit ${LANE_WORKTREES}`}.`,
    `- Claude Code from cron, weekdays at 18:30: \`30 18 * * 1-5 cd <repo> && ${made}${claude}\``,
    `- Windows Task Scheduler: \`schtasks /create /sc weekly /d MON,TUE,WED,THU,FRI /st 18:30 /tn crossroom-lane /tr "cmd /c cd /d <repo> && ${madeWin}${claude.replace(/"/g, '\\"')}"\``,
    autonomy === 'read'
      ? `- Codex: \`codex exec --sandbox read-only "${prompt}"\`.`
      : `- Codex: \`${made}codex exec --full-auto --add-dir ${LANE_WORKTREES} "${prompt}"\` (its sandbox may stop a push: the commit stays).`,
  ];
}
