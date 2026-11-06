/**
 * Checking signed minutes with nothing but the document: the same checks as `verifyMinutes` in
 * the client's signing.ts, which `crossroom verify` runs, written without Node so the browser can
 * run them (the /verify page). Minutes v1 and minutes v2 both.
 *
 * It mirrors signing.ts line for line where signing.ts decides anything: which trailer counts (the
 * last one), what must follow it (nothing), what text is signed (v1: `parley/minutes/v1`, the head
 * and the normalised body; v2: `minutesStatementV2` over the body's digest and the instance the
 * document's own sentence names), and that the key the sentence names is the key that signed.
 * A test holds the two to the same verdict on signed, pasted,
 * edited and forged documents, so a change to one fails the other's test.
 *
 * The signature check itself is handed in (`SigCheck`): WebCrypto in the browser, `node:crypto` in
 * a test. Pure: no Node import and no zod.
 */
import {
  fromB64u,
  hex,
  minutesBodyDigest,
  minutesStatementV2,
  normaliseMinutes,
  parseMinutesTrailerV2,
  type SigAlg,
  sha256,
  toWellFormedText,
  utf8,
} from './chain.js';

/** Whether `sig` is `key`'s signature over `message`, under `alg`. Never throws: anything malformed is false. */
export type SigCheck = (alg: SigAlg, key: Uint8Array, message: Uint8Array, sig: Uint8Array) => Promise<boolean>;

/** Thrown by a `SigCheck` that cannot run here at all (a browser with no Ed25519), as opposed to one that found a signature wrong. */
export class SigCheckUnavailable extends Error {}

/** What a document turned out to be. */
export type MinutesVerdict =
  | {
      /** The signature holds over the text as it is. Whether the key is a given instance's is a second question. */
      status: 'signed';
      version: 1 | 2;
      publicKey: string;
      fingerprint: string;
      /** The instance the document's own sentence names, who signed as. */
      instance: string;
      head: string;
      room?: string;
      seq?: number;
    }
  | { status: 'unsigned'; reason: string }
  | { status: 'altered'; reason: string };

const SIGNATURE_V1 = /^<!-- parley-signature v1 key=([A-Za-z0-9_-]{43}) head=([0-9a-f]{64}) sig=([A-Za-z0-9_-]{86}) -->[ \t]*$/;

const CHANGED = 'the signature does not match the text: something in it changed after it was signed';
const NOT_THE_KEY = 'the key named in the text is not the key that signed it';

/** What a person compares: sha256 of the key, its first 16 hex digits in fours (signing.ts `fingerprintOf`). */
export const fingerprintOfKey = (publicKey: string): string =>
  hex(sha256(fromB64u(publicKey)))
    .slice(0, 16)
    .replace(/(.{4})(?!$)/g, '$1 ');

type Trailer = { start: number; end: number } & (
  | { v: 1; key: string; head: string; sig: string }
  | { v: 2; t: NonNullable<ReturnType<typeof parseMinutesTrailerV2>> }
);

/** The last signature trailer in a document, of either version, with where its line starts and ends. */
function lastTrailer(text: string): Trailer | null {
  let found: Trailer | null = null;
  let at = 0;
  for (const line of text.split('\n')) {
    const end = at + line.length;
    const v1 = SIGNATURE_V1.exec(line);
    if (v1) found = { start: at, end, v: 1, key: v1[1]!, head: v1[2]!, sig: v1[3]! };
    else {
      const t = parseMinutesTrailerV2(line);
      if (t) found = { start: at, end, v: 2, t };
    }
    at = end + 1;
  }
  return found;
}

/** The instance and fingerprint the document's own paragraph names: the last such sentence, which Crossroom writes last. */
function signedBy(body: string): { instance: string; fingerprint: string } | null {
  const said = normaliseMinutes(body)
    .match(/Signed by (?:Crossroom|Parley) at (\S+), key ([0-9a-f ]{19})\./g)
    ?.at(-1)
    ?.match(/at (\S+), key ([0-9a-f ]{19})\./);
  return said ? { instance: said[1]!, fingerprint: said[2]! } : null;
}

/** A base64url text that is the one encoding of its bytes, or null (signing.ts `canonicalB64u`). */
function canonicalB64u(text: string): Uint8Array | null {
  try {
    const bytes = fromB64u(text);
    return bytesToB64u(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function bytesToB64u(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let k = 0; k < chars; k++) out += B64U[(n >> (18 - 6 * k)) & 63]!;
  }
  return out;
}

/** The bytes a statement is signed as: UTF-8, a lone surrogate as U+FFFD, which is what Node's `Buffer.from(string)` writes. */
const statementBytes = (s: string) => utf8(toWellFormedText(s));

/** Check a signed document, with nothing but the document: minutes v1, or minutes v2. */
export async function verifyMinutesDocument(doc: string, check: SigCheck): Promise<MinutesVerdict> {
  const text = doc.replace(/\r\n?/g, '\n');
  const found = lastTrailer(text);
  if (!found) return { status: 'unsigned', reason: 'there is no Crossroom signature in it' };
  if (text.slice(found.end).trim()) return { status: 'altered', reason: 'there is text after the signature, which it does not cover' };
  const body = text.slice(0, found.start);
  try {
    return found.v === 1 ? await verifyV1(body, found.key, found.head, found.sig, check) : await verifyV2(body, found.t, check);
  } catch (e) {
    // A check that could not run says nothing about the document, so it is not "altered".
    if (e instanceof SigCheckUnavailable) throw e;
    return { status: 'altered', reason: CHANGED };
  }
}

async function verifyV1(body: string, key: string, head: string, sig: string, check: SigCheck): Promise<MinutesVerdict> {
  const raw = fromB64u(key);
  const message = statementBytes(`parley/minutes/v1\n${head}\n${normaliseMinutes(body)}`);
  if (raw.length !== 32 || !(await check('ed25519', raw, message, fromB64u(sig)))) return { status: 'altered', reason: CHANGED };
  const fingerprint = fingerprintOfKey(key);
  const said = signedBy(body);
  if (!said || said.fingerprint !== fingerprint) return { status: 'altered', reason: NOT_THE_KEY };
  return { status: 'signed', version: 1, publicKey: key, fingerprint, instance: said.instance, head };
}

async function verifyV2(body: string, t: NonNullable<ReturnType<typeof parseMinutesTrailerV2>>, check: SigCheck): Promise<MinutesVerdict> {
  if (minutesBodyDigest(body) !== t.body) return { status: 'altered', reason: CHANGED };
  const said = signedBy(body);
  if (!said) return { status: 'altered', reason: 'the text does not say which instance signed it' };
  const statement = minutesStatementV2({ alg: t.alg, instance: said.instance, room: t.room, seq: t.seq, head: t.head, body: t.body });
  const raw = canonicalB64u(t.key);
  const sig = canonicalB64u(t.sig);
  const shaped = t.alg === 'ed25519' ? raw?.length === 32 : raw?.length === 65 && raw[0] === 4;
  if (!raw || !sig || sig.length !== 64 || !shaped || !(await check(t.alg, raw, statementBytes(statement), sig))) return { status: 'altered', reason: CHANGED };
  const fingerprint = fingerprintOfKey(t.key);
  if (said.fingerprint !== fingerprint) return { status: 'altered', reason: NOT_THE_KEY };
  return { status: 'signed', version: 2, publicKey: t.key, fingerprint, instance: said.instance, head: t.head, room: t.room, seq: t.seq };
}

/**
 * Whether a document's signing key is the key an instance publishes (`GET /api/signing-key`):
 * `same` when it is, `different` when the instance publishes another, `unknown` when nothing was
 * published to compare. A valid signature by a different key proves only that whoever holds that
 * key signed it.
 */
export function keyAgainstInstance(signedKey: string, published: string | null): 'same' | 'different' | 'unknown' {
  if (!published) return 'unknown';
  return published === signedKey ? 'same' : 'different';
}
