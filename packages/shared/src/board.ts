/**
 * The room board: a small store of named JSON values that a room's
 * seats and its owner read and write, each value with a version, so two agents can agree a plan,
 * a list of owners or a status without passing it back and forth as text.
 *
 * The board belongs to one room. It is sealed with the room's other content, deleted with it, and
 * never read from another room: it is the room's working state, not a memory.
 *
 * Offered only in a room created with `board: true` (`sessions.board`), which an
 * end-to-end room never is. The rules here are the one copy the server, the web app and the
 * renderers share, so this module imports nothing (no zod): the web imports it.
 */

/** The most keys a room's board holds. */
export const BOARD_KEYS_MAX = 200;
/** The longest key, in characters. */
export const BOARD_KEY_MAX = 64;
/** What a key may be made of: letters, digits and `_ . : / -`, so it prints safely anywhere. */
export const BOARD_KEY = /^[A-Za-z0-9_.:/-]{1,64}$/;
/** The largest value, in UTF-8 bytes of its compact JSON text. */
export const BOARD_VALUE_MAX_BYTES = 8 * 1024;
/** The most a room's board holds, in UTF-8 bytes of its values together. */
export const BOARD_ROOM_MAX_BYTES = 256 * 1024;

/** The most writes one seat makes to a room's board: each appends an event to the room's record. */
export const BOARD_WRITES_PER_SEAT = 500;

/** The code a stale write answers with (409), beside the current value and version. */
export const STALE_VERSION = 'STALE_VERSION';

/** One key on the board, as the owner's snapshot and the recap read it. */
export interface BoardEntry {
  key: string;
  /** The value as compact JSON text. */
  value: string;
  /** 1 when created, one more on every write. A key that is not on the board is at version 0. */
  version: number;
  /** The participant id that wrote it last, or `human` for the owner. */
  updatedBy: string;
  updatedAt: string;
  /** The seq of the `board_updated` event that wrote it. */
  updatedSeq: number;
}

/** A key as the `board` operation lists it: who set it is a seat letter, or `owner`. */
export interface BoardRef {
  key: string;
  version: number;
  by: string;
  at: string;
}

/** What the `board` operation answers. */
export interface BoardData {
  /** Every key, without values, when no key was asked for. */
  keys?: BoardRef[];
  /** The key asked for, and its entry, or null when the board holds no such key. */
  key?: string;
  entry?: (BoardRef & { value: string }) | null;
  /** How full the board is. */
  total: { keys: number; bytes: number };
}

/** What `board_set` answers. */
export interface BoardSetData {
  key: string;
  /** The version the key is at now: 0 once deleted. */
  version: number;
  created: boolean;
  deleted: boolean;
  /** Set when nothing changed: the value was already that, or a delete found no such key. */
  unchanged?: boolean;
}

const utf8 = new TextEncoder();
/** The UTF-8 size of a text, as the caps count it. */
export const boardBytes = (text: string) => utf8.encode(text).length;

/** Why a key is refused, or null for a good one. */
export function boardKeyProblem(key: string): string | null {
  if (typeof key !== 'string' || !key) return 'key is required.';
  if (key.length > BOARD_KEY_MAX) return `key is at most ${BOARD_KEY_MAX} characters.`;
  if (!BOARD_KEY.test(key)) return 'key may use letters, digits and _ . : / - only, e.g. "plan" or "owners/api".';
  return null;
}

/**
 * A value as JSON text, made compact: `{ value }` with the text to store, `{ value: null }` for the
 * JSON `null`, which deletes the key, or `{ error }` in words an agent can act on.
 */
export function boardValue(text: string): { value: string | null } | { error: string } {
  if (typeof text !== 'string' || !text.trim()) return { error: 'value is required: JSON text, or null to delete the key.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      error:
        'value must be JSON text: a quoted string ("ship on Friday"), a number, true or false, a list ([1,2]) or an object ({"owner":"B"}). null deletes the key.',
    };
  }
  if (parsed === null) return { value: null };
  const compact = JSON.stringify(parsed);
  const bytes = boardBytes(compact);
  if (bytes > BOARD_VALUE_MAX_BYTES) return { error: `value is ${bytes} bytes as JSON; a key holds at most ${BOARD_VALUE_MAX_BYTES}.` };
  return { value: compact };
}

/** A value laid out for a person to read: indented JSON, or the text itself if it does not parse. */
export function boardPretty(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
