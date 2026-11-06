/**
 * Where an organisation's own database lives, and the only names `orgs.db_file` may hold. Read by
 * the server's router and by `crossroom org export` (commands/org-export.ts), which checks
 * the names an export lists; imports nothing of the server beyond the region pattern.
 */
import { REGION } from '../keys/residency.js';

/** What the router accepts as an organisation's id: letters, digits, `_` and `-` (`ORG_ID` is stricter). */
export const ORG_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** Where an organisation's own database lives, relative to the data directory (`orgs.db_file`). */
export const orgDbFile = (orgId: string) => `orgs/${orgId}.db`;

/**
 * The only values `orgs.db_file` may hold for an organisation: `orgDbFile` of its own id, or the
 * same file one region directory down (`orgs/<region>/<org>.db`, keys/residency.ts, for an
 * organisation made in a region). So no row can name a path outside `orgs/`, nor another
 * organisation's file, which would open one organisation's rooms as another's.
 */
export const validDbFile = (f: unknown, orgId: string): f is string => {
  if (typeof f !== 'string' || !ORG_KEY.test(orgId)) return false;
  if (f === orgDbFile(orgId)) return true;
  const parts = f.split('/');
  return parts.length === 3 && parts[0] === 'orgs' && REGION.test(parts[1] ?? '') && parts[2] === `${orgId}.db`;
};
