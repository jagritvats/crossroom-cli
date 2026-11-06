/**
 * The runner's calls to the services it posts effects to (GitHub, Slack, Linear, Jira, PagerDuty):
 * one bounded JSON request, its failure as an `EffectCode`.
 *
 * - **Where it goes is the runner's.** Every URL is a base the runner's operator configured (or
 *   the service's own fixed API), plus a fixed path whose variable parts are target fields the wire
 *   contract has already checked by pattern, each percent-encoded. Nothing an effect carries is a
 *   host or a URL.
 * - **A credential never follows a redirect** (`redirect: 'error'`), since a custom header survives
 *   one across origins.
 * - **Fetch is the caller's**, as for the relay client (runner/client.ts): the runner runs on the
 *   answering team's machine and calls services its operator named. The `crossroom` command passes the
 *   global fetch; tests pass one that reaches a fake service.
 * - **Errors carry no secret and no body.** A service's error text can echo what it was sent, so an
 *   `EffectHttpError` says only the code, the status and what was being done, and even that goes
 *   through `redactTokens` with every credential in play.
 */
import { redactTokens } from '../keys.js';
import type { EffectCode } from './wire.js';

/** The one function effects call to reach a service: the global `fetch`, or a test's stand-in. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class EffectHttpError extends Error {
  constructor(
    readonly code: EffectCode,
    /** The HTTP status, or 0 when nothing answered. */
    readonly status: number,
    message: string,
    /** Worth trying again later: the service did not answer, was busy, or said to slow down. */
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'EffectHttpError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** The most of an answer read: a page of comments or check runs is well under this. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

export interface JsonCall {
  fetch: FetchLike;
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** What is being done, for the message: `POST a PR comment`. Never a URL with a token in it. */
  what: string;
  /** Every credential this call or its caller holds, scrubbed from the message. */
  secrets?: readonly (string | null | undefined)[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface JsonAnswer {
  status: number;
  json: unknown;
  headers: Headers;
}

function codeOf(status: number, headers: Headers): { code: EffectCode; transient: boolean } {
  if (status === 401) return { code: 'auth', transient: false };
  // GitHub answers an exhausted rate limit 403 with the limit's headers, and that passes.
  if (status === 403 && headers.get('x-ratelimit-remaining') === '0') return { code: 'rate_limited', transient: true };
  if (status === 403) return { code: 'forbidden', transient: false };
  if (status === 404 || status === 410) return { code: 'not_found', transient: false };
  if (status === 413) return { code: 'rejected', transient: false };
  if (status === 429) return { code: 'rate_limited', transient: true };
  if (status >= 500) return { code: 'network', transient: true };
  return { code: 'rejected', transient: false };
}

async function readBounded(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One request, answered 2xx with JSON (or nothing), or an `EffectHttpError` with a code. A 3xx is
 * refused as `rejected`, whatever it points at.
 */
export async function callJson(c: JsonCall): Promise<JsonAnswer> {
  const fail = (code: EffectCode, status: number, why: string, transient: boolean) =>
    new EffectHttpError(code, status, redactTokens(`${c.what}: ${why}`, c.secrets ?? []), transient);
  const headers: Record<string, string> = { accept: 'application/json', ...(c.headers ?? {}) };
  if (c.body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  const timeout = AbortSignal.timeout(c.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = c.signal ? AbortSignal.any([timeout, c.signal]) : timeout;
  let res: Response;
  try {
    res = await c.fetch(c.url, {
      method: c.method,
      headers,
      ...(c.body !== undefined ? { body: typeof c.body === 'string' ? c.body : JSON.stringify(c.body) } : {}),
      redirect: 'error',
      signal,
    });
  } catch (e) {
    if (c.signal?.aborted) throw fail('network', 0, 'stopped', false);
    // The global fetch refuses a redirect (`redirect: 'error'`) as `fetch failed`, with the
    // redirect in its cause: not a network error to retry, and never one to follow.
    if (/redirect/i.test(String((e as { cause?: { message?: unknown } })?.cause?.message ?? ''))) throw fail('rejected', 0, 'answered with a redirect, which a credential never follows', false);
    throw fail('network', 0, timeout.aborted ? 'no answer in time' : 'could not reach the service', true);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw fail('rejected', res.status, 'answered with a redirect, which a credential never follows', false);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const { code, transient } = codeOf(res.status, res.headers);
    throw fail(code, res.status, `answered ${res.status}`, transient);
  }
  let text: string;
  try {
    text = await readBounded(res);
  } catch {
    throw fail('network', res.status, 'the answer broke off or was too large', true);
  }
  if (!text.trim()) return { status: res.status, json: null, headers: res.headers };
  try {
    return { status: res.status, json: JSON.parse(text), headers: res.headers };
  } catch {
    throw fail('rejected', res.status, 'answered with something that is not JSON', false);
  }
}

/** A path segment as a URL carries it: every character but the unreserved ones percent-encoded. */
export const seg = (s: string | number) => encodeURIComponent(String(s));

/**
 * A base URL as the runner keeps one: https, or http on this machine's loopback (a test's fake
 * service, a local GitHub Enterprise tunnel). No user, password, query or fragment; no trailing
 * slash. Throws with a sentence for the operator.
 */
export function serviceBase(url: string, what: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  const loopback = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/i.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error(`${what} must be https://`);
  if (u.username || u.password || u.search || u.hash) throw new Error(`${what} carries no user, password, query or fragment`);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}
