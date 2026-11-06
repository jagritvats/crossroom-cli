/**
 * The Microsoft Teams app: a personal tab that shows the
 * workspace, and link previews that never carry a room.
 *
 * - **Frames.** With the `teamsApp` flag on, Teams' hosts may frame the pages a person works from
 *   (`teamsFrameable`): the workspace home `/w`, a project's pages `/p/<project>[/...]`, the inbox
 *   and the tab's own page. Never a room page, a seat page, a share link, `/j/*` or `/api/*`: a
 *   room opens in the browser, where its key is.
 * - **The tab's sign-in.** The tab page asks Teams to open `TEAMS_AUTH_PATH` in its sign-in window,
 *   which signs in through the instance's own providers and hands the tab a one-time code bound to
 *   a challenge only the tab knows (`POST /api/msteams/handoff`, then `POST /api/msteams/session`).
 * - **Previews.** `POST /api/msteams/messages` answers Teams' `composeExtension/queryLink` with a
 *   constant card, after dropping the URL's fragment, where `#k=`, `#t=` and `#e=` keep keys.
 *
 * Pure, with no zod and nothing from Node, so the web app may import it as a value.
 */

/**
 * Who may frame those pages: Microsoft's list for tabs (learn.microsoft.com, "Requirements for
 * building tabs", read 2026-11-04): Teams, the Microsoft 365 app, and `*.cloud.microsoft`, where
 * every Microsoft 365 web host is moving.
 */
export const TEAMS_FRAME_ANCESTORS = [
  'https://teams.microsoft.com',
  'https://*.teams.microsoft.com',
  'https://*.cloud.microsoft',
  'https://*.microsoft365.com',
  'https://*.office.com',
] as const;

/** The tab's page, the manifest's `contentUrl`. */
export const TEAMS_TAB_PATH = '/teams/tab';
/** The page Teams opens in its sign-in window (`authentication.authenticate`). Never framed. */
export const TEAMS_AUTH_PATH = '/teams/auth';
/** Where the tab goes once the person is signed in. */
export const TEAMS_HOME_PATH = '/w';

/** The routes of the tab's sign-in. */
export const TEAMS_HANDOFF_PATH = '/api/msteams/handoff';
export const TEAMS_SESSION_PATH = '/api/msteams/session';
/** Microsoft's messaging endpoint: the bot registration names `<instance>/api/msteams/messages`. */
export const TEAMS_MESSAGES_PATH = '/api/msteams/messages';

/** A challenge and a verifier: base64url, 43 characters (sha256's), as PKCE's. */
export const TEAMS_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export const TEAMS_VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;

/** A segment of a page that may be framed: an id or a word, never a dot segment or an escape. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Whether Teams may frame this page (a pathname, with no query or fragment). Read by segments, as
 * the web's router reads a path, and only segments that are plain words or ids: anything else is a
 * page Teams may not frame.
 */
export function teamsFrameable(pathname: string): boolean {
  if (!pathname.startsWith('/')) return false;
  const parts = pathname.split('/').filter((s) => s !== '');
  if (parts.length === 0 || !parts.every((s) => SEGMENT.test(s))) return false;
  const [head] = parts;
  if (head === 'w' || head === 'inbox') return parts.length === 1;
  if (head === 'teams') return parts.length === 2 && parts[1] === 'tab';
  // A project and its tabs: `/p/<project>`, `/p/<project>/<tab>`, `/p/<project>/playbooks/<playbook>`.
  if (head === 'p') return parts.length >= 2 && parts.length <= 4;
  return false;
}

/** The CSP `frame-ancestors` directive a page is sent with: Teams' hosts, or nobody. */
export const frameAncestors = (frameable: boolean): string =>
  frameable ? `frame-ancestors ${TEAMS_FRAME_ANCESTORS.join(' ')}` : "frame-ancestors 'none'";
