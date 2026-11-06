/**
 * The team's controls, on the runner's side: what a lease or heartbeat answer's
 * `control` asks of this runner beyond `paused`, as the relay's `FleetControl` sends it.
 *
 * - `rotate`: standing seat ids whose team asked for a new ask link from its page. The runner mints
 *   it, as `crossroom runner rotate <label>` does (runner/connect.ts `rotate`): a new token, the new
 *   epoch declared, which kills the old one's seat tokens in every room. Then it uploads the new
 *   link (`POST /api/runner/links`) for the team's maintainers, sealed there under the
 *   organisation key. The relay never makes an ask token. A rotation the relay refused, or this
 *   runner could not make, is not tried again for `ROTATE_RETRY_MS`, however often it is listed; one
 *   the relay did not answer is tried at its next answer.
 * - `stopBefore`: the team's last stop-all, as a stamp, which the relay sends only when it came
 *   after this runner last registered (the relay's `Fleet.control`). A stamp other than the last
 *   one read, the first one included, stops every agent this runner runs at that moment, its
 *   process tree killed (`Hosted.stop`, `killTree`). The relay has already withdrawn the jobs and
 *   killed their seat tokens; this is what ends the CLIs themselves. The stamp is the relay's
 *   clock and is never compared with this machine's: whether it is new is the relay's comparison,
 *   on its own clock, and whether it changed is this one's. A process registers as it starts, so a
 *   stop-all from before it never reaches it, and one made in the seconds after it started, while
 *   its first lease was parked, stops what it resumed.
 *
 * `withFleetControl` puts it on the host's relay (`HostRelay`): every lease and heartbeat answer
 * is read for them. What it calls is the connection's and the host's (`FleetActions`), wired in
 * runner/connect.ts and runner/host.ts.
 *
 * Nothing here ever holds a token: `control` carries ids and a time, and the link upload's token
 * is read from the runner's store by the caller.
 */
import { RelayError } from './client.js';
import type { HostRelay } from './host.js';

/** What the runner does for its team's controls. */
export interface FleetActions {
  /** Rotate the seat whose relay id this is: mint, declare, upload the link. Its label is the connection's to find. */
  rotate(seatId: string): Promise<void>;
  /**
   * Stop every agent running now, starting ones included; answers how many. Called in the same
   * tick as the answer that carried the new stop-all is read, so a job that answer hands out, which
   * the relay leased after the stop, is not running yet and is left to start.
   */
  stop(): Promise<number>;
  log?(line: string): void;
  /** This machine's clock, for how long a refused rotation waits (tests). */
  now?(): number;
}

/**
 * How long a rotation that failed for good waits before this runner tries it again. The relay lists
 * a seat to rotate on every lease and heartbeat answer until it is rotated, so without it a
 * rotation the relay refuses (its seat-change limit, 429) or this runner cannot make (a seat it no
 * longer configures) would be tried again every few seconds, all day.
 */
export const ROTATE_RETRY_MS = 15 * 60_000;

/** Whether a rotation's failure is one a retry at the next answer cannot mend: anything but the relay not answering. */
const failedForGood = (e: unknown) => !(e instanceof RelayError) || (e.status >= 400 && e.status < 500);

/**
 * A control's fleet fields, read loosely: a relay without them (or an older one) asks for nothing.
 * `stopBefore` is null when the answer says there has been no stop-all since the runner registered,
 * leaves the field out, or carries something that is not a time.
 */
export function fleetControlOf(control: unknown): { rotate: string[]; stopBefore: string | null } {
  const c = (control && typeof control === 'object' ? control : {}) as { rotate?: unknown; stopBefore?: unknown };
  const rotate = Array.isArray(c.rotate) ? c.rotate.filter((s): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s)).slice(0, 100) : [];
  const stamp = typeof c.stopBefore === 'string' && c.stopBefore.length <= 64 && Number.isFinite(Date.parse(c.stopBefore)) ? c.stopBefore : null;
  return { rotate: [...new Set(rotate)], stopBefore: stamp };
}

export class FleetControl {
  /** The last stop-all stamp acted on, so a stamp repeated on every answer stops things once. */
  private stamp: string | null = null;
  /** Rotations in flight: an answer that still lists one while it runs starts no second. */
  private rotating = new Set<string>();
  /** Rotations that failed for good, by seat, and when each may be tried again (`ROTATE_RETRY_MS`). */
  private refused = new Map<string, number>();
  private work = new Set<Promise<unknown>>();

  constructor(private readonly o: FleetActions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Read one answer's control and act on what is new in it. Never throws; what it starts runs on its own. */
  apply(control: unknown): void {
    const c = fleetControlOf(control);
    // A null stamp (none since the runner registered, or its session renewed since) stops nothing
    // and forgets nothing: the stop-all acted on stays acted on.
    if (c.stopBefore !== null && c.stopBefore !== this.stamp) {
      this.stamp = c.stopBefore;
      let stopping: Promise<number>;
      try {
        stopping = this.o.stop();
      } catch (e) {
        stopping = Promise.reject(e);
      }
      this.track(
        stopping.then(
          (n) => this.o.log?.(`the team stopped every seat: ${n} agent${n === 1 ? '' : 's'} stopped`),
          (e) => this.o.log?.(`stopping the team's agents failed: ${(e as Error)?.message ?? e}`),
        ),
      );
    }
    for (const seatId of c.rotate) {
      if (this.rotating.has(seatId)) continue;
      const retryAt = this.refused.get(seatId);
      if (retryAt !== undefined && this.now() < retryAt) continue;
      this.rotating.add(seatId);
      let rotating: Promise<void>;
      try {
        rotating = this.o.rotate(seatId);
      } catch (e) {
        rotating = Promise.reject(e);
      }
      this.track(
        rotating
          .then(
            () => {
              this.refused.delete(seatId);
              this.o.log?.(`rotated a seat's ask link, as its team asked`);
            },
            (e) => {
              // The relay not answering is tried again at its next answer; anything else waits.
              if (failedForGood(e)) this.refused.set(seatId, this.now() + ROTATE_RETRY_MS);
              this.o.log?.(`rotating a seat's ask link failed: ${(e as Error)?.message ?? e}`);
            },
          )
          .finally(() => this.rotating.delete(seatId)),
      );
    }
  }

  private track(p: Promise<unknown>) {
    this.work.add(p);
    void p.finally(() => this.work.delete(p));
  }

  /** Resolves once everything `apply` started has finished (tests, and a runner draining). */
  async settled(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }
}

/** The host's relay with every lease and heartbeat answer read for the team's controls. */
export function withFleetControl(relay: HostRelay, fleet: FleetControl): HostRelay {
  return {
    async lease(input, signal) {
      const r = await relay.lease(input, signal);
      fleet.apply(r.control);
      return r;
    },
    updateJob: (jobId, input, seatToken) => relay.updateJob(jobId, input, seatToken),
    async heartbeat(input) {
      const r = await relay.heartbeat(input);
      fleet.apply(r.control);
      return r;
    },
  };
}
