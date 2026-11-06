/**
 * `crossroom logout [--relay <url>]`: sign this machine out of a Crossroom account. The token
 * `crossroom login` kept for the relay revokes itself (`POST /api/auth/logout` with it as the bearer,
 * which ends that token and calls in flight through it, and nothing else of the account's), and is
 * then forgotten here.
 *
 * It is forgotten even when the relay cannot be reached, since forgetting is what was asked; the
 * answer then says the token still stands there, and where to revoke it.
 */
import { type Args, Usage } from '../cli.js';
import { forgetAgentsNote } from './agents-note.js';
import { credentialsPath, DEFAULT_RELAY, readCredentials, writeCredentials } from './credentials.js';
import { registerCommand } from './index.js';
import { chosenInstance } from './relay-call.js';

export async function logout(args: Args, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<string> {
  if (args.positional.length) throw new Usage('Usage: crossroom logout [--relay <url>]');
  const relay = chosenInstance(args, DEFAULT_RELAY);
  const creds = readCredentials();
  const held = creds[relay];
  if (!held) {
    const others = Object.keys(creds);
    return `This machine is not signed in to ${relay}.${others.length ? ` It is signed in to ${others.join(', ')}: pass --relay to sign out of one.` : ''}`;
  }
  let revoked = false;
  try {
    const res = await fetchImpl(`${relay}/api/auth/logout`, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${held.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    revoked = res.ok;
  } catch {
    /* unreachable: said below */
  }
  delete creds[relay];
  writeCredentials(creds);
  // A machine signed out of the account no longer tells its sessions about the account's agents.
  forgetAgentsNote(relay);
  return revoked
    ? `Signed out of ${relay}. The token is revoked there and gone from ${credentialsPath()}.`
    : `Forgotten on this machine, but ${relay} did not confirm it revoked the token, so it may still work until it expires. Revoke it on your account page, under "Terminals signed in".`;
}

registerCommand({
  name: 'logout',
  topic: 'workspace',
  usage: 'crossroom logout [--relay <url>]',
  summary: 'sign this machine out of your Crossroom account',
  order: 171,
  run: async (args) => {
    console.log(await logout(args));
    return 0;
  },
});
