/**
 * `crossroom org`: an account's organisations on a relay, from the terminal.
 *
 * The forms, all under this one command, each signed in with `crossroom login`'s API token for the
 * relay (`~/.parley/credentials.json`):
 * - `crossroom org [list] [--relay <url>] [--json]`: the organisations the account is a member of,
 *   with their teams and projects (`GET /api/orgs`, `GET /api/orgs/:o`).
 * - `crossroom org create <slug> --name "<name>"`: a new organisation, the account its owner
 *   (`POST /api/orgs`).
 * - `crossroom org invite <org> [--role member|admin|auditor]`: an invitation link, shown once
 *   (`POST /api/orgs/:o/invitations`). `<org>` is a slug or an id of one of the account's own.
 * - `crossroom org export <org> --out <file>`: the organisation's own database file, for an owner
 *   (commands/org-export.ts).
 *
 * The token travels only as the `Authorization` header to the relay it was issued by, on requests
 * that refuse to follow a redirect (a redirect would carry the header to wherever it points), and
 * is never printed, put in a URL, or handed to another process. The invitation link is printed,
 * once: it is what the command is for, and the relay keeps only its hash.
 *
 * A golden test pins the help lines.
 */
import type { InvitationResult, OrgDetail, OrgView } from '@parley/shared/org';
import { accessLabel } from '@parley/shared/org';
import { type Args, text, Usage } from '../cli.js';
import { call, type FetchLike, realFetch, signedIn } from './relay-call.js';
import { registerCommand } from './index.js';
import { orgExport } from './org-export.js';

export type { FetchLike };

const USAGE = 'Usage: crossroom org [list] [--relay <url>] [--json] | create <slug> --name "<name>" | invite <org> [--role member|admin|auditor]';
const ROLES = ['member', 'admin', 'auditor'];

/** The organisation a user named, by slug or id, among the account's own. */
async function findOrg(relay: string, token: string, fetchImpl: FetchLike, named: string): Promise<OrgView> {
  const mine = await call<OrgView[]>(relay, token, fetchImpl, 'GET', '/api/orgs');
  const found = mine.find((o) => o.slug === named || o.id === named);
  if (!found)
    throw new Usage(
      `You are not a member of an organisation called "${named}" on ${relay}.${mine.length ? ` Yours: ${mine.map((o) => o.slug).join(', ')}.` : ''}`,
    );
  return found;
}

function describe(o: OrgDetail): string[] {
  const lines = [`${o.name} (${o.slug})  ${o.role}  ${o.id}`];
  lines.push(`  teams: ${o.teams.length ? o.teams.map((t) => `${t.name} (${t.members})${t.role ? ` [${t.role}]` : ''}`).join(', ') : 'none yet'}`);
  lines.push(
    `  projects: ${
      o.projects.length
        ? o.projects.map((p) => `${accessLabel({ custody: 'project', project: { id: p.id, name: p.name, members: p.members } })}${p.role ? ` [${p.role}]` : ''}`).join(', ')
        : 'none yet'
    }`,
  );
  if (o.members) lines.push(`  members: ${o.members.length}`);
  return lines;
}

/**
 * `crossroom org …`. Results go to `out` (stdout), progress and refusals are thrown as `Usage`. The
 * number is the exit code.
 */
export async function orgCommand(args: Args, out: (line: string) => void, fetchImpl: FetchLike = realFetch): Promise<number> {
  const [form = 'list', ...rest] = args.positional;
  const json = args.flags.json === true;
  if (form === 'list') {
    if (rest.length) throw new Usage(USAGE);
    const { relay, token } = signedIn(args);
    const mine = await call<OrgView[]>(relay, token, fetchImpl, 'GET', '/api/orgs');
    const details: OrgDetail[] = [];
    for (const o of mine) details.push(await call<OrgDetail>(relay, token, fetchImpl, 'GET', `/api/orgs/${encodeURIComponent(o.id)}`));
    if (json) out(JSON.stringify(details, null, 2));
    else if (!details.length) out(`You are not a member of any organisation on ${relay}. Make one with \`crossroom org create <slug> --name "<name>"\`.`);
    else for (const d of details) for (const l of describe(d)) out(l);
    return 0;
  }
  if (form === 'create') {
    const slug = rest[0];
    const name = text(args.flags.name);
    if (!slug || rest.length > 1 || !name) throw new Usage('Usage: crossroom org create <slug> --name "<name>"');
    const { relay, token } = signedIn(args);
    const made = await call<OrgView>(relay, token, fetchImpl, 'POST', '/api/orgs', { name, slug });
    if (json) out(JSON.stringify(made, null, 2));
    else out(`Made ${made.name} (${made.slug}) on ${relay}, and you are its owner. Invite people with \`crossroom org invite ${made.slug}\`.`);
    return 0;
  }
  if (form === 'invite') {
    const named = rest[0];
    const role = text(args.flags.role) ?? 'member';
    if (!named || rest.length > 1) throw new Usage('Usage: crossroom org invite <org> [--role member|admin|auditor]');
    if (!ROLES.includes(role)) throw new Usage(`--role is one of ${ROLES.join(', ')}; got "${role}".`);
    const { relay, token } = signedIn(args);
    const o = await findOrg(relay, token, fetchImpl, named);
    const inv = await call<InvitationResult>(relay, token, fetchImpl, 'POST', `/api/orgs/${encodeURIComponent(o.id)}/invitations`, { role });
    if (json) out(JSON.stringify(inv, null, 2));
    else {
      out(`An invitation to ${o.name} as ${inv.role}, until ${inv.expiresAt.slice(0, 10)}. Send it to the person it is for; it works once, and is not shown again:`);
      out(`  ${inv.url}`);
    }
    return 0;
  }
  throw new Usage(USAGE);
}

registerCommand({
  name: 'org',
  topic: 'workspace',
  usage: 'crossroom org [list] [--relay <url>]',
  summary: 'your organisations on a relay, with their teams and projects',
  more: [{ usage: 'create <slug> --name "<name>" | invite <org> [--role member|admin|auditor] | export <org> --out <file>' }],
  order: 180,
  run(args, say) {
    if (args.positional[0] === 'export') return orgExport(args, say);
    return orgCommand(args, (line) => console.log(line));
  },
});
