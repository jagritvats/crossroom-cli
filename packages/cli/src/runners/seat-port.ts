/**
 * What a hosted seat's runner needs from its room, and nothing more.
 *
 * `Hosted` (hosted.ts) drives an agent CLI through its turns. It used to hold `Core` itself,
 * which tied a runner to the process that keeps the room. A `SeatPort` is the whole of what it
 * asks the room for, so the same class can drive a seat from inside this process
 * (`InProcessSeatPort`, below) or from a machine of its own over the seat's token (a remote
 * `crossroom runner`).
 *
 * A port that answers over a network may return a promise wherever the type allows one. The port
 * here answers synchronously, and `Hosted` carries straight on when a call returns a value rather
 * than a promise, so every Core call a hosted seat makes still happens in the order, and in the
 * same turn of the event loop, that it did before ports existed.
 *
 * Whatever a port does, it applies calls in the order they are made: `Hosted` fires
 * `setState('thinking')` and then `setState('waiting')` without waiting for the first, and the
 * seat's plate must end on the second.
 *
 * The types and paths here are the client's (an agent loop takes any port); the in-process port,
 * which reads the room directly, is the server's.
 */
import path from 'node:path';
import type { HostedConfig, ParleyEvent, Participant, SessionStatus } from '@parley/shared';

export type MaybePromise<T> = T | Promise<T>;

/** Who the seat is, as its room knows it. */
export interface SeatInfo {
  participantId: string;
  sessionId: string;
  name: string;
  slot: number;
}

/**
 * Who a hosted seat is and how this machine runs it. The seat comes from the room (`open`); the
 * directory, model and extra arguments come from whoever runs it, and are never read from the
 * room by a remote runner.
 */
export interface HostedSeat extends SeatInfo {
  hosted: HostedConfig | null;
}

/** The room, as far as a runner needs it. */
export interface RoomState {
  status: SessionStatus;
  e2ee: boolean;
}

/** The seat's own row, as far as a runner needs it: whether it has finished, and when it last called Parley. */
export interface SeatState {
  finishedAt: string | null;
  lastSeenAt: string | null;
}

/** What the fallback `say` declares on the seat's behalf when it joins first. */
export interface FallbackDecl {
  provider?: string;
  model?: string;
  reachability?: 'push' | 'poll';
}

export type RunnerState = Participant['runnerState'];

export interface SeatPort {
  /**
   * Open the room for this seat and hold it open until `close`. The runner reads its room from
   * timers and process callbacks, long after the request that started it, and a CLI turn can
   * outlast any idle window the room keeper applies.
   */
  open(): Promise<SeatInfo>;
  /** Let go of whatever `open` held. Closing twice, or without opening, releases nothing more. */
  close(): Promise<void>;
  /** The MCP endpoint the seat's CLI is configured with. */
  mcpUrl(): string;
  /** What the seat would be delivered by its next `wait` (past its cursor, and visible to it). */
  unseen(): MaybePromise<ParleyEvent[]>;
  /**
   * Every event the seat would be delivered, as it happens, and the room's end (which a runner
   * acts on whoever ended it). Returns the unsubscribe. Moves no cursor.
   */
  subscribe(on: (ev: ParleyEvent) => void): () => void;
  /** The room's status, or null once it is gone. */
  room(): MaybePromise<RoomState | null>;
  /**
   * The seat's own row as it stands when asked, or null once it is gone. Never from a cache that
   * lags the room: `Hosted` compares `lastSeenAt` before and after each turn to tell whether the
   * turn reached Crossroom, and three turns read as silent put the seat in error for good.
   */
  seat(): MaybePromise<SeatState | null>;
  /** What the owner's plate says about the runner. */
  setState(state: RunnerState, note: string | null): MaybePromise<void>;
  /** The CLI's own conversation id, kept so a restarted runner resumes instead of re-joining cold. */
  resumeId(): string | null;
  setResumeId(id: string): MaybePromise<void>;
  /** Post the agent's final text as a message, for a turn that ended without using any Crossroom tool. */
  fallbackSay(text: string, decl: FallbackDecl): MaybePromise<void>;
  /** The seat's scratch directory, for a seat that names no directory of its own. */
  workDir(): string;
  /** Where the runner's log for this seat is written. */
  logPath(): string;
}

/** A hosted seat's log under a data directory. `RunnerManager.logTail` and room deletion read the same path. */
export const seatLogPath = (dataDir: string, participantId: string) => path.join(dataDir, 'logs', `${participantId}.log`);

/** A hosted seat's scratch directory under a data directory. */
export const seatWorkDir = (dataDir: string, participantId: string) => path.join(dataDir, 'work', participantId);

