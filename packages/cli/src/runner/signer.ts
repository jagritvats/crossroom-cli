/**
 * What a seat's runner signs statements with: receipts, write signatures,
 * attestations and co-signatures, each a statement from @parley/shared/chain signed as UTF-8 bytes,
 * exactly as given.
 *
 * - `crossroom runner start` signs with the runner's own Ed25519 key (runner/keys.ts), the one it
 *   registered with the relay before any job was leased to it, so the relay holds each of its seats
 *   to that key and an organisation can publish it
 *   (`/.well-known/parley-keys.json`, cosign/verify-cosign.ts).
 * - `crossroom join`, which registers nothing, signs with a key made for the job (`ephemeralSigner`):
 *   the relay pins it at its first signature, on first use, and says so.
 *
 * The private key stays in this process. Nothing here logs, and no key goes in an argument or the
 * environment of anything it starts.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import type { SigAlg } from '@parley/shared/chain';
import type { RunnerKeys } from './keys.js';

export interface StatementSigner {
  alg: SigAlg;
  /** The public key, base64url (Ed25519: its raw 32 bytes). */
  key: string;
  /** The signature over the statement's UTF-8 bytes, base64url. */
  sign(statement: string): string;
}

function ed25519(privateKey: KeyObject): StatementSigner {
  const key = String(createPublicKey(privateKey).export({ format: 'jwk' }).x);
  return { alg: 'ed25519', key, sign: (statement) => sign(null, Buffer.from(statement, 'utf8'), privateKey).toString('base64url') };
}

/** The runner's registered key as a signer. Throws when the stored private key is not its public key's. */
export function runnerSigner(keys: Pick<RunnerKeys, 'ed25519Private' | 'ed25519Public'>): StatementSigner {
  const s = ed25519(createPrivateKey({ key: Buffer.from(keys.ed25519Private, 'base64url'), format: 'der', type: 'pkcs8' }));
  if (s.key !== keys.ed25519Public) throw new Error("this runner's ed25519 public key is not its private key's");
  return s;
}

/** A key made for one job, held only in memory. */
export const ephemeralSigner = (): StatementSigner => ed25519(generateKeyPairSync('ed25519').privateKey);
