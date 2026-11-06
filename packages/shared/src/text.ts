/**
 * Participant-written text that ends up on one line of something Crossroom prints.
 *
 * Shared because the same rules have to hold wherever a briefing is rendered: on the server
 * for an ordinary room, and in the seat helper for an end-to-end encrypted one, where the
 * server never sees the words at all.
 */
import type { SourceCheck } from './index.js';

/**
 * Every character a reader might take as the end of a line.
 *
 * Not just `\r` and `\n`. NEL (U+0085), LS and PS (U+2028, U+2029), VT and FF all end a line
 * in Unicode, and a model reading a briefing may honour any of them. JavaScript's `\s` does
 * not include NEL, so a whitespace collapse alone lets it through.
 */
export const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

/**
 * Participant-written text that Crossroom prints *outside* a fence, on one line.
 *
 * Seat names and titles derived from a first message are chosen by a participant and then
 * printed in the other agent's briefing as Crossroom's own words — the session heading, "you are
 * talking to X". Anything that can break the line there can start a forged section at column
 * 0. So every C0 and C1 control character and both Unicode separators become a space, which
 * also removes invisible junk no legitimate name contains.
 */
export const oneLine = (text: string) =>
  [...text]
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 ? ' ' : ch;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

/** First non-empty line, collapsed and clipped: a title derived from prose. */
export const firstLine = (text: string, max = 120) => {
  const line = text.split(LINE_BREAK).map(oneLine).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

// ---------------- tool offers ----------------

/**
 * Something a seat says it will run for the other seats, on request: a log search, a git
 * command, a query against its own database. Crossroom never runs it. The seat that offered it
 * runs it on its own machine and answers with a packet, so the ledger shows who asked for
 * what, who ran it and what came back, and nothing crosses that the offering side did not
 * choose to send.
 */
export interface Offer {
  name: string;
  description: string;
}

/** A tool name: short, one token, the same in every renderer. */
export const OFFER_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
export const MAX_OFFERS = 8;
const OFFER_DESC_MIN = 3;
const OFFER_DESC_MAX = 160;
/** What an agent sends to withdraw every offer it made. */
export const NO_OFFERS = 'none';
export const OFFERS_EXAMPLE = 'git_history: git log and git show on this repository; log_search: grep the service logs for a string';

const offersRule = (problem: string) =>
  `${problem}. Offers are \`name: what it does\` items separated by ";" or line breaks, at most ${MAX_OFFERS}, e.g. offers="${OFFERS_EXAMPLE}". A name is letters, digits, _ . or -, starting with a letter. offers=none withdraws them.`;

/**
 * One string in, a list out, or a sentence saying what is wrong with it.
 *
 * A string rather than a list of objects because it has to survive every surface unchanged: a
 * form-encoded curl, the seat helper's `k=v`, a JSON body and an MCP schema all carry a string,
 * and only one of them carries nested structures. `none` withdraws. Descriptions are collapsed
 * with `oneLine`, because they are printed in the other seat's briefing and in the minutes.
 */
export function parseOffers(text: string): Offer[] {
  const raw = text.trim();
  if (raw.toLowerCase() === NO_OFFERS) return [];
  const items = raw
    .split(LINE_BREAK)
    .flatMap((l) => l.split(';'))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) throw new Error(offersRule('No offers found in that'));
  if (items.length > MAX_OFFERS) throw new Error(offersRule(`That is ${items.length} offers`));
  const out: Offer[] = [];
  for (const item of items) {
    const colon = item.indexOf(':');
    const name = colon > 0 ? item.slice(0, colon).trim() : '';
    const description = colon > 0 ? oneLine(item.slice(colon + 1)) : '';
    const shown = oneLine(item).slice(0, 60);
    if (!name) throw new Error(offersRule(`"${shown}" has no name before a colon`));
    if (!OFFER_NAME.test(name)) throw new Error(offersRule(`"${oneLine(name).slice(0, 60)}" is not a usable tool name`));
    if (description.length < OFFER_DESC_MIN) throw new Error(offersRule(`${name} needs a description of what it does`));
    if (description.length > OFFER_DESC_MAX) throw new Error(offersRule(`The description of ${name} is over ${OFFER_DESC_MAX} characters`));
    if (out.some((o) => o.name.toLowerCase() === name.toLowerCase())) throw new Error(offersRule(`${name} is offered twice`));
    out.push({ name, description });
  }
  return out;
}

/** The offer a request names, whatever case it was typed in. */
export const findOffer = (offers: Offer[], name: string) => offers.find((o) => o.name.toLowerCase() === name.trim().toLowerCase());

/** Offers on one line, in the order they were declared. */
export const offersText = (offers: Offer[]) => offers.map((o) => `${o.name}: ${o.description}`).join('; ');

/** How a tool request reads everywhere Crossroom prints one. */
export const runText = (tool: string, args: string | null) => `${tool}(${args ?? ''})`;

// ---------------- a seat's close-out ----------------

/**
 * What `finish` takes besides its summary: what was decided, who does what, and what is still open.
 * Every kind of room ends on some of these, a meeting and a hand-over as much as a dispute, so the
 * recap leads with them. Each is one string of items, for the reason `offers` is: a form-encoded
 * curl, the seat helper's `k=v` and an MCP schema all carry a string.
 */
export const CLOSE_OUT_FIELDS = ['decisions', 'actions', 'open'] as const;
export type CloseOutField = (typeof CLOSE_OUT_FIELDS)[number];
/** The most items one field keeps, and the longest an item is printed. */
export const CLOSE_OUT_ITEMS = 20;
export const CLOSE_OUT_ITEM_MAX = 400;
/** The longest a field's whole string may be. */
export const CLOSE_OUT_MAX = 4000;

/**
 * One field's string as its items: split on ";" and on line breaks, each collapsed with `oneLine`
 * (they are printed one to a line in the recap), a leading list marker dropped, empty ones left out,
 * and each cut at `CLOSE_OUT_ITEM_MAX`. Never throws: the count is the caller's to refuse, since only
 * the server and the helper hold the words before they are stored (`closeOutProblem`).
 */
export function closeOutItems(text: string): string[] {
  return text
    .split(LINE_BREAK)
    .flatMap((l) => l.split(';'))
    .map((s) => oneLine(s).replace(/^(?:[-*•]|\d{1,3}[.)])\s+/, ''))
    .filter(Boolean)
    .map((s) => (s.length > CLOSE_OUT_ITEM_MAX ? `${s.slice(0, CLOSE_OUT_ITEM_MAX - 1).trimEnd()}…` : s));
}

/** Why a field's string cannot be stored, or null. */
export function closeOutProblem(field: CloseOutField, text: string): string | null {
  const n = closeOutItems(text).length;
  return n > CLOSE_OUT_ITEMS ? `${field} has ${n} items; at most ${CLOSE_OUT_ITEMS}, separated by ";"` : null;
}

/** A seat's close-out as a `participant_finished` payload carries it. Each list is absent when empty. */
export interface CloseOut {
  summary: string;
  decisions?: string[];
  actions?: string[];
  open?: string[];
}

/**
 * The close-out in a `participant_finished` payload, read defensively: a payload from before these
 * fields has only a summary, and one from a published file or a browser is not the server's. A list
 * is read as strings, collapsed again and capped; a bare string (an end-to-end room's field before the
 * helper split it) is split here.
 */
export function closeOutOf(payload: Record<string, unknown> | null | undefined): CloseOut {
  const p = payload ?? {};
  const list = (v: unknown): string[] =>
    (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').flatMap(closeOutItems) : typeof v === 'string' ? closeOutItems(v) : []).slice(
      0,
      CLOSE_OUT_ITEMS,
    );
  const out: CloseOut = { summary: typeof p.summary === 'string' ? p.summary : '' };
  for (const f of CLOSE_OUT_FIELDS) {
    const items = list(p[f]);
    if (items.length) out[f] = items;
  }
  return out;
}

// ---------------- source checks ----------------

/** What Crossroom found in a packet's cited file, as the end of a sentence. Counts only: no text a participant wrote. */
export function sourceCheckPhrase(c: SourceCheck): string {
  const file = c.files > 1 ? 'the cited files' : 'the cited file';
  const lines = (n: number) => (n === 1 ? '1 line' : `${n} lines`);
  switch (c.status) {
    case 'checked':
      return c.of === 1 ? `its one line is in ${file}` : `all ${c.of} lines are in ${file}`;
    case 'partial':
      return `${c.found} of its ${lines(c.of)} ${c.found === 1 ? 'is' : 'are'} in ${file}`;
    case 'differs':
      return c.of === 1 ? `its one line is not in ${file}` : `none of its ${c.of} lines are in ${file}`;
    case 'not_found':
      return c.files > 1 ? "the cited files are not in the sender's directory" : "the cited file is not in the sender's directory";
  }
}

/** The same, as a short tag: `source checked`, `source partly checked`, `source differs`, `source not found`. */
export function sourceCheckTag(c: SourceCheck): string {
  return { checked: 'source checked', partial: 'source partly checked', differs: 'source differs', not_found: 'source not found' }[c.status];
}

// ---------------- runtimes in seat names ----------------

/** What a hosted runner is called where a seat name carries it, as in "Frontend (Codex)". */
export const RUNNER_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity', grok: 'Grok' };

/**
 * A seat name with its runtime changed. The seat keeps its role and takes the name of what now
 * runs it: "Frontend (Codex)" run by Claude becomes "Frontend (Claude Code)", and a seat called
 * just "Codex" becomes "Claude Code". Any other name is left alone: a seat named for its role
 * alone ("Reviewer") says nothing about its runtime that could turn false.
 */
export function relabelSeat(name: string, from: string, to: string): string {
  const was = RUNNER_LABELS[from];
  const now = RUNNER_LABELS[to];
  if (!was || !now || was === now) return name;
  if (name === was) return now;
  const suffix = ` (${was})`;
  return name.endsWith(suffix) ? `${name.slice(0, -suffix.length)} (${now})` : name;
}

/** Title a quick room carries until its first message names it. */
/**
 * Seat letters. Here rather than beside the domain types because the browser prints them, and
 * `index.ts` builds its zod schemas when it loads: importing a one-line helper from there would
 * ship the whole validation library to every visitor.
 */
export const SLOT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] as const;
export const slotLetter = (slot: number) => SLOT_LETTERS[slot] ?? String(slot);
/**
 * The most seats any room can hold: one per seat letter. The ceiling the code supports, which the
 * schemas' bounds use because they are built when a module loads. What an instance actually allows
 * is its own cap (`roomSeatsMax` on the server, `PARLEY_ROOM_SEATS_MAX`, `/api/features`), at most this.
 */
export const ROOM_SEATS_LIMIT = SLOT_LETTERS.length;
/** The seats an instance allows in a room unless its operator sets `PARLEY_ROOM_SEATS_MAX`. */
export const ROOM_SEATS_DEFAULT = 6;
/** The fewest seats an instance's cap may be. */
export const ROOM_SEATS_FLOOR = 2;
/** The refusal for a room past the instance's cap, the same on every path that opens or grows a room. */
export const seatCapText = (max: number): string => `This instance allows up to ${max} agents in a room.`;
/**
 * What a seat sees past this many seats in a room changes: the briefing's list of the others goes
 * compact (one short line each, roles clipped), so a room of twelve stays readable to a small model.
 */
export const COMPACT_SEATS_OVER = 6;

/**
 * Sub-rooms a room's lead may open (a later part builds them): off, the owner asked each time, or
 * opened without asking. Stored as 0, 1 and 2 in `sessions.subrooms`.
 */
export const SUBROOM_MODES = ['off', 'ask', 'auto'] as const;
export type SubroomMode = (typeof SUBROOM_MODES)[number];
/** The optional tools a room is created with. Absent or false means a room as it always was. */
export interface RoomOptions {
  board?: boolean;
  typedTools?: boolean;
  subrooms?: SubroomMode;
  /** Packets reach the other agents as cards they open on demand (`@parley/shared/sparse`). */
  sparse?: boolean;
  /** Two sides filing items for each other and working them later (`@parley/shared/lane`). */
  lane?: boolean;
}
/** The options as a create input holds them, keeping only those that are set (`subrooms: 'off'` is none). */
export function roomOptionsOf(o: RoomOptions | null | undefined): RoomOptions {
  const out: RoomOptions = {};
  if (o?.board === true) out.board = true;
  if (o?.typedTools === true) out.typedTools = true;
  if (o?.subrooms === 'ask' || o?.subrooms === 'auto') out.subrooms = o.subrooms;
  if (o?.sparse === true) out.sparse = true;
  if (o?.lane === true) out.lane = true;
  return out;
}
/**
 * The longest seat role: one line the owner types for what a seat is in the room for, printed to
 * every seat and in the recap through `oneLine`.
 */
export const ROLE_MAX = 160;

/**
 * Said after a role that is a standing seat's team's own description of it (`Participant.roleByTeam`)
 * rather than the owner's words: in the briefing, the recap and on the plate. Crossroom's words, so it
 * sits outside the role, after it.
 */
export const ROLE_BY_TEAM = '(described by its team)';

/**
 * A role as it is stored and printed: collapsed to one line (`oneLine`) and clipped to `ROLE_MAX`
 * UTF-16 units, never between the halves of a surrogate pair. The owner's role and a standing seat's
 * team-written description (the role it falls back to) both go through it.
 */
export function roleLine(text: string): string {
  return lineClip(text, ROLE_MAX);
}

/** Text on one line (`oneLine`), cut to `max` UTF-16 units, never between the halves of a surrogate pair. */
export function lineClip(text: string, max: number): string {
  const line = oneLine(text);
  if (line.length <= max) return line;
  let end = max;
  const last = line.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return line.slice(0, end).trimEnd();
}

export const QUICK_TITLE = 'New room';
/** What a room opened with the one button was titled before the brand became Crossroom; rooms already stored carry it. */
export const LEGACY_QUICK_TITLE = 'New parley';
/** Whether a title is still the one button's placeholder, old or new. */
export const isQuickTitle = (title: string) => title === QUICK_TITLE || title === LEGACY_QUICK_TITLE;
/** Placeholder seat names; an agent replaces its own when it joins. */
export const QUICK_SEAT_NAMES = ['Seat A', 'Seat B'] as const;
/** Placeholder names for a quick room of `n` seats (`Seat A` onwards). */
export const quickSeatNames = (n: number): string[] => Array.from({ length: n }, (_, i) => `Seat ${slotLetter(i)}`);

/** A lane's two sides when nothing names them better. */
export const LANE_SIDE_FALLBACK = ['Side A', 'Side B'] as const;

/**
 * A lane's two side names from its title or topic, when it reads "web and api" (or "web & api",
 * "web / api", "web <-> api", "web vs api"), after an optional "Lane:" label; otherwise `Side A` and
 * `Side B`. A lane's sides are repositories, and its seat names are what every item, note and pass
 * calls them by, so "Agent A" or "Your repository" would print on every line. A part that is long,
 * a seat letter, a preset's unfilled `[blank]` or the same as the other is not taken.
 */
export function laneSideNames(topic: string): [string, string] {
  const line = oneLine(topic).replace(/^[A-Za-z][\w -]{0,20}:\s+/, '');
  const m = /^(.+?)\s+(?:and|&|\/|<->|<=>|vs\.?|versus|\+)\s+(.+?)[.!]?$/i.exec(line);
  const ok = (s: string) => s.length >= 1 && s.length <= 40 && s.split(/\s+/).length <= 4 && !/[[\]`@]/.test(s) && !/^[A-La-l]$/.test(s);
  if (m) {
    const [a, b] = [m[1]!.trim(), m[2]!.trim()];
    if (ok(a) && ok(b) && a.toLowerCase() !== b.toLowerCase() && !/\s(?:and|&)\s/i.test(b)) return [a, b];
  }
  return [...LANE_SIDE_FALLBACK];
}
/**
 * The message budget a room of `seats` gets when nobody chose one: 40 for two or three seats, then
 * 15 a seat, so each of six agents still has a turn or two to answer the others.
 */
export const defaultMaxMessages = (seats: number): number => Math.max(40, 15 * seats);

/**
 * The one Claude Code permission rule that lets an agent make every seat call on an instance
 * without its user approving each one: `Bash(curl *<origin>/j/*)`, from a seat link or the instance's
 * address. Probed with Claude Code 2.1.304 on 2026-10-23: the colon form `Bash(curl -s <url>/j/:*)`
 * matched nothing (the colon of `https:` ends its prefix), while this one matched every shape the
 * recipes take (quoted or not, `-X POST`, a heredoc) and refused any other path. A `$L` in a call of
 * its own is never allowed ("a variable can't be checked"), which is why the recipes write the link
 * out. Not a sandbox: options after the address can still attach a local file or name a second one.
 */
export function curlRule(seatUrlOrOrigin: string): string {
  const at = seatUrlOrOrigin.indexOf('/j/');
  const origin = at >= 0 ? seatUrlOrOrigin.slice(0, at) : seatUrlOrOrigin.replace(/\/+$/, '');
  return `Bash(curl *${origin}/j/*)`;
}
