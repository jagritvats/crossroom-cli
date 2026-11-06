/**
 * Transparency logs for anchoring: Rekor v2, and a relay's own log
 * for private relays (`log=local`), which keeps Rekor's shapes so one verifier reads both.
 *
 * - **What is logged** is a `hashedrekord` (v0.0.2): SHA-256 of a batch's `parley/anchor/v1`
 *   statement, its ECDSA P-256 signature (DER) and the anchoring key (PKIX DER). Nothing else
 *   leaves: the statement names the relay, an hour and a root, and the root is a hash over hashes.
 * - **What comes back** is a `TransparencyLogEntry` (protobuf's JSON mapping, so 64-bit numbers
 *   may be strings): the canonicalised body the log hashed, its index, and an inclusion proof to a
 *   checkpoint, which is a signed note (C2SP signed-note and tlog-checkpoint) naming the tree's size
 *   and root. Rekor v2 gives no integrated time, which is why each batch is also timestamped (tsa.ts).
 * - **Checking an entry** (`checkLogEntry`) recomputes the log's leaf, SHA-256(0x00 || body), walks
 *   the audit path to the checkpoint's root, and checks the checkpoint's signature against the log
 *   keys the caller trusts. What the body says (whose key, over which digest) is the caller's to
 *   hold against the statement (verify-anchor.ts).
 *
 * Nothing here has run against the real Rekor yet, so the server's anchor worker records
 * `verified: false`. Every call goes through the fetch it is handed; the server's is `safeFetch`.
 */
import { createHash, createPublicKey, type KeyObject, sign, verify } from 'node:crypto';
import { canonicalize } from '@parley/shared/chain';
import { leafHashOf, verifyInclusion } from './merkle.js';

export const P256_DETAILS = 'PKIX_ECDSA_P256_SHA_256';
export const ED25519_DETAILS = 'PKIX_ED25519';
export const HASHEDREKORD = { kind: 'hashedrekord', version: '0.0.2' } as const;

/** The name a relay's own log signs its checkpoints under. */
export const LOCAL_KEY_NAME = 'parley-anchors';
/** A relay's own log's origin line: the relay's public URL copied, never a host derived from it. */
export const localOrigin = (relay: string) => `parley/anchors/v1 ${relay}`;

/** The most a log's answer may be. */
export const LOG_MAX_BYTES = 256 * 1024;

export interface InclusionProofJson {
  logIndex: string | number;
  /** Base64. */
  rootHash: string;
  treeSize: string | number;
  /** Base64, leaf side first. */
  hashes: string[];
  checkpoint: { envelope: string };
}

/** A log's entry as Rekor v2 returns it (`dev.sigstore.rekor.v1.TransparencyLogEntry`), and as a local log keeps it. */
export interface TransparencyLogEntry {
  logIndex: string | number;
  logId?: { keyId: string };
  kindVersion: { kind: string; version: string };
  integratedTime?: string | number;
  inclusionProof: InclusionProofJson;
  /** Base64 of the body the log hashed into its leaf. */
  canonicalizedBody: string;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
/** Standard base64 in its one spelling, or null. */
function fromB64(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  const b = Buffer.from(s, 'base64');
  return b.toString('base64') === s ? new Uint8Array(b) : null;
}
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sha256 = (b: Uint8Array | string) => new Uint8Array(createHash('sha256').update(b).digest());
/** A whole number from 0, as protobuf's JSON writes a 64-bit one (a string) or as a number. */
function count(v: unknown): number | null {
  const n = typeof v === 'string' && /^(0|[1-9]\d{0,15})$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------- what is logged

/** What a hashedrekord says: a digest, a signature over the data it digests, and the key. */
export interface RekordClaims {
  /** SHA-256 of the signed data. */
  digest: Uint8Array;
  /** ECDSA, DER. */
  signature: Uint8Array;
  /** PKIX DER. */
  publicKey: Uint8Array;
}

/** The hashedrekord v0.0.2 body, JCS: what a local log hashes into its leaf, as Rekor does its own. */
export function hashedRekordBody(c: RekordClaims): string {
  return canonicalize({
    apiVersion: HASHEDREKORD.version,
    kind: HASHEDREKORD.kind,
    spec: {
      hashedRekordV002: {
        data: { algorithm: 'SHA2_256', digest: b64(c.digest) },
        signature: { content: b64(c.signature), verifier: { keyDetails: P256_DETAILS, publicKey: { rawBytes: b64(c.publicKey) } } },
      },
    },
  });
}

/** Rekor v2's `POST /api/v2/log/entries` body for a hashedrekord. */
export const hashedRekordRequest = (c: RekordClaims) => ({
  hashedRekordRequestV002: {
    digest: b64(c.digest),
    signature: { content: b64(c.signature), verifier: { publicKey: { rawBytes: b64(c.publicKey) }, keyDetails: P256_DETAILS } },
  },
});

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The claims in an entry's body, or null for a body that is no hashedrekord v0.0.2 over SHA-256. */
export function readEntryBody(tle: unknown): RekordClaims | null {
  if (!isObj(tle)) return null;
  const raw = fromB64(tle.canonicalizedBody);
  if (!raw) return null;
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    return null;
  }
  if (!isObj(body) || body.kind !== HASHEDREKORD.kind || body.apiVersion !== HASHEDREKORD.version || !isObj(body.spec)) return null;
  const spec = body.spec.hashedRekordV002;
  if (!isObj(spec) || !isObj(spec.data) || !isObj(spec.signature) || !isObj(spec.signature.verifier)) return null;
  if (spec.data.algorithm !== 'SHA2_256' || spec.signature.verifier.keyDetails !== P256_DETAILS) return null;
  const pk = spec.signature.verifier.publicKey;
  const digest = fromB64(spec.data.digest);
  const signature = fromB64(spec.signature.content);
  const publicKey = isObj(pk) ? fromB64(pk.rawBytes) : null;
  if (!digest || digest.length !== 32 || !signature || !publicKey) return null;
  return { digest, signature, publicKey };
}

/** Whether `claims` is a signature over `data` under its own key: what a log's verifier also checks. */
export function claimsSign(claims: RekordClaims, data: string): boolean {
  try {
    if (!Buffer.from(claims.digest).equals(Buffer.from(sha256(data)))) return false;
    const key = createPublicKey({ key: Buffer.from(claims.publicKey), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    return verify('sha256', Buffer.from(data, 'utf8'), key, Buffer.from(claims.signature));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- checkpoints (signed notes)

/** A log key the caller trusts: the public key, and the name its signature line goes by where known. */
export interface LogKey {
  key: KeyObject;
}

/** The em dash a note's signature line starts with, built from its code point. */
const DASH = `${String.fromCodePoint(0x2014)} `;

/** The 4-byte hints a signature by `key` may carry: C2SP's for Ed25519 (over its name), Rekor's for others (over PKIX). */
function hintsOf(key: KeyObject, name: string): string[] {
  const spki = new Uint8Array(key.export({ type: 'spki', format: 'der' }));
  const hints = [toHex(sha256(spki).subarray(0, 4))];
  if (key.asymmetricKeyType === 'ed25519') {
    const raw = spki.subarray(spki.length - 32);
    hints.push(toHex(sha256(Buffer.concat([Buffer.from(`${name}\n`, 'utf8'), Buffer.from([1]), Buffer.from(raw)])).subarray(0, 4)));
  }
  return hints;
}

/** A note's text signed by `key` (P-256 or Ed25519) under `name`, as C2SP writes it. */
export function signNote(text: string, name: string, key: KeyObject): string {
  if (!text.endsWith('\n') || /\n\n/.test(text) || /\s/.test(name)) throw new Error('a note is lines ending in a newline, signed under a name with no space');
  const pub = createPublicKey(key);
  const ed = pub.asymmetricKeyType === 'ed25519';
  const sig = ed ? sign(null, Buffer.from(text, 'utf8'), key) : sign('sha256', Buffer.from(text, 'utf8'), key);
  const hint = Buffer.from(hintsOf(pub, name)[ed ? 1 : 0]!, 'hex');
  return `${text}\n${DASH}${name} ${b64(Buffer.concat([hint, sig]))}\n`;
}

export interface Checkpoint {
  origin: string;
  size: number;
  /** Hex. */
  root: string;
}

/** The checkpoint text a log signs: origin, size and base64 root, each on its line. */
export const checkpointText = (c: Checkpoint) => `${c.origin}\n${c.size}\n${b64(Buffer.from(c.root, 'hex'))}\n`;

/** A checkpoint signed by at least one of `keys`, or null. Signature lines by keys not trusted are passed over. */
export function openCheckpoint(envelope: unknown, keys: readonly LogKey[]): Checkpoint | null {
  if (typeof envelope !== 'string' || envelope.length > 16_384) return null;
  const at = envelope.indexOf('\n\n');
  if (at < 0) return null;
  const text = envelope.slice(0, at + 1);
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 3) return null;
  const [origin, sizeText, rootText] = lines as [string, string, string];
  const size = count(sizeText);
  const root = fromB64(rootText);
  if (!origin || size === null || !root || root.length !== 32) return null;
  const sigs = envelope.slice(at + 2).split('\n');
  if (sigs.length < 2 || sigs.at(-1) !== '') return null;
  // Every signature line well formed, or none is read: a note with a broken line is no note.
  const signed: { name: string; hint: string; sig: Buffer }[] = [];
  for (const line of sigs.slice(0, -1)) {
    if (!line.startsWith(DASH)) return null;
    const rest = line.slice(DASH.length);
    const sp = rest.lastIndexOf(' ');
    const blob = sp > 0 ? fromB64(rest.slice(sp + 1)) : null;
    if (!blob || blob.length < 5) return null;
    signed.push({ name: rest.slice(0, sp), hint: toHex(blob.subarray(0, 4)), sig: Buffer.from(blob.subarray(4)) });
  }
  for (const { name, hint, sig } of signed) {
    for (const { key } of keys) {
      if (!hintsOf(key, name).includes(hint)) continue;
      try {
        const ok = key.asymmetricKeyType === 'ed25519' ? verify(null, Buffer.from(text, 'utf8'), key, sig) : verify('sha256', Buffer.from(text, 'utf8'), key, sig);
        if (ok) return { origin, size, root: toHex(root) };
      } catch {
        // A key of another type: the next.
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- an entry, checked

export type EntryCheck = { ok: true; logIndex: number; treeSize: number; origin: string } | { ok: false; reason: string };

/**
 * Whether a log entry is in its log: the body's leaf at its index, under the root of a checkpoint
 * that one of `keys` signed, of the size the proof names. `origin`, where given, must be the
 * checkpoint's.
 */
export function checkLogEntry(tle: unknown, keys: readonly LogKey[], origin?: string): EntryCheck {
  if (!isObj(tle) || !isObj(tle.inclusionProof) || !isObj(tle.kindVersion)) return { ok: false, reason: 'the log entry is not one Crossroom can read' };
  if (tle.kindVersion.kind !== HASHEDREKORD.kind || tle.kindVersion.version !== HASHEDREKORD.version) return { ok: false, reason: 'the log entry is not a hashedrekord v0.0.2' };
  const body = fromB64(tle.canonicalizedBody);
  const p = tle.inclusionProof;
  const logIndex = count(tle.logIndex);
  const treeSize = count(p.treeSize);
  const root = fromB64(p.rootHash);
  const hashes = Array.isArray(p.hashes) ? p.hashes.map(fromB64) : null;
  if (!body || logIndex === null || treeSize === null || count(p.logIndex) !== logIndex || !root || root.length !== 32 || !hashes || hashes.some((h) => !h || h.length !== 32))
    return { ok: false, reason: 'the log entry is not one Crossroom can read' };
  if (!verifyInclusion(logIndex, treeSize, leafHashOf(body), hashes.map((h) => toHex(h!)), toHex(root)))
    return { ok: false, reason: "the log's inclusion proof does not lead to its root" };
  const cp = openCheckpoint(isObj(p.checkpoint) ? p.checkpoint.envelope : null, keys);
  if (!cp) return { ok: false, reason: "the log's checkpoint is signed by no log key you trust" };
  if (cp.size !== treeSize || cp.root !== toHex(root)) return { ok: false, reason: "the log's checkpoint is of another tree" };
  if (origin !== undefined && cp.origin !== origin) return { ok: false, reason: "the log's checkpoint names another log" };
  return { ok: true, logIndex, treeSize, origin: cp.origin };
}

// ---------------------------------------------------------------- Rekor v2

export class LogError extends Error {}

export type LogFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;

/**
 * Log a batch's statement in Rekor v2 (`POST <base>/api/v2/log/entries`), and answer the entry once
 * it is the hashedrekord sent, included under the root of the checkpoint it came with. The
 * checkpoint's signature is checked by whoever verifies, against the log keys they trust.
 */
export async function submitToRekor(base: string, claims: RekordClaims, send: LogFetch): Promise<TransparencyLogEntry> {
  let res: Response;
  try {
    res = await send(`${base.replace(/\/+$/, '')}/api/v2/log/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(hashedRekordRequest(claims)),
    });
  } catch (e) {
    throw new LogError(`the log could not be reached (${(e as Error)?.name ?? 'error'})`);
  }
  if (res.status !== 200 && res.status !== 201) throw new LogError(`the log answered ${res.status}`);
  const text = await res.text();
  if (text.length > LOG_MAX_BYTES) throw new LogError('the log answered with too much');
  let tle: unknown;
  try {
    tle = JSON.parse(text);
  } catch {
    throw new LogError('the log answered with no entry');
  }
  const got = readEntryBody(tle);
  const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
  if (!got || !same(got.digest, claims.digest) || !same(got.signature, claims.signature) || !same(got.publicKey, claims.publicKey))
    throw new LogError('the log answered with an entry for something else');
  const e = tle as TransparencyLogEntry;
  const p = e.inclusionProof;
  const cp = openCheckpointUnsigned(p?.checkpoint?.envelope);
  const logIndex = count(e.logIndex);
  const treeSize = count(p?.treeSize);
  const root = fromB64(p?.rootHash);
  const hashes = Array.isArray(p?.hashes) ? p.hashes.map(fromB64) : null;
  if (
    logIndex === null ||
    treeSize === null ||
    !root ||
    !hashes ||
    hashes.some((h) => !h) ||
    !cp ||
    cp.size !== treeSize ||
    cp.root !== toHex(root) ||
    !verifyInclusion(logIndex, treeSize, leafHashOf(fromB64(e.canonicalizedBody)!), hashes.map((h) => toHex(h!)), toHex(root))
  )
    throw new LogError("the log's entry carries no proof of its inclusion");
  return e;
}

/** A checkpoint's lines without checking who signed it: what the server reads before keeping an entry. */
function openCheckpointUnsigned(envelope: unknown): Checkpoint | null {
  if (typeof envelope !== 'string') return null;
  const at = envelope.indexOf('\n\n');
  if (at < 0) return null;
  const [origin, sizeText, rootText] = envelope.slice(0, at).split('\n');
  const size = count(sizeText);
  const root = fromB64(rootText);
  return origin && size !== null && root && root.length === 32 ? { origin, size, root: toHex(root) } : null;
}
