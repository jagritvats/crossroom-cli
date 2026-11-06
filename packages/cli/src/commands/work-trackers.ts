/**
 * GitHub and Jira for `crossroom work import` and `crossroom work sync`, read on this machine with the
 * person's own token (Azure DevOps is work-azure.ts), and what all three send Crossroom.
 *
 * Crossroom holds no tracker credential, so a private repository or a private Jira can only be read
 * where its token is: here, or in a CI job. Each token comes from the environment and goes to its own
 * tracker's origin and nowhere else, never follows a redirect, and never reaches Crossroom: what the
 * project gets is the item as the shared reader (trackers/) made it, sent to
 * `POST /api/projects/:p/import/reported` (`reportOf`).
 *
 * - GitHub: `GITHUB_TOKEN` or `GH_TOKEN`, to `https://api.github.com` only. A sync is a search
 *   (`repo:<owner>/<repo> <qualifiers>`, newest change first), each result read with its comments and
 *   timeline.
 * - Jira: on Jira Cloud (`*.atlassian.net`) `JIRA_EMAIL` with `JIRA_API_TOKEN`, as basic auth; on a
 *   self-managed site `JIRA_PAT`, as a bearer token, and only to the site `JIRA_SITE` names, since the
 *   address a person pastes can name any host. `JIRA_SITE`, when set, holds for Jira Cloud too. A sync
 *   is a JQL search in one project (`project = "KEY" AND (<condition>)`), each issue then read whole.
 */
import { GITHUB_TOKEN_ENV, isJiraCloudHost, JIRA_TOKEN_ENV, TRACKER_WORD, type TrackerProvider } from '@parley/shared/trackers';
import { Usage } from '../cli.js';
import { type GithubItemRef, readGithubItem } from '../trackers/github.js';
import { type Synced, syncItems, TrackerAnswerError, type TrackerFilter, type TrackerIo, TrackerQueryError, type TrackerRead } from '../trackers/io.js';
import { type JiraWhere, jiraApiOf, readJiraIssue } from '../trackers/jira.js';
import { line } from './project-pick.js';
import type { FetchLike } from './relay-call.js';

/** A token as a request carries it, and the variable it came from (said in messages, never its value). */
export interface TrackerToken {
  from: string;
  header: string;
}

const NOTHING_SENT = 'Nothing was sent to Crossroom.';

/**
 * A getter that sends `tok` to `origin` and nowhere else: every path is joined to that origin, and a
 * redirect fails the request. `name` says which tracker in a refusal.
 */
export function tokenIo(fetchImpl: FetchLike, origin: string, tok: TrackerToken, name: string, headers: Record<string, string> = {}): TrackerIo {
  const send = async (path: string, init: { method: string; json?: unknown }) => {
    if (!path.startsWith('/')) throw new Usage(`${name}: a path that is not on ${origin}. ${NOTHING_SENT}`);
    let res: Response;
    try {
      res = await fetchImpl(`${origin}${path}`, {
        method: init.method,
        redirect: 'error',
        headers: {
          authorization: tok.header,
          accept: 'application/json',
          'user-agent': 'crossroom',
          ...headers,
          ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      });
    } catch {
      throw new Usage(`${name} could not be reached. ${NOTHING_SENT}`);
    }
    if (res.status === 401 || res.status === 203) throw new Usage(`${name} refused the token in ${tok.from}: it may have expired, or may not read that. ${NOTHING_SENT}`);
    if (res.status === 403) throw new Usage(`The token in ${tok.from} may not read that, or ${name} is limiting requests. ${NOTHING_SENT}`);
    if (res.status === 404) throw new Usage(`${name} has no such item or project, or the token in ${tok.from} may not see it. ${NOTHING_SENT}`);
    if (res.status === 429) throw new Usage(`${name} is limiting requests right now. Try again in a few minutes.`);
    const text = await res.text();
    if (!res.ok) {
      let msg = '';
      try {
        const j = JSON.parse(text) as { message?: unknown; errorMessages?: unknown };
        msg = String(j.message ?? (Array.isArray(j.errorMessages) ? j.errorMessages.join('; ') : ''));
      } catch {
        // not JSON
      }
      throw new Usage(`${name} answered ${res.status}${msg ? `: ${line(msg).slice(0, 300)}` : ''}. ${NOTHING_SENT}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Usage(`${name} answered something that is not JSON (a sign-in page?). ${NOTHING_SENT}`);
    }
  };
  return { get: (path) => send(path, { method: 'GET' }), post: (path, json) => send(path, { method: 'POST', json }) };
}

/** A reader's refusal of the tracker's answer, said as the command says things. */
export async function readOr<T>(name: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof TrackerAnswerError) throw new Usage(`${name} answered for another item. ${NOTHING_SENT}`);
    if (e instanceof TrackerQueryError) throw new Usage(`${e.message} ${NOTHING_SENT}`);
    throw e;
  }
}

/** A condition as a sync takes it: the person's own words in the tracker's language, or a filter compiled from flags. */
export const asked = (q: string | TrackerFilter) => (typeof q === 'string' ? { query: q } : { filter: q });

// ---------------------------------------------------------------- what Crossroom is sent

export { reportOf } from '../trackers/report.js';

// ---------------------------------------------------------------- GitHub

const GITHUB_API = 'https://api.github.com';
const GITHUB_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

/** The person's GitHub token, from the first of `GITHUB_TOKEN_ENV` that is set, or null. */
export function githubToken(env: NodeJS.ProcessEnv): TrackerToken | null {
  for (const from of GITHUB_TOKEN_ENV) {
    const v = env[from]?.trim();
    if (v) return { from, header: `Bearer ${v}` };
  }
  return null;
}

export const GITHUB_NO_TOKEN = `Set ${GITHUB_TOKEN_ENV[0]} (or ${GITHUB_TOKEN_ENV[1]}) to a token that can read the repository's issues and pull requests (a fine-grained token with Issues and Pull requests: Read, or \`gh auth token\`). The token stays on this machine.`;

export const githubIo = (fetchImpl: FetchLike, tok: TrackerToken) => tokenIo(fetchImpl, GITHUB_API, tok, 'GitHub', GITHUB_HEADERS);

export function readGithubWithToken(fetchImpl: FetchLike, tok: TrackerToken, ref: GithubItemRef): Promise<TrackerRead> {
  return readOr('GitHub', () => readGithubItem(githubIo(fetchImpl, tok), ref, { readBy: 'account' }));
}

export { GITHUB_DEFAULT_QUERY, GITHUB_NO_SPRINT, parseGithubRepo } from '../trackers/github.js';
export type { Synced };

/** The issues and pull requests a search picks in one repository, newest change first, at most `limit`, each read whole. */
export function syncGithub(fetchImpl: FetchLike, tok: TrackerToken, repo: string, q: string | TrackerFilter, limit: number): Promise<{ items: Synced[]; more: boolean }> {
  return readOr('GitHub', () => syncItems(githubIo(fetchImpl, tok), { provider: 'github', where: `https://github.com/${repo}`, ...asked(q), limit, readBy: 'account' }));
}

// ---------------------------------------------------------------- Jira

const sameOrigin = (a: string, b: string) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/**
 * The person's Jira credential for `site` (`https://<host>`), or null when none is set. Throws when
 * one is set but may not go there: a self-managed site needs `JIRA_SITE` to name it.
 */
export function jiraToken(env: NodeJS.ProcessEnv, site: string): TrackerToken | null {
  const E = JIRA_TOKEN_ENV;
  const pinned = env[E.site]?.trim();
  const cloud = isJiraCloudHost(new URL(site).hostname);
  const email = env[E.email]?.trim();
  const token = env[E.token]?.trim();
  const pat = env[E.pat]?.trim();
  if (!(email && token) && !pat) return null;
  if (pinned && !sameOrigin(pinned, site))
    throw new Usage(`${E.site} names ${line(pinned)}, so no Jira token goes to ${line(site)}. Nothing was read or sent.`);
  if (cloud) {
    if (email && token) return { from: E.token, header: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
    throw new Usage(`Jira Cloud reads ${E.email} with ${E.token} (id.atlassian.com, Security, API tokens); ${E.pat} is for a self-managed site. Nothing was read or sent.`);
  }
  if (!pat) throw new Usage(`A self-managed Jira reads a personal access token from ${E.pat}. Nothing was read or sent.`);
  if (!pinned) throw new Usage(`${E.pat} is sent only to the site ${E.site} names: set ${E.site}=${site} to read ${line(site)} with it. Nothing was read or sent.`);
  return { from: E.pat, header: `Bearer ${pat}` };
}

export const JIRA_NO_TOKEN = `Set ${JIRA_TOKEN_ENV.email} and ${JIRA_TOKEN_ENV.token} for Jira Cloud (id.atlassian.com, Security, API tokens), or ${JIRA_TOKEN_ENV.pat} and ${JIRA_TOKEN_ENV.site} for a self-managed Jira. The token stays on this machine.`;

/** Version 3 on Jira Cloud, 2 on a self-managed site. */
export { jiraApiOf } from '../trackers/jira.js';

export const jiraIo = (fetchImpl: FetchLike, site: string, tok: TrackerToken) => tokenIo(fetchImpl, site, tok, 'Jira');

export function readJiraWithToken(fetchImpl: FetchLike, tok: TrackerToken, ref: { site: string; key: string }): Promise<TrackerRead> {
  return readOr('Jira', () => readJiraIssue(jiraIo(fetchImpl, ref.site, tok), ref, { readBy: 'account', api: jiraApiOf(ref.site) }));
}

export { JIRA_DEFAULT_QUERY, type JiraWhere, jiraJql, parseJiraWhere } from '../trackers/jira.js';

/** The issues a JQL condition (or a filter) picks in one project, newest change first, at most `limit`, each read whole. */
export async function syncJira(fetchImpl: FetchLike, tok: TrackerToken, where: JiraWhere, q: string | TrackerFilter, sprint: boolean, limit: number): Promise<{ items: Synced[]; more: boolean; project: string }> {
  const r = await readOr('Jira', () =>
    syncItems(jiraIo(fetchImpl, where.site, tok), { provider: 'jira', where: whereUrl(where), ...asked(q), sprint: sprint ? 'current' : null, limit, readBy: 'account', anyHost: true }),
  );
  return { items: r.items, more: r.more, project: r.project ?? where.project ?? '' };
}

/** A place as an address again, as the shared readers take one. */
const whereUrl = (w: JiraWhere) => (w.project ? `${w.site}/browse/${w.project}` : `${w.site}/jira/software/c/boards/${w.board}`);

export const tokenWord = (p: TrackerProvider) => `your ${TRACKER_WORD[p]} token`;
