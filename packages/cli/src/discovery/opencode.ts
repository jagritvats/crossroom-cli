/**
 * OpenCode sessions on this computer.
 *
 * Recent: the driver's own client (`session.list`), which talks only to the sidecar Crossroom starts.
 * Live: only `opencode service status`, which says whether the shared service runs, not which
 * sessions it has open. Crossroom never asks the service itself: finding it means reading its
 * password file, and neither that nor `service.json` is ever opened.
 */
import { resolveBin } from '../runners/adapters.js';
import type { NativeSession } from './native.js';
import type { LiveState, ProbeContext, ProbeSession, SessionProbe } from './probe.js';

const STATUS_TIMEOUT_MS = 6000;
/** How long a service answer stands in for `live()`, which may not spawn anything. */
const STATUS_TTL_MS = 30_000;

/** Running, stopped, or undefined when the answer could not be read. */
export function serviceRunning(output: string): boolean | undefined {
  if (/\b(not running|stopped|inactive|not installed)\b/i.test(output)) return false;
  if (/\b(running|active)\b/i.test(output)) return true;
  return undefined;
}

/** The shared service may hold any session open, and Crossroom cannot see its exit. */
const possiblyOpen: LiveState = { status: 'unknown', surface: 'unknown', exit: 'none' };

export function openCodeProbe(ctx: ProbeContext): SessionProbe {
  let known: { running: boolean | undefined; at: number } | undefined;
  const executable = () => ctx.driver().executable ?? resolveBin('opencode');
  const status = async () => {
    let running: boolean | undefined;
    const binary = executable();
    if (binary && !/\.(cmd|bat)$/i.test(binary)) {
      try {
        running = serviceRunning(await ctx.process.run(binary, ['service', 'status'], { timeoutMs: STATUS_TIMEOUT_MS, maxBytes: 64 * 1024 }));
      } catch (error) {
        // A non-zero exit can still be a plain "stopped".
        const stdout = (error as { stdout?: string }).stdout;
        running = stdout ? serviceRunning(stdout) : undefined;
      }
    }
    known = { running, at: ctx.now() };
    return running;
  };
  const state = (running: boolean | undefined) => (running === false ? null : { ...possiblyOpen });
  const fromNative = (session: NativeSession, running: boolean | undefined): ProbeSession => ({
    nativeId: session.id,
    cwd: session.cwd,
    title: session.title,
    lastActiveAt: session.updatedAt,
    live: state(running),
    source: 'server',
    nativeVersion: session.version,
    kind: session.parentId ? 'subagent' : session.kind,
  });
  return {
    harness: 'opencode',
    live() {
      return Promise.resolve(known && ctx.now() - known.at < STATUS_TTL_MS ? state(known.running) : { ...possiblyOpen });
    },
    async list(options) {
      // Without OpenCode on this computer there is nothing to list, and nothing worth a warning.
      if (!executable()) return { sessions: [], source: 'server' };
      const driver = ctx.driver();
      if (!driver.listSessions) throw new Error('This OpenCode adapter cannot list sessions yet.');
      const running = await status();
      if (options.liveOnly && running === false) return { sessions: [], source: 'server' };
      const listed = await driver.listSessions({ limit: options.limit, directory: options.directory, signal: options.signal });
      return {
        sessions: listed.map((session) => fromNative(session, running)),
        source: 'server',
        truncated: listed.length >= options.limit,
        ...(running === undefined
          ? { detail: 'Crossroom cannot tell whether the OpenCode service is running, so it offers copies of its sessions only.' }
          : running
            ? { detail: 'The OpenCode service is running and may have any of these open, so Crossroom offers copies only.' }
            : {}),
      };
    },
  };
}
