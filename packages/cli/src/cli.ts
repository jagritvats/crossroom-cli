/**
 * The `crossroom` command: rooms on a Crossroom instance (app.crossroom.dev unless one is named),
 * and your own agents run on this computer into their seats.
 *
 *   crossroom new "<topic>"           open a room, and take a seat or start agents in its seats
 *   crossroom ask <dir> "<question>"  put an agent of yours in another directory on a question
 *   crossroom minutes [<room>]        the recap of a room opened here
 *   crossroom rooms                   those rooms, and how each one stands
 *   crossroom open|end|share [<room>] what the room page's buttons do, from here
 *   crossroom doctor                  what this machine can run
 *
 * Its data lives in `~/.parley` (unless PARLEY_DATA says otherwise). The entry point is
 * cli-main.ts, which checks the Node version before this module can load `node:sqlite`. A build
 * that carries more commands (the server's `serve`) adds them with `addCommands`.
 *
 * Each subcommand is a registered `Command` (commands/index.ts says how to add one); this module
 * holds what they call, reads the arguments, and builds the help from the registry.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TAGLINE } from '@parley/shared/brand';
import { E2EE_REFUSED, helperCommand, RoomCipher } from '@parley/shared/e2ee';
import {
  briefing,
  type OpData,
  type OpName,
  renderBoard,
  renderBoardSet,
  renderContextIndex,
  renderLaneFiled,
  renderLaneItems,
  renderLanePass,
  renderLaneSettings,
  renderLaneUpdated,
  renderToolCalled,
  renderToolDeclared,
  renderToolResult,
  renderOpenRoom,
  renderSubrooms,
  renderClaimed,
  renderDeclined,
  renderFinished,
  renderRecord,
  renderReported,
  renderSubmitted,
  renderWork,
  renderPosition,
  renderRequested,
  renderSay,
  renderShared,
  renderStatus,
  renderWait,
} from '@parley/shared/render';
import { firstLine, slotLetter } from '@parley/shared/text';
// The seat helper's own grammar and link parsing, so `crossroom op` reads its arguments as `crossroom-seat` does.
import { OPS, parseLink, type Io as SeatIo, type SeatLink, parseArgs as seatArgs, UsageError } from '../../seat/src/seat.js';
import { type Command, commandHelpLines, commandSwitches, findCommand, helpLines, helpTopic, knownFlags, overviewLines, suggestFlag, topicLines } from './commands/index.js';
import type { MemoryEntry } from './commands/memory-notes.js';
import { SEAT_FINISHED } from '@parley/shared/protocol';
import { type RunnerOptions, runnerAvailability } from './runners/hosted.js';
import { verifyMinutes } from './signing.js';

declare const __PARLEY_VERSION__: string | undefined;
export const VERSION = typeof __PARLEY_VERSION__ === 'string' ? __PARLEY_VERSION__ : 'dev';
export const DEFAULT_PORT = 4747;


export const dataDir = () => process.env.PARLEY_DATA ?? path.join(os.homedir(), '.parley');

/** Thrown for a mistake the user can fix; `run` prints the message alone, without a stack. */
export class Usage extends Error {}

/** A flag that takes a value was given none. `run` names a misspelt flag instead (`refuseUnknownFlags`). */
export class MissingValue extends Usage {
  constructor(readonly flag: string) {
    super(`--${flag} needs a value.`);
  }
}

// ---------------------------------------------------------------- arguments

export interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
  /**
   * Every value of a flag given more than once, in order (`--deny a --deny b`); `flags` keeps the
   * last. Absent when nothing repeats, so a parse compares equal to one from before it existed.
   */
  values?: Record<string, string[]>;
}

/**
 * Flags that never take a value, with those registered commands declare (`Command.switches`).
 * Every other `--name` takes the next word, or `--name=value`.
 */
const SWITCHES = new Set(['no-open', 'json', 'no-start', 'digest', 'wait', 'help', 'version', 'list', 'print', 'forget']);

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const values: Record<string, string[]> = {};
  const set = (name: string, v: string) => {
    const was = flags[name];
    if (typeof was === 'string') (values[name] ??= [was]).push(v);
    flags[name] = v;
  };
  const declared = commandSwitches();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h') flags.help = true;
    else if (a === '-v') flags.version = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) set(name, a.slice(eq + 1));
      else if (SWITCHES.has(name) || declared.has(name)) flags[name] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new MissingValue(name);
        set(name, v);
        i++;
      }
    } else positional.push(a);
  }
  if (flags.host === CODEX && flags.session === undefined) flags.session = codexSession();
  const command = positional.shift() ?? 'serve';
  return { command, positional, flags, ...(Object.keys(values).length ? { values } : {}) };
}

/**
 * `--host codex`: the command runs inside a Codex session, and that session stands for
 * `--session`. Codex sets CODEX_SESSION_ID in every command it runs, and passes the same id to its
 * hooks as `session_id`, so the plugin's Stop hook finds the seat by it. Codex skills cannot
 * substitute the id into a command the way Claude Code's `${CLAUDE_SESSION_ID}` does, and a
 * command holding `$CODEX_SESSION_ID` is no longer the plain words an approval rule matches.
 * (`serve --host <address>` is the address to listen on, which is never `codex`.)
 */
const CODEX = 'codex';

function codexSession(): string {
  const id = process.env.CODEX_SESSION_ID?.trim();
  if (!id) throw new Usage('--host codex takes the session from CODEX_SESSION_ID, which Codex sets in the commands it runs. It is not set here: run this from inside a Codex session, or pass --session <id>.');
  return id;
}

/**
 * The Codex session a command the Codex rules file runs unasked (`crossroom op`, `crossroom status
 * --host codex`) acts for, and never another one named with `--session`: a rule matches a prefix,
 * so a `--session` after it would reach another session's seat, in another room, with no prompt.
 */
export function ownCodexSession(args: Args, what: string, about = 'the seat this Codex session holds'): string {
  const session = codexSession();
  if (text(args.flags.session) !== session) throw new Usage(`${what} is for ${about}, and takes no --session.`);
  return session;
}

/** A flag's value, or undefined for a flag given as a bare switch or not at all. */
export const text = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** `--driver exec|acp` on `crossroom runner start` and `crossroom join`: undefined when not given. */
export function driverFlag(v: string | undefined): 'exec' | 'acp' | undefined {
  if (v === undefined) return undefined;
  if (v === 'exec' || v === 'acp') return v;
  throw new Usage(`--driver is exec or acp; got "${v.slice(0, 40)}".`);
}

export function portOf(flags: Args['flags']): number {
  const raw = text(flags.port);
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Usage(`--port must be a port number; got "${raw}".`);
  return n;
}

// ---------------------------------------------------------------- a Crossroom on this machine

type Probe = 'parley' | 'other' | 'free';

/** Whether a Crossroom answers on this port, something else does, or nothing does. */
export async function probe(port: number): Promise<Probe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return res.ok && body?.ok === true ? 'parley' : 'other';
  } catch (e) {
    // Refused: nobody listening. A timeout is someone listening who does not answer like Crossroom.
    return (e as { name?: string }).name === 'TimeoutError' ? 'other' : 'free';
  }
}

const pidFile = () => path.join(dataDir(), 'server.pid');

/** Open a URL in the default browser, without a shell: cmd.exe would re-split the arguments. */
export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser to open; the URL is printed anyway */
  }
}

// ---------------------------------------------------------------- rooms `ask` opened

export interface SavedRoom {
  id: string;
  /** The owner token: the only thing that opens the room, shown once by the server. */
  owner: string;
  title: string;
  createdAt: string;
  base: string;
  /**
   * Who saved it, when not the `crossroom` command: `crew` and `crew-device` are rooms Crew (part of
   * the retired Crossroom Code) opened, kept in their own pools. Absent for the command's own rooms.
   */
  pool?: 'crew' | 'crew-device';
  /**
   * The directories its agents work in and its topic, as known when it was opened, for
   * the local copy of its recap (`crossroom memory`, commands/memory-notes.ts). Absent on rooms
   * saved before they were kept.
   */
  dirs?: string[];
  topic?: string;
}

const roomsFile = () => path.join(dataDir(), 'cli-rooms.json');
/** Owner tokens kept per pool. The server keeps only a hash, so a token dropped here is that room gone. */
const ROOMS_KEPT = 50;

/** Rooms this process saved as the command's own, in the order it saved them. */
const openedThisRun: SavedRoom[] = [];
/** The rooms this process opened and saved (and forgets them: each is offered to the account once). */
export function takeOpenedRooms(): SavedRoom[] {
  return openedThisRun.splice(0);
}

export function savedRooms(): SavedRoom[] {
  try {
    const list = JSON.parse(readFileSync(roomsFile(), 'utf8')) as unknown;
    return Array.isArray(list) ? (list as SavedRoom[]).filter((r) => r && typeof r.id === 'string' && typeof r.owner === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Keep an owner token, as the browser keeps one in its storage: this file is to the command what
 * localStorage is to the page. Readable by this user only where the system has such a thing.
 * A save drops only the oldest rooms of its own pool, so the rooms another writer left (Crew's,
 * before it was retired) never push out the tokens of `crossroom ask` rooms, nor the other way round.
 */
export function saveRoom(room: SavedRoom, { inAccount = false }: { inAccount?: boolean } = {}) {
  // The command's own rooms, offered to the signed-in account once the command is done
  // (commands/keep-in-account.ts). Not Crew's, and not one the account already holds.
  if (!room.pool && !inAccount && !openedThisRun.some((r) => r.id === room.id)) openedThisRun.push(room);
  mkdirSync(dataDir(), { recursive: true });
  const pool = room.pool ?? '';
  let kept = 1;
  const list = [room, ...savedRooms().filter((r) => r.id !== room.id && ((r.pool ?? '') !== pool || kept++ < ROOMS_KEPT))];
  writeFileSync(roomsFile(), `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------- seats a Claude Code session holds

/**
 * The seat a Claude Code session took, so the Crossroom plugin's Stop hook can keep that session
 * in its room (plugins/crossroom/scripts/stop-hook.mjs reads this file). Keyed by the session id,
 * which the plugin's skills pass as `--session ${CLAUDE_SESSION_ID}`. A seat link is that
 * seat's only credential, so the file is this user's alone, like cli-rooms.json.
 */
export interface SessionSeat {
  /**
   * The Claude Code session holding the seat, whose Stop hook keeps it in the room. Null for a seat
   * this machine knows but no session holds: one the `crossroom:seat` agent took in the background,
   * or one whose session was left. `crossroom seats` lists it and `/crossroom:resume` can take it up.
   */
  session: string | null;
  seat: string;
  /** Where the seat's Stop hook answers: `/api/hook/stop/<token>` on the seat link's own host. */
  hook: string;
  at: string;
  /** The directory the seat was taken from, so a new session there can find it again. */
  cwd?: string;
  /**
   * The holding session's own peer address, from Claude Code's cross-session messaging
   * (`CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`, which Claude Code exports to
   * its Bash tool), so `crossroom wake` can tell that session something arrived while nobody was
   * waiting on the seat. Recorded only when the command runs inside that very session.
   */
  peer?: SeatPeer;
}

/** A Claude Code session's peer address: its socket and the token that opens it. */
export interface SeatPeer {
  socket: string;
  token: string;
}

/**
 * The peer address of the session running this command, for a seat `session` holds: only when
 * Claude Code says this process belongs to that session (`CLAUDE_CODE_SESSION_ID`), so a seat
 * recorded for one session never carries another's address.
 */
export function peerOfEnv(session: string | null, env: NodeJS.ProcessEnv = process.env): SeatPeer | undefined {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!session || env.CLAUDE_CODE_SESSION_ID !== session || !socket || !token) return undefined;
  // A Unix socket path or a Windows pipe name, absolute; a token of plain characters.
  if (!(path.isAbsolute(socket) || socket.startsWith('\\\\.\\pipe\\')) || /[\0-\x1f]/.test(socket)) return undefined;
  if (!/^[A-Za-z0-9._~+/=-]{8,512}$/.test(token)) return undefined;
  return { socket, token };
}

/** Change the peer address recorded with a seat (undefined forgets it), leaving the rest as it was. */
export function setSeatPeer(hook: string, peer: SeatPeer | undefined) {
  const list = sessionSeats();
  if (!list.some((s) => s.hook === hook)) return;
  writeSeats(list.map((s) => (s.hook === hook ? { ...s, peer } : s)));
}

const seatsFile = () => path.join(dataDir(), 'claude-seats.json');
const SEATS_KEPT = 50;

/** The Stop-hook address for a seat link, or null if it is not one. */
export function hookUrlOf(seatUrl: string): string | null {
  try {
    const u = new URL(seatUrl);
    const m = u.pathname.match(/^\/j\/([A-Za-z0-9_-]+)\/?$/);
    return m && (u.protocol === 'http:' || u.protocol === 'https:') ? `${u.origin}/api/hook/stop/${m[1]}` : null;
  } catch {
    return null;
  }
}

export function sessionSeats(): SessionSeat[] {
  try {
    const list = JSON.parse(readFileSync(seatsFile(), 'utf8')) as unknown;
    return Array.isArray(list)
      ? (list as SessionSeat[]).filter((s) => s && (typeof s.session === 'string' || s.session === null) && typeof s.hook === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeSeats(list: SessionSeat[]) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(seatsFile(), `${JSON.stringify(list.slice(0, SEATS_KEPT), null, 2)}\n`, { mode: 0o600 });
}

/**
 * Record that `session` holds `seatUrl`, or with no session that this machine knows the seat.
 *
 * A seat is held by one session at most, so recording it moves it: a session resuming a seat from
 * another session (`/crossroom:resume`) takes it over, and the old session's Stop hook lets that
 * session go instead of both holding one seat. A later seat for the same session replaces its
 * earlier one, as before. `cwd` is where the seat was taken, which is how a new session in that
 * directory finds it again.
 */
export function recordSessionSeat(session: string | null, seatUrl: string, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): SessionSeat {
  if (session !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new Usage(`"${session}" is not a Claude Code session id.`);
  const hook = hookUrlOf(seatUrl);
  if (!hook) throw new Usage(`${seatUrl} is not a Crossroom seat link (…/j/<token>).`);
  const peer = peerOfEnv(session, env);
  const entry: SessionSeat = { session, seat: seatUrl, hook, at: new Date().toISOString(), cwd, ...(peer ? { peer } : {}) };
  const before = sessionSeats();
  writeSeats([entry, ...before.filter((s) => s.hook !== hook && (session === null || s.session !== session))]);
  // The sessions this seat was taken from still hold its link in their context, and nothing else
  // would tell them it moved: in live runs the old session took its user's next message as the
  // answer the room was waiting for, and finished the seat the new session held.
  const from = before.filter((s) => s.hook === hook && s.session !== null && s.session !== session).map((s) => s.session!);
  noteMoved(from, session);
  return entry;
}

// ---------------------------------------------------------------- seats that moved to another session

/**
 * A session whose seat another session took (`/crossroom:resume`, or the same link joined elsewhere),
 * to be told so once: by its Stop hook if it is still in a turn, or with its user's next prompt.
 * The plugin's hooks read this file and delete each entry as they tell it. It holds no link, only
 * the session to tell, and it exists only while someone has not been told yet: the prompt hook
 * checks that it exists before it starts Node at all.
 */
export interface MovedSeat {
  session: string;
  at: string;
}

const movedFile = () => path.join(dataDir(), 'claude-moved.json');
/** A session not told within a day has ended, or has long since stopped acting on the room. */
const MOVED_MS = 24 * 3600_000;

export function movedSeats(): MovedSeat[] {
  try {
    const list = JSON.parse(readFileSync(movedFile(), 'utf8')) as unknown;
    return Array.isArray(list) ? (list as MovedSeat[]).filter((m) => m && typeof m.session === 'string' && typeof m.at === 'string') : [];
  } catch {
    return [];
  }
}

/** Tell `sessions` their seat moved, and stop telling `holder`, which holds a seat again. */
function noteMoved(sessions: string[], holder: string | null) {
  const had = movedSeats();
  if (!sessions.length && !had.some((m) => m.session === holder)) return;
  const at = new Date().toISOString();
  const keep = had.filter((m) => m.session !== holder && !sessions.includes(m.session) && Date.parse(m.at) > Date.now() - MOVED_MS);
  const list = [...sessions.map((session) => ({ session, at })), ...keep].slice(0, SEATS_KEPT);
  if (!list.length) {
    rmSync(movedFile(), { force: true });
    return;
  }
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(movedFile(), `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
}

/** Forget seats whose room no longer exists, so nothing offers to resume them again. */
function forgetSeats(hooks: Set<string>) {
  if (hooks.size) writeSeats(sessionSeats().filter((s) => !hooks.has(s.hook)));
}

/** Forget one seat on this machine: no Stop hook holds a session for it, and nothing offers it again. */
export function forgetSeat(seatUrl: string): boolean {
  const hook = hookUrlOf(seatUrl.replace(/#.*$/, ''));
  if (!hook) throw new Usage(`${seatUrl} is not a Crossroom seat link (…/j/<token>).`);
  const had = sessionSeats().some((s) => s.hook === hook);
  forgetSeats(new Set([hook]));
  return had;
}

/**
 * The seat a command means: the link given, else the one `--session` holds, else the latest one
 * taken from this directory. Never a guess beyond that: a seat speaks for its holder in the room.
 *
 * So the directory never yields a seat another session holds, except to a terminal reading its room
 * (no `--session`, and `read`, which moves nothing). A seat no session holds (taken in the
 * background, or by `crossroom ask` without a session) is read from its directory by anyone there.
 * Leaving cannot be undone, so a session leaves only the seat it holds or one it names by its link.
 * The directory offers its latest seat only: when that one may not be taken, the command refuses
 * rather than reaching past it to an older seat, whose room may be over or not the one meant.
 */
export function pickSeat(args: Args, cwd = process.cwd(), purpose: 'read' | 'leave' = 'read'): string {
  return chooseSeat(args, cwd, purpose).seat;
}

/** How `pickSeat` found its seat: named by its link, held by `--session`, or taken from the directory. */
type SeatVia = 'link' | 'session' | 'directory';

function chooseSeat(args: Args, cwd: string, purpose: 'read' | 'leave'): { seat: string; via: SeatVia } {
  const given = args.positional[0];
  if (given) {
    if (!hookUrlOf(given.replace(/#.*$/, ''))) throw new Usage(`${given} is not a Crossroom seat link (…/j/<token>).`);
    return { seat: given, via: 'link' };
  }
  const seats = sessionSeats();
  const session = text(args.flags.session);
  const held = session ? seats.find((s) => s.session === session) : undefined;
  if (held) return { seat: held.seat, via: 'session' };
  const fromHere = seats.filter((s) => !!s.cwd && sameDir(s.cwd, cwd));
  const mayTake = (s: SessionSeat) => (purpose === 'read' ? !session || s.session === null : !session && s.session === null);
  // Newest first, as `recordSessionSeat` writes them.
  const here = fromHere[0];
  if (here && mayTake(here)) return { seat: here.seat, via: 'directory' };
  const byLink = '`crossroom seats` lists the seats this machine knows; name one by its link.';
  if (!fromHere.length) throw new Usage(`${session ? 'This session holds no seat, and none' : 'No seat'} was taken from this directory. ${byLink}`);
  if (session && purpose === 'leave')
    throw new Usage(`This session holds no seat. Leaving cannot be undone, so a seat this session does not hold is left by its link. ${byLink}`);
  throw new Usage(
    `${session ? 'This session holds no seat, and the latest seat taken from this directory is held by another' : 'The latest seat taken from this directory is held by a'} Claude Code session. ${byLink}`,
  );
}

const seatBase = (seatUrl: string) => seatUrl.replace(/#.*$/, '').replace(/\/+$/, '');

/** `crossroom status`: the room as the seat's own `status` tells it, which answers a GET and moves nothing. */
export async function seatStatusText(args: Args, cwd = process.cwd()): Promise<string> {
  // The Codex rules file lets `crossroom status --host codex` run outside the sandbox unasked, and a
  // rule matches a prefix: a link after it would be a request to any host with no prompt.
  if (args.flags.host === CODEX) {
    if (args.positional[0])
      throw new Usage('`crossroom status --host codex` reads the seat this session holds, and takes no link. To read another seat, run `crossroom status "<link>"` on its own, which Codex asks about first.');
    ownCodexSession(args, '`crossroom status --host codex`');
  }
  const { seat, via } = chooseSeat(args, cwd, 'read');
  const res = await fetch(`${seatBase(seat)}/status`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) throw new Usage(`The Crossroom at ${new URL(seatBase(seat)).origin} did not answer.`);
  if (res.status === 401 || res.status === 404) throw new Usage('That seat is gone: its room was deleted, or its link was replaced.');
  if (!res.ok) throw new Usage(`Could not read the room: ${res.status} ${await res.text()}`);
  const room = await res.text();
  // A session that holds no seat is shown the directory's seat no session holds, which is what a
  // user asking "how is my room going" usually means. Said first, because in live runs an
  // agent read that room as its own and then left it, on a bare `/crossroom:leave`.
  if (via === 'directory' && text(args.flags.session))
    return `${NOT_THIS_SESSIONS}\n\n${room}`;
  return room;
}

/** What `crossroom status --session` prints first when the session holds no seat. */
export const NOT_THIS_SESSIONS =
  "This session holds no seat. Below is the latest seat taken from this directory, which no session holds: it is not this session's seat. Take no part in it, and never leave it, unless your user names that room. `crossroom seats` lists every seat this machine knows.";

/** `finish`'s own limits on its summary, as the server holds them, so a line it would refuse is refused here first. */
const SUMMARY_MIN = 10;
const SUMMARY_MAX = 4000;

/**
 * `crossroom leave`: finish the seat, with a line for the other side, and forget it here, so the
 * plugin's Stop hook lets its session go and nothing offers to resume it. A seat whose room already
 * ended, or is gone, is only forgotten.
 *
 * The seat is forgotten only once the room has the finish, or has no such seat: a refused or
 * unanswered finish leaves the room live with this seat in it, and the seat still needed here.
 */
export async function leaveSeat(args: Args, cwd = process.cwd()): Promise<string> {
  const seat = pickSeat(args, cwd, 'leave');
  const summary = text(args.flags.summary)?.trim() || 'Left the room.';
  if (summary.length < SUMMARY_MIN || summary.length > SUMMARY_MAX)
    throw new Usage(`--summary must be ${SUMMARY_MIN} to ${SUMMARY_MAX} characters: one line on where you leave things. Nothing was sent.`);
  const kept = 'This machine still has the seat.';
  // An end-to-end room refuses a plain-text finish, before doing anything: only the seat helper,
  // holding the key after `#e=`, can write the line the other side reads.
  if (/#.*\be=/.test(seat))
    throw new Usage(
      [
        `This seat's room is end-to-end encrypted, so \`crossroom leave\` cannot finish it, and nothing was sent. ${kept}`,
        'Finish it with the seat helper, which encrypts your line:',
        `  ${helperCommand(seat, 'finish', 'summary="<your line>"')}`,
        'Once it has finished, `crossroom seat <link> --forget` forgets it on this machine.',
      ].join('\n'),
    );
  const res = await fetch(`${seatBase(seat)}/finish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ summary }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res)
    throw new Usage(
      `The Crossroom at ${new URL(seatBase(seat)).origin} did not answer, so the room was not told you left. ${kept} Run this again once it answers; \`crossroom seat <link> --forget\` forgets the seat without telling the room.`,
    );
  if (res.ok) {
    forgetSeat(seat);
    return 'Left the room: the other side was told, with your line. This machine has forgotten the seat.';
  }
  if (res.status === 401 || res.status === 404 || res.status === 410) {
    forgetSeat(seat);
    return 'That seat was already gone. This machine has forgotten it.';
  }
  const said = (await res.text().catch(() => '')).trim();
  // Finished before, from this session or another: the room heard its last word then, and a seat
  // finishes once (the server's `finish`). Nothing is left for this machine to hold it for.
  if (res.status === 409 && said.includes(SEAT_FINISHED)) {
    forgetSeat(seat);
    return 'That seat had already finished, so the room was not told again. This machine has forgotten it.';
  }
  // Refused, so the room goes on with this seat in it: an end-to-end room whose link lost its key
  // answers 409, and says what to run instead.
  throw new Usage(`The room refused the finish, so it was not told you left. ${kept}\n${res.status} ${said}`);
}

// ---------------------------------------------------------------- `crossroom op`: a seat's calls, without curl

/**
 * The seat `crossroom op` speaks for: the one this Codex session holds (`--host codex`), and no
 * other. Never one taken from the directory, as `status` may: every call is the seat speaking, or
 * moving what it has been shown.
 *
 * The Codex rules file lets `crossroom op` run outside the sandbox unasked, and a rule matches a
 * prefix, so whatever `op` accepts, an agent led on by the room can run without a prompt. A
 * `--seat <link>` would send a call, and any file `key@<file>` names, to any host; a `--session`
 * would speak for another session's seat, in another room. So `op` takes neither: the seat's host
 * came from `crossroom seat` or `crossroom ask`, which Codex asks about first.
 */
export function opSeat(args: Args): string {
  if (args.flags.seat !== undefined)
    throw new Usage('`crossroom op` speaks only for the seat this session holds, and takes no --seat. `crossroom seat <link> --host codex` takes a seat for this session.');
  if (args.flags.host !== CODEX) throw new Usage('`crossroom op` runs inside a Codex session, for the seat that session holds: add --host codex.');
  const session = ownCodexSession(args, '`crossroom op`');
  const held = sessionSeats().find((s) => s.session === session);
  if (!held)
    throw new Usage('This session holds no seat. `crossroom seat <link>` with this session takes one; `crossroom seats` lists the seats this machine knows.');
  return held.seat;
}

/**
 * The briefing's calls, as `crossroom op` makes them: plain words, one command each, so a Codex rule
 * that allows `crossroom op` covers every one and no call needs `curl`, a variable or a redirection.
 * No link in them either: `seat` names the seat (`--host codex`), and the token stays out of every
 * command the agent writes.
 */
export function opCalls(seat: string): string {
  const op = (rest: string) => `crossroom op ${rest} ${seat}`;
  return [
    '## Calls',
    `Every call is \`crossroom op <call>\` with \`key=value\` arguments, run on its own: never chained, and with no \`$VAR\` in it. \`${seat}\` names your seat. Every call prints text; read it.`,
    '```sh',
    '# say something',
    op('say text="Your message here."'),
    '# wait for the other side (blocks up to 45 s; returns new activity or "(no new activity)")',
    op('wait'),
    '# ask for something specific you need',
    op('request_context what="the zod schema line for customerId" why="to check nullability"'),
    '# answer with an excerpt, citing its real source',
    op('share_context kind=code title="checkout schema" source="src/schema.ts:12" body="customerId: z.string().uuid()"'),
    '# put a disagreement on the record, then move on evidence',
    op('claim stance=oppose evidence=X1 text="customerId can be null in v1.4" reason="the schema requires a uuid"'),
    op('position claim=C1 stance=support evidence=X1,X2 reason="X1 changed my mind"'),
    '# where things stand / re-sync after losing the thread',
    op('status'),
    op('join'),
    '# done',
    op('finish summary="What was established, what moved, what is unresolved."'),
    '```',
    "stance: support | oppose | uncertain | insufficient_evidence. Put text holding `$`, a backtick or a double quote in single quotes. Long text: `key@<file>` reads it from a file, and `key@-` from stdin.",
  ].join('\n');
}

type Renderers = { [K in OpName]: (d: OpData[K], c: RoomCipher | null) => Promise<string> | string };

/**
 * The calls `crossroom op` makes: the seat helper's ten, and `record`, a project room's, which
 * the server answers exactly as a call that never existed for a seat its room does not offer it to.
 * The helper's own `OPS` stays the ten: a project room is never end-to-end.
 */
const CALLS: readonly OpName[] = [...OPS, 'record', 'work', 'submit', 'report', 'board', 'board_set', 'declare_tool', 'call_tool', 'tool_result', 'open_room', 'subrooms', 'context', 'items', 'file', 'update', 'verify', 'pass', 'autonomy'];

export interface OpResult {
  code: number;
  out: string;
  err: string;
}

/**
 * `crossroom op <call> [key=value | key@file | key@-]…`: one of the seat's calls, as the seat helper
 * (`packages/seat`) makes it, with its argument grammar and its encryption for an end-to-end room,
 * and the text the server renders. The briefing's calls are `crossroom op` ones (`opCalls`).
 */
export async function seatOp(args: Args, io: SeatIo, fetchImpl: typeof fetch = fetch): Promise<OpResult> {
  const [call, ...tokens] = args.positional;
  if (!call) throw new Usage(`Usage: crossroom op <call> [key=value | key@file | key@-]... --host codex\nCalls: ${CALLS.join(', ')}.`);
  if (!CALLS.includes(call as OpName)) throw new Usage(`There is no call "${call}". Calls: ${CALLS.join(', ')}.`);
  const name = call as OpName;
  let link: SeatLink;
  let fields: Record<string, unknown>;
  try {
    link = parseLink(opSeat(args));
    fields = await seatArgs(tokens, io);
  } catch (e) {
    if (e instanceof UsageError) throw new Usage(e.message);
    throw e;
  }
  const cipher = link.key ? await RoomCipher.fromKey(link.key).catch(() => null) : null;
  if (link.key && !cipher) throw new Usage("The #e= part of this seat's link is not a Crossroom room key.");
  // Not encrypted here yet, so never sent: the server would refuse them too, but only after they
  // had crossed the wire in the clear.
  const refused = cipher ? ((E2EE_REFUSED as Partial<Record<OpName, readonly string[]>>)[name] ?? []).filter((k) => fields[k]) : [];
  if (refused.length) return { code: 1, out: '', err: `${refused.join(' and ')} cannot be sent in an end-to-end encrypted room yet. Nothing was sent.` };
  if (cipher) fields = await cipher.sealArgs(name, fields);

  const origin = new URL(link.base).origin;
  const res = await fetchImpl(`${link.base}/${name}?format=json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fields),
  }).catch(() => null);
  if (!res) return { code: 1, out: '', err: `The Crossroom at ${origin} did not answer. Nothing was sent.` };
  const body = (await res.json().catch(() => null)) as { ok?: boolean; e2ee?: boolean; error?: string; data?: unknown } | null;
  if (!body) return { code: 1, out: '', err: `Unexpected answer from ${origin} (HTTP ${res.status}).` };
  if (!body.ok) return { code: 1, out: '', err: body.error ?? `HTTP ${res.status}` };
  if (body.e2ee && !cipher)
    return { code: 1, out: '', err: "This room is end-to-end encrypted, and the seat's link has no key: record the whole link, with its #e= part." };
  const render: Renderers = {
    join: async (d, c) => briefing(c ? await c.join(d) : d, { calls: opCalls('--host codex') }),
    status: async (d, c) => renderStatus(c ? await c.status(d) : d),
    wait: async (d, c) => renderWait(c ? await c.wait(d) : d),
    say: renderSay,
    request_context: renderRequested,
    decline_context: renderDeclined,
    share_context: renderShared,
    claim: renderClaimed,
    position: renderPosition,
    finish: renderFinished,
    // A project room's: in `CALLS`, not in the helper's `OPS`.
    record: (d) => renderRecord(d),
    work: (d) => renderWork(d),
    submit: (d) => renderSubmitted(d),
    report: (d) => renderReported(d),
    // A room with a board's: in `CALLS`, never an end-to-end room's.
    board: (d) => renderBoard(d),
    board_set: (d) => renderBoardSet(d),
    // A room with typed tools': in `CALLS`, never an end-to-end room's.
    declare_tool: (d) => renderToolDeclared(d),
    call_tool: (d) => renderToolCalled(d),
    tool_result: (d) => renderToolResult(d),
    // A room's lead's, in a room that allows sub-rooms: never an end-to-end room's.
    open_room: (d) => renderOpenRoom(d),
    subrooms: (d) => renderSubrooms(d),
    // A sparse room's: never an end-to-end room's.
    context: (d) => renderContextIndex(d),
    // A lane's: never an end-to-end room's.
    items: (d) => renderLaneItems(d),
    file: (d) => renderLaneFiled(d),
    update: (d) => renderLaneUpdated(d),
    verify: (d) => renderLaneUpdated(d),
    pass: (d) => renderLanePass(d),
    autonomy: (d) => renderLaneSettings(d),
  };
  // A key on a link to an ordinary room opens nothing; the server sent plaintext.
  const out = await (render[name] as (d: unknown, c: RoomCipher | null) => Promise<string> | string)(body.data, body.e2ee ? cipher : null);
  return { code: 0, out, err: '' };
}

// ---------------------------------------------------------------- seats this machine knows

/** A recorded seat and where its room stands now, as `crossroom seats` and `/crossroom:resume` read it. */
export interface KnownSeat {
  seat: string;
  session: string | null;
  cwd: string | null;
  /** Taken from this directory, the one the command runs in. */
  here: boolean;
  at: string;
  /** 'live' covers a room not yet started; 'unreachable' is a Crossroom that did not answer. */
  room: 'live' | 'ended' | 'gone' | 'unreachable';
  title: string | null;
  seatLetter: string | null;
  seatName: string | null;
  /** Events waiting for this seat that its agent has not been shown. */
  pending: number;
}

const sameDir = (a: string, b: string) => {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/** Where one seat's room stands, from its seat's `status`, which answers a GET and moves nothing. */
async function seatStatus(s: SessionSeat): Promise<Pick<KnownSeat, 'room' | 'title' | 'seatLetter' | 'seatName' | 'pending'>> {
  const none = { title: null, seatLetter: null, seatName: null, pending: 0 };
  const base = s.seat.replace(/#.*$/, '').replace(/\/+$/, '');
  // An end-to-end room's title and names are ciphertext here; the link's key is for the helper.
  const sealed = /#.*\be=/.test(s.seat);
  try {
    const res = await fetch(`${base}/status?format=json`, { signal: AbortSignal.timeout(3000) });
    if (res.status === 401 || res.status === 404) return { room: 'gone', ...none };
    const body = (await res.json()) as { ok?: boolean; data?: any };
    const d = body?.data;
    if (!res.ok || !d) return { room: 'unreachable', ...none };
    return {
      room: d.status === 'ended' ? 'ended' : 'live',
      title: sealed ? '(end-to-end encrypted room)' : typeof d.title === 'string' ? d.title : null,
      seatLetter: typeof d.me?.slot === 'number' ? slotLetter(d.me.slot) : null,
      seatName: sealed ? null : typeof d.me?.name === 'string' ? d.me.name : null,
      pending: Number(d.pending) || 0,
    };
  } catch {
    return { room: 'unreachable', ...none };
  }
}

/**
 * Every seat this machine recorded, with its room's state, the likeliest to resume first: live
 * before anything else, then taken from this directory, then the most recent. Seats whose room is
 * gone are dropped from the file as they are found.
 */
export async function knownSeats(cwd = process.cwd()): Promise<KnownSeat[]> {
  const recorded = sessionSeats();
  const rows = await Promise.all(
    recorded.map(async (s) => ({
      seat: s.seat,
      session: s.session,
      cwd: s.cwd ?? null,
      here: !!s.cwd && sameDir(s.cwd, cwd),
      at: s.at,
      ...(await seatStatus(s)),
    })),
  );
  forgetSeats(new Set(recorded.filter((_, i) => rows[i]!.room === 'gone').map((s) => s.hook)));
  const rank = (r: KnownSeat) => (r.room === 'live' ? 0 : r.room === 'unreachable' ? 2 : 3) - (r.here ? 1 : 0);
  return rows.filter((r) => r.room !== 'gone').sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at));
}

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** `crossroom seats`: the seats this machine knows, for a person reading the terminal. */
export function seatsText(rows: KnownSeat[]): string {
  if (!rows.length) return 'No seats recorded on this machine. `crossroom seat <link>` records one; the Crossroom plugin does it for you.';
  const line = (r: KnownSeat) => {
    const who = r.seatLetter ? `seat ${r.seatLetter}${r.seatName ? ` (${r.seatName})` : ''}` : 'a seat';
    const state =
      r.room === 'live'
        ? `live${r.pending ? `, ${r.pending} new for you` : ''}`
        : r.room === 'ended'
          ? 'ended'
          : 'no answer from its Crossroom';
    return `  ${r.here ? '*' : '-'} "${r.title ?? 'a Crossroom room'}", ${who}: ${state}. Taken ${ago(r.at)}${r.cwd ? ` in ${r.cwd}` : ''}${r.session ? '' : ', held by no session'}.\n      ${r.seat}`;
  };
  return [
    'Seats this machine took, likeliest to resume first (* means from this directory):',
    ...rows.map(line),
    '',
    'In Claude Code, /crossroom:resume takes one up in the current session, and in Codex, $crossroom:resume does.',
  ].join('\n');
}

// ---------------------------------------------------------------- ask

interface RunnerInfo {
  id: string;
  label: string;
  available: boolean;
  note?: string;
}

/** Runners in the order `ask` prefers them: the confined one first (SECURITY.md, runner table). */
const PREFERRED = ['claude', 'codex', 'grok'];

export function pickRunner(runners: RunnerInfo[], wanted?: string): RunnerInfo {
  if (wanted) {
    const r = runners.find((x) => x.id === wanted);
    if (!r) throw new Usage(`There is no runner called "${wanted}". Crossroom can host: ${runners.map((x) => x.id).join(', ')}.`);
    if (!r.available) throw new Usage(`${r.label} cannot take a seat here: ${r.note ?? 'not available'}.`);
    return r;
  }
  for (const id of PREFERRED) {
    const r = runners.find((x) => x.id === id && x.available);
    if (r) return r;
  }
  throw new Usage(
    'No agent CLI Crossroom can host was found. Install and log in to Claude Code (`claude`) or Codex (`codex`); `crossroom doctor` shows what it looked for.',
  );
}

/** The room `ask` opens: your seat, and an agent of the chosen runner in the other directory. */
export function askRoom(o: { dir: string; question: string; runner: Pick<RunnerInfo, 'label'> }) {
  const name = path.basename(o.dir) || o.dir;
  return {
    title: firstLine(`Ask ${name}: ${o.question}`, 120),
    mode: 'free' as const,
    maxMessages: 24,
    sharedBrief: [
      o.question,
      '',
      `Seat A asked this. Seat B has ${name} in its working directory and answers from it.`,
      '- B: answer from the files, not from memory. Share what you find as packets with their exact source (path and lines), and say plainly when the repository does not show something.',
      '- A: ask for exactly what you need, and register a claim for anything you disagree about that the files can settle.',
      '- Both finish once A has what it asked for.',
    ].join('\n'),
    participants: [
      { name: 'Asker', kind: 'attached' as const },
      // Taken by an agent this computer starts in the directory (commands/local-agent.ts): the room
      // is on the instance, the agent and the repository stay here.
      {
        name: `${name} (${o.runner.label})`,
        kind: 'attached' as const,
        privateBrief: `You are the agent for ${name}, the repository in your working directory. The other seat cannot read it: everything it learns about this code comes from what you share, so read before you answer.`,
      },
    ],
  };
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${res.status} ${res.statusText}`;
}

export interface AskResult {
  roomId: string;
  seatUrl: string;
  watchUrl: string;
  runner: string;
  directory: string;
  minutes: string;
  /** The other seat's link, for `--no-start`: `crossroom join` takes it with an agent in the directory. */
  agentSeatUrl: string;
  /** Where the agent started for the other seat writes its log; absent with `--no-start`. */
  agentLog?: string;
  /** The rooms whose kept recaps `--recall` brought in, as one owner packet. */
  recalled?: string[];
}

/**
 * `crossroom ask <dir> "<question>"`: a room on the instance (the hosted one unless `--instance`,
 * `--relay` or `CROSSROOM_URL` names another), your seat, and an agent of yours started on this
 * computer in `<dir>` for the other one (commands/local-agent.ts). Nothing runs on the instance's side.
 */
export async function ask(args: Args, say: (line: string) => void, deps: { runners?: RunnerOptions } = {}): Promise<AskResult> {
  const [dirArg, ...words] = args.positional;
  const question = words.join(' ').trim();
  if (!dirArg || !question) throw new Usage('Usage: crossroom ask <directory> "<question>" [--with claude|codex] [--model <name>]');
  const dir = path.resolve(dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Usage(`${dir} is not a directory.`);
  const recall = text(args.flags.recall);
  // Those modules import this one, so they load here, once this one has.
  const { chosenInstance } = await import('./commands/relay-call.js');
  const { DEFAULT_INSTANCE } = await import('./commands/instance.js');
  const local = await import('./commands/local-agent.js');
  const memory = await import('./commands/memory-notes.js');
  const base = chosenInstance(args, DEFAULT_INSTANCE);
  const runner = pickRunner(runnerAvailability(deps.runners), text(args.flags.with));
  const agent = { runtime: runner.id, label: runner.label, dir, model: text(args.flags.model), unconfinedOk: args.flags['unconfined-reads-ok'] === true };
  if (!args.flags['no-start']) local.checkConfinement(agent);
  // The recaps of rooms this instance has ended since the last look, kept before anything is opened.
  await memory.syncMemory({ only: (r) => r.base === base }).catch(() => undefined);
  const dirs = [...new Set([process.cwd(), dir])];
  let notes: MemoryEntry[] = [];
  let recalled = '';
  if (recall !== undefined) {
    try {
      notes = memory.recallNotes(recall, { dirs });
    } catch (e) {
      throw new Usage((e as Error).message);
    }
    recalled = memory.recallText(notes);
    if (!recalled) say('No earlier room this computer keeps a recap of matches, so none is brought in.');
  }

  // Never follows a redirect: the answer carries the room's only owner token.
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(askRoom({ dir, question, runner })),
    redirect: 'error',
  });
  if (!res.ok) throw new Usage(`Crossroom at ${hostOf(base)} refused the room: ${await errorOf(res)}`);
  const created = (await res.json()) as {
    session: { id: string; title: string; createdAt: string };
    ownerToken: string;
    ownerUrl: string;
    participants: { id: string; slot: number; kind: string; seatUrl: string }[];
  };
  const [seat, other] = [...created.participants].sort((a, b) => a.slot - b.slot);
  if (!seat || !other) throw new Usage(`Crossroom at ${hostOf(base)} answered with a room that has no second seat.`);
  const saved: SavedRoom = { id: created.session.id, owner: created.ownerToken, title: created.session.title, createdAt: created.session.createdAt, base, dirs };
  saveRoom(saved);
  // Before the agent starts, so its join briefing carries them.
  if (recalled) {
    try {
      await memory.postRecall(saved, recalled);
    } catch (e) {
      say((e as Error).message);
      recalled = '';
    }
  }
  const started = args.flags['no-start'] ? null : local.startLocalAgent(other.seatUrl, agent, { roomId: saved.id, letter: 'B' });
  // Recorded either way: held by the session that asked, or known to this machine with no session
  // holding it (the plugin's background agent takes it, or a terminal did), so it can be resumed.
  recordSessionSeat(text(args.flags.session) ?? null, seat.seatUrl);
  return {
    roomId: created.session.id,
    seatUrl: seat.seatUrl,
    watchUrl: created.ownerUrl,
    runner: runner.id,
    directory: dir,
    minutes: `crossroom minutes ${created.session.id}`,
    agentSeatUrl: other.seatUrl,
    ...(started ? { agentLog: started.log } : {}),
    ...(recalled ? { recalled: notes.map((n) => n.id) } : {}),
  };
}

const hostOf = (base: string) => {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
};

// ---------------------------------------------------------------- rooms `ask` opened, by hand

/**
 * The room a command means: the one named, by its id or the start of it as `crossroom rooms` prints
 * it, or the latest one opened here (`new`, `ask`, `panel open`).
 */
export function pickRoom(args: Args): SavedRoom {
  const rooms = savedRooms();
  const want = args.positional[0];
  if (!want) {
    if (!rooms[0]) throw new Usage('No room was opened from this machine yet. `crossroom new "<topic>"` opens one.');
    return rooms[0];
  }
  const exact = rooms.find((r) => r.id === want);
  if (exact) return exact;
  const starts = rooms.filter((r) => r.id.startsWith(want));
  if (starts.length === 1) return starts[0]!;
  if (starts.length > 1) throw new Usage(`More than one room starts with ${want}: ${starts.map((r) => r.id.slice(0, 12)).join(', ')}. Give more of the id.`);
  throw new Usage(`Room ${want} was not opened from this machine, so there is no key for it here.`);
}

const owned = (room: SavedRoom, extra: Record<string, string> = {}) => ({ 'x-parley-owner': room.owner, accept: 'application/json', ...extra });

/** The private link: the room's page with its key in the fragment, as the web's Copy private link makes it. */
export const privateLink = (room: SavedRoom) => `${room.base}/s/${encodeURIComponent(room.id)}#k=${encodeURIComponent(room.owner)}`;

export interface RoomRow {
  id: string;
  title: string;
  createdAt: string;
  /** `live`, `open` (not every seat has joined), `ended`, `gone` (the server no longer has it) or `unknown` (not reachable). */
  state: 'live' | 'open' | 'ended' | 'gone' | 'unknown';
  yourTurn: number;
  lastActivityAt: string | null;
}

/**
 * The rooms `ask` opened from this machine, and how each one stands (`POST /api/sessions/lookup`,
 * fifty at a time per server, as the web's list asks). A server that does not answer leaves its
 * rooms `unknown`; one that answers without a room has deleted it.
 */
export async function roomRows(): Promise<RoomRow[]> {
  const rooms = savedRooms();
  const found = new Map<string, { status: string; attention?: { yourTurn?: number; lastActivityAt?: string } }>();
  const reached = new Set<string>();
  for (const base of new Set(rooms.map((r) => r.base))) {
    const mine = rooms.filter((r) => r.base === base);
    for (let i = 0; i < mine.length; i += 50) {
      try {
        const res = await fetch(`${base}/api/sessions/lookup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ rooms: mine.slice(i, i + 50).map((r) => ({ id: r.id, owner: r.owner })) }),
        });
        if (!res.ok) continue;
        for (const s of (await res.json()) as { id: string; status: string }[]) found.set(s.id, s);
        reached.add(base);
      } catch {
        /* not running: its rooms stay unknown */
      }
    }
  }
  return rooms.map((r) => {
    const s = found.get(r.id);
    const state: RoomRow['state'] = s
      ? s.status === 'ended'
        ? 'ended'
        : s.status === 'open'
          ? 'open'
          : 'live'
      : reached.has(r.base)
        ? 'gone'
        : 'unknown';
    return {
      id: r.id,
      title: r.title,
      createdAt: r.createdAt,
      state,
      yourTurn: s?.attention?.yourTurn ?? 0,
      lastActivityAt: s?.attention?.lastActivityAt ?? null,
    };
  });
}

export function roomsText(rows: RoomRow[]): string {
  if (!rows.length) return 'No rooms yet. `crossroom new "<topic>"` opens one.';
  const word: Record<RoomRow['state'], string> = {
    live: 'live',
    open: 'not started: a seat is still empty',
    ended: 'ended',
    gone: 'gone from the server',
    unknown: 'Crossroom is not running',
  };
  const lines = rows.map((r) => {
    const turn = r.yourTurn ? `, your turn (${r.yourTurn} question${r.yourTurn === 1 ? '' : 's'} for you)` : '';
    return `  ${r.id.slice(0, 8)}  ${firstLine(r.title).slice(0, 60)}\n            ${word[r.state]}${turn}, opened ${r.createdAt.slice(0, 16).replace('T', ' ')}`;
  });
  return `${lines.join('\n')}\n\ncrossroom open|end|share|minutes <id> acts on one; with no id, on the first.`;
}

/** End a room, as its End room button does. */
export async function endRoom(args: Args): Promise<string> {
  const room = pickRoom(args);
  const outcome = text(args.flags.outcome);
  const res = await fetch(`${room.base}/api/sessions/${encodeURIComponent(room.id)}/end`, {
    method: 'POST',
    headers: owned(room, { 'content-type': 'application/json' }),
    body: JSON.stringify(outcome ? { outcome } : {}),
  });
  if (!res.ok) throw new Usage(`Could not end room ${room.id}: ${await errorOf(res)}`);
  return `Ended "${firstLine(room.title)}". Its minutes: crossroom minutes ${room.id.slice(0, 8)}`;
}

/**
 * A read-only link to a room for someone who is not its owner, or, with `--list` and
 * `--revoke <id>`, the ones it has. What the minutes page's Share panel does.
 */
export async function shareRoom(args: Args): Promise<string> {
  const room = pickRoom(args);
  const at = `${room.base}/api/sessions/${encodeURIComponent(room.id)}/shares`;
  const revoke = text(args.flags.revoke);
  if (revoke) {
    const res = await fetch(`${at}/${encodeURIComponent(revoke)}`, { method: 'DELETE', headers: owned(room) });
    if (!res.ok) throw new Usage(`Could not revoke share ${revoke}: ${await errorOf(res)}`);
    return `Revoked. That link now opens nothing.`;
  }
  if (args.flags.list) {
    const res = await fetch(at, { headers: owned(room) });
    if (!res.ok) throw new Usage(`Could not list the room's share links: ${await errorOf(res)}`);
    const shares = (await res.json()) as { id: string; createdAt: string; revokedAt: string | null; opens?: number }[];
    const live = shares.filter((s) => !s.revokedAt);
    if (!live.length) return 'This room has no live share links.';
    return live.map((s) => `  ${s.id}  made ${s.createdAt.slice(0, 16).replace('T', ' ')}`).join('\n');
  }
  const res = await fetch(at, { method: 'POST', headers: owned(room) });
  if (!res.ok) throw new Usage(`Could not share room ${room.id}: ${await errorOf(res)}`);
  const made = (await res.json()) as { url: string; share: { id: string } };
  return [
    'Anyone with this link can read the room as a reader who is not its owner: no private briefs, and nothing sent to one seat alone.',
    `  ${made.url}`,
    `Revoke it: crossroom share ${room.id.slice(0, 8)} --revoke ${made.share.id}`,
  ].join('\n');
}

// ---------------------------------------------------------------- minutes

export async function minutes(args: Args, say: (line: string) => void): Promise<string> {
  const room = pickRoom(args);
  const id = room.id;
  const headers = { 'x-parley-owner': room.owner };
  if (args.flags.wait) {
    say('Waiting for the room to end…');
    for (;;) {
      const res = await fetch(`${room.base}/api/sessions/${encodeURIComponent(id)}/wait`, { headers });
      if (!res.ok) throw new Usage(`Could not wait on room ${id}: ${await errorOf(res)}`);
      if (((await res.json()) as { status?: string }).status === 'ended') break;
    }
  }
  const style = args.flags.digest ? '?style=digest' : '';
  const res = await fetch(`${room.base}/api/sessions/${encodeURIComponent(id)}/minutes${style}`, { headers });
  if (!res.ok) throw new Usage(`Could not read the minutes of room ${id}: ${await errorOf(res)}`);
  return res.text();
}

// ---------------------------------------------------------------- verify

/**
 * `crossroom verify minutes.md`: whether signed minutes changed since they were signed (signing.ts).
 * Offline, which answers for the text. `--instance <url>` also asks that instance for its key,
 * which answers whose key it was; without it the output says how to check.
 */
export async function verify(args: Args): Promise<{ ok: boolean; lines: string[] }> {
  const file = args.positional[0];
  if (!file) throw new Usage('Usage: crossroom verify <minutes.md> [--instance <url>]');
  let doc: string;
  try {
    doc = readFileSync(file, 'utf8');
  } catch {
    throw new Usage(`Cannot read ${file}.`);
  }
  const v = verifyMinutes(doc);
  if (!v.ok) return { ok: false, lines: [`Not verified: ${v.reason}.`] };
  const lines = [
    `Verified: nothing in ${path.basename(file)} has changed since it was signed.`,
    `Signed with key ${v.fingerprint}${v.instance ? `, which the document says is ${v.instance}'s` : ''}.`,
  ];
  const instance = text(args.flags.instance);
  if (!instance) {
    lines.push(`To check the key is really that instance's, run again with --instance <its URL>, or compare the fingerprint with <its URL>/api/signing-key.`);
    return { ok: true, lines };
  }
  const base = instance.replace(/\/+$/, '');
  let published: { publicKey?: string } | null = null;
  try {
    const res = await fetch(`${base}/api/signing-key`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    published = res.ok ? ((await res.json()) as { publicKey?: string }) : null;
  } catch {
    published = null;
  }
  if (!published?.publicKey) return { ok: false, lines: [...lines, `Could not read the signing key of ${base}.`] };
  if (published.publicKey !== v.publicKey) return { ok: false, lines: [...lines, `${base} signs with a different key: this document was not signed by it.`] };
  return { ok: true, lines: [...lines, `${base} publishes this key, so it signed this document.`] };
}

// ---------------------------------------------------------------- doctor

export async function doctor(args: Args): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = [];
  let ok = true;
  const row = (mark: 'ok' | '--' | '!!', label: string, detail: string) => lines.push(`  ${mark.padEnd(3)} ${label.padEnd(14)} ${detail}`);

  row('ok', 'Node', `${process.versions.node} (needs 22.13 or newer)`);
  try {
    new DatabaseSync(':memory:').close();
    row('ok', 'SQLite', 'built into this Node');
  } catch (e) {
    ok = false;
    row('!!', 'SQLite', `could not open a database: ${(e as Error).message}`);
  }
  const dir = dataDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.doctor'), 'ok');
    row('ok', 'Data', dir);
  } catch (e) {
    ok = false;
    row('!!', 'Data', `${dir} is not writable: ${(e as Error).message}`);
  }
  const port = portOf(args.flags);
  const state = await probe(port);
  row(
    state === 'other' ? '!!' : 'ok',
    `Port ${port}`,
    state === 'parley' ? 'a Crossroom is running here' : state === 'free' ? 'free' : 'in use by something else; pass --port',
  );

  lines.push('', '  Agents this computer can start for you (`crossroom ask`, `join`, `panel open`, the runner):');
  const runners = runnerAvailability();
  for (const r of runners) row(r.available ? 'ok' : '--', r.label, r.available && r.path ? `${r.note}: ${r.path}` : r.note);
  lines.push(
    '',
    runners.some((r) => r.available)
      ? '  Ready. `crossroom new "<topic>"` opens a room; `crossroom ask <dir> "<question>"` puts an agent of yours on another directory.'
      : '  No agent CLI to host was found. Pasting a seat link into any agent you run yourself works without one.',
  );
  return { lines, ok };
}

// ---------------------------------------------------------------- stop

/** What `stop` says when it finds no server of its own: one a service runs is the service manager's. */
const NOTHING_STOPPED =
  'No background Crossroom started by `crossroom ask` is recorded here. One that `crossroom background` runs is a service: `crossroom background status` names it.';

/** Stop the background Crossroom `ask` started, and the agent CLIs it started with it. */
export function stop(): string {
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile(), 'utf8').trim());
  } catch {
    return NOTHING_STOPPED;
  }
  if (!Number.isInteger(pid) || pid <= 0) return NOTHING_STOPPED;
  try {
    if (process.platform === 'win32') {
      // /T takes the agent CLIs with it; without it they would outlive the server they served.
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      if (r.status !== 0) return `Crossroom (process ${pid}) was not running.`;
    } else {
      // Started detached, so it leads its own process group: its agent CLIs are in it too.
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    return `Crossroom (process ${pid}) was not running.`;
  }
  writeFileSync(pidFile(), '');
  return `Stopped the background Crossroom (process ${pid}).`;
}

// ---------------------------------------------------------------- run

/** Command files a build adds to the client's own: the server build's `serve`. */
const addedCommands: Array<() => Promise<unknown>> = [];

/** Register more command files, loaded before the client's so they keep their place in the registry. */
export function addCommands(load: () => Promise<unknown>): void {
  addedCommands.push(load);
}

/**
 * Load every command file (commands/client.ts, and any a build added), once. Dynamic, so that a
 * command file can import this module: by the time it loads, everything here has been set. `run`
 * calls it first; a test that reads the registry or the help without `run` calls it itself.
 */
export async function loadCommands(): Promise<void> {
  for (const load of addedCommands) await load();
  await import('./commands/client.js');
}

/** The help's first line, and its last: what this is, and where it keeps its data. */
const helpHead = () => `Crossroom ${VERSION}: ${TAGLINE}`;
const helpFoot = () => `Data lives in ${dataDir()} (PARLEY_DATA changes it).`;

/**
 * `crossroom help`, `-h` and `--help`: the overview (commands/index.ts `overviewLines`), short enough
 * to read whole. The detail is a topic away: `crossroom help <topic>`, `<command>` or `all`.
 */
export function helpText(): string {
  return [
    helpHead(),
    '',
    ...overviewLines(),
    '',
    'crossroom help <command> shows one command; crossroom <command> --help does too.',
    helpFoot(),
  ].join('\n');
}

/** `crossroom help all`: every topic's page, every command with every flag. */
export function helpAllText(): string {
  return [helpHead(), '', ...helpLines(), '', helpFoot()].join('\n');
}

/**
 * What `crossroom help <word>` prints for a topic, `all` or a command (or an alias), or null for
 * none of them. In `crossroom help <word>` a topic wins over an alias with the same word (`start`);
 * in `crossroom <word> --help`, typed as a command, the command does. No topic is a command's name. A command with help of its own answers with it; a deprecated one, which no topic lists,
 * adds the sentence it says when it runs.
 */
export function helpFor(word: string, prefer: 'topic' | 'command' = 'topic'): string | null {
  if (word === 'all') return helpAllText();
  const topic = helpTopic(word);
  const c = findCommand(word);
  if (topic && !(prefer === 'command' && c)) return [...topicLines(topic.id), '', 'crossroom help shows every topic.'].join('\n');
  if (!c) return null;
  if (c.help) return c.help();
  return [...commandHelpLines(c), ...(c.deprecated ? ['', c.deprecated] : [])].join('\n');
}

/**
 * A flag no command reads is a mistake, never something to ignore: `crossroom new --instance <url>`
 * once opened its room on the hosted instance because the flag was dropped in silence. Refused here,
 * before the command runs, with the flag it most likely meant. A flag another command takes is let
 * through, so nothing a plugin or script passes today starts failing.
 */
export function refuseUnknownFlags(args: Args, command: Command): void {
  const known = knownFlags([...SWITCHES, 'help', 'version']);
  const unknown = Object.keys(args.flags).filter((f) => !known.has(f));
  if (!unknown.length) return;
  const f = unknown[0]!;
  const near = suggestFlag(f, command, known);
  throw new Usage(
    `crossroom ${command.name} has no --${f}${near ? `: did you mean --${near}?` : '.'} Nothing was done. \`crossroom ${command.name} --help\` lists its flags.`,
  );
}

export async function run(argv: string[]): Promise<number> {
  const err = (line: string) => process.stderr.write(`${line}\n`);
  try {
    await loadCommands();
    let args: Args;
    try {
      args = parseArgs(argv);
    } catch (e) {
      // A misspelt flag at the end (`minutes --digets`) is no flag at all: say which one it most
      // likely meant, rather than that it needs a value.
      if (e instanceof MissingValue && !knownFlags([...SWITCHES, 'help', 'version']).has(e.flag)) {
        const word = argv.find((a) => !a.startsWith('-')) ?? 'serve';
        const command = findCommand(word);
        if (command) refuseUnknownFlags({ command: word, positional: [], flags: { [e.flag]: true } }, command);
      }
      throw e;
    }
    if (args.flags.version) {
      console.log(VERSION);
      return 0;
    }
    if (args.command === 'help') {
      const word = args.positional[0];
      if (!word) {
        console.log(helpText());
        return 0;
      }
      const page = helpFor(word);
      if (page === null) throw new Usage(`There is no command or help topic "${word}".\n\n${helpText()}`);
      console.log(page);
      return 0;
    }
    if (args.flags.help) {
      // `crossroom --help` names no command (the word defaults to serve), so it gets the overview;
      // `crossroom serve --help` names it. A word that is no command gets the overview too.
      const named = args.command !== 'serve' || argv.includes('serve');
      console.log((named && helpFor(args.command, 'command')) || helpText());
      return 0;
    }
    // Only a typed `serve` runs Crossroom on this computer. With no command word the command
    // prints its overview: most people use the hosted instance and never need a local one.
    if (args.command === 'serve' && !argv.includes('serve')) {
      console.log(helpText());
      return 0;
    }
    const command = findCommand(args.command);
    if (!command) throw new Usage(`There is no command "${args.command}".\n\n${helpText()}`);
    refuseUnknownFlags(args, command);
    if (command.deprecated && args.flags.service !== true) err(command.deprecated);
    try {
      return await command.run(args, err);
    } finally {
      // Rooms the command opened go into the signed-in account too, on the instance that issued
      // them. Never fails the command: anything that goes wrong is one line, and the room stays here.
      const opened = takeOpenedRooms();
      if (opened.length)
        await import('./commands/keep-in-account.js')
          .then((m) => m.keepOpened(args, opened, err))
          .catch(() => {});
      // Whether an instance the command named supports a newer client: a line on stderr, at most
      // once a day per instance (client-version.ts). Never fails or holds the command long.
      await import('./client-version.js')
        .then((m) => m.warnIfOutdated({ version: VERSION, dataDir: dataDir(), say: err }))
        .catch(() => {});
    }
  } catch (e) {
    if (e instanceof Usage) {
      err(e.message);
      return 2;
    }
    err(String((e as Error)?.stack ?? e));
    return 1;
  }
}
