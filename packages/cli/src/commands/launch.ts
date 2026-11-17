/**
 * `crossroom launch`: seat agents in the workbench this terminal belongs to, one pane, tab or agent
 * of its own each, already holding its seat.
 *
 * A terminal workbench runs the agents; Crossroom gives them a room. So this command does not run
 * an agent itself (that is `crossroom ask` and `crossroom join`): it asks the workbench to start one
 * the way the person would, with the paste line as its first prompt, where they can watch it,
 * approve its steps and talk to it.
 *
 * - **tmux, WezTerm, kitty**: a new window or tab, one pane per agent, through their own command
 *   lines (`tmux new-window`/`split-window`, `wezterm cli spawn`/`split-pane`, `kitten @ launch`,
 *   which needs `allow_remote_control`). With a room held here, one more pane runs `crossroom watch`.
 * - **Warp**: a Tab Config (`[[panes]]`, one leaf per agent) written to Warp's own tab_configs
 *   folder, 0600, and opened with `warp://tab_config/<name>`. Warp's URI scheme cannot run a command
 *   by itself; a Tab Config is how its docs say to.
 * - **Windows Terminal**: one `wt.exe` call, `new-tab` then a `split-pane` per agent, each pane
 *   titled for its seat. Each pane runs Windows PowerShell with the agent's command as an encoded
 *   command: Windows Terminal starts a pane's program by CreateProcess, which finds `claude.exe` but
 *   not the `claude.cmd` npm installs, and it re-quotes the arguments it splits on `;`.
 * - **Orca**: `orca agent launch --agent <a> --prompt <line>`, in the workspace this directory
 *   belongs to (Orca's CLI is under Settings, Experimental, CLI).
 * - **Paseo**: `paseo run --provider <a> --no-wait <line>`, on the daemon the CLI finds.
 * - **print**: the commands, for any other terminal.
 *
 * What each agent is started with: Claude Code gets `--allowedTools` with the one curl rule for
 * this instance's seat links (`curlRule`), so it doesn't ask before every call. Codex's sandbox
 * blocks every host off the loopback, so a Codex seat on another host is given the connector
 * (`/mcp/connect`) for that session only, with its tools approved as hosted Codex seats have them.
 *
 * A seat link is in the started agent's command line, as it is in every agent a seat link is
 * pasted into; an owner's private link never is. `crossroom launch -` reads the links from stdin
 * so they are not in this command's own.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seatPrompt } from '@parley/shared/deeplink';
import { curlRule, slotLetter } from '@parley/shared/text';
import { type Args, Usage, text } from '../cli.js';
import { resolveBin } from '../runners/adapters.js';
import { registerCommand } from './index.js';
import { localSessions, type ResolvedSession, resolveResume, resumeSpecs, type SessionSource } from './local-sessions.js';

export const WORKBENCHES = ['tmux', 'wezterm', 'kitty', 'warp', 'wt', 'orca', 'paseo', 'herdr', 'print'] as const;
export type Workbench = (typeof WORKBENCHES)[number];
export const AGENT_CLIS = ['claude', 'codex', 'gemini', 'opencode'] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];

export interface LaunchSeat {
  seatUrl: string;
  agent: AgentCli;
  /** The seat's letter, for names and titles. */
  letter: string;
  /** An existing session of this agent to reopen with the line as its next prompt (`--resume`). */
  resume?: string;
  /** Where its pane starts, when not the launch's directory: a resumed session's own folder. */
  dir?: string;
}

export interface LaunchInput {
  seats: LaunchSeat[];
  dir: string;
  /** A room this machine holds the key for: its short id, for a `crossroom watch` pane and names. */
  room?: string;
  /** How to run this command again, for the watch pane. */
  self: string[];
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
}

/**
 * One thing to do. A `run`'s argv may hold `{prev}`, the trimmed output of the last `run` that
 * captured: its last line, or with `pick`, the field at that dotted path of its JSON output.
 */
export type Step =
  | { kind: 'run'; argv: string[]; capture?: boolean; pick?: string }
  | { kind: 'write'; file: string; text: string }
  | { kind: 'open'; url: string }
  | { kind: 'say'; text: string };

/**
 * A seat link: an http(s) origin (a host name or address, a bracketed IPv6 address, an optional
 * port), then /j/<token>, nothing after it but an end-to-end room's key (`#e=<base64url>`). Every
 * character it admits is one no shell reads specially, since the link goes into a command line.
 */
const SEAT_LINK = /^(https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?)\/j\/([A-Za-z0-9_-]{8,200})(#e=[A-Za-z0-9_-]{1,200})?$/;

export function seatOrigin(seatUrl: string): string {
  const m = SEAT_LINK.exec(seatUrl);
  if (!m) throw new Usage('That is not a seat link (https://<host>/j/<token>).');
  return m[1]!;
}

function isLoopback(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === 'localhost' || host === '[::1]' || /^127\./.test(host);
}

/**
 * The command that starts an agent, interactive, with the paste line as its first prompt; with
 * `resume`, the command that reopens that session with the line as its next one, so the agent
 * joins with everything the session already knows.
 */
export function agentArgv(seat: LaunchSeat): string[] {
  const prompt = seatPrompt(seat.seatUrl);
  const origin = seatOrigin(seat.seatUrl);
  const resume = seat.resume;
  switch (seat.agent) {
    case 'claude':
      // The prompt first: --allowedTools takes every word after it.
      return ['claude', ...(resume ? ['--resume', resume] : []), prompt, '--allowedTools', curlRule(seat.seatUrl)];
    case 'codex': {
      // Root options go before `resume`, which reads them as its own.
      const connector = isLoopback(origin)
        ? []
        : [
            '-c',
            `mcp_servers.crossroom.url=${JSON.stringify(`${origin}/mcp/connect`)}`,
            '-c',
            'mcp_servers.crossroom.tool_timeout_sec=120',
            '-c',
            'mcp_servers.crossroom.default_tools_approval_mode="approve"',
          ];
      return ['codex', ...connector, ...(resume ? ['resume', resume] : []), prompt];
    }
    case 'gemini':
      if (resume) throw new Usage('Gemini CLI sessions found by Crossroom can\'t be reopened from here.');
      return ['gemini', '-i', prompt];
    case 'opencode':
      return ['opencode', ...(resume ? ['--session', resume] : []), '--prompt', prompt];
  }
}

/**
 * One word for a POSIX shell: bash, zsh and fish. Single quotes alone are not enough, since fish
 * reads a backslash before a quote or another backslash as an escape inside them. So a quote or a
 * backslash is written outside the single quotes, between double quotes, which all three read as
 * that one character, and the parts join into one word. A word that starts with `=` (zsh expands
 * it) or `~` is quoted too.
 */
export function shQuote(w: string): string {
  if (/^[A-Za-z0-9_./:@%+-][A-Za-z0-9_./:=@%+-]*$/.test(w)) return w;
  let out = '';
  let open = false;
  for (const ch of w) {
    if (ch === "'" || ch === '\\') {
      if (open) out += "'";
      open = false;
      out += ch === "'" ? `"'"` : '"\\\\"';
    } else {
      if (!open) out += "'";
      open = true;
      out += ch;
    }
  }
  return open ? `${out}'` : out || "''";
}

/** The characters PowerShell reads as a single quote: `'` and the curly ones, U+2018 to U+201B. */
const PS_QUOTES = new Set(["'", ...[0x2018, 0x2019, 0x201a, 0x201b].map((c) => String.fromCodePoint(c))]);

/**
 * One word for PowerShell, Warp's shell on Windows: single-quoted, each quote character doubled,
 * the curly ones included, since PowerShell ends a single-quoted string on any of them. No `@` at
 * a word's start bare (splatting).
 */
export function psQuote(w: string): string {
  if (/^[A-Za-z0-9_./:=%+-][A-Za-z0-9_./:=@%+-]*$/.test(w)) return w;
  return psQuoteAlways(w);
}

/** A PowerShell single-quoted string, whatever the word. */
export function psQuoteAlways(w: string): string {
  let out = "'";
  for (const ch of w) out += PS_QUOTES.has(ch) ? ch + ch : ch;
  return `${out}'`;
}

/** A PowerShell command line: a quoted program needs the call operator, or PowerShell reads it as a string. */
export function psLine(argv: string[]): string {
  const words = argv.map(psQuote);
  return words[0]?.startsWith("'") ? `& ${words.join(' ')}` : words.join(' ');
}

export const shellLine = (argv: string[], platform: NodeJS.Platform): string => (platform === 'win32' ? psLine(argv) : argv.map(shQuote).join(' '));

/**
 * One argument for `wt.exe`, which splits its own command line into commands at every `;`, inside
 * an argument too, unless the `;` is escaped as `\;`.
 */
export const wtArg = (w: string): string => w.replaceAll(';', '\\;');

/** A pane's program for Windows Terminal: Windows PowerShell running the line, which reaches no parser but PowerShell's. */
export function wtPaneArgv(line: string): string[] {
  return ['powershell.exe', '-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(line, 'utf16le').toString('base64')];
}

/** Where Warp keeps its Tab Configs (docs.warp.dev/terminal/windows/tab-configs). */
export function warpTabConfigDir(platform: NodeJS.Platform, home: string, env: Record<string, string | undefined>): string {
  // The target system's path rules, not this one's: a plan is made (and tested) for any system.
  if (platform === 'darwin') return path.posix.join(home, '.warp', 'tab_configs');
  if (platform === 'win32') return path.win32.join(env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming'), 'warp', 'Warp', 'data', 'tab_configs');
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'warp-terminal', 'tab_configs');
}

const toml = (s: string) => JSON.stringify(s);

/** A Warp Tab Config: one leaf pane per command, side by side, in two rows past three. */
export function warpTabConfig(name: string, title: string, dir: string, panes: Array<{ id: string; command: string; dir?: string }>): string {
  const lines = [`name = ${toml(name)}`, `title = ${toml(title)}`, 'color = "magenta"', ''];
  const leaf = (p: { id: string; command: string; dir?: string }, focused: boolean) =>
    ['[[panes]]', `id = ${toml(p.id)}`, 'type = "terminal"', `directory = ${toml(p.dir ?? dir)}`, `commands = [${toml(p.command)}]`, ...(focused ? ['is_focused = true'] : []), ''];
  const split = (id: string, dirn: 'horizontal' | 'vertical', children: string[]) => ['[[panes]]', `id = ${toml(id)}`, `split = "${dirn}"`, `children = [${children.map(toml).join(', ')}]`, ''];
  if (panes.length === 1) return [...lines, ...leaf(panes[0]!, true)].join('\n');
  if (panes.length <= 3) return [...lines, ...split('root', 'horizontal', panes.map((p) => p.id)), ...panes.flatMap((p, i) => leaf(p, i === 0))].join('\n');
  // Four or more: two rows, each at least two wide.
  const half = Math.ceil(panes.length / 2);
  const top = panes.slice(0, half);
  const bottom = panes.slice(half);
  return [
    ...lines,
    ...split('root', 'vertical', ['top', 'bottom']),
    ...split('top', 'horizontal', top.map((p) => p.id)),
    ...split('bottom', 'horizontal', bottom.map((p) => p.id)),
    ...panes.flatMap((p, i) => leaf(p, i === 0)),
  ].join('\n');
}

function openUrl(url: string, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['open', url];
  if (platform === 'win32') return ['cmd', '/c', 'start', '""', url];
  return ['xdg-open', url];
}

/** Orca's and Paseo's names for the agents (Orca's docs show claude and codex; the rest follow its groups, @gemini and @opencode). */
const WORKBENCH_AGENT: Record<AgentCli, string> = { claude: 'claude', codex: 'codex', gemini: 'gemini', opencode: 'opencode' };

/** What to do to seat each agent in a workbench. */
export function launchPlan(bench: Workbench, input: LaunchInput): Step[] {
  const { seats, dir, room, platform } = input;
  const name = room ? `crossroom-${room}` : 'crossroom';
  // Orca and Paseo start sessions of their own: a session found on this computer reopens only in a pane.
  if ((bench === 'orca' || bench === 'paseo') && seats.some((s) => s.resume))
    throw new Usage(`${bench === 'orca' ? 'Orca' : 'Paseo'} starts its own sessions, so --resume can't reopen one there. Use --in tmux, wezterm, kitty, warp, wt or print.`);
  const panes = seats.map((s) => ({ id: `seat-${s.letter.toLowerCase()}`, argv: agentArgv(s), seat: s, dir: s.dir ?? dir }));
  // A pane gets the workbench's environment, not this shell's: a data directory set only here goes with it.
  const data = input.env.PARLEY_DATA && platform !== 'win32' ? ['env', `PARLEY_DATA=${input.env.PARLEY_DATA}`] : [];
  const watch = room ? [...data, ...input.self, 'watch', room] : null;
  const steps: Step[] = [];
  const codexOff = seats.some((s) => s.agent === 'codex' && !isLoopback(seatOrigin(s.seatUrl)));
  switch (bench) {
    case 'tmux': {
      const [first, ...rest] = panes;
      steps.push({ kind: 'run', argv: ['tmux', 'new-window', '-P', '-F', '#{window_id}', '-n', name, '-c', first!.dir, ...first!.argv], capture: true });
      for (const p of rest) steps.push({ kind: 'run', argv: ['tmux', 'split-window', '-d', '-t', '{prev}', '-c', p.dir, ...p.argv] });
      if (watch) steps.push({ kind: 'run', argv: ['tmux', 'split-window', '-d', '-t', '{prev}', '-c', dir, ...watch] });
      steps.push({ kind: 'run', argv: ['tmux', 'select-layout', '-t', '{prev}', 'tiled'] });
      break;
    }
    case 'wezterm': {
      const [first, ...rest] = panes;
      steps.push({ kind: 'run', argv: ['wezterm', 'cli', 'spawn', '--cwd', first!.dir, '--', ...first!.argv], capture: true });
      for (const p of rest) steps.push({ kind: 'run', argv: ['wezterm', 'cli', 'split-pane', '--pane-id', '{prev}', '--right', '--cwd', p.dir, '--', ...p.argv], capture: true });
      if (watch) steps.push({ kind: 'run', argv: ['wezterm', 'cli', 'split-pane', '--pane-id', '{prev}', '--bottom', '--cwd', dir, '--', ...watch] });
      break;
    }
    case 'kitty': {
      const [first, ...rest] = panes;
      steps.push({ kind: 'run', argv: ['kitten', '@', 'launch', '--type=tab', '--tab-title', name, '--cwd', first!.dir, ...first!.argv], capture: true });
      for (const p of [...rest, ...(watch ? [{ argv: watch, dir }] : [])])
        steps.push({ kind: 'run', argv: ['kitten', '@', 'launch', '--type=window', '--next-to', 'id:{prev}', '--cwd', p.dir, ...p.argv], capture: true });
      break;
    }
    case 'warp': {
      const file = (platform === 'win32' ? path.win32 : path.posix).join(warpTabConfigDir(platform, input.home, input.env), `${name}.toml`);
      const all = [...panes.map((p) => ({ id: p.id, command: shellLine(p.argv, platform), dir: p.dir })), ...(watch ? [{ id: 'watch', command: shellLine(watch, platform) }] : [])];
      steps.push({ kind: 'write', file, text: warpTabConfig(name, room ? `Crossroom ${room}` : 'Crossroom', dir, all) });
      steps.push({ kind: 'open', url: `warp://tab_config/${name}` });
      steps.push({ kind: 'say', text: `Warp opens the tab "${name}" (${file}). It holds seat links: it is yours alone, and they stop working when the room ends.` });
      break;
    }
    case 'wt': {
      // Inside Windows Terminal, the window this command runs in; else a window of its own.
      const argv = ['wt', '-w', input.env.WT_SESSION ? '0' : 'new'];
      const pane = (verb: 'new-tab' | 'split-pane', title: string, paneDir: string, line: string) => {
        if (verb === 'split-pane') argv.push(';');
        argv.push(verb, '--title', wtArg(title), '--suppressApplicationTitle', '-d', wtArg(paneDir), ...wtPaneArgv(line).map(wtArg));
      };
      const label = room ? `Crossroom ${room}` : 'Crossroom';
      panes.forEach((p, i) => pane(i === 0 ? 'new-tab' : 'split-pane', `${label} ${p.seat.letter} (${p.seat.agent})`, p.dir, psLine(p.argv)));
      if (watch) {
        // A pane gets Windows Terminal's environment, not this shell's: a data directory set only here goes with it.
        const data = input.env.PARLEY_DATA ? `$env:PARLEY_DATA = ${psQuote(input.env.PARLEY_DATA)}; ` : '';
        pane('split-pane', `${label} watch`, dir, data + psLine(watch));
      }
      steps.push({ kind: 'run', argv });
      break;
    }
    case 'herdr': {
      // A herdr workspace named for the room, a pane each, and in it the agent herdr itself starts,
      // so herdr knows it as an agent (its state, focus, prompts). Each agent is named
      // `crossroom-<room>-<letter>` in lowercase, which is how a desktop bar finds a seat's agent again.
      const [first, ...rest] = panes;
      // herdr takes agent names of lowercase letters, digits, - and _, at most 32: room ids are mixed case.
      const agentName = (letter: string) => `${name}-${letter}`.toLowerCase();
      const start = (p: (typeof panes)[number]) =>
        steps.push({ kind: 'run', argv: ['herdr', 'agent', 'start', agentName(p.seat.letter), '--kind', p.seat.agent, '--pane', '{prev}', '--', ...p.argv.slice(1)] });
      steps.push({ kind: 'run', argv: ['herdr', 'workspace', 'create', '--cwd', first!.dir, '--label', name, '--focus'], capture: true, pick: 'result.root_pane.pane_id' });
      start(first!);
      rest.forEach((p, i) => {
        steps.push({ kind: 'run', argv: ['herdr', 'pane', 'split', '{prev}', '--direction', i % 2 === 0 ? 'right' : 'down', '--cwd', p.dir], capture: true, pick: 'result.pane.pane_id' });
        start(p);
      });
      if (watch) steps.push({ kind: 'say', text: `Follow the room in any herdr pane: ${shellLine(watch, platform)}` });
      break;
    }
    case 'orca':
      for (const p of panes) steps.push({ kind: 'run', argv: ['orca', 'agent', 'launch', '--agent', WORKBENCH_AGENT[p.seat.agent], '--prompt', seatPrompt(p.seat.seatUrl), '--json'] });
      if (watch) steps.push({ kind: 'say', text: `Follow the room in any Orca terminal: ${shellLine(watch, platform)}` });
      break;
    case 'paseo':
      for (const p of panes)
        steps.push({
          kind: 'run',
          argv: ['paseo', 'run', '--provider', WORKBENCH_AGENT[p.seat.agent], '--title', `${name}-${p.seat.letter.toLowerCase()}`, '--no-wait', '--quiet', seatPrompt(p.seat.seatUrl)],
        });
      if (watch) steps.push({ kind: 'say', text: `Follow the room here: ${shellLine(watch, platform)}` });
      break;
    case 'print':
      steps.push({ kind: 'say', text: 'Run each in a terminal of its own:' });
      // PowerShell on Windows: Windows PowerShell 5.1 reads no `&&`, and cmd reads no single quotes.
      for (const p of panes)
        steps.push({
          kind: 'say',
          text:
            platform === 'win32'
              ? `  Seat ${p.seat.letter} (PowerShell): Set-Location -LiteralPath ${psQuoteAlways(p.dir)}; ${psLine(p.argv)}`
              : `  Seat ${p.seat.letter}: cd ${shQuote(p.dir)} && ${shellLine(p.argv, platform)}`,
        });
      if (watch) steps.push({ kind: 'say', text: `  Follow the room: ${shellLine(watch, platform)}` });
      break;
  }
  if (codexOff && (bench === 'orca' || bench === 'paseo'))
    steps.push({
      kind: 'say',
      text: `Codex's sandbox reaches no host but this computer's, so a Codex seat joins through the connector. Once: codex mcp add crossroom --url ${seatOrigin(seats.find((s) => s.agent === 'codex')!.seatUrl)}/mcp/connect`,
    });
  return steps;
}

/** The workbench this terminal belongs to, or `print` where Crossroom can start no pane. */
export function workbenchOf(env: Record<string, string | undefined>, has: (bin: string) => boolean, platform: NodeJS.Platform): Workbench {
  // herdr (Omarchy's agent workspace) marks each of its panes, whatever terminal shows it.
  if (env.HERDR_PANE_ID && has('herdr')) return 'herdr';
  if (env.ORCA_PANE_KEY && has('orca')) return 'orca';
  if (env.TMUX && has('tmux')) return 'tmux';
  if (env.WEZTERM_PANE && has('wezterm')) return 'wezterm';
  if (env.KITTY_WINDOW_ID && env.KITTY_LISTEN_ON && has('kitten')) return 'kitty';
  if (env.TERM_PROGRAM === 'WarpTerminal') return 'warp';
  // Windows Terminal ships with Windows 11: a tab of its own wherever it is installed, in this window when inside it.
  if (platform === 'win32' && has('wt')) return 'wt';
  return 'print';
}

/** Which agent sits in each seat: one name for every seat, or one per seat, in order. */
export function agentsFor(withFlag: string | undefined, count: number): AgentCli[] {
  const names = (withFlag ?? 'claude').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const n of names) if (!(AGENT_CLIS as readonly string[]).includes(n)) throw new Usage(`--with takes ${AGENT_CLIS.join(', ')}; "${n}" is not one.`);
  if (names.length === 1) return Array(count).fill(names[0]) as AgentCli[];
  if (names.length !== count) throw new Usage(`--with names ${names.length} agents for ${count} seats: name one for every seat, or one for all.`);
  return names as AgentCli[];
}

export interface Runner {
  run(argv: string[]): { ok: boolean; out: string; err: string };
  write(file: string, text: string): void;
  say(line: string): void;
}

const realRunner: Runner = {
  run(argv) {
    const bin = resolveBin(argv[0]!);
    if (!bin) return { ok: false, out: '', err: `${argv[0]} is not on PATH` };
    // A Windows .cmd shim can't be spawned without a shell, which would split the arguments again.
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) return { ok: false, out: '', err: `${argv[0]} is a .cmd shim here; use --in print` };
    const r = spawnSync(bin, argv.slice(1), { encoding: 'utf8', timeout: 30_000 });
    return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '') || (r.error?.message ?? '') };
  },
  write(file, body) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, { mode: 0o600 });
    chmodSync(file, 0o600);
  },
  say: (l) => console.log(l),
};

/**
 * The field at a dotted path of a command's JSON output, as text; empty when the output is not
 * JSON or holds no such field, which the next step then fails on with the workbench's own error.
 */
export function picked(out: string, field: string): string {
  let v: unknown;
  try {
    v = JSON.parse(out);
  } catch {
    return '';
  }
  for (const k of field.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

/** Do a plan, step by step; the first that fails stops it, and says how. */
export function runPlan(steps: Step[], platform: NodeJS.Platform, r: Runner = realRunner): void {
  let prev = '';
  for (const s of steps) {
    if (s.kind === 'say') r.say(s.text);
    else if (s.kind === 'write') r.write(s.file, s.text);
    else {
      const argv = s.kind === 'open' ? openUrl(s.url, platform) : s.argv.map((a) => a.replaceAll('{prev}', prev));
      const res = r.run(argv);
      if (!res.ok) throw new Usage(`${argv.slice(0, 3).join(' ')} failed: ${(res.err || res.out).trim().split('\n')[0] || 'no reason given'}. Try --in print.`);
      if (s.kind === 'run' && s.capture) prev = s.pick ? picked(res.out, s.pick) : (res.out.trim().split('\n').pop()?.trim() ?? '');
    }
  }
}

/** How to run this command again from a pane: `crossroom` where it is on PATH, else this very Node and script. */
export function selfArgv(): string[] {
  if (resolveBin('crossroom')) return ['crossroom'];
  return [process.execPath, ...process.execArgv.filter((a) => !a.startsWith('--inspect')), process.argv[1] ?? 'crossroom'];
}

/** The sessions `--resume` names, each checked to be one a pane can reopen, and none named twice. */
export async function resumedSessions(args: Args, source?: SessionSource): Promise<ResolvedSession[]> {
  const specs = resumeSpecs(args.flags.resume, args.values?.resume);
  if (!specs.length) return [];
  const from = source ?? (await localSessions());
  const out: ResolvedSession[] = [];
  for (const spec of specs) {
    const s = await resolveResume(spec, from);
    if (out.some((o) => o.harness === s.harness && o.nativeId === s.nativeId)) throw new Usage(`--resume names session ${s.nativeId} twice: one session takes one seat.`);
    out.push(s);
  }
  return out;
}

/** The workbench `--in` names, or the one this terminal belongs to. */
export function benchOf(args: Args): Workbench {
  const benchFlag = text(args.flags.in) ?? 'auto';
  if (benchFlag !== 'auto' && !(WORKBENCHES as readonly string[]).includes(benchFlag)) throw new Usage(`--in takes auto, ${WORKBENCHES.join(', ')}.`);
  return benchFlag === 'auto' ? workbenchOf(process.env, (b) => resolveBin(b) !== null, process.platform) : (benchFlag as Workbench);
}

/**
 * Seat agents from the links given, in the workbench named or found. The sessions `--resume`
 * named take the first seats, reopened in their own folders; `--with`'s agents take the rest.
 * Shared with `crossroom new --launch`, which passes the room's short id, the seats' letters (B on,
 * when it took A) and the sessions it resolved before opening the room.
 */
export async function launchSeats(
  seatUrls: string[],
  args: Args,
  opts: { room?: string; letters?: string[]; resumed?: ResolvedSession[] } = {},
): Promise<void> {
  const bench = benchOf(args);
  const resumed = opts.resumed ?? (await resumedSessions(args));
  if (resumed.length > seatUrls.length) throw new Usage(`--resume names ${resumed.length} sessions for ${seatUrls.length} seats.`);
  const rest = seatUrls.length - resumed.length;
  const agents = rest ? agentsFor(text(args.flags.with), rest) : [];
  for (const u of seatUrls) seatOrigin(u);
  const dir = path.resolve(text(args.flags.dir) ?? process.cwd());
  const seats: LaunchSeat[] = seatUrls.map((seatUrl, i) => {
    const letter = opts.letters?.[i] ?? slotLetter(i);
    const r = resumed[i];
    return r ? { seatUrl, agent: r.harness, letter, resume: r.nativeId, dir: r.cwd } : { seatUrl, agent: agents[i - resumed.length]!, letter };
  });
  const plan = launchPlan(bench, { seats, dir, room: opts.room, self: selfArgv(), platform: process.platform, home: os.homedir(), env: process.env });
  // With --json, stdout is the room's JSON: what this says goes to stderr.
  const say = args.flags.json === true ? (l: string) => console.error(l) : (l: string) => console.log(l);
  if (args.flags['dry-run'] === true) {
    for (const s of plan)
      say(s.kind === 'run' ? shellLine(s.argv, process.platform) : s.kind === 'open' ? shellLine(openUrl(s.url, process.platform), process.platform) : s.kind === 'write' ? `# write ${s.file}\n${s.text}` : s.text);
    return;
  }
  runPlan(plan, process.platform, { ...realRunner, say });
  if (bench !== 'print')
    say(`Started in ${bench}: ${seats.map((s) => `${s.agent}${s.resume ? ` (session ${s.resume.slice(0, 8)})` : ''} in seat ${s.letter}`).join(', ')}.`);
}

const READ_CAP = 64 * 1024;

registerCommand({
  name: 'launch',
  topic: 'start',
  synopsis: 'crossroom launch <seat link>...',
  usage: 'crossroom launch <seat link>... | -',
  summary: 'agents into seats, a pane each: tmux, WezTerm, kitty, Warp, Windows Terminal, Orca, Paseo or herdr',
  more: [
    { usage: '[--with claude|codex|gemini|opencode[,…]] [--in auto|tmux|wezterm|kitty|warp|wt|orca|paseo|herdr|print]' },
    { usage: '[--resume claude:<id>[,…]]', summary: 'reopen sessions already on this computer in the first seats (crossroom sessions lists them)' },
    { usage: '[--dir <dir>] [--dry-run]', summary: 'where the agents start; print the commands instead of running them' },
  ],
  order: 17,
  async run(args) {
    let links = args.positional;
    if (links.length === 1 && links[0] === '-') links = readFileSync(0).subarray(0, READ_CAP).toString('utf8').split(/\s+/);
    links = links.filter((l) => /^https?:\/\//.test(l));
    if (!links.length) throw new Usage('Give the seat links to fill (or - to read them from stdin), as `crossroom new` prints them.');
    await launchSeats(links, args);
    return 0;
  },
});
