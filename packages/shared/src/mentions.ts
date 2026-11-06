/**
 * Who a message is for: `@B`, `@codex`, `to=C`.
 *
 * Every message reaches every seat (its audience stays `all`). A mention only marks it as meant for
 * some of them, so a seat it is not meant for can hold its turn. Three callers must reach the same
 * answer from the same inputs, which is why this lives here and imports no zod: the server's `say`,
 * a runner predicting the event it is about to sign (runner/write-sign.ts), and the
 * seat helper, which parses the plain text of an end-to-end room before encrypting it.
 *
 * - With two seats nothing is parsed or stored: the only other seat is always the one addressed.
 * - With no `to`, a run of `@tokens` at the very start of the text addresses those seats, and so
 *   does a seat letter anywhere in it (`@B thanks. @C, how does orders…`): real agents address the
 *   second seat mid-message, and an uppercase single letter that is a seat here is hard to write by
 *   accident. A name or anything else in the middle of a sentence never does, so `@Override`, an
 *   email address and "as @codex said" are safe. Text mentions are lenient: a leading token that
 *   names nobody is dropped and reported back; a mid-text letter that is no seat is just text.
 * - An explicit `to` is strict: a token that names nobody, or more than one seat, is an error that
 *   names the seats, as `request_context`'s is.
 */
import { LINE_BREAK, oneLine, ROOM_SEATS_LIMIT, slotLetter } from './text.js';

/** A seat as matching needs it. `provider` is what its agent declared on `join`, if anything. */
export interface MentionSeat {
  id: string;
  slot: number;
  name: string;
  provider?: string | null;
}

/** One mention token: a letter or digit, then up to 59 of letters, digits, `.`, `_` and `-`. */
const TOKEN = /^@([A-Za-z0-9][A-Za-z0-9._-]{0,59})/;
/** The most tokens one message's leading run is read for. Any after it are just text. */
export const MAX_MENTIONS = ROOM_SEATS_LIMIT;
/** Tokens that mean the whole room, which is what no mention means too. */
const EVERYONE = new Set(['all', 'everyone', 'room']);
/** Tokens that mean the session owner, who is never addressed by a message. */
const OWNER = new Set(['human', 'owner']);

/** Whitespace a mention run may be separated by: `\s`, plus every line break (`\s` lacks NEL). */
const isSpace = (ch: string) => /\s/.test(ch) || LINE_BREAK.test(ch);

/**
 * The `@tokens` at the very start of `text`, without the `@`, at most `MAX_MENTIONS`. A token ends
 * at whitespace, a comma, a colon or the end of the text; one followed by anything else (`@B's`)
 * is not a token, and the run stops there. A trailing `.` is not part of a token (`@B. Hello`).
 */
export function leadingMentions(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  const skip = () => {
    while (i < text.length && isSpace(text[i]!)) i++;
  };
  skip();
  while (out.length < MAX_MENTIONS) {
    const m = TOKEN.exec(text.slice(i));
    if (!m) break;
    const next = text[i + m[0].length];
    if (next !== undefined && !isSpace(next) && next !== ',' && next !== ':') break;
    const token = m[1]!.replace(/\.+$/, '');
    if (!token) break;
    out.push(token);
    i += m[0].length;
    if (text[i] === ',' || text[i] === ':') i++;
    skip();
  }
  return out;
}

/**
 * Seat letters written as `@B` anywhere in `text`, in order, each once: an uppercase letter with no
 * letter, digit, `.`, `_`, `-` or `@` on either side, so `a@B.com`, `@Bob` and `@B-team` are not
 * one. Text inside backticks (a code span or a fence) is skipped, so a quoted `@C` stays a quote.
 * Which letters are seats is the caller's to decide.
 */
export function inlineLetters(text: string): string[] {
  const plain = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`]*`/g, ' ');
  const out: string[] = [];
  for (const m of plain.matchAll(/(?<![A-Za-z0-9._@-])@([A-Z])(?![A-Za-z0-9_@-])/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The seats a token names, from the first pass that names any: participant id, then seat letter,
 * then name (ignoring case). With `loose`, two more passes follow: the name with only letters and
 * digits kept (`claude-code` names "Claude Code"), then the declared provider.
 *
 * The passes are separate on purpose, and in this order. A seat letter is assigned by Crossroom
 * and a name is chosen by its holder, so a name must never win a tie against a letter: otherwise
 * whoever called itself "C" receives what was meant for seat C. (The server's `seatName` also refuses such
 * a name; this is the second lock.) Callers that want one seat take the first: seats are in slot
 * order, so that is the lowest slot, as a `find` over each pass would give.
 */
export function matchSeat<S extends MentionSeat>(seats: readonly S[], token: string, { loose = false }: { loose?: boolean } = {}): S[] {
  const want = token.trim().toLowerCase();
  const passes: Array<(s: S) => boolean> = [
    (s) => s.id === token,
    (s) => slotLetter(s.slot).toLowerCase() === want,
    (s) => s.name.toLowerCase() === want,
  ];
  if (loose) {
    const flat = alnum(want);
    passes.push(
      (s) => flat !== '' && alnum(s.name) === flat,
      (s) => !!s.provider && s.provider.trim().toLowerCase() === want,
    );
  }
  for (const pass of passes) {
    const hit = seats.filter(pass);
    if (hit.length) return hit;
  }
  return [];
}

export interface MentionInput {
  /** The message as written. Read only when `parseText` is true and `to` is absent. */
  text: string;
  /** The explicit addressees: letters, names or ids, separated by commas or spaces, or `all`. */
  to?: string | null;
  /** Every seat of the room, the writer's own included, in slot order. */
  seats: readonly MentionSeat[];
  /** The writer's participant id. */
  me: string;
  /** Whether a leading run of `@tokens` in `text` counts: false in an end-to-end room. */
  parseText: boolean;
}

export interface Mentions {
  /** Participant ids addressed, in slot order, the writer's own never among them. Empty: everyone. */
  ids: string[];
  /** Tokens that named no seat (text mentions only; in `to` they are an error). */
  unknown: string[];
  /** Tokens that named more than one seat (text mentions only). */
  ambiguous: string[];
  /** Whether a token named the session owner, who a message never addresses. */
  owner: boolean;
  /** Whether a token said the whole room (`all`, `everyone`, `room`). */
  everyone: boolean;
}

/** Why an explicit `to` was refused, worded for the agent that sent it. */
export class MentionError extends Error {}

const seatList = (seats: readonly MentionSeat[]) => seats.map((s) => `${slotLetter(s.slot)} (${oneLine(s.name)})`).join(', ');

/**
 * Who a message is for. Throws `MentionError` for an explicit `to` that names nobody, more than one
 * seat, or the owner; never for text, whose stray tokens come back in `unknown` and `ambiguous`.
 */
export function resolveMentions({ text, to, seats, me, parseText }: MentionInput): Mentions {
  const out: Mentions = { ids: [], unknown: [], ambiguous: [], owner: false, everyone: false };
  const strict = to !== undefined && to !== null && to.trim() !== '';
  const others = seats.filter((s) => s.id !== me);
  const tokens = strict
    ? to
        .split(/[\s,]+/)
        .map((t) => t.replace(/^@/, '').trim())
        .filter(Boolean)
        .slice(0, MAX_MENTIONS)
    : parseText && seats.length > 2
      ? leadingMentions(text)
      : [];
  const picked = new Set<string>();
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (EVERYONE.has(lower)) {
      out.everyone = true;
      continue;
    }
    if (OWNER.has(lower)) {
      if (strict) throw new MentionError('a message is never addressed to the session owner, who reads everything here: ask them with request_context to=human.');
      out.owner = true;
      continue;
    }
    let hit = matchSeat(seats, token, { loose: true });
    // Your own seat counts as a match only when it is the only one: "@codex" from one of two Codex
    // seats means the other.
    if (hit.length > 1) hit = hit.filter((s) => s.id !== me);
    if (hit.length === 1) {
      if (hit[0]!.id !== me) picked.add(hit[0]!.id);
      continue;
    }
    const shown = oneLine(token).slice(0, 60);
    if (strict) {
      throw new MentionError(
        hit.length
          ? `"${shown}" names more than one seat, so use its letter: to=${hit.map((s) => slotLetter(s.slot)).join(' or to=')}.`
          : `no participant "${shown}" here. Seats: ${seatList(others)}, or to=all.`,
      );
    }
    (hit.length ? out.ambiguous : out.unknown).push(shown);
  }
  // Seat letters later in the text: only letters that are a seat here, and never a stray report.
  if (!strict && parseText && seats.length > 2) {
    for (const letter of inlineLetters(text)) {
      const seat = seats.find((s) => slotLetter(s.slot) === letter);
      if (seat && seat.id !== me) picked.add(seat.id);
    }
  }
  // Everyone, or a room of two, is the same as no mention at all: nothing is stored.
  if (!out.everyone && seats.length > 2) out.ids = seats.filter((s) => picked.has(s.id)).map((s) => s.id);
  return out;
}

/** The fields of a message event's payload a mention check reads. */
interface MentionEvent {
  type: string;
  payload: unknown;
}

/** The ids a message event's payload names (`mentions`), or none. */
export function mentionsOf(e: MentionEvent): string[] {
  if (e.type !== 'message') return [];
  const m = (e.payload as { mentions?: unknown } | null)?.mentions;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Whether every one of `events` is a message addressed to seats other than `meId`: a seat that runs
 * on its own may then hold its turn. False for no events, and for any event of another kind.
 */
export function forOthersOnly(meId: string, events: readonly MentionEvent[]): boolean {
  if (!events.length) return false;
  return events.every((e) => {
    const ids = mentionsOf(e);
    return ids.length > 0 && !ids.includes(meId);
  });
}

/** Letters joined for a sentence: "C", "C and D", "B, C and D". */
export function lettersText(letters: readonly string[]): string {
  if (letters.length <= 1) return letters.join('');
  return `${letters.slice(0, -1).join(', ')} and ${letters[letters.length - 1]}`;
}
