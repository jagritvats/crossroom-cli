/**
 * `crossroom new`: open a room on a Crossroom others can reach, take seat A, and print what to hand
 * on. `crossroom ask` hosts the other seat on this machine's own server, so its links never leave
 * the machine; this is the command for a room with someone else's agent, or another session's.
 *
 * It goes through `POST /api/sessions/quick` with `join`, so the room is opened and seat A taken in
 * one call. The owner token is kept as `ask` keeps one (`saveRoom`), so `crossroom open`, `minutes`,
 * `end` and `share` work on the room, and seat A is recorded (`recordSessionSeat`), so the plugin's
 * Stop hook keeps the session that ran it in the room. `--add` gives a room this machine holds the
 * key for one more seat (`POST /api/sessions/:id/seats`).
 *
 * Every request carries a token or makes one, so none follows a redirect (`redirect: 'error'`).
 */
import { linkOfPrompt } from '@parley/shared/deeplink';
import { defaultMaxMessages, firstLine, ROOM_SEATS_LIMIT, slotLetter } from '@parley/shared/text';
import { briefing, type JoinData } from '@parley/shared/render';
import { type Args, claudeSessionOf, type OpHost, opCalls, opSeatFlag, pickRoom, recordSessionSeat, saveRoom, Usage, text } from '../cli.js';
import { reach } from '../reach.js';
import { handoffLines, OP_RULE, pasteLine } from '../site/agent-guide.js';
import { registerCommand } from './index.js';
import { launchSeats, resumedSessions } from './launch.js';
import { resumeSpecs } from './local-sessions.js';
import { resolveBin } from '../runners/adapters.js';
import { line } from './project-pick.js';
import { privateLinkOf, type Seats, watchRoom } from './watch.js';
import type { ParleyEvent } from '@parley/shared';
import { chosenInstance, signedIn } from './relay-call.js';
import { HOUSE_ROLE, HOUSE_SEAT_NAME } from '@parley/shared/house';

/** The hosted Crossroom's app host (commands/instance.ts). */
export { DEFAULT_INSTANCE } from './instance.js';
import { DEFAULT_INSTANCE } from './instance.js';

export interface NewResult {
  roomId: string;
  /** The instance the room is on, as an origin. */
  instance: string;
  title: string;
  /** Seat A, which this call took; empty when `--launch` fills every seat. */
  seatUrl: string;
  /** With `--launch` and no session: every seat, A first, for the agents it starts. */
  launchUrls?: string[];
  /** The seats to hand on, B first, each as the line to paste. */
  pasteLines: string[];
  watchUrl: string;
  briefing: string;
  minutes: string;
  /** When the room ends if nobody comes, in the instance's words; absent where no clock runs, or from an older instance. */
  waitingClock?: string;
  /** Seat A is held through `crossroom op`, and this Claude Code rule allows every call of it. Absent for a curl briefing. */
  allowRule?: string;
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${res.status} ${res.statusText}`;
}

/**
 * Open the room. `forPerson`: the command was typed by a person at a terminal (`personAtTerminal`),
 * so it takes no seat itself and every seat is printed to hand to an agent.
 */
export async function newRoom(
  args: Args,
  fetchImpl: typeof fetch = fetch,
  { forPerson = false, env = process.env }: { forPerson?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<NewResult> {
  const base = chosenInstance(args, DEFAULT_INSTANCE);
  const brief = args.positional.join(' ').trim();
  const seatsFlag = text(args.flags.seats);
  // `--launch a,b` and `--resume <agent>:<id>`: agents this command starts in panes, the sessions
  // reopened first. Without a session to hold seat A, they take every seat; with one, the seats after it.
  const placing = launchCount(args);
  // `--launch` without `--session` fills every seat, as it always has, from Claude Code too.
  const takeA = !forPerson && (!placing || text(args.flags.session) !== undefined);
  const session = seatSession(args, env);
  const seats = seatsFlag !== undefined ? Number(seatsFlag) : placing ? Math.max(2, placing + (takeA ? 1 : 0)) : undefined;
  // The ceiling any instance allows; the instance itself refuses past its own cap (six unless raised).
  if (seats !== undefined && !(Number.isInteger(seats) && seats >= 2 && seats <= ROOM_SEATS_LIMIT))
    throw new Usage(`--seats takes a number from 2 to ${ROOM_SEATS_LIMIT}; most instances seat up to 6.`);
  const res = await reach(fetchImpl, `${base}/api/sessions/quick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      ...(brief ? { brief } : {}),
      ...(seats ? { seats } : {}),
      // A sparse room (`@parley/shared/sparse`): the instance refuses it where its flag is off.
      ...(args.flags.sparse === true ? { sparse: true } : {}),
      join: takeA,
      ...(text(args.flags.name) ? { name: text(args.flags.name) } : {}),
      ...(text(args.flags.provider) ? { provider: text(args.flags.provider) } : {}),
      ...(text(args.flags.model) ? { model: text(args.flags.model) } : {}),
    }),
    redirect: 'error',
  });
  if (!res.ok) throw new Usage(`${base} did not open a room: ${await errorOf(res)}`);
  const made = (await res.json()) as {
    session: { id: string; title: string; createdAt: string };
    ownerToken: string;
    ownerUrl: string;
    seatUrls: string[];
    briefing?: string;
    waitingClock?: string;
  };
  const clock = typeof made.waitingClock === 'string' && made.waitingClock ? { waitingClock: made.waitingClock } : {};
  if (!takeA) {
    if (made.seatUrls.length < 2) throw new Usage(`${base} answered a room without its seats: is it an older Crossroom?`);
    saveRoom({ id: made.session.id, owner: made.ownerToken, title: made.session.title, createdAt: made.session.createdAt, base, dirs: [process.cwd()] });
    return {
      roomId: made.session.id,
      instance: base,
      title: made.session.title,
      seatUrl: '',
      launchUrls: made.seatUrls,
      pasteLines: [],
      watchUrl: made.ownerUrl,
      briefing: '',
      minutes: `crossroom minutes ${made.session.id.slice(0, 8)}`,
      ...clock,
    };
  }
  const [seatA, ...others] = made.seatUrls;
  if (!seatA || !others.length || made.briefing === undefined) throw new Usage(`${base} answered a room without its seats or briefing: is it an older Crossroom?`);
  // Codex runs the briefing's calls as `crossroom op` (its rules allow no curl, and its sandbox may have
  // no network), and so does a Claude Code session holding the seat, so a room opened from either is
  // briefed as `crossroom op join` would brief it: join again (a keep-alive that renames nothing), as
  // data, rendered with those calls.
  const host = opHostOf(args, session, env);
  const seatBrief = host ? await opBriefing(seatA, fetchImpl, host) : made.briefing;
  saveRoom({ id: made.session.id, owner: made.ownerToken, title: made.session.title, createdAt: made.session.createdAt, base, dirs: [process.cwd()] });
  recordSessionSeat(session, seatA, process.cwd(), env);
  return {
    roomId: made.session.id,
    instance: base,
    title: made.session.title,
    seatUrl: seatA,
    pasteLines: others.map(pasteLine),
    watchUrl: made.ownerUrl,
    briefing: seatBrief,
    minutes: `crossroom minutes ${made.session.id.slice(0, 8)}`,
    ...clock,
    ...(host === 'claude' ? { allowRule: OP_RULE } : {}),
  };
}

/**
 * The agent host this process runs under, read from what each host sets in the commands its agent
 * runs, or null. Claude Code sets `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT` and
 * `CLAUDE_CODE_SESSION_ID` in its shell tool and hooks (cross-session messaging keys on the last);
 * Codex sets `CODEX_SESSION_ID` (cli.ts's `--host codex` reads it). Only variables a host sets for
 * its own children count: a person's terminal never carries them, even one the Claude Code
 * extension opened. A command a person types through Claude Code's `!` prefix reads as the agent's,
 * which is right, since its output lands in the agent's context too.
 */
export function agentHostOf(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SESSION_ID) return 'Claude Code';
  if (env.CODEX_SESSION_ID) return 'Codex';
  return null;
}

/**
 * Git Bash's own window (mintty) gives a program pipes, not a console, so Node reads
 * `stdout.isTTY` as false for a person typing there. mintty names itself in `TERM_PROGRAM`, and
 * `MSYSTEM` says the shell is Git Bash's (MSYS2). An agent started from such a window inherits both,
 * which is why the agent hosts' own variables are read first; one that sets none would be printed
 * the person's lines, every seat's link included, which it can still use.
 */
export function minttyPerson(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.MSYSTEM && env.TERM_PROGRAM === 'mintty';
}

/**
 * Whether a person typed `crossroom new` at a terminal, rather than an agent running it through its
 * shell tool. A person gets every seat to hand on and takes none; an agent takes seat A and gets its
 * briefing. The agent hosts' own variables decide first (`agentHostOf`), since some run commands in a
 * terminal; then a terminal on stdout (or Git Bash's window, `minttyPerson`) means a person. `--agent`
 * asks for the agent's form anywhere, and `--session` or `--host` mean a plugin ran it.
 */
export function personAtTerminal(args: Args, isTTY: boolean | undefined = process.stdout.isTTY, env: NodeJS.ProcessEnv = process.env): boolean {
  if (args.flags.json || args.flags.agent || args.flags.session !== undefined || args.flags.host !== undefined || launchCount(args) !== 0) return false;
  if (agentHostOf(env)) return false;
  return !!isTTY || minttyPerson(env);
}

/**
 * Whether a person's `crossroom new` stays to show the room's arrivals: only with a terminal on
 * both stdin and stdout (where Ctrl-C reaches it), and never with `--no-follow`. Git Bash's window
 * gives pipes, so it never follows there, and nothing a script or an agent runs can be held open.
 */
export function followsHere(args: Args, stdinTTY: boolean | undefined = process.stdin.isTTY, stdoutTTY: boolean | undefined = process.stdout.isTTY): boolean {
  return !!stdinTTY && !!stdoutTTY && args.flags['no-follow'] !== true;
}

/** The host a room's instance answers on, for the first line of what `new` prints. */
export const instanceHost = (origin: string): string => new URL(origin).host;

/** The agents `--launch` could start here, of the two the hint names. */
const HINTED_AGENTS = ['claude', 'codex'] as const;

/**
 * One line naming `--launch` for the agents found on this computer, for a person who opened a room
 * without it; null when they used `--launch` or `--resume`, or neither agent is installed.
 */
export function launchHint(args: Args, installed: (bin: string) => boolean = (b) => resolveBin(b) !== null): string | null {
  if (args.flags.launch !== undefined || launchCount(args) !== 0) return null;
  const found = HINTED_AGENTS.filter((b) => installed(b));
  if (!found.length) return null;
  const topic = args.positional.join(' ').trim();
  // Written out only when it can be pasted back as one shell word.
  const quoted = topic && !/["$`\\!\r\n]/.test(topic) && topic.length <= 80 ? `"${topic}"` : '"<topic>"';
  return `Next time, crossroom new ${quoted} --launch ${found.join(',')} opens the room with ${found.length > 1 ? 'those agents' : 'that agent'} already in it, a pane each.`;
}

/** What `crossroom new` prints to a person at a terminal: where to watch, and a line for each agent. */
export function personLines(r: NewResult, { hint = null, following = false }: { hint?: string | null; following?: boolean } = {}): string[] {
  const seats = r.launchUrls ?? [];
  const short = r.roomId.slice(0, 8);
  return [
    `Room "${r.title}" is open on ${instanceHost(r.instance)} (${r.roomId}).`,
    '',
    'Watch it in your browser (the only way back in, and private to you):',
    `  ${r.watchUrl}`,
    '',
    'Paste one line into each agent, a seat each:',
    ...seats.map((u, i) => `  ${slotLetter(i)}  ${pasteLine(u)}`),
    ...(r.waitingClock ? ['', r.waitingClock] : []),
    '',
    `Or start agents for them here, a pane each: crossroom launch ${seats.join(' ')}`,
    ...(hint ? [hint] : []),
    following ? `Arrivals show below until the room ends. Ctrl-C stops showing them; the room keeps running (crossroom watch ${short}).` : `Follow it in this terminal: crossroom watch ${short}`,
    `Recap once it ends: crossroom recap ${short}`,
  ];
}

/** What the person following a room reads for an event, or null for one they needn't see. Counts messages in `tally`. */
export function followLine(ev: ParleyEvent, seats: Seats, tally: { messages: number }): string | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const seat = seats.get(ev.actor);
  const who = seat ? `${slotLetter(seat.slot)}${seat.name ? ` (${line(firstLine(seat.name, 40))})` : ''}` : 'An agent';
  switch (ev.type) {
    case 'participant_joined':
      return `  ${who} joined.`;
    case 'session_started':
      return '  Every seat is taken; the room has started.';
    case 'message': {
      tally.messages++;
      const said = typeof p.text === 'string' ? line(firstLine(p.text, 100)) : '';
      if (tally.messages === 1) return `  First message, from ${who}${said ? `: ${said}` : '.'}`;
      // A running count, not every message: the browser and `crossroom watch` show them all.
      return [5, 10, 25, 50].includes(tally.messages) || (tally.messages > 50 && tally.messages % 50 === 0) ? `  ${tally.messages} messages so far.` : null;
    }
    case 'participant_finished':
      return `  ${who} finished.`;
    case 'session_ended':
      return `  The room has ended, after ${tally.messages} message${tally.messages === 1 ? '' : 's'}.`;
    default:
      return null;
  }
}

/**
 * Show a room's arrivals until it ends or `signal` stops it, through `watchRoom` (the owner's
 * stream, the token from the private link, sent as a header to the room's own origin only).
 * Answers how it stopped.
 */
export async function followRoom(
  r: NewResult,
  { fetchImpl = fetch, write = (s: string) => process.stdout.write(`${s}\n`), signal }: { fetchImpl?: typeof fetch; write?: (s: string) => void; signal?: AbortSignal } = {},
): Promise<'ended' | 'stopped' | 'lost'> {
  const target = privateLinkOf(r.watchUrl);
  if (!target) return 'lost';
  const tally = { messages: 0 };
  let ended = false;
  try {
    await watchRoom(
      { base: r.instance, id: r.roomId, owner: target.owner },
      {
        json: false,
        follow: false,
        after: 0,
        fetchImpl,
        write,
        signal,
        render: (ev, seats) => {
          if (ev.type === 'session_ended') ended = true;
          return followLine(ev, seats, tally);
        },
      },
    );
  } catch {
    if (!signal?.aborted) return 'lost';
  }
  return ended ? 'ended' : signal?.aborted ? 'stopped' : 'lost';
}

/** Follow in this terminal until the room ends or Ctrl-C, which stops following and leaves the room running. */
async function followInTerminal(r: NewResult): Promise<void> {
  const stop = new AbortController();
  const onInt = () => stop.abort();
  process.once('SIGINT', onInt);
  console.log('');
  try {
    const how = await followRoom(r, { signal: stop.signal });
    const short = r.roomId.slice(0, 8);
    if (how === 'ended') console.log(`Recap: crossroom recap ${short}`);
    else console.log(`${how === 'stopped' ? 'Stopped showing arrivals' : 'The stream closed'}. The room keeps running; follow it with crossroom watch ${short}`);
  } finally {
    process.off('SIGINT', onInt);
  }
}

/** The line a person passes on for each open seat, repeated at the end of the agent's output so it is the last thing read. */
export function sendLines(pasteLines: string[]): string[] {
  if (pasteLines.length === 1) return [`Send this to your other agent: ${pasteLines[0]}`];
  return pasteLines.map((l, i) => `Send this to ${i === 0 ? 'your other agent' : 'another agent'} (seat ${slotLetter(i + 1)}): ${l}`);
}

/** The agents `--launch` names, or null without it. */
function launchList(args: Args): string[] | null {
  if (args.flags.launch === undefined) return null;
  if (args.flags.launch === true) throw new Usage('--launch names the agents to start, as claude,codex.');
  return String(args.flags.launch).split(',').map((s) => s.trim()).filter(Boolean);
}

/** How many seats this command fills with agents in panes: sessions reopened, then agents started. */
function launchCount(args: Args): number {
  return resumeSpecs(args.flags.resume, args.values?.resume).length + (launchList(args)?.length ?? 0);
}

/**
 * The session seat A is recorded for: the one `--session` names (a plugin's skill, or `--host`),
 * else the Claude Code session this command runs in (`CLAUDE_CODE_SESSION_ID`), so its next calls
 * are `crossroom op <call>` with no link, and its `wait` holds. None outside an agent session.
 */
function seatSession(args: Args, env: NodeJS.ProcessEnv): string | null {
  return text(args.flags.session) ?? claudeSessionOf(env);
}

/**
 * Which `crossroom op` calls seat A is briefed with, if any: Codex's with `--host codex`; Claude
 * Code's when the seat is recorded for the Claude Code session this very process runs in, the one
 * `crossroom op` reads; otherwise none, and the server's curl briefing stands.
 */
function opHostOf(args: Args, session: string | null, env: NodeJS.ProcessEnv): OpHost | null {
  if (args.flags.host === 'codex') return 'codex';
  return session !== null && session === claudeSessionOf(env) ? 'claude' : null;
}

/** Seat A's briefing with `crossroom op` calls, for a room opened from a Codex or Claude Code session. */
async function opBriefing(seatUrl: string, fetchImpl: typeof fetch, host: OpHost): Promise<string> {
  const res = await fetchImpl(`${seatUrl}/join?format=json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
  }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { ok?: boolean; data?: JoinData; error?: string } | null;
  if (!body?.ok || !body.data) throw new Usage(`The room is open, but its briefing could not be read: ${body?.error ?? 'no answer'}. Run \`crossroom op join${host === 'codex' ? ' --host codex' : ''}\`.`);
  return briefing(body.data, { calls: opCalls(opSeatFlag(host)) });
}

/** Crossroom's agent as one seat of a create or an add (the web app's `houseSeatInput`). */
const houseSeat = () => ({ name: HOUSE_SEAT_NAME, kind: 'hosted', role: HOUSE_ROLE, hosted: { runner: 'api' } });

/** A refusal of Crossroom's agent, with the way on where the CLI has one. */
async function houseRefusal(res: Response, relay: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
  const said = body?.error ?? `${res.status} ${res.statusText}`;
  if (body?.code === 'HOUSE_NO_WORKSPACE') return `${said} Make your personal workspace with \`crossroom agents setup\` (or on ${relay}/w), then try again.`;
  if (body?.code === 'HOUSE_NOT_CLAIMED' || res.status === 402) return `${said} See \`crossroom credit\`.`;
  return said;
}

/**
 * `crossroom new "<topic>" --crossroom-agent` (beta): a room of two, you and Crossroom's agent, paid
 * from the signed-in account's credit (`POST /api/sessions`, with the account's token, since the
 * quick route seats no agent). An agent running the command takes seat A and gets its briefing; a
 * person at a terminal gets seat A's line to paste.
 */
export async function houseRoom(
  args: Args,
  fetchImpl: typeof fetch = fetch,
  { forPerson = false, env = process.env }: { forPerson?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<NewResult> {
  const { relay: base, token } = signedIn(args);
  if (args.flags.seats !== undefined || launchCount(args)) throw new Usage('--crossroom-agent opens a room of two, you and Crossroom\'s agent: leave out --seats, --launch and --resume, and add seats after with --add.');
  const brief = args.positional.join(' ').trim();
  const res = await reach(fetchImpl, `${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: firstLine(brief, 120).trim() || "A room with Crossroom's agent",
      mode: 'free',
      ...(brief ? { sharedBrief: brief } : {}),
      maxMessages: defaultMaxMessages(2),
      ...(args.flags.sparse === true ? { sparse: true } : {}),
      participants: [{ name: text(args.flags.name) ?? 'Seat A', kind: 'attached' }, houseSeat()],
    }),
    redirect: 'error',
  });
  if (!res.ok) throw new Usage(`${base} did not open a room with Crossroom's agent: ${await houseRefusal(res, base)}`);
  const made = (await res.json()) as {
    session: { id: string; title: string; createdAt: string };
    participants: Array<{ seatUrl?: string }>;
    ownerToken: string;
    ownerUrl: string;
  };
  const seatA = made.participants[0]?.seatUrl;
  if (!seatA) throw new Usage(`${base} answered a room without seat A: is it an older Crossroom?`);
  saveRoom({ id: made.session.id, owner: made.ownerToken, title: made.session.title, createdAt: made.session.createdAt, base, dirs: [process.cwd()] });
  const short = made.session.id.slice(0, 8);
  const result: NewResult = {
    roomId: made.session.id,
    instance: base,
    title: made.session.title,
    seatUrl: seatA,
    pasteLines: [],
    watchUrl: made.ownerUrl,
    briefing: '',
    minutes: `crossroom minutes ${short}`,
  };
  if (forPerson) return result;
  const session = seatSession(args, env);
  const joined = await fetchImpl(`${seatA}/join`, { method: 'POST', headers: { accept: 'text/markdown' }, redirect: 'error' }).catch(() => null);
  if (!joined?.ok) throw new Usage(`The room is open, but seat A's briefing could not be read. Paste this into your agent: ${pasteLine(seatA)}`);
  recordSessionSeat(session, seatA, process.cwd(), env);
  const host = opHostOf(args, session, env);
  return {
    ...result,
    briefing: host ? await opBriefing(seatA, fetchImpl, host) : await joined.text(),
    ...(host === 'claude' ? { allowRule: OP_RULE } : {}),
  };
}

/** What a person at a terminal reads after `--crossroom-agent`: where to watch, and seat A's line. */
export function houseLines(r: NewResult): string[] {
  const short = r.roomId.slice(0, 8);
  return [
    `Room "${r.title}" is open on ${instanceHost(r.instance)} (${r.roomId}), with Crossroom's agent (beta) in seat B.`,
    '',
    'Watch it in your browser (the only way back in, and private to you):',
    `  ${r.watchUrl}`,
    '',
    'Paste this line into your agent:',
    `  A  ${pasteLine(r.seatUrl)}`,
    '',
    `Or start it here in a pane: crossroom launch ${r.seatUrl}`,
    `Follow it in this terminal: crossroom watch ${short}`,
    `Recap once it ends: crossroom recap ${short}`,
    "Credit left: crossroom credit",
  ];
}

/** Crossroom's agent added to a room this machine holds the key for, paid from the signed-in account. */
export async function addHouseSeat(args: Args, fetchImpl: typeof fetch = fetch): Promise<{ roomId: string }> {
  const room = pickRoom({ ...args, positional: [String(args.flags.add)] });
  const { token } = signedIn({ ...args, flags: { ...args.flags, relay: room.base } });
  const res = await fetchImpl(`${room.base}/api/sessions/${encodeURIComponent(room.id)}/seats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-parley-owner': room.owner, authorization: `Bearer ${token}` },
    body: JSON.stringify(houseSeat()),
    redirect: 'error',
  });
  if (!res.ok) throw new Usage(`Could not add Crossroom's agent to ${room.id}: ${await houseRefusal(res, room.base)}`);
  return { roomId: room.id };
}

/** One more seat in a room this machine holds the key for. Answers the line to hand on. */
export async function addSeat(args: Args, fetchImpl: typeof fetch = fetch): Promise<{ roomId: string; seatUrl: string; pasteLine: string }> {
  const room = pickRoom({ ...args, positional: [String(args.flags.add)] });
  const name = text(args.flags.name) ?? 'Another agent';
  const res = await fetchImpl(`${room.base}/api/sessions/${encodeURIComponent(room.id)}/seats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-parley-owner': room.owner },
    body: JSON.stringify({ name, kind: 'attached' }),
    redirect: 'error',
  });
  if (!res.ok) throw new Usage(`Could not add a seat to ${room.id}: ${await errorOf(res)}`);
  const seat = (await res.json()) as { seatUrl: string };
  return { roomId: room.id, seatUrl: seat.seatUrl, pasteLine: pasteLine(seat.seatUrl) };
}

registerCommand({
  name: 'new',
  topic: 'start',
  synopsis: 'crossroom new "<topic>"',
  usage: 'crossroom new ["<what the room is for>"]',
  summary: 'open a room; you take seat A, or --launch and --resume fill the seats',
  more: [
    { usage: '[--seats <n>] [--name <you>] [--relay <url>] [--json]', summary: 'the instance: --relay, else CROSSROOM_URL, else the hosted one' },
    { usage: '[--agent]', summary: "take seat A and print its briefing (at a terminal you get every seat's line)" },
    { usage: '[--no-seat]', summary: "take no seat anywhere; every seat's line comes back (with --json, for a program, without the private link)" },
    { usage: '[--no-follow]', summary: 'at a terminal, print the lines and exit instead of showing arrivals until the room ends' },
    { usage: '[--sparse]', summary: "packets reach the others as cards they search and open (a team's shared context)" },
    { usage: '[--launch claude,codex] [--in <workbench>]', summary: 'start those agents in the seats, a pane each (see crossroom launch)' },
    { usage: '[--resume claude:<id>[,…]]', summary: 'reopen sessions already on this computer in the first of those seats (crossroom sessions)' },
    { usage: '[--session <id>]', summary: 'keep that Claude Code session in the room (the Crossroom plugin passes it)' },
    { usage: '[--no-keep]', summary: 'keep the room on this computer only; signed in to its instance, it also goes into your account' },
    { usage: '[--crossroom-agent]', summary: "(beta) you and Crossroom's agent, paid from your credit (crossroom credit); needs crossroom login" },
  ],
  order: 15,
  switches: ['sparse', 'agent', 'no-keep', 'crossroom-agent', 'no-follow', 'no-seat'],
  forms: [
    { usage: 'crossroom new --add <room> [--name <seat>]', summary: 'one more seat in a room opened here; prints its line', order: 16 },
    { usage: 'crossroom new --add <room> --crossroom-agent', summary: "(beta) Crossroom's agent joins a room opened here, on your credit", order: 16 },
  ],
  async run(args) {
    if (args.flags.add !== undefined) {
      if (args.flags.add === true) throw new Usage('--add needs the room, as `crossroom rooms` prints it.');
      if (args.flags['crossroom-agent'] === true) {
        const r = await addHouseSeat(args);
        if (args.flags.json) console.log(JSON.stringify(r, null, 2));
        else console.log(`Crossroom's agent (beta) is joining ${r.roomId.slice(0, 8)}, paid from your credit. Follow it: crossroom watch ${r.roomId.slice(0, 8)}`);
        return 0;
      }
      const r = await addSeat(args);
      if (args.flags.json) console.log(JSON.stringify(r, null, 2));
      else console.log(['A new seat. Hand it on with this line:', `  ${r.pasteLine}`].join('\n'));
      return 0;
    }
    if (args.flags['crossroom-agent'] === true) {
      const forPerson = personAtTerminal(args);
      const r = await houseRoom(args, fetch, { forPerson });
      if (args.flags.json) console.log(JSON.stringify(r, null, 2));
      else if (forPerson) console.log(houseLines(r).join('\n'));
      else
        console.log(
          [
            `Room "${r.title}" is open on ${instanceHost(r.instance)} (${r.roomId}). You hold seat A; Crossroom's agent (beta) takes seat B.`,
            '',
            `Watch it: ${r.watchUrl}`,
            `Recap once it ends: ${r.minutes}`,
            '',
            '---',
            '',
            r.briefing,
          ].join('\n'),
        );
      return 0;
    }
    // Sessions to reopen are found and checked before the room opens, so a wrong id leaves no empty room.
    const resumed = await resumedSessions(args);
    const launch = launchList(args) ?? [];
    if (args.flags['no-seat'] === true) {
      if (args.flags.agent === true || args.flags.session !== undefined || launch.length || resumed.length)
        throw new Usage('--no-seat takes no seat here: leave out --agent, --session, --launch and --resume.');
      const r = await newRoom(args, fetch, { forPerson: true });
      if (!args.flags.json) {
        console.log(personLines(r).join('\n'));
        return 0;
      }
      // For a program (a desktop bar's New room): each seat's line, and no private link. The room's
      // key stays in this computer's store, and `crossroom open <short>` opens its page.
      const { watchUrl: _key, ...rest } = r;
      console.log(JSON.stringify({ ...rest, pasteLines: (r.launchUrls ?? []).map(pasteLine), open: `crossroom open ${r.roomId.slice(0, 8)}` }, null, 2));
      return 0;
    }
    if (personAtTerminal(args)) {
      const r = await newRoom(args, fetch, { forPerson: true });
      const following = followsHere(args);
      console.log(personLines(r, { hint: launchHint(args), following }).join('\n'));
      if (following) await followInTerminal(r);
      return 0;
    }
    const r = await newRoom(args);
    const short = r.roomId.slice(0, 8);
    if (resumed.length || launch.length) {
      // The agents take every seat (no session holds A) or the seats after A, in order.
      const urls = r.launchUrls ?? r.pasteLines.map((l) => linkOfPrompt(l) ?? l);
      const firstSlot = r.launchUrls ? 0 : 1;
      const filled = urls.slice(0, resumed.length + launch.length);
      await launchSeats(filled, { ...args, flags: { ...args.flags, with: launch.join(',') || 'claude' } }, { room: short, letters: filled.map((_, i) => slotLetter(firstSlot + i)), resumed });
      const left = urls.slice(filled.length);
      if (args.flags.json) {
        console.log(JSON.stringify({ ...r, launched: filled.length }, null, 2));
        return 0;
      }
      console.log(
        [
          `Room "${r.title}" is open on ${instanceHost(r.instance)} (${r.roomId}).`,
          ...(left.length ? ['', 'Seats nobody has taken yet; hand each on with its line:', ...left.map((u) => `  ${pasteLine(u)}`)] : []),
          '',
          `Follow it here: crossroom watch ${short}`,
          `Or in the browser: crossroom open ${short}`,
          `Recap once it ends: ${r.minutes}`,
        ].join('\n'),
      );
      return 0;
    }
    if (args.flags.json) {
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    const others = r.pasteLines.map((l) => linkOfPrompt(l) ?? l);
    console.log(
      [
        `Room "${r.title}" is open on ${instanceHost(r.instance)} (${r.roomId}).`,
        '',
        ...handoffLines({ seatA: r.seatUrl, others, ownerUrl: r.watchUrl }, { joinVia: 'joined', clock: r.waitingClock ?? null, ...(r.allowRule ? { rule: r.allowRule } : {}) }),
        '',
        `Recap once it ends: ${r.minutes}`,
        '',
        '---',
        '',
        r.briefing,
        // The line the user passes on comes first above, so they hear it before the agent settles
        // into wait; it comes again last, so it is the line nobody has to dig out of the briefing.
        '',
        '---',
        '',
        ...sendLines(r.pasteLines),
      ].join('\n'),
    );
    return 0;
  },
});
