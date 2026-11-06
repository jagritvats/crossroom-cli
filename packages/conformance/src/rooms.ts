/**
 * The rooms the suite checks, and how it comes by them (`ConformanceCreate`, @parley/shared/protocol):
 * - `quick`: it makes them itself, an ordinary room and, for the end-to-end check, an end-to-end one;
 * - `owner-token`: one room someone made, named by its private link (`/s/<id>#k=<token>`, with
 *   `&e=<key>` for an end-to-end room), and the seat links of it they want used, if any;
 * - `cmd`: a command run once per kind of room it needs, which prints such a room's links.
 *
 * At most `CONFORMANCE_ROOMS_MAX` rooms, at no more than `CONFORMANCE_CREATES_PER_MINUTE`, each
 * marked as a test's (`x-parley-synthetic`) so no count of the server's includes it, and each deleted
 * once the suite is done with it. A room someone handed the suite is theirs: never ended, never
 * deleted.
 *
 * A link is read for its token alone. Whatever address a link names, the token goes back to the URL
 * the suite was given (client.ts), so output a server or a command prints cannot send it elsewhere.
 */
import { CONFORMANCE_CREATES_PER_MINUTE, CONFORMANCE_ROOMS_MAX } from '@parley/shared/protocol';
import { encryptField, generateRoomKey, importRoomKey, isRoomKey, makeCheck } from '@parley/shared/e2ee';
import { type Answer, type Server, sleep } from './client.js';

export type RoomKind = 'plain' | 'e2ee';

export interface Seat {
  id: string;
  slot: number;
  token: string;
}

export interface Room {
  id: string;
  owner: string;
  kind: RoomKind;
  /** The room key, for an end-to-end room: the suite encrypts with it, and never sends it. */
  key: string | null;
  seats: Seat[];
  /** The suite made it (or had it made), so it is the suite's to end and delete. */
  made: boolean;
}

/** How the suite comes by its rooms. */
export type RoomSource =
  | { kind: 'quick' }
  /** The text of the file `--owner-token-file` names: the private link, and any seat links. */
  | { kind: 'owner-token'; text: string }
  /** Runs the command for a room of this kind and answers what it printed. */
  | { kind: 'cmd'; run: (kind: RoomKind) => Promise<string> };

/** Why a check could not have a room: the suite's own words. */
export class NoRoom extends Error {
  constructor(
    message: string,
    /** True when the server or the source simply offers no such room, which skips a check rather than failing it. */
    readonly skip = false,
  ) {
    super(message);
  }
}

const SYNTHETIC = { 'x-parley-synthetic': '1' };
const TOKEN = '[A-Za-z0-9_-]{8,128}';
const OWNER_LINK = new RegExp(`/s/([A-Za-z0-9_-]{4,64})#([^\\s"'<>()\\]]+)`);
const SEAT_LINK = new RegExp(`/j/(${TOKEN})(?![A-Za-z0-9_-])`, 'g');

/** A fragment's `k=…&e=…`, each value decoded; a malformed escape leaves the value as it stands. */
function fragment(f: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of f.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    let v = part.slice(eq + 1);
    try {
      v = decodeURIComponent(v);
    } catch {
      /* kept as it stands */
    }
    out.set(part.slice(0, eq), v);
  }
  return out;
}

/** The room a private link names, and the seat tokens in the same text: tokens only, never addresses. */
export function readLinks(text: string): { id: string; owner: string; key: string | null; seatTokens: string[] } | null {
  const m = OWNER_LINK.exec(text);
  if (!m) return null;
  const params = fragment(m[2]!);
  const owner = params.get('k') ?? '';
  if (!new RegExp(`^${TOKEN}$`).test(owner)) return null;
  const e = params.get('e') ?? null;
  const seatTokens = [...new Set([...text.matchAll(SEAT_LINK)].map((x) => x[1]!))];
  return { id: m[1]!, owner, key: e && isRoomKey(e) ? e : null, seatTokens };
}

/** Keeps the suite to its room budget and its rate, and remembers what it must clean up. */
export class Rooms {
  private readonly creates: number[] = [];
  readonly made: Room[] = [];
  /** Rooms the suite made and deleted, kept for the identical-404 check's last pairs. */
  readonly deleted: Room[] = [];
  /** Rooms the suite made whose deletion the server refused. */
  readonly left: string[] = [];
  private readonly cache = new Map<RoomKind, Promise<Room>>();
  /** How many rooms a source was asked for (each `cmd` run counts, whatever it printed). */
  asked = 0;

  constructor(
    private readonly server: Server,
    private readonly source: RoomSource,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  /** The room of this kind, made or found once and kept for every check that needs it. */
  get(kind: RoomKind): Promise<Room> {
    let p = this.cache.get(kind);
    if (!p) {
      p = this.obtain(kind);
      this.cache.set(kind, p);
    }
    return p;
  }

  /** Whether a room of this kind was asked for, and came: for a check that uses one only if it exists. */
  existing(kind: RoomKind): Promise<Room | null> {
    const p = this.cache.get(kind);
    return p ? p.catch(() => null) : Promise.resolve(null);
  }

  private async obtain(kind: RoomKind): Promise<Room> {
    if (this.source.kind === 'owner-token') {
      const links = readLinks(this.source.text);
      if (!links) throw new NoRoom('the file holds no private link of the form /s/<id>#k=<token>');
      const has: RoomKind = links.key ? 'e2ee' : 'plain';
      if (has !== kind) throw new NoRoom(`the room given is ${has === 'e2ee' ? 'an end-to-end room' : 'an ordinary room'}, and this check needs the other kind`, true);
      return await this.adopt(links, kind, false);
    }
    if (this.source.kind === 'quick' && kind === 'e2ee') {
      const features = await this.server.call('GET', '/api/features');
      if (features.status === 200 && features.json?.e2ee === false) throw new NoRoom('the server says it opens no end-to-end rooms', true);
    }
    await this.budget();
    if (this.source.kind === 'cmd') {
      const out = await this.source.run(kind);
      const links = readLinks(out);
      if (!links) throw new NoRoom(`the command printed no private link for ${kind === 'e2ee' ? 'an end-to-end' : 'an ordinary'} room`, kind === 'e2ee');
      if (kind === 'e2ee' && !links.key) {
        // The command made an ordinary room where an end-to-end one was asked for: it is still the suite's to delete.
        const stray: Room = { id: links.id, owner: links.owner, kind: 'plain', key: null, seats: [], made: true };
        this.made.push(stray);
        throw new NoRoom('the command printed an ordinary room where an end-to-end one was asked for', true);
      }
      return await this.adopt(links, kind, true);
    }
    return kind === 'plain' ? await this.quick() : await this.e2ee();
  }

  /** Waits until a create would stay within the rate, and refuses one beyond the budget. */
  private async budget(): Promise<void> {
    if (this.asked >= CONFORMANCE_ROOMS_MAX) throw new NoRoom(`the suite makes at most ${CONFORMANCE_ROOMS_MAX} rooms`);
    for (;;) {
      const recent = this.creates.filter((t) => this.now() - t < 60_000);
      if (recent.length < CONFORMANCE_CREATES_PER_MINUTE) break;
      await this.wait(60_000 - (this.now() - recent[0]!) + 10);
    }
    this.asked++;
    this.creates.push(this.now());
  }

  private created(a: Answer, kind: RoomKind, key: string | null): Room {
    const j = a.json;
    if (a.status !== 201 || !j?.session?.id || typeof j.ownerToken !== 'string' || !Array.isArray(j.participants))
      throw new NoRoom(`creating ${kind === 'e2ee' ? 'an end-to-end' : 'an ordinary'} room answered ${a.status}`, kind === 'e2ee' && a.status === 403);
    const room: Room = {
      id: String(j.session.id),
      owner: j.ownerToken,
      kind,
      key,
      seats: j.participants.map((p: any) => ({ id: String(p.id), slot: Number(p.slot), token: String(p.inviteToken) })),
      made: true,
    };
    this.made.push(room);
    return room;
  }

  private async quick(): Promise<Room> {
    const a = await this.server.call('POST', '/api/sessions/quick?format=json', {
      headers: SYNTHETIC,
      body: { title: 'Crossroom conformance', brief: 'A room `crossroom conformance` made to check this server. It deletes the room when it is done.' },
    });
    return this.created(a, 'plain', null);
  }

  private async e2ee(): Promise<Room> {
    const key = generateRoomKey();
    const k = await importRoomKey(key);
    const a = await this.server.call('POST', '/api/sessions', {
      headers: SYNTHETIC,
      body: {
        title: await encryptField(k, 'session.title', 'Crossroom conformance (end to end)'),
        sharedBrief: await encryptField(k, 'session.brief', 'A room `crossroom conformance` made to check the end-to-end refusals. It deletes the room when it is done.'),
        participants: [
          { name: 'Seat A', kind: 'attached' },
          { name: 'Seat B', kind: 'attached' },
        ],
        e2ee: { check: await makeCheck(k) },
      },
    });
    return this.created(a, 'e2ee', key);
  }

  /** A room from its links: its seats from the owner's snapshot, each seat's token given, or fetched anew in a room the suite made. */
  private async adopt(links: NonNullable<ReturnType<typeof readLinks>>, kind: RoomKind, made: boolean): Promise<Room> {
    const room: Room = { id: links.id, owner: links.owner, kind, key: links.key, seats: [], made };
    if (made) this.made.push(room);
    const snap = await this.server.call('GET', `/api/sessions/${encodeURIComponent(room.id)}`, { headers: { 'x-parley-owner': room.owner } });
    if (snap.status !== 200 || !Array.isArray(snap.json?.participants)) throw new NoRoom(`the room's owner link did not open it (${snap.status})`);
    const bySlot = new Map<number, string>(snap.json.participants.map((p: any) => [Number(p.slot), String(p.id)]));
    const known = new Map<number, string>();
    for (const token of links.seatTokens) {
      const st = await this.server.call('GET', `/j/${token}/status?format=json`, { logPath: '/j/<seat>/status?format=json' });
      const slot = st.status === 200 ? Number(st.json?.data?.me?.slot) : Number.NaN;
      if (bySlot.has(slot)) known.set(slot, token);
    }
    for (const [slot, id] of [...bySlot].sort((x, y) => x[0] - y[0])) {
      let token = known.get(slot);
      if (!token) {
        // A room the suite was handed: it uses the seats it was given links to, and never takes another
        // by replacing its link, which would cut off the agent holding it for good.
        if (!made) continue;
        // No link for this seat was given: the owner replaces it, which is the owner's to do.
        const r = await this.server.call('POST', `/api/sessions/${encodeURIComponent(room.id)}/participants/${encodeURIComponent(id)}/link`, {
          headers: { 'x-parley-owner': room.owner },
        });
        if (r.status !== 200 || typeof r.json?.inviteToken !== 'string') throw new NoRoom(`a link for seat ${slot} could not be had (${r.status})`);
        token = r.json.inviteToken as string;
      }
      room.seats.push({ id, slot, token });
    }
    return room;
  }

  /** Deletes every room the suite made, and remembers which the server would not delete. */
  async cleanup(): Promise<void> {
    for (const room of this.made) {
      const a = await this.server.call('DELETE', `/api/sessions/${encodeURIComponent(room.id)}`, { headers: { 'x-parley-owner': room.owner } }).catch(() => null);
      if (a?.status === 200) this.deleted.push(room);
      else this.left.push(room.id);
    }
  }
}
