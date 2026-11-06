/**
 * What `GET /api/seat/e2ee-keys` answers a runner for one seat (`seatKeys` on the
 * relay): the room's wrapped keys and the seat's structure, which the runner's end-to-end egress
 * opens (runner/e2ee-egress.ts). Ciphertext and structure only.
 */
export interface SeatKeysView {
  room: string;
  /** Whether the room is end to end: the seat page refuses such a room (409), so a runner asks here. */
  e2ee: boolean;
  /**
   * The seat itself, structure only, in the shape the seat page gives a runner's dispatch check
   * (check 8, runner/dispatch.ts): which the seat page cannot answer for an end-to-end room. The
   * room's `status` beside it.
   */
  status: string;
  seat: { id: string; sessionId: string; kind: string; finishedAt: string | null; leftAt: string | null; standingLabel: string | null };
  /** Null for a room in no end-to-end project. */
  project: string | null;
  epoch: number;
  /** The room's key check (`sessions.e2ee_check`), so a runner knows the key it opened is this room's. */
  check: string | null;
  roomKeys: { holder: string; wrapped: string }[];
  /** The project key wrapped to this seat's runner, every epoch it was, while the runner is authorised. */
  projectKeys: { epoch: number; recipient: string; wrapped: string }[];
  chain: { epoch: number; wrapped: string }[];
}
