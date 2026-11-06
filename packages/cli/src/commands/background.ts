/**
 * `crossroom background install | status | uninstall`: this
 * computer's Crossroom kept running from login, by the system's own service manager, with the
 * system's own notices.
 *
 * The two pieces stay two processes, each its own service (runner-service.ts, `Piece`):
 * - `server`, rooms on this computer (`crossroom serve`, port 4747);
 * - `runner`, the team's runner (`crossroom runner start`), the same service `crossroom runner
 *   service install` sets up, so the two commands never run it twice.
 *
 * Each holds different credentials and answers to a different peer: the server is the code the
 * hosted instance runs, open to anyone holding a room's token; the runner is outbound only and is the
 * team's egress line. A crash or a restart of one never takes the other with it, and the service
 * manager restarts each on its own. What they share is the way they are installed, inspected and
 * removed: this command.
 *
 * A third piece, `host`, ran Crossroom Code's managed chats, which is retired: a
 * computer that installed its service sees it in `status`, and `uninstall` removes it.
 *
 * `install` sets up the pieces this computer uses: the server always, the runner once it has seats.
 * `--only` names them instead. Each service's env file
 * carries `PARLEY_OS_NOTICES=1` unless `--no-notices`, and each piece then raises the system's own
 * notice about its own work (os-notice.ts).
 */
import path from 'node:path';
import { type Args, dataDir, probe, Usage } from '../cli.js';
import { loadConfig, type RunnerConfig, runnerHome } from '../runner/config.js';
import { findCommand, registerCommand } from './index.js';
import {
  HOST_PORT,
  type InstallResult,
  installService,
  installUnit,
  noticesInEnvFile,
  type Piece,
  PIECES,
  planUnit,
  readPageLink,
  realIo,
  SERVER_PORT,
  SERVICE_ENV_FILE,
  type ServiceIo,
  serviceEnvText,
  type StatusResult,
  type UninstallResult,
  type UnitTarget,
  uninstallUnit,
  unitStatus,
} from './runner-service.js';

/** The pieces `install` sets up. */
export const ALL_PIECES: readonly Piece[] = ['server', 'runner'];
/** Every piece a service may be left for: `host` is Crossroom Code's, which only `status` and `uninstall` still see. */
const EVERY_PIECE: readonly Piece[] = ['server', 'host', 'runner'];

/** Where this computer's Crossroom keeps each piece, and what is set up. */
export interface BackgroundPlace {
  dataDir: string;
  runnerHome: string;
  /** The runner's configuration, or null when there is none (or it cannot be read). */
  runner: RunnerConfig | null;
}

export const hostDir = (data: string) => path.join(data, 'managed-chats');

export function targetOf(piece: Piece, place: Pick<BackgroundPlace, 'dataDir' | 'runnerHome'>): UnitTarget {
  if (piece === 'runner') return { piece, home: place.runnerHome };
  if (piece === 'host') return { piece, home: hostDir(place.dataDir), dataDir: place.dataDir, port: HOST_PORT };
  return { piece, home: place.dataDir, dataDir: place.dataDir, port: SERVER_PORT };
}

/** `--only server,runner` as pieces, refusing a word that names none (`host` is for `uninstall` alone). */
export function onlyOf(v: string | true | undefined): Piece[] | null {
  if (v === undefined) return null;
  const words = (typeof v === 'string' ? v : '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  const bad = words.filter((w) => !EVERY_PIECE.includes(w as Piece));
  if (!words.length || bad.length) throw new Usage(`--only takes ${ALL_PIECES.join(', ')}, separated by commas${bad.length ? `; not ${bad.map((b) => JSON.stringify(b.slice(0, 40))).join(', ')}` : ''}.`);
  return [...new Set(words as Piece[])];
}

/** Which pieces `install` sets up, and why each other one is left out. */
export function chosenPieces(
  place: BackgroundPlace,
  only: Piece[] | null,
  // The server piece runs `crossroom serve`, which only the server bundle carries: the client
  // package (packages/cli) talks to an instance and sets up the runner alone.
  hasServer: boolean = findCommand('serve') !== undefined,
): { pieces: Piece[]; left: string[] } {
  if (only) {
    if (only.includes('host')) throw new Usage('`host` ran Crossroom Code, which is retired: `crossroom background uninstall --only host` removes its service.');
    if (only.includes('server') && !hasServer)
      throw new Usage('This crossroom has no server to run: it opens rooms on an instance, app.crossroom.dev unless you name another. `--only runner` sets up the runner.');
    return { pieces: ALL_PIECES.filter((p) => only.includes(p)), left: [] };
  }
  const pieces: Piece[] = hasServer ? ['server'] : [];
  const left: string[] = [];
  if (place.runner?.seats.length) pieces.push('runner');
  else left.push('The runner has no seats here; `crossroom agents setup` sets one up.');
  return { pieces, left };
}

export interface InstalledPiece {
  piece: Piece;
  result: InstallResult;
  /** Its env file and what is in it: PATH, the data directory, notices. */
  envFile: string;
  envText: string;
  /** Its log, once it runs. */
  log: string;
  /** Whether it answered within a few seconds of starting; absent for a dry run. */
  answering?: boolean;
}

export interface BackgroundInstall {
  installed: InstalledPiece[];
  left: string[];
  notices: boolean;
  dryRun: boolean;
}

export interface LiveChecks {
  server(): Promise<boolean>;
  runner(): Promise<boolean | null>;
}

/** How long `install` waits for each piece it started to answer. */
export const START_WAIT_MS = 20_000;

/** The env file a unit names (`--service-env <file>`), read from its definition: systemd's or launchd's. */
export function envFileIn(definition: string | null): string | null {
  if (!definition) return null;
  const sd = /"--service-env" "((?:[^"\\]|\\.)*)"/.exec(definition);
  if (sd) return sd[1]!.replace(/\$\$/g, '$').replace(/%%/g, '%').replace(/\\(.)/g, '$1');
  const pl = /<string>--service-env<\/string>\s*<string>([^<]*)<\/string>/.exec(definition);
  if (pl)
    return pl[1]!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  return null;
}

export async function installBackground(
  place: BackgroundPlace,
  io: ServiceIo,
  o: { only?: Piece[] | null; notices?: boolean; dryRun?: boolean; visible?: boolean; live?: LiveChecks; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<BackgroundInstall> {
  const notices = o.notices !== false;
  const { pieces, left } = chosenPieces(place, o.only ?? null);
  if (!pieces.length) throw new Usage(`Nothing to set up here. ${left.join(' ')}`.trim());
  // Everything that can refuse, before anything is written or started: a runner with no seats, and a
  // path no service can carry. An install that stopped half way would leave a piece set up unsaid.
  if (pieces.includes('runner') && !place.runner?.seats.length)
    throw new Usage(
      place.runner
        ? 'The runner has no seats yet, so its service would only stop again. Add one first: crossroom agents add <label>=<dir>. Nothing was set up.'
        : 'The runner is not set up here: `crossroom agents setup` (or `crossroom runner init`) sets it up. Nothing was set up.',
    );
  const plans = pieces.map((piece) => ({ piece, plan: planUnit(targetOf(piece, place), io, { visible: o.visible, notices }) }));
  const installed: InstalledPiece[] = [];
  const shell = 'The services read PATH and the data directory from this shell, and no other PARLEY_ setting in it (PARLEY_ROOM_SEATS_MAX, say).';
  for (const { piece, plan } of plans) {
    const envFile = plan.spec.envFile;
    const base = { piece, envFile, envText: serviceEnvText(plan.env), log: path.join(plan.spec.home, PIECES[piece].log) };
    if (piece === 'runner') {
      installed.push({ ...base, result: await installService(place.runnerHome, place.runner!, io, { dryRun: o.dryRun, visible: o.visible, notices }) });
      continue;
    }
    const notes = [
      'A Crossroom already running on port 4747 (started by `crossroom`, `crossroom ask` or VS Code) keeps the port, and the service takes over once it stops: `crossroom stop` stops one `crossroom ask` started.',
      shell,
    ];
    // One server per user, whatever the data directory: one installed for another one moves.
    const was = envFileIn(io.fs.read(plan.file));
    if (was && was !== envFile) notes.push(`${WHAT[piece]} moves to ${plan.spec.home}, from ${path.dirname(was)}; the rooms kept there stay there.`);
    const result = await installUnit(plan, io, { dryRun: o.dryRun, notes });
    if (!o.dryRun && was && was !== envFile) io.fs.remove(was);
    installed.push({ ...base, result });
  }
  if (!o.dryRun && installed.length) {
    // Started, by the service manager's word: does each answer? A piece that doesn't, says why in its log.
    const live = o.live ?? liveChecks(place);
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const until = Date.now() + (o.waitMs ?? START_WAIT_MS);
    for (const p of installed) {
      for (;;) {
        const now = await (p.piece === 'server' ? live.server() : live.runner());
        if (now || Date.now() >= until) {
          p.answering = !!now;
          break;
        }
        await sleep(500);
      }
    }
  }
  return { installed, left, notices, dryRun: !!o.dryRun };
}

export interface PieceStatus {
  piece: Piece;
  service: StatusResult;
  /** Whether the piece answers right now, however it was started; null where nothing can say. */
  answering: boolean | null;
  /** Whether its service's env file turns the system's notices on. */
  notices: boolean;
  /** The service runs, but waits for a copy started by hand, which has the port or the directory. */
  waiting: boolean;
}

/** What a service's piece says while it waits for a copy started by hand (builtin.ts). */
const WAITING = /already running(?: at \S+)?, started outside this service/;
const STARTED = /Crossroom listening on/;

/** Each piece's service, whether it answers, and whether it raises notices. */
export async function backgroundStatus(place: BackgroundPlace, io: ServiceIo, live: LiveChecks = liveChecks(place)): Promise<PieceStatus[]> {
  const out: PieceStatus[] = [];
  for (const piece of EVERY_PIECE) {
    const t = targetOf(piece, place);
    const service = await unitStatus(t, io);
    // Crossroom Code's host is shown only where its service was left behind.
    if (piece === 'host') {
      if (service.installed)
        out.push({ piece, service: { ...service, notes: [...service.notes, "It ran Crossroom Code, which is retired: `crossroom background uninstall --only host` removes it."] }, answering: null, notices: false, waiting: false });
      continue;
    }
    // The settings and log of the service installed, which may be another data directory's.
    const envFile = (piece !== 'runner' && envFileIn(io.fs.read(service.file))) || path.join(t.home, SERVICE_ENV_FILE);
    // Resolved on both sides: `PARLEY_DATA=D:/x` and the `D:\x` a path join gives are one directory.
    if (piece !== 'runner' && path.resolve(path.dirname(envFile)) !== path.resolve(t.home)) {
      service.log = path.join(path.dirname(envFile), PIECES[piece].log);
      service.tail = service.installed ? (io.fs.read(service.log) ?? '').split('\n').filter(Boolean).slice(-5) : [];
      service.notes.push(`Its service runs from ${path.dirname(envFile)}, not this shell's ${t.home}.`);
    }
    const answering = piece === 'server' ? await live.server() : await live.runner();
    const lastStart = Math.max(...service.tail.map((l, i) => (STARTED.test(l) ? i : -1)));
    const waiting = service.installed && service.state === 'running' && service.tail.some((l, i) => i > lastStart && WAITING.test(l));
    out.push({ piece, service, answering, notices: service.installed && noticesInEnvFile(io.fs.read(envFile)), waiting });
  }
  return out;
}

/**
 * Whether each piece answers: the server's health, the runner's page. Only a service's runner leaves
 * its page's link, so a runner in a terminal is unknown (null).
 */
export function liveChecks(place: BackgroundPlace, fetcher: (url: string) => Promise<{ ok: boolean }> = (u) => fetch(u, { signal: AbortSignal.timeout(1500), redirect: 'error' })): LiveChecks {
  return {
    server: async () => (await probe(SERVER_PORT)) === 'parley',
    runner: () => {
      const link = readPageLink(place.runnerHome);
      if (!link) return Promise.resolve(null);
      // The page's shell answers anyone on the loopback, key or none; a runner that died left the link.
      return fetcher(new URL(link).origin).then(
        (r) => r.ok,
        () => false,
      );
    },
  };
}

export async function uninstallBackground(place: BackgroundPlace, io: ServiceIo, o: { only?: Piece[] | null } = {}): Promise<{ piece: Piece; result: UninstallResult }[]> {
  const pieces = o.only ?? EVERY_PIECE;
  const out: { piece: Piece; result: UninstallResult }[] = [];
  for (const piece of EVERY_PIECE) if (pieces.includes(piece)) out.push({ piece, result: await uninstallUnit(targetOf(piece, place), io) });
  return out;
}

// ---------------------------------------------------------------- words

const WHAT: Record<Piece, string> = {
  server: 'rooms on this computer',
  host: 'Crossroom Code',
  runner: 'the runner',
};

const managerOf = (platform: string) => (platform === 'linux' ? 'systemd user units' : platform === 'darwin' ? 'LaunchAgents' : 'Task Scheduler tasks that start at your logon');

/** Where to look, or what to run, when a piece's service has failed or stopped. */
function nextStep(s: StatusResult): string | null {
  const unitHome = path.dirname(s.log);
  if (s.state === 'failed')
    return s.platform === 'linux'
      ? `It failed: \`journalctl --user -u ${s.name}\` and ${s.log} say why.`
      : s.platform === 'darwin'
        ? `It failed: ${path.posix.join(unitHome, 'service-output.log')} and ${s.log} say why.`
        : `It failed: ${s.log} and the task's history in Task Scheduler say why.`;
  if (s.state === 'stopped')
    return s.platform === 'linux'
      ? `Start it again with \`systemctl --user start ${s.name}\`, or log in again.`
      : s.platform === 'darwin'
        ? `Start it again with \`launchctl kickstart gui/$(id -u)/${s.name}\`, or log in again.`
        : `Start it again with \`schtasks /Run /TN "${s.name}"\`, or log on again.`;
  return null;
}

export function installText(r: BackgroundInstall): string {
  if (r.dryRun)
    return [
      ...r.installed.map(({ piece, result, envFile, envText }) =>
        [
          `${WHAT[piece]}: would write ${result.file}:`,
          '',
          result.contents.replace(/\r\n/g, '\n').trimEnd(),
          '',
          `and ${envFile} (0600):`,
          '',
          envText.trimEnd(),
          '',
          'Then run:',
          ...result.commands.map((c) => `  ${c.join(' ')}`),
        ].join('\n'),
      ),
      ...(r.left.length ? [['Left out:', ...r.left.map((l) => `  ${l}`)].join('\n')] : []),
    ].join('\n\n');
  const first = r.installed[0]?.result;
  return [
    first ? `Set up as ${managerOf(first.platform)}, started now and again at every login:` : 'Nothing was set up.',
    ...r.installed.map(({ piece, result, answering, log }) =>
      answering
        ? `  ${WHAT[piece]} (${result.name}): ${piece === 'server' ? `answering at http://127.0.0.1:${SERVER_PORT}` : 'running'}. Log: ${log}`
        : `  ${WHAT[piece]} (${result.name}): not answering yet. Its log says why: ${log}`,
    ),
    r.notices
      ? "Each tells you with the system's own notice when something waits for you: an agent's question, a packet to review. `--no-notices` turns that off."
      : 'Their notices are off; run install again without --no-notices to turn them on.',
    ...r.left,
    ...[...new Set(r.installed.flatMap(({ result }) => result.notes))],
    '`crossroom background status` says how each is doing, and `crossroom background uninstall` removes them.',
  ].join('\n');
}

export function statusText(rows: PieceStatus[]): string {
  const lines = rows.map(({ piece, service, answering, notices, waiting }) => {
    const state = !service.installed ? 'no service' : waiting ? 'running, waiting for a copy started by hand to stop' : service.state;
    const now = waiting || answering === null ? '' : answering ? ', answering' : ', not answering';
    return `  ${piece.padEnd(7)}${WHAT[piece].padEnd(24)}${state}${now}${service.installed ? `${notices ? ', notices on' : ', notices off'} (${service.name})` : ''}`;
  });
  const steps = rows.flatMap((r) => {
    if (!r.service.installed) return [];
    if (r.waiting)
      return ['  server: `crossroom stop` stops a Crossroom `crossroom ask` started; the service then takes the port.'];
    const step = nextStep(r.service);
    return step ? [`  ${r.piece}: ${step}`] : [];
  });
  const tails = rows
    .filter((r) => r.service.installed && r.service.tail.length)
    .flatMap((r) => [`Last lines of ${r.service.log}:`, ...r.service.tail.slice(-3).map((l) => `  ${l}`)]);
  const notes = [...new Set(rows.flatMap((r) => r.service.notes))];
  const none = rows.every((r) => !r.service.installed);
  return [
    "This computer's Crossroom in the background:",
    ...lines,
    ...(none ? ['Nothing runs as a service yet. `crossroom background install` sets that up.'] : []),
    ...steps,
    ...notes,
    ...tails,
  ].join('\n');
}

export function uninstallText(rows: { piece: Piece; result: UninstallResult }[]): string {
  const gone = rows.filter((r) => r.result.removed.length);
  if (!gone.length) return 'No background service was set up here; nothing to remove.';
  return [
    `Stopped and removed: ${gone.map((r) => `${WHAT[r.piece]} (${r.result.name})`).join(', ')}.`,
    'Every room and runner setting stays where it was, and so do the logs. `crossroom` and `crossroom runner start` still run each in a terminal.',
  ].join('\n');
}

// ---------------------------------------------------------------- the command

export function placeOf(env: NodeJS.ProcessEnv = process.env): BackgroundPlace {
  const home = runnerHome(env);
  let runner: RunnerConfig | null = null;
  try {
    runner = loadConfig(home);
  } catch {
    // A broken runner.yml is the runner's to report; here it means no runner to set up.
  }
  return { dataDir: dataDir(), runnerHome: home, runner };
}

export async function background(args: Args, io: ServiceIo = realIo(), place: BackgroundPlace = placeOf()): Promise<number> {
  const sub = args.positional[0] ?? 'status';
  const json = args.flags.json === true;
  const out = (v: unknown, t: string) => console.log(json ? JSON.stringify(v, null, 2) : t);
  const only = onlyOf(args.flags.only);
  if (sub === 'install') {
    const r = await installBackground(place, io, { only, notices: args.flags['no-notices'] !== true, dryRun: args.flags['dry-run'] === true, visible: args.flags.visible === true });
    out(r, installText(r));
    return 0;
  }
  if (sub === 'status') {
    const rows = await backgroundStatus(place, io);
    out(rows, statusText(rows));
    return 0;
  }
  if (sub === 'uninstall') {
    const rows = await uninstallBackground(place, io, { only });
    out(rows, uninstallText(rows));
    return 0;
  }
  throw new Usage(`Usage: ${USAGE}`);
}

const USAGE = 'crossroom background install|status|uninstall [--only server,runner] [--no-notices] [--dry-run] [--visible] [--json]';

registerCommand({
  name: 'background',
  topic: 'computer',
  usage: 'crossroom background install|status|uninstall',
  summary: "keep this computer's Crossroom running from login, with the system's own notices",
  more: [
    { usage: '[--only server,runner] [--no-notices] [--dry-run] [--visible] [--json]', summary: '--visible: on Windows, each in a window' },
    { usage: '--only runner', summary: 'the runner alone (what `crossroom runner service` also does)' },
  ],
  order: 145,
  switches: ['no-notices', 'dry-run', 'visible'],
  run: (args) => background(args),
});
