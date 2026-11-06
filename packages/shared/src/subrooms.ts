/**
 * Sub-rooms: a room's lead opens a separate room, linked to this one,
 * for part of the work that a separate group of agents does and the rest of the room need not
 * read. A question for one seat is an @mention, never a sub-room.
 *
 * What keeps them rare, all of it on at once:
 * - Off unless the owner set `subrooms` at create: `ask` (the owner opens or refuses each one,
 *   the default once ticked) or `auto` (opened at once, for unattended runs).
 * - Only the room's lead is offered `open_room`; a room with no lead offers it to nobody.
 * - A reason (`why`, one line) on every one, which the owner reads and the recap prints.
 * - At most `PARLEY_SUBROOMS_MAX` children a room (2 unless the operator says), one level deep.
 * - Its message budget comes out of the parent's: half of what is left at most, and none while
 *   fewer than `SUBROOM_MIN_LEFT` remain. So a room with sub-rooms spends no more than its owner gave.
 * - One proposal waiting at a time, ten quiet minutes after a refusal, and half an hour before an
 *   unanswered proposal lapses.
 *
 * No zod here: the web imports it.
 */
import { lineClip, LINE_BREAK, oneLine, ROLE_MAX } from './text.js';

export const SUBROOM_STATES = ['proposed', 'opened', 'refused', 'expired'] as const;
export type SubroomState = (typeof SUBROOM_STATES)[number];

/** The reason a lead gives, one line. */
export const SUBROOM_WHY_MAX = 200;
export const SUBROOM_WHY_MIN = 8;
/** The child's title, as a room's (`CreateSessionInput.title`). */
export const SUBROOM_TITLE_MAX = 120;
/** The child's shared brief, which its seats read first. */
export const SUBROOM_BRIEF_MAX = 8000;
/** The `seats` text: `Name: role; Name: role`. */
export const SUBROOM_SEATS_TEXT_MAX = 2000;
/** A seat's name in the child, as any seat's. */
export const SUBROOM_SEAT_NAME_MAX = 60;
/** The fewest messages a parent must have left before any of them can go to a child. */
export const SUBROOM_MIN_LEFT = 20;
/** How long a refusal holds the next proposal back. */
export const SUBROOM_REFUSAL_COOLDOWN_MS = 10 * 60_000;
/** How long a proposal waits for the owner before it lapses. */
export const SUBROOM_PROPOSAL_TTL_MS = 30 * 60_000;
/** The children a room may have, opened and waiting together, unless the operator says otherwise. */
export const SUBROOMS_DEFAULT = 2;
export const SUBROOMS_FLOOR = 1;
export const SUBROOMS_LIMIT = 6;
/** The longest refusal reason the owner gives. */
export const SUBROOM_REASON_MAX = 500;

/** One seat of a planned sub-room. */
export interface SubroomSeat {
  name: string;
  role?: string;
}

/** What the lead asked for: the child's setup, before Crossroom fits its budget. */
export interface SubroomPlan {
  title: string;
  brief: string;
  seats: SubroomSeat[];
  /** The budget the lead asked for, or null for the default. */
  budget: number | null;
  /** The lead takes a seat in the child too. */
  join: boolean;
}

/** A seat link of an opened child, handed to the lead once. */
export interface SubroomLink {
  name: string;
  /** The seat's letter in the child. */
  slot: string;
  url: string;
  /** The lead's own seat, with `join=1`. */
  you?: true;
}

/** What a finished child reported back: the close-outs of its seats, gathered. */
export interface SubroomReport {
  outcome: string | null;
  summaries: string[];
  decisions: string[];
  actions: string[];
  open: string[];
}

/** One sub-room as the owner and the lead see it. */
export interface SubroomView {
  id: string;
  state: SubroomState;
  title: string;
  why: string;
  seats: SubroomSeat[];
  /** The child's budget: what it was given once opened, what it would be given before. */
  budget: number;
  join: boolean;
  proposedAt: string;
  decidedAt: string | null;
  /** When a waiting proposal lapses. */
  expiresAt: string | null;
  childId: string | null;
  /** The child's status once opened, `deleted` once it is gone. */
  childStatus: 'open' | 'active' | 'ended' | 'deleted' | null;
  /** The owner's reason, for a refusal that gave one. */
  reason: string | null;
  /** What the child reported once it ended. */
  report: SubroomReport | null;
}

/** What `open_room` answers. */
export interface OpenRoomData {
  id: string;
  state: 'proposed' | 'opened';
  title: string;
  seats: number;
  budget: number;
  /** The parent's messages left after this child's share is taken. */
  remaining: number;
  childId?: string;
  /** For a proposal: when it lapses unanswered. */
  expiresAt?: string;
  /** For a room opened at once: its seat links, handed now and never again. */
  links?: SubroomLink[];
}

/** What `subrooms` answers. */
export interface SubroomsData {
  mode: 'ask' | 'auto';
  max: number;
  /** The parent's messages left. */
  remaining: number;
  children: Array<SubroomView & { links?: SubroomLink[] }>;
}

/** `subroom_ended`'s payload, sealed in the parent. */
export interface SubroomEndedPayload {
  id: string;
  childId: string;
  title: string;
  outcome: string | null;
  /** Each finished seat's summary. */
  summaries: string[];
  decisions: string[];
  actions: string[];
  open: string[];
  /** Every seat of the child finished, rather than the room being ended for it. */
  finished: boolean;
}

/** `session_created.subroomOf` in a child: what its seats are told about where it came from. */
export interface SubroomOrigin {
  parentId: string;
  parentTitle: string;
  /** The lead that opened it, by name. */
  by: string;
  why: string;
}

/**
 * The `seats` text read into seats: items separated by `;` or line breaks, each `Name` or
 * `Name: role`. A refusal names what is wrong, in Crossroom's words.
 */
export function parseSubroomSeats(text: string): { seats: SubroomSeat[] } | { error: string } {
  if (typeof text !== 'string' || text.length > SUBROOM_SEATS_TEXT_MAX) return { error: `seats is at most ${SUBROOM_SEATS_TEXT_MAX} characters.` };
  const seats: SubroomSeat[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(new RegExp(`;|${LINE_BREAK.source}`))) {
    const item = oneLine(raw);
    if (!item) continue;
    const colon = item.indexOf(':');
    const name = oneLine(colon < 0 ? item : item.slice(0, colon));
    const role = colon < 0 ? '' : oneLine(item.slice(colon + 1));
    if (!name) return { error: 'Each seat in seats needs a name before its ":".' };
    if (name.length > SUBROOM_SEAT_NAME_MAX) return { error: `A seat's name is at most ${SUBROOM_SEAT_NAME_MAX} characters.` };
    if (role.length > ROLE_MAX) return { error: `A seat's role is at most ${ROLE_MAX} characters.` };
    const key = name.toLowerCase();
    if (seen.has(key)) return { error: 'Each seat in seats needs a name of its own.' };
    seen.add(key);
    seats.push(role ? { name, role } : { name });
  }
  return { seats };
}

/** The reason, as the owner and the recap read it: one line, at most `SUBROOM_WHY_MAX`. */
export const subroomWhy = (why: string) => lineClip(why, SUBROOM_WHY_MAX);

/** How a child's budget is fitted: what the lead asked for (or the default), at most half of what the parent has left. */
export function subroomBudget(asked: number | null, defaultFor: number, remaining: number): number {
  const half = Math.floor(Math.max(0, remaining) / 2);
  const want = asked !== null && Number.isSafeInteger(asked) && asked > 0 ? asked : defaultFor;
  return Math.max(0, Math.min(want, half));
}

/** The words for a state, as the owner reads them. */
export const SUBROOM_STATE_WORDS: Readonly<Record<SubroomState, string>> = {
  proposed: 'waiting for the owner',
  opened: 'opened',
  refused: 'refused',
  expired: 'lapsed unanswered',
};
