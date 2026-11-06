/**
 * Residency: which region an organisation's database lives in, `orgs.region`, with the
 * file at `orgs/<region>/<org>.db` under the data directory. The server's router
 * opens the file, and makes an organisation's, through these functions.
 *
 * - A private relay's operator names its regions in `PARLEY_REGIONS` (`eu,us`), each a directory
 *   they mount where its data must stay. An organisation is placed in one when it is made, and moving
 *   one later is the shard router's.
 * - **Never claimed on the hosted instance:** with the hosted licence set (`PARLEY_HOSTED_LICENCE`),
 *   no region is offered, whatever `PARLEY_REGIONS` says, and the settings say residency is not
 *   claimed. The hosted instance runs in one place, so it claims none.
 * - A region is a short lower-case name, so it is a path segment of its own and nothing else: no
 *   value of `orgs.region` can name a file outside `orgs/`.
 */
import { HOSTED_LICENCE_ENV, HOSTED_LICENCE_VALUE } from '@parley/shared/enterprise';

type Env = Record<string, string | undefined>;

export const REGIONS_ENV = 'PARLEY_REGIONS';
/** A region's name: a path segment, lower case, never `.` or `..`. */
export const REGION = /^[a-z][a-z0-9-]{0,31}$/;

/** Whether this instance is the hosted one, which never claims residency. */
export const hostedInstance = (env: Env) => env[HOSTED_LICENCE_ENV]?.trim() === HOSTED_LICENCE_VALUE;

/** The regions this instance offers, in its operator's order: none on the hosted instance. */
export function residencyRegions(env: Env): string[] {
  if (hostedInstance(env)) return [];
  const seen = new Set<string>();
  for (const r of (env[REGIONS_ENV] ?? '').split(',').map((s) => s.trim())) if (REGION.test(r)) seen.add(r);
  return [...seen];
}

/** Whether `region` is one this instance offers. */
export const regionOffered = (region: unknown, env: Env): region is string => typeof region === 'string' && residencyRegions(env).includes(region);

/** Where an organisation's database lives, relative to the data directory: `orgs/<org>.db`, or `orgs/<region>/<org>.db`. */
export function regionalDbFile(orgId: string, region: string | null): string {
  if (region === null) return `orgs/${orgId}.db`;
  if (!REGION.test(region)) throw new Error(`${JSON.stringify(region)} is not a region`);
  return `orgs/${region}/${orgId}.db`;
}

/** What the settings say of an organisation's residency. */
export function residencyView(region: string | null, env: Env): { region: string | null; regions: string[]; claimed: boolean } {
  const regions = residencyRegions(env);
  const claimed = !hostedInstance(env) && region !== null && regions.includes(region);
  return { region: claimed ? region : null, regions, claimed };
}
