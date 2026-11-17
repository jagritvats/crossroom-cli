/**
 * Reaching an instance: every request a command makes to a Crossroom (or to the relay an account
 * signed in to) gets a time limit, and a request that never got an answer becomes one line that
 * names the host, says why in words, and says what to do (net-errors.ts).
 */
import { Usage } from './cli.js';
import { type Reason, REQUEST_TIMEOUT_MS, unreachableLine } from './net-errors.js';

export { REQUEST_TIMEOUT_MS, unreachableLine } from './net-errors.js';

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** The request never got an answer: what the line says is in its message. */
export class Unreachable extends Usage {
  constructor(
    message: string,
    /** Why, in one word (net-errors.ts `Reason`), for code that says more than the line. */
    readonly reason: Reason,
  ) {
    super(message);
  }
}

/** A request with a time limit, the caller's own signal kept. */
export function timed(init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): RequestInit {
  const limit = AbortSignal.timeout(timeoutMs);
  return { ...init, signal: init.signal ? AbortSignal.any([init.signal, limit]) : limit };
}

/**
 * Fetch from an instance: with a time limit, and an `Unreachable` with the line above when no
 * answer came. Whatever the instance answered (a refusal included) comes back as it is.
 */
export async function reach(
  fetchImpl: FetchFn,
  url: string,
  init: RequestInit,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<Response> {
  try {
    return await fetchImpl(url, timed(init, opts.timeoutMs));
  } catch (e) {
    // The caller's own abort is the caller's to report.
    if (init.signal?.aborted) throw e;
    const { line, reason } = unreachableLine(url, e, opts);
    throw new Unreachable(line, reason);
  }
}
