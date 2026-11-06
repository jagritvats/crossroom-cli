/**
 * A co-signed head: once a room ends, each side's runner signs `parley/cosign/v1`
 * over the room's head, as the role its seat holds (`host`, or `guest` across a connection), in its
 * organisation's name for itself (`org:<domain>` or `org:<id>`). A co-sign signs the head, never the
 * document: whoever holds the minutes and the record checks that the minutes are over that head.
 *
 * The key is the runner's own (runner/signer.ts), the same one its receipts and writes are signed
 * with. The relay vouches for it on first use only; the organisation vouches for it by publishing
 * it at `https://<domain>/.well-known/parley-keys.json` (`parleyKeysFor`, the document's format in
 * cosign/verify-cosign.ts), which `crossroom verify --record --org <domain>` reads.
 */
import { cosignStatement } from '@parley/shared/chain';
import { type KeyUse, type ParleyKeys, parleyKeysDocument } from '../cosign/verify-cosign.js';
import type { StatementSigner } from './signer.js';

/** An organisation's name for itself, as a co-signature's `by` takes it. */
export const COSIGN_AS = /^org:[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$/;

export interface CosignBodyOut {
  seq: number;
  head: string;
  role: 'host' | 'guest';
  by: string;
  alg: StatementSigner['alg'];
  key: string;
  sig: string;
}

/** The body `POST /api/seat/cosign` takes, signed over the head at `seq` of the bundle's own relay and room. */
export function cosignBody(signer: StatementSigner, at: { relay: string; room: string; seq: number; head: string }, role: 'host' | 'guest', by: string): CosignBodyOut {
  if (!COSIGN_AS.test(by)) throw new Error('a co-signature is made as org:<domain> or org:<organisation id>');
  const statement = cosignStatement({ relay: at.relay, room: at.room, seq: at.seq, head: at.head, role });
  return { seq: at.seq, head: at.head, role, by, alg: signer.alg, key: signer.key, sig: signer.sign(statement) };
}

/** The `/.well-known/parley-keys.json` an organisation publishes to vouch for this runner's key. */
export function parleyKeysFor(domain: string, signer: StatementSigner, o: { label?: string; use?: KeyUse[] } = {}): ParleyKeys {
  return parleyKeysDocument(domain, [{ alg: signer.alg, key: signer.key, ...o }]);
}
