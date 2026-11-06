/**
 * `crossroom lane`: the shortcuts for a lane (`@parley/shared/lane`) on this machine. Everything here
 * is the lane's link with less typing: an agent with nothing installed does all of it with curl.
 *
 * - `crossroom lane open ["<what>"]` opens a lane on a Crossroom others can reach, takes side A for
 *   this directory, and prints the line to paste into the other repository's agent.
 * - `crossroom lane add <link>` records a lane's link for this directory (the other side's, pasted once).
 * - `crossroom lane` (or `list`) says what needs this directory in each of its lanes.
 * - `crossroom lane pass` prints the pass of this directory's lane: what any agent runs to work it.
 * - `crossroom lane schedule [HH:MM]` prints how to run that pass every weekday, with what this
 *   machine already has. It installs nothing.
 * - `crossroom lane mirror` mirrors the lane to GitHub Issues, Linear, Jira or Azure DevOps with the
 *   person's own token (lane-mirror/), and with `--inbound` brings labelled issues and trusted
 *   comments in. `crossroom lane notify` posts what moved to Slack or Teams. `crossroom lane ci`
 *   prints both as a scheduled GitHub Actions workflow and an Azure Pipelines one.
 *
 * In CI, where no lanes.json exists, `--link` or `CROSSROOM_LANE_LINK` names the lane.
 *
 * Lanes are kept in `<data>/lanes.json`, by directory, readable by this user only: a link is that
 * side's only credential. The plugin's SessionStart hook reads the same file. No request follows a
 * redirect, since every one carries a link.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_AUTONOMY, isLaneAutonomy, type LaneAutonomy, type LaneItemsData, passPrompt, scheduleLines } from '@parley/shared/lane';
import { CI_STATE_DIR, ciRecipes } from '@parley/shared/lane-mirror';
import type { CreateSessionResult } from '@parley/shared';
import { curlRule, firstLine, laneSideNames } from '@parley/shared/text';
import { type Args, dataDir, saveRoom, text, Usage } from '../cli.js';
import { lanePasteLine } from '../site/lane-guide.js';
import { relayOrigin } from './credentials.js';
import { type Client, line, pickProject, type ProjectRef } from './project-pick.js';
import { call, chosenInstance, type FetchLike, realFetch, signedIn } from './relay-call.js';
import { type HelpLine, helpLine, registerCommand } from './index.js';
import { DEFAULT_INSTANCE } from './new.js';
import { loadMirrorConfig, trackerFor, trackerToken } from './lane-mirror/config.js';
import { httpLanePort, type MirrorSummary, mirrorOnce } from './lane-mirror/engine.js';
import { notifyOnce, notifyTarget } from './lane-mirror/notify.js';

/** One lane side this machine holds, for one directory. */
export interface SavedLane {
  /** The seat link, `<origin>/j/<token>`. */
  link: string;
  /** The directory it belongs to. */
  cwd: string;
  /** The room's id, when this machine opened it (and so holds its owner token in cli-rooms.json). */
  roomId?: string;
  at: string;
}

const LANES_KEPT = 50;
const lanesFile = () => path.join(dataDir(), 'lanes.json');

export function savedLanes(): SavedLane[] {
  try {
    const list = JSON.parse(readFileSync(lanesFile(), 'utf8'));
    return Array.isArray(list) ? (list as SavedLane[]).filter((l) => l && typeof l.link === 'string' && typeof l.cwd === 'string') : [];
  } catch {
    return [];
  }
}

const norm = (p: string) => {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** Keep a lane for a directory, newest first, one entry per link. */
export function saveLane(lane: SavedLane) {
  mkdirSync(dataDir(), { recursive: true });
  const list = [lane, ...savedLanes().filter((l) => l.link !== lane.link)].slice(0, LANES_KEPT);
  writeFileSync(lanesFile(), `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
}

/** The lanes of a directory. */
export const lanesHere = (cwd = process.cwd()) => savedLanes().filter((l) => norm(l.cwd) === norm(cwd));

/** A seat link as written, without a fragment or a trailing slash; refused unless it has a seat link's shape. */
export function laneLink(raw: string): string {
  const link = raw.trim().replace(/#.*$/, '').replace(/\/+$/, '').replace(/\/(pass|items)$/, '');
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Usage('That is not a link. A lane link looks like https://app.crossroom.dev/j/<token>.');
  }
  if (!/^\/j\/[A-Za-z0-9_-]{8,}$/.test(url.pathname)) throw new Usage('That is not a lane link: it should end in /j/<token>.');
  relayOrigin(url.origin);
  return `${url.origin}${url.pathname}`;
}

async function errorOf(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    return (JSON.parse(body) as { error?: string }).error ?? `${res.status} ${res.statusText}`;
  } catch {
    return body.trim().split('\n')[0] || `${res.status} ${res.statusText}`;
  }
}

/** What needs this side, from its `items` (a GET that moves nothing). */
export async function needsOf(link: string, fetchImpl: typeof fetch = fetch): Promise<LaneItemsData> {
  const res = await fetchImpl(`${link}/items?needs=me&format=json`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) throw new Usage(`${link} is not a lane, or not one this Crossroom has any more.`);
  if (!res.ok) throw new Usage(`${link} answered: ${await errorOf(res)}`);
  return ((await res.json()) as { data: LaneItemsData }).data;
}

export interface OpenedLane {
  roomId: string;
  link: string;
  other: string;
  watchUrl: string;
  briefing: string;
}

export async function openLane(args: Args, fetchImpl: typeof fetch = fetch): Promise<OpenedLane> {
  const base = chosenInstance(args, DEFAULT_INSTANCE);
  const brief = args.positional.slice(1).join(' ').trim();
  const autonomy = text(args.flags.autonomy);
  if (autonomy !== undefined && !isLaneAutonomy(autonomy)) throw new Usage('--autonomy is pr, branch or read.');
  const res = await fetchImpl(`${base}/api/sessions/quick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      ...(brief ? { brief } : {}),
      lane: true,
      ...(autonomy ? { autonomy } : {}),
      join: true,
      name: text(args.flags.name) ?? path.basename(process.cwd()),
    }),
    redirect: 'error',
  }).catch((e: Error) => {
    throw new Usage(`${base} did not answer (${e.message}). Check the address, or pass --relay <url>.`);
  });
  if (!res.ok) throw new Usage(`${base} did not open a lane: ${await errorOf(res)}`);
  const made = (await res.json()) as { session: { id: string; title: string; createdAt: string }; ownerToken: string; ownerUrl: string; seatUrls: string[]; briefing?: string };
  const [link, other] = made.seatUrls;
  if (!link || !other || made.briefing === undefined) throw new Usage(`${base} answered a lane without its sides or briefing: is it an older Crossroom?`);
  saveRoom({ id: made.session.id, owner: made.ownerToken, title: made.session.title, createdAt: made.session.createdAt, base, dirs: [process.cwd()] });
  saveLane({ link, cwd: process.cwd(), roomId: made.session.id, at: new Date().toISOString() });
  return { roomId: made.session.id, link, other, watchUrl: made.ownerUrl, briefing: made.briefing };
}

/** A lane opened in a project: both sides' links, and the room page the project's members open. */
export interface ProjectLane {
  roomId: string;
  project: ProjectRef;
  sides: { name: string; link: string }[];
  roomUrl: string;
}

/**
 * `crossroom lane open --project <p>`: a lane in a project (`POST /api/sessions` with `lane` and
 * `projectId`, as the project page's Start a lane sends it), made with the account's credential
 * (`crossroom login`, or `CROSSROOM_API_KEY`). Its members read it signed in; side A is recorded for
 * this directory, as a lane opened without a project is, and the owner token is kept in
 * cli-rooms.json and never printed, so a CI log carries the two sides' links and nothing more.
 */
export async function openProjectLane(args: Args, fetchImpl: FetchLike = realFetch): Promise<ProjectLane> {
  const { relay, token } = signedIn(args);
  const c: Client = { relay, token, fetchImpl };
  const topic = (text(args.flags.topic) ?? args.positional.slice(1).join(' ')).trim();
  const autonomy = text(args.flags.autonomy);
  if (autonomy !== undefined && !isLaneAutonomy(autonomy)) throw new Usage('--autonomy is pr, branch or read.');
  const p = await pickProject(c, text(args.flags.project), text(args.flags.workspace));
  const title = firstLine(topic) || 'Async lane';
  const names = laneSideNames(title);
  const made = await call<CreateSessionResult & { ownerToken: string }>(relay, token, fetchImpl, 'POST', '/api/sessions', {
    title,
    mode: 'free',
    sharedBrief: topic,
    maxMessages: 40,
    participants: names.map((name, n) => ({ name, kind: 'attached', ...(n === 0 && autonomy ? { autonomy } : {}) })),
    lane: true,
    projectId: p.id,
  });
  const sides = made.participants.map((x) => ({ name: x.name, link: x.seatUrl }));
  if (sides.length !== 2) throw new Usage(`${relay} answered a lane without its two sides: is it an older Crossroom?`);
  saveRoom({ id: made.session.id, owner: made.ownerToken, title: made.session.title, createdAt: made.session.createdAt, base: relay, dirs: [process.cwd()] });
  saveLane({ link: sides[0]!.link, cwd: process.cwd(), roomId: made.session.id, at: new Date().toISOString() });
  return { roomId: made.session.id, project: p, sides, roomUrl: `${relay}/s/${made.session.id}` };
}

/** What `crossroom lane open --project` prints: both sides' links, the first for this directory. */
export function projectLaneLines(r: ProjectLane, cwd: string): string[] {
  const [a, b] = r.sides;
  return [
    `Opened a lane (${r.roomId}) in ${line(r.project.name)}. Its members open it signed in: ${r.roomUrl}`,
    '',
    `${line(a!.name)}'s link, recorded for ${cwd} (keep it private: it is that side's only key):`,
    `  ${a!.link}`,
    `${line(b!.name)}: paste this line into the other repository's agent, once:`,
    `  ${lanePasteLine(b!.link)}`,
    '',
    'Next:',
    '  crossroom lane pass       what your agent runs to work the lane',
    '  crossroom lane schedule   how to run that pass every weekday',
  ];
}

/** The lane of this directory a command acts on: `--link`, else the newest one recorded here. */
function laneOf(args: Args): string {
  const given = text(args.flags.link) ?? process.env.CROSSROOM_LANE_LINK;
  if (given) return laneLink(given);
  const here = lanesHere();
  if (!here.length) throw new Usage('This directory has no lane. `crossroom lane open` opens one, and `crossroom lane add <link>` records one you were given.');
  return here[0]!.link;
}

/** `HH:MM` as cron and Task Scheduler take it. */
function timeOf(raw: string | undefined): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw ?? '18:30');
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Usage('Give the time as HH:MM, e.g. 18:30.');
  return { h: Number(m[1]), m: Number(m[2]) };
}

/** `--every <seconds>`: run again after that long, at least a minute; absent, once. */
function everyOf(args: Args): number | null {
  const v = text(args.flags.every);
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 60) throw new Usage('--every is a number of seconds, 60 or more.');
  return n * 1000;
}

/** `once`, then again every `every` ms. A failed run of a repeating loop is logged and the loop goes on: a tracker or lane that is down for a minute must not end it. */
export async function repeat(every: number | null, once: () => Promise<void>, log: (line: string) => void = (l) => console.error(l), sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
  for (;;) {
    try {
      await once();
    } catch (e) {
      if (every === null) throw e;
      log(`${new Date().toISOString()} this run failed, trying again in ${Math.round(every / 1000)} s: ${(e as Error).message}`);
    }
    if (every === null) return;
    await sleep(every);
  }
}

/** What `crossroom lane open` prints for the person at the terminal; the agent's briefing only with `--briefing`. */
export function openedLines(r: OpenedLane, cwd: string, briefing: boolean): string[] {
  return [
    `Opened a lane (${r.roomId}) and took side A for ${cwd}.`,
    '',
    "Side A's link, yours, recorded for this directory (keep it private: it is side A's only key):",
    `  ${r.link}`,
    "Paste this line into the other repository's agent, once:",
    `  ${lanePasteLine(r.other)}`,
    `Watch the lane (private to you, and the only way back in): ${r.watchUrl}`,
    '',
    'Next:',
    '  crossroom lane pass       what your agent runs to work the lane',
    '  crossroom lane schedule   how to run that pass every weekday',
    ...(briefing ? ['', '---', '', r.briefing] : ['', "`crossroom lane open --briefing` also prints side A's briefing, for an agent."]),
  ];
}

/** The line above a pass, for the person: the pass itself is written for an agent. */
export const passHead = (link: string) => {
  const prompt = passPrompt(`${link}/pass`);
  return `This is your agent's pass. Run it with: claude -p "${prompt}" (or paste "${prompt}" into your agent).`;
};

/** What `crossroom lane list` prints for one lane: who this side is and what needs it, then its link, labelled. */
export function listHead(link: string, d: LaneItemsData): string[] {
  const needs = d.needs.length;
  return [
    `Side ${d.me}: ${needs} item${needs === 1 ? ' needs' : 's need'} you, ${d.counts.open} open in all, ${d.counts.closed} closed.`,
    `Side ${d.me}'s link (keep it private): ${link}`,
  ];
}

/**
 * The command that runs this repository's tests, for the schedule's allowlist: `npm test`, `make
 * test`, `pytest`, `cargo test` or `go test ./...`, by the files that say so, or null.
 */
export function detectTestCommand(cwd: string): string | null {
  const read = (f: string) => {
    try {
      return readFileSync(path.join(cwd, f), 'utf8');
    } catch {
      return null;
    }
  };
  const pkg = read('package.json');
  if (pkg) {
    try {
      const t = (JSON.parse(pkg) as { scripts?: { test?: unknown } }).scripts?.test;
      // npm init's placeholder runs no tests.
      if (typeof t === 'string' && t.trim() && !/no test specified/.test(t)) return 'npm test';
    } catch {
      // Not JSON: look further.
    }
  }
  for (const f of ['Makefile', 'makefile', 'GNUmakefile']) if (/^test\s*:/m.test(read(f) ?? '')) return 'make test';
  const py = read('pyproject.toml');
  if (existsSync(path.join(cwd, 'pytest.ini')) || /\bpytest\b/.test(py ?? '') || /\[tool:pytest\]/.test(read('setup.cfg') ?? '') || (py !== null && existsSync(path.join(cwd, 'tests')))) return 'pytest';
  if (existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(path.join(cwd, 'go.mod'))) return 'go test ./...';
  return null;
}

const TEST_PLACEHOLDER = '<your test command>';

/** `crossroom lane schedule`: this platform's lines (and the agent app's), with the repository and its test command filled in. */
export function scheduleText(link: string, autonomy: LaneAutonomy, at: { h: number; m: number }, cwd: string, platform: NodeJS.Platform = process.platform): string {
  const hhmm = `${String(at.h).padStart(2, '0')}:${String(at.m).padStart(2, '0')}`;
  const test = detectTestCommand(cwd);
  const lines = scheduleLines(`${link}/pass`, curlRule(link), autonomy)
    .filter((l) => (platform === 'win32' ? !l.startsWith('- Claude Code from cron') : !l.startsWith('- Windows Task Scheduler')))
    .map((l) => l.replace('30 18 * * 1-5', `${at.m} ${at.h} * * 1-5`).replace('/st 18:30', `/st ${hhmm}`).replace('at 18:30', `at ${hhmm}`))
    .map((l) => l.replaceAll('<repo>', cwd))
    .map((l) => (test ? l.replaceAll(TEST_PLACEHOLDER, test) : l));
  const missing = lines.some((l) => l.includes(TEST_PLACEHOLDER))
    ? [`No test command was found here (package.json, Makefile, pyproject.toml, Cargo.toml or go.mod): replace ${TEST_PLACEHOLDER} with the one that runs this repository's tests.`]
    : [];
  return [`Run this lane's pass every weekday at ${hhmm} with any one of these. Nothing is installed for you.`, ...lines, ...missing].join('\n');
}

/** The tracker's token; a dry run is told it needs one too, since it still reads the tracker. */
export function tokenFor(provider: Parameters<typeof trackerToken>[0], dryRun: boolean, env: NodeJS.ProcessEnv = process.env) {
  try {
    return trackerToken(provider, env);
  } catch (e) {
    if (dryRun && e instanceof Usage) throw new Usage(`${e.message} A dry run still reads the tracker, so it needs the token too.`);
    throw e;
  }
}

/** What a notify run says it did. A Teams Workflow answers 202 before it posts, so its word is "accepted". */
export const notifyLine = (posted: number, kind: 'slack' | 'teams') =>
  posted && kind === 'teams'
    ? `${posted} change${posted === 1 ? '' : 's'} accepted by Teams; Teams reports delivery failures in the flow's run history.`
    : `${posted} change${posted === 1 ? '' : 's'} posted.`;

const summaryLine = (s: MirrorSummary) =>
  [
    `${s.created} issue${s.created === 1 ? '' : 's'} made, ${s.updated} updated, ${s.commented} comment${s.commented === 1 ? '' : 's'}`,
    s.filedIn || s.notesIn ? `${s.filedIn} filed in, ${s.notesIn} note${s.notesIn === 1 ? '' : 's'} in` : '',
    s.untrusted ? `${s.untrusted} from people without write access left out` : '',
    s.trailers ? `${s.trailers} marked fixed by commit trailers` : '',
  ]
    .filter(Boolean)
    .join('; ');

/** The CI recipes are shared with the web app's Connect your tools dialog (`@parley/shared/lane-mirror`). */
export { CI_STATE_DIR, ciRecipes };

const USAGE = 'crossroom lane [list|open|add|pass|schedule|mirror|notify|ci]';
const SUMMARY = 'items you file for another repository, worked on its next pass';
const MORE: HelpLine[] = [
  { usage: 'open ["<what>"] [--autonomy pr|branch|read] [--briefing]', summary: 'open a lane for this directory; prints the line for the other side' },
  { usage: 'open --project <p> [--topic "<what>"]', summary: 'the same, in a project, with your account' },
  { usage: 'add <link>', summary: 'record the lane link you were given for this directory' },
  { usage: 'pass | schedule [HH:MM]', summary: "this directory's pass, and how to run it every weekday" },
  { usage: 'mirror [--inbound] [--dry-run] [--every <s>]', summary: 'mirror to GitHub, Linear, Jira or Azure DevOps' },
  { usage: 'notify --slack|--teams <url> [--titles]', summary: 'post what moved to Slack or Teams' },
  { usage: 'ci', summary: 'the mirror and notify as scheduled CI jobs' },
];

/** `crossroom lane help`: the lane command's own lines, not the whole program's. */
export const laneHelp = () => [helpLine({ usage: USAGE, summary: SUMMARY }), ...MORE.map((l) => helpLine(l, '        '))].join('\n');

registerCommand({
  name: 'lane',
  topic: 'lanes',
  usage: USAGE,
  summary: SUMMARY,
  more: MORE,
  switches: ['inbound', 'dry-run', 'titles', 'briefing'],
  help: laneHelp,
  order: 47,
  async run(args) {
    const action = args.positional[0] ?? 'list';
    switch (action) {
      case 'help':
        console.log(laneHelp());
        return 0;
      case 'open': {
        if (args.flags.project !== undefined) {
          const p = await openProjectLane(args);
          console.log(args.flags.json ? JSON.stringify(p, null, 2) : projectLaneLines(p, process.cwd()).join('\n'));
          return 0;
        }
        const r = await openLane(args);
        if (args.flags.json) {
          console.log(JSON.stringify(r, null, 2));
          return 0;
        }
        console.log(openedLines(r, process.cwd(), args.flags.briefing === true).join('\n'));
        return 0;
      }
      case 'add': {
        const raw = args.positional[1];
        if (!raw) throw new Usage('crossroom lane add <link>: the lane link you were given.');
        const link = laneLink(raw);
        const d = await needsOf(link);
        saveLane({ link, cwd: process.cwd(), at: new Date().toISOString() });
        console.log(
          `Recorded side ${d.me} of a lane for ${process.cwd()}. ${d.needs.length ? `${d.needs.length} item${d.needs.length === 1 ? ' needs' : 's need'} you: \`crossroom lane\` lists them.` : 'Nothing needs you yet.'}`,
        );
        return 0;
      }
      case 'list': {
        const lanes = args.flags.link ? [{ link: laneOf(args) }] : lanesHere();
        if (!lanes.length) {
          console.log('This directory has no lane. `crossroom lane open` opens one, and `crossroom lane add <link>` records one you were given.');
          return 0;
        }
        for (const l of lanes) {
          const d = await needsOf(l.link).catch((e: Error) => e);
          if (d instanceof Error) {
            console.log(`A lane link (keep it private): ${l.link}\n${d.message}\n`);
            continue;
          }
          const res = await fetch(`${l.link}/items`, { redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => null);
          console.log(`${listHead(l.link, d).join('\n')}\n\n${res?.ok ? await res.text() : `did not answer${res ? `: ${await errorOf(res)}` : ''}`}\n`);
        }
        return 0;
      }
      case 'pass': {
        const link = laneOf(args);
        const res = await fetch(`${link}/pass`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Usage(`${link} answered: ${await errorOf(res)}`);
        console.log(`${passHead(link)}\n\n${await res.text()}`);
        return 0;
      }
      case 'schedule': {
        const link = laneOf(args);
        const d = await needsOf(link);
        console.log(scheduleText(link, d.autonomy ?? DEFAULT_AUTONOMY, timeOf(args.positional[1]), process.cwd()));
        return 0;
      }
      case 'mirror': {
        const link = laneOf(args);
        const cwd = process.cwd();
        const config = loadMirrorConfig(cwd, args.flags, existsSync(path.join(cwd, '.git')));
        const tracker = trackerFor({ config, ...tokenFor(config.provider, args.flags['dry-run'] === true) });
        const lane = httpLanePort(link);
        await repeat(everyOf(args), async () => {
          const s = await mirrorOnce({ lane, tracker, config, dataDir: dataDir(), cwd, dryRun: args.flags['dry-run'] === true });
          if (args.flags.json) console.log(JSON.stringify(s));
          else {
            console.log(`${args.flags['dry-run'] ? 'Would have: ' : ''}${summaryLine(s)}.`);
            for (const w of s.warnings) console.log(`  ${w}`);
          }
        });
        return 0;
      }
      case 'notify': {
        const link = laneOf(args);
        const target = notifyTarget(args.flags);
        const lane = httpLanePort(link);
        await repeat(everyOf(args), async () => {
          const r = await notifyOnce({ lane, target, dataDir: dataDir(), titles: args.flags.titles === true });
          console.log(r.primed ? 'First run: noted where the lane stands. Later runs post what moved.' : notifyLine(r.posted, target.kind));
        });
        return 0;
      }
      case 'ci':
        console.log(ciRecipes());
        return 0;
      default:
        throw new Usage('crossroom lane [list|open|add|pass|schedule|mirror|notify|ci]');
    }
  },
});
