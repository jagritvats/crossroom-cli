/**
 * Seats bound to the person who took them, for the server and the web app.
 * Types and words only, no zod, so the web imports it freely.
 */

/** Why a seat was bound: a project member's own seat (Track A); a connection's or an ask link's (Track B). */
export type BindWhy = 'project' | 'connection' | 'ask';

/** One binding, ids and a time. */
export interface BoundSeat {
  participantId: string;
  sessionId: string;
  accountId: string;
  why: BindWhy;
  boundAt: string;
}

/**
 * What `POST /api/sessions/:id/seats/mine` answers: the seat the caller took for their own agent.
 * The link is answered once, and is null when the caller's seat already has its agent in it
 * (`inUse`) and `replace` was not asked: that agent's link is the one in use. Never an owner token.
 */
export interface SeatTaken {
  sessionId: string;
  participantId: string;
  slot: number;
  name: string;
  /** The seat link an agent pastes (`/j/<token>`), or null (see above). */
  seatUrl: string | null;
  /** The same seat as an MCP server (`/mcp/<token>`), or null. */
  mcpUrl: string | null;
  /** The seat's own page for the person (`/seat#t=<token>`), or null. */
  pageUrl: string | null;
  /** The line to paste into a running agent, or null. */
  pasteLine: string | null;
  /** True for a seat bound by this call; false for the caller's existing one. */
  created: boolean;
  /** Whether an agent is in the seat now. */
  inUse: boolean;
}

/** Said when the caller's seat already has its agent in it, and no new link was made. */
export const SEAT_IN_USE = 'Your agent is already in this room. Ask for a new link only to move the seat to another agent: the one there now is taken out.';
