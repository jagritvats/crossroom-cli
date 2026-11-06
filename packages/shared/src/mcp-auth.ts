/**
 * Your agents from the Claude app: the account's own MCP connector,
 * `/mcp/me`, and the OAuth 2.1 authorization that lets an app such as Claude act through it for
 * one account.
 *
 * Crossroom is both the authorization server and the resource server. The tokens it issues here
 * open `/mcp/me` and nothing else: they are not API tokens (`pa_…`), and no other route's
 * credential check accepts one. No zod, so the web app imports it as it is.
 */

/** The account's connector, under the app's public URL. */
export const MCP_ME_PATH = '/mcp/me';
/**
 * The one scope: see the account's agents and call one into a room of its own (`MCP_SCOPE_WORDS`). It
 * never reaches the account's projects: `/mcp/me`'s project tools answer an API key only, until a scope of
 * their own is granted on the consent page.
 */
export const MCP_SCOPE = 'agents';

/** An access token for `/mcp/me`: an hour, kept only as its hash. */
export const MCP_ACCESS_TOKEN = /^pc_[A-Za-z0-9_-]{43}$/;
/** A refresh token: rotated on every use, kept only as its hash. */
export const MCP_REFRESH_TOKEN = /^pr_[A-Za-z0-9_-]{43}$/;
/** A client registered through Dynamic Client Registration (RFC 7591). */
export const MCP_CLIENT_ID = /^mc_[A-Za-z0-9_-]{22}$/;
/** A connected app as the account page names it: one grant, one app. */
export const MCP_GRANT_ID = /^mg_[A-Za-z0-9_-]{22}$/;

export const MCP_ACCESS_MINUTES = 60;
export const MCP_REFRESH_DAYS = 30;
/** How long the consent page may sit open, and an authorization code may wait to be redeemed. */
export const MCP_CONSENT_MINUTES = 10;
export const MCP_CODE_MINUTES = 5;

/** The longest client name the consent page shows, as the app registered it. */
export const MCP_CLIENT_NAME_MAX = 80;

/** What the consent page shows, for a request the server checked and signed. */
export interface ConsentView {
  /** The signed-in account's login at its provider, so the person sees whose agents these are. */
  accountLogin: string | null;
  /** The app's name, as it registered itself (`dcr`) or as its own metadata document says (`cimd`). */
  clientName: string;
  /**
   * `dcr`: the app named itself when it registered, and nothing vouches for the name.
   * `cimd`: its id is an https address on its own host, and the name came from there.
   */
  clientKind: 'dcr' | 'cimd';
  /** For `cimd`, the host its id is on. */
  clientHost: string | null;
  /** Where Allow sends the browser back to, and the host of that address. */
  redirectUri: string;
  redirectHost: string;
  /** Whether this account already allowed this app (Allow again keeps one entry). */
  connected: boolean;
  /**
   * The sign-in providers this Crossroom requires before an app may be connected (ids such as
   * `github`), empty when any will do, and whether this account has signed in with one of them.
   */
  requiredProviders: string[];
  providerOk: boolean;
  /**
   * The agents this account can call, by name (at most `CONSENT_AGENTS_SHOWN`), and how many in
   * all, so a person signed in to another account than their terminal's sees it before allowing.
   */
  agents: string[];
  agentCount: number;
}

/** How many agent names the consent page lists before "and N more". */
export const CONSENT_AGENTS_SHOWN = 8;

/** One connected app, on the account page. */
export interface ConnectedAppView {
  id: string;
  clientName: string;
  clientKind: 'dcr' | 'cimd';
  redirectHost: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** What Allow lets the app do, in the words the consent page uses. */
export const MCP_SCOPE_WORDS: readonly string[] = [
  'See which of your agents you can call, and whether each one is online.',
  'Call one of them into a new room of yours at once, even one you set to ask you first, and take the other seat in that room.',
  'Open rooms and take part in them through seat links it is given, as the Crossroom connector does.',
];
