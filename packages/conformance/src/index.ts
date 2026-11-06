/**
 * The conformance suite for the open room protocol (`parley-room/1`, spec/): what
 * `crossroom conformance <url>` runs, and what the server's own tests run in process, so the
 * command and the tests agree by construction.
 *
 * `runConformance` checks one server through the HTTP binding: it comes by its rooms (rooms.ts), runs
 * each check it was asked for (checks.ts) in an order where one check's leftovers are another's
 * input, deletes every room it made, and reports in `CONFORMANCE_CHECKS` order. It makes at most
 * `CONFORMANCE_ROOMS_MAX` rooms, no more than `CONFORMANCE_CREATES_PER_MINUTE` in any minute, and
 * marks each as a test's, so the server leaves them out of every count it keeps.
 *
 * The suite depends on `@parley/shared` alone (the record's bytes, the e2ee field format, the
 * protocol's names) and WebCrypto: no server code, so a server cannot pass by sharing its bugs.
 */
import {
  CONFORMANCE_CHECKS,
  type ConformanceCheck,
  type ConformanceReport,
  type ConformanceResult,
  ROOM_PROTOCOL,
} from '@parley/shared/protocol';
import { CHECKS, Ctx, Fail, identical404AfterDelete, Skip } from './checks.js';
import { type FetchLike, randomHex, Server, sleep } from './client.js';
import { type RoomSource, Rooms } from './rooms.js';

export { type Answer, type FetchLike, Server, serverBase } from './client.js';
export { fenceProblem, forgedHeading, TERMINATORS } from './checks.js';
export { readLinks, type Room, type RoomKind, type RoomSource } from './rooms.js';
export { bundleProblem, chainProblem, verifySignature } from './verify.js';

export interface ConformanceOptions {
  /** The server to check: its root URL, as its seat links start. */
  url: string;
  /** Defaults to the global `fetch`. Every call passes `redirect: 'error'`. */
  fetch?: FetchLike;
  /** Where the rooms come from: made by the suite unless said otherwise. */
  source?: RoomSource;
  /** Some of `CONFORMANCE_CHECKS`; all of them when absent or empty. */
  only?: readonly ConformanceCheck[];
  /** Progress, a line at a time, in the suite's own words. */
  log?: (line: string) => void;
  /** For tests: the clock and the pause the rate limit uses. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A result, and whether the check could not run here at all (which is not a failure). */
export interface ConformanceOutcome extends ConformanceResult {
  skipped?: true;
}

export interface ConformanceRun extends ConformanceReport {
  results: ConformanceOutcome[];
  /** How many checks could not run here. */
  skipped: number;
  /** Rooms the suite made that the server would not let it delete, by id. */
  roomsLeft: string[];
  /** Every request the suite made, tokens left out of the paths: method, path, status and when. */
  requests: Server['log'];
}

/** The suite's words for an error a check did not expect: never the error's own text, which may be the server's. */
const unexpected = (e: unknown) =>
  e instanceof Error && e.name === 'TimeoutError'
    ? 'the server did not answer in time'
    : 'a request to the server failed, or its answer could not be read';

export async function runConformance(o: ConformanceOptions): Promise<ConformanceRun> {
  const fetchImpl = o.fetch ?? ((url, init) => fetch(url, init));
  const server = new Server(o.url, fetchImpl, o.now);
  const rooms = new Rooms(server, o.source ?? { kind: 'quick' }, o.now, o.sleep ?? sleep);
  const ctx = new Ctx(server, rooms, `cf${randomHex(5)}`);
  const wanted = new Set<ConformanceCheck>(o.only?.length ? o.only : CONFORMANCE_CHECKS);
  const outcomes = new Map<ConformanceCheck, ConformanceOutcome>();
  const log = o.log ?? (() => {});

  try {
    for (const [check, fn] of CHECKS) {
      if (!wanted.has(check)) continue;
      log(`checking ${check}`);
      try {
        outcomes.set(check, { check, ok: true, detail: await fn(ctx) });
      } catch (e) {
        if (e instanceof Skip) outcomes.set(check, { check, ok: true, skipped: true, detail: e.message });
        else if (e instanceof Fail) outcomes.set(check, { check, ok: false, detail: e.message });
        else outcomes.set(check, { check, ok: false, detail: unexpected(e) });
      }
    }
  } finally {
    if (rooms.made.length) log(`deleting the ${rooms.made.length === 1 ? 'room' : `${rooms.made.length} rooms`} the suite made`);
    await rooms.cleanup();
  }

  // A deleted room must answer as a room that never was: checked once the suite's rooms are gone.
  const first = outcomes.get('identical-404');
  if (first?.ok && !first.skipped && rooms.deleted.length) {
    try {
      const n = await identical404AfterDelete(server, rooms.deleted);
      first.detail += `; ${n} more for the rooms it deleted`;
    } catch (e) {
      outcomes.set('identical-404', { check: 'identical-404', ok: false, detail: e instanceof Fail ? e.message : unexpected(e) });
    }
  }

  const results = CONFORMANCE_CHECKS.filter((c) => outcomes.has(c)).map((c) => outcomes.get(c)!);
  return {
    url: server.base,
    protocol: ROOM_PROTOCOL,
    results,
    ok: results.every((r) => r.ok) && rooms.left.length === 0,
    roomsMade: rooms.made.length,
    skipped: results.filter((r) => r.skipped).length,
    roomsLeft: rooms.left,
    requests: server.log,
  };
}
