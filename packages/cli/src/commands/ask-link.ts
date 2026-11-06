/**
 * `crossroom ask <ask link> "<question>"`: one room with a team's standing seat,
 * opened through its ask link (`POST /api/ask`), and seat A's link for the agent asking. The
 * `ask` command (builtin.ts) hands over here when its first word is an ask link.
 *
 *   crossroom ask https://app.crossroom.dev/ask/<token> "Do you send a null customerId?"
 *       [--claim "<text>"] [--json] [--session <id>]
 *
 * `-` in place of the link reads it from stdin, so it is not in the command's arguments, which any
 * user of the machine can list (`printenv ORDERS_ASK | crossroom ask - "…"`). `builtin.ts` hands `-`
 * over here, and `askLink` takes it.
 *
 * What it promises about the ask token:
 * - it goes only to the relay the link names, only in `x-parley-ask`, and only over HTTPS or plain
 *   HTTP to this machine (`askLinkParts`): never in a query string, and never after a redirect;
 * - it is never printed, stored or put in anything this command writes: an error says what went
 *   wrong in Crossroom's own words, and never repeats the link;
 * - this command starts no process: the room is on the relay, so no local Crossroom is needed, and no
 *   child could inherit the link from this one's arguments.
 *
 * What it keeps is what `crossroom ask <dir>` keeps: the room's owner token in `cli-rooms.json` (so
 * `crossroom minutes`, `open`, `end` and `share` work on it), and seat A's link in
 * `claude-seats.json` (so the plugin's Stop hook and `/crossroom:resume` find it). Seat B's token never
 * reaches this command: the relay seals it to the team's runner.
 *
 * The helpers below (`call`, `openAsk`, `holdsLink`) are shared with `crossroom ask --each`.
 */
import { seatPrompt } from '@parley/shared/deeplink';
import { ASK_GONE, ASK_HEADER, AskInput, SEAT_LABEL, StandingRuntime } from '@parley/shared/runner';
import type { StandingSeatInfo } from '@parley/shared';
import { firstLine, oneLine, RUNNER_LABELS } from '@parley/shared/text';
import { type Args, privateLink, recordSessionSeat, type SavedRoom, saveRoom, text, Usage } from '../cli.js';
import { askLinkParts, seatLinkToken } from '../consumer-check.js';

/**
 * Anything shaped like `…/ask/…` on a web address: what `crossroom ask` hands over here rather than
 * reading as a directory. Deliberately loose, so a link with a slash or a fragment after it still
 * lands here, where `askLinkParts` checks it and a refusal never repeats it: read as a directory,
 * it would be printed back in "… is not a directory".
 */
export const ASK_LINK = /^https?:\/\/\S*\/ask\/\S*$/i;
export const isAskLink = (word: string | undefined): boolean => !!word && ASK_LINK.test(word);

/** What `crossroom ask` says about an ask link it will not send anything to. It never repeats the link. */
export const NOT_USABLE =
  'That is not an ask link Crossroom can use: it takes https://<relay>/ask/<token>, or plain http:// to this machine only, since the token would otherwise cross the network in the clear. Nothing was sent.';

/** A Claude Code session id, as `--session` takes one: the test `recordSessionSeat` applies, made before anything is sent. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const OWNER_TOKEN = /^[A-Za-z0-9._~-]{16,256}$/;

// ---------------------------------------------------------------- talking to a relay

/** What the ask commands take besides their arguments: where results go, and, for tests, the network and the clock. */
export interface AskIo {
  /** Results: stdout by default. Progress goes to `say`, on stderr. */
  out?: (text: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Stops a wait early, as Ctrl-C does. */
  signal?: AbortSignal;
  /** Stdin, for `-`: the targets of `--each -`, or the link of `crossroom ask -`. */
  readStdin?: () => Promise<string>;
  /** Where the agent CLIs are, for `--each` with a directory: this computer's PATH by default. */
  runners?: { resolveBin?: (bin: string) => string | null };
  /** Starts the agent for a directory's seat: `startLocalAgent` (commands/local-agent.ts) by default. */
  startAgent?: (link: string, agent: { runtime: string; label: string; dir: string; model?: string; unconfinedOk?: boolean }, where: { roomId: string; letter: string }) => unknown;
}

export const outOf = (io: AskIo) => io.out ?? ((t: string) => console.log(t));

/** The most `-` reads from stdin: a list of targets (`--each -`), or one link. */
export const STDIN_MAX_BYTES = 64 * 1024;

async function processStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
    size += (c as Buffer).length;
    if (size > STDIN_MAX_BYTES) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Stdin, for `-`: so a link reaches the command without being in its arguments, where `ps` shows it. */
export async function stdinOf(io: AskIo): Promise<string> {
  const body = await (io.readStdin ?? processStdin)();
  if (body.length > STDIN_MAX_BYTES) throw new Usage(`What came on stdin is larger than ${STDIN_MAX_BYTES / 1024} KiB. Nothing was sent.`);
  return body;
}
/**
 * A pause between tries. Never unref'd: while it runs nothing else holds the process open (fetch's
 * idle sockets do not), and `cli-main.ts` would exit mid-command, code 13, "unsettled top-level await".
 */
export const sleepOf = (io: AskIo) => io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

export interface Reply {
  /** 0 when nothing answered. */
  status: number;
  /** The body as JSON, or null when it was not JSON. */
  json: any;
  retryAfter: string | null;
}

/**
 * One request to a Crossroom. Never follows a redirect: a token goes only to the address its link
 * named, and fetch keeps a header like `x-parley-ask` across one.
 */
export async function call(
  io: AskIo,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Reply> {
  const signals = [AbortSignal.timeout(init.timeoutMs ?? 30_000), ...(init.signal ? [init.signal] : [])];
  try {
    const res = await (io.fetch ?? fetch)(url, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.any(signals),
    });
    const raw = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
  } catch {
    return { status: 0, json: null, retryAfter: null };
  }
}

/** The error a Crossroom answered with, on one line and clipped, or null. Only ever printed for the user's own mistakes. */
export const saidBy = (r: Reply): string | null =>
  r.json && typeof r.json.error === 'string' && r.json.error.trim() ? oneLine(r.json.error).slice(0, 300) : null;

// ---------------------------------------------------------------- what an ask may carry

/**
 * Text that holds a Crossroom link carrying a credential: an ask link, a seat link, or a private link
 * with its key. The question and the claim go to another team's agent and into a room's record,
 * so a link pasted into one by mistake would hand that team the asker's seat, room or ask link.
 */
export const holdsLink = (s: string): boolean => /\/(?:ask|j|mcp)\/[A-Za-z0-9._~-]{16,}|#k=|[?&#]t=[A-Za-z0-9_-]{16,}/.test(s);

/** An ask's body, checked as the relay will check it, so a refusal is the user's to fix before anything is sent. */
export function askBody(question: string, claims: string[] | undefined): AskInput {
  for (const [what, s] of [['question', question], ...(claims ?? []).map((c) => ['claim', c] as const)] as const)
    if (holdsLink(s)) throw new Usage(`The ${what} holds a Crossroom link with its token in it, which the other team would read. Leave it out. Nothing was sent.`);
  const parsed = AskInput.safeParse({ question, ...(claims?.length ? { claims } : {}) });
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const field = issue.path[0] === 'claims' ? 'A claim' : 'The question';
  const size = issue.path[0] === 'claims' ? '3 to 500' : '3 to 2000';
  throw new Usage(`${field} must be ${size} characters. Nothing was sent.`);
}

// ---------------------------------------------------------------- one ask

/** A room an ask opened, as far as this command keeps it: every field checked, nothing kept that the relay made up. */
export interface OpenedAsk {
  room: SavedRoom;
  seatUrl: string;
  /** Who answers, as the relay described its seat; null where it gave nothing well-formed. */
  standing: StandingSeatInfo | null;
  online: boolean;
}

export type AskOutcome = { ok: true; opened: OpenedAsk } | { ok: false; status: number; why: string; said: string | null };

/** Why a relay would not open an ask room, by its status, in fixed words. */
export function askRefused(status: number, origin: string): string {
  switch (status) {
    case 0:
      return `The Crossroom at ${origin} did not answer.`;
    case 400:
      return 'The relay refused the question as it was sent.';
    case 404:
      return ASK_GONE;
    case 409:
      return 'Its team has paused this seat, so it is not taking questions right now.';
    case 429:
      return 'This seat, or this network, has asked as many questions as the relay takes for now. Try again later.';
    case 503:
      return "The relay cannot open the room right now: it holds as many live rooms as it takes, or the team's runner is not set up yet. Try again later.";
    default:
      return `The relay refused the ask (HTTP ${status}).`;
  }
}

/** Tries an ask may take against an edge's per-minute limit, and the longest one wait. */
const EDGE_TRIES = 6;
const EDGE_WAIT_MAX_S = 60;
const EDGE_WAIT_DEFAULT_S = 10;

/**
 * `POST /api/ask`, and the answer checked. A 429 whose body is not Crossroom's own JSON is the edge's
 * per-minute limit in front of the relay (compose.yaml's `parley-h1-create`, six a minute): it is
 * waited out, as its `Retry-After` says, a few times. Crossroom's own 429 (the seat's limits, or this
 * network's hour) is final.
 */
export async function openAsk(
  parts: { base: string; token: string },
  body: AskInput,
  io: AskIo,
  say: (line: string) => void,
): Promise<AskOutcome> {
  const origin = new URL(parts.base).origin;
  let r: Reply = { status: 0, json: null, retryAfter: null };
  for (let attempt = 1; attempt <= EDGE_TRIES; attempt++) {
    r = await call(io, `${parts.base}/api/ask`, { method: 'POST', headers: { [ASK_HEADER]: parts.token }, body, timeoutMs: 60_000 });
    const edge = r.status === 429 && !saidBy(r);
    if (!edge || attempt === EDGE_TRIES) break;
    const s = Number(r.retryAfter);
    const wait = Number.isFinite(s) && s > 0 ? Math.min(Math.ceil(s), EDGE_WAIT_MAX_S) : EDGE_WAIT_DEFAULT_S;
    say(`The relay at ${origin} takes a few asks a minute; trying again in ${wait} s.`);
    await sleepOf(io)(wait * 1000);
  }
  if (r.status !== 201) return { ok: false, status: r.status, why: askRefused(r.status, origin), said: saidBy(r) };
  const opened = readAnswer(r.json, parts.base, body.question);
  if (!opened) return { ok: false, status: r.status, why: 'The relay answered the ask with something that is not an ask room.', said: null };
  return { ok: true, opened };
}

/** The relay's answer to an ask, checked field by field (`AskResult`), or null. */
export function readAnswer(json: any, base: string, question: string): OpenedAsk | null {
  const id = json?.session?.id;
  const owner = json?.ownerToken;
  const seatUrl = json?.participants?.[0]?.seatUrl;
  if (typeof id !== 'string' || !ROOM_ID.test(id) || typeof owner !== 'string' || !OWNER_TOKEN.test(owner)) return null;
  // Seat A's link is recorded, and its Stop hook later calls the host it names: only the relay the
  // ask went to.
  if (!seatLinkToken(seatUrl, base)) return null;
  const title = typeof json.session.title === 'string' ? firstLine(json.session.title, 120) : '';
  const created = typeof json.session.createdAt === 'string' && !Number.isNaN(Date.parse(json.session.createdAt)) ? json.session.createdAt : new Date().toISOString();
  const s = json.standing;
  const runtime = StandingRuntime.safeParse(s?.runtime);
  const standing =
    s && typeof s.label === 'string' && SEAT_LABEL.test(s.label) && runtime.success ? { label: s.label, runtime: runtime.data, confined: s.confined === true } : null;
  return {
    room: { id, owner, title: title || firstLine(question, 120), createdAt: created, base },
    seatUrl,
    standing,
    online: s?.online === true,
  };
}

/**
 * Record seat A for the plugin's hooks and `crossroom seats`, once its room exists. A seat link the
 * hooks cannot use (a relay under a path prefix) is left unrecorded rather than failing a command
 * whose room is already open: the link is still printed.
 */
export function recordSeat(session: string | null, seatUrl: string, say: (line: string) => void): void {
  try {
    recordSessionSeat(session, seatUrl);
  } catch (e) {
    if (!(e instanceof Usage)) throw e;
    say('This seat was not recorded on this machine: its link is not one the Crossroom plugin can hold a session in.');
  }
}

/** Who takes the other seat, in a sentence: the seat's label, its runtime and whether its reads are confined. */
export function standingWords(standing: StandingSeatInfo | null, online: boolean): string {
  const who = standing
    ? `${standing.label}'s standing seat takes the other seat: ${RUNNER_LABELS[standing.runtime] ?? standing.runtime} on its team's machine, with its reads ${standing.confined ? 'confined to its repository' : 'not confined to its repository'}.`
    : "The team's standing seat takes the other seat.";
  return `${who} ${online ? 'Its runner is online.' : "Its team's runner is not online right now, so the seat is taken only once it is."}`;
}

// ---------------------------------------------------------------- the command

export async function askLink(args: Args, say: (line: string) => void, io: AskIo = {}): Promise<number> {
  const [given, ...words] = args.positional;
  const question = words.join(' ').trim();
  if (!given || !question) throw new Usage('Usage: crossroom ask <ask link> "<question>" [--claim "<text>"] [--json] [--session <id>]');
  // `-`: the link on stdin, its first line that is not blank.
  const link = given === '-' ? ((await stdinOf(io)).split(/\r?\n/).find((l) => l.trim()) ?? '').trim() : given;
  const parts = askLinkParts(link);
  if (!parts) throw new Usage(NOT_USABLE);
  const session = text(args.flags.session) ?? null;
  // Checked before the room exists, since a room whose seat could not be recorded would be a room
  // this machine has lost track of.
  if (session !== null && !SESSION_ID.test(session)) throw new Usage(`"${oneLine(session).slice(0, 80)}" is not a Claude Code session id. Nothing was sent.`);
  const claim = text(args.flags.claim);
  const body = askBody(question, claim === undefined ? undefined : [claim]);

  const r = await openAsk(parts, body, io, say);
  // Not "nothing was asked" when nothing answered: a request cut off part way may still have opened
  // a room, which the relay then holds under an owner token nobody kept.
  if (!r.ok) throw new Usage(`${r.why}${r.status === 400 && r.said ? ` It said: ${r.said}` : ''}`);
  const { room, seatUrl, standing, online } = r.opened;
  saveRoom(room);
  recordSeat(session, seatUrl, say);

  const out = outOf(io);
  const watchUrl = privateLink(room);
  if (args.flags.json) {
    out(JSON.stringify({ roomId: room.id, seatUrl, watchUrl, standing, online, minutes: `crossroom minutes ${room.id}` }, null, 2));
    return 0;
  }
  out(
    [
      standingWords(standing, online),
      ...(claim === undefined ? [] : ['', 'Your claim is registered as C1: the room settles it only once both seats take a position on it.']),
      '',
      'Your seat: paste this into the agent you are working with, or fetch it if you are that agent.',
      `  ${seatPrompt(seatUrl)}`,
      '',
      `Watch it: ${watchUrl}`,
      `Minutes once it ends: crossroom minutes ${room.id}`,
    ].join('\n'),
  );
  return 0;
}
