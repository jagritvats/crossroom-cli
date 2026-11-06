/**
 * `crossroom ask --each <file> "<question>" --claim "<text>"`: one room per target
 * in `<file>` (ask links, or directories for local rooms), and one table of verdicts read from
 * each room's ledger: the claim established breaks, ruled out is safe, anything else is neutral
 * (`ConsumerVerdict`). The `ask` command (builtin.ts) hands over here when it is given `--each`.
 *
 *   crossroom ask --each <file | -> "<question>" --claim "<text>"
 *       [--minutes 30] [--json] [--with claude|codex] [--model <name>] [--no-start] [--instance <url>]
 *
 * **The targets.** `<file>` is one of:
 * - a list, one target a line (`-` reads it from stdin), with blank lines and `#` comments skipped:
 *   an ask link (`https://<relay>/ask/<token>`, or plain http to this machine only), or a
 *   directory, relative to the file's own directory, for a local room like `crossroom ask <dir>`;
 * - a `.parley/consumers.yml` (a `.yml` or `.yaml` file, `ConsumersFile`), which names each ask
 *   link by the environment variable that holds it and never holds a link itself. Its `question`
 *   is used when none is given here.
 * `${consumer}` in the question and the claim becomes each target's name: the consumer's, the
 * standing seat's label as its relay describes it, or the directory's.
 *
 * **Each room** carries the claim as the owner's claim C1, with a note after the question saying
 * the verdict is read from it and asking each seat to take a position on it. An ask link's room is
 * opened with the claim in the ask itself (`POST /api/ask`), so the two are one transaction on the
 * relay. A directory's room is opened on the instance (the hosted one unless `--instance` names
 * another), the claim registered, and only then an agent of yours started on this computer in the
 * directory (commands/local-agent.ts), so it never works on a room without the claim: a room whose
 * claim does not register is ended, and no agent is started for it.
 * Seat A of every room is the asker's: its link is printed for an agent to take, and recorded for no
 * session (`crossroom seats` lists them).
 *
 * **The verdict** is `verdictOf` (consumer-check.ts) over each room's owner snapshot: the claim's
 * status, which only unanimity of at least two positions settles, and for an ask room its standing
 * seat's own stance. By default the command waits, up to `--minutes` (30), for the rooms to end,
 * then prints the table. A room still live when that time runs out is ended, as the consumer check
 * ends its rooms: a live ask room holds one of its seat's few live slots (`ASK_LIVE_MAX` on the
 * relay) against every asker of that team. Ctrl-C stops waiting and prints the table as it
 * stands, and `--minutes 0` prints it at once; both leave the rooms open for their seats to finish,
 * and the table says their verdicts can still change. It exits 1 when any verdict is `breaks`, as
 * the consumer check does.
 *
 * **What it promises:**
 * - Nothing is opened until every target and both texts have been checked: a typo on the last line
 *   costs no room. Each ask link is asked `GET /api/ask` first, which changes nothing, so a link that
 *   opens nothing, or a paused seat, is reported and never asked.
 * - No ask link or ask token is ever printed, and none is in a process's arguments or environment
 *   because of this command: a consumers file's variables are deleted from this process's
 *   environment as soon as they are read, before anything could start the background Crossroom that
 *   would inherit them. An error names a line or a variable, never a link.
 * - The table holds nothing a participant wrote: names from the file, labels the relay checked
 *   against `SEAT_LABEL`, Crossroom's claim labels and status words, and fixed sentences, each on one
 *   line (`oneLine`).
 * - At most `MAX_TARGETS` rooms a run, asked one after another, waiting out an edge's per-minute
 *   create limit rather than hammering it (`openAsk`).
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ClaimStatus, StandingSeatInfo } from '@parley/shared';
import { ASK_HEADER, type ConsumersFile, type ConsumerVerdict, SEAT_LABEL } from '@parley/shared/runner';
import { LINE_BREAK, oneLine, RUNNER_LABELS } from '@parley/shared/text';
import { type Args, askRoom, pickRunner, type SavedRoom, saveRoom, text, Usage } from '../cli.js';
import { runnerAvailability } from '../runners/hosted.js';
import { checkConfinement, startLocalAgent } from './local-agent.js';
import { DEFAULT_INSTANCE } from './instance.js';
import { chosenInstance } from './relay-call.js';
import { askLinkParts, CONSUMERS_MAX_BYTES, ConsumerCheckError, exitCodeOf, parseConsumers, standingOf, verdictOf } from '../consumer-check.js';
import { type AskIo, askBody, askRefused, call, holdsLink, NOT_USABLE, openAsk, outOf, recordSeat, saidBy, sleepOf, stdinOf } from './ask-link.js';

/** The most rooms one run opens. The playbooks' fan-out cap, and well under what an edge or a seat takes. */
export const MAX_TARGETS = 20;
/** How long the command waits for its rooms by default, and at most, in minutes. */
export const WAIT_DEFAULT_MINUTES = 30;
export const WAIT_MAX_MINUTES = 240;
/** The longest one owner `wait` asks for: the hosted instance's ceiling, under its edge's cut-off. */
const WAIT_STEP_S = 90;

// ---------------------------------------------------------------- targets

export type Target =
  | { kind: 'ask'; line: number; name: string | null; base: string; token: string }
  | { kind: 'dir'; line: number; name: string; dir: string }
  /** A consumers-file entry whose variable holds no usable link: reported, never asked. */
  | { kind: 'unset'; line: number; name: string; why: string };

const lineOf = (n: number) => `Line ${n} of the targets`;
const sameKey = (dir: string) => (process.platform === 'win32' ? dir.toLowerCase() : dir);

/** Refuse a second target that is the first again (the same ask token or directory), and too many. */
function checked(targets: Target[], where: string): Target[] {
  const seen = new Map<string, number>();
  for (const t of targets) {
    const key = t.kind === 'ask' ? `ask ${t.token}` : t.kind === 'dir' ? `dir ${sameKey(t.dir)}` : null;
    if (!key) continue;
    const before = seen.get(key);
    if (before !== undefined) throw new Usage(`${lineOf(t.line)} is the same target as line ${before}: one room per target. Nothing was opened.`);
    seen.set(key, t.line);
  }
  if (!targets.length) throw new Usage(`${where} names no targets: one ask link or directory a line. Nothing was opened.`);
  if (targets.length > MAX_TARGETS) throw new Usage(`${where} names ${targets.length} targets; one run opens at most ${MAX_TARGETS} rooms. Nothing was opened.`);
  return targets;
}

/**
 * A list of targets, one a line: an ask link, or a directory relative to `baseDir`. Blank lines and
 * `#` comments are skipped. A line it cannot use stops everything, and the message names the line,
 * never what is on it: a link in a shape nothing here recognises (a bare token, UTF-16 read as
 * UTF-8) would otherwise be printed back as a path.
 */
export function parseTargetList(body: string, baseDir: string, where = 'The targets'): Target[] {
  const targets: Target[] = [];
  // A byte-order mark in front of the first line is not part of it.
  (body.charCodeAt(0) === 0xfeff ? body.slice(1) : body)
    .split(LINE_BREAK)
    .forEach((raw, i) => {
      const line = i + 1;
      const t = raw.trim();
      if (!t || t.startsWith('#')) return;
      // A scheme, or something a link's token is in: read as a directory, it would be printed back.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || holdsLink(t)) {
        const parts = askLinkParts(t);
        if (!parts) throw new Usage(`${lineOf(line)}: ${NOT_USABLE}`);
        targets.push({ kind: 'ask', line, name: null, ...parts });
        return;
      }
      const dir = path.resolve(baseDir, t);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir)
        throw new Usage(
          /[\0\uFFFD]/.test(t)
            ? `${lineOf(line)} is not UTF-8 text. Save the targets as UTF-8 and run it again. Nothing was opened.`
            : `${lineOf(line)} is neither an ask link nor a directory (a relative one is read from ${baseDir}). Nothing was opened.`,
        );
      targets.push({ kind: 'dir', line, name: oneLine(path.basename(dir)) || dir, dir });
    });
  return checked(targets, where);
}

/**
 * A file's text: UTF-8, or UTF-16 when it opens with that byte-order mark, which is what Windows
 * PowerShell 5.1 writes for `echo $env:ORDERS_ASK > targets.txt`.
 */
export function decoded(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  // swap16 needs whole pairs: a last odd byte is not a character anyway.
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2))).swap16().toString('utf16le');
  return bytes.toString('utf8');
}

/** A consumers file's targets: each ask link from the environment variable its entry names. */
export function consumerTargets(file: ConsumersFile, env: NodeJS.ProcessEnv): Target[] {
  const targets = file.consumers.map((c, i): Target => {
    const link = env[c.ask_secret]?.trim();
    if (!link) return { kind: 'unset', line: i + 1, name: c.name, why: `${c.ask_secret} is not set here, and it is what holds this consumer's ask link.` };
    const parts = askLinkParts(link);
    if (!parts)
      return { kind: 'unset', line: i + 1, name: c.name, why: `${c.ask_secret} does not hold an ask link Crossroom can use: https://<relay>/ask/<token>, or plain http to this machine only.` };
    return { kind: 'ask', line: i + 1, name: c.name, ...parts };
  });
  return checked(targets, 'The consumers file');
}

/**
 * The targets `--each` names, and a consumers file's question. A consumers file's variables leave
 * this process's environment here, once read: a directory's agent is started in the background
 * (commands/local-agent.ts), and a child inherits the environment it is started with.
 */
export async function loadTargets(where: string, io: AskIo): Promise<{ targets: Target[]; fileQuestion: string | null }> {
  const tooBig = `The targets are larger than ${CONSUMERS_MAX_BYTES / 1024} KiB. Nothing was opened.`;
  if (where === '-') {
    const body = await stdinOf(io);
    if (body.length > CONSUMERS_MAX_BYTES) throw new Usage(tooBig);
    return { targets: parseTargetList(body, process.cwd()), fileQuestion: null };
  }
  const file = path.resolve(where);
  let body: string;
  try {
    if (statSync(file).size > CONSUMERS_MAX_BYTES) throw new Usage(tooBig);
    body = decoded(readFileSync(file));
  } catch (e) {
    if (e instanceof Usage) throw e;
    throw new Usage(`Cannot read ${file}. Nothing was opened.`);
  }
  if (!/\.ya?ml$/i.test(file)) return { targets: parseTargetList(body, path.dirname(file), path.basename(file)), fileQuestion: null };
  let consumers: ConsumersFile;
  try {
    consumers = parseConsumers(body);
  } catch (e) {
    throw new Usage(`${e instanceof ConsumerCheckError ? e.message : 'consumers.yml could not be read'}. Nothing was opened.`);
  }
  try {
    return { targets: consumerTargets(consumers, process.env), fileQuestion: consumers.question };
  } finally {
    for (const c of consumers.consumers) delete process.env[c.ask_secret];
  }
}

// ---------------------------------------------------------------- one row of the table

/** One target's row: how its room was opened, and the verdict read from its ledger. Never a token but seat A's link. */
export interface EachRow {
  target: string;
  kind: 'ask' | 'dir';
  /** False when no room was opened for it; `why` says why. */
  asked: boolean;
  room: string | null;
  /** Seat A's link: the asker's seat, for an agent to take. */
  seatUrl: string | null;
  verdict: ConsumerVerdict;
  claim: string | null;
  status: ClaimStatus | null;
  why: string;
  /** Who answered an ask room, as the relay recorded it. */
  standing: StandingSeatInfo | null;
  /** The agent CLI in a directory room's other seat. */
  runner: string | null;
  ended: boolean;
  /** What went wrong around an opened room, in a sentence: its claim, or its agent, did not take. */
  trouble: string | null;
}

const notAsked = (target: string, kind: EachRow['kind'], why: string): EachRow => ({
  target,
  kind,
  asked: false,
  room: null,
  seatUrl: null,
  verdict: 'neutral',
  claim: null,
  status: null,
  why,
  standing: null,
  runner: null,
  ended: false,
  trouble: null,
});

/** What each room is told after the question, so its seats know the claim is how it will be read. */
export const verdictNote = (claim: string) =>
  `The owner registered the claim "${oneLine(claim)}" for this room, and reads its verdict from it: once the evidence is in, each seat takes a position on it (support if it holds, oppose if it does not), and then finishes.`;

/** `${consumer}` in the question or the claim, filled with the target's name. */
export const fill = (template: string, name: string) => template.replaceAll('${consumer}', name);

// ---------------------------------------------------------------- opening a directory's room

type Runner = Parameters<typeof pickRunner>[0][number];

/** Ends a room as its owner, with Crossroom's words for why. True once it has ended, by this call or before it. */
async function endRoom(room: SavedRoom, outcome: string, io: AskIo): Promise<boolean> {
  const r = await call(io, `${room.base}/api/sessions/${encodeURIComponent(room.id)}/end`, {
    method: 'POST',
    headers: { 'x-parley-owner': room.owner },
    body: { outcome },
    timeoutMs: 15_000,
  });
  return r.status === 200;
}

/**
 * A directory's room, as `crossroom ask <dir>` opens one, with its agent started only once the
 * claim is registered. Without its claim the room has no verdict to read, and its question says the
 * owner registered one: it is ended, and no agent is started for it.
 */
async function openDirRoom(
  base: string,
  runner: Runner,
  t: Extract<Target, { kind: 'dir' }>,
  question: string,
  claim: string,
  o: { model?: string; noStart: boolean; unconfinedOk: boolean },
  io: AskIo,
  say: (line: string) => void,
): Promise<{ ok: true; room: SavedRoom; seatUrl: string; trouble: string | null } | { ok: false; why: string }> {
  const made = await call(io, `${base}/api/sessions`, { method: 'POST', body: askRoom({ dir: t.dir, question, runner }) });
  const said = (r: typeof made) => (saidBy(r) ? `: ${saidBy(r)}` : r.status ? ` (HTTP ${r.status})` : ': it did not answer');
  if (made.status !== 201) return { ok: false, why: `Crossroom refused the room${said(made)}.` };
  const j = made.json;
  const seats: any[] = Array.isArray(j?.participants) ? [...j.participants].sort((a: any, b: any) => a?.slot - b?.slot) : [];
  const [seat, other] = seats;
  if (typeof j?.session?.id !== 'string' || typeof j?.ownerToken !== 'string' || typeof seat?.seatUrl !== 'string' || typeof other?.seatUrl !== 'string')
    return { ok: false, why: 'Crossroom answered with something that is not a room.' };
  const room: SavedRoom = { id: j.session.id, owner: j.ownerToken, title: String(j.session.title ?? ''), createdAt: String(j.session.createdAt ?? new Date().toISOString()), base };
  // Kept first: whatever fails next, the room can still be ended or read.
  saveRoom(room);
  const headers = { 'x-parley-owner': room.owner };
  const at = `${base}/api/sessions/${encodeURIComponent(room.id)}`;
  const claimed = await call(io, `${at}/claims`, { method: 'POST', headers, body: { text: claim } });
  if (claimed.status !== 201) {
    const ended = await endRoom(room, 'Ended by crossroom ask --each: its claim could not be registered, so its agent was never started.', io);
    return {
      ok: false,
      why: `Its claim could not be registered${said(claimed)}, so no agent was started and its room ${ended ? 'was ended' : `could not be ended: \`crossroom end ${room.id}\` ends it`}.`,
    };
  }
  recordSeat(null, seat.seatUrl, say);
  let trouble: string | null = null;
  if (!o.noStart) {
    try {
      (io.startAgent ?? startLocalAgent)(other.seatUrl, { runtime: runner.id, label: runner.label, dir: t.dir, model: o.model, unconfinedOk: o.unconfinedOk }, { roomId: room.id, letter: 'B' });
    } catch (e) {
      trouble = `Its agent did not start: ${(e as Error).message}. \`crossroom join\` with the other seat's link starts it.`;
    }
  }
  return { ok: true, room, seatUrl: seat.seatUrl, trouble };
}

// ---------------------------------------------------------------- waiting and reading

/** Park on a room's owner `wait` until it ends, is deleted, or the deadline or `signal` comes. Moves nothing. */
async function waitRoom(room: SavedRoom, deadline: number, signal: AbortSignal, io: AskIo): Promise<'ended' | 'deleted' | 'live'> {
  for (;;) {
    const left = deadline - Date.now();
    if (signal.aborted || left <= 0) return 'live';
    const timeout = Math.min(WAIT_STEP_S, Math.max(5, Math.ceil(left / 1000)));
    const r = await call(io, `${room.base}/api/sessions/${encodeURIComponent(room.id)}/wait?timeout=${timeout}`, {
      headers: { 'x-parley-owner': room.owner },
      timeoutMs: (timeout + 30) * 1000,
      signal,
    });
    if (r.status === 404) return 'deleted';
    if (r.status === 200 && r.json?.status === 'ended') return 'ended';
    if (r.status !== 200 && !signal.aborted) await sleepOf(io)(2000);
  }
}

/** A room's verdict, from its owner snapshot (`verdictOf`). */
async function readVerdict(row: EachRow, room: SavedRoom, io: AskIo): Promise<EachRow> {
  const r = await call(io, `${room.base}/api/sessions/${encodeURIComponent(room.id)}`, { headers: { 'x-parley-owner': room.owner }, timeoutMs: 60_000 });
  const j = r.json;
  if (r.status === 404) return { ...row, why: 'The room was deleted before its verdict could be read.' };
  if (r.status !== 200 || !j?.session || !Array.isArray(j.participants) || !Array.isArray(j.claims) || !Array.isArray(j.positions))
    return { ...row, why: `Its room could not be read${r.status ? ` (HTTP ${r.status})` : ''}.` };
  const v = verdictOf(j);
  return { ...row, verdict: v.verdict, claim: v.claim, status: v.status, why: v.why, ended: v.ended, standing: row.kind === 'ask' ? standingOf(j.participants) : null };
}

// ---------------------------------------------------------------- the table

const STATUS_WORDS: Record<ClaimStatus, string> = { agreed: 'established', rejected: 'ruled out', disputed: 'disputed', open: 'open' };
const clip = (s: string, n: number) => {
  const one = oneLine(s);
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const answeredBy = (r: EachRow): string => {
  if (!r.asked) return '';
  if (r.kind === 'dir') return `${RUNNER_LABELS[r.runner ?? ''] ?? 'an agent'}, on this machine`;
  if (!r.standing) return "its team's runner";
  return `${r.standing.label}'s runner (${RUNNER_LABELS[r.standing.runtime] ?? r.standing.runtime}${r.standing.confined ? '' : ', reads not confined'})`;
};

/**
 * The table, for a person or an agent reading the terminal. Every cell is Crossroom's own words, a
 * name from the targets or a label the relay checked, on one line.
 */
export function verdictTable(rows: readonly EachRow[], claim: string): string {
  const cells = rows.map((r) => [
    clip(r.target, 40),
    r.asked ? r.verdict : 'not asked',
    r.claim && r.status ? `${r.claim} ${STATUS_WORDS[r.status]}` : '',
    clip(answeredBy(r), 60),
    r.room ? `${r.room.slice(0, 8)} ${r.ended ? 'ended' : 'live'}` : '',
  ]);
  const widths = cells.reduce((w, c) => c.map((x, i) => Math.max(w[i] ?? 0, x.length)), [] as number[]);
  const pad = (c: string[]) => `  ${c.map((x, i) => (i === c.length - 1 ? x : x.padEnd(widths[i]!))).join('  ')}`.trimEnd();
  const indent = ' '.repeat(2 + widths[0]! + 2);
  const lines = rows.flatMap((r, i) => [
    pad(cells[i]!),
    ...(r.verdict === 'neutral' ? [`${indent}${clip(r.why, 300)}`] : []),
    ...(r.trouble ? [`${indent}${clip(r.trouble, 300)}`] : []),
  ]);
  const count = (v: ConsumerVerdict) => rows.filter((r) => r.asked && r.verdict === v).length;
  const unasked = rows.filter((r) => !r.asked).length;
  const tally = [`${count('breaks')} breaks`, `${count('safe')} safe`, `${count('neutral')} neutral`, ...(unasked ? [`${unasked} not asked`] : [])].join(', ');
  const live = rows.some((r) => r.asked && r.room && !r.ended);
  return [
    `Verdicts on the claim "${clip(claim, 200)}", read from each room's ledger:`,
    '',
    ...lines,
    '',
    `${tally}.`,
    ...(live ? ["A live room's verdict can still change: `crossroom minutes <room> --wait` waits for it to end, and `crossroom end <room>` ends it."] : []),
  ].join('\n');
}

// ---------------------------------------------------------------- the command

interface Planned {
  target: Target;
  name: string;
  question: string;
  claim: string;
}

export async function askEach(args: Args, say: (line: string) => void, io: AskIo = {}): Promise<number> {
  const where = text(args.flags.each);
  if (!where) throw new Usage('Usage: crossroom ask --each <file> "<question>" --claim "<text>" [--minutes 30] [--json]');
  const claimTemplate = text(args.flags.claim)?.trim();
  if (!claimTemplate)
    throw new Usage('--each needs --claim "<text>": the claim each room is judged by (established breaks, ruled out is safe). Nothing was opened.');
  const rawMinutes = args.flags.minutes === undefined ? String(WAIT_DEFAULT_MINUTES) : text(args.flags.minutes);
  const minutes = Number(rawMinutes);
  if (!rawMinutes || !Number.isFinite(minutes) || minutes < 0 || minutes > WAIT_MAX_MINUTES)
    throw new Usage(`--minutes is how long to wait for the rooms to end, 0 to ${WAIT_MAX_MINUTES}. Nothing was opened.`);
  if (text(args.flags.session)) say('--each opens several rooms and a session holds one seat, so its seats are recorded for no session: `crossroom seats` lists them.');

  const { targets, fileQuestion } = await loadTargets(where, io);
  let questionTemplate = args.positional.join(' ').trim();
  if (!questionTemplate && fileQuestion) {
    if (fileQuestion.includes('${pr}')) throw new Usage("The consumers file's question names ${pr}: give the question here instead. Nothing was opened.");
    questionTemplate = fileQuestion;
  }
  if (!questionTemplate) throw new Usage('Usage: crossroom ask --each <file> "<question>" --claim "<text>". Nothing was opened.');

  // Every target checked before any room opens: ask links described (a GET, which changes
  // nothing), and each room's two texts checked as its server will check them.
  const rows: Array<EachRow | null> = targets.map(() => null);
  const plans: Array<Planned | null> = [];
  for (const [i, t] of targets.entries()) {
    if (t.kind === 'unset') {
      rows[i] = notAsked(t.name, 'ask', t.why);
      plans.push(null);
      continue;
    }
    let name: string;
    if (t.kind === 'dir') name = t.name;
    else {
      const info = await call(io, `${t.base}/api/ask`, { headers: { [ASK_HEADER]: t.token }, timeoutMs: 15_000 });
      const label = typeof info.json?.label === 'string' && SEAT_LABEL.test(info.json.label) ? info.json.label : null;
      name = t.name ?? label ?? `the ask link on line ${t.line}`;
      if (info.status !== 200 || info.json?.paused === true) {
        rows[i] = notAsked(name, 'ask', askRefused(info.status === 200 ? 409 : info.status, new URL(t.base).origin));
        plans.push(null);
        continue;
      }
    }
    const claim = fill(claimTemplate, name);
    const question = `${fill(questionTemplate, name)}\n\n${verdictNote(claim)}`;
    const body = askBody(question, [claim]);
    plans.push({ target: t, name, question: body.question, claim });
  }

  const dirs = plans.filter((p) => p?.target.kind === 'dir');
  let local: { base: string; runner: Runner } | null = null;
  if (dirs.length) {
    const runner = pickRunner(runnerAvailability(io.runners), text(args.flags.with));
    if (!args.flags['no-start']) checkConfinement({ runtime: runner.id, label: runner.label, unconfinedOk: args.flags['unconfined-reads-ok'] === true });
    local = { base: chosenInstance(args, DEFAULT_INSTANCE), runner };
  }

  // One room per target, one after another.
  const rooms = new Map<number, SavedRoom>();
  for (const [i, p] of plans.entries()) {
    if (!p) continue;
    const t = p.target;
    if (t.kind === 'ask') {
      const r = await openAsk(t, { question: p.question, claims: [p.claim] }, io, say);
      if (!r.ok) {
        rows[i] = notAsked(p.name, 'ask', r.why);
        continue;
      }
      saveRoom(r.opened.room);
      recordSeat(null, r.opened.seatUrl, say);
      rooms.set(i, r.opened.room);
      rows[i] = { ...notAsked(p.name, 'ask', ''), asked: true, room: r.opened.room.id, seatUrl: r.opened.seatUrl, standing: r.opened.standing };
    } else if (t.kind === 'dir' && local) {
      const r = await openDirRoom(local.base, local.runner, t, p.question, p.claim, { model: text(args.flags.model), noStart: !!args.flags['no-start'], unconfinedOk: args.flags['unconfined-reads-ok'] === true }, io, say);
      if (!r.ok) {
        rows[i] = notAsked(p.name, 'dir', r.why);
        continue;
      }
      rooms.set(i, r.room);
      rows[i] = { ...notAsked(p.name, 'dir', ''), asked: true, room: r.room.id, seatUrl: r.seatUrl, runner: local.runner.id, trouble: r.trouble };
    }
  }

  const out = outOf(io);
  const opened = [...rooms.keys()].map((i) => rows[i]!);
  // The seats first, before any waiting: nobody can take one until its link is out. Under --json,
  // stdout is kept for the one document at the end.
  const show = args.flags.json ? say : out;
  if (opened.length) {
    const width = Math.max(...opened.map((r) => clip(r.target, 40).length));
    show(
      [
        `Opened ${opened.length} room${opened.length === 1 ? '' : 's'}. Your seat in each: paste each link into an agent working on this side, or fetch it if you are that agent.`,
        ...opened.map((r) => `  ${clip(r.target, 40).padEnd(width)}  ${r.seatUrl}`),
        ...(local && dirs.length
          ? [
              args.flags['no-start']
                ? `In each directory's room the other seat's ${local.runner.label} agent was not started (--no-start): \`crossroom join <its link> --dir <dir>\` starts it.`
                : `In each directory's room a ${local.runner.label} agent takes the other seat on this computer, in that directory.`,
            ]
          : []),
      ].join('\n'),
    );
  }
  const skipped = rows.filter((r) => r && !r.asked).length;
  if (skipped) say(`${skipped} target${skipped === 1 ? ' was' : 's were'} not asked; the table says why.`);

  if (minutes > 0 && rooms.size) {
    const stop = new AbortController();
    const onInterrupt = () => stop.abort();
    // Once: a second Ctrl-C stops the command as usual.
    process.once('SIGINT', onInterrupt);
    const signal = io.signal ? AbortSignal.any([stop.signal, io.signal]) : stop.signal;
    const deadline = Date.now() + minutes * 60_000;
    say(
      `Waiting up to ${minutes} min for ${rooms.size === 1 ? 'the room' : `the ${rooms.size} rooms`} to end; any still live then is ended. Ctrl-C stops waiting and prints the verdicts so far, and leaves the rooms open.`,
    );
    let done = 0;
    try {
      await Promise.all(
        [...rooms].map(async ([i, room]) => {
          const how = await waitRoom(room, deadline, signal, io);
          if (how !== 'live') {
            say(`${clip(rows[i]!.target, 40)}: its room ${how === 'ended' ? 'ended' : 'was deleted'} (${++done} of ${rooms.size}).`);
            return;
          }
          // Ctrl-C leaves the room open. The time running out gives up on it: left live, an ask room
          // would hold its seat's live slot against every asker of that team until its clock ends it.
          if (signal.aborted) return;
          const ended = await endRoom(room, `Ended by crossroom ask --each: the seats had not settled the claim within ${minutes} minutes.`, io);
          const note = ended
            ? `Its room was ended when the ${minutes} min ran out.`
            : `Its room was still live when the ${minutes} min ran out, and could not be ended: \`crossroom end ${room.id}\` ends it.`;
          rows[i] = { ...rows[i]!, trouble: rows[i]!.trouble ? `${rows[i]!.trouble} ${note}` : note };
        }),
      );
    } finally {
      process.off('SIGINT', onInterrupt);
    }
  }

  for (const [i, room] of rooms) rows[i] = await readVerdict(rows[i]!, room, io);
  const final = rows as EachRow[];
  if (args.flags.json) out(JSON.stringify({ question: questionTemplate, claim: claimTemplate, results: final }, null, 2));
  else out(verdictTable(final, claimTemplate));
  return exitCodeOf(final.filter((r) => r.asked));
}
