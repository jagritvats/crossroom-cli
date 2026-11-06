/**
 * Finds the agent sessions on this computer, Crossroom's own and everyone else's, for
 * `crossroom sessions` and `--resume`. It reads only what each harness documents or leaves in its
 * own session records, copies an allowlist of fields, and never opens a credential file.
 */
import path from 'node:path';
import { Harness as Harnesses, type DiscoveredSession, type DiscoveryReport, type Harness } from '@parley/shared/sessions';
import { oneLine } from '@parley/shared/text';
import { bounded, type SessionDriver } from './native.js';
import { claudeProbe } from './claude.js';
import { codexProbe } from './codex.js';
import { insidePath } from './files.js';
import { grokProbe } from './grok.js';
import { openCodeProbe } from './opencode.js';
import type { ProcessOps } from './process.js';
import { probeContext, SESSION_ID, type LiveHint, type LiveState, type ProbeSession, type SessionProbe } from './probe.js';

export type { LiveHint, LiveState, ProbeSession, SessionProbe } from './probe.js';

export const DISCOVERY = {
  /** Sessions per harness when the caller does not say. */
  limit: 50,
  maxLimit: 200,
  probeMs: 6000,
  totalMs: 10_000,
  cacheMs: 5000,
  titleChars: 160,
} as const;

const NAMES: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', opencode: 'OpenCode' };
/** What a probe that failed would have read from, for its probes[] entry. */
const PRIMARY: Record<Harness, DiscoveredSession['source']> = { claude: 'sdk', codex: 'server', grok: 'files', opencode: 'server' };

export interface DiscoveryOptions {
  /** What each probe may ask of its agent beyond its files; none by default. */
  driver?: (harness: Harness) => SessionDriver;
  /** Crossroom's data directory: sessions whose folder is inside it are Crossroom's own work. */
  dataDirectory: string;
  probes?: SessionProbe[];
  home?: string;
  env?: NodeJS.ProcessEnv;
  process?: ProcessOps;
  now?: () => number;
  /** Tests shorten these; the host keeps the defaults. */
  timeouts?: { probeMs?: number; totalMs?: number; cacheMs?: number };
}

export interface ReportOptions {
  harnesses?: Harness[];
  /** Only sessions whose working folder is exactly this one. */
  directory?: string;
  limit?: number;
  liveOnly?: boolean;
}

/** One session looked up by id. */
export type FoundSession = DiscoveredSession;

interface Normalized {
  harnesses: Harness[];
  directory?: string;
  limit: number;
  liveOnly: boolean;
}

export function normalizeReportOptions(options: ReportOptions = {}): Normalized {
  const harnesses = [...new Set((options.harnesses ?? Harnesses.options).filter((h) => Harnesses.options.includes(h)))];
  const limit = Number.isSafeInteger(options.limit) && options.limit! > 0 ? Math.min(options.limit!, DISCOVERY.maxLimit) : DISCOVERY.limit;
  return {
    harnesses: harnesses.length ? harnesses : [...Harnesses.options],
    ...(options.directory ? { directory: path.resolve(options.directory) } : {}),
    limit,
    liveOnly: options.liveOnly === true,
  };
}

export const cleanTitle = (title: string | undefined) => {
  const line = oneLine(title ?? '');
  if (!line) return 'Untitled session';
  return line.length > DISCOVERY.titleChars ? line.slice(0, DISCOVERY.titleChars - 1).trimEnd() + '…' : line;
};

const clipDetail = (text: string) => {
  const line = oneLine(text);
  return line.length > 300 ? line.slice(0, 299) + '…' : line;
};

const byRecency = (a: DiscoveredSession, b: DiscoveredSession) =>
  (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1) || a.harness.localeCompare(b.harness) || a.nativeId.localeCompare(b.nativeId);

/** The `live` a report shows: where and how, never the lock or the recorded start. */
const shown = (live: LiveState | null): DiscoveredSession['live'] =>
  live ? { ...(live.pid !== undefined ? { pid: live.pid } : {}), status: live.status, surface: live.surface } : null;

export class SessionDiscovery {
  private readonly probes = new Map<Harness, SessionProbe>();
  private readonly inflight = new Map<string, Promise<DiscoveryReport>>();
  private readonly cache = new Map<string, { at: number; report: DiscoveryReport }>();
  private readonly now: () => number;
  private readonly probeMs: number;
  private readonly totalMs: number;
  private readonly cacheMs: number;
  /** Folders Crossroom's own work runs in: hosted seats' directories, under its data directory. */
  private readonly ownFolders: string[];
  constructor(private readonly options: DiscoveryOptions) {
    this.now = options.now ?? Date.now;
    this.probeMs = options.timeouts?.probeMs ?? DISCOVERY.probeMs;
    this.totalMs = options.timeouts?.totalMs ?? DISCOVERY.totalMs;
    this.cacheMs = options.timeouts?.cacheMs ?? DISCOVERY.cacheMs;
    const context = (harness: Harness) =>
      probeContext({ home: options.home, env: options.env, process: options.process, now: options.now, driver: () => options.driver?.(harness) ?? {} });
    const probes = options.probes ?? [
      claudeProbe(context('claude')),
      codexProbe(context('codex')),
      grokProbe(context('grok')),
      openCodeProbe(context('opencode')),
    ];
    for (const probe of probes) this.probes.set(probe.harness, probe);
    this.ownFolders = [path.resolve(options.dataDirectory)];
  }

  /** Never throws: a probe that fails or runs out of time is a probes[] entry with ok false. */
  report(options: ReportOptions = {}): Promise<DiscoveryReport> {
    const normalized = normalizeReportOptions(options);
    const key = JSON.stringify(normalized);
    const now = this.now();
    for (const [stale, entry] of this.cache) if (now - entry.at >= this.cacheMs) this.cache.delete(stale);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached.report);
    const running = this.inflight.get(key);
    if (running) return running;
    const work = this.run(normalized).then((report) => {
      this.cache.set(key, { at: this.now(), report });
      return report;
    });
    const settled = work.finally(() => this.inflight.delete(key));
    this.inflight.set(key, settled);
    return settled;
  }

  /** One session by its native id, classified as a report would, or undefined when no probe can find it. */
  async find(harness: Harness, id: string): Promise<FoundSession | undefined> {
    const probe = this.probes.get(harness);
    if (!probe || !SESSION_ID.test(id)) return undefined;
    const controller = new AbortController();
    try {
      const session = probe.find
        ? await bounded(probe.find(id, { signal: controller.signal }), this.probeMs, 'Session lookup timed out')
        : (
            await bounded(
              probe.list({ limit: DISCOVERY.maxLimit, signal: controller.signal }),
              this.probeMs,
              'Session lookup timed out',
            )
          ).sessions.find((entry) => entry.nativeId === id);
      if (!session || session.nativeId !== id) return undefined;
      return this.classify(harness, session, true);
    } catch {
      controller.abort();
      return undefined;
    }
  }

  /**
   * Whether a session is open elsewhere right now: files and pids only, so a watcher can poll it.
   * When the probe cannot answer, the session is reported open, with an exit Crossroom cannot see.
   */
  async live(harness: Harness, id: string, hint?: LiveHint): Promise<LiveState | null> {
    const probe = this.probes.get(harness);
    if (!probe) return null;
    if (!SESSION_ID.test(id)) return { status: 'unknown', surface: 'unknown', exit: 'none' };
    try {
      return await bounded(probe.live(id, hint), this.probeMs, 'Liveness check timed out');
    } catch {
      return { status: 'unknown', surface: 'unknown', exit: 'none' };
    }
  }

  private async run(options: Normalized): Promise<DiscoveryReport> {
    const deadline = Date.now() + this.totalMs;
    const results = await Promise.all(options.harnesses.map((harness) => this.probe(harness, options, deadline)));
    let truncated = false;
    const sessions: DiscoveredSession[] = [];
    const probes: DiscoveryReport['probes'] = [];
    for (const result of results) {
      const visible = result.sessions
        .map((session) => this.classify(result.entry.harness, session, false))
        .filter((session): session is DiscoveredSession => session !== undefined)
        .filter((session) => !options.liveOnly || session.live !== null)
        .sort(byRecency);
      if (visible.length > options.limit || result.truncated) truncated = true;
      const kept = visible.slice(0, options.limit);
      sessions.push(...kept);
      probes.push({ ...result.entry, count: kept.length });
    }
    return { checkedAt: this.now(), truncated, sessions: sessions.sort(byRecency), probes };
  }

  private async probe(harness: Harness, options: Normalized, deadline: number) {
    const started = Date.now();
    const probe = this.probes.get(harness);
    const failed = (detail: string) => ({
      entry: { harness, ok: false, source: PRIMARY[harness], elapsedMs: Date.now() - started, count: 0, detail: clipDetail(detail) },
      sessions: [] as ProbeSession[],
      truncated: false,
    });
    if (!probe) return failed('Crossroom has no way to look for ' + NAMES[harness] + ' sessions.');
    const budget = Math.max(0, Math.min(this.probeMs, deadline - Date.now()));
    const controller = new AbortController();
    try {
      const result = await bounded(
        probe.list({ limit: options.limit, directory: options.directory, liveOnly: options.liveOnly, signal: controller.signal }),
        budget,
        NAMES[harness] + ' took longer than ' + Math.round(budget / 100) / 10 + ' s to list its sessions.',
      );
      return {
        entry: {
          harness,
          ok: true,
          source: result.source,
          elapsedMs: Date.now() - started,
          count: 0,
          ...(result.detail ? { detail: clipDetail(result.detail) } : {}),
        },
        sessions: result.sessions,
        truncated: result.truncated === true,
      };
    } catch (error) {
      controller.abort();
      return failed(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Who owns a session. Undefined hides it from a report: subagent threads belong to the session
   * that spawned them. A lookup by id still answers.
   */
  private classify(harness: Harness, session: ProbeSession, lookup: boolean): DiscoveredSession | undefined {
    const base: DiscoveredSession = {
      harness,
      nativeId: session.nativeId,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      title: cleanTitle(session.title),
      ...(session.lastActiveAt !== undefined ? { lastActiveAt: session.lastActiveAt } : {}),
      live: shown(session.live),
      owner: 'external',
      source: session.source,
      ...(session.nativeVersion ? { nativeVersion: session.nativeVersion } : {}),
    };
    const parley = (reason: string): DiscoveredSession => ({ ...base, owner: 'parley', reason });
    if (session.cwd && this.ownFolders.some((folder) => insidePath(session.cwd!, folder)))
      return parley('Crossroom started it for its own work.');
    if (harness === 'codex' && session.originator === 'parley') return parley('Crossroom started it.');
    if (session.kind === 'subagent') return lookup ? { ...base, reason: 'A subagent thread, which belongs to the session that started it.' } : undefined;
    return base;
  }
}
