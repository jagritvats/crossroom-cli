import os from 'node:os';
import type { DiscoveredSession, Harness, LiveSurface } from '@parley/shared/sessions';
import type { SessionDriver } from './native.js';
import { systemProcess, type ProcessOps } from './process.js';

/** What a caller may know of a live session's process: what `live()` is asked about. */
export interface LiveHint {
  pid?: number;
  procStart?: string;
  lock?: true;
}

export interface LiveState {
  pid?: number;
  /** The process's start, epoch milliseconds as a decimal string, so a reused pid is not mistaken for it. */
  procStart?: string;
  /** A held writer lock is what shows the session open. */
  lock?: true;
  status: 'idle' | 'busy' | 'waiting' | 'unknown';
  surface: LiveSurface;
  /** How Crossroom would see it close: its pid ending, its lock being released, or not at all. */
  exit: 'pid' | 'lock' | 'none';
}

/** A native session as a probe saw it, before classification. Only allowlisted fields ever get here. */
export interface ProbeSession {
  nativeId: string;
  cwd?: string;
  title?: string;
  lastActiveAt?: number;
  live: LiveState | null;
  source: DiscoveredSession['source'];
  nativeVersion?: string;
  /** exec sessions may be Crossroom room seats; subagent threads are never offered. */
  kind?: 'interactive' | 'exec' | 'subagent';
  /** The client that created it, when the harness records one (Codex's originator). */
  originator?: string;
}

export interface ProbeListOptions {
  limit: number;
  directory?: string;
  liveOnly?: boolean;
  signal: AbortSignal;
}

export interface ProbeResult {
  sessions: ProbeSession[];
  source: DiscoveredSession['source'];
  /** More sessions exist than were returned. */
  truncated?: boolean;
  detail?: string;
}

export interface SessionProbe {
  harness: Harness;
  list(options: ProbeListOptions): Promise<ProbeResult>;
  find?(id: string, options: { signal: AbortSignal }): Promise<ProbeSession | undefined>;
  /** Cheap enough to poll every two seconds: files and pids only, never an agent CLI. */
  live(id: string, hint?: LiveHint): Promise<LiveState | null>;
}

export interface ProbeContext {
  home: string;
  env: NodeJS.ProcessEnv;
  driver: () => SessionDriver;
  process: ProcessOps;
  now: () => number;
}

export function probeContext(partial: Partial<ProbeContext> & { driver: () => SessionDriver }): ProbeContext {
  return {
    home: partial.home ?? os.homedir(),
    env: partial.env ?? (partial.home ? {} : process.env),
    process: partial.process ?? systemProcess,
    now: partial.now ?? Date.now,
    driver: partial.driver,
  };
}

/**
 * Every harness's session ids are letters, digits, dashes and underscores (UUIDs, `ses_…`). They
 * name files and SDK lookups, so an id that could carry a path or a line break is never used.
 */
export const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,199}$/;

export const SESSION_STATUS =(value: unknown): LiveState['status'] =>
  value === 'idle' || value === 'busy' || value === 'waiting' ? value : 'unknown';

/** The words for where a session is open, as a person would say it. */
export function surfaceLabel(surface: LiveSurface | undefined): string {
  switch (surface) {
    case 'terminal':
      return 'a terminal';
    case 'vscode':
      return 'VS Code';
    case 'desktop':
      return 'the desktop app';
    case 'background':
      return 'a background session';
    default:
      return 'another app';
  }
}
