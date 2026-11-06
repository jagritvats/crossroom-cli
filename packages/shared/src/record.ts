/**
 * The record: facts a project keeps across its rooms, their labels, the search
 * grammar, the `record` seat operation's arguments and result, and the signed export.
 *
 * A fact is filed when a project room ends: an established or ruled-out claim as **F**, an open or
 * disputed claim, an unanswered request or an owner question left open as **Q**, an outcome or a
 * ruling as **D**. Every word of it is sealed under the project key on the server. A seat of the
 * project's own organisation may read facts in scope through `record`; a fact is a prior finding,
 * cited as `F14`, and never counts as evidence crossing in the room that cites it.
 *
 * Pure: zod and nothing from Node. The web app may import from here with `import type` only,
 * so its bundle carries no zod.
 */
import { z } from 'zod';
import type { RecordScope } from './org.js';

// ---------------------------------------------------------------- facts and labels

export const FactKind = z.enum(['established', 'ruled_out', 'settled', 'open', 'decision']);
export type FactKind = z.infer<typeof FactKind>;
/** The label prefix each kind is filed under. */
export const FACT_PREFIX: Readonly<Record<FactKind, 'F' | 'Q' | 'D'>> = {
  established: 'F',
  ruled_out: 'F',
  settled: 'D',
  open: 'Q',
  decision: 'D',
};
/** A fact's label: F, Q or D and a number, unique in its project. One of the server's citable labels, and never a packet's `X` or a claim's `C`. */
export const FACT_LABEL = /^[FQD][1-9][0-9]{0,5}$/;
export const isFactLabel = (label: unknown): label is string => typeof label === 'string' && FACT_LABEL.test(label);

/** A source a fact rests on, as the packets of its room cited it and Crossroom checked them. */
export interface FactSource {
  /** The packet it came from in its room (`X2`). */
  packet: string;
  /** The seat that shared it, by its standing label or name. */
  seat: string;
  source: string;
  /** The commit the check read, when there was one. */
  commit: string | null;
  check: 'checked' | 'differs' | 'not_found' | 'unchecked';
  /**
   * Source identity (workspace B2). Absent on a source filed before it was recorded, and `toFact`
   * then says `unknown` / null: a legacy source is never assigned a repository it did not name.
   */
  provider?: 'github' | 'parley' | 'manual' | 'unknown';
  /** `owner/name`, or null where unknown. */
  repo?: string | null;
  /** A commit SHA or tag, or null where unknown. */
  revision?: string | null;
}
/** A position on a fact's claim when the room ended. */
export interface FactPosition {
  seat: string;
  stance: string;
  evidence: string[];
}
/** A fact as a member of its project reads it. */
export interface Fact {
  id: string;
  label: string;
  kind: FactKind;
  text: string;
  sources: FactSource[];
  positions: FactPosition[];
  filedAt: string;
  /** Null once its room is deleted (a promoted fact outlives it). */
  sessionId: string | null;
  promotedAt: string | null;
  staleAt: string | null;
  staleReason: string | null;
  supersededBy: string | null;
}

// ---------------------------------------------------------------- search

/**
 * The search grammar: words, and `path:<glob>`, `repo:<owner/name>`, `team:<id>`,
 * `status:<kind>`, `before:<date>`, `after:<date>`. Facts are decrypted and scanned in memory,
 * so nothing here is ever an index a copy of the database could read.
 *
 * The query is an agent's to write (`record`), and a glob is the one part a matcher can be made to
 * spend seconds on: picomatch compiles `**` to a lazy pattern that backtracks, so `**\/a/**\/a/**\/b`
 * took 39 s on 800 characters. So a search takes at most `SEARCH_TERMS_MAX`
 * terms and `SEARCH_PATHS_MAX` globs, each at most `SEARCH_GLOB_MAX` characters of `*`, `?`, `[…]`
 * and plain path characters (no braces, no extglobs), with at most `SEARCH_GLOBSTARS_MAX` `**`.
 *
 * A query past any of those, or longer than `SEARCH_MAX`, is refused, never searched with the term left out: every term narrows
 * what a query matches, so a filter left out widens it, and `path:api/{v1,v2}/**` searched without
 * its glob would hand a seat the project's newest facts instead of the API ones, as if they were
 * what it asked for. The parser keeps every term as written and says why in `refused`; whoever
 * searches (the facts route, the `record` operation, a playbook's `facts` packet) answers 400 with
 * that sentence before scanning anything, and a playbook whose `facts` query is refused is refused
 * when it is saved (`parsePlaybook`). And the search matches every glob against a fact's sources
 * through a bounded matcher run under `withinTime` (runner/egress-policy.ts), as the policy's deny
 * globs are, so no query can hold the event loop whatever reached it.
 */
export interface FactQuery {
  words: string[];
  paths: string[];
  repos: string[];
  teams: string[];
  kinds: FactKind[];
  before: string | null;
  after: string | null;
  /**
   * Why this query must not be searched, in Crossroom's words (one of `SEARCH_REFUSED`), or null. Every
   * term is still in the fields above as written: a refused query is refused whole, with a 400.
   */
  refused: string | null;
}
export const SEARCH_MAX = 500;
export const SEARCH_TERMS_MAX = 20;
export const SEARCH_PATHS_MAX = 5;
export const SEARCH_GLOB_MAX = 200;
export const SEARCH_GLOBSTARS_MAX = 3;
/** A glob the search may match: plain path characters, `*`, `?` and `[…]` classes. */
const SEARCH_GLOB = /^[A-Za-z0-9._/*?[\]-]+$/;

/** Whether a `path:` glob is within the limits a search can match in bounded time. */
export const searchGlobAllowed = (glob: string) =>
  glob.length <= SEARCH_GLOB_MAX && SEARCH_GLOB.test(glob) && (glob.match(/\*\*/g)?.length ?? 0) <= SEARCH_GLOBSTARS_MAX;

/** The sentences a refused search answers with (`FactQuery.refused`), constant words only. */
export const SEARCH_REFUSED = {
  length: `A search is at most ${SEARCH_MAX} characters.`,
  terms: `A search takes at most ${SEARCH_TERMS_MAX} terms.`,
  paths: `A search takes at most ${SEARCH_PATHS_MAX} path: globs.`,
  glob: `A path: glob is at most ${SEARCH_GLOB_MAX} characters of letters, digits, . _ - / * ? and [ ], with at most ${SEARCH_GLOBSTARS_MAX} **; no braces or extglobs.`,
} as const;

/**
 * Read a search string. An unknown `key:` is a word, so a query can never fail to parse; one past
 * the limits parses whole and says so in `refused`, which the caller answers with a 400.
 */
export function parseFactQuery(q: string): FactQuery {
  const out: FactQuery = { words: [], paths: [], repos: [], teams: [], kinds: [], before: null, after: null, refused: null };
  const tokens = q.slice(0, SEARCH_MAX).split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const m = /^(path|repo|team|status|before|after):(.+)$/.exec(token);
    const key = m?.[1];
    const v = m?.[2] ?? '';
    if (key === 'path') {
      out.paths.push(v);
      if (!searchGlobAllowed(v)) out.refused ??= SEARCH_REFUSED.glob;
    } else if (key === 'repo') out.repos.push(v);
    else if (key === 'team') out.teams.push(v);
    else if (key === 'status' && FactKind.safeParse(v).success) out.kinds.push(v as FactKind);
    else if ((key === 'before' || key === 'after') && /^\d{4}-\d\d-\d\d$/.test(v) && !Number.isNaN(Date.parse(v))) out[key] = v;
    else out.words.push(token.toLowerCase());
  }
  // Cut at `SEARCH_MAX`, a term would lose its end, and `path:src/**/x.ts` read as `path:src/**`.
  if (q.length > SEARCH_MAX) out.refused = SEARCH_REFUSED.length;
  else if (tokens.length > SEARCH_TERMS_MAX) out.refused = SEARCH_REFUSED.terms;
  else if (out.paths.length > SEARCH_PATHS_MAX) out.refused = SEARCH_REFUSED.paths;
  return out;
}

/** `GET /api/projects/:p/facts?q=&limit=` (a reader): the project's facts matching the query, newest first. */
export interface FactsResult {
  facts: Fact[];
  total: number;
}

// ---------------------------------------------------------------- the `record` seat operation

/** At most this many entries per call. */
export const RECORD_LIMIT_MAX = 5;
/** The operation's whole reply stays under this many characters (a test holds it there). */
export const RECORD_OUTPUT_MAX = 3500;
/** The one line a project room's briefing adds about `record`. */
export const RECORD_BRIEFING_LINE_MAX = 160;

/** `record(query?, limit?)`: the arguments, as a tool schema's raw shape. */
export const RecordOpArgs = {
  query: z.string().max(SEARCH_MAX).optional().describe('Words, path:<glob>, repo:<owner/name> or status:<kind>. Empty lists the latest.'),
  limit: z.number().int().min(1).max(RECORD_LIMIT_MAX).optional().describe(`How many facts, at most ${RECORD_LIMIT_MAX}.`),
};

/** One fact as the `record` operation gives it to a seat. */
export interface RecordEntry {
  label: string;
  kind: FactKind;
  filedAt: string;
  text: string;
  /** Each as `X2 payments-api src/api/checkout.ts:40-72 @a1b2c3d`. */
  sources: string[];
  /** Crossroom's reading of the sources when the fact was filed, printed after the fence where no participant writes. */
  check: FactSource['check'];
}
/** `OpData.record`: what `?format=json` serves. */
export interface RecordData {
  entries: RecordEntry[];
  /** How many facts in scope matched, beyond those returned. */
  total: number;
  scope: RecordScope;
}

// ---------------------------------------------------------------- promotion and export

/** `POST /api/projects/:p/facts/:f/promote` (a project admin, Team plan): keep the signed full minutes with the fact. */
export interface PromoteResult {
  label: string;
  promotedAt: string;
}
export const RECORD_EXPORT_FORMAT = 'parley-record/v1';
/**
 * `GET /api/projects/:p/record/export` (a project admin): every fact, and each promoted fact's
 * signed minutes by their sha256, signed as a whole with the instance's Ed25519 key over
 * `parley/record/v1` and a line feed, then the canonical JSON of everything but `signature.value`,
 * so the signature's algorithm, public key, fingerprint and instance are signed too. It is served
 * as that canonical JSON, and `crossroom verify record.json` holds the file to those exact bytes (a
 * trailing LF or CRLF allowed), then checks the signature, each attached minutes' own signature,
 * and that each fact is in the right section of its minutes.
 */
export interface RecordExport {
  format: typeof RECORD_EXPORT_FORMAT;
  project: { id: string; name: string; org: string };
  exportedAt: string;
  facts: Array<Omit<Fact, 'sessionId'> & { minutes: string | null }>;
  attachments: Record<string, string>;
  signature: { algorithm: 'Ed25519'; publicKey: string; fingerprint: string; instance: string; value: string };
}
