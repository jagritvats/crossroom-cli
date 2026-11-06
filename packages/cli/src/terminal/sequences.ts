/**
 * What a terminal shows when a room needs its person, written as the terminal's own escape
 * sequences. Pure: every function answers a string, and
 * the caller decides whether to write it.
 *
 * - **Which terminal.** `terminalOf` reads the environment the terminal sets in its panes, never a
 *   guess from `TERM` alone. Inside tmux `TERM_PROGRAM` is `tmux`, so the outer terminal is read
 *   from the variables tmux inherited (`KITTY_WINDOW_ID`, `WEZTERM_PANE`, `WT_SESSION`...).
 * - **What a sequence may say.** Only Crossroom's own words, a seat letter and a room's short id,
 *   like a system notice (os-notice.ts): never a room's title, a seat's name or anything a
 *   participant wrote. `plainAscii` blanks everything outside printable ASCII on top of that, so no
 *   text can end a sequence early (ESC, BEL, ST, C1) or start another.
 * - **Inside tmux** a sequence the outer terminal must see goes through tmux's passthrough
 *   (`ESC P tmux; ... ESC \`, every ESC doubled), which needs `set -g allow-passthrough on`. The
 *   title is not wrapped: tmux reads it itself as the pane's title.
 */

export const ESC = '\x1b';
export const BEL = '\x07';
/** String terminator: ESC backslash. */
export const ST = `${ESC}\\`;

/** The terminals Crossroom knows how to signal. `other` gets a title and a bell. */
export type TerminalKind = 'warp' | 'kitty' | 'ghostty' | 'iterm2' | 'wezterm' | 'windows-terminal' | 'vscode' | 'foot' | 'orca' | 'apple-terminal' | 'other';

export interface Terminal {
  kind: TerminalKind;
  /** Running inside tmux: sequences for the outer terminal need passthrough. */
  tmux: boolean;
}

type Env = Record<string, string | undefined>;

/** The terminal this process writes to, from the variables terminals set in their panes. */
export function terminalOf(env: Env = process.env): Terminal {
  const tmux = Boolean(env.TMUX);
  const prog = env.TERM_PROGRAM ?? '';
  const term = env.TERM ?? '';
  let kind: TerminalKind = 'other';
  // Orca's own variable is internal (src/main/agent-hooks), so it only names the workbench;
  // what Orca shows is decided by the OSC 7501 probe, which Orca answers.
  if (env.ORCA_PANE_KEY) kind = 'orca';
  else if (prog === 'WarpTerminal' || env.WARP_CLI_AGENT_PROTOCOL_VERSION || env.WARP_IS_LOCAL_SHELL_SESSION) kind = 'warp';
  else if (env.KITTY_WINDOW_ID || term === 'xterm-kitty') kind = 'kitty';
  else if (prog === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) kind = 'ghostty';
  else if (env.WEZTERM_PANE || prog === 'WezTerm') kind = 'wezterm';
  else if (prog === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2') kind = 'iterm2';
  else if (env.WT_SESSION) kind = 'windows-terminal';
  else if (prog === 'vscode') kind = 'vscode';
  else if (term.startsWith('foot')) kind = 'foot';
  else if (prog === 'Apple_Terminal') kind = 'apple-terminal';
  return { kind, tmux };
}

/** Printable ASCII only: anything else becomes a space, so no text can end or start a sequence. */
export function plainAscii(s: string, max = 200): string {
  return s.replace(/[^\x20-\x7e]/g, ' ').slice(0, max);
}

/** A sequence the outer terminal must see, through tmux's passthrough when inside tmux. */
export function passthrough(seq: string, t: Pick<Terminal, 'tmux'>): string {
  return t.tmux ? `${ESC}Ptmux;${seq.replaceAll(ESC, ESC + ESC)}${ST}` : seq;
}

/** The window or tab title (OSC 2). Not wrapped for tmux, which reads it as the pane's title. */
export const titleSeq = (title: string): string => `${ESC}]2;${plainAscii(title, 120)}${ST}`;
/** Keep the current title on xterm's title stack, and put it back (CSI 22;2 t, CSI 23;2 t). */
export const pushTitle = `${ESC}[22;2t`;
export const popTitle = `${ESC}[23;2t`;

/** A desktop notification as OSC 9 (iTerm2's form): one line, no title. */
export const osc9 = (body: string): string => `${ESC}]9;${plainAscii(body)}${ST}`;

/** A desktop notification as OSC 777 (urxvt's form): `notify;<title>;<body>`. The title can't hold `;`. */
export const osc777 = (title: string, body: string): string =>
  `${ESC}]777;notify;${plainAscii(title, 80).replaceAll(';', ',')};${plainAscii(body)}${ST}`;

/**
 * A desktop notification as OSC 99 (kitty's form): the title, then the body, under one id, so a
 * newer notice of the same id replaces the older (sw.kovidgoyal.net/kitty/desktop-notifications).
 */
export function osc99(id: string, title: string, body: string): string {
  const i = plainAscii(id, 32).replace(/[^A-Za-z0-9_+.-]/g, '-');
  return `${ESC}]99;i=${i}:d=0:p=title;${plainAscii(title, 80)}${ST}${ESC}]99;i=${i}:d=1:p=body;${plainAscii(body)}${ST}`;
}

/** ConEmu's progress (OSC 9;4): 0 clears it, 3 is busy with no amount, 4 is paused (waiting on someone). */
export const progressSeq = (state: 0 | 1 | 2 | 3 | 4, value = 0): string => `${ESC}]9;4;${state};${Math.max(0, Math.min(100, Math.round(value)))}${ST}`;

/** One program's state, per the Program Status Protocol (OSC 7501, revision 0.4). */
export type ProgramState = 'working' | 'idle' | 'done' | 'blocked' | 'error' | 'clear';
export interface ProgramStatus {
  state: ProgramState;
  /** `room` or `room/seat`: each report replaces the record of its id. */
  id: string;
  kind?: 'permission' | 'question' | 'auth';
  title?: string;
  msg?: string;
}

const b64 = (s: string) => Buffer.from(plainAscii(s, 600), 'utf8').toString('base64');
/** The protocol caps a whole sequence at 4096 bytes. */
const STATUS_MAX = 4096;

/** An OSC 7501 report, `app=crossroom` in every one, as the protocol asks. */
export function statusSeq(s: ProgramStatus): string {
  const id = plainAscii(s.id, 64).replace(/[^A-Za-z0-9_/.-]/g, '-');
  const parts = [`state=${s.state}`, `id=${id}`, 'app=crossroom'];
  if (s.kind) parts.push(`kind=${s.kind}`);
  if (s.title) parts.push(`title=${b64(s.title)}`);
  if (s.msg) parts.push(`msg=${b64(s.msg)}`);
  const seq = `${ESC}]7501;${parts.join(':')}${ST}`;
  return seq.length <= STATUS_MAX ? seq : `${ESC}]7501;${parts.slice(0, 3).join(':')}${ST}`;
}

/** The probe: does this terminal read OSC 7501? Followed by DA1, which every terminal answers. */
export const STATUS_PROBE = `${ESC}]7501;?${ST}${ESC}[c`;

/** Whether a terminal's answer to `STATUS_PROBE` says it reads OSC 7501: a 7501 reply before DA1's. */
export function probeSaysYes(answer: string): boolean {
  const da1 = answer.search(/\x1b\[\?[0-9;]*c/);
  const status = answer.indexOf(`${ESC}]7501;`);
  return status >= 0 && (da1 < 0 || status < da1);
}

/** How a terminal shows a notice: the sequence it reads, or a bell where it reads none Crossroom knows. */
export function noticeSeq(t: Terminal, n: { id: string; title: string; body: string }): string {
  let seq: string;
  switch (t.kind) {
    case 'kitty':
      seq = osc99(n.id, n.title, n.body);
      break;
    case 'iterm2':
      seq = osc9(`${n.title}: ${n.body}`);
      break;
    case 'warp':
    case 'ghostty':
    case 'wezterm':
    case 'foot':
      seq = osc777(n.title, n.body);
      break;
    default:
      // A bell marks the tab in nearly every terminal, Apple's and VS Code's included, and in tmux's
      // status line, which shows it without any passthrough.
      return BEL;
  }
  return passthrough(seq, t);
}

/** Whether the terminal shows OSC 9;4 progress where Crossroom can keep it current. */
export const showsProgress = (t: Terminal): boolean => t.kind === 'windows-terminal';
