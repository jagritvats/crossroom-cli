/**
 * `crossroom rooms --watch [--json] [--interval <s>]`: the rooms this computer holds keys for, and
 * which of them need their person, read again every few seconds and printed each time that changes.
 * It is what a desktop's bar reads (the Omarchy plugin runs it once and reads its lines), so one
 * process holds the owner tokens and nothing else ever sees them: no token goes on a command line,
 * into a line printed here, or into a notice.
 *
 * - **What it asks.** `POST /api/sessions/lookup` for every room (its state and open questions to the
 *   owner), then, for each live room, the seats' liveness (`/liveness`, small) on every pass and the
 *   owner's snapshot (`GET /api/sessions/:id`, for when each seat last called in) every
 *   `SNAPSHOT_EVERY` passes, since a seat stalls only after two minutes.
 * - **What needs you.** A question an agent put to you (`yourTurn`), a seat waiting on its own user to
 *   approve a step (`approval`) or answer it (`asking`), and a seat that stalled: something waits
 *   for it, it is not listening, and it has been quiet for `STALL_AFTER_S` (the web's rule, stall.ts).
 *   A seat that said it stepped away (`away`) is shown but needs nobody.
 * - **What it prints.** Room ids and states, seat letters and counts. The title is the one text a
 *   participant may have written (a quick room takes an agent's first line), so it goes through
 *   `line`: no control character, no bidi override, one line.
 */
import { createHash } from 'node:crypto';
import type { SeatLiveness } from '@parley/shared';
import { firstLine, slotLetter } from '@parley/shared/text';
import { type KnownSeat, knownSeats, type SavedRoom, savedRooms, Usage, text } from '../cli.js';
import { line } from './project-pick.js';

/** How long a seat may leave what waits for it before it reads as stalled (the web's `STALL_AFTER_S`). */
export const STALL_AFTER_S = 120;
/** Live rooms read closely on each pass, the latest first. Older live rooms still show their questions. */
export const CLOSE_READ_MAX = 12;
/** The snapshot is read on every this-many passes, and on the first. */
const SNAPSHOT_EVERY = 4;
/** The default pass, and the bounds `--interval` takes. */
export const INTERVAL_S = { default: 20, min: 5, max: 600 };

export type RoomStateName = 'live' | 'open' | 'ended' | 'gone' | 'unknown';

export interface RoomState {
  id: string;
  /** The id's first eight characters, as `crossroom open <short>` takes it. */
  short: string;
  title: string;
  /** The instance's host, for a list that holds rooms on more than one. */
  host: string;
  state: RoomStateName;
  /** Questions agents put to you that are still open. */
  yourTurn: number;
  /** Seats waiting on their own user, by letter. */
  approval: string[];
  asking: string[];
  /** Seats that said they stepped away. Needs nobody. */
  away: string[];
  /** Seats that went quiet with something waiting for them. */
  stalled: string[];
  lastActivityAt: string | null;
  /** Any of the above but `away`. */
  needsYou: boolean;
}

/**
 * A seat an agent on this computer took in someone's room (the Crossroom plugin records each one,
 * `crossroom seats` lists them): the joined side of what a bar shows. Never the seat's link, which
 * is the seat's only credential: `key` names it, a digest of the link that opens nothing.
 */
export interface SeatState {
  key: string;
  title: string;
  /** The seat's letter and the name its agent took, when the room says. */
  letter: string;
  name: string;
  room: 'live' | 'ended' | 'unreachable';
  /** Events waiting that its agent has not been shown yet. */
  pending: number;
  /** The folder its agent works in, by its last name only. */
  dir: string;
  /** Whether a Claude Code or Codex session holds it now. */
  held: boolean;
  at: string;
}

/** The name a seat goes by outside this process: a digest of its link, never the link. */
export const seatKey = (link: string): string => createHash('sha256').update(link).digest('hex').slice(0, 12);

/** One recorded seat, kept to what may leave this process. */
export function seatRow(s: KnownSeat): SeatState | null {
  if (s.room === 'gone') return null;
  return {
    key: seatKey(s.seat),
    title: line(firstLine(s.title ?? '', 80)),
    letter: s.seatLetter && /^[A-L]$/.test(s.seatLetter) ? s.seatLetter : '',
    name: line(firstLine(s.seatName ?? '', 40)),
    room: s.room,
    pending: Math.max(0, Number(s.pending) || 0),
    // Either separator: a seat recorded on Windows names its folder with backslashes.
    dir: s.cwd ? line(s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '') : '',
    held: !!s.session,
    at: s.at,
  };
}

/** The seats `rooms --watch` reports, at most this many, likeliest to matter first. */
export const SEATS_SHOWN = 12;

export interface RoomsState {
  type: 'rooms';
  at: string;
  rooms: RoomState[];
  /** Rooms that are live or waiting for a seat. */
  live: number;
  /** Rooms that need you. */
  needsYou: number;
  /** Seats agents on this computer took in rooms, yours or not. */
  seats: SeatState[];
}

interface SnapshotSeat {
  id: string;
  slot: number;
  kind?: string;
  joinedAt?: string | null;
  finishedAt?: string | null;
  leftAt?: string | null;
  lastSeenAt?: string | null;
}

/** What a seat waits on, from its liveness and its row: one word or null. */
export function seatNeed(seat: SnapshotSeat, why: Partial<SeatLiveness> | undefined, ended: boolean, now: number): 'approval' | 'asking' | 'away' | 'stalled' | null {
  if (ended || !why || seat.finishedAt || seat.leftAt) return null;
  const kind = why.attention?.kind;
  if (kind === 'approval') return 'approval';
  if (kind === 'question' || why.askingUser) return 'asking';
  if (kind === 'away') return 'away';
  if (seat.kind !== 'attached' || !seat.joinedAt || !seat.lastSeenAt) return null;
  if (why.listening || !why.unseen) return null;
  const secs = (now - Date.parse(seat.lastSeenAt)) / 1000;
  return Number.isFinite(secs) && secs >= STALL_AFTER_S ? 'stalled' : null;
}

/** A JSON answer to a request that may carry an owner token: never through a redirect, since fetch keeps the header across one. */
async function getJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const res = await fetchImpl(url, { ...init, redirect: 'error' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

const owner = (room: SavedRoom) => ({ 'x-parley-owner': room.owner, accept: 'application/json' });

const hostOf = (base: string): string => {
  try {
    return new URL(base).host;
  } catch {
    return '';
  }
};

/** Reads the rooms again, keeping each live room's last snapshot between passes. */
export class RoomsReader {
  private pass = 0;
  private readonly seats = new Map<string, SnapshotSeat[]>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly rooms: () => SavedRoom[] = savedRooms,
    private readonly now: () => number = () => Date.now(),
    private readonly joined: () => Promise<KnownSeat[]> = () => knownSeats(),
  ) {}

  async read(): Promise<RoomsState> {
    const rooms = this.rooms().filter((r) => !r.pool);
    const found = new Map<string, { status: string; attention?: { yourTurn?: number; lastActivityAt?: string } }>();
    const reached = new Set<string>();
    for (const base of new Set(rooms.map((r) => r.base))) {
      const mine = rooms.filter((r) => r.base === base);
      for (let i = 0; i < mine.length; i += 50) {
        try {
          const list = (await getJson(this.fetchImpl, `${base}/api/sessions/lookup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ rooms: mine.slice(i, i + 50).map((r) => ({ id: r.id, owner: r.owner })) }),
          })) as Array<{ id: string; status: string; attention?: { yourTurn?: number; lastActivityAt?: string } }>;
          for (const s of list) found.set(s.id, s);
          reached.add(base);
        } catch {
          /* not reachable now: its rooms read as unknown */
        }
      }
    }
    const fresh = this.pass++ % SNAPSHOT_EVERY === 0;
    const now = this.now();
    const out: RoomState[] = [];
    let closeReads = 0;
    for (const r of rooms) {
      const s = found.get(r.id);
      const state: RoomStateName = s ? (s.status === 'ended' ? 'ended' : s.status === 'open' ? 'open' : 'live') : reached.has(r.base) ? 'gone' : 'unknown';
      const row: RoomState = {
        id: r.id,
        short: r.id.slice(0, 8),
        title: line(firstLine(r.title ?? '', 80)),
        host: hostOf(r.base),
        state,
        yourTurn: Number(s?.attention?.yourTurn ?? 0) || 0,
        approval: [],
        asking: [],
        away: [],
        stalled: [],
        lastActivityAt: s?.attention?.lastActivityAt ?? null,
        needsYou: false,
      };
      if ((state === 'live' || state === 'open') && closeReads < CLOSE_READ_MAX) {
        closeReads++;
        const room = `${r.base}/api/sessions/${encodeURIComponent(r.id)}`;
        try {
          if (fresh || !this.seats.has(r.id)) {
            const snap = (await getJson(this.fetchImpl, room, { headers: owner(r) })) as { participants?: SnapshotSeat[] };
            this.seats.set(r.id, (snap.participants ?? []).filter((p) => typeof p.id === 'string' && typeof p.slot === 'number'));
          }
          const live = (await getJson(this.fetchImpl, `${room}/liveness`, { headers: owner(r) })) as SeatLiveness[];
          const byId = new Map((Array.isArray(live) ? live : []).map((l) => [l.participantId, l]));
          for (const seat of [...(this.seats.get(r.id) ?? [])].sort((a, b) => a.slot - b.slot)) {
            const need = seatNeed(seat, byId.get(seat.id), false, now);
            if (need) row[need].push(slotLetter(seat.slot));
          }
        } catch {
          /* this pass reads only what the lookup said */
        }
      } else this.seats.delete(r.id);
      row.needsYou = row.yourTurn > 0 || row.approval.length > 0 || row.asking.length > 0 || row.stalled.length > 0;
      out.push(row);
    }
    let seats: SeatState[] = [];
    try {
      seats = (await this.joined())
        .map(seatRow)
        .filter((x): x is SeatState => !!x)
        .slice(0, SEATS_SHOWN);
    } catch {
      /* the seats file unreadable: report rooms only */
    }
    return {
      type: 'rooms',
      at: new Date(now).toISOString(),
      seats,
      rooms: out,
      live: out.filter((r) => r.state === 'live' || r.state === 'open').length,
      needsYou: out.filter((r) => r.needsYou).length,
    };
  }
}

/** What changed is what is printed: the same rooms in the same state print nothing. */
export const sameState = (a: RoomsState | null, b: RoomsState): boolean =>
  !!a &&
  JSON.stringify(a.rooms.map(({ lastActivityAt, ...r }) => r)) === JSON.stringify(b.rooms.map(({ lastActivityAt, ...r }) => r)) &&
  JSON.stringify(a.seats) === JSON.stringify(b.seats);

/** The readable form: one line for the count, one per room that needs you. */
export function stateText(s: RoomsState): string {
  const head = `${s.live} live room${s.live === 1 ? '' : 's'}; ${s.needsYou ? `${s.needsYou} need${s.needsYou === 1 ? 's' : ''} you` : 'nothing needs you'}.`;
  const why = (r: RoomState) =>
    [
      r.yourTurn ? `your turn (${r.yourTurn})` : '',
      r.approval.length ? `${r.approval.join(', ')} waiting for approval` : '',
      r.asking.length ? `${r.asking.join(', ')} asking its user` : '',
      r.stalled.length ? `${r.stalled.join(', ')} stalled` : '',
    ]
      .filter(Boolean)
      .join('; ');
  return [head, ...s.rooms.filter((r) => r.needsYou).map((r) => `  ${r.short}  ${r.title.slice(0, 40)}: ${why(r)}`)].join('\n');
}

/** `--interval`, in seconds, within its bounds. */
export function intervalOf(raw: unknown): number {
  if (raw === undefined) return INTERVAL_S.default;
  const s = raw === true ? undefined : text(raw as string | undefined);
  const n = s !== undefined && /^\d{1,4}$/.test(s) ? Number(s) : Number.NaN;
  if (!(n >= INTERVAL_S.min && n <= INTERVAL_S.max)) throw new Usage(`--interval takes seconds, from ${INTERVAL_S.min} to ${INTERVAL_S.max}.`);
  return n;
}

export interface WatchRoomsOptions {
  json: boolean;
  intervalS: number;
  reader?: RoomsReader;
  write?: (s: string) => void;
  signal?: AbortSignal;
  /** Passes before it returns; unbounded when absent (tests set it). */
  passes?: number;
}

/** Read and print until stopped. Answers how many states it printed. */
export async function watchRooms(o: WatchRoomsOptions): Promise<number> {
  const reader = o.reader ?? new RoomsReader();
  const write = o.write ?? ((s: string) => process.stdout.write(`${s}\n`));
  let last: RoomsState | null = null;
  let printed = 0;
  for (let pass = 0; o.passes === undefined || pass < o.passes; pass++) {
    if (o.signal?.aborted) break;
    const s = await reader.read();
    if (!sameState(last, s)) {
      write(o.json ? JSON.stringify(s) : stateText(s));
      printed++;
      last = s;
    }
    if (o.passes !== undefined && pass + 1 >= o.passes) break;
    // A ref'd timer: under cli-main's top-level await an unref'd one lets Node exit mid-watch.
    await new Promise<void>((ok) => {
      const t = setTimeout(ok, o.intervalS * 1000);
      o.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        ok();
      }, { once: true });
    });
  }
  return printed;
}

/**
 * A seat's own page (`<origin>/seat#t=<token>`), from its link: what `crossroom seats --open <key>`
 * opens for the person whose agent holds it. Null for a link that is not a seat link, and for an
 * end-to-end room's (its page cannot read the room without the key the helper keeps).
 */
export function seatPageOf(link: string): string | null {
  if (/#.*\be=/.test(link)) return null;
  let u: URL;
  try {
    u = new URL(link.replace(/#.*$/, ''));
  } catch {
    return null;
  }
  const m = /^(.*)\/j\/([A-Za-z0-9_-]{8,200})\/?$/.exec(u.pathname);
  if (!m || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
  return `${u.origin}${m[1]}/seat#t=${encodeURIComponent(m[2]!)}`;
}

/** The recorded seat a key names (`seatKey`), or null. */
export function seatByKey<T extends { seat: string }>(seats: T[], key: string): T | null {
  return /^[0-9a-f]{12}$/.test(key) ? (seats.find((s) => seatKey(s.seat) === key) ?? null) : null;
}
