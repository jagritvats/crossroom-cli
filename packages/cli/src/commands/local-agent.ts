/**
 * An agent of the person's own, started on this computer into one seat of a room: what `crossroom
 * ask <dir>`, `crossroom ask --each` (a directory's room) and `crossroom panel open` (a seat with a
 * runner and a folder) do for the seat they do not hand back. The room lives on the instance; the
 * agent runs here, in the folder, under the person's own sign-ins.
 *
 * It is `crossroom join - --dir <dir>` (runner/join.ts), started in the background with the seat link
 * on its stdin, so the link is in no process's arguments. `join` brings the runner's protections
 * (the loopback egress proxy, the policy, no token in any argument) and ends when the room ends or
 * the seat finishes. Its output goes to a log under the data directory, which the caller names.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { dataDir, Usage } from '../cli.js';

export interface LocalAgent {
  /** `claude`, `codex` or `grok`. */
  runtime: string;
  /** Its label, for messages ("Claude Code"). */
  label: string;
  dir: string;
  model?: string;
  /** The person passed `--unconfined-reads-ok`: Codex and Grok read outside the folder. */
  unconfinedOk?: boolean;
}

/** Runtimes whose reads are not confined to the folder, so `join` asks for the acknowledgement. */
const UNCONFINED = new Set(['codex', 'grok']);

/**
 * Refused before any room is opened: a Codex or Grok agent can read files outside its folder, and
 * the person says they know that with `--unconfined-reads-ok`, as `crossroom join` asks.
 */
export function checkConfinement(a: Pick<LocalAgent, 'runtime' | 'label' | 'unconfinedOk'>): void {
  if (UNCONFINED.has(a.runtime) && !a.unconfinedOk)
    throw new Usage(
      `${a.label} can read files outside the folder it works in (its sandbox confines writes, not reads). Pass --unconfined-reads-ok to start it anyway, or --with claude, which is confined. Nothing was opened.`,
    );
}

/** The arguments of the `crossroom join` this computer starts for a seat, its link on stdin. */
export function joinArgs(a: LocalAgent): string[] {
  return [
    'join',
    '-',
    '--dir',
    a.dir,
    '--with',
    a.runtime,
    ...(a.model ? ['--model', a.model] : []),
    ...(UNCONFINED.has(a.runtime) && a.unconfinedOk ? ['--unconfined-reads-ok'] : []),
  ];
}

/**
 * A path as a person would type it in a printed command: bare when it holds nothing a shell reads,
 * else in double quotes. Never through JSON, which doubles every backslash of a Windows path.
 */
export const shellArg = (s: string): string => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** Where a seat's agent writes what it says about itself: one file a seat. */
export const agentLogPath = (roomId: string, letter: string) => path.join(dataDir(), 'agents', `${roomId.slice(0, 12)}-${letter}.log`);

/**
 * Start the agent for one seat and leave it running: its process outlives this command, as a room's
 * agents must, and ends with the room. Returns where its log is.
 */
export function startLocalAgent(link: string, a: LocalAgent, where: { roomId: string; letter: string }, o: { spawn?: typeof spawn } = {}): { log: string } {
  // Set by the test setup: under a test runner `process.argv[1]` is the runner, not
  // this command, and an agent started here would be a real one in a real room.
  if (!o.spawn && process.env.PARLEY_NO_LOCAL_AGENTS === '1') throw new Usage('Starting an agent on this computer is turned off here (PARLEY_NO_LOCAL_AGENTS).');
  const start = o.spawn ?? spawn;
  const log = agentLogPath(where.roomId, where.letter);
  mkdirSync(path.dirname(log), { recursive: true });
  const fd = openSync(log, 'a');
  try {
    // process.execArgv carries tsx's loader when this runs from the repository; the package's
    // bundle has none. Either way the same entry point starts, as `join`.
    const child = start(process.execPath, [...process.execArgv, process.argv[1]!, ...joinArgs(a)], {
      detached: true,
      stdio: ['pipe', fd, fd],
      windowsHide: true,
      cwd: a.dir,
    });
    child.stdin!.end(`${link}\n`);
    child.unref();
  } finally {
    closeSync(fd);
  }
  return { log };
}
