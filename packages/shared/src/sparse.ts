/**
 * Sparse rooms (`sparse: true` at create, `sessions.sparse`): a room a team keeps
 * shared context in, where nobody is expected to read all of it.
 *
 * A packet shared with everyone reaches the other agents as a card: its label, kind, title, sender,
 * size and source, and a short description the sender wrote (`about`), or the body's opening line
 * when it wrote none. An agent opens a packet whole only when it bears on its own work, with
 * `context label=<X>`, and finds one with `context q=<words>`. A packet sent to one seat (a reply
 * to its request) still arrives whole: that seat asked for it.
 *
 * The search is lexical and runs where the room is: Crossroom calls no model, so there are no
 * embeddings. Titles and descriptions are short, so an agent reads the index itself and judges what
 * is relevant with its own model; the ranking only puts the likely ones first. Terms are split on
 * case and punctuation (`customerId` is `customer id`), lightly stemmed, and matched whole or by
 * prefix, weighted by field (title, then description, then source, then body) and by how rare a term
 * is in this room.
 *
 * The one copy the server, the renderers and the web app share, so it imports nothing but text.ts.
 */
import { LINE_BREAK, oneLine } from './text.js';

/** The longest description a sender may give a packet, in characters. */
export const ABOUT_MAX = 280;
/** The most of a title and a source an index line shows; an opened packet shows them whole. */
export const CARD_TITLE_MAX = 120;
export const CARD_SOURCE_MAX = 80;
/** The longest opening line shown for a packet with no description. */
export const OPENING_MAX = 140;
/** Packets a sparse room holds: more than an ordinary room's 60, since nobody reads them all. */
export const SPARSE_MAX_ITEMS = 300;
/** Cards a sparse room's briefing lists, newest last; the rest are counted and found by search. */
export const SPARSE_BRIEF_CARDS = 12;
/** Cards a search answers with unless asked for fewer, and the most it ever answers with. */
export const SEARCH_HITS_DEFAULT = 10;
export const SEARCH_HITS_MAX = 25;
/** Packets one `context label=` call opens whole. */
export const OPEN_MAX = 3;

/** A description as it is stored: one line, spaces collapsed. Empty means none. */
export const aboutText = (raw: string | null | undefined): string => oneLine(String(raw ?? ''));

/** At most `max` characters, never cutting a surrogate pair, with an ellipsis when it cut. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** A packet body's first non-empty line, on one line and clipped: what a card shows with no description. */
export function openingLine(body: string): string {
  for (const line of body.split(LINE_BREAK)) {
    const l = oneLine(line);
    if (l) return clip(l, OPENING_MAX);
  }
  return '';
}

/** A packet's size as a card prints it. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** One packet as an index lists it. Every text field but the label and kind was written by a participant. */
export interface PacketCard {
  /** X1, X2...: Crossroom's own. */
  label: string;
  kind: string;
  title: string;
  /** The sender's description, or null when it gave none (`opening` stands in). */
  about: string | null;
  /** The body's opening line, for a packet with no description. */
  opening?: string;
  /** Who shared it, as the room names that seat ("Name (participant B)", or the owner). */
  fromName: string;
  source: string | null;
  bytes: number;
  /** Sent to this seat alone. */
  direct: boolean;
  createdAt: string;
}

/** A card found by a search, with the query terms it matched. */
export interface PacketHit extends PacketCard {
  score: number;
  matched: string[];
}

/** A packet opened whole by `context label=`. */
export interface OpenedPacket extends PacketCard {
  body: string;
}

/** What the `context` operation answers. */
export interface ContextIndexData {
  /** Packets this seat can read, in all. */
  total: number;
  /** The words searched for, as given, when it was a search. */
  query?: string;
  /** The seat letter (or `owner`) the list was narrowed to, when it was. */
  from?: string;
  /** Cards listed or found, newest last for a listing and best first for a search. */
  cards: Array<PacketCard | PacketHit>;
  /** Cards that matched or were listable but not shown. */
  more: number;
  /** Packets opened whole, when labels were asked for. */
  opened?: OpenedPacket[];
  /** Labels asked for that name no packet this seat can read. */
  missing?: string[];
  /** Crossroom's own lines after an opened packet (its source check, its attestation), by label. */
  notes?: Record<string, string>;
}

/** The labels a `context label=` call names: X1, x2, "X3, X4" or "X3 X4", each once, uppercased. */
export function parseLabels(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const l = part.trim().toUpperCase();
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------- search

/** Words too common to tell packets apart. */
const STOP = new Set(
  'a an and are as at be been but by can do does for from had has have how i if in into is it its me my no not of on or our so than that the their them then there these they this to too us was we were what when where which who why will with you your'.split(
    ' ',
  ),
);

/** A light suffix strip, so `caching`, `cached` and `caches` meet `cache` by prefix. */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * The terms of a text: split on case changes (`customerId`, `HTTPServer`) and on anything that is
 * not a letter or digit (`retry_policy`, `src/api/x.ts`), lower-cased, without stop words or single
 * characters, stemmed. Each term once, in order.
 */
export function searchTerms(text: string): string[] {
  const spaced = text
    .normalize('NFKC')
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase();
  const out: string[] = [];
  for (const w of spaced.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if ([...w].length < 2 || STOP.has(w)) continue;
    const t = stem(w);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** The fields a search reads, each as text. `body` is optional: a reader that lacks it ranks on the rest. */
export interface SearchFields {
  title: string;
  about: string;
  source: string;
  from: string;
  kind: string;
  body?: string;
}

/** How much a match in each field counts. The title and description are what a sender wrote to be found by. */
const WEIGHT: Readonly<Record<keyof SearchFields, number>> = { title: 4, about: 3, source: 2, from: 1, kind: 1, body: 1 };
const FIELDS = Object.keys(WEIGHT) as Array<keyof SearchFields>;

/** 1 for the same term, 0.6 for one a prefix of the other (both at least three characters), else 0. */
function termMatch(q: string, terms: readonly string[]): number {
  let best = 0;
  for (const t of terms) {
    if (t === q) return 1;
    if (q.length >= 3 && t.length >= 3 && (t.startsWith(q) || q.startsWith(t))) best = 0.6;
  }
  return best;
}

/**
 * The items that match `query`, best first, with the query terms each matched. Ties go to the newer
 * item (later in `items`). A query with no usable term matches nothing. Pure: the server runs it over
 * opened packets, and the web app over the packets on the owner's page.
 */
export function searchItems<T>(items: readonly T[], query: string, fields: (item: T) => SearchFields): Array<{ item: T; score: number; matched: string[] }> {
  const q = searchTerms(query);
  if (!q.length || !items.length) return [];
  const indexed = items.map((item, at) => {
    const f = fields(item);
    const terms = {} as Record<keyof SearchFields, string[]>;
    for (const k of FIELDS) terms[k] = searchTerms(f[k] ?? '');
    return { item, at, terms, title: (f.title ?? '').toLowerCase(), about: (f.about ?? '').toLowerCase() };
  });
  // How rare each term is in this room: a word in every packet tells none of them apart.
  const n = indexed.length;
  const idf = new Map<string, number>();
  for (const term of q) {
    const df = indexed.filter((x) => FIELDS.some((k) => termMatch(term, x.terms[k]) > 0)).length;
    idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }
  const phrase = q.length > 1 ? query.toLowerCase().replace(/\s+/g, ' ').trim() : '';
  const hits: Array<{ item: T; score: number; matched: string[]; at: number }> = [];
  for (const x of indexed) {
    let score = 0;
    const matched: string[] = [];
    for (const term of q) {
      let s = 0;
      for (const k of FIELDS) s += WEIGHT[k] * termMatch(term, x.terms[k]);
      if (s > 0) {
        matched.push(term);
        score += s * idf.get(term)!;
      }
    }
    if (!score) continue;
    // Every term found, or the words found together as typed, is worth more than a scatter of them.
    if (matched.length === q.length) score *= 1.25;
    if (phrase && (x.title.includes(phrase) || x.about.includes(phrase))) score *= 1.5;
    hits.push({ item: x.item, score: Math.round(score * 100) / 100, matched, at: x.at });
  }
  hits.sort((a, b) => b.score - a.score || b.at - a.at);
  return hits.map(({ item, score, matched }) => ({ item, score, matched }));
}
