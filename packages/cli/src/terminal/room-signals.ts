/**
 * A room's state as a terminal shows it, read from the owner's event stream (`crossroom watch`):
 * whose turn it is, which seats wait on their own user, which finished, and whether the room ended.
 * `RoomSignals` is pure (events in, sequences out); `Signaller` writes them to a terminal.
 *
 * - **Live, not history.** The owner's stream replays the room's events, then sends a `snapshot`
 *   frame, then the live ones. Nothing is announced before `live()` is called (the snapshot frame),
 *   so watching an old room raises no notice for a question answered last week; its state still
 *   shows, once, when it goes live.
 * - **Each record once.** An OSC 7501 report replaces the record of its id, so a report is written
 *   only when a record changes; the title likewise.
 * - **What is said** is fixed sentences, a seat letter and the room's short id (sequences.ts).
 *
 * The seat's attention follows the web app's rule: a seat waits on its user
 * while its latest event (runner state aside) is a `participant_attention` with a kind.
 */
import type { ParleyEvent } from '@parley/shared';
import { slotLetter } from '@parley/shared/text';
import {
  noticeSeq,
  popTitle,
  type ProgramStatus,
  passthrough,
  progressSeq,
  pushTitle,
  showsProgress,
  statusSeq,
  type Terminal,
  titleSeq,
} from './sequences.js';

type Attention = 'approval' | 'question' | 'away' | 'side-room';

interface SeatState {
  slot: number;
  joined: boolean;
  done: boolean;
  attention: Attention | null;
}

export interface Notice {
  id: string;
  title: string;
  body: string;
}

/** What changed after one event, for a terminal to show. */
export interface Signals {
  statuses: ProgramStatus[];
  notices: Notice[];
  /** The title, when it changed. */
  title?: string;
  /** Whether someone is waiting on a person, when that changed (progress shows it as paused). */
  waiting?: boolean;
}

const ATTENTION = new Set<string>(['approval', 'question', 'away', 'side-room']);

export class RoomSignals {
  private readonly seats = new Map<string, SeatState>();
  private readonly questions = new Map<string, string>();
  private ended = false;
  private isLive = false;
  private readonly shown = new Map<string, string>();
  private shownTitle = '';
  private shownWaiting = false;
  readonly short: string;

  constructor(roomId: string) {
    this.short = roomId.slice(0, 8);
  }

  /**
   * The seats by participant id, and the owner's open questions, from the owner's snapshot (its
   * `participants` and `contextRequests`): a watch that starts `--after` an event never reads the request
   * that opened a question still waiting.
   */
  seatsFrom(snapshot: unknown): void {
    const snap = snapshot as {
      participants?: Array<{ id?: unknown; slot?: unknown; joinedAt?: unknown; finishedAt?: unknown; leftAt?: unknown }>;
      contextRequests?: Array<{ id?: unknown; from?: unknown; to?: unknown; status?: unknown }>;
      session?: { status?: unknown };
    } | null;
    for (const p of snap?.participants ?? []) {
      if (typeof p.id !== 'string' || typeof p.slot !== 'number') continue;
      const s = this.seats.get(p.id) ?? { slot: p.slot, joined: false, done: false, attention: null };
      s.slot = p.slot;
      if (p.joinedAt) s.joined = true;
      if (p.finishedAt || p.leftAt) s.done = true;
      this.seats.set(p.id, s);
    }
    for (const r of snap?.contextRequests ?? []) {
      if (typeof r.id !== 'string' || r.to !== 'human') continue;
      if (r.status === 'open') this.questions.set(r.id, typeof r.from === 'string' ? this.letter(r.from) : '?');
      else this.questions.delete(r.id);
    }
    if (snap?.session?.status === 'ended') this.ended = true;
  }

  private seat(id: string): SeatState | undefined {
    return this.seats.get(id);
  }

  private letter(id: string): string {
    const s = this.seat(id);
    return s ? slotLetter(s.slot) : '?';
  }

  /** Read one event. Answers what to show, which is nothing until `live()`. */
  read(ev: ParleyEvent): Signals {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const notices: Notice[] = [];
    const at = this.seat(ev.actor);
    if (at && ev.type !== 'participant_state' && ev.type !== 'participant_attention') at.attention = null;
    switch (ev.type) {
      case 'participant_joined':
        if (at) at.joined = true;
        break;
      case 'participant_finished':
      case 'participant_left':
        if (at) {
          at.done = true;
          at.attention = null;
        }
        break;
      case 'participant_attention': {
        if (!at) break;
        const kind = typeof p.kind === 'string' && ATTENTION.has(p.kind) ? (p.kind as Attention) : null;
        const was = at.attention;
        at.attention = kind;
        if (kind && kind !== was && (kind === 'approval' || kind === 'question'))
          notices.push({
            id: `crossroom-${this.short}-${this.letter(ev.actor)}`,
            title: 'Crossroom',
            body:
              kind === 'approval'
                ? `Seat ${this.letter(ev.actor)} is waiting for its user to approve a step (room ${this.short}).`
                : `Seat ${this.letter(ev.actor)} is asking its user something (room ${this.short}).`,
          });
        break;
      }
      case 'context_requested': {
        const id = typeof p.requestId === 'string' ? p.requestId : null;
        if (!id) break;
        if (p.declined === true) this.questions.delete(id);
        else if (p.to === 'human') {
          this.questions.set(id, this.letter(ev.actor));
          notices.push({
            id: `crossroom-${this.short}`,
            title: 'Crossroom: your turn',
            body: `Seat ${this.letter(ev.actor)} asked you a question in room ${this.short}. Answer it on the room's page: crossroom open ${this.short}`,
          });
        }
        break;
      }
      case 'context_shared':
        if (typeof p.inReplyTo === 'string') this.questions.delete(p.inReplyTo);
        break;
      case 'session_ended':
        this.ended = true;
        for (const s of this.seats.values()) s.attention = null;
        this.questions.clear();
        notices.push({ id: `crossroom-${this.short}`, title: 'Crossroom', body: `Room ${this.short} ended. Its recap: crossroom minutes ${this.short}` });
        break;
    }
    if (!this.isLive) return { statuses: [], notices: [] };
    return { ...this.changes(), notices };
  }

  /** The stream reached the live end (its snapshot frame): show the state as it stands, once. */
  live(): Signals {
    this.isLive = true;
    return { ...this.changes(), notices: [] };
  }

  /** The records and title as they stand now. */
  records(): { statuses: ProgramStatus[]; title: string; waiting: boolean } {
    const statuses: ProgramStatus[] = [];
    const waitingOnSeat = [...this.seats.values()].filter((s) => !s.done && (s.attention === 'approval' || s.attention === 'question'));
    let room: ProgramStatus;
    if (this.ended) room = { id: this.short, state: 'done', title: 'Crossroom', msg: `Room ended. Recap: crossroom minutes ${this.short}` };
    else if (this.questions.size) room = { id: this.short, state: 'blocked', kind: 'question', title: 'Crossroom', msg: `Your turn: a seat asked you a question.` };
    else if (waitingOnSeat.some((s) => s.attention === 'approval')) room = { id: this.short, state: 'blocked', kind: 'permission', title: 'Crossroom', msg: 'A seat waits for its user to approve a step.' };
    else if (waitingOnSeat.length) room = { id: this.short, state: 'blocked', kind: 'question', title: 'Crossroom', msg: 'A seat is asking its user something.' };
    else room = { id: this.short, state: 'working', title: 'Crossroom' };
    statuses.push(room);
    for (const s of [...this.seats.values()].sort((a, b) => a.slot - b.slot)) {
      if (!s.joined) continue;
      const id = `${this.short}/${slotLetter(s.slot)}`;
      const title = `Seat ${slotLetter(s.slot)}`;
      if (s.done || this.ended) statuses.push({ id, state: 'done', title });
      else if (s.attention === 'approval') statuses.push({ id, state: 'blocked', kind: 'permission', title });
      else if (s.attention === 'question') statuses.push({ id, state: 'blocked', kind: 'question', title });
      else if (s.attention === 'away') statuses.push({ id, state: 'idle', title });
      else statuses.push({ id, state: 'working', title });
    }
    const title = this.ended
      ? `Crossroom ${this.short}: ended`
      : this.questions.size
        ? `(Your turn) Crossroom ${this.short}`
        : waitingOnSeat.some((s) => s.attention === 'approval')
          ? `(Waiting on approval) Crossroom ${this.short}`
          : waitingOnSeat.length
            ? `(Asking its user) Crossroom ${this.short}`
            : `Crossroom ${this.short}: live`;
    return { statuses, title, waiting: !this.ended && (this.questions.size > 0 || waitingOnSeat.length > 0) };
  }

  private changes(): Omit<Signals, 'notices'> {
    const now = this.records();
    const statuses = now.statuses.filter((s) => {
      const key = JSON.stringify(s);
      if (this.shown.get(s.id) === key) return false;
      this.shown.set(s.id, key);
      return true;
    });
    const out: Omit<Signals, 'notices'> = { statuses };
    if (now.title !== this.shownTitle) out.title = this.shownTitle = now.title;
    if (now.waiting !== this.shownWaiting) out.waiting = this.shownWaiting = now.waiting;
    return out;
  }

  /** The ids of every record shown, for clearing them when the watch stops before the room ends. */
  shownIds(): string[] {
    return [...this.shown.keys()];
  }

  get roomEnded(): boolean {
    return this.ended;
  }
}

export interface SignallerOptions {
  terminal: Terminal;
  /** The terminal answered the OSC 7501 probe. */
  statusProtocol: boolean;
  write: (s: string) => void;
}

/** Writes a room's signals to a terminal, and puts its title back when done. */
export class Signaller {
  private started = false;
  constructor(
    readonly room: RoomSignals,
    private readonly o: SignallerOptions,
  ) {}

  show(sig: Signals): void {
    const { terminal: t, write } = this.o;
    let out = '';
    if (!this.started && (sig.title !== undefined || sig.statuses.length)) {
      this.started = true;
      out += pushTitle;
    }
    if (this.o.statusProtocol) for (const s of sig.statuses) out += passthrough(statusSeq(s), t);
    if (sig.title !== undefined) out += titleSeq(sig.title);
    if (sig.waiting !== undefined && showsProgress(t)) out += passthrough(progressSeq(sig.waiting ? 4 : 0), t);
    for (const n of sig.notices) out += noticeSeq(t, n);
    if (out) write(out);
  }

  /**
   * The watch is over. A room that ended keeps its `done` records (the protocol keeps them past the
   * program's exit); one still live is cleared, so no pane says "working" for a watch that stopped.
   */
  stop(): void {
    if (!this.started) return;
    const { terminal: t, write } = this.o;
    let out = '';
    if (this.o.statusProtocol && !this.room.roomEnded) for (const id of this.room.shownIds()) out += passthrough(statusSeq({ id, state: 'clear' }), t);
    if (showsProgress(t)) out += passthrough(progressSeq(0), t);
    out += popTitle;
    write(out);
    this.started = false;
  }
}
