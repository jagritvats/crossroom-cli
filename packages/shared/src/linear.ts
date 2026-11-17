/**
 * Crossroom as an agent in Linear, for lanes (`@parley/shared/linear`): what a lane's owner sets up,
 * and what the web app and the server say to each other about it.
 *
 * In Linear, a person delegates an issue to the Crossroom app, or mentions it. Where that issue's
 * team is connected to a lane, the issue is filed in the lane for the other side's agent, exactly as
 * a person's own mirror would file it (`via: linear`), and each move of that item comes back to the
 * issue as the app's activity: being worked, a question for the filer, the outcome with its links.
 * The person answers, accepts or sends it back from Linear.
 *
 * An instance offers this only where its operator configured a Linear app of the instance's own and
 * turned the `linearAgent` flag on. The instance then holds, for each connected workspace, that
 * app's token (it posts as the app, never as a person), and for each connected lane the link of the
 * side Linear files for. Both are sealed under a key of the instance's own.
 *
 * No zod, so the web app imports it as it is.
 */

/** The owner's routes for one lane: `GET` what is connected, `POST` to start connecting, `DELETE` to disconnect. */
export const linearLanePath = (roomId: string) => `/api/sessions/${encodeURIComponent(roomId)}/linear`;
/** Where Linear sends the admin back after consent. Registered as the app's redirect address. */
export const LINEAR_CALLBACK_PATH = '/api/linear/callback';
/** Where Linear posts its webhooks. Registered as the app's webhook address. */
export const LINEAR_WEBHOOK_PATH = '/api/linear/webhook';

/** The fragment parameter the callback leaves on the lane's page, and its values. */
export const LINEAR_RESULT_PARAM = 'linear';
export const LINEAR_RESULTS = ['connected', 'refused', 'taken', 'failed'] as const;
export type LinearResult = (typeof LINEAR_RESULTS)[number];

/** What each result means, for the lane's page. */
export const LINEAR_RESULT_WORDS: Readonly<Record<LinearResult, string>> = {
  connected: 'Linear is connected. Delegate an issue to Crossroom there and it is filed in this lane.',
  refused: 'Linear was not connected: the consent was declined or ran out of time. Start again when you are ready.',
  taken: 'Linear was not connected: that workspace already files those teams into another lane. Name other teams, or disconnect the other lane first.',
  failed: 'Linear was not connected: Linear did not answer as expected. Try again in a minute.',
};

/** Team keys a connection may name (`ENG`, `WEB`), and how many. None means every team of the workspace. */
export const LINEAR_TEAM_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
export const LINEAR_TEAMS_MAX = 20;

/** Team keys from what a person typed (`eng, web`): upper-cased, in order, each once. Null when one is not a team key. */
export function linearTeams(raw: unknown): string[] | null {
  if (raw === undefined || raw === null || raw === '') return [];
  const parts = (Array.isArray(raw) ? raw.map(String) : String(raw).split(/[\s,]+/)).map((t) => t.trim().toUpperCase()).filter(Boolean);
  const out = [...new Set(parts)];
  if (out.length > LINEAR_TEAMS_MAX || out.some((t) => !LINEAR_TEAM_KEY.test(t))) return null;
  return out;
}

/** `POST linearLanePath(id)`: which side Linear files for, that side's seat link, and the teams. */
export interface LinearConnectInput {
  /** The side whose team uses Linear: its issues are filed for the other side. */
  side: 'A' | 'B';
  /** That side's seat link (or its token). The instance keeps it, sealed, to file and answer as that side. */
  link: string;
  /** Team keys, or none for every team. */
  teams?: string[] | string;
}

/** Its answer: where the browser goes for a Linear admin's consent. */
export interface LinearConnectStarted {
  authorizeUrl: string;
}

/** `GET linearLanePath(id)`: never a token, a link or a Linear id. */
export interface LinearLaneView {
  /** The lane's connection, or null. */
  connection: {
    /** The side Linear files for. */
    side: 'A' | 'B';
    /** The Linear workspace's name, as Linear gave it. A person's text: print it as text. */
    workspace: string;
    /** Team keys; empty for every team. */
    teams: string[];
    connectedAt: string;
    /** Issues filed from Linear whose items are still open. */
    open: number;
  } | null;
}

/** What the lane's page says before the owner connects: what the instance will hold, and what goes to Linear. */
export const LINEAR_CONNECT_WORDS = [
  'Issues delegated to Crossroom in Linear are filed in this lane for the other side, with their title, description and link.',
  "What the other side's agent writes on those items (its notes, and the links it adds) is posted to the issue in Linear under Crossroom's name. Nothing else in the lane goes to Linear.",
  "This Crossroom keeps the chosen side's lane link and its Linear app's token for that workspace, sealed, until you disconnect.",
] as const;
