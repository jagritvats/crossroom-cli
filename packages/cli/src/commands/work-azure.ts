/**
 * Azure DevOps work items for `crossroom work`, read on this machine with the person's own token.
 *
 * Crossroom holds no Azure DevOps credential, so a private board can only be read where its token
 * is: here, or in a CI job. The token comes from the environment (`AZURE_TOKEN_ENV`: a personal
 * access token with Work Items: Read, or Azure Pipelines' `System.AccessToken`), goes only to
 * `https://dev.azure.com` (the address is rebuilt from the parsed item, whichever host it came by),
 * never follows a redirect, and never reaches Crossroom: what the project gets is the item as the
 * shared reader (trackers/azure.ts) made it, sent to `POST /api/projects/:p/import/reported`.
 *
 * - `readAzureItem`: one item, by its address, with its relations, iteration and comments.
 * - `queryAzureItems`: the items a WIQL condition picks in one Azure DevOps project, newest change
 *   first, read 200 at a time: `crossroom work sync`, which a schedule runs to keep a board in step.
 *   With `sprint`, only the team's current iteration (`@CurrentIteration`, asked in the team's context).
 */
import { type AzureWorkItemRef, AZURE_TOKEN_ENV } from '@parley/shared/azure-devops';
import { AZURE_DEFAULT_QUERY, type AzureWhere, readAzureWorkItem } from '../trackers/azure.js';
import { syncItems, type TrackerFilter, type TrackerRead } from '../trackers/io.js';
import type { FetchLike } from './relay-call.js';
import { asked, readOr, type Synced, type TrackerToken, tokenIo } from './work-trackers.js';

const SITE = 'https://dev.azure.com';
/** The most items one sync reads. */
export const SYNC_MAX = 1000;
/** What `sync` asks for when no `--query` is given: everything not yet finished. */
export const DEFAULT_QUERY = AZURE_DEFAULT_QUERY;

export interface AzureToken extends TrackerToken {
  /** The environment variable it came from. */
  from: (typeof AZURE_TOKEN_ENV)[number];
}

/** The person's token, from the first of `AZURE_TOKEN_ENV` that is set, or null. */
export function azureToken(env: NodeJS.ProcessEnv): AzureToken | null {
  for (const from of AZURE_TOKEN_ENV) {
    const v = env[from]?.trim();
    if (!v) continue;
    // Azure Pipelines' job token is an OAuth bearer; a personal access token goes as basic auth with an empty user.
    const header = from === 'SYSTEM_ACCESSTOKEN' ? `Bearer ${v}` : `Basic ${Buffer.from(`:${v}`).toString('base64')}`;
    return { from, header };
  }
  return null;
}

export const NO_TOKEN = `Set ${AZURE_TOKEN_ENV[0]} to a personal access token with Work Items: Read (in Azure Pipelines, map SYSTEM_ACCESSTOKEN into the step's env). The token stays on this machine.`;

export { type AzureWhere, parseAzureProject } from '../trackers/azure.js';

export const azureIo = (fetchImpl: FetchLike, tok: AzureToken) => tokenIo(fetchImpl, SITE, tok, 'Azure DevOps', { 'x-tfs-fedauthredirect': 'Suppress' });

/** One work item, read with the person's token. */
export function readAzureItem(fetchImpl: FetchLike, tok: AzureToken, ref: AzureWorkItemRef): Promise<TrackerRead> {
  return readOr('Azure DevOps', () => readAzureWorkItem(azureIo(fetchImpl, tok), ref, { readBy: 'account' }));
}

export type QueriedItem = Synced;

/**
 * The items `where` picks in the project, newest change first, at most `limit`. `where` is a WIQL
 * condition, the person's own, or a filter compiled from flags. With `sprint`, the team's current
 * iteration only, which needs `at.team`.
 */
export function queryAzureItems(
  fetchImpl: FetchLike,
  tok: AzureToken,
  at: AzureWhere,
  where: string | TrackerFilter,
  limit: number,
  o: { sprint?: boolean } = {},
): Promise<{ items: QueriedItem[]; more: boolean }> {
  const place = `${SITE}/${encodeURIComponent(at.org)}/${encodeURIComponent(at.project)}`;
  return readOr('Azure DevOps', () =>
    syncItems(azureIo(fetchImpl, tok), { provider: 'azure', where: place, team: at.team ?? null, ...asked(where), sprint: o.sprint === true && !!at.team ? 'current' : null, limit, readBy: 'account' }),
  );
}
