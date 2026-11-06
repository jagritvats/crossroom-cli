import type { LiveSurface } from '@parley/shared/sessions';

/** A native session as its harness lists it, before Crossroom classifies it. */
export interface NativeSession {
  id: string;
  cwd?: string;
  title?: string;
  updatedAt?: number;
  parentId?: string;
  version?: string;
  /** How it was started, when the harness records it: exec runs may be room seats, subagents are never offered. */
  kind?: 'interactive' | 'exec' | 'subagent';
  /** Where it was started, when the harness records it. */
  surface?: LiveSurface;
  /** The client that created it (Codex's originator). */
  originator?: string;
}

/**
 * What a probe may ask of its agent beyond the files it reads: the executable to run, and a
 * listing of its sessions where the agent offers one. Tests stand one in; `crossroom sessions`
 * passes none, so each probe reads its agent's own records.
 */
export interface SessionDriver {
  readonly executable?: string;
  /** Native sessions this harness knows about, newest first. */
  listSessions?(options: { limit: number; directory?: string; signal?: AbortSignal }): Promise<NativeSession[]>;
}

/** A probe's work must not run without end. */
export async function bounded<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
