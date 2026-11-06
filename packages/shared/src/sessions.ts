/**
 * The agent sessions on this computer, as `crossroom sessions` lists them and `crossroom launch
 * --resume` and `crossroom new --resume` find them (the client's `discovery/`).
 */
import { z } from 'zod';

export const Harness = z.enum(['opencode', 'codex', 'claude', 'grok']);
export type Harness = z.infer<typeof Harness>;

/** Where a live native session is open. */
export type LiveSurface = 'terminal' | 'vscode' | 'desktop' | 'background' | 'unknown';

/** A native agent session found on this computer, whether or not Crossroom started it. */
export interface DiscoveredSession {
  harness: Harness;
  nativeId: string;
  cwd?: string;
  title: string;
  lastActiveAt?: number;
  live: null | { pid?: number; status: 'idle' | 'busy' | 'waiting' | 'unknown'; surface: LiveSurface };
  /** parley: Crossroom started it for its own work (a hosted seat, a scripted run it made). */
  owner: 'parley' | 'external';
  reason?: string;
  source: 'cli' | 'sdk' | 'server' | 'files';
  nativeVersion?: string;
}

export interface DiscoveryReport {
  checkedAt: number;
  truncated: boolean;
  sessions: DiscoveredSession[];
  probes: { harness: Harness; ok: boolean; source: DiscoveredSession['source']; elapsedMs: number; count: number; detail?: string }[];
}
