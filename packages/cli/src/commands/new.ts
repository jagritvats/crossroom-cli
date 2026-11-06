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
import { ROOM_SEATS_LIMIT, slotLetter } from '@parley/shared/text';
import { briefing, type JoinData } from '@parley/shared/render';
import { type Args, opCalls, pickRoom, recordSessionSeat, saveRoom, Usage, text } from '../cli.js';
import { handoffLines, pasteLine } from '../site/agent-guide.js';
import { registerCommand } from './index.js';
import { launchSeats, resumedSessions } from './launch.js';
import { resumeSpecs } from './local-sessions.js';
import { chosenInstance } from './relay-call.js';

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
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${res.status} ${res.statusText}`;
}

/**
 * Open the room. `forPerson`: the command was typed by a person at a terminal (`personAtTerminal`),
 * so it takes no seat itself and every seat is printed to hand to an agent.
 */
export async function newRoom(args: Args, fetchImpl: typeof fetch = fetch, { forPerson = false }: { forPerson?: boolean } = {}): Promise<NewResult> {
  const base = chosenInstance(args, DEFAULT_INSTANCE);
  const brief = args.positional.join(' ').trim();
  const seatsFlag = text(args.flags.seats);
  // `--launch a,b` and `--resume <agent>:<id>`: agents this command starts in panes, the sessions
  // reopened first. Without a session to hold seat A, they take every seat; with one, the seats after it.
  const placing = launchCount(args);
  const session = text(args.flags.session) ?? null;
  const takeA = !forPerson && (!placing || session !== null);
  const seats = seatsFlag !== undefined ? Number(seatsFlag) : placing ? Math.max(2, placing + (takeA ? 1 : 0)) : undefined;
  // The ceiling any instance allows; the instance itself refuses past its own cap (six unless raised).
  if (seats !== undefined && !(Number.isInteger(seats) && seats >= 2 && seats <= ROOM_SEATS_LIMIT))
    throw new Usage(`--seats takes a number from 2 to ${ROOM_SEATS_LIMIT}; most instances seat up to 6.`);
  const res = await fetchImpl(`${base}/api/sessions/quick`, {
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
  }).catch((e: Error) => {
    throw new Usage(`${base} did not answer (${e.message}). Check the address, or pass --relay <url>.`);
  });
  if (!res.ok) throw new Usage(`${base} did not open a room: ${await errorOf(res)}`);
  const made = (await res.json()) as {
    session: { id: string; title: string; createdAt: string };
    ownerToken: string;
    ownerUrl: string;
    seatUrls: string[];
    briefing?: string;
  };
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
    };
  }
  const [seatA, ...others] = made.seatUrls;
  if (!seatA || !others.length || made.briefing === undefined) throw new Usage(`${base} answered a room without its seats or briefing: is it an older Crossroom?`);
  // Codex runs the briefing's calls as `crossroom op` (its rules allow no curl, and its sandbox may have
  // no network), so a room opened from Codex is briefed as `crossroom op join` would brief it: join
  // again (a keep-alive that renames nothing), as data, rendered with those calls.
  const seatBrief = args.flags.host === 'codex' ? await opBriefing(seatA, fetchImpl) : made.briefing;
  saveRoom({ id: made.session.id, owner: made.ownerToken, title: made.session.title, createdAt: made.session.createdAt, base, dirs: [process.cwd()] });
  recordSessionSeat(session, seatA);
  return {
    roomId: made.session.id,
    instance: base,
    title: made.session.title,
    seatUrl: seatA,
    pasteLines: others.map(pasteLine),
    watchUrl: made.ownerUrl,
    briefing: seatBrief,
    minutes: `crossroom minutes ${made.session.id.slice(0, 8)}`,
  };
}

/**
 * Whether a person typed `crossroom new` at a terminal, rather than an agent running it through its
 * shell tool. A person gets every seat to hand on and takes none; an agent takes seat A and gets its
 * briefing. Agents' shell tools give the command no terminal; `--agent` asks for the agent's form
 * where one does (an agent in a tmux pane), and `--session` or `--host` mean a plugin ran it.
 */
export function personAtTerminal(args: Args, isTTY: boolean | undefined = process.stdout.isTTY): boolean {
  return !!isTTY && !args.flags.json && !args.flags.agent && args.flags.session === undefined && args.flags.host === undefined && launchCount(args) === 0;
}

/** The host a room's instance answers on, for the first line of what `new` prints. */
export const instanceHost = (origin: string): string => new URL(origin).host;

/** What `crossroom new` prints to a person at a terminal: where to watch, and a line for each agent. */
export function personLines(r: NewResult): string[] {
  const seats = r.launchUrls ?? [];
  return [
    `Room "${r.title}" is open on ${instanceHost(r.instance)} (${r.roomId}).`,
    '',
    'Watch it in your browser (the only way back in, and private to you):',
    `  ${r.watchUrl}`,
    '',
    'Paste one line into each agent, a seat each:',
    ...seats.map((u, i) => `  ${slotLetter(i)}  ${pasteLine(u)}`),
    '',
    `Or start agents for them here, a pane each: crossroom launch ${seats.join(' ')}`,
    `Follow it in this terminal: crossroom watch ${r.roomId.slice(0, 8)}`,
    `Recap once it ends: crossroom recap ${r.roomId.slice(0, 8)}`,
  ];
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

/** Seat A's briefing with `crossroom op` calls, for a room opened from a Codex session. */
async function opBriefing(seatUrl: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(`${seatUrl}/join?format=json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
  }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { ok?: boolean; data?: JoinData; error?: string } | null;
  if (!body?.ok || !body.data) throw new Usage(`The room is open, but its briefing could not be read: ${body?.error ?? 'no answer'}. Run \`crossroom op join --host codex\`.`);
  return briefing(body.data, { calls: opCalls('--host codex') });
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
    { usage: '[--sparse]', summary: "packets reach the others as cards they search and open (a team's shared context)" },
    { usage: '[--launch claude,codex] [--in <workbench>]', summary: 'start those agents in the seats, a pane each (see crossroom launch)' },
    { usage: '[--resume claude:<id>[,…]]', summary: 'reopen sessions already on this computer in the first of those seats (crossroom sessions)' },
    { usage: '[--session <id>]', summary: 'keep that Claude Code session in the room (the Crossroom plugin passes it)' },
    { usage: '[--no-keep]', summary: 'keep the room on this computer only; signed in to its instance, it also goes into your account' },
  ],
  order: 15,
  switches: ['sparse', 'agent', 'no-keep'],
  forms: [{ usage: 'crossroom new --add <room> [--name <seat>]', summary: 'one more seat in a room opened here; prints its line', order: 16 }],
  async run(args) {
    if (args.flags.add !== undefined) {
      if (args.flags.add === true) throw new Usage('--add needs the room, as `crossroom rooms` prints it.');
      const r = await addSeat(args);
      if (args.flags.json) console.log(JSON.stringify(r, null, 2));
      else console.log(['A new seat. Hand it on with this line:', `  ${r.pasteLine}`].join('\n'));
      return 0;
    }
    // Sessions to reopen are found and checked before the room opens, so a wrong id leaves no empty room.
    const resumed = await resumedSessions(args);
    const launch = launchList(args) ?? [];
    if (personAtTerminal(args)) {
      console.log(personLines(await newRoom(args, fetch, { forPerson: true })).join('\n'));
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
        ...handoffLines({ seatA: r.seatUrl, others, ownerUrl: r.watchUrl }, { joinVia: 'joined' }),
        '',
        `Recap once it ends: ${r.minutes}`,
        '',
        '---',
        '',
        r.briefing,
      ].join('\n'),
    );
    return 0;
  },
});
