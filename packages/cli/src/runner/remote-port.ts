/**
 * `HttpSeatPort`: a seat's room, reached from another machine over the seat's token,
 * for `Hosted` (runners/hosted.ts) to drive an agent CLI with, exactly as it drives one in the
 * room keeper's own process through `InProcessSeatPort`. One contract test, in the
 * server's suite, holds both to the same contract.
 *
 * Everything goes in the `x-parley-seat` header, never in a path or a query, so no access log on
 * the way keeps the token:
 * - `GET /api/seat`: who the seat is, the room's status, the seat's own row, and the events the
 *   seat may see. It moves nothing, so the port asks it whenever `Hosted` wants the room as it
 *   stands, and never answers from a cache.
 * - `GET /api/seat/events`: the live stream, opened by `open` and held until `close`; it is what
 *   the port keeps open on the relay's side. `subscribe` filters it down to what the seat's
 *   agent would be delivered (`deliverableTo`), which moves no cursor.
 * - `GET /api/seat/op/status`: how many events lie past the seat's cursor, for `unseen`.
 * - `POST /api/seat/op/say`: the fallback message, through the seat's policy first. Never `join`,
 *   which moves the seat's cursor.
 * The runner's own state goes where the runner says (`reportState`: `POST /api/runner/jobs/:id`
 * on the relay, with the runner's session), as a `RunnerNoteCode` only: the answering team's
 * errors and paths stay on its machine.
 */
import type { ParleyEvent, Participant, SessionSnapshot } from '@parley/shared';
import { E2EE_ENVELOPES_HEADER } from '@parley/shared/e2ee';
import type { RunnerNoteCode } from '@parley/shared/runner';
import { deliverable } from '../delivery.js';
import type { FallbackDecl, RoomState, RunnerState, SeatInfo, SeatPort, SeatState } from '../runners/seat-port.js';
import type { FetchLike, OutboundGate } from './proxy.js';

/**
 * Whether the seat's agent would be delivered an event by its next `wait`: the server's `visibleTo`, over
 * the event alone, from the one definition both read (delivery.ts). A copy of its own here once
 * went on delivering playbook notes and effects, which no agent is handed, and woke a
 * standing seat for each.
 */
export function deliverableTo(participantId: string, e: ParleyEvent): boolean {
  return deliverable(participantId, e);
}

/**
 * What a runner state becomes on the relay: a code whose sentence is fixed (`RUNNER_NOTES`). The
 * note itself stays here, in the job's log: it quotes the CLI, and the CLI quotes the machine.
 */
export function noteCodeFor(state: RunnerState, note: string | null): RunnerNoteCode {
  const n = note ?? '';
  switch (state) {
    case 'starting':
    case 'thinking':
    case 'waiting':
      return state;
    case 'stopped':
      return /budget/i.test(n) ? 'budget_spent' : 'stopped';
    case 'error':
      if (/not (logged|signed) in|log ?in\b|login|sign-in/i.test(n)) return 'signed_out';
      if (/rate.?limit|usage|quota|\b429\b|too many requests/i.test(n)) return 'limited';
      return 'error';
    default:
      return 'idle';
  }
}

/** A seat operation the relay refused. Its message never holds the seat's token. */
export class SeatCallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpSeatPortOptions {
  /** The relay's base URL: a seat link up to its `/j/`. */
  relay: string;
  seatToken: string;
  /** The `fetch` to use; the crossroom command passes the global one. */
  fetch: FetchLike;
  /** The MCP endpoint the CLI is configured with: its egress proxy route, never the relay itself. */
  mcpUrl: string;
  workDir: string;
  logPath: string;
  /** Where the seat's runner state goes. Absent (`crossroom join`), states stay in the log: an attached seat's plate shows no runner. */
  reportState?: (code: RunnerNoteCode) => Promise<unknown>;
  /** Where the CLI's resume id is kept, so a restarted runner resumes it. In memory only when left out. */
  resume?: { get(): string | null; set(id: string): unknown };
  /** The seat's policy: the fallback message leaves through it, as the CLI's own calls leave through the proxy. */
  gate?: OutboundGate;
  /** How long the event stream may say nothing (it pings every 15 s) before it is opened again. */
  idleMs?: number;
  /** How long `open` waits for the event stream to be live. */
  liveMs?: number;
}

interface SeatBody {
  snapshot: SessionSnapshot & { viewer: 'seat'; seat: string };
}

interface Listener {
  on: (ev: ParleyEvent) => void;
  /** Events at or below this are from before the subscription. Null until the port has asked the relay. */
  floor: number | null;
  buffer: ParleyEvent[];
}

/** The seat's gone: its link was replaced, its room deleted, or its token never opened anything. */
const GONE = new Set([401, 404, 410]);

const maxSeq = (events: readonly ParleyEvent[]) => events.reduce((m, e) => Math.max(m, e.seq), 0);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export class HttpSeatPort implements SeatPort {
  private readonly base: string;
  private info: SeatInfo | null = null;
  private listeners = new Set<Listener>();
  private floors = new Set<Promise<void>>();
  private lastSeq = 0;
  private closed = false;
  /** Aborted by `close`: ends the stream loop and every wait inside it. */
  private life = new AbortController();
  private streamAc: AbortController | null = null;
  private streaming = false;
  private gone = false;
  private chain: Promise<unknown> = Promise.resolve();
  private lastCode: RunnerNoteCode | null = null;
  private lastSend: Promise<unknown> = Promise.resolve();
  private resume: string | null;

  constructor(private o: HttpSeatPortOptions) {
    this.base = o.relay.replace(/\/+$/, '');
    this.resume = o.resume?.get() ?? null;
  }

  private hide(text: string): string {
    return text.split(this.o.seatToken).join('***');
  }

  private call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-parley-seat', this.o.seatToken);
    // The seat page and its stream, for an end-to-end room too, as stored: the route opens it.
    if (path === '/api/seat' || path.startsWith('/api/seat/events')) headers.set(E2EE_ENVELOPES_HEADER, 'envelopes');
    return this.o.fetch(`${this.base}${path}`, { ...init, headers, redirect: 'manual', cache: 'no-store' });
  }

  /** The seat's view of its room, or null when the seat is gone. */
  private async seatBody(): Promise<SeatBody | null> {
    const res = await this.call('/api/seat');
    if (GONE.has(res.status)) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const body = (await res.json().catch(() => null)) as (SeatBody & { error?: string }) | null;
    if (!res.ok || !body?.snapshot) throw new SeatCallError(res.status, this.hide(`the relay answered ${res.status} for the seat${body?.error ? `: ${body.error}` : ''}`));
    return body;
  }

  private me(body: SeatBody): Participant | undefined {
    return body.snapshot.participants.find((p) => p.id === body.snapshot.seat);
  }

  /** One seat operation: GET for `status`, POST with a JSON body for the rest. */
  private async op<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T> {
    const res = await this.call(
      `/api/seat/op/${name}`,
      args === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) },
    );
    const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null;
    if (!res.ok || !body?.ok) throw new SeatCallError(res.status, this.hide(`${name} failed (${res.status})${body?.error ? `: ${body.error}` : ''}`));
    return body.data as T;
  }

  async open(): Promise<SeatInfo> {
    if (this.closed) throw new Error('this seat port is closed');
    if (this.info) return this.info;
    const body = await this.seatBody();
    if (!body) throw new SeatCallError(404, 'This seat link does not open anything any more.');
    const me = this.me(body);
    if (!me) throw new SeatCallError(404, 'This seat link does not open anything any more.');
    this.info = { participantId: me.id, sessionId: me.sessionId, name: me.name, slot: me.slot };
    this.lastSeq = maxSeq(body.snapshot.events);
    let live!: () => void;
    const isLive = new Promise<void>((r) => (live = r));
    void this.streamLoop(live);
    // Live once the relay has sent its snapshot frame, which it does right before it listens.
    await Promise.race([isLive, sleep(this.o.liveMs ?? 10_000, this.life.signal)]);
    return this.info;
  }

  /** Whether the port holds its event stream open on the relay, or is opening it again. */
  holding(): boolean {
    return !this.closed && !this.gone && this.streaming;
  }

  /** Resolves once every subscription made so far knows where it starts. */
  async ready(): Promise<void> {
    await Promise.all([...this.floors]);
  }

  private async streamLoop(live: () => void) {
    let delay = 500;
    this.streaming = true;
    try {
      while (!this.closed) {
        const r = await this.streamOnce(live);
        if (this.closed) break;
        if (r === 'gone') {
          this.gone = true;
          live();
          break;
        }
        if (r === 'live') delay = 500;
        await sleep(delay, this.life.signal);
        delay = Math.min(delay * 2, 15_000);
      }
    } finally {
      this.streaming = false;
    }
  }

  /** One connection of the event stream, until it ends. */
  private async streamOnce(live: () => void): Promise<'gone' | 'live' | 'error'> {
    const ac = new AbortController();
    this.streamAc = ac;
    const onClose = () => ac.abort();
    this.life.signal.addEventListener('abort', onClose, { once: true });
    let wasLive = false;
    let idle: NodeJS.Timeout | null = null;
    const poke = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => ac.abort(), this.o.idleMs ?? 45_000);
    };
    try {
      poke();
      const res = await this.call(`/api/seat/events?after=${this.lastSeq}`, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
      if (GONE.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        return 'gone';
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        return 'error';
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        poke();
        buf += value;
        let cut: number;
        while ((cut = buf.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '');
          if (this.frame(frame) === 'snapshot' && !wasLive) {
            wasLive = true;
            live();
          }
        }
      }
      return wasLive ? 'live' : 'error';
    } catch {
      return wasLive ? 'live' : 'error';
    } finally {
      if (idle) clearTimeout(idle);
      this.life.signal.removeEventListener('abort', onClose);
      if (this.streamAc === ac) this.streamAc = null;
    }
  }

  /** Read one SSE frame; returns its event name. */
  private frame(frame: string): string {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (event === 'snapshot' || event === 'ping') return event;
    let ev: ParleyEvent;
    try {
      ev = JSON.parse(data.join('\n')) as ParleyEvent;
    } catch {
      return event;
    }
    if (typeof ev?.seq !== 'number') return event;
    if (ev.seq <= this.lastSeq) return event;
    this.lastSeq = ev.seq;
    const pid = this.info?.participantId;
    if (!pid || !(ev.type === 'session_ended' || deliverableTo(pid, ev))) return event;
    for (const l of this.listeners) {
      if (l.floor === null) l.buffer.push(ev);
      else if (ev.seq > l.floor) this.deliver(l, ev);
    }
    return event;
  }

  private deliver(l: Listener, ev: ParleyEvent) {
    if (!this.listeners.has(l)) return;
    try {
      l.on(ev);
    } catch {
      /* a listener's own failure is its own */
    }
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.life.abort();
      this.streamAc?.abort();
      this.listeners.clear();
    }
    return Promise.resolve();
  }

  mcpUrl(): string {
    return this.o.mcpUrl;
  }

  /**
   * What the seat's next `wait` would deliver. The relay says how many events lie past the seat's
   * cursor, and those are the last that many of the events the seat may be delivered; the two
   * reads are taken around one `status`, and retried when the room moved in between.
   */
  async unseen(): Promise<ParleyEvent[]> {
    let before = await this.seatBody();
    for (let i = 0; ; i++) {
      if (!before) return [];
      const status = await this.op<{ pending?: number }>('status');
      const after = await this.seatBody();
      if (!after) return [];
      const pid = after.snapshot.seat;
      const n = Math.max(0, Math.trunc(Number(status?.pending) || 0));
      if (maxSeq(after.snapshot.events) === maxSeq(before.snapshot.events) || i >= 2) {
        const mine = after.snapshot.events.filter((e) => deliverableTo(pid, e));
        return n ? mine.slice(-n) : [];
      }
      before = after;
    }
  }

  subscribe(on: (ev: ParleyEvent) => void): () => void {
    const l: Listener = { on, floor: null, buffer: [] };
    this.listeners.add(l);
    // Where this subscription starts: the newest event the seat may see, as the relay has it now.
    // Anything the stream brings at or below it happened before the subscription.
    const settle = (floor: number) => {
      l.floor = floor;
      const held = l.buffer.splice(0);
      for (const ev of held) if (ev.seq > floor) this.deliver(l, ev);
    };
    const p = this.seatBody().then(
      (b) => settle(b ? maxSeq(b.snapshot.events) : this.lastSeq),
      () => settle(this.lastSeq),
    );
    this.floors.add(p);
    void p.finally(() => this.floors.delete(p));
    return () => {
      this.listeners.delete(l);
    };
  }

  /** The room's status and the seat's own row, from one read; null when the seat is gone. */
  async look(): Promise<{ room: RoomState; seat: SeatState | null } | null> {
    const b = await this.seatBody();
    if (!b) return null;
    const me = this.me(b);
    return {
      room: { status: b.snapshot.session.status, e2ee: b.snapshot.session.e2ee },
      seat: me ? { finishedAt: me.finishedAt, lastSeenAt: me.lastSeenAt } : null,
    };
  }

  async room(): Promise<RoomState | null> {
    return (await this.look())?.room ?? null;
  }

  async seat(): Promise<SeatState | null> {
    return (await this.look())?.seat ?? null;
  }

  /**
   * The seat's runner state, as a code, in the order the calls were made. A call that repeats the
   * last code sends nothing: `Hosted` says "thinking" on every tool line a CLI prints.
   */
  setState(state: RunnerState, note: string | null): Promise<void> {
    const report = this.o.reportState;
    if (!report) return Promise.resolve();
    const code = noteCodeFor(state, note);
    if (code === this.lastCode) return this.lastSend.then(() => undefined);
    this.lastCode = code;
    const sent = this.chain.catch(() => {}).then(() => report(code));
    this.chain = sent;
    this.lastSend = sent;
    return sent.then(() => undefined);
  }

  resumeId(): string | null {
    return this.resume;
  }

  async setResumeId(id: string): Promise<void> {
    this.resume = id;
    await this.o.resume?.set(id);
  }

  /**
   * The agent's last words, posted as its message: through the seat's policy first, as every call
   * its CLI makes goes through the proxy's. A refusal or a hold posts nothing.
   *
   * `say` alone, which keeps the seat joined. Not `join` first, as `InProcessSeatPort` does with
   * the server's own join: the `join` operation also moves the seat's delivery cursor to the head, so every
   * event the agent had not yet been given would be marked delivered, `unseen` would come back
   * empty, and `Hosted` would never wake the agent for what the other side said. So the declared
   * provider and model are not sent from here: over the relay, only `join` carries them.
   */
  async fallbackSay(text: string, _decl: FallbackDecl): Promise<void> {
    if (this.o.gate) {
      const d = await this.o.gate.decide({ op: 'say', args: { text } });
      if (d.action !== 'forward') throw new SeatCallError(403, `the fallback message was not sent (${d.rule})`);
    }
    await this.op('say', { text });
  }

  /** Finish the seat with the runner's own fixed words (a rotated link, say). Not the agent's, so not through its policy. */
  async finish(summary: string): Promise<void> {
    await this.op('finish', { summary });
  }

  workDir(): string {
    return this.o.workDir;
  }

  logPath(): string {
    return this.o.logPath;
  }
}
