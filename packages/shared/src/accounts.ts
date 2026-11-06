/**
 * Accounts: who signed in, how the server knows them again, and the rooms an account
 * holds, as the directory database keeps them and the auth and account routes carry them.
 *
 * An account never widens who reads a room. It holds an owner token its browser already had,
 * wrapped under a key derived from `PARLEY_ACCOUNT_KEY` (custody), and every read through it
 * unwraps that token and goes through `unlockAsOwner`, the owner's own path, so a room that is not
 * the account's answers exactly as one that does not exist.
 *
 * Pure: zod and nothing from Node. The web app may import from here with `import type` only,
 * so its bundle carries no zod.
 */
import { z } from 'zod';

// ---------------------------------------------------------------- providers

/** Sign-in providers. GitHub first; Google and Microsoft are OIDC (R2.md). */
export const AuthProvider = z.enum(['github', 'google', 'microsoft']);
export type AuthProvider = z.infer<typeof AuthProvider>;

/** The environment each provider needs, all of it, before it is offered (`accounts` flag `configured`). */
export const PROVIDER_ENV: Readonly<Record<AuthProvider, { id: string; secret: string }>> = {
  github: { id: 'PARLEY_GITHUB_CLIENT_ID', secret: 'PARLEY_GITHUB_CLIENT_SECRET' },
  google: { id: 'PARLEY_GOOGLE_CLIENT_ID', secret: 'PARLEY_GOOGLE_CLIENT_SECRET' },
  microsoft: { id: 'PARLEY_MICROSOFT_CLIENT_ID', secret: 'PARLEY_MICROSOFT_CLIENT_SECRET' },
};
/** The instance secret custody keys are derived from; `PARLEY_ACCOUNT_KEY_PREVIOUS` allows rotation. */
export const ACCOUNT_KEY_ENV = 'PARLEY_ACCOUNT_KEY';
export const ACCOUNT_KEY_PREVIOUS_ENV = 'PARLEY_ACCOUNT_KEY_PREVIOUS';

export const PROVIDER_LABELS: Readonly<Record<AuthProvider, string>> = { github: 'GitHub', google: 'Google', microsoft: 'Microsoft' };

/** `GET /api/auth/providers`: the configured ones only, so the page offers nothing that would fail. */
export interface ProvidersResult {
  providers: Array<{ id: AuthProvider; label: string }>;
}

/**
 * `GET /api/auth/:p/start?return=<path>`: only a same-origin path is accepted as `return`, so the
 * sign-in cannot be turned into an open redirect.
 */
export const SAME_ORIGIN_PATH = /^\/(?![/\\])[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(?:\?[^#\s]*)?$/;
export const isSameOriginPath = (p: unknown): p is string => typeof p === 'string' && p.length <= 512 && SAME_ORIGIN_PATH.test(p);
export const AuthStartQuery = z.object({ return: z.string().refine(isSameOriginPath, 'return must be a path on this site').optional() }).strict();
export type AuthStartQuery = z.infer<typeof AuthStartQuery>;

/** Where every failed sign-in lands, whatever failed: one page, and the IdP's words never echoed. */
export const SIGNIN_FAILED_PATH = '/?signin=failed';
/**
 * Where a sign-in to an account the instance's operator suspended lands instead: the person proved
 * who they are to the provider, so telling them it is their account that is held hides nothing.
 */
export const SIGNIN_SUSPENDED_PATH = '/?signin=suspended';
/**
 * The refusal for a suspended account where one is said in words: a terminal's `crossroom login`
 * redeemed after the suspension (403). Every other credential of the account (a web session, an API
 * token, a linked computer) is simply not one while it is suspended: the account routes' one 401.
 */
export const ACCOUNT_SUSPENDED = 'This account is suspended on this Crossroom. Ask whoever runs it.';

// ---------------------------------------------------------------- credentials

/**
 * The web session cookie: `HttpOnly; Secure; SameSite=Lax; Path=/`, sliding 30 days.
 *
 * `__Host-`, never `__Secure-`: a browser accepts a `__Host-` cookie only from this host itself,
 * with no `Domain` and `Path=/`. A `__Secure-` one can be set by any sibling on the registrable
 * domain (`Domain=example.com`) on a longer path, which the browser then sends first, and a planted
 * session would win on that path (cookie tossing). A narrower path isolates nothing.
 */
export const SESSION_COOKIE = '__Host-parley_session';
export const SESSION_DAYS = 30;
/** The OAuth binding cookie, set at start and cleared on the callback whatever happens. Ten minutes; `__Host-` for the same reason. */
export const BINDING_COOKIE = '__Host-parley_oauth';
export const FLOW_MINUTES = 10;
/** An API token for the CLI (`crossroom login`), sent as `Authorization: Bearer pa_…`. Stored as its hash. */
export const API_TOKEN_PREFIX = 'pa_';
export const API_TOKEN = /^pa_[A-Za-z0-9_-]{43}$/;
/** The one 401 body for an account route without a live session or token. */
export const SIGN_IN_FIRST = 'sign in first';

/** Custody: `owner_wrapped = 'c1.' + AES-256-GCM(K, ownerToken)`, K from HKDF over `PARLEY_ACCOUNT_KEY`. */
export const CUSTODY_PREFIX = 'c1.';
export const CUSTODY_INFO = 'parley/custody/v1';
/** The AAD a wrapped owner token is bound to. */
export const custodyAad = (accountId: string, sessionId: string) => `${CUSTODY_INFO}|${accountId}|${sessionId}`;
/**
 * A short-lived secret sealed under a key derived from `PARLEY_ACCOUNT_KEY`, never a room's: the
 * PKCE verifier of a sign-in in progress (`oauth_flows.verifier_sealed`).
 */
export const INSTANCE_SEALED_PREFIX = 'k1.';
/** How long a room an account holds is kept once it ends, unless the owner deletes it (`sessions.retention_days`). */
export const ACCOUNT_RETENTION_DAYS = 30;

// ---------------------------------------------------------------- the principal

/**
 * Who an account route's caller is: a signed-in browser (the cookie) or the CLI (an API token).
 * Registered as one of the server's principal kinds, after the owner token, never before it.
 */
export interface AccountPrincipal {
  kind: 'account';
  accountId: string;
  via: 'cookie' | 'token';
}

export const Plan = z.enum(['free']);
export type Plan = z.infer<typeof Plan>;

export interface Account {
  id: string;
  createdAt: string;
  plan: Plan;
}

/** An identity as the account page shows it. The provider's subject stays on the server. */
export interface Identity {
  provider: AuthProvider;
  login: string;
  lastLoginAt: string | null;
}

/** `GET /api/account`: always 200, so a page can ask without knowing whether anyone signed in. */
export type AccountView =
  | { signedIn: false; configured: boolean }
  | { signedIn: true; configured: true; account: Account; identities: Identity[]; rooms: number };

// ---------------------------------------------------------------- the rooms an account holds

/** How a room came to an account. `account_rooms.via`. */
export const RoomVia = z.enum(['browser', 'created', 'cli']);
export type RoomVia = z.infer<typeof RoomVia>;

/** `POST /api/account/rooms`: rooms this browser holds, each checked through `unlockAsOwner` before it is wrapped. */
export const AccountRoomsInput = z
  .object({ rooms: z.array(z.object({ id: z.string().min(1).max(64), owner: z.string().min(1).max(128) }).strict()).max(50) })
  .strict();
export type AccountRoomsInput = z.infer<typeof AccountRoomsInput>;

/** A room as the account lists it: its id and how it came, never its owner token. */
export interface AccountRoom {
  id: string;
  addedAt: string;
  via: RoomVia;
}
export interface AccountRoomsResult {
  /** The ids that were added. A room whose token did not open it is simply absent, as with the lookup. */
  added: string[];
  rooms: AccountRoom[];
}

// ---------------------------------------------------------------- `crossroom login` (a device flow)

/** `POST /api/cli/login`: no credential; the answer is shown in the terminal. */
export interface CliLoginStart {
  deviceCode: string;
  /** Short, typed or confirmed by the signed-in person in the browser. */
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}
/**
 * `POST /api/cli/approve`, from a signed-in browser (cookie, same origin), in two steps. Without
 * `confirm: true` it binds nothing: it answers whether the terminal asked from the browser's
 * network and how long ago, so the page can warn before the person commits. Only a second call
 * with `confirm: true` signs the terminal in to the account. A code someone else sent is the
 * phishing every device flow has, and the warning is worth nothing once the token is minted.
 */
export const CliApproveInput = z
  .object({ userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/), confirm: z.boolean().optional() })
  .strict();
export type CliApproveInput = z.infer<typeof CliApproveInput>;
export type CliApproveResult =
  | { ok: true; approved: false; sameNetwork: boolean; ageSeconds: number }
  | { ok: true; approved: true; sameNetwork: boolean };
/** `POST /api/cli/token`, polled by the CLI. */
export const CliTokenInput = z.object({ deviceCode: z.string().min(16).max(128) }).strict();
export type CliTokenInput = z.infer<typeof CliTokenInput>;
export type CliTokenResult = { pending: true } | { token: string; accountId: string; expiresAt: string | null };

/**
 * An API token as `GET /api/account/tokens` lists it: never the token, never its hash. Each is
 * revoked on its own (`DELETE /api/account/tokens/:id`), and `POST /api/auth/logout` with a bearer
 * token revokes that token (`crossroom logout`).
 */
export interface ApiTokenView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** Whether this is the token the listing was asked with. */
  current: boolean;
}

/** An API key's name, as the person typed it: what will use it. One line once stored. */
export const API_KEY_LABEL_MAX = 60;
/** Live API keys an account may hold at once, its terminals' logins included. */
export const API_KEYS_MAX = 20;
export const API_KEYS_FULL = `This account already has ${API_KEYS_MAX} live API keys. Revoke one you no longer use, then make a new one.`;
/** A key never makes another key: only a signed-in browser may. */
export const API_KEY_BROWSER_ONLY = 'Make an API key from your account page in a signed-in browser.';

/** `POST /api/account/tokens`: what the key is for. */
export const CreateApiTokenInput = z.object({ label: z.string().min(1).max(API_KEY_LABEL_MAX) }).strict();
export type CreateApiTokenInput = z.infer<typeof CreateApiTokenInput>;
/** Its answer (201): the key itself, shown this once. Only its hash is stored. */
export interface ApiTokenCreated {
  id: string;
  token: string;
  label: string;
  expiresAt: string;
}

/** `~/.parley/credentials.json` (0600): one API token per relay, keyed by its public URL. */
export type CredentialsFile = Record<string, { token: string; accountId: string; createdAt: string }>;
