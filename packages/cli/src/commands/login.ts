/**
 * `crossroom login [--relay <url>]`: sign this machine in to a Crossroom account by
 * the relay's device flow, and keep the API token in `~/.parley/credentials.json` (0600),
 * keyed by relay (commands/credentials.ts).
 *
 * 1. `POST /api/cli/login` hands back a device code, which stays in this process, and a user code,
 *    which is printed with the page to type it on (`<relay>/account`). The page opens in the
 *    browser unless `--no-open`, and only when it is on the relay's own origin. Neither code is
 *    ever in the address: someone who could send a person a link with the code filled in could
 *    get their own terminal signed in as that person.
 * 2. `POST /api/cli/token` every `interval` seconds, slower when the relay says so, until a signed-in
 *    browser approves the code or it expires (ten minutes).
 * 3. The token is written to the credentials file and nowhere else: never printed (not with
 *    `--json` either), never in another process's arguments or environment. A token this machine
 *    held for the same relay before is revoked once the new one is safely written.
 *
 * `crossroom logout` (commands/logout.ts) revokes the token and forgets it.
 *
 * `crossroom login status [--relay <url>] [--json]` says which credential the account commands use
 * (`CROSSROOM_API_KEY` from the environment, or this machine's login), for which instance, and as
 * whom the instance knows it. It never prints the key or the token; it exits 1 when there is none
 * or the instance does not accept it.
 */
import { type AccountView, API_TOKEN, type CliLoginStart, PROVIDER_LABELS } from '@parley/shared/accounts';
import { type Args, openBrowser, Usage } from '../cli.js';
import { credentialsPath, DEFAULT_RELAY, readCredentials, writeCredentials } from './credentials.js';
import { findCommand, registerCommand } from './index.js';
import { type AccountCredential, API_KEY_ENV, accountCredential, chosenInstance, credentialWhere } from './relay-call.js';

/** What `login` reaches the world through; tests pass their own. */
export interface LoginDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Opens the approval page in a browser: the page's address only, never a code or a token. */
  open: (url: string) => void;
}

const realDeps: LoginDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  open: openBrowser,
};

/** What `crossroom login` prints with `--json`, and what the tests read. Never the token. */
export interface LoginResult {
  relay: string;
  accountId: string;
  /** Who the account is, as the relay names it: `octocat (GitHub)`; null when it would not say. */
  who: string | null;
  expiresAt: string | null;
  credentials: string;
  /** A token this machine held for the relay before, revoked now; false when there was none or the relay refused. */
  replaced: boolean;
}

/** An RFC 8628 `slow_down`: five seconds more between polls. */
const SLOW_DOWN_MS = 5_000;
/** A request that has not answered in this long is a relay that did not answer. */
const REQUEST_MS = 15_000;
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

type Answer = { status: number; body: Record<string, unknown> | null } | { status: 0; body: null };

async function call(deps: LoginDeps, url: string, init: RequestInit): Promise<Answer> {
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) });
  } catch {
    return { status: 0, body: null };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, body: body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null };
}

const postJson = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** A refusal in the relay's own words when it gave some, else its status. */
const said = (a: Answer) => (typeof a.body?.error === 'string' ? a.body.error : `HTTP ${a.status}`);

function started(relay: string, a: Answer): CliLoginStart {
  if (a.status === 0) throw new Usage(`${relay} did not answer. Check the address, or pass --relay <url>.`);
  if (a.status !== 201) throw new Usage(a.status === 404 && typeof a.body?.error === 'string' ? a.body.error : `${relay} refused to start a login: ${said(a)}`);
  const b = a.body as Partial<CliLoginStart> | null;
  if (
    !b ||
    typeof b.deviceCode !== 'string' ||
    typeof b.userCode !== 'string' ||
    !USER_CODE.test(b.userCode) ||
    typeof b.verificationUrl !== 'string' ||
    typeof b.expiresIn !== 'number' ||
    typeof b.interval !== 'number'
  )
    throw new Usage(`${relay} did not answer the way a Crossroom does.`);
  return b as CliLoginStart;
}

/** The approval page, when it is safe to open for the person: an http(s) page on the relay itself. */
function openable(relay: string, url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === relay;
  } catch {
    return false;
  }
}

/** Who an API token's account is, as the relay names it (`octocat (GitHub)`), or null. */
export async function whoIs(deps: LoginDeps, relay: string, token: string): Promise<string | null> {
  const a = await call(deps, `${relay}/api/account`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
  const v = a.body as AccountView | null;
  if (a.status !== 200 || !v || v.signedIn !== true) return null;
  const id = v.identities?.[0];
  if (!id) return null;
  return `${id.login} (${PROVIDER_LABELS[id.provider] ?? id.provider})`;
}

/** What `crossroom login status` prints with `--json`. Never the key or the token. */
export interface LoginStatus {
  relay: string;
  /** `env`: `CROSSROOM_API_KEY`. `login`: this machine's sign-in. `none`: neither. */
  via: AccountCredential['via'] | 'none';
  /** Whether the instance accepted the credential just now. */
  accepted: boolean;
  /** Who the account is, as the relay names it, when it accepted it and would say. */
  who: string | null;
  accountId: string | null;
}

/** Which credential the account commands would use, and whether the instance takes it. */
export async function loginStatus(args: Args, deps: LoginDeps = realDeps, env: NodeJS.ProcessEnv = process.env): Promise<LoginStatus> {
  const cred = accountCredential(args, env);
  if (!cred) return { relay: chosenInstance(args, DEFAULT_RELAY, env), via: 'none', accepted: false, who: null, accountId: null };
  const a = await call(deps, `${cred.relay}/api/account`, { headers: { accept: 'application/json', authorization: `Bearer ${cred.token}` }, redirect: 'error' });
  if (a.status === 0) throw new Usage(`${cred.relay} did not answer. Check the address, or pass --relay <url>.`);
  const v = a.body as AccountView | null;
  if (a.status !== 200 || !v || v.signedIn !== true) return { relay: cred.relay, via: cred.via, accepted: false, who: null, accountId: null };
  const id = v.identities?.[0];
  return { relay: cred.relay, via: cred.via, accepted: true, who: id ? `${id.login} (${PROVIDER_LABELS[id.provider] ?? id.provider})` : null, accountId: v.account.id };
}

/** What `crossroom login status` prints. */
export function statusText(s: LoginStatus): string {
  if (s.via === 'none') return `Not signed in to ${s.relay}. Run \`crossroom login --relay ${s.relay}\`, or set ${API_KEY_ENV} to an API key from your account page.`;
  const where = credentialWhere({ relay: s.relay, token: '', via: s.via });
  if (!s.accepted)
    return s.via === 'env'
      ? `${s.relay} does not accept the key in ${API_KEY_ENV}: it was revoked, has expired, or is for another Crossroom.`
      : `${s.relay} no longer knows this machine's sign-in (kept in ${where}). Run \`crossroom login --relay ${s.relay}\` again.`;
  const as = s.who ? ` as ${s.who}` : '';
  return s.via === 'env'
    ? `Using the API key in ${API_KEY_ENV} for ${s.relay}${as}. Account commands use it in place of this machine's login while it is set.`
    : `Signed in to ${s.relay}${as}, with the token \`crossroom login\` kept in ${where}.`;
}

export async function login(args: Args, say: (line: string) => void, deps: LoginDeps = realDeps): Promise<LoginResult> {
  if (args.positional.length) throw new Usage('Usage: crossroom login [--relay <url>] [--no-open] [--json]\n       crossroom login status [--relay <url>] [--json]');
  const relay = chosenInstance(args, DEFAULT_RELAY);
  // Read before anything is asked of the relay, so a file this command would refuse to rewrite
  // stops it before a login is started and approved for nothing.
  const before = readCredentials()[relay] ?? null;

  const start = started(relay, await call(deps, `${relay}/api/cli/login`, postJson({})));
  const minutes = Math.max(1, Math.round(start.expiresIn / 60));
  say(`To sign this machine in to ${relay}, open this page in a browser where you are signed in to Crossroom:`);
  say(`  ${start.verificationUrl}`);
  say('and enter this code under "Sign in a terminal":');
  say(`  ${start.userCode}`);
  say(`It works once, for ${minutes} minute${minutes === 1 ? '' : 's'}. Enter it only if you ran \`crossroom login\` yourself just now.`);
  if (!args.flags['no-open']) {
    if (openable(relay, start.verificationUrl)) deps.open(start.verificationUrl);
    else say(`(Not opened for you: ${relay} named a page on another site. Open it yourself only if you trust it.)`);
  }
  say('Waiting for the browser...');

  const deadline = deps.now() + start.expiresIn * 1000;
  let every = Math.max(1, start.interval) * 1000;
  let quiet = 0;
  let token: { token: string; accountId: string; expiresAt: string | null } | null = null;
  while (!token) {
    await deps.sleep(every);
    if (deps.now() >= deadline) throw new Usage('The code expired before a browser approved it. Run `crossroom login` again.');
    const a = await call(deps, `${relay}/api/cli/token`, postJson({ deviceCode: start.deviceCode }));
    if (a.status === 0 || a.status >= 500) {
      // A relay restarting mid-login is not the login failing: keep asking until the code expires.
      if (++quiet === 3) say(`${relay} is not answering just now; still trying until the code expires.`);
      continue;
    }
    quiet = 0;
    if (a.status === 429) {
      const asked = typeof a.body?.interval === 'number' ? a.body.interval * 1000 : 0;
      every = Math.max(every + SLOW_DOWN_MS, asked);
      continue;
    }
    if (a.status !== 200) throw new Usage(a.status === 404 ? said(a) : `${relay} refused the login: ${said(a)}`);
    if (a.body?.pending === true) continue;
    const t = a.body as { token?: unknown; accountId?: unknown; expiresAt?: unknown } | null;
    if (!t || typeof t.token !== 'string' || !API_TOKEN.test(t.token) || typeof t.accountId !== 'string')
      throw new Usage(`${relay} did not answer the way a Crossroom does.`);
    token = { token: t.token, accountId: t.accountId, expiresAt: typeof t.expiresAt === 'string' ? t.expiresAt : null };
  }

  // Written first, and only then the old token revoked: a failed write must not leave this
  // machine signed out of an account it was signed in to a moment ago.
  const creds = readCredentials();
  creds[relay] = { token: token.token, accountId: token.accountId, createdAt: new Date(deps.now()).toISOString() };
  writeCredentials(creds);
  let replaced = false;
  if (before && before.token !== token.token) {
    const r = await call(deps, `${relay}/api/auth/logout`, { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${before.token}` } });
    replaced = r.status === 200;
  }
  return { relay, accountId: token.accountId, who: await whoIs(deps, relay, token.token), expiresAt: token.expiresAt, credentials: credentialsPath(), replaced };
}

/** What `crossroom login` prints once signed in. */
export function loggedInText(r: LoginResult): string {
  const lines = [`Signed in to ${r.relay}${r.who ? ` as ${r.who}` : ''}.`];
  const until = r.expiresAt ? `, until ${r.expiresAt.slice(0, 10)}` : '';
  lines.push(`The token is in ${r.credentials}${process.platform === 'win32' ? '' : ', readable by you only'}${until}. It opens every room your account holds.`);
  if (r.replaced) lines.push('The token this machine held for it before is revoked.');
  lines.push(
    findCommand('logout')
      ? '`crossroom logout` signs this machine out; so does revoking it on your account page.'
      : 'Revoke it on your account page, under "Terminals signed in", once this machine no longer needs it.',
  );
  return lines.join('\n');
}

registerCommand({
  name: 'login',
  topic: 'workspace',
  usage: 'crossroom login [--relay <url>]',
  summary: 'sign this machine in to your Crossroom account',
  order: 170,
  forms: [{ usage: 'crossroom login status [--relay <url>]', summary: 'which credential the account commands use, and as whom', order: 170 }],
  run: async (args, say) => {
    if (args.positional[0] === 'status' && args.positional.length === 1) {
      const s = await loginStatus(args);
      console.log(args.flags.json ? JSON.stringify(s, null, 2) : statusText(s));
      return s.accepted ? 0 : 1;
    }
    const r = await login(args, say);
    console.log(args.flags.json ? JSON.stringify(r, null, 2) : loggedInText(r));
    if (process.env[API_KEY_ENV]?.trim()) say(`${API_KEY_ENV} is set, so account commands use that key in place of this sign-in while it is.`);
    return 0;
  },
});
