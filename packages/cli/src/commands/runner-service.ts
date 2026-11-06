/**
 * `crossroom runner service install | status | uninstall`: the runner as a
 * background service of this user's own, so the agents keep listening after the terminal closes,
 * after a log-out where the system allows it, and after a reboot.
 *
 * Per user, never system-wide: the agents' CLIs keep their sign-ins (`claude login`, `codex
 * login`) in the user's home, and a runner run as another account would find none of them.
 *
 * - **Linux:** a systemd user unit, `$XDG_CONFIG_HOME/systemd/user/<id>.service` (`~/.config` when
 *   unset), enabled and started with `systemctl --user`. `KillMode=mixed`: stopping it sends SIGTERM
 *   to the runner alone, which drains its jobs (as Ctrl-C does), rather than to every agent CLI in
 *   the unit's control group at once. A user unit stops at log-out unless lingering is on, which
 *   needs root: `status` says so and prints the line, and nothing here runs `sudo`.
 * - **macOS:** a LaunchAgent, `~/Library/LaunchAgents/<label>.plist`, loaded with `launchctl
 *   bootstrap gui/<uid>` and restarted when it exits with a failure (`KeepAlive.SuccessfulExit`).
 *   `ExitTimeOut` gives a draining runner as long as systemd's `TimeoutStopSec`.
 * - **Windows:** a Task Scheduler task that starts at this user's logon, in their own session
 *   (`InteractiveToken`: no password stored, the user's network and DPAPI secrets available), with
 *   restart on failure and no time limit, registered from an XML definition (`schtasks /Create
 *   /XML`). A console program started by a logon task gets a window, and Windows 11's default
 *   terminal ignores a hidden start, so the action is `conhost.exe --headless <node> …`: conhost
 *   hosts the console with no window. `--headless` is conhost's own, undocumented flag
 *   (microsoft/terminal#13914); `install --visible` runs node directly instead, in a window, for a
 *   Windows on which the headless task does not start.
 *
 * What every service runs: the absolute `node` and the `crossroom` script this command was run
 * with, `runner start --service --service-env <runner home>/service.json`. A service starts with a
 * minimal PATH, so the PATH of the shell `install` ran in is kept in that file (0600, with
 * `PARLEY_RUNNER_HOME` and `PARLEY_DATA`), and `runner start` puts it back before anything else: the
 * agents' CLIs are found as they were in that shell (the GitHub Actions runner's `.path` file, for the
 * same reason). The file holds no secret, and neither does any unit file: the runner's token and keys
 * stay in its home at 0600. A `crossroom` run through `npx` lives in npm's cache, which npm may clear,
 * so `install` refuses it.
 *
 * One service per runner home: the default home's is `crossroom-runner` (`dev.crossroom.runner`,
 * "Crossroom runner"), any other home's carries a short hash of its path.
 *
 * `runner start --service` writes what it says to `<runner home>/runner.log` (0600, rotated at
 * `LOG_MAX_BYTES`, one old file kept) instead of a terminal nobody reads, and the runner page's link,
 * which carries the page's key, to `<runner home>/page-link` (0600) alone: never to the log, the
 * journal or launchd's output file. `crossroom runner page` prints it from there.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { oneLine } from '@parley/shared/text';
import { type Args, Usage } from '../cli.js';
import { type RunnerConfig, seatDir } from '../runner/config.js';

export type ServicePlatform = 'linux' | 'darwin' | 'win32';

/** Paths as the platform the service is for reads them: tests plan a Windows task on Linux. */
const pathOf = (p: ServicePlatform) => (p === 'win32' ? path.win32 : path.posix);

/** Where `runner start --service` writes what it says. */
export const LOG_FILE = 'runner.log';
/** Rotated to `runner.log.1` (replacing the last one) once it passes this. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** The runner page's link, key in its fragment: written by a service's runner, read by `crossroom runner page`. */
export const PAGE_LINK_FILE = 'page-link';
/** What a service's `runner start` restores before it reads anything: PATH and the data directories. */
export const SERVICE_ENV_FILE = 'service.json';
/** The Windows task's definition, kept beside the runner for reading; `uninstall` removes it. */
export const TASK_XML_FILE = 'service-task.xml';
/** launchd's own output for the service (a crash's stack trace); what the runner says is in `runner.log`. */
export const LAUNCHD_OUTPUT_FILE = 'service-output.log';
/** How long a stopping runner may drain its jobs before its service manager kills what is left, in seconds. */
export const STOP_TIMEOUT_S = 600;
/** How long a failed runner waits before its service starts it again, in seconds. */
export const RESTART_DELAY_S = 30;

const NPX_REFUSED =
  'This crossroom runs from npx, whose cache npm may clear at any time, so a service pointing at it would stop working. Install the package (npm install -g crossroom) and run `crossroom runner service install` from that install.';

/**
 * The variables a service's env file may set: nothing else is applied. `PARLEY_OS_NOTICES` is the
 * one switch `crossroom background install` sets: the piece then raises the system's own notices
 * (os-notice.ts).
 */
const ENV_KEYS = ['PATH', 'PARLEY_RUNNER_HOME', 'PARLEY_DATA', 'PARLEY_OS_NOTICES'] as const;
export type ServiceEnv = Partial<Record<(typeof ENV_KEYS)[number], string>>;

// ---------------------------------------------------------------- what the service runs

/**
 * The three things `crossroom` keeps running on a person's computer.
 * They stay three processes, because each holds different credentials and answers to a different
 * peer, and each is its own service of the system's own manager, which restarts it on its own:
 *
 * - `runner`: the team's runner (`runner start`), outbound only, which others' agents depend on;
 * - `server`: rooms on this computer (`serve`, port 4747), the same code the hosted instance runs;
 * - `host`: Crossroom Code's managed chats (`host run`, port 4748), which is retired. Its unit is
 *   still named here so `crossroom background status` and `uninstall` find one an install left.
 */
export type Piece = 'runner' | 'server' | 'host';

interface PieceInfo {
  /** The service id's stem: `crossroom-<piece>`. */
  stem: string;
  /** What the Windows task is called. */
  task: string;
  /** One line for the unit's description. */
  description: string;
  /** The command that writes the unit, and the one that removes it, for the comment in it. */
  writtenBy: string;
  removedBy: string;
  /** How long a stopping piece may finish its work before what is left is killed, in seconds. */
  stopTimeoutS: number;
  /** How to run it in a terminal instead, where no service manager can. */
  terminal: string;
  /** What it writes what it says to, in its working directory, when a service runs it. */
  log: string;
}

export const PIECES: Record<Piece, PieceInfo> = {
  runner: {
    stem: 'crossroom-runner',
    task: 'Crossroom runner',
    description: 'Crossroom runner: your agents answer while it runs',
    writtenBy: 'crossroom runner service install',
    removedBy: 'crossroom runner service uninstall',
    stopTimeoutS: 600,
    terminal: 'crossroom runner start',
    log: 'runner.log',
  },
  server: {
    stem: 'crossroom-server',
    task: 'Crossroom server',
    description: 'Crossroom on this computer: your rooms and the agents they start',
    writtenBy: 'crossroom background install',
    removedBy: 'crossroom background uninstall',
    stopTimeoutS: 60,
    terminal: 'crossroom serve',
    log: 'server.log',
  },
  host: {
    stem: 'crossroom-host',
    task: 'Crossroom Code',
    description: 'Crossroom Code: your managed chats, reachable from your other devices',
    writtenBy: 'crossroom background install',
    removedBy: 'crossroom background uninstall',
    stopTimeoutS: 60,
    terminal: 'crossroom host start',
    log: 'host.log',
  },
};

/** The ports `serve` and `host run` listen on when a service starts them. */
export const SERVER_PORT = 4747;
export const HOST_PORT = 4748;

export interface ServiceSpec {
  /** `crossroom-runner`, or `crossroom-runner-<hash>` for a runner home other than the default; `crossroom-server`, `crossroom-host`. */
  id: string;
  /** The service's working directory, absolute: the runner's home, the data directory, or the host's directory. */
  home: string;
  /** node, its options and the crossroom script, all absolute. */
  program: string[];
  /** `<home>/service.json`. */
  envFile: string;
  /** What it runs; the runner when absent. */
  piece?: Piece;
  /** The port a server or a host listens on. */
  port?: number;
}

const pieceOf = (s: Pick<ServiceSpec, 'piece'>): PieceInfo => PIECES[s.piece ?? 'runner'];

/** The whole command line a service runs. */
export function serviceArgv(s: ServiceSpec): string[] {
  const tail = ['--service-env', s.envFile];
  if (s.piece === 'server') return [...s.program, 'serve', '--service', '--port', String(s.port ?? SERVER_PORT), ...tail];
  if (s.piece === 'host') return [...s.program, 'host', 'run', '--service', '--port', String(s.port ?? HOST_PORT), ...tail];
  return [...s.program, 'runner', 'start', '--service', ...tail];
}

/** The id of the service for a runner home: the default home's has no suffix. */
export function serviceId(home: string, homedir: string, platform: ServicePlatform): string {
  const P = pathOf(platform);
  const abs = P.resolve(home);
  const norm = (p: string) => (platform === 'win32' ? p.toLowerCase() : p);
  if (norm(abs) === norm(P.join(homedir, '.parley', 'runner'))) return 'crossroom-runner';
  return `crossroom-runner-${createHash('sha256').update(norm(abs), 'utf8').digest('hex').slice(0, 8)}`;
}

/** launchd's label for a service id: `dev.crossroom.runner` (or `.server`, `.host`), with the id's hash after a dot. */
export const launchdLabel = (id: string) => id.replace(/^crossroom-/, 'dev.crossroom.').replace(/-([0-9a-f]{8})$/, '.$1');
/** The Windows task's name for a service id. */
export const taskName = (id: string) =>
  id.replace(/^crossroom-(runner|server|host)/, (_m, p: Piece) => PIECES[p].task).replace(/-([0-9a-f]{8})$/, ' $1');

const LOADER_OPTS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);
const isAbsoluteSpecifier = (v: string) => path.isAbsolute(v) || path.win32.isAbsolute(v) || v.startsWith('file:');

/**
 * node, its options and the script, as the service will run them. Refuses a script in npx's cache,
 * and a loader named by a bare specifier (`--import tsx`), which resolves from the directory node
 * starts in and would not resolve from the runner's home. Debugger options are left out: a service
 * would otherwise open an inspector port at every start.
 */
export function serviceProgram(o: { execPath: string; execArgv: readonly string[]; script: string }): string[] {
  if (!o.script || !isAbsoluteSpecifier(o.script)) throw new Usage(`The crossroom script's path is not absolute (${oneLine(o.script).slice(0, 200)}): run crossroom by its path, then install the service.`);
  if (/[\\/]_npx[\\/]/.test(o.script)) throw new Usage(NPX_REFUSED);
  const opts: string[] = [];
  for (let i = 0; i < o.execArgv.length; i++) {
    const a = o.execArgv[i]!;
    if (/^--(inspect|debug)/.test(a)) continue;
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a);
    const spec = eq && LOADER_OPTS.has(eq[1]!) ? eq[2]! : LOADER_OPTS.has(a) ? o.execArgv[i + 1] : undefined;
    if (spec !== undefined && !isAbsoluteSpecifier(spec))
      throw new Usage(
        `node was started with ${a}${eq ? '' : ` ${spec}`}, which a service could not resolve from the runner's home. Install the service from the built crossroom (node <path>/crossroom.mjs runner service install).`,
      );
    opts.push(a);
    if (!eq && LOADER_OPTS.has(a) && spec !== undefined) opts.push(o.execArgv[++i]!);
  }
  return [o.execPath, ...opts, o.script];
}

/** A path or argument with a control character in it, refused: no unit format carries one safely. */
function plain(what: string, v: string): string {
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new Usage(`${what} holds a control character, which a service definition cannot carry: ${JSON.stringify(v).slice(0, 200)}`);
  return v;
}

// ---------------------------------------------------------------- systemd

/**
 * One ExecStart word: double-quoted, with `\` and `"` escaped for the quoting, `%` doubled (a
 * specifier otherwise) and `$` doubled (a variable otherwise).
 */
export function systemdWord(v: string): string {
  return `"${plain('A path', v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** A path in a plain setting (`WorkingDirectory=`): specifiers expanded, so `%` doubled, and nothing else read. */
const systemdPath = (v: string) => plain('A path', v).replace(/%/g, '%%');

export function systemdUnit(s: ServiceSpec): string {
  const p = pieceOf(s);
  return [
    `# Written by \`${p.writtenBy}\`; \`${p.removedBy}\` removes it.`,
    '[Unit]',
    `Description=${p.description}`,
    // The retired host started after the server (no requirement).
    ...(s.piece === 'host' ? [`After=${PIECES.server.stem}.service`] : []),
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${serviceArgv(s).map(systemdWord).join(' ')}`,
    `WorkingDirectory=${systemdPath(s.home)}`,
    'Restart=on-failure',
    `RestartSec=${RESTART_DELAY_S}`,
    // SIGTERM to the piece alone, which finishes its work (a runner drains its jobs); whatever is
    // left after the timeout, the agent CLIs it started included, is killed.
    'KillMode=mixed',
    `TimeoutStopSec=${p.stopTimeoutS}`,
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- launchd

/** Text in XML: `&`, `<`, `>` and both quotes as entities. */
export function xmlText(v: string): string {
  return plain('A path', v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function launchdPlist(s: ServiceSpec): string {
  const str = (v: string) => `<string>${xmlText(v)}</string>`;
  const out = path.posix.join(s.home, LAUNCHD_OUTPUT_FILE);
  const p = pieceOf(s);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- Written by \`${p.writtenBy}\`; \`${p.removedBy}\` removes it. -->`,
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${str(launchdLabel(s.id))}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...serviceArgv(s).map((a) => `    ${str(a)}`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  ${str(s.home)}`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    `  <integer>${RESTART_DELAY_S}</integer>`,
    '  <key>ExitTimeOut</key>',
    `  <integer>${p.stopTimeoutS}</integer>`,
    // 0077, in decimal as launchd reads it: the output file is the user's alone.
    '  <key>Umask</key>',
    '  <integer>63</integer>',
    '  <key>StandardOutPath</key>',
    `  ${str(out)}`,
    '  <key>StandardErrorPath</key>',
    `  ${str(out)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- Task Scheduler

/** One argument as Windows' command-line parsing reads it back (CommandLineToArgvW). */
export function windowsArg(v: string): string {
  plain('An argument', v);
  if (v !== '' && !/[ \t"]/.test(v)) return v;
  let out = '"';
  let slashes = 0;
  for (const ch of v) {
    if (ch === '\\') slashes++;
    else if (ch === '"') {
      out += `${'\\'.repeat(slashes * 2 + 1)}"`;
      slashes = 0;
    } else {
      out += '\\'.repeat(slashes) + ch;
      slashes = 0;
    }
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

export interface TaskOptions {
  /** `DOMAIN\user`: the logon that starts it, and the account it runs as. */
  userId: string;
  /** `%SystemRoot%`, resolved: where conhost.exe is. */
  systemRoot: string;
  /** Run node itself, in a window, rather than under `conhost --headless`. */
  visible?: boolean;
}

/**
 * The task's command and arguments. Task Scheduler expands `%VAR%` in both, and nothing escapes it,
 * so a path holding `%` is refused rather than run as something else.
 */
export function taskAction(s: ServiceSpec, o: Pick<TaskOptions, 'systemRoot' | 'visible'>): { command: string; args: string } {
  const argv = serviceArgv(s);
  for (const a of [...argv, s.home]) if (a.includes('%')) throw new Usage(`Task Scheduler reads %…% in a path as a variable, so a service cannot run from ${oneLine(a).slice(0, 200)}. Move it to a path without %.`);
  if (o.visible) return { command: argv[0]!, args: argv.slice(1).map(windowsArg).join(' ') };
  return { command: path.win32.join(o.systemRoot, 'System32', 'conhost.exe'), args: ['--headless', ...argv].map(windowsArg).join(' ') };
}

export function taskXml(s: ServiceSpec, o: TaskOptions): string {
  const { command, args } = taskAction(s, o);
  const user = xmlText(o.userId);
  const p = pieceOf(s);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlText(p.description)}. Written by ${p.writtenBy}; ${p.removedBy} removes it.</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${user}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>true</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>999</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlText(command)}</Command>`,
    `      <Arguments>${xmlText(args)}</Arguments>`,
    `      <WorkingDirectory>${xmlText(s.home)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** UTF-16LE with a byte-order mark, as `schtasks /XML` reads a file that says `encoding="UTF-16"`. */
export const utf16le = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);

// ---------------------------------------------------------------- the service's own files

/** A file written whole and only then put in place, at `mode`: a reader never sees half of it. */
function writeWhole(file: string, data: string | Buffer, mode: number) {
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, file);
}

/** The files a service install writes, removes and reads: the real disk, or a test's own. */
export interface ServiceFs {
  /** Written whole, at `mode`. */
  write(file: string, data: string | Buffer, mode: number): void;
  exists(file: string): boolean;
  remove(file: string): void;
  mkdirp(dir: string): void;
  read(file: string): string | null;
}

export const realFs: ServiceFs = {
  write: writeWhole,
  exists: existsSync,
  remove: (f) => rmSync(f, { force: true }),
  mkdirp: (d) => {
    mkdirSync(d, { recursive: true });
  },
  read: (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  },
};

/** The service's env file's text: the keys `applyServiceEnv` takes, and nothing else. */
export function serviceEnvText(env: ServiceEnv): string {
  const clean: ServiceEnv = {};
  for (const k of ENV_KEYS) if (env[k] !== undefined) clean[k] = plain(k, env[k]!);
  return `${JSON.stringify({ v: 1, env: clean }, null, 2)}\n`;
}

/**
 * `runner start --service --service-env <file>`: the PATH and data directories `install` kept, put
 * back before anything reads them. Only the keys `install` writes are taken.
 */
export function applyServiceEnv(file: string, env: NodeJS.ProcessEnv = process.env, piece: Piece = 'runner'): void {
  const again = `Run \`${PIECES[piece].writtenBy}\` again.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Usage(`The service's settings (${file}) are missing or unreadable. ${again}`);
  }
  const got = (parsed as { v?: unknown; env?: unknown })?.env;
  if ((parsed as { v?: unknown })?.v !== 1 || !got || typeof got !== 'object') throw new Usage(`The service's settings (${file}) are not ones this crossroom wrote. ${again}`);
  for (const k of ENV_KEYS) {
    const v = (got as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length > 0 && !v.includes('\0')) env[k] = v;
  }
}

/** Where a service's runner puts a line that carried a link, whole: an ask link is printed once, when it is new. */
export const LINKS_FILE = 'links';

/** Credentials Crossroom or GitHub mint, by their prefixes: the list the runner image's entrypoint redacts. */
const TOKENS = /\b(?:rt|rs|sg|pa|pi|pc|pr|scim|ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_-]{16,}/g;

/**
 * A line as a service's log keeps it, by the rule the runner image's entrypoint follows
 * (`redactLine` there): an ask link, a key in a fragment, a seat link and a token are cut out. A log
 * is read, copied and pasted into bug reports; a terminal's line was seen once. `link` says the line
 * carried a link, which then goes whole to `links` (0600) instead.
 */
export function redactLine(line: string): { shown: string; link: boolean } {
  let link = false;
  const shown = line
    .replace(/\/ask\/[A-Za-z0-9_-]{8,}/g, () => {
      link = true;
      return '/ask/***';
    })
    .replace(/#([a-z])=[^\s'"<>)]+/g, (_m, k: string) => {
      link = true;
      return `#${k}=***`;
    })
    .replace(/\/(j|mcp)\/[A-Za-z0-9_-]{8,}/g, '/$1/***')
    .replace(TOKENS, '***');
  return { shown, link };
}

/**
 * What `runner start --service` says with: a line, with its time, appended to `runner.log`, which
 * is created at 0600 (and put back to 0600 if something widened it), and rotated to `runner.log.1`
 * once it passes `maxBytes`. A line is one line in the file whatever the runner was saying, and a
 * line with a link or a token in it is redacted there (`redactLine`), the whole line kept in `links`.
 */
export function serviceLog(home: string, o: { maxBytes?: number; now?: () => Date; file?: string } = {}): (line: string) => void {
  const file = path.join(home, o.file ?? LOG_FILE);
  const links = path.join(home, LINKS_FILE);
  const max = o.maxBytes ?? LOG_MAX_BYTES;
  const now = o.now ?? (() => new Date());
  mkdirSync(home, { recursive: true });
  if (process.platform !== 'win32') for (const f of [file, links]) if (existsSync(f)) chmodSync(f, 0o600);
  return (line: string) => {
    try {
      const at = now().toISOString();
      const one = oneLine(line);
      const { shown, link } = redactLine(one);
      if (link) appendFileSync(links, `${at} ${one}\n`, { mode: 0o600 });
      if (existsSync(file) && statSync(file).size >= max) renameSync(file, `${file}.1`);
      appendFileSync(file, `${at} ${shown}${link ? `  [the link itself is in ${links}]` : ''}\n`, { mode: 0o600 });
    } catch {
      // A log that cannot be written never stops the runner answering.
    }
  };
}

/**
 * A server or a host run by a service prints with `console.log` like any other run, all over the
 * code: in a service each line goes to `say` (a `serviceLog`) instead of a terminal nobody reads, or,
 * on Windows under `conhost --headless`, nowhere at all.
 */
export function captureOutput(say: (line: string) => void): void {
  const write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) say(line);
    const done = typeof enc === 'function' ? enc : typeof cb === 'function' ? cb : undefined;
    if (done) (done as () => void)();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = write;
  process.stderr.write = write;
}

export const pageLinkFile = (home: string) => path.join(home, PAGE_LINK_FILE);

/** The runner page's link, for `crossroom runner page`: this file and nothing else holds it. */
export function writePageLink(home: string, url: string) {
  writeWhole(pageLinkFile(home), `${url}\n`, 0o600);
}

/** The link a running service's runner wrote, or null. */
export function readPageLink(home: string): string | null {
  try {
    const v = readFileSync(pageLinkFile(home), 'utf8').trim();
    return /^https?:\/\/\S+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Gone when the runner that wrote it stops: a link to a page nobody serves is worse than none. Only its own. */
export function forgetPageLink(home: string, url: string) {
  if (readPageLink(home) === url) rmSync(pageLinkFile(home), { force: true });
}

// ---------------------------------------------------------------- running the service manager

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ServiceIo {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** For launchd's `gui/<uid>` domain. */
  uid: number | null;
  /** The running node, its options and the crossroom script. */
  execPath: string;
  execArgv: readonly string[];
  script: string;
  exec(file: string, args: string[]): Promise<ExecResult>;
  fs: ServiceFs;
}

export function realExec(file: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : 127) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err ? (err as Error).message : '')) });
    });
  });
}

/** The crossroom script, through any link to it: npx's cache shows only once the link is followed. */
function scriptPath(argv1: string | undefined): string {
  if (!argv1) return '';
  try {
    return realpathSync(path.resolve(argv1));
  } catch {
    return path.resolve(argv1);
  }
}

export function realIo(): ServiceIo {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    execPath: process.execPath,
    execArgv: process.execArgv,
    script: scriptPath(process.argv[1]),
    exec: realExec,
    fs: realFs,
  };
}

function platformOf(io: ServiceIo, piece: Piece = 'runner'): ServicePlatform {
  if (io.platform === 'linux' || io.platform === 'darwin' || io.platform === 'win32') return io.platform;
  throw new Usage(`A background service is set up on Linux (systemd), macOS (launchd) and Windows (Task Scheduler), not on ${io.platform}. Run \`${PIECES[piece].terminal}\` under your own process manager.`);
}

/** Which piece a service runs, and from where. */
export interface UnitTarget {
  piece: Piece;
  /** Its working directory: the runner's home, the data directory, or the host's directory. */
  home: string;
  /** The data directory a server or a host reads; the runner's comes from PARLEY_DATA, as it always has. */
  dataDir?: string;
  /** The port a server or a host listens on. */
  port?: number;
}

/** A piece's service id, the file its manager reads, and the name the manager lists it by. */
function unitNames(t: UnitTarget, io: Pick<ServiceIo, 'env' | 'homedir'>, platform: ServicePlatform) {
  const P = pathOf(platform);
  const abs = P.resolve(t.home);
  const id = t.piece === 'runner' ? serviceId(abs, io.homedir, platform) : PIECES[t.piece].stem;
  const file = platform === 'linux' ? systemdUnitPath(io, id) : platform === 'darwin' ? launchdPlistPath(io.homedir, id) : P.join(abs, TASK_XML_FILE);
  const name = platform === 'linux' ? `${id}.service` : platform === 'darwin' ? launchdLabel(id) : taskName(id);
  return { P, abs, id, file, name };
}

export interface Plan {
  platform: ServicePlatform;
  spec: ServiceSpec;
  /** The file the service manager reads, and what goes in it. */
  file: string;
  contents: string;
  /** What the service is called where its manager lists it. */
  name: string;
  env: ServiceEnv;
  /** Windows' task definition, kept in the runner's home. */
  taskXmlFile?: string;
}

export function systemdUnitPath(io: Pick<ServiceIo, 'env' | 'homedir'>, id: string): string {
  const xdg = io.env.XDG_CONFIG_HOME?.trim();
  return path.posix.join(xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(io.homedir, '.config'), 'systemd', 'user', `${id}.service`);
}

export const launchdPlistPath = (homedir: string, id: string) => path.posix.join(homedir, 'Library', 'LaunchAgents', `${launchdLabel(id)}.plist`);

function windowsUser(env: NodeJS.ProcessEnv): string {
  const user = env.USERNAME?.trim();
  if (!user) throw new Usage('USERNAME is not set, so the task cannot name the user it runs for. Run this from your own signed-in session.');
  const domain = env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${user}` : user;
}

/** What `install` would write and register for the runner in `home`, computed without touching anything. */
export function planService(home: string, io: ServiceIo, o: { visible?: boolean; notices?: boolean } = {}): Plan {
  return planUnit({ piece: 'runner', home }, io, o);
}

/**
 * What installing a piece's service would write and register, computed without touching anything.
 * `notices` turns on the system's own notices for it (`PARLEY_OS_NOTICES`, os-notice.ts).
 */
export function planUnit(t: UnitTarget, io: ServiceIo, o: { visible?: boolean; notices?: boolean } = {}): Plan {
  const platform = platformOf(io, t.piece);
  const { P, abs, id, file, name } = unitNames(t, io, platform);
  plain(t.piece === 'runner' ? 'The runner home' : 'The directory', abs);
  const spec: ServiceSpec = {
    id,
    home: abs,
    program: serviceProgram(io),
    envFile: P.join(abs, SERVICE_ENV_FILE),
    ...(t.piece === 'runner' ? {} : { piece: t.piece, port: t.port ?? (t.piece === 'server' ? SERVER_PORT : HOST_PORT) }),
  };
  const pathVar = io.env.PATH ?? io.env.Path ?? '';
  const data = t.piece === 'runner' ? io.env.PARLEY_DATA?.trim() : t.dataDir;
  const env: ServiceEnv = {
    PATH: pathVar,
    ...(t.piece === 'runner' ? { PARLEY_RUNNER_HOME: abs } : {}),
    ...(data ? { PARLEY_DATA: P.resolve(data) } : {}),
    ...(o.notices ? { PARLEY_OS_NOTICES: '1' } : {}),
  };
  if (platform === 'linux') return { platform, spec, env, name, file, contents: systemdUnit(spec) };
  if (platform === 'darwin') return { platform, spec, env, name, file, contents: launchdPlist(spec) };
  const contents = taskXml(spec, { userId: windowsUser(io.env), systemRoot: io.env.SystemRoot?.trim() || io.env.SYSTEMROOT?.trim() || 'C:\\Windows', visible: o.visible });
  return { platform, spec, env, name, file, contents, taskXmlFile: file };
}

const noSystemd = (piece: Piece) =>
  `This machine has no systemd user manager to run the service (a container, or WSL without systemd). Run \`${PIECES[piece].terminal}\` in a terminal, or under a process manager of your own.`;

async function must(io: ServiceIo, file: string, args: string[], what: string): Promise<ExecResult> {
  const r = await io.exec(file, args);
  if (r.code !== 0) throw new Usage(`${what} failed (${file} ${args.join(' ')}): ${oneLine(r.stderr || r.stdout).slice(0, 400) || `exit ${r.code}`}`);
  return r;
}

/** Directories macOS keeps a background process out of until the user allows it (Files and Folders). */
const PROTECTED_MAC = ['Documents', 'Desktop', 'Downloads', 'Library/Mobile Documents'];

/** Lines about this runner's seats that a background service may not reach, on this platform. */
export function seatNotes(cfg: RunnerConfig | null, home: string, io: Pick<ServiceIo, 'platform' | 'homedir'>): string[] {
  if (io.platform !== 'darwin' || !cfg) return [];
  const notes: string[] = [];
  for (const s of cfg.seats) {
    const d = seatDir(s, home);
    const under = PROTECTED_MAC.find((p) => d === path.posix.join(io.homedir, p) || d.startsWith(`${path.posix.join(io.homedir, p)}/`));
    if (under)
      notes.push(
        `The seat ${s.label} works in ${d}, under ~/${under}, which macOS may keep a background process out of. If its jobs cannot read the directory, allow node in System Settings, Privacy & Security, Files and Folders (or Full Disk Access), or move the repository.`,
      );
  }
  return notes;
}

export interface InstallResult {
  platform: ServicePlatform;
  name: string;
  file: string;
  /** Every command run, in order: for `--dry-run`, every command that would run. */
  commands: string[][];
  notes: string[];
  dryRun: boolean;
  contents: string;
}

/**
 * Write the service's files and register it with this user's service manager, then start it. Run
 * again, it replaces the definition and restarts the runner, so a new crossroom or a new PATH
 * takes effect.
 */
export async function installService(home: string, cfg: RunnerConfig, io: ServiceIo, o: { dryRun?: boolean; visible?: boolean; notices?: boolean } = {}): Promise<InstallResult> {
  if (!cfg.seats.length) throw new Usage('The runner has no seats yet, so a service would only stop again. Add one first: crossroom agents add <label>=<dir> (or crossroom runner add).');
  // Run again (after updating crossroom, say), it keeps the notices `crossroom background install`
  // turned on, unless told otherwise: the two commands write one service.
  const notices = o.notices ?? noticesInEnvFile(io.fs.read(planService(home, io, o).spec.envFile));
  const plan = planService(home, io, { ...o, notices });
  const notes = [
    ...seatNotes(cfg, plan.spec.home, io),
    'If `crossroom runner start` is running in a terminal for this runner, stop it: the service runs its own.',
  ];
  return await installUnit(plan, io, { ...o, notes });
}

/** Whether an env file `install` wrote turns the system's notices on. */
export function noticesInEnvFile(text: string | null): boolean {
  try {
    return (JSON.parse(text ?? '{}') as { env?: Record<string, unknown> }).env?.PARLEY_OS_NOTICES === '1';
  } catch {
    return false;
  }
}

/**
 * Write a planned service's files and register it with this user's service manager, then start it.
 * Run again, it replaces the definition and restarts the piece, so a new crossroom or a new PATH
 * takes effect. Every piece goes through here (`crossroom background install`, background.ts).
 */
export async function installUnit(plan: Plan, io: ServiceIo, o: { dryRun?: boolean; notes?: string[] } = {}): Promise<InstallResult> {
  const { platform, spec, name, file } = plan;
  const uidDomain = `gui/${io.uid ?? ''}`;
  const commands: string[][] =
    platform === 'linux'
      ? [
          ['systemctl', '--user', 'daemon-reload'],
          ['systemctl', '--user', 'enable', name],
          // Queued, not waited for: a draining runner takes up to its stop timeout to let go.
          ['systemctl', '--user', 'restart', '--no-block', name],
        ]
      : platform === 'darwin'
        ? [
            ['launchctl', 'bootout', `${uidDomain}/${name}`],
            ['launchctl', 'enable', `${uidDomain}/${name}`],
            ['launchctl', 'bootstrap', uidDomain, file],
          ]
        : [
            ['schtasks', '/Create', '/TN', name, '/XML', file, '/F'],
            ['schtasks', '/End', '/TN', name],
            ['schtasks', '/Run', '/TN', name],
          ];
  const notes = [...(o.notes ?? [])];
  const result: InstallResult = { platform, name, file, commands, notes, dryRun: !!o.dryRun, contents: plan.contents };
  if (o.dryRun) return result;

  if (platform === 'linux') {
    // A user manager to talk to, before anything is written.
    if ((await io.exec('systemctl', ['--user', 'show-environment'])).code !== 0) throw new Usage(noSystemd(spec.piece ?? 'runner'));
  }
  if (platform === 'darwin' && io.uid === null) throw new Usage('This process has no user id, so launchd has no domain to load the service into.');
  const P = pathOf(platform);
  io.fs.mkdirp(spec.home);
  io.fs.write(spec.envFile, serviceEnvText(plan.env), 0o600);
  io.fs.mkdirp(P.dirname(file));
  if (platform === 'win32') io.fs.write(file, utf16le(plan.contents), 0o600);
  // A unit or a plist holds no secret; it is written at the mode its directory expects (0644).
  else io.fs.write(file, plan.contents, 0o644);

  if (platform === 'linux') {
    for (const c of commands) await must(io, c[0]!, c.slice(1), 'Setting up the systemd unit');
    const linger = await lingerOf(io);
    if (linger === false) notes.unshift(lingerLine(io.env));
  } else if (platform === 'darwin') {
    // Not loaded yet is the usual answer here.
    await io.exec(commands[0]![0]!, commands[0]!.slice(1));
    await must(io, commands[1]![0]!, commands[1]!.slice(1), 'Enabling the LaunchAgent');
    await must(io, commands[2]![0]!, commands[2]!.slice(1), 'Loading the LaunchAgent');
  } else {
    await must(io, commands[0]![0]!, commands[0]!.slice(1), 'Registering the task');
    // A runner the task started before keeps its old definition until it stops: not running is the usual answer.
    await io.exec(commands[1]![0]!, commands[1]!.slice(1));
    await must(io, commands[2]![0]!, commands[2]!.slice(1), 'Starting the task');
  }
  return result;
}

/** Whether lingering is on for this user (a user unit runs without a session), or null when loginctl cannot say. */
async function lingerOf(io: ServiceIo): Promise<boolean | null> {
  const user = io.env.USER?.trim() || io.env.LOGNAME?.trim() || os.userInfo().username;
  const r = await io.exec('loginctl', ['show-user', user, '--property=Linger']);
  if (r.code !== 0) return null;
  const m = /^Linger=(yes|no)\s*$/m.exec(r.stdout);
  return m ? m[1] === 'yes' : null;
}

const lingerLine = (env: NodeJS.ProcessEnv) =>
  `The service runs while you are logged in. To keep it running after you log out, and from boot, run once: sudo loginctl enable-linger ${env.USER?.trim() || env.LOGNAME?.trim() || '$USER'}`;

export type ServiceState = 'running' | 'stopped' | 'failed' | 'not installed' | 'unknown';

export interface StatusResult {
  platform: ServicePlatform;
  name: string;
  file: string;
  installed: boolean;
  state: ServiceState;
  /** Linux only: whether it keeps running after log-out. */
  linger: boolean | null;
  log: string;
  /** The last lines the runner wrote. */
  tail: string[];
  notes: string[];
}

function tailOf(fs: ServiceFs, file: string, n: number): string[] {
  return (fs.read(file) ?? '').split('\n').filter(Boolean).slice(-n);
}

export async function serviceStatus(home: string, cfg: RunnerConfig | null, io: ServiceIo): Promise<StatusResult> {
  const s = await unitStatus({ piece: 'runner', home }, io);
  if (s.installed) s.notes.push(...seatNotes(cfg, pathOf(s.platform).resolve(home), io));
  return s;
}

/** Whether a piece's service is installed and running, as its manager says, and the last lines of its log. */
export async function unitStatus(t: UnitTarget, io: ServiceIo): Promise<StatusResult> {
  const platform = platformOf(io, t.piece);
  const { P, abs, file, name } = unitNames(t, io, platform);
  const log = P.join(abs, PIECES[t.piece].log);
  let installed = io.fs.exists(file);
  let state: ServiceState = installed ? 'unknown' : 'not installed';
  let linger: boolean | null = null;
  const notes: string[] = [];
  if (platform === 'linux') {
    if (installed) {
      const r = await io.exec('systemctl', ['--user', 'is-active', name]);
      const word = r.stdout.trim().split('\n')[0] ?? '';
      state = word === 'active' || word === 'activating' || word === 'reloading' ? 'running' : word === 'failed' ? 'failed' : word === 'inactive' ? 'stopped' : 'unknown';
      linger = await lingerOf(io);
      if (linger === false) notes.push(lingerLine(io.env));
    }
  } else if (platform === 'darwin') {
    const r = await io.exec('launchctl', ['print', `gui/${io.uid ?? ''}/${name}`]);
    if (r.code === 0) {
      installed = true;
      const st = /^\s*state = (\S+)/m.exec(r.stdout)?.[1];
      const lastExit = /^\s*last exit code = (\d+)/m.exec(r.stdout)?.[1];
      state = st === 'running' ? 'running' : lastExit && lastExit !== '0' ? 'failed' : 'stopped';
    } else if (installed) state = 'stopped';
  } else {
    const q = await io.exec('schtasks', ['/Query', '/TN', name]);
    installed = q.code === 0;
    if (installed) {
      // The state's name in English whatever the system's language: schtasks prints a translated one.
      const r = await io.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-ScheduledTask -TaskName '${name.replace(/'/g, "''")}' -ErrorAction Stop).State`]);
      const word = r.code === 0 ? r.stdout.trim() : '';
      state = word === 'Running' ? 'running' : word === 'Ready' || word === 'Disabled' || word === 'Queued' ? 'stopped' : 'unknown';
    } else state = 'not installed';
  }
  return { platform, name, file, installed, state, linger, log, tail: installed ? tailOf(io.fs, log, 5) : [], notes };
}

export interface UninstallResult {
  platform: ServicePlatform;
  name: string;
  removed: string[];
  commands: string[][];
}

/** Stop the service, unregister it and remove its files. The runner's own files and its log stay. */
export function uninstallService(home: string, io: ServiceIo): Promise<UninstallResult> {
  return uninstallUnit({ piece: 'runner', home }, io);
}

/** Stop a piece's service, unregister it and remove its files. The piece's own files and its log stay. */
export async function uninstallUnit(t: UnitTarget, io: ServiceIo): Promise<UninstallResult> {
  const platform = platformOf(io, t.piece);
  const { P, abs, id } = unitNames(t, io, platform);
  const removed: string[] = [];
  const commands: string[][] = [];
  const run = async (args: string[], required = false) => {
    commands.push(args);
    const r = await io.exec(args[0]!, args.slice(1));
    if (required && r.code !== 0) throw new Usage(`Removing the service failed (${args.join(' ')}): ${oneLine(r.stderr || r.stdout).slice(0, 400) || `exit ${r.code}`}`);
    return r;
  };
  const rm = (f: string) => {
    if (io.fs.exists(f)) {
      io.fs.remove(f);
      removed.push(f);
    }
  };
  if (platform === 'linux') {
    const name = `${id}.service`;
    const unit = systemdUnitPath(io, id);
    // With no user manager to ask (an SSH or `sudo -u` session, say), nothing can be stopped: the unit
    // keeps running, so its file stays and the command says so, rather than "removed".
    if ((await io.exec('systemctl', ['--user', 'show-environment'])).code !== 0)
      throw new Usage(`This session can't reach your systemd user manager, so ${name} was neither stopped nor removed. Run this again from your own login session.`);
    // Stopped and disabled whether or not the file is still there; a unit that was never loaded answers non-zero.
    const off = await run(['systemctl', '--user', 'disable', '--now', name]);
    if (off.code !== 0 && !/not loaded|does not exist|not found|No such file/i.test(`${off.stderr} ${off.stdout}`))
      throw new Usage(`Stopping ${name} failed (systemctl --user disable --now ${name}): ${oneLine(off.stderr || off.stdout).slice(0, 400) || `exit ${off.code}`}. Its file is kept.`);
    rm(unit);
    await run(['systemctl', '--user', 'daemon-reload']);
    rm(P.join(abs, SERVICE_ENV_FILE));
    return { platform, name, removed, commands };
  }
  if (platform === 'darwin') {
    const name = launchdLabel(id);
    await run(['launchctl', 'bootout', `gui/${io.uid ?? ''}/${name}`]);
    rm(launchdPlistPath(io.homedir, id));
    rm(P.join(abs, SERVICE_ENV_FILE));
    return { platform, name, removed, commands };
  }
  const name = taskName(id);
  const exists = (await run(['schtasks', '/Query', '/TN', name])).code === 0;
  if (exists) {
    await run(['schtasks', '/End', '/TN', name]);
    await run(['schtasks', '/Delete', '/TN', name, '/F'], true);
    removed.push(`task "${name}"`);
  }
  rm(P.join(abs, TASK_XML_FILE));
  rm(P.join(abs, SERVICE_ENV_FILE));
  return { platform, name, removed, commands };
}

// ---------------------------------------------------------------- the command

const quoteCmd = (c: string[]) => c.map((a) => (/^[A-Za-z0-9_./:@=+-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');

export function installText(r: InstallResult, home: string): string {
  const where = r.platform === 'linux' ? 'a systemd user unit' : r.platform === 'darwin' ? 'a LaunchAgent' : 'a Task Scheduler task that starts at your logon';
  if (r.dryRun)
    return [`Would write ${r.file}:`, '', r.contents.replace(/\r\n/g, '\n').trimEnd(), '', 'Then run:', ...r.commands.map((c) => `  ${quoteCmd(c)}`)].join('\n');
  return [
    `The runner runs in the background now, as ${where} (${r.name}), and starts again with your session.`,
    `Its log: ${pathOf(r.platform).join(pathOf(r.platform).resolve(home), LOG_FILE)}. \`crossroom runner service status\` says how it is doing, and \`crossroom runner page\` prints the link to its page.`,
    ...r.notes,
  ].join('\n');
}

export function statusText(s: StatusResult): string {
  if (!s.installed) return `No background service is set up for this runner. \`crossroom runner service install\` sets one up.`;
  const kind = s.platform === 'linux' ? 'systemd user unit' : s.platform === 'darwin' ? 'LaunchAgent' : 'Task Scheduler task';
  return [
    `${s.name} (${kind}, ${s.file}): ${s.state}.`,
    ...s.notes,
    s.tail.length ? `Last lines of ${s.log}:` : `Nothing in ${s.log} yet.`,
    ...s.tail.map((l) => `  ${l}`),
  ].join('\n');
}

export function uninstallText(r: UninstallResult): string {
  return r.removed.length
    ? `Stopped ${r.name} and removed it (${r.removed.join(', ')}). The runner's settings and log stay; \`crossroom runner start\` still runs it in a terminal.`
    : `No background service was set up for this runner; nothing to remove.`;
}

/** `crossroom runner service [install | status | uninstall]`. */
export async function runnerService(args: Args, home: string, cfg: () => RunnerConfig, cfgOrNull: () => RunnerConfig | null, io: ServiceIo = realIo()): Promise<number> {
  const sub = args.positional[1] ?? 'status';
  const json = args.flags.json === true;
  const out = (v: unknown, t: string) => console.log(json ? JSON.stringify(v, null, 2) : t);
  if (sub === 'install') {
    // Keeps the notices an earlier install turned on, unless --no-notices (background.ts writes the same service).
    const r = await installService(home, cfg(), io, { dryRun: args.flags['dry-run'] === true, visible: args.flags.visible === true, ...(args.flags['no-notices'] === true ? { notices: false } : {}) });
    out(r, installText(r, home));
    return 0;
  }
  if (sub === 'status') {
    const s = await serviceStatus(home, cfgOrNull(), io);
    out(s, statusText(s));
    return 0;
  }
  if (sub === 'uninstall') {
    const r = await uninstallService(home, io);
    out(r, uninstallText(r));
    return 0;
  }
  throw new Usage('Usage: crossroom runner service install [--dry-run] [--visible] [--no-notices] | status | uninstall');
}
