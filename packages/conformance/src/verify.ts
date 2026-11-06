/**
 * What the suite recomputes for itself, from `@parley/shared/chain` and WebCrypto alone: a v2 chain
 * from a record bundle (spec/05-chains.md) and a statement's signature (spec/06-signatures.md). It
 * imports nothing of the server it checks, so a server cannot pass by sharing a bug with it; the
 * record's bytes it uses are the ones the committed vectors hold.
 */
import {
  type CommitmentEntry,
  chainHeadV2,
  commitmentOf,
  eventEnvelopeV2,
  fromB64u,
  isHex64,
  isNonce,
  ROOM_RECORD_FORMAT,
  type RecordEvent,
  type RoomRecordBundle,
  utf8,
} from '@parley/shared/chain';

/** Whether `sig` is `key`'s signature over `statement`'s UTF-8: Ed25519, or ECDSA P-256 over SHA-256 with r || s. */
export async function verifySignature(alg: string, key: string, statement: string, sig: string): Promise<boolean> {
  try {
    const raw = fromB64u(key);
    const signature = fromB64u(sig);
    if (signature.length !== 64) return false;
    const data = utf8(statement) as BufferSource;
    if (alg === 'ed25519') {
      if (raw.length !== 32) return false;
      const k = await globalThis.crypto.subtle.importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, ['verify']);
      return await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, k, signature as BufferSource, data);
    }
    if (alg === 'ecdsa-p256-sha256') {
      if (raw.length !== 65 || raw[0] !== 4) return false;
      const k = await globalThis.crypto.subtle.importKey('raw', raw as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, signature as BufferSource, data);
    }
    return false;
  } catch {
    return false;
  }
}

/** A record bundle's shape, or the suite's words for what is wrong with it. */
export function bundleProblem(b: unknown, room: string, view: RoomRecordBundle['view']): string | null {
  if (!b || typeof b !== 'object') return 'the record bundle is not a JSON object';
  const r = b as Partial<RoomRecordBundle>;
  if (r.format !== ROOM_RECORD_FORMAT) return `the record bundle's format is not ${ROOM_RECORD_FORMAT}`;
  if (r.room !== room) return 'the record bundle names another room';
  if (r.view !== view) return `the record bundle is not the ${view} view`;
  if (!Array.isArray(r.commitments) || !Array.isArray(r.events)) return 'the record bundle has no commitments or no events';
  let last = 0;
  for (const c of r.commitments) {
    if (!Array.isArray(c) || c.length !== 2 || !Number.isInteger(c[0]) || !isHex64(c[1])) return 'a commitment is not a (seq, hex SHA-256) pair';
    if ((c[0] as number) <= last) return 'the commitments are not in increasing seq order';
    last = c[0] as number;
  }
  if (!r.head || typeof r.head.seq !== 'number' || !isHex64(r.head.head)) return 'the record bundle has no head';
  for (const e of r.events) if (!e || typeof e !== 'object' || !isNonce((e as RecordEvent).nonce)) return 'an event in the bundle has no nonce';
  return null;
}

/** An event's commitment, recomputed from what the bundle carries of it. */
export const recompute = (room: string, e: RecordEvent): string =>
  commitmentOf(
    e.nonce,
    eventEnvelopeV2({ room, seq: e.seq, type: e.type, actor: e.actor, audience: e.audience, at: e.at, payload: e.payload, sig: e.sig ?? null }),
  );

/**
 * Recompute a bundle: every event it carries against its listed commitment, and the head from the
 * list. Null when everything matches, else what did not.
 */
export function chainProblem(b: RoomRecordBundle): string | null {
  const bySeq = new Map<number, string>(b.commitments.map(([s, c]) => [s, c]));
  for (const e of b.events) {
    const listed = bySeq.get(e.seq);
    if (!listed) return `event ${e.seq} is carried but has no commitment in the list`;
    if (recompute(b.room, e) !== listed) return `event ${e.seq} does not recompute to its commitment`;
  }
  const last = b.commitments.at(-1);
  if (!last) return 'the record lists no commitments';
  if (b.head.seq !== last[0]) return "the head's seq is not the last commitment's";
  if (chainHeadV2(b.room, b.commitments) !== b.head.head) return 'the head does not recompute from the commitments';
  return null;
}

/** The head through `seq`: the chain over the commitments up to and including it. */
export function headThrough(room: string, commitments: readonly CommitmentEntry[], seq: number): string | null {
  const upTo = commitments.filter(([s]) => s <= seq);
  if (upTo.at(-1)?.[0] !== seq) return null;
  return chainHeadV2(room, upTo);
}
