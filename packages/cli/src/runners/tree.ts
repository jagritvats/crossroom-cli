/**
 * Stop a CLI and everything it started.
 *
 * `ChildProcess.kill` ends only the direct child. On Windows that leaves the shells, sandboxes
 * and helpers a CLI spawned running on their own; a hung `run_command` is exactly such a
 * grandchild. So Windows kills the tree by PID (never by image name: other Node processes on
 * this machine are not ours).
 *
 * POSIX signals the process group the child leads, since it is spawned detached there. A group
 * does not reach everything, though. A CLI that runs its commands in a terminal gives each one a
 * session of its own, which a pseudo-terminal needs, and a hung command there outlived the group
 * signal. The tree tests caught it on Linux, where they had never run. So every descendant is
 * signalled too, listed before anything is signalled: once the CLI dies its children belong to
 * init, and nothing traces them back to it.
 *
 * No imports but Node's own, so a harness on any platform can load this file as it is.
 */
import { spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/** Every process below `pid`, from one `ps` listing; none where `ps` cannot be run. */
export function descendants(pid: number): number[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || typeof r.stdout !== 'string') return [];
  const children = new Map<number, number[]>();
  for (const line of r.stdout.split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!p || !pp) continue;
    const list = children.get(pp);
    if (list) list.push(p);
    else children.set(pp, [p]);
  }
  const out: number[] = [];
  const stack = [pid];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

export function killTree(proc: ChildProcess, graceMs = 3000) {
  const pid = proc.pid;
  if (!pid || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
    return;
  }
  const below = descendants(pid);
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {
        /* already gone */
      }
    }
    for (const d of below) {
      try {
        process.kill(d, sig);
      } catch {
        /* already gone */
      }
    }
  };
  signal('SIGTERM');
  // Only while the CLI itself is still running: after it has gone, its group id and the pids
  // listed above may already belong to processes that are none of Crossroom's business.
  const hard = setTimeout(() => signal('SIGKILL'), graceMs);
  hard.unref();
  proc.once('close', () => clearTimeout(hard));
}
