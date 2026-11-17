/**
 * `crossroom credit` (beta): the account's credit for Crossroom's agent, the agent Crossroom runs on
 * its own Anthropic key and pays for out of a workspace credit. `GET /api/account/house` lists the
 * account's grants and the offer it may still claim; `crossroom credit claim` claims that offer
 * (`POST /api/account/house/claim`), into the personal workspace unless `--workspace` names another.
 *
 * A grant moves into a team workspace only from a browser (the route refuses an API key), so this
 * command points to the account page for that. Workspace names are the account's own text, printed
 * through `line`.
 */
import type { AccountHouseView, HouseGrantView, HouseOfferPublic } from '@parley/shared/house';
import { MICRO } from '@parley/shared/house';
import { type Args, text, Usage } from '../cli.js';
import { registerCommand } from './index.js';
import { line } from './project-pick.js';
import { call, type FetchLike, realFetch, signedIn } from './relay-call.js';

/** Micro-dollars as dollars and cents. */
export const dollars = (micro: number): string => `$${(Math.max(0, micro) / MICRO).toFixed(2)}`;

const day = (iso: string): string => iso.slice(0, 10);

/** Why an account can't claim a live offer, in words. */
const REFUSED: Record<NonNullable<AccountHouseView['refusal']>, string> = {
  not_signed_in: 'sign in to claim it',
  claimed: 'this account has claimed it already',
  not_eligible: 'this account is not eligible for it',
  promo_full: 'it has all been claimed',
  promo_ended: 'it has ended',
  off: 'Crossroom has paused it',
};

const offerLine = (o: HouseOfferPublic): string =>
  `${dollars(o.grantMicro)} of credit, good for ${o.creditDays} days once claimed${o.endsAt ? `; the offer ends ${day(o.endsAt)}` : ''}`;

function grantLine(g: HouseGrantView): string {
  const where = `${line(g.orgName) || 'a workspace'} (${g.orgKind === 'personal' ? 'personal' : 'team'})`;
  const state =
    g.state === 'live' ? `${dollars(g.leftMicro)} left of ${dollars(g.grantedMicro)}, until ${day(g.expiresAt)}` : `${g.state}, spent ${dollars(g.spentMicro)} of ${dollars(g.grantedMicro)}`;
  return `  ${where}: ${state}`;
}

/** What `crossroom credit` prints for the account's view. */
export function creditLines(v: AccountHouseView, relay: string): string[] {
  if (!v.offered && !v.grants.length) return [`${new URL(relay).host} does not offer Crossroom's agent right now.`];
  const out = ["Crossroom's agent (beta): an agent Crossroom runs in your rooms, paid from a workspace credit."];
  if (v.grants.length) out.push('', 'Your credit:', ...v.grants.map(grantLine));
  if (v.claimable) out.push('', `You can claim ${offerLine(v.claimable)}: crossroom credit claim`);
  else if (v.refusal) out.push('', `There is an offer, but ${REFUSED[v.refusal] ?? 'it cannot be claimed'}.`);
  if (v.grants.some((g) => g.state === 'live')) out.push('', 'Seat it in a room: crossroom new "<topic>" --crossroom-agent, or crossroom new --add <room> --crossroom-agent');
  if (v.teams.length && v.grants.some((g) => g.state === 'live' && !g.final))
    out.push(`To move a personal credit into a team workspace, use your account page: ${relay}/account`);
  return out;
}

export async function credit(args: Args, fetchImpl: FetchLike = realFetch): Promise<{ view: AccountHouseView; relay: string }> {
  const { relay, token } = signedIn(args);
  const sub = args.positional[0];
  if (sub === undefined) return { view: await call<AccountHouseView>(relay, token, fetchImpl, 'GET', '/api/account/house'), relay };
  if (sub !== 'claim') throw new Usage(`crossroom credit takes no "${sub}". Run \`crossroom credit\` or \`crossroom credit claim\`.`);
  const orgId = text(args.flags.workspace);
  const view = await call<AccountHouseView>(relay, token, fetchImpl, 'POST', '/api/account/house/claim', orgId ? { orgId } : {});
  return { view, relay };
}

registerCommand({
  name: 'credit',
  topic: 'workspace',
  usage: 'crossroom credit [--relay <url>] [--json]',
  summary: "(beta) your credit for Crossroom's agent, and the offer you can still claim",
  order: 175,
  forms: [{ usage: 'crossroom credit claim [--workspace <id>]', summary: '(beta) claim the offer, into your personal workspace unless named', order: 176 }],
  async run(args) {
    const { view, relay } = await credit(args);
    if (args.flags.json) console.log(JSON.stringify(view, null, 2));
    else {
      if (args.positional[0] === 'claim') console.log('Claimed.\n');
      console.log(creditLines(view, relay).join('\n'));
    }
    return 0;
  },
});
