/**
 * Signed minutes: a room's minutes that anyone can check offline, long
 * after they left the room, for one thing: that nothing in them changed since this instance
 * signed them.
 *
 * Two parts.
 * - **A hash chain over the room's events.** Every event extends a head kept on the session row
 *   (the server's `appendEvent`), over the event exactly as stored: in a sealed room that is ciphertext,
 *   so the chain needs no key and the sweep extends it too. Before signing, Crossroom recomputes the
 *   chain from the stored rows. If it differs, the log was changed outside Crossroom, and the
 *   document says so rather than carrying a signature.
 * - **An Ed25519 signature** by the instance's own key over the document and that head. The key
 *   is made on first start in the data directory and published at `GET /api/signing-key`.
 *   Signatures are deterministic, so the same record always renders to the same bytes.
 *
 * What a signature proves offline: the text was not changed since the holder of that key signed
 * it. Whether the key is a given instance's is a second question: `crossroom verify --instance`
 * asks the instance, or a reader compares the fingerprint with what it publishes.
 *
 * Chain v2 and minutes v2 sit beside v1 here, and v1 stays exactly as it was: every room
 * created before chain v2 keeps chain v1 for good, and its minutes verify as they always did.
 * - **Chain v2** commits to each event behind a nonce (`@parley/shared/chain`), and the head runs
 *   over (seq, c) alone, so it is recomputed from the stored commitments with no key
 *   (`headOfCommitments`), and by any reader of an event from the event and its nonce.
 * - **Minutes v2** sign a small statement (`parley/minutes/v2`: alg, instance, room, seq, head and
 *   the digest of the document) rather than the document, so a key held in a KMS can sign it and an
 *   organisation can co-sign the head without the document. The document carries the same sentence
 *   a person reads as v1's, and a trailer a verifier reads (`<!-- parley-signature v2 … -->`).
 * - **A ledger signature** (`parley/ledger/v1`) over a v2 room's head alone, which an end-to-end
 *   room's minutes carry: the browser writes those, so the server holds no document to sign.
 * Statements are signed as their UTF-8, with Ed25519 (the instance's own key, deterministic) or
 * ECDSA P-256 over SHA-256 as r || s (a KMS's, randomised: the server caches those).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  chainNextV2,
  chainStartV2,
  fromB64u,
  isHex64,
  ledgerStatement,
  type MinutesTrailerV2,
  minutesBodyDigest,
  minutesStatementV2,
  minutesTrailerV2,
  parseMinutesTrailerV2,
  type SigAlg,
  utf8,
} from '@parley/shared/chain';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** An event row as stored: `payload` is ciphertext in a sealed room. */
export interface ChainRow {
  seq: number;
  type: string;
  actor: string;
  audience: string;
  payload: string;
  created_at: string;
  /** Chain v2's c_i (`events.commitment`): absent or null in a v1 room, whose head never reads it. */
  commitment?: string | null;
}

export const chainStart = (sessionId: string) => sha(`parley/chain/v1|${sessionId}`);

/** The head after one more event. Every field but the payload is an id, a name or a timestamp, so newlines separate them unambiguously, and the payload goes last. */
export const chainNext = (prev: string, e: ChainRow) => sha([prev, e.seq, e.type, e.actor, e.audience, e.created_at, e.payload].join('\n'));

export const chainHead = (sessionId: string, rows: ChainRow[]) => rows.reduce(chainNext, chainStart(sessionId));

/**
 * A v2 room's head over its stored commitments, `(seq, c)` from seq 1 up by one, with no key: or
 * null when a commitment is missing or is not a digest, or a seq is skipped. Nothing but the
 * commitment column is read, so the sweep and a reader holding no key both recompute it.
 */
export function headOfCommitments(room: string, rows: readonly { seq: number; commitment?: string | null }[]): string | null {
  let head = chainStartV2(room);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (Number(r.seq) !== i + 1 || !isHex64(r.commitment)) return null;
    head = chainNextV2(head, i + 1, r.commitment);
  }
  return head;
}

// ---------------------------------------------------------------- the instance key

export interface Signer {
  /** The raw 32-byte public key, base64url. */
  publicKey: string;
  /** What a person compares: sha256 of the key, its first 16 hex digits in fours. */
  fingerprint: string;
  sign(message: string): string;
}

export const fingerprintOf = (publicKey: string) =>
  createHash('sha256')
    .update(Buffer.from(publicKey, 'base64url'))
    .digest('hex')
    .slice(0, 16)
    .replace(/(.{4})(?!$)/g, '$1 ');

function signerFrom(privateKey: KeyObject): Signer {
  const publicKey = String(createPublicKey(privateKey).export({ format: 'jwk' }).x);
  return {
    publicKey,
    fingerprint: fingerprintOf(publicKey),
    sign: (message) => sign(null, Buffer.from(message), privateKey).toString('base64url'),
  };
}

/** The instance's key, from `signing-key.pem` in the data directory, made there on first start. */
export function loadSigner(dataDir: string): Signer {
  const file = path.join(dataDir, 'signing-key.pem');
  try {
    return signerFrom(createPrivateKey(readFileSync(file, 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  try {
    writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    // Another process made it first: use theirs, or two keys would sign for one instance.
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return signerFrom(createPrivateKey(readFileSync(file, 'utf8')));
    throw e;
  }
  return signerFrom(createPrivateKey(pem));
}

/** A base64url text that is the one encoding of its bytes, or null: so one key, or one signature, is written one way. */
function canonicalB64u(text: string): Uint8Array | null {
  try {
    const bytes = fromB64u(text);
    return Buffer.from(bytes).toString('base64url') === text ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Whether `sig` is `key`'s signature over a statement's UTF-8, under `alg` (`@parley/shared/chain`
 * `SigAlg`). Ed25519: the raw 32-byte key, a 64-byte signature. ECDSA P-256 over SHA-256: the
 * uncompressed point (65 bytes), the signature r || s (64 bytes, IEEE P1363), never DER. Keys and
 * signatures are base64url, each in its one canonical spelling. Anything malformed is false, never
 * a throw, since what is checked here came from a file or a record somebody else wrote.
 */
export function verifyStatement(alg: string, key: string, statement: string, sig: string): boolean {
  try {
    const raw = canonicalB64u(key);
    const signature = canonicalB64u(sig);
    if (!raw || !signature || signature.length !== 64) return false;
    const message = Buffer.from(utf8(statement));
    if (alg === 'ed25519') {
      if (raw.length !== 32) return false;
      return verify(null, message, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' }), Buffer.from(signature));
    }
    if (alg === 'ecdsa-p256-sha256') {
      if (raw.length !== 65 || raw[0] !== 4) return false;
      const x = Buffer.from(raw.subarray(1, 33)).toString('base64url');
      const y = Buffer.from(raw.subarray(33)).toString('base64url');
      const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' });
      return verify('sha256', message, { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature));
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the document

const SIGNATURE_V1 = /^<!-- parley-signature v1 key=([A-Za-z0-9_-]{43}) head=([0-9a-f]{64}) sig=([A-Za-z0-9_-]{86}) -->[ \t]*$/;

/**
 * What survives being pasted and saved: line endings become LF, trailing spaces go, and so do
 * blank lines at the end. Editors and GitHub do all three, and none of them changes what a
 * document says.
 */
const normalise = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');

const message = (head: string, body: string) => `parley/minutes/v1\n${head}\n${normalise(body)}`;

/**
 * The minutes with a signature: a paragraph a person reads, inside what is signed, and a comment
 * a verifier reads, which GitHub and Crossroom's own page do not show.
 */
export function signMinutes(md: string, o: { signer: Signer; head: string; instance: string }): string {
  const body =
    `${normalise(md)}\n\n---\n\n` +
    `Signed by Crossroom at ${o.instance}, key ${o.signer.fingerprint}. ` +
    `\`crossroom verify\` on this file checks offline that nothing in it has changed; ${o.instance}/api/signing-key publishes the key.`;
  return `${body}\n<!-- parley-signature v1 key=${o.signer.publicKey} head=${o.head} sig=${o.signer.sign(message(o.head, body))} -->\n`;
}

// ---------------------------------------------------------------- minutes v2

/** Where minutes v2 sit: the instance (its public URL), the room, and the head they were signed at. */
export interface MinutesV2Point {
  instance: string;
  room: string;
  seq: number;
  head: string;
}

/** The key that signs, as a document names it: its algorithm, its public key and its fingerprint. */
export interface MinutesV2Key {
  alg: SigAlg;
  publicKey: string;
  fingerprint: string;
}

/** Minutes v2 before their signature. */
export interface MinutesV2Draft {
  /** What a person reads, the paragraph that names the signer included: everything above the trailer. */
  body: string;
  /** `parley/minutes/v2`, over the body's digest: what is signed. */
  statement: string;
  /** The document, given the signature over `statement` (base64url): the body, then the trailer on its last line. */
  signed(sig: string): string;
}

/**
 * Minutes v2, ready to sign with any key. The paragraph keeps v1's sentence word for word, so a
 * person reads the same thing and `verifyMinutes` finds the instance the same way; what it adds
 * says which point of the record the signature covers.
 */
export function draftMinutesV2(md: string, key: MinutesV2Key, at: MinutesV2Point): MinutesV2Draft {
  const body =
    `${normalise(md)}\n\n---\n\n` +
    `Signed by Crossroom at ${at.instance}, key ${key.fingerprint}. ` +
    `\`crossroom verify\` on this file checks offline that nothing in it has changed; ${at.instance}/api/signing-key publishes the key. ` +
    `The signature covers the room's record through event ${at.seq}, which \`crossroom verify --record\` checks against the record itself.`;
  const digest = minutesBodyDigest(body);
  const statement = minutesStatementV2({ alg: key.alg, instance: at.instance, room: at.room, seq: at.seq, head: at.head, body: digest });
  return {
    body,
    statement,
    signed: (sig) => `${body}\n${minutesTrailerV2({ alg: key.alg, key: key.publicKey, room: at.room, seq: at.seq, head: at.head, body: digest, sig })}\n`,
  };
}

/** Minutes v2 signed with the instance's own key: Ed25519, so the same record always renders to the same bytes. */
export function signMinutesV2(md: string, o: MinutesV2Point & { signer: Signer }): string {
  const draft = draftMinutesV2(md, { alg: 'ed25519', publicKey: o.signer.publicKey, fingerprint: o.signer.fingerprint }, o);
  return draft.signed(o.signer.sign(draft.statement));
}

/** A statement Crossroom signed, as a record bundle carries it (`RecordSignature`, @parley/shared/chain). */
export interface SignedStatement {
  statement: string;
  alg: SigAlg;
  key: string;
  sig: string;
}

/**
 * `parley/ledger/v1` over a v2 room's head, signed with the instance's own key: what an end-to-end
 * room's minutes carry, since the browser writes those and the server has no document to sign.
 */
export function signLedger(o: MinutesV2Point & { signer: Signer }): SignedStatement {
  const statement = ledgerStatement({ alg: 'ed25519', instance: o.instance, room: o.room, seq: o.seq, head: o.head });
  return { statement, alg: 'ed25519', key: o.signer.publicKey, sig: o.signer.sign(statement) };
}

// ---------------------------------------------------------------- checking a document

export type Verdict =
  | {
      ok: true;
      publicKey: string;
      fingerprint: string;
      head: string;
      instance: string | null;
      /** Set for minutes v2 only, so a v1 verdict is exactly what it always was. */
      version?: 2;
      room?: string;
      seq?: number;
      alg?: SigAlg;
    }
  | { ok: false; reason: string };

type Trailer = { start: number; end: number } & ({ v: 1; key: string; head: string; sig: string } | { v: 2; t: MinutesTrailerV2 });

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
  const said = normalise(body).match(/Signed by (?:Crossroom|Parley) at (\S+), key ([0-9a-f ]{19})\./g)?.at(-1)?.match(/at (\S+), key ([0-9a-f ]{19})\./);
  return said ? { instance: said[1]!, fingerprint: said[2]! } : null;
}

const CHANGED = 'the signature does not match the text: something in it changed after it was signed';
const NOT_THE_KEY = 'the key named in the text is not the key that signed it';

/** Check a signed document, with nothing but the document: minutes v1, or minutes v2. */
export function verifyMinutes(doc: string): Verdict {
  const text = doc.replace(/\r\n?/g, '\n');
  const found = lastTrailer(text);
  if (!found) return { ok: false, reason: 'there is no Crossroom signature in it' };
  if (text.slice(found.end).trim()) return { ok: false, reason: 'there is text after the signature, which it does not cover' };
  const body = text.slice(0, found.start);
  return found.v === 1 ? verifyV1(body, found.key, found.head, found.sig) : verifyV2(body, found.t);
}

function verifyV1(body: string, key: string, head: string, sig: string): Verdict {
  let good = false;
  try {
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' });
    good = verify(null, Buffer.from(message(head, body)), pub, Buffer.from(sig, 'base64url'));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: CHANGED };
  const fingerprint = fingerprintOf(key);
  const said = signedBy(body);
  if (!said || said.fingerprint !== fingerprint) return { ok: false, reason: NOT_THE_KEY };
  return { ok: true, publicKey: key, fingerprint, head, instance: said.instance };
}

/**
 * The statement signed minutes v2 carry, with its signature: or null for a document that is not
 * minutes v2 or does not verify on its own.
 */
export function minutesV2Signature(doc: string): SignedStatement | null {
  const text = doc.replace(/\r\n?/g, '\n');
  const found = lastTrailer(text);
  if (found?.v !== 2) return null;
  const v = verifyMinutes(doc);
  if (!v.ok || v.version !== 2 || !v.instance) return null;
  const t = found.t;
  return {
    statement: minutesStatementV2({ alg: t.alg, instance: v.instance, room: t.room, seq: t.seq, head: t.head, body: t.body }),
    alg: t.alg,
    key: t.key,
    sig: t.sig,
  };
}

/**
 * Minutes v2: the body must hash to the trailer's `body=`, and the signature hold over the statement
 * rebuilt from the trailer and the instance the paragraph names. The statement binds the instance,
 * so a paragraph that names another instance than the one that signed fails as a changed text.
 */
function verifyV2(body: string, t: MinutesTrailerV2): Verdict {
  try {
    if (minutesBodyDigest(body) !== t.body) return { ok: false, reason: CHANGED };
    const said = signedBy(body);
    if (!said) return { ok: false, reason: 'the text does not say which instance signed it' };
    const statement = minutesStatementV2({ alg: t.alg, instance: said.instance, room: t.room, seq: t.seq, head: t.head, body: t.body });
    if (!verifyStatement(t.alg, t.key, statement, t.sig)) return { ok: false, reason: CHANGED };
    const fingerprint = fingerprintOf(t.key);
    if (said.fingerprint !== fingerprint) return { ok: false, reason: NOT_THE_KEY };
    return { ok: true, publicKey: t.key, fingerprint, head: t.head, instance: said.instance, version: 2, room: t.room, seq: t.seq, alg: t.alg };
  } catch {
    return { ok: false, reason: CHANGED };
  }
}
