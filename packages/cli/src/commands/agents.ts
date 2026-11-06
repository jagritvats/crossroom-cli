/**
 * Your own agents from the terminal: the standing seats you run on your own
 * machines, granted to your account on the relay, set up in one step and called from
 * anywhere.
 *
 *   crossroom agents [--json]                       the agents your account may call, and the seats it may grant
 *   crossroom agents setup [--name <runner>]        your personal workspace, and this machine's runner in its team
 *   crossroom agents add <label>=<dir> [--with claude|codex|grok] [--model] [--description] [--mode ask|join] [--unconfined-reads-ok]
 *   crossroom agents grant <label> [--mode ask|join] [--off]
 *   crossroom agents notes <label> [--forget] [--json]  what an agent kept from your own calls, on this machine
 *   crossroom call <agent> "<what you need>" [--brief <text> | --brief-file <file|->] [--name <you>] [--session <id>] [--json]
 *
 * Every command acts for the account `crossroom login` signed this machine in to (`signedIn`,
 * relay-call.ts): its token goes only in the Authorization header to that relay, never after a
 * redirect, and is never printed.
 *
 * - **`setup`** makes the personal workspace if there is none (`POST /api/workspaces/personal`) and
 *   puts this machine's runner (`runner.yml` and `runner.db` under `PARLEY_RUNNER_HOME`, or
 *   `~/.parley/runner`) in its team: a runner with no identity registers with a token the team mints
 *   for it (`POST /api/teams/:t/runner-tokens`, adopted as `crossroom runner init --team-token -`
 *   would, never printed); one already registered and in no team is claimed into it with its own
 *   token (`POST /api/teams/:t/runners/claim`); one already the team's is left as it is. A runner of
 *   another relay, or of another team, is refused: its seats would leave that team.
 * - **`add`** is `crossroom runner add`, then a declaration of the runner's seats to the relay (what
 *   `crossroom runner start` does first), then the grant to the account (`POST
 *   /api/account/agents/grant`) in the mode asked for (`ask`, the default, or `join`).
 * - **`call`** opens a room with one of your agents in seat B (`POST /api/account/agents/call`,
 *   a direct call on the relay) and hands seat A to the agent you are working with. It keeps what
 *   `crossroom ask <ask link>` keeps: the owner token in `cli-rooms.json`, so `crossroom minutes`
 *   reads the answer, and seat A in `claude-seats.json` with `--session`, so the plugin's Stop hook
 *   keeps that session in the room.
 *
 * `agents`, `add` and `grant` keep your agents' names in `<data>/agents.json`, which the plugin's
 * SessionStart hook reads to tell a new session they exist. Names only: they are labels you chose.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { seatPrompt } from '@parley/shared/deeplink';
import { AGENT_CALL_BRIEF_MAX, AGENT_CALL_WHY_MAX } from '@parley/shared/agent-calls';
import { SEAT_LABEL } from '@parley/shared/runner';
import { oneLine, RUNNER_LABELS } from '@parley/shared/text';
import { type Args, privateLink, saveRoom, text, Usage, VERSION } from '../cli.js';
import { ConfigError, loadConfig, type RunnerConfig, runnerHome, seatDir } from '../runner/config.js';
import { adoptRunnerToken, ConnectError, connectRunner } from '../runner/connect.js';
import { notesOn } from '../runner/notes.js';
import { runnerPaths, RunnerStore, type SeatNoteRow } from '../runner/store.js';
import { noteAgents } from './agents-note.js';
import { holdsLink, recordSeat, stdinOf } from './ask-link.js';
import { registerCommand } from './index.js';
import { block, line } from './project-pick.js';
import { call, type FetchLike, realFetch, RelayRefused, signedIn } from './relay-call.js';
import { add as addSeat, init as initRunner } from './runner.js';

// ---------------------------------------------------------------- what the relay answers

/** One of the account's own agents, as `GET /api/account/agents` lists it. */
export interface AgentView {
  seatId: string;
  label: string;
  description: string;
  runtime: string;
  state: 'live' | 'paused' | 'offline';
  runnerReady: boolean;
  /** The runner it is declared on: labels are unique per runner only. */
  runnerId: string;
  /** `agents`: how it takes a call from an agent in your rooms. `seats`: null while it is not granted. */
  mode: 'ask' | 'join' | null;
  granted?: boolean;
}

export interface AccountAgents {
  offer: boolean;
  workspace: string | null;
  /** The personal workspace's team, where its runners register; null before there is one. */
  team?: string | null;
  /** The agents the account's rooms, and `crossroom call`, may call. */
  agents: AgentView[];
  /** Every seat of the personal workspace the account may grant to itself, granted or not. */
  seats: AgentView[];
}

/** What `POST /api/account/agents/call` answers (the relay's `DirectCallResult`). */
interface CallAnswer {
  callId: string;
  agent: string;
  session: { id: string; title: string; createdAt: string };
  ownerToken: string;
  ownerUrl: string;
  seatUrl: string;
  standing: { label: string; runtime: string; confined: boolean; online: boolean };
}

export interface AgentsIo {
  fetch?: FetchLike;
  /** The runner's home, for `setup` and `add`: `PARLEY_RUNNER_HOME` or `~/.parley/runner` by default. */
  home?: string;
  /** Stdin, for `--brief-file -`. */
  readStdin?: () => Promise<string>;
}

const fetchOf = (io: AgentsIo): FetchLike => io.fetch ?? realFetch;

// ---------------------------------------------------------------- the names a session is told

export { agentsFile, type AgentsNote, noteAgents, readAgentsNote } from './agents-note.js';

// ---------------------------------------------------------------- words

const runtimeWord = (r: string) => RUNNER_LABELS[r] ?? r;
const MODE_WORD = { ask: 'asks you first when an agent in your rooms calls it', join: 'joins when called' } as const;
const STATE_WORD = { live: 'listening', paused: 'paused', offline: 'not running' } as const;

/** One agent on one line: name, runtime, state, how it takes a call, and what it is for. */
function agentLine(a: AgentView, width: number): string {
  const how = a.mode ? `, ${MODE_WORD[a.mode]}` : '';
  const old = a.runnerReady ? '' : ' (its runner is too old to take calls: update crossroom there)';
  const what = a.description ? ` - ${oneLine(a.description).slice(0, 120)}` : '';
  return `  ${a.label.padEnd(width)}  ${runtimeWord(a.runtime)}, ${STATE_WORD[a.state] ?? a.state}${how}${old}${what}`;
}

const NOT_RUNNING = 'An agent that is not running answers once `crossroom runner start` runs on its machine.';

/** `--mode`, or undefined when it is not given: a grant then keeps the mode it has (`ask` for a new one). */
function modeOf(args: Args): 'ask' | 'join' | undefined {
  const m = text(args.flags.mode);
  if (m === undefined) return undefined;
  if (m !== 'ask' && m !== 'join') throw new Usage(`--mode takes ask (you approve each call from an agent in your rooms) or join (it joins when called); got "${oneLine(m).slice(0, 20)}".`);
  return m;
}

// ---------------------------------------------------------------- crossroom agents

export async function listAgents(args: Args, io: AgentsIo = {}): Promise<AccountAgents> {
  const { relay, token } = signedIn(args);
  const got = await call<AccountAgents>(relay, token, fetchOf(io), 'GET', '/api/account/agents');
  const answer: AccountAgents = { ...got, agents: Array.isArray(got?.agents) ? got.agents : [], seats: Array.isArray(got?.seats) ? got.seats : [] };
  noteAgents(relay, answer.agents);
  return answer;
}

export function agentsText(a: AccountAgents, relay: string): string {
  const lines: string[] = [];
  const width = Math.max(8, ...a.seats.map((s) => s.label.length), ...a.agents.map((s) => s.label.length));
  if (a.agents.length) {
    lines.push(`Your agents on ${relay}:`, ...a.agents.map((s) => agentLine(s, width)), '', 'Call one from anywhere: crossroom call <agent> "<what you need>"');
    if (a.agents.some((s) => s.state === 'offline')) lines.push(NOT_RUNNING);
  }
  const ungranted = a.seats.filter((s) => !s.granted);
  if (ungranted.length) {
    if (lines.length) lines.push('');
    lines.push(
      'Seats of your personal workspace that are not yours to call yet:',
      ...ungranted.map((s) => agentLine({ ...s, mode: null }, width)),
      '',
      'Make one callable: crossroom agents grant <label> [--mode join]',
    );
  }
  if (!lines.length)
    lines.push(
      'You have no agents yet. On the machine that will run one:',
      '  crossroom agents setup',
      '  crossroom agents add <label>=<directory> --with claude [--description "<what it is for>"] [--mode join]',
      '  crossroom runner start',
    );
  return lines.join('\n');
}

// ---------------------------------------------------------------- crossroom agents setup

interface TeamRunnerRow {
  id: string;
  revoked?: boolean;
}

/** Whether the team's runners list this one, live. A revoked runner stays listed for a while, revoked. */
const liveIn = (rows: unknown, runnerId: string) => Array.isArray(rows) && (rows as TeamRunnerRow[]).some((r) => r.id === runnerId && r.revoked !== true);
const ANOTHER_HOME = 'Give your agents a runner of their own: PARLEY_RUNNER_HOME=<another directory> crossroom agents setup';

/** This machine's runner config, or null; a config that does not parse is the user's to fix. */
function configAt(home: string): RunnerConfig | null {
  try {
    return loadConfig(home);
  } catch (e) {
    if (e instanceof ConfigError) throw new Usage(e.message);
    throw e;
  }
}

/** The runner's identity, read and closed again: null before it has one. */
function identityAt(home: string): { runnerId: string; runnerToken: string; relay: string } | null {
  if (!existsSync(runnerPaths(home).db)) return null;
  const store = RunnerStore.open(runnerPaths(home).db);
  try {
    const id = store.identity();
    return id ? { runnerId: id.runnerId, runnerToken: id.runnerToken, relay: id.relay } : null;
  } finally {
    store.close();
  }
}

const sameOrigin = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

export interface SetupResult {
  workspace: string;
  team: string;
  /** What happened to this machine's runner. */
  runner: 'registered' | 'claimed' | 'already';
  runnerId: string;
  home: string;
}

export async function setupAgents(args: Args, say: (line: string) => void, io: AgentsIo = {}): Promise<SetupResult> {
  const { relay, token } = signedIn(args);
  const f = fetchOf(io);
  const home = io.home ?? runnerHome();
  // Refused before anything is made: a runner set up for another relay would register nowhere useful.
  const before = configAt(home);
  if (before && !sameOrigin(before.relay, relay))
    throw new Usage(
      `This machine's runner (${home}) is set up for ${before.relay}, not ${relay}. Give your agents a runner of their own: PARLEY_RUNNER_HOME=<another directory> crossroom agents setup`,
    );
  const id = identityAt(home);
  if (id && !sameOrigin(id.relay, relay))
    throw new Usage(`This machine's runner (${home}) is registered with ${id.relay}, not ${relay}. Give your agents a runner of their own: PARLEY_RUNNER_HOME=<another directory> crossroom agents setup`);

  let ws: { workspace: { id: string }; leadTeamId?: string };
  try {
    ws = await call(relay, token, f, 'POST', '/api/workspaces/personal', {});
  } catch (e) {
    if (e instanceof RelayRefused && e.status === 404) throw new Usage(`${relay} has no personal workspaces turned on, so your own agents cannot be set up there.`);
    throw e;
  }
  const team = ws.leadTeamId;
  if (!team) throw new Usage(`${relay} made your personal workspace but answered no team for its runners. Try again in a moment.`);
  const cfg = before ?? initRunner(home, { relay, ...(text(args.flags.name) ? { name: text(args.flags.name)! } : {}) }, say);

  const base: SetupResult = { workspace: ws.workspace.id, team, runner: 'already', runnerId: '', home };
  if (id) {
    const theirs = await call<TeamRunnerRow[]>(relay, token, f, 'GET', `/api/teams/${encodeURIComponent(team)}/runners`);
    if (liveIn(theirs, id.runnerId)) return { ...base, runner: 'already', runnerId: id.runnerId };
    if (Array.isArray(theirs) && theirs.some((r) => r.id === id.runnerId))
      throw new Usage(`This machine's runner (${home}) was revoked from your personal workspace. ${ANOTHER_HOME}`);
    // Registered, and not this team's: it may be in no team at all, which its own token claims. That
    // moves it and every seat it declared (their ask links included) into the personal workspace, so
    // only when asked for.
    if (args.flags['move-runner'] !== true)
      throw new Usage(
        `This machine's runner (${home}) is registered with ${relay}, but not in your personal workspace. If it is in no team, \`crossroom agents setup --move-runner\` moves it there, with the seats it declared and their ask links. If it is another team's, its seats stay that team's. ${ANOTHER_HOME}`,
      );
    try {
      await call(relay, token, f, 'POST', `/api/teams/${encodeURIComponent(team)}/runners/claim`, { runnerToken: id.runnerToken });
    } catch (e) {
      if (e instanceof RelayRefused && e.status === 404)
        throw new Usage(`This machine's runner (${home}) belongs to another team, so its seats cannot become yours. ${ANOTHER_HOME}`);
      throw e;
    }
    say(`This machine's runner joined your personal workspace, with any seats it had.`);
    return { ...base, runner: 'claimed', runnerId: id.runnerId };
  }
  const minted = await call<{ runnerId: string; runnerToken: string }>(relay, token, f, 'POST', `/api/teams/${encodeURIComponent(team)}/runner-tokens`, {
    name: cfg.name,
  });
  try {
    await adoptRunnerToken({ home, config: cfg, fetch: (u, i) => f(String(u), i ?? {}), log: say, version: VERSION }, minted.runnerToken);
  } catch (e) {
    if (e instanceof ConnectError) throw new Usage(e.message);
    throw e;
  }
  return { ...base, runner: 'registered', runnerId: minted.runnerId };
}

// ---------------------------------------------------------------- crossroom agents add / grant

/**
 * Grant a seat of the personal workspace to the account, by label (and runner, from `add`), and
 * answer it as the list then shows it. With no `--mode`, a granted seat keeps its mode and a new
 * grant asks first. Two seats of one label on different machines are refused: neither is picked.
 */
async function grantByLabel(args: Args, label: string, on: boolean, m: 'ask' | 'join' | undefined, io: AgentsIo, runnerId?: string): Promise<AgentView> {
  const { relay, token } = signedIn(args);
  const f = fetchOf(io);
  const listed = await call<AccountAgents>(relay, token, f, 'GET', '/api/account/agents');
  const named = (listed.seats ?? []).filter((s) => s.label === label && (runnerId === undefined || s.runnerId === runnerId));
  if (named.length > 1)
    throw new Usage(
      `Two of your seats are labelled ${label}, on different machines. Give one another label (crossroom runner remove ${label} there, then crossroom agents add) to grant it by name.`,
    );
  const seat = named[0];
  if (!seat)
    throw new Usage(
      `No seat of your personal workspace is labelled ${oneLine(label).slice(0, 64)}. \`crossroom agents\` lists them; a seat shows there once its runner has declared it (\`crossroom agents add\`, or \`crossroom runner start\`).`,
    );
  const keep = m ?? (seat.granted && seat.mode ? seat.mode : 'ask');
  await call(relay, token, f, 'POST', '/api/account/agents/grant', { seatId: seat.seatId, on, ...(on ? { mode: keep } : {}) });
  const after = await listAgents(args, io);
  return after.seats.find((s) => s.seatId === seat.seatId) ?? { ...seat, granted: on, mode: on ? keep : null };
}

/** An ask link's line, as `declare` logs it once: a capability, printed by `crossroom agents add` nowhere. */
const ASK_LINK_LINE = /'s ask link \(shown once/;

export async function addAgent(args: Args, say: (line: string) => void, io: AgentsIo = {}): Promise<AgentView> {
  const spec = args.positional[1];
  if (!spec || !spec.includes('=')) throw new Usage('Name the agent and its directory: crossroom agents add <label>=<directory> [--with claude] [--mode join]');
  const label = spec.slice(0, spec.indexOf('=')).trim();
  const dir = spec.slice(spec.indexOf('=') + 1).trim();
  const m = modeOf(args);
  const { relay, token } = signedIn(args);
  const f = fetchOf(io);
  const home = io.home ?? runnerHome();
  const cfg0 = configAt(home);
  const id = identityAt(home);
  const NOT_SET_UP = `This machine's runner (${home}) is not in your personal workspace yet. Run \`crossroom agents setup\` first.`;
  if (!cfg0 || !id || !sameOrigin(id.relay, relay)) throw new Usage(NOT_SET_UP);
  // Checked before anything is written or declared: a runner of another team would take the seat,
  // and the directory with it, into that team.
  const listed = await call<AccountAgents>(relay, token, f, 'GET', '/api/account/agents');
  if (!listed.team) throw new Usage(NOT_SET_UP);
  if (!liveIn(await call<TeamRunnerRow[]>(relay, token, f, 'GET', `/api/teams/${encodeURIComponent(listed.team)}/runners`), id.runnerId)) throw new Usage(NOT_SET_UP);
  if ((listed.seats ?? []).some((s) => s.label === label && s.runnerId !== id.runnerId))
    throw new Usage(`You have an agent called ${label} on another machine already. Pick another label, so each can be called by name.`);
  // A seat already in runner.yml (an earlier `add` that stopped short of the grant) is declared and
  // granted as it is, but only when this asks for what it already is.
  const existing = cfg0.seats.find((s) => s.label === label);
  if (existing) {
    const wanted = { dir: path.resolve(dir), runtime: text(args.flags.with) ?? existing.runtime, description: text(args.flags.description) ?? existing.description };
    if (path.resolve(seatDir(existing, home)) !== wanted.dir || existing.runtime !== wanted.runtime || (existing.description ?? '') !== (wanted.description ?? ''))
      throw new Usage(`${label} is in this runner's runner.yml already, set up differently. To change it: crossroom runner remove ${label}, then crossroom agents add again.`);
  }
  const cfg = existing ? cfg0 : addSeat(home, spec, args, () => {});
  // Declared now, as `crossroom runner start` would first, so the seat exists to be granted. Its ask
  // link (anyone holding one can ask the agent) is left unprinted: `crossroom runner rotate` makes one.
  let conn: Awaited<ReturnType<typeof connectRunner>> | null = null;
  try {
    conn = await connectRunner({ home, config: cfg, fetch: (u, i) => f(String(u), i ?? {}), log: (l) => (ASK_LINK_LINE.test(l) ? undefined : say(l)), version: VERSION });
    await conn.declare(cfg);
  } catch (e) {
    if (e instanceof ConnectError) throw new Usage(`${label} is in runner.yml, but the relay did not take it: ${e.message}`);
    throw e;
  } finally {
    conn?.close();
  }
  return grantByLabel(args, label, true, m, io, id.runnerId);
}

// ---------------------------------------------------------------- crossroom call

/** A Claude Code session id, as `--session` takes one: the test `recordSessionSeat` applies, made before anything is sent. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface CallResult {
  roomId: string;
  agent: string;
  seatUrl: string;
  watchUrl: string;
  online: boolean;
  minutes: string;
}

export async function callAgent(args: Args, say: (line: string) => void, io: AgentsIo = {}): Promise<{ result: CallResult; standing: CallAnswer['standing'] }> {
  const [agent, ...words] = args.positional;
  const why = words.join(' ').trim();
  if (!agent || !why) throw new Usage('Usage: crossroom call <agent> "<what you need from it>" [--brief-file <file|->] [--session <id>] [--json]');
  const session = text(args.flags.session) ?? null;
  if (session !== null && !SESSION_ID.test(session)) throw new Usage(`"${oneLine(session).slice(0, 80)}" is not a Claude Code session id. Nothing was sent.`);
  if (why.length > AGENT_CALL_WHY_MAX) throw new Usage(`Say what you need in at most ${AGENT_CALL_WHY_MAX} characters, and put the rest in --brief-file. Nothing was sent.`);
  const file = text(args.flags['brief-file']);
  let brief = text(args.flags.brief) ?? null;
  if (file !== undefined) {
    if (brief !== null) throw new Usage('Give the brief once: --brief or --brief-file. Nothing was sent.');
    try {
      brief = file === '-' ? await stdinOf({ readStdin: io.readStdin }) : readFileSync(file, 'utf8');
    } catch (e) {
      if (e instanceof Usage) throw e;
      throw new Usage(`Could not read ${oneLine(file).slice(0, 120)}. Nothing was sent.`);
    }
  }
  brief = brief?.trim() || null;
  if (brief && brief.length > AGENT_CALL_BRIEF_MAX) throw new Usage(`The brief takes at most ${AGENT_CALL_BRIEF_MAX} characters. Nothing was sent.`);
  // The agent's record is the account's own, but a link in it is still a credential written down.
  for (const [what, s] of [
    ['request', why],
    ['brief', brief ?? ''],
  ] as const)
    if (holdsLink(s)) throw new Usage(`The ${what} holds a Crossroom link with its token in it. Leave it out. Nothing was sent.`);

  const { relay, token } = signedIn(args);
  const name = text(args.flags.name);
  const a = await call<CallAnswer>(relay, token, fetchOf(io), 'POST', '/api/account/agents/call', {
    agent,
    why,
    ...(brief ? { brief } : {}),
    ...(name ? { name } : {}),
  });
  if (!a?.session?.id || !a.ownerToken || !a.seatUrl) throw new Usage(`${relay} answered the call with something that is not a room.`);
  const room = { id: a.session.id, owner: a.ownerToken, title: a.session.title, createdAt: a.session.createdAt, base: relay, dirs: [process.cwd()] };
  // The relay put the room in the account as it opened it.
  saveRoom(room, { inAccount: true });
  recordSeat(session, a.seatUrl, say);
  return {
    result: { roomId: room.id, agent: a.agent, seatUrl: a.seatUrl, watchUrl: privateLink(room), online: a.standing?.online === true, minutes: `crossroom minutes ${room.id}` },
    standing: a.standing,
  };
}

export function callText(r: CallResult, standing: CallAnswer['standing']): string {
  const reads = standing.confined ? 'its reads confined to its checkout' : 'its reads not confined to its checkout';
  return [
    `${r.agent} takes the other seat: ${runtimeWord(standing.runtime)} on your own runner, with ${reads}.`,
    r.online ? 'Its runner is online.' : `Its runner is not running right now, so ${r.agent} joins once \`crossroom runner start\` runs on its machine.`,
    '',
    'Your seat: paste this into the agent you are working with, or fetch it if you are that agent.',
    `  ${seatPrompt(r.seatUrl)}`,
    '',
    `Watch it: ${r.watchUrl}`,
    `The answer, once the room ends: ${r.minutes}`,
  ].join('\n');
}

// ---------------------------------------------------------------- crossroom agents notes

export interface AgentNotes {
  label: string;
  /** Oldest first, as the runner keeps them. */
  notes: SeatNoteRow[];
  /** Whether the seat keeps notes: false when runner.yml says `notes: off`, null when this machine configures no such seat. */
  keeps: boolean | null;
  /** With `--forget`: how many went. */
  forgotten?: number;
}

/**
 * `crossroom agents notes <label> [--forget]`: what one of this machine's agents kept from the calls
 * its account made itself (runner/notes.ts), read from runner.db here and never from the relay,
 * which never has them. `--forget` clears them. A machine with no runner database has none.
 */
export function agentNotes(args: Args, home: string = runnerHome()): AgentNotes {
  const label = args.positional[1];
  if (!label || !SEAT_LABEL.test(label)) throw new Usage('Name the agent as its runner labels it: crossroom agents notes <label> [--forget] [--json]');
  const seat = configAt(home)?.seats.find((s) => s.label === label) ?? null;
  const keeps = seat ? notesOn(seat) : null;
  const forget = args.flags.forget === true;
  const db = runnerPaths(home).db;
  if (!existsSync(db)) return { label, notes: [], keeps, ...(forget ? { forgotten: 0 } : {}) };
  const store = RunnerStore.open(db);
  try {
    if (forget) return { label, notes: [], keeps, forgotten: store.forgetSeatNotes(label) };
    return { label, notes: store.seatNotes(label), keeps };
  } finally {
    store.close();
  }
}

/** The notes for a terminal: the agent wrote them, so each line goes through `line` or `block` (controls, separators and bidi overrides blanked). */
export function agentNotesText(n: AgentNotes): string {
  if (n.forgotten !== undefined)
    return n.forgotten ? `${n.label}'s ${n.forgotten} note${n.forgotten === 1 ? ' is' : 's are'} gone from this machine.` : `${n.label} kept no notes on this machine.`;
  const off = n.keeps === false ? `Notes are off for ${n.label} (notes: off in runner.yml), so it keeps no more.` : null;
  if (!n.notes.length) {
    const why =
      n.keeps === null
        ? `No agent on this machine is called ${n.label}, and none of its notes are here.`
        : `${n.label} has kept no notes yet. It keeps one each time a call you made yourself (crossroom call) ends, and reads them at the start of the next.`;
    return [why, ...(off ? [off] : [])].join('\n');
  }
  const out = [`What ${n.label} kept from your earlier calls, oldest first (on this machine only; crossroom agents notes ${n.label} --forget clears them):`, ''];
  for (const note of n.notes) {
    out.push(`${line(note.at)}  (job ${line(note.jobId).slice(0, 16)})`);
    out.push(...block(note.text).split('\n').map((l) => `    ${l}`), '');
  }
  if (off) out.push(off);
  return out.join('\n').trimEnd();
}

// ---------------------------------------------------------------- the commands

registerCommand({
  name: 'agents',
  topic: 'computer',
  usage: 'crossroom agents [--json]',
  summary: 'your own agents, and the seats you may make yours',
  order: 24,
  forms: [
    { usage: 'crossroom agents setup [--move-runner]', summary: "your personal workspace, and this machine's runner in it", order: 25 },
    { usage: 'crossroom agents add <label>=<dir> [--mode join]', summary: 'declare an agent here and make it yours (runner add flags)', order: 26 },
    { usage: 'crossroom agents grant <label> [--mode] [--off]', summary: 'change whether, and how, your rooms may call it', order: 27 },
    { usage: 'crossroom agents notes <label> [--forget]', summary: 'what it kept from your own calls, on this machine', order: 28 },
  ],
  // Not `--claim`: a switch one command declares is a switch for every command, and `crossroom ask`
  // takes `--claim <text>`.
  switches: ['off', 'move-runner'],
  async run(args, say) {
    const sub = args.positional[0];
    const out = (t: string) => console.log(t);
    if (sub === undefined || sub === 'list') {
      const a = await listAgents(args);
      out(args.flags.json ? JSON.stringify(a, null, 2) : agentsText(a, signedIn(args).relay));
      return 0;
    }
    if (sub === 'setup') {
      const r = await setupAgents(args, say);
      if (args.flags.json) out(JSON.stringify(r, null, 2));
      else
        out(
          [
            r.runner === 'already' ? "This machine's runner is already in your personal workspace." : "This machine's runner is in your personal workspace now.",
            '',
            'Next, for each agent you want listening here:',
            '  crossroom agents add <label>=<directory> --with claude [--description "<what it is for>"] [--mode join]',
            'then keep the runner running in the background, from login: crossroom runner service install',
            '(or run `crossroom runner start` in a terminal you keep open)',
          ].join('\n'),
        );
      return 0;
    }
    if (sub === 'add') {
      const a = await addAgent(args, say);
      if (args.flags.json) out(JSON.stringify(a, null, 2));
      else
        out(
          [
            `${a.label} is one of your agents now: it ${MODE_WORD[a.mode ?? 'ask']}.`,
            "It answers while this machine's runner runs: `crossroom runner service install` keeps it running in the background, from login (or `crossroom runner start` in a terminal).",
            `Call it from anywhere: crossroom call ${a.label} "<what you need>"`,
          ].join('\n'),
        );
      return 0;
    }
    if (sub === 'grant') {
      const label = args.positional[1];
      if (!label) throw new Usage('Name the agent: crossroom agents grant <label> [--mode ask|join] [--off]');
      const on = args.flags.off !== true;
      const a = await grantByLabel(args, label, on, modeOf(args), {});
      if (args.flags.json) out(JSON.stringify(a, null, 2));
      else out(on ? `${a.label} is yours to call: it ${MODE_WORD[a.mode ?? 'ask']}.` : `${a.label} can no longer be called from your rooms or with crossroom call.`);
      return 0;
    }
    if (sub === 'notes') {
      const n = agentNotes(args);
      out(args.flags.json ? JSON.stringify(n, null, 2) : agentNotesText(n));
      return 0;
    }
    throw new Usage(`Usage: crossroom agents [setup|add|grant|notes]; "${oneLine(sub).slice(0, 20)}" is not one of them.`);
  },
});

registerCommand({
  name: 'call',
  topic: 'start',
  synopsis: 'crossroom call <agent> "<need>"',
  usage: 'crossroom call <agent> "<what you need>"',
  summary: 'one of your own agents into a room, from anywhere',
  more: [
    { usage: '[--brief-file <file|->] [--name <you>] [--json]' },
    { usage: '[--session <id>]', summary: 'keep that Claude Code session in the room (the Crossroom plugin passes it)' },
  ],
  order: 23,
  async run(args, say) {
    const { result, standing } = await callAgent(args, say);
    console.log(args.flags.json ? JSON.stringify({ ...result, standing }, null, 2) : callText(result, standing));
    return 0;
  },
});
