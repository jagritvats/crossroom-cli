/**
 * The suite's one way to talk to the server under test.
 *
 * - Every request goes to the URL the suite was given, and to nothing else: a seat or owner link the
 *   server prints is read for its token alone, and the token goes back to that same URL. A link to
 *   another address is never followed, so a server cannot send the suite's tokens elsewhere.
 * - Every request is made with `redirect: 'error'`: fetch keeps a custom header such as
 *   `x-parley-owner` when it follows a redirect, so a redirect could carry a token to another origin.
 * - A token travels in a header or the seat link's path, as the protocol puts it, never in a query.
 */

/** `fetch`, or anything that answers like it (Hono's `app.request` in a test). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** What the server answered, read once. `json` is the body parsed, or undefined when it is not JSON. */
export interface Answer {
  status: number;
  /** The media type alone, lower-cased, without its parameters. */
  type: string;
  /** The whole `content-type`, as sent: two answers that must be identical are compared on it. */
  contentType: string;
  text: string;
  json: any;
}

const REQUEST_TIMEOUT_MS = 60_000;

/** A URL the suite will check: http or https, no credentials, query or fragment. Throws otherwise. */
export function serverBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('the server to check must be an http or https URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('the server to check must be an http or https URL');
  if (u.username || u.password) throw new Error('the server URL must not carry a user name or password');
  if (u.search || u.hash) throw new Error('the server URL must not carry a query or a fragment');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export class Server {
  readonly base: string;
  private readonly fetchImpl: FetchLike;
  /** Every request made, by method and path (tokens in a path replaced): what a test reads to count creates. */
  readonly log: Array<{ method: string; path: string; status: number; at: number }> = [];
  private readonly now: () => number;

  constructor(url: string, fetchImpl: FetchLike, now: () => number = Date.now) {
    this.base = serverBase(url);
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  /**
   * One request. `body` is sent as JSON when it is not a string. `logPath` is what the request log
   * records instead of the path, for a path that holds a token.
   */
  async call(
    method: string,
    path: string,
    o: { headers?: Record<string, string>; body?: unknown; signal?: AbortSignal; logPath?: string } = {},
  ): Promise<Answer> {
    const headers: Record<string, string> = { accept: 'application/json, text/markdown;q=0.9, */*;q=0.8', ...(o.headers ?? {}) };
    let body: string | undefined;
    if (o.body !== undefined) {
      body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'))
        headers['content-type'] = typeof o.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
    }
    // A server that never answers must not hold the suite for good. The longest call it makes is a
    // `wait` of at most 20 seconds, so a minute is a hang, not a slow answer.
    const limit = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = o.signal ? AbortSignal.any([o.signal, limit]) : limit;
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body, redirect: 'error', signal });
    const text = await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    const type = contentType.split(';')[0]!.trim().toLowerCase();
    let json: any;
    if (type === 'application/json') {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    this.log.push({ method, path: o.logPath ?? path, status: res.status, at: this.now() });
    return { status: res.status, type, contentType, text, json };
  }
}

/** Twelve random hex characters, for ids and tokens no server has issued. */
export function randomHex(bytes = 6): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** A random base64url string of `bytes` bytes: a token in the shape a server issues, which it never did. */
export function randomToken(bytes = 18): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A room id in the shape Crossroom issues (twelve characters of base64url, with `-` and `_` folded to `x`). */
export const randomRoomId = () => randomToken(9).replace(/[-_]/g, 'x').slice(0, 12);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
