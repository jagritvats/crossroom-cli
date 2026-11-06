/**
 * How many seats a room may hold on this instance: six unless the operator sets
 * `PARLEY_ROOM_SEATS_MAX`, and never more than the seat letters (`ROOM_SEATS_LIMIT`, twelve).
 *
 * The schemas are bounded by the ceiling, because they are built when a module loads; the cap is
 * checked where a room is made or grows (the server's `createSession` and `addSeat`), where a playbook's
 * run starts (`seatLimitRefusal`), and reported by `/api/features` so the web offers no
 * more seats than will be accepted.
 *
 * Module-wide, like the server's flag overrides: it is the instance's, and `buildApp` binds it
 * (`roomSeatsMax` in `HttpDeps`), so a test sets it without touching the environment. Nothing
 * bound, the environment decides. This module imports nothing of the server, so the server's core can read it.
 */
import { ROOM_SEATS_DEFAULT, ROOM_SEATS_FLOOR, ROOM_SEATS_LIMIT, seatCapText } from '@parley/shared/text';

export const ROOM_SEATS_ENV = 'PARLEY_ROOM_SEATS_MAX';

/**
 * The cap a raw setting asks for: a whole number, clamped to 2..12. Empty or absent is the default;
 * anything that is not a whole number warns and falls back to the default, rather than stopping a
 * server for a typo in its environment.
 */
export function roomSeatsMaxFrom(raw: string | undefined | null, warn: (line: string) => void = (l) => console.warn(l)): number {
  const v = String(raw ?? '').trim();
  if (!v) return ROOM_SEATS_DEFAULT;
  if (!/^\d+$/.test(v)) {
    warn(`${ROOM_SEATS_ENV}=${JSON.stringify(v.slice(0, 40))} is not a whole number; rooms seat up to ${ROOM_SEATS_DEFAULT} agents.`);
    return ROOM_SEATS_DEFAULT;
  }
  const n = Number(v);
  const clamped = Math.min(ROOM_SEATS_LIMIT, Math.max(ROOM_SEATS_FLOOR, n));
  if (clamped !== n) warn(`${ROOM_SEATS_ENV}=${v} is outside ${ROOM_SEATS_FLOOR} to ${ROOM_SEATS_LIMIT}; rooms seat up to ${clamped} agents.`);
  return clamped;
}

let bound: number | null = null;

/** Bind this instance's cap (`buildApp`), clamped like the environment's; null unbinds it. */
export function bindRoomSeatsMax(n: number | null): void {
  bound = n === null ? null : Math.min(ROOM_SEATS_LIMIT, Math.max(ROOM_SEATS_FLOOR, Math.trunc(n)));
}

/** The most seats a room holds on this instance. */
export function roomSeatsMax(): number {
  return bound ?? roomSeatsMaxFrom(process.env[ROOM_SEATS_ENV], () => {});
}

/** Why a room of `n` seats is past this instance's cap, or null. */
export function seatCapRefusal(n: number): string | null {
  const max = roomSeatsMax();
  return n > max ? seatCapText(max) : null;
}
