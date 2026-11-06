/**
 * `crossroom watch <room> [--json]`: a room's event log as it is written, read from the owner's own
 * stream (`GET /api/sessions/:id/events`, the owner token in `x-parley-owner`), the pull side of the
 * webhooks a room's owner sets, for a program that would rather read than be
 * called. `--json` prints one event per line (NDJSON), exactly as the stream sends it, the owner's
 * view: an end-to-end room's content arrives as its envelopes. Without it, one readable line an
 * event, every control character and bidi override blanked (`line` in project-pick.ts), since
 * participants wrote what it prints.
 *
 * - **The room.** One `crossroom ask` or `crossroom new` opened here (its owner token is in the local
 *   store, `pickRoom`), or `--owner-token-file <file>` (or `-` for stdin) holding the room's private
 *   link (`/s/<id>#k=<token>`), never a token in argv where any process on the machine can read it.
 * - **The token** goes only to the room's own origin, as a header, and no request follows a redirect.
 *   It is never printed.
 * - **Ends** after the room's `session_ended` (with `--follow`, keeps reading: the owner may still
 *   rule on a claim). A dropped stream is opened again after the last event read, five times in a
 *   row at most. 401, 404 and 410 end it at once: the room is gone or the token does not open it.
 */
import { readFileSync } from 'node:fs';
import type { ParleyEvent } from '@parley/shared';
import { firstLine, slotLetter } from '@parley/shared/text';
import { type Args, pickRoom, Usage, text } from '../cli.js';
import { relayOrigin } from './credentials.js';
import { registerCommand } from './index.js';
import { line } from './project-pick.js';
import { probeStatusProtocol } from '../terminal/probe.js';
import { RoomSignals, Signaller } from '../terminal/room-signals.js';
import { terminalOf } from '../terminal/sequences.js';

/** The most a link file or stdin is read for: one link, never more. */
const READ_CAP = 64 * 1024;
/** How many times in a row a dropped stream is opened again. */
const RETRIES = 5;

export interface WatchTarget {
  base: string;
  id: string;
  owner: string;
}

/** The room a private link names: its origin, its id and its key. Null for anything else. */
export function privateLinkOf(textIn: string): WatchTarget | null {
  const m = /(https?:\/\/[^\s/]+)\/s\/([A-Za-z0-9_-]{4,80})#([^\s]*)/.exec(textIn);
  if (!m) return null;
  const params = new URLSearchParams(m[3]);
  const owner = params.get('k');
  if (!owner) return null;
  return { base: m[1]!, id: m[2]!, owner };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    chunks.push(b);
    size += b.length;
    if (size >= READ_CAP) break;
  }
  return Buffer.concat(chunks).subarray(0, READ_CAP).toString('utf8');
}

async function targetOf(args: Args): Promise<WatchTarget> {
  const file = text(args.flags['owner-token-file']);
  if (args.flags['owner-token-file'] === true) throw new Usage('--owner-token-file names a file holding the room\'s private link, or - for stdin.');
  if (file !== undefined) {
    let body: string;
    try {
      body = file === '-' ? await readStdin() : readFileSync(file).subarray(0, READ_CAP).toString('utf8');
    } catch {
      // Not the file's text, nor the error's: a path someone typed may be a token pasted by mistake.
      throw new Usage('--owner-token-file names a file that could not be read.');
    }
    const t = privateLinkOf(body);
    if (!t) throw new Usage("That file holds no room's private link (…/s/<id>#k=<key>, as Copy private link makes it).");
    return { ...t, base: relayOrigin(t.base) };
  }
  const room = pickRoom(args);
  return { base: room.base, id: room.id, owner: room.owner };
}

/** One SSE frame: its event name and data. */
interface Frame {
  event: string;
  data: string;
}

/** Frames out of a stream's text, as they complete. */
async function* frames(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = 'message';
  let data: string[] = [];
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const raw = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (raw === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = 'message';
          data = [];
        } else if (raw.startsWith('event:')) event = raw.slice(6).trim();
        else if (raw.startsWith('data:')) data.push(raw.slice(5).replace(/^ /, ''));
        nl = buf.indexOf('\n');
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Who acted, by seat letter and name, from the owner's snapshot. */
type Seats = Map<string, { slot: number; name: string }>;

function seatsOf(snapshot: unknown): Seats {
  const out: Seats = new Map();
  const ps = (snapshot as { participants?: Array<{ id?: unknown; slot?: unknown; name?: unknown }> } | null)?.participants;
  for (const p of ps ?? []) if (typeof p.id === 'string' && typeof p.slot === 'number') out.set(p.id, { slot: p.slot, name: typeof p.name === 'string' ? p.name : '' });
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** One readable line for an event: its number, time, kind, who, and a short gist. Participant text, made safe for a terminal. */
export function eventLine(ev: ParleyEvent, seats: Seats): string {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const s = seats.get(ev.actor);
  const who = ev.actor === 'human' ? 'owner' : ev.actor === 'system' ? 'crossroom' : s ? `${slotLetter(s.slot)} ${firstLine(s.name, 40)}` : 'a seat';
  const gist = str(p.text) ?? str(p.title) ?? str(p.what) ?? str(p.summary) ?? str(p.outcome) ?? str(p.key) ?? '';
  const time = typeof ev.createdAt === 'string' ? ev.createdAt.slice(11, 19) : '';
  const head = `#${ev.seq} ${time} ${ev.type} (${line(who)})`;
  return gist ? `${head}: ${line(firstLine(gist, 120))}` : head;
}

export interface WatchOptions {
  json: boolean;
  follow: boolean;
  after: number;
  fetchImpl?: typeof fetch;
  write?: (s: string) => void;
  signal?: AbortSignal;
  /** How long to wait before opening a dropped stream again. */
  retryMs?: number;
  /** Shows the room's state in the terminal (terminal/room-signals.ts): titles, notices, OSC 7501. */
  signals?: Signaller | null;
}

/** Read the room's stream until it ends. Answers how many events it printed. */
export async function watchRoom(t: WatchTarget, o: WatchOptions): Promise<number> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const write = o.write ?? ((s: string) => process.stdout.write(`${s}\n`));
  const room = `${t.base}/api/sessions/${encodeURIComponent(t.id)}`;
  const headers = { 'x-parley-owner': t.owner };
  const refuse = (status: number) => {
    if (status === 401 || status === 404 || status === 410) throw new Usage(`${t.base} has no room ${t.id} that this key opens (it may have been deleted).`);
    throw new Usage(`${t.base} answered ${status} for room ${t.id}.`);
  };
  // The seats' letters and names, for the readable form; `--json` prints events as sent.
  let seats: Seats = new Map();
  if (!o.json) {
    const snap = await fetchImpl(room, { headers: { ...headers, accept: 'application/json' }, redirect: 'error', signal: o.signal });
    if (!snap.ok) refuse(snap.status);
    const body = await snap.json();
    seats = seatsOf(body);
    o.signals?.room.seatsFrom(body);
  }
  let last = o.after;
  let printed = 0;
  let failures = 0;
  for (;;) {
    if (o.signal?.aborted) return printed;
    let res: Response;
    try {
      res = await fetchImpl(`${room}/events?after=${last}`, { headers: { ...headers, accept: 'text/event-stream' }, redirect: 'error', signal: o.signal });
    } catch (e) {
      if (o.signal?.aborted) return printed;
      if (++failures > RETRIES) throw new Usage(`${t.base} did not answer (${(e as Error).message}).`);
      await new Promise((r) => setTimeout(r, o.retryMs ?? 2000));
      continue;
    }
    if (!res.ok || !res.body) refuse(res.status);
    let ended = false;
    for await (const f of frames(res.body!, o.signal)) {
      failures = 0;
      if (f.event === 'ping') continue;
      if (f.event === 'snapshot') {
        if (!o.json) {
          try {
            const body = JSON.parse(f.data);
            seats = seatsOf(body);
            o.signals?.room.seatsFrom(body);
          } catch {}
          // The replay is over: what follows is live, so the room's state shows now, and notices may follow.
          if (o.signals) o.signals.show(o.signals.room.live());
        }
        continue;
      }
      let ev: ParleyEvent;
      try {
        ev = JSON.parse(f.data) as ParleyEvent;
      } catch {
        continue;
      }
      if (typeof ev.seq !== 'number' || ev.seq <= last) continue;
      last = ev.seq;
      // A seat names itself as it joins, after the snapshot this read its names from.
      const joinedAs = ev.type === 'participant_joined' ? (ev.payload as { name?: unknown } | undefined)?.name : undefined;
      const known = seats.get(ev.actor);
      if (typeof joinedAs === 'string' && known) seats.set(ev.actor, { ...known, name: joinedAs });
      write(o.json ? JSON.stringify(ev) : eventLine(ev, seats));
      if (o.signals) o.signals.show(o.signals.room.read(ev));
      printed++;
      if (ev.type === 'session_ended' && !o.follow) {
        ended = true;
        break;
      }
    }
    if (ended || o.signal?.aborted) return printed;
    if (++failures > RETRIES) throw new Usage(`${t.base} kept closing the stream of room ${t.id}.`);
    await new Promise((r) => setTimeout(r, o.retryMs ?? 2000));
  }
}

/**
 * The terminal signals for a watch, or null: only where stdout is a terminal, and never with
 * `--no-signals` or `CROSSROOM_SIGNALS=0`. OSC 7501 reports go only to a terminal that answered
 * the probe (Orca, Rex), since a terminal that doesn't read it has no use for them.
 */
export async function signallerFor(roomId: string, args: Args, env: NodeJS.ProcessEnv = process.env): Promise<Signaller | null> {
  if (!process.stdout.isTTY || args.flags['no-signals'] === true || env.CROSSROOM_SIGNALS === '0') return null;
  const terminal = terminalOf(env);
  const statusProtocol = await probeStatusProtocol();
  return new Signaller(new RoomSignals(roomId), { terminal, statusProtocol, write: (s) => process.stdout.write(s) });
}

registerCommand({
  name: 'watch',
  topic: 'follow',
  usage: 'crossroom watch [<room>] [--json] [--follow]',
  summary: "a room's events as they happen (--json: one per line), until it ends",
  more: [
    { usage: '[--after <seq>] [--owner-token-file <file>|-]', summary: 'start after an event; a room from its private link' },
    { usage: '[--no-signals]', summary: "in a terminal, the room's state shows as its title, notices and Orca's status (CROSSROOM_SIGNALS=0 turns it off)" },
  ],
  order: 35,
  switches: ['follow', 'no-signals'],
  async run(args) {
    const after = text(args.flags.after);
    if (after !== undefined && !/^\d{1,9}$/.test(after)) throw new Usage('--after takes the number of the last event you have read.');
    const target = await targetOf(args);
    const json = args.flags.json === true;
    const signals = json ? null : await signallerFor(target.id, args);
    const stop = () => {
      signals?.stop();
      process.exit(130);
    };
    if (signals) process.once('SIGINT', stop);
    try {
      await watchRoom(target, { json, follow: args.flags.follow === true, after: Number(after ?? 0), signals });
    } finally {
      process.off('SIGINT', stop);
      signals?.stop();
    }
    return 0;
  },
});
