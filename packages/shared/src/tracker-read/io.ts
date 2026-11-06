/**
 * The readers of issue trackers (GitHub, Azure DevOps, Jira), shared by the relay, a team's runner,
 * the `crossroom` command and the web app (`@parley/shared/tracker-read`: zod-free and Node-free, so a
 * browser runs them with a token the person types, which never reaches Crossroom). A reader is a pure function over a getter: it asks for paths on the tracker's API and builds
 * what Crossroom keeps of one item (`TrackerRead`) with the `@parley/shared/trackers` helpers only, so
 * every string and list is bounded the same way whoever read it.
 *
 * Who reads decides who is asked: the relay passes a getter that goes through `safeFetch` with no
 * token (a public project only); the command passes one that sends the person's own token to that
 * tracker's origin and nowhere else, with `redirect: 'error'`. A reader never sees a token, a host
 * or an error's wording: the getter throws its own refusal for the item itself, and a reader treats a
 * failure of anything beyond the item (its comments, links, sprint dates) as nothing to add.
 */
import type { TrackerSnapshot } from '../trackers.js';

export interface TrackerIo {
  /** GET a path (and query) on the tracker's API; answers its JSON, or throws the caller's own refusal. */
  get(path: string): Promise<unknown>;
  /** POST a JSON body to a path; for queries (a search, WIQL). */
  post?(path: string, body: unknown): Promise<unknown>;
}

/** What a reader makes of one item. */
export interface TrackerRead {
  /** One line, bounded. */
  title: string;
  /** The description as text, bounded at the brief's size. */
  body: string;
  /** The acceptance criteria the tracker lists, bounded; empty when it lists none. */
  criteria: string[];
  snapshot: TrackerSnapshot;
  /** Who opened it, where the tracker says (GitHub); the brief's head names them. */
  author?: string | null;
}

export interface ReadOptions {
  readBy: TrackerSnapshot['readBy'];
  /** The time, for tests. */
  now?: () => Date;
}

/** The tracker answered, but not with the item asked for. */
export class TrackerAnswerError extends Error {}

/**
 * What a search or a list was asked is not one it can run: an address that names no repository or
 * project, a filter a tracker can't express. Its message is a sentence for the person, and names
 * nothing but what they typed.
 */
export class TrackerQueryError extends Error {}

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Points as the snapshot holds them: a finite number from 0 to 100,000, or null. */
export const pointsOf = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : num(v);
  return n !== null && Number.isFinite(n) && n >= 0 && n <= 100_000 ? n : null;
};

/** A call beyond the item itself: its failure leaves that part empty, never fails the read. */
export async function besides<T>(fallback: T, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch {
    return fallback;
  }
}

/** The longest brief a work item holds (`MAX_BRIEF_CHARS` in `@parley/shared/work`, which imports zod; a test holds the two equal). */
export const BRIEF_CHARS = 20_000;

/** `owner/repo` as a webhook's `repo` field is held to (`TRUSTED_VALUE['trigger.repo']`, which a test holds this to). */
export const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** The most items one search page carries, and its default. */
export const SEARCH_PAGE_MAX = 100;
export const SEARCH_PAGE_DEFAULT = 25;
/** The most items a discovery list carries. */
export const OPTIONS_MAX = 100;

/** One item as a search page lists it: cheap, the list only, never comments, links or a timeline. */
export interface TrackerSearchItem {
  /** The item's own page, as an import takes it. */
  url: string;
  /** `acme/shop#12`, `#42`, `PAY-7`. */
  key: string;
  title: string;
  state: string;
  type: string;
  /** The sprint, iteration or milestone's name. */
  iteration: string | null;
  assignee: string | null;
  updatedAt: string | null;
}

/** A page of a search: `next` is the cursor for the following page, or null at the end; `total` where the tracker says. */
export interface TrackerSearchPage {
  items: TrackerSearchItem[];
  next: string | null;
  total: number | null;
}

/** A page size as a search takes it: 1 to `SEARCH_PAGE_MAX`, `SEARCH_PAGE_DEFAULT` when absent or not a number. */
export const pageSizeOf = (n: unknown): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : SEARCH_PAGE_DEFAULT;
  return Math.min(Math.max(v, 1), SEARCH_PAGE_MAX);
};

/** A cursor that is a whole number (a page, an offset), or the default. */
export const cursorNumber = (c: string | null | undefined, dflt: number, max = 1_000_000): number => {
  if (!c || !/^[0-9]{1,7}$/.test(c)) return dflt;
  return Math.min(Number(c), max);
};

/** A named thing a discovery list gives: a project, a team, a sprint, a label. Plain bounded strings. */
export interface TrackerOption {
  /** What a filter or a sync takes: a key, a name, an id as a string. */
  value: string;
  /** What a person reads. */
  name: string;
  /** Anything the tracker adds: dates, the state, the description's first line. */
  detail?: string;
  /** A sprint's or iteration's window, where known, and whether it is the current one. */
  start?: string | null;
  end?: string | null;
  current?: boolean;
}

export const readAt = (o: ReadOptions) => (o.now ? o.now() : new Date()).toISOString();
