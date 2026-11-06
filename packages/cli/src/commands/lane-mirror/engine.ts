/**
 * `crossroom lane mirror`'s engine: one run between a lane and a tracker, on the person's machine
 * or their CI, through the lane's seat link and the person's own tracker token (types.ts has the
 * rules).
 *
 * A run, in this order:
 * 1. **In** (`inbound`): an issue carrying the lane's label and no marker, written by a trusted
 *    person, is filed as this side (`via` set, the issue linked, a dedupe key from its id so a run
 *    that dies before marking it files nothing twice), then marked. An issue carrying item n's
 *    marker that is not item n's issue (a marker pasted into another) counts as unmarked. A trusted
 *    person's comment on a mirrored issue becomes a note. A close in the tracker becomes a note too,
 *    while the item is still open, being worked or waiting for information (otherwise the mirror's
 *    own move may have closed it, and Linear, Jira and Azure DevOps don't say who did), and
 *    withdraws the item only under `withdrawOnClose`, only for an item this side filed that is still
 *    open, only when a trusted person closed it. Untrusted authors are counted, never copied, and a
 *    name goes into the lane cleaned, on one line, clipped. One issue or comment that fails is
 *    reported and the rest go on; the cursor moves only when none failed.
 * 2. **Trailers** (`trailers`): a `Fixes-Lane: L<n>` trailer in a commit on the default branch
 *    (`origin/HEAD`, else `origin/main` or `origin/master`, never whatever is checked out) marks an
 *    item the other side filed, still open or being worked, `fixed`, with the commit as the ref. The
 *    trailer cursor stops before the first commit whose update failed.
 * 3. **Out**: every item this side mirrors (`items`), and every item that already has an issue,
 *    whose version moved since the last run: the issue is found or created, its title (and body,
 *    with `body`) kept, its state moved, a comment for each move or note the tracker did not bring
 *    in, links attached, and the issue linked back on the item. An item closed before it was ever
 *    mirrored is left alone. An issue that came in is never rewritten: its words are its author's.
 *
 * The state file (`<data>/lane-mirror/<key>-<provider>.json`, this user only) holds what was done,
 * and no lane text (a title is kept as its digest), since CI keeps it in a cache. Every tracker write
 * is found before it is made and the state is saved after each item, so a run that dies part way
 * repeats nothing on the next. A run with no state file (a CI cache that missed) finds each issue by
 * its marker and takes what the issue already shows as done: the item's links, its notes so far,
 * and a close a person made, which is never reopened.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  LANE_BODY_MAX,
  LANE_KIND_WORDS,
  LANE_NOTE_MAX,
  LANE_STATE_WORDS,
  LANE_TITLE_MAX,
  type LaneFiledData,
  type LaneItem,
  type LaneItemsData,
  type LaneKind,
  type LaneState,
  type LaneUpdatedData,
  laneLabel,
} from '@parley/shared/lane';
import {
  type Changes,
  clip,
  type ExternalIssue,
  type IssueRef,
  laneKey,
  MARKER_PREFIX,
  type MirrorConfig,
  mirrorMarker,
  type OutItem,
  parseMarker,
  shownName,
  stripHidden,
  type TrackerAdapter,
  TrackerError,
} from './types.js';

const run = promisify(execFile);

/** The lane, as the mirror reaches it: the seat link's operations. */
export interface LanePort {
  /** The room's id (for the marker's key) and this seat's letter. */
  whoami(): Promise<{ roomId: string; me: string }>;
  /** Every item, closed ones included. */
  items(): Promise<LaneItemsData>;
  item(n: number): Promise<LaneItem | null>;
  file(input: Record<string, string>): Promise<LaneFiledData>;
  update(n: number, input: Record<string, string | number>): Promise<LaneUpdatedData>;
}

/** A seat link's operations over HTTP, with `?format=json`. No request follows a redirect: each carries the link. */
export function httpLanePort(link: string, fetcher: typeof fetch = fetch): LanePort {
  const call = async <T>(op: string, init?: { body?: Record<string, string | number>; query?: string }): Promise<T> => {
    const url = `${link}/${op}?format=json${init?.query ?? ''}`;
    const res = await fetcher(url, {
      method: init?.body ? 'POST' : 'GET',
      ...(init?.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let parsed: { data?: T; error?: string } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: the error below says what came back.
    }
    if (!res.ok || parsed.data === undefined) throw new TrackerError(`the lane answered ${res.status}: ${clip(parsed.error ?? text.split('\n')[0] ?? '', 300)}`, res.status);
    return parsed.data;
  };
  return {
    async whoami() {
      const [status, items] = await Promise.all([call<{ id: string }>('status'), call<LaneItemsData>('items', { query: '&needs=me' })]);
      return { roomId: status.id, me: items.me };
    },
    items: () => call<LaneItemsData>('items', { query: '&all=1' }),
    async item(n) {
      return (await call<LaneItemsData>('items', { query: `&id=L${n}` })).item ?? null;
    },
    file: (body) => call<LaneFiledData>('file', { body }),
    update: (n, body) => call<LaneUpdatedData>('update', { body: { id: `L${n}`, ...body } }),
  };
}

/** A title as the state file keeps it: a digest, never the words. */
export const titleHash = (title: string) => createHash('sha256').update(title).digest('hex');

/** What the mirror remembers of one item's issue. */
interface Rec extends IssueRef {
  /** The item's version as last mirrored; -1 just after the issue was made. */
  version: number;
  state: LaneState;
  /** `titleHash` of the title last written. */
  titleHash: string;
  priority: number;
  dueAt: string | null;
  /** The newest note already mirrored, by time. */
  noteAt: string;
  links: string[];
  /** Whether the issue was open when last seen. */
  open: boolean;
  /** The issue came in from the tracker: its words are its author's, so the mirror never rewrites them. */
  inbound?: true;
}

export interface MirrorState {
  v: 1;
  refs: Record<string, Rec>;
  inCursor: string | null;
  /** Comment ids already copied in, the newest 500. */
  comments: string[];
  /** The newest commit whose trailers were read. */
  trailerCursor?: string;
}

const COMMENTS_KEPT = 500;

export function stateFile(dataDir: string, key: string, cfg: MirrorConfig): string {
  const target = cfg.target.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
  return path.join(dataDir, 'lane-mirror', `${key}-${cfg.provider}-${target}.json`);
}

export function loadState(file: string): MirrorState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as MirrorState;
    if (s && s.v === 1 && s.refs && typeof s.refs === 'object') {
      // A file from before titles were kept as digests: the words leave it at the next save.
      for (const rec of Object.values(s.refs) as Array<Rec & { title?: string }>) {
        if (typeof rec.title === 'string') rec.titleHash ??= titleHash(rec.title);
        delete rec.title;
      }
      return { ...s, comments: Array.isArray(s.comments) ? s.comments : [] };
    }
  } catch {
    // None yet, or unreadable: start over. Every issue is found by its marker before one is made,
    // and what it already shows is taken as done.
  }
  return { v: 1, refs: {}, inCursor: null, comments: [] };
}

/** Written to a temp file and renamed into place, readable by this user only. */
export function saveState(file: string, s: MirrorState) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export interface MirrorSummary {
  created: number;
  updated: number;
  commented: number;
  filedIn: number;
  notesIn: number;
  untrusted: number;
  trailers: number;
  warnings: string[];
}

export interface MirrorRun {
  lane: LanePort;
  tracker: TrackerAdapter;
  config: MirrorConfig;
  /** Where the state file lives (`crossroom`'s data directory). */
  dataDir: string;
  /** The repository whose commits' trailers are read, when `config.trailers`. */
  cwd?: string;
  /** Says what it would do, and writes nothing. */
  dryRun?: boolean;
}

const sideWords = (by: string) => (by === 'owner' ? 'the owner' : `side ${by}`);

/** The issue's body, as the mirror writes it: a line of Crossroom's, the body only with `body`, the marker last. */
function composeBody(i: LaneItem, marker: string, cfg: MirrorConfig): string {
  const head = `Crossroom lane ${laneLabel(i.n)} · ${LANE_KIND_WORDS[i.kind]} · ${LANE_STATE_WORDS[i.state]} · filed by side ${i.filedBy}.`;
  const words = cfg.body ? [i.body, i.expect ? `Expected: ${i.expect}` : '', i.cite ? `Cites: ${i.cite}` : ''].filter(Boolean).join('\n\n') : 'The lane holds the details; work it from there.';
  return [head, words, marker].join('\n\n');
}

export function outItem(i: LaneItem, key: string, cfg: MirrorConfig): OutItem {
  const marker = mirrorMarker(key, i.n);
  return { marker, label: laneLabel(i.n), kind: i.kind, state: i.state, title: clip(i.title, 250), body: composeBody(i, marker, cfg), priority: i.priority, dueAt: i.dueAt };
}

/** A lane kind for an issue that came in, from its labels: bug and question by name, the config's kind labels, else task. */
function kindOf(issue: ExternalIssue, cfg: MirrorConfig): LaneKind {
  const labels = issue.labels.map((l) => l.toLowerCase());
  for (const [kind, word] of Object.entries(cfg.kindMap) as [LaneKind, string][]) if (word && labels.includes(word.toLowerCase())) return kind;
  if (labels.includes('bug')) return 'bug';
  if (labels.includes('question')) return 'question';
  return 'task';
}

/** The lane states in which a close in the tracker is news: in any other, the mirror's own move may have closed it. */
const CLOSE_IS_NEWS: readonly LaneState[] = ['open', 'working', 'needs_info'];

/** One mirror run. */
export async function mirrorOnce(r: MirrorRun): Promise<MirrorSummary> {
  const { lane, tracker, config: cfg } = r;
  const sum: MirrorSummary = { created: 0, updated: 0, commented: 0, filedIn: 0, notesIn: 0, untrusted: 0, trailers: 0, warnings: [] };
  const warn = (w: string) => sum.warnings.push(w);
  const drain = () => {
    if (tracker.warnings?.length) sum.warnings.push(...tracker.warnings.splice(0));
  };
  const who = await lane.whoami();
  const key = laneKey(who.roomId);
  const file = stateFile(r.dataDir, key, cfg);
  const st = loadState(file);
  /** No record of anything: a first run, or one whose state was lost. */
  const fresh = Object.keys(st.refs).length === 0;
  const save = () => {
    if (!r.dryRun) saveState(file, st);
  };
  const me = await tracker.whoami();
  const byIssue = () => new Map(Object.entries(st.refs).map(([n, rec]) => [rec.id, Number(n)]));
  const items = new Map<number, LaneItem>();
  const reload = async () => {
    const d = await lane.items();
    items.clear();
    for (const i of [...d.needs, ...d.waiting, ...d.closed]) items.set(i.n, i);
  };
  await reload();

  // 1. In.
  if (cfg.inbound) {
    let ch: Changes | null = null;
    try {
      ch = await tracker.changes(st.inCursor);
    } catch (e) {
      warn(`reading the tracker: ${(e as Error).message}`);
    }
    if (ch) {
      /** An inbound write failed: the cursor stays, so the next run reads it again. */
      let failed = false;
      const known = byIssue();
      for (const issue of ch.issues) {
        try {
          let mk = issue.marker ? parseMarker(issue.marker) : null;
          if (mk && mk.key !== key) continue; // another lane's issue
          // Item n's marker on an issue that is not item n's: a pasted marker names nothing.
          if (mk && st.refs[String(mk.n)] && st.refs[String(mk.n)]!.id !== issue.id) mk = null;
          if (!mk) {
            if (!issue.open || !issue.labels.some((l) => l.toLowerCase() === cfg.label.toLowerCase()) || known.has(issue.id)) continue;
            if (issue.author.id === me) continue;
            if (!issue.author.trusted) {
              sum.untrusted++;
              continue;
            }
            if (r.dryRun) {
              sum.filedIn++;
              continue;
            }
            const body = clip(`${stripHidden(issue.body)}\n\n(From ${issue.key}, opened by ${shownName(issue.author.name)}.)`.trim(), LANE_BODY_MAX);
            const filed = await lane.file({
              kind: kindOf(issue, cfg),
              title: clip(stripHidden(issue.title).replace(/\s+/g, ' ') || issue.key, LANE_TITLE_MAX),
              body,
              via: cfg.provider,
              dedupe: `${cfg.provider}:${cfg.target}:${issue.id}`,
              ...(issue.url.startsWith('https://') ? { links: issue.url } : {}),
            });
            const n = Number(filed.id.slice(1));
            const marker = mirrorMarker(key, n);
            await tracker.mark(issue, marker);
            const item = await lane.item(n);
            st.refs[String(n)] = {
              id: issue.id,
              key: issue.key,
              url: issue.url,
              version: item?.version ?? 1,
              state: item?.state ?? 'open',
              titleHash: titleHash(item?.title ?? ''),
              priority: item?.priority ?? 0,
              dueAt: item?.dueAt ?? null,
              noteAt: item?.updatedAt ?? new Date().toISOString(),
              links: item?.links ?? [],
              open: true,
              inbound: true,
            };
            known.set(issue.id, n);
            if (!filed.duplicate) sum.filedIn++;
            save();
            continue;
          }
          const rec = st.refs[String(mk.n)];
          const item = items.get(mk.n);
          if (!rec || !item) continue;
          if (rec.open && !issue.open && issue.closedBy?.id !== me && CLOSE_IS_NEWS.includes(item.state)) {
            // Closed in the tracker by someone other than this mirror: the lane hears of it, in its own
            // words. Only a trusted closer is named.
            const by = issue.closedBy?.trusted ? ` by ${shownName(issue.closedBy.name)}` : '';
            const withdraw = cfg.withdrawOnClose && item.filedBy === who.me && item.state === 'open' && !!issue.closedBy?.trusted;
            if (r.dryRun) continue;
            await lane.update(mk.n, { note: `Closed in the tracker (${issue.key})${by}.${withdraw ? ' Withdrawn, as this side asked the mirror to.' : ''}`, via: cfg.provider, ...(withdraw ? { state: 'closed' } : {}) });
            sum.notesIn++;
          }
          if (r.dryRun) continue;
          rec.open = issue.open;
          save();
        } catch (e) {
          failed = true;
          warn(`${issue.key}: ${(e as Error).message}`);
        }
      }
      const known2 = byIssue();
      /** What each item already holds from the tracker, so a run that lost its state copies no comment twice. */
      const noted = new Map<number, Set<string>>();
      const notesOf = async (n: number) => {
        let set = noted.get(n);
        if (!set) {
          set = new Set(((await lane.item(n))?.notes ?? []).filter((x) => x.via).map((x) => x.note));
          noted.set(n, set);
        }
        return set;
      };
      for (const c of ch.comments) {
        const n = known2.get(c.issue.id);
        if (n === undefined || st.comments.includes(c.id)) continue;
        // The mirror's own words come back as comments: skipped by author and by marker.
        if (c.author.id === me || c.body.includes(MARKER_PREFIX)) continue;
        if (!c.author.trusted) {
          sum.untrusted++;
          continue;
        }
        const text = stripHidden(c.body);
        if (!text || r.dryRun) continue;
        try {
          const note = clip(`${text}\n\n(${shownName(c.author.name)} on ${c.issue.key}.)`, LANE_NOTE_MAX);
          const have = await notesOf(n);
          if (!have.has(note)) {
            await lane.update(n, { note, via: cfg.provider });
            have.add(note);
            sum.notesIn++;
          }
          // Recorded only once the note is in the lane.
          st.comments = [...st.comments, c.id].slice(-COMMENTS_KEPT);
          save();
        } catch (e) {
          failed = true;
          warn(`${laneLabel(n)} (${c.issue.key}): ${(e as Error).message}`);
        }
      }
      // With no state, issues are matched to items only by the out pass below: the next run reads the
      // same span again, so a comment on one of them is not passed over.
      if (!r.dryRun && !failed && !fresh) st.inCursor = ch.cursor;
      save();
      await reload();
    }
    drain();
  }

  // 2. Trailers.
  if (cfg.trailers && r.cwd) {
    const t = await trailersIn(r.cwd, st.trailerCursor);
    if (t.warning) warn(t.warning);
    commits: for (const c of t.commits) {
      for (const n of c.items) {
        const item = items.get(n);
        if (!item || item.filedBy === who.me || (item.state !== 'open' && item.state !== 'working')) continue;
        if (!r.dryRun) {
          try {
            await lane.update(n, { state: 'fixed', ref: c.sha.slice(0, 12), note: `Commit ${c.sha.slice(0, 12)} on ${c.branch} says it fixes ${laneLabel(n)}.` });
          } catch (e) {
            // The cursor stays before this commit, so the next run tries it again.
            warn(`${laneLabel(n)}: ${(e as Error).message}`);
            break commits;
          }
          items.set(n, { ...item, state: 'fixed' });
        }
        sum.trailers++;
      }
      if (!r.dryRun) st.trailerCursor = c.sha;
    }
    save();
    await reload();
  }

  // 3. Out.
  for (const item of [...items.values()].sort((a, b) => a.n - b.n)) {
    const n = item.n;
    let rec = st.refs[String(n)];
    if (rec && rec.version === item.version) continue;
    const wanted = cfg.items === 'all' || (cfg.items === 'theirs' ? item.filedBy !== who.me : item.filedBy === who.me);
    const makes = wanted && item.state !== 'closed';
    // With no state, an item this side filed in from this tracker is looked for, never made again.
    const adopt = !rec && fresh && item.via === cfg.provider && item.filedBy === who.me;
    if (!rec && !makes && !adopt) continue;
    const out = outItem(item, key, cfg);
    if (r.dryRun) {
      if (rec) sum.updated++;
      else if (makes) sum.created++;
      continue;
    }
    try {
      if (!rec) {
        const found = await tracker.find(out.marker);
        if (!found && !makes) continue;
        const issue = found ?? (await tracker.create(out));
        if (!found) sum.created++;
        const latest = item.last?.at ?? item.updatedAt;
        rec = {
          id: issue.id,
          key: issue.key,
          url: issue.url,
          version: -1,
          // The lane state the issue shows: a new one is open. A found one as found, so a move is
          // applied, except that a close a person made while the item is open stays closed.
          state: !found ? 'open' : found.open ? 'open' : item.state !== 'closed' ? item.state : 'closed',
          titleHash: titleHash(item.title),
          priority: item.priority,
          dueAt: item.dueAt,
          noteAt: latest,
          // A found issue already has the links: they were attached before the state was lost.
          links: found ? [...item.links] : [],
          open: issue.open,
          // It came in from the tracker: its words stay its author's.
          ...(adopt ? { inbound: true as const } : {}),
        };
        st.refs[String(n)] = rec;
        save();
      } else if (!rec.inbound && (rec.titleHash !== titleHash(item.title) || rec.priority !== item.priority || rec.dueAt !== item.dueAt || cfg.body)) {
        await tracker.update(rec, out, { priority: rec.priority, dueAt: rec.dueAt });
        rec.titleHash = titleHash(item.title);
        rec.priority = item.priority;
        rec.dueAt = item.dueAt;
        sum.updated++;
      }
      // Moves and notes since the last run, as comments; what came in from the tracker is not sent back.
      const last = item.last?.at ?? '';
      if (last > rec.noteAt) {
        const whole = await lane.item(n);
        for (const note of (whole?.notes ?? []).filter((x) => x.at > rec!.noteAt && !x.via && x.from !== null && x.note !== `Linked ${rec!.url}`)) {
          const moved = note.from !== note.to;
          const words = cfg.body && note.note ? `\n\n${note.note}` : '';
          const ref = note.ref ? `\n\nRef: ${note.ref}` : '';
          await tracker.comment(rec, `Crossroom lane ${laneLabel(n)}: ${sideWords(note.by)} ${moved ? `moved it to ${LANE_STATE_WORDS[note.to]}` : 'added a note'}.${words}${ref}\n\n${out.marker}`);
          sum.commented++;
        }
        rec.noteAt = last;
      }
      if (rec.state !== item.state) {
        try {
          await tracker.setState(rec, item.state);
          rec.state = item.state;
          rec.open = item.state !== 'closed';
        } catch (e) {
          warn(`${laneLabel(n)} (${rec.key}): ${(e as Error).message}`);
        }
      }
      for (const url of item.links.filter((u) => u !== rec!.url && !rec!.links.includes(u))) {
        await tracker.link(rec, url);
        rec.links.push(url);
      }
      let version = item.version;
      if (rec.url.startsWith('https://') && !item.links.includes(rec.url)) {
        // The issue linked back on the item, so either side's agent can find it.
        version = (await lane.update(n, { links: rec.url, version: item.version })).version;
        rec.links.push(rec.url);
      }
      rec.version = version;
      save();
    } catch (e) {
      warn(`${laneLabel(n)}: ${(e as Error).message}`);
    }
  }
  drain();
  save();
  return sum;
}

export interface Trailers {
  commits: Array<{ sha: string; branch: string; items: number[] }>;
  /** Why none were read, when that is worth saying. */
  warning?: string;
}

/**
 * Commits on the default branch since `cursor` (or the latest 50), with the items their
 * `Fixes-Lane:` trailers name, oldest first. The default branch is `origin/HEAD`, else
 * `origin/main` or `origin/master`; never `HEAD`, which in CI may be a pull request's commit.
 */
export async function trailersIn(cwd: string, cursor: string | undefined): Promise<Trailers> {
  const git = async (...args: string[]) => (await run('git', args, { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  let branch = '';
  try {
    branch = await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  } catch {
    for (const b of ['origin/main', 'origin/master']) {
      try {
        await git('rev-parse', '--verify', '--quiet', `refs/remotes/${b}`);
        branch = b;
        break;
      } catch {
        // Not this one.
      }
    }
  }
  if (!branch)
    return {
      commits: [],
      warning: 'Commit trailers were not read: this repository has no origin/HEAD, origin/main or origin/master (`git remote set-head origin --auto` names the default branch).',
    };
  let log: string;
  try {
    const range = cursor && /^[0-9a-f]{7,40}$/.test(cursor) ? [`${cursor}..${branch}`] : ['-n', '50', branch];
    log = await git('log', '--reverse', '--format=%H%x1f%B%x1e', ...range);
  } catch {
    // A cursor the history no longer holds (a force-push): read the latest 50 again.
    if (!cursor) return { commits: [] };
    return trailersIn(cwd, undefined);
  }
  const commits: Trailers['commits'] = [];
  for (const entry of log.split('\x1e')) {
    const [sha, body = ''] = entry.trim().split('\x1f');
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;
    const items = [...body.matchAll(/^(?:Fixes-Lane|Crossroom-Lane):\s*L(\d{1,6})\s*$/gim)].map((m) => Number(m[1]));
    commits.push({ sha, branch, items: [...new Set(items)] });
  }
  return { commits };
}
