/**
 * How a command that acts for the signed-in account talks to its relay (`crossroom org`, `work`,
 * `artifact`, `project`, `agents`, `call`): the token `crossroom login` kept for the relay, or the
 * account API key in `CROSSROOM_API_KEY` (for an agent or a CI job, where nobody runs the device
 * flow), sent only as the `Authorization` header to that relay, on requests that refuse to follow a
 * redirect (a redirect would carry the header to wherever it points), and never printed, logged,
 * put in a URL, or handed to another process.
 *
 * With `CROSSROOM_API_KEY` set, the instance is `--relay` when given, else `CROSSROOM_URL`, else
 * the hosted one. `CROSSROOM_URL` is an origin and nothing more: https, or plain http on this
 * machine's loopback only.
 */
import { API_TOKEN } from '@parley/shared/accounts';
import { type Args, text, Usage } from '../cli.js';
import { noteInstance } from '../client-version.js';
import { credentialFor, credentialsPath, DEFAULT_RELAY, relayOrigin } from './credentials.js';

/** The variables an agent or a CI job sets in place of `crossroom login`. */
export const API_KEY_ENV = 'CROSSROOM_API_KEY';
export const URL_ENV = 'CROSSROOM_URL';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The relay answered, and said no. `status` lets a command say more than the relay's own words. */
export class RelayRefused extends Usage {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** What the relay said when it refused: its own `error` line when it sent one, else its status. */
const saidBy = (parsed: unknown, status: number) =>
  typeof (parsed as { error?: unknown } | null)?.error === 'string' ? (parsed as { error: string }).error : `HTTP ${status}`;

/** A request to the relay with the account's token: the status, and the body as the relay sent it. */
async function send(relay: string, token: string, fetchImpl: FetchLike, method: string, path: string, body: unknown, accept: string): Promise<{ res: Response; raw: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`${relay}${path}`, {
      method,
      headers: { accept, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Usage(`Could not reach ${relay}: ${(e as Error).name === 'TimeoutError' ? 'it did not answer in 15 seconds' : 'the request failed'}.`);
  }
  return { res, raw: await res.text() };
}

function refusal(relay: string, token: string, res: Response, parsed: unknown): RelayRefused | null {
  if (res.status === 401)
    return new RelayRefused(
      token === envKey()
        ? `${relay} does not accept the key in ${API_KEY_ENV}: it was revoked, has expired, or is for another Crossroom (${URL_ENV} names the instance).`
        : `${relay} no longer knows this machine's sign-in. Run \`crossroom login --relay ${relay}\` again.`,
      401,
    );
  if (!res.ok) return new RelayRefused(`${relay} refused: ${saidBy(parsed, res.status)}`, res.status);
  return null;
}

/** A request answered as JSON, or a `Usage` saying what went wrong. */
export async function call<T>(relay: string, token: string, fetchImpl: FetchLike, method: string, path: string, body?: unknown): Promise<T> {
  const { res, raw } = await send(relay, token, fetchImpl, method, path, body, 'application/json');
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const refused = refusal(relay, token, res, parsed);
  if (refused) throw refused;
  return parsed as T;
}

/** A request whose answer is a document (an export): the text as it came, or a `Usage`. */
export async function callText(relay: string, token: string, fetchImpl: FetchLike, method: string, path: string, accept: string): Promise<string> {
  const { res, raw } = await send(relay, token, fetchImpl, method, path, undefined, accept);
  let parsed: unknown = null;
  if (!res.ok) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const refused = refusal(relay, token, res, parsed);
  if (refused) throw refused;
  return raw;
}

/** `CROSSROOM_API_KEY` as set, or undefined when it is not (an empty value is not set). */
const envKey = (env: NodeJS.ProcessEnv = process.env): string | undefined => env[API_KEY_ENV]?.trim() || undefined;

/** Any account key inside a text, blanked, so an address someone pasted a key into is never printed with it. */
const hideKeys = (s: string) => s.replace(/pa_[A-Za-z0-9_-]+/g, 'pa_…');

/**
 * `CROSSROOM_URL` as the origin it names, or a `Usage` that says what is wrong: an instance's
 * address with no path, query or fragment, over https (plain http only on this machine's loopback,
 * as `relayOrigin` decides).
 */
export function instanceFromEnv(raw: string): string {
  const typed = raw.trim();
  const shown = hideKeys(typed);
  let u: URL;
  try {
    u = new URL(typed);
  } catch {
    throw new Usage(`${URL_ENV} must be an instance's address, like ${DEFAULT_RELAY}; got "${shown}".`);
  }
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash)
    throw new Usage(`${URL_ENV} must be an instance's address with no path, like ${DEFAULT_RELAY}; got "${shown}".`);
  try {
    return relayOrigin(u.origin);
  } catch (e) {
    throw new Usage(`${URL_ENV}: ${hideKeys((e as Error).message).replace(/--relay/g, URL_ENV)}`);
  }
}

/**
 * The instance a command means: `--relay`, then `--instance` (the same flag under the name people
 * reach for; `verify` has always taken it), then `CROSSROOM_URL`, then `fallback`. One rule for
 * every command that picks an instance, so a local or self-hosted setup named once in the
 * environment never falls through to the hosted one.
 */
export function chosenInstance(args: Args, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const named = text(args.flags.relay) ?? text(args.flags.instance);
  const url = env[URL_ENV]?.trim();
  const base = named !== undefined ? relayOrigin(named) : url ? instanceFromEnv(url) : relayOrigin(fallback);
  // Checked once the command is done: does it support a client this old (client-version.ts)?
  noteInstance(base);
  return base;
}

/** Which credential an account command uses, and where it came from. Never the key itself in any message. */
export interface AccountCredential {
  relay: string;
  token: string;
  /** `env`: `CROSSROOM_API_KEY`. `login`: the token `crossroom login` kept in the credentials file. */
  via: 'env' | 'login';
}

/**
 * The credential an account command would use, or null when there is none: `CROSSROOM_API_KEY`
 * first (refused, without echoing it, when it is not shaped like a key), else this machine's login.
 */
export function accountCredential(args: Args, env: NodeJS.ProcessEnv = process.env): AccountCredential | null {
  const key = envKey(env);
  if (key !== undefined) {
    if (!API_TOKEN.test(key))
      throw new Usage(`${API_KEY_ENV} is set, but not to a Crossroom API key (a key starts with pa_; make one on your account page). Nothing was sent.`);
    return { relay: chosenInstance(args, DEFAULT_RELAY, env), token: key, via: 'env' };
  }
  const relay = chosenInstance(args, DEFAULT_RELAY, env);
  const held = credentialFor(relay);
  return held ? { relay, token: held.token, via: 'login' } : null;
}

/** The relay a command means and the account's token for it, or a line saying how to sign in. */
export function signedIn(args: Args, env: NodeJS.ProcessEnv = process.env): { relay: string; token: string } {
  const got = accountCredential(args, env);
  if (got) return { relay: got.relay, token: got.token };
  const relay = chosenInstance(args, DEFAULT_RELAY, env);
  throw new Usage(`This machine is not signed in to ${relay}. Run \`crossroom login --relay ${relay}\` first, or set ${API_KEY_ENV} to an API key from your account page.`);
}

/** Where the credential an account command uses lives, in words, for `crossroom login status`. */
export const credentialWhere = (c: AccountCredential) => (c.via === 'env' ? `the ${API_KEY_ENV} environment variable` : credentialsPath());

/** The real `fetch`, in the shape commands take so tests can pass their own. */
export const realFetch: FetchLike = (input, init) => fetch(input, init);
