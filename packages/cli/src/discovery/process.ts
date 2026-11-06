/**
 * What discovery may learn about a process it did not start: whether a pid is alive, when that
 * process started (so a pid the OS handed to someone else is not mistaken for the agent), and
 * whether a lock file is held. Nothing here reads a process's memory, arguments or environment.
 *
 * Every spawn is bounded, hidden on Windows and run without a shell.
 */
import { execFile } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveBin } from '../runners/adapters.js';

export interface ProcessOps {
  /** True while a process with this pid exists, ours or not. */
  alive(pid: number): boolean;
  /** When the process with this pid started, in epoch milliseconds; undefined when unknown. */
  startedAt(pid: number): Promise<number | undefined>;
  /** Per file: true held, false not held (or gone), undefined when this computer cannot tell. */
  locksHeld(files: string[]): Promise<Map<string, boolean | undefined>>;
  /** Runs an executable (never a shell) and returns its stdout. */
  run(file: string, args: string[], options: { timeoutMs: number; maxBytes: number; cwd?: string }): Promise<string>;
}

const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;

export function pidAlive(pid: number): boolean {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function run(file: string, args: string[], options: { timeoutMs: number; maxBytes: number; cwd?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: options.maxBytes, windowsHide: true, shell: false, cwd: options.cwd },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** 100 ns intervals from 1601 to 1970, for converting a Windows FILETIME. */
const FILETIME_EPOCH = 116444736000000000n;
export function fileTimeToMs(value: string): number | undefined {
  if (!/^\d{15,20}$/.test(value)) return undefined;
  const ms = Number((BigInt(value) - FILETIME_EPOCH) / 10000n);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** Windows PowerShell from System32, never whichever `powershell` comes first on PATH. */
const powershell = () =>
  path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export async function processStartedAt(pid: number, timeoutMs = 3000): Promise<number | undefined> {
  if (!validPid(pid)) return undefined;
  try {
    if (process.platform === 'win32') {
      const out = await run(
        powershell(),
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`],
        { timeoutMs, maxBytes: 4096 },
      );
      return fileTimeToMs(out.trim());
    }
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // The command name is in parentheses and may hold spaces; fields resume after the last ')'.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(fields[19]);
      const boot = /^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'))?.[1];
      // USER_HZ is 100 on every Linux Crossroom runs on; getconf would cost a spawn per call.
      return Number.isFinite(ticks) && boot ? Number(boot) * 1000 + ticks * 10 : undefined;
    }
    const ps = resolveBin('ps');
    if (!ps) return undefined;
    const out = await run(ps, ['-o', 'lstart=', '-p', String(pid)], { timeoutMs, maxBytes: 4096 });
    const ms = Date.parse(out.trim());
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Codex keeps a zero-byte writer lock per open thread, and the files linger after it closes, so
 * only a held one means open. On Windows a held lock refuses to open (EBUSY, or EPERM while it is
 * being released). On POSIX, lsof names the files some process has open; without lsof Crossroom
 * cannot tell, and says so instead of guessing.
 */
export async function locksHeld(files: string[]): Promise<Map<string, boolean | undefined>> {
  const result = new Map<string, boolean | undefined>();
  if (!files.length) return result;
  if (process.platform === 'win32') {
    for (const file of files) {
      try {
        closeSync(openSync(file, 'r+'));
        result.set(file, false);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        result.set(file, code === 'EBUSY' || code === 'EPERM' ? true : code === 'ENOENT' ? false : undefined);
      }
    }
    return result;
  }
  const lsof = resolveBin('lsof');
  if (!lsof) {
    for (const file of files) result.set(file, undefined);
    return result;
  }
  let out = '';
  try {
    out = await run(lsof, ['-Fn', '--', ...files], { timeoutMs: 3000, maxBytes: 256 * 1024 });
  } catch (error) {
    // lsof exits 1 when none of the files is open; anything else is unknown.
    const failed = error as { code?: unknown; stdout?: string; killed?: boolean };
    if (failed.code !== 1 || failed.killed) {
      for (const file of files) result.set(file, undefined);
      return result;
    }
    out = failed.stdout ?? '';
  }
  // lsof may print a resolved path (/private/var on macOS), so match on the lock's own name.
  const open = new Set(
    out
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => path.basename(line.slice(1))),
  );
  for (const file of files) result.set(file, open.has(path.basename(file)));
  return result;
}

/** A process's start time does not change while it lives; ask again after a while, since a pid can be reused. */
const STARTED_TTL_MS = 10_000;
const started = new Map<number, { at: number; value: Promise<number | undefined> }>();
function cachedStartedAt(pid: number) {
  const now = Date.now();
  const hit = started.get(pid);
  if (hit && now - hit.at < STARTED_TTL_MS) return hit.value;
  if (started.size > 256) for (const [key, entry] of started) if (now - entry.at >= STARTED_TTL_MS) started.delete(key);
  const value = processStartedAt(pid);
  started.set(pid, { at: now, value });
  return value;
}

export const systemProcess: ProcessOps = {
  alive: pidAlive,
  startedAt: cachedStartedAt,
  locksHeld,
  run,
};

/**
 * Whether a live pid is still the process a record describes. `recordedStart` is that process's
 * own start (exact); `recordedAfter` is a moment the process was already running, such as when
 * it opened a session. A reused pid belongs to a process that started later. Unknown is kept as
 * the same process: thinking a session is open is the safe mistake.
 */
export async function sameProcess(
  ops: ProcessOps,
  pid: number,
  recorded: { start?: number; after?: number },
): Promise<boolean> {
  if (!ops.alive(pid)) return false;
  if (recorded.start === undefined && recorded.after === undefined) return true;
  const observed = await ops.startedAt(pid);
  if (observed === undefined) return true;
  if (recorded.start !== undefined) return Math.abs(observed - recorded.start) <= 1000;
  return observed <= recorded.after! + 2000;
}
