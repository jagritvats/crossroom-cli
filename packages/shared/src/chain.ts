/**
 * The room's record, version 2: the bytes every implementation hashes and signs,
 * so the server, the browser, a runner, `crossroom verify` and the SDKs agree on them byte for byte.
 *
 * - **JCS** (RFC 8785): `canonicalize`. Keys sorted by UTF-16 code unit, no whitespace, numbers
 *   and strings as ECMAScript's JSON.stringify writes them. A string that is not well-formed UTF-16
 *   (a lone surrogate) is refused rather than guessed at. Participant text can hold one (JSON's
 *   `\ud800` is valid), so what is hashed is made well-formed here, where JS and Python agree on
 *   it: `eventEnvelopeV2` and `writeArgs` replace every lone surrogate in a payload with U+FFFD, as
 *   `String.prototype.toWellFormed` does, and `minutesBodyDigest` hashes the document as a UTF-8
 *   encoder writes it, which is the same thing.
 * - **SHA-256** (FIPS 180-4), in plain JavaScript, synchronous everywhere: `appendEvent` runs inside
 *   a node:sqlite transaction, and a browser verifying a partial view has no synchronous WebCrypto.
 * - **Chain v2**: an event's commitment c_i hides it behind a nonce n_i kept inside the sealed
 *   payload, and the head is a linear chain over (seq, c). Every existing room stays on chain v1
 *   (signing.ts) for good, and v1 verification stays forever.
 * - **Statements**: the small texts that are signed (minutes v2, a co-signature, a receipt, a write,
 *   an attestation, an anchoring batch and its leaves, a licence), each built here and nowhere else.
 * - **The record bundle** (`GET …/record`) and what verifying one answers, as types.
 *
 * Pure: no Node import and no zod, so the web app may import values from here. `spec/vectors/`
 * holds the vectors these functions reproduce (generated once by `spec/vectors/generate.mts`, and
 * checked by the server's tests); a change that moves one byte of any of them is a
 * new version, never an edit.
 */

// ---------------------------------------------------------------- bytes

/** Thrown for a value that has no canonical form, or a field that cannot go into a statement. */
export class NotCanonical extends Error {}

/** Whether a string is well-formed UTF-16: every surrogate paired. */
export function isWellFormedText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * A string with every lone surrogate replaced by U+FFFD and nothing else changed, as
 * `String.prototype.toWellFormed` (ES2024, which the web's lib predates) returns it.
 */
export function toWellFormedText(s: string): string {
  if (isWellFormedText(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s.slice(i, i + 2);
        i++;
      } else out += REPLACEMENT;
    } else out += c >= 0xdc00 && c <= 0xdfff ? REPLACEMENT : s[i]!;
  }
  return out;
}

/** A value fresh from JSON.parse with every string in it made well-formed, in place. Keys are Crossroom's own, and stay as they are. */
function wellFormedInPlace(v: unknown): unknown {
  if (typeof v === 'string') return toWellFormedText(v);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // An own `__proto__` (JSON.parse makes one) is an ordinary property here, so assigning to it is too.
    for (const k of Object.keys(o)) o[k] = wellFormedInPlace(o[k]);
  }
  return v;
}

/** P, as E_i and a write's args hold a payload: JSON.parse(JSON.stringify(payload)), every string in it well-formed. */
export const envelopePayload = (payload: unknown): unknown => wellFormedInPlace(JSON.parse(JSON.stringify(payload ?? {})));

const encoder = new TextEncoder();

/** UTF-8 of a well-formed string. A lone surrogate would encode as U+FFFD, so it is refused instead. */
export function utf8(s: string): Uint8Array {
  if (!isWellFormedText(s)) throw new NotCanonical('a string with a lone surrogate has no UTF-8 form; pass it through toWellFormed() first');
  return encoder.encode(s);
}

const HEX_DIGITS = '0123456789abcdef';

/** Lowercase hex. */
export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX_DIGITS[b >> 4]! + HEX_DIGITS[b & 15]!;
  return out;
}

/** The bytes of lowercase or uppercase hex of even length. */
export function fromHex(text: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(text)) throw new NotCanonical('not hex');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding (RFC 4648 §5). */
export function b64u(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let k = 0; k < chars; k++) out += B64U[(n >> (18 - 6 * k)) & 63]!;
  }
  return out;
}

/** The bytes of base64url without padding; anything else is refused. */
export function fromB64u(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new NotCanonical('not base64url');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const quad = text.slice(i, i + 4);
    let n = 0;
    for (let k = 0; k < 4; k++) n = (n << 6) | (k < quad.length ? B64U.indexOf(quad[k]!) : 0);
    const bytes = quad.length - 1;
    for (let k = 0; k < bytes; k++) out[o++] = (n >> (16 - 8 * k)) & 255;
  }
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// ---------------------------------------------------------------- SHA-256 (FIPS 180-4)

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 of some bytes. */
export function sha256(data: Uint8Array): Uint8Array {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = data.length;
  const blocks = Math.ceil((len + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(data);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  // The message's length in bits, as a 64-bit big-endian integer.
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  const W = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(off + 4 * t);
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15]!;
      const w2 = W[t - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) | 0;
    }
    let a = H[0]!;
    let b = H[1]!;
    let c = H[2]!;
    let d = H[3]!;
    let e = H[4]!;
    let f = H[5]!;
    let g = H[6]!;
    let h = H[7]!;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t]! + W[t]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H[0] = (H[0]! + a) | 0;
    H[1] = (H[1]! + b) | 0;
    H[2] = (H[2]! + c) | 0;
    H[3] = (H[3]! + d) | 0;
    H[4] = (H[4]! + e) | 0;
    H[5] = (H[5]! + f) | 0;
    H[6] = (H[6]! + g) | 0;
    H[7] = (H[7]! + h) | 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(4 * i, H[i]!);
  return out;
}

/** Lowercase hex SHA-256 of a string's UTF-8, or of bytes. */
export const sha256Hex = (data: string | Uint8Array): string => hex(sha256(typeof data === 'string' ? utf8(data) : data));

// ---------------------------------------------------------------- JCS (RFC 8785)

const jsonString = (s: string): string => {
  if (!isWellFormedText(s)) throw new NotCanonical('a string with a lone surrogate has no canonical form; pass it through toWellFormed() first');
  // ECMAScript's own escaping is RFC 8785's: \" \\ \b \f \n \r \t, other C0 controls as lowercase
  // \u00xx, and everything else (U+2028 and U+2029 included) as itself.
  return JSON.stringify(s);
};

/**
 * The canonical JSON of a value (RFC 8785). JSON values only: null, booleans, finite numbers,
 * well-formed strings, arrays and plain objects. An object member whose value is `undefined` is
 * left out, as JSON.stringify leaves it out; anything else with no JSON form is refused (`NaN`, an
 * infinity, a bigint, a function, an `undefined` or a hole in an array, a Date or any other class).
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new NotCanonical(`${value} has no JSON form`);
      // ECMAScript's Number serialisation is RFC 8785's, and it writes -0 as 0.
      return JSON.stringify(value);
    case 'string':
      return jsonString(value);
    case 'object': {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!(i in value) || value[i] === undefined) throw new NotCanonical('an array with a hole or an undefined in it has no canonical form');
          items.push(canonicalize(value[i]));
        }
        return `[${items.join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new NotCanonical('only plain objects have a canonical form');
      const obj = value as Record<string, unknown>;
      // Default sort: by UTF-16 code unit, which is RFC 8785's order.
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${jsonString(k)}:${canonicalize(obj[k])}`).join(',')}}`;
    }
    default:
      throw new NotCanonical(`a ${typeof value} has no JSON form`);
  }
}

/** UTF-8 of the canonical JSON: what is hashed. */
export const canonicalBytes = (value: unknown): Uint8Array => utf8(canonicalize(value));

// ---------------------------------------------------------------- chain v2

/** `sessions.chain_version`: every room that existed before chain v2 is 1, for good. */
export type ChainVersion = 1 | 2;

export const COMMIT_DOMAIN = 'parley/commit/v2';
export const CHAIN_DOMAIN = 'parley/chain/v2';
/** n_i: 16 random bytes, base64url, 22 characters, made in `appendEvent`. */
export const NONCE_BYTES = 16;
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const isNonce = (n: unknown): n is string => typeof n === 'string' && NONCE_PATTERN.test(n);
/** A SHA-256 as these functions write one: 64 lowercase hex digits. */
export const HEX64 = /^[0-9a-f]{64}$/;
export const isHex64 = (h: unknown): h is string => typeof h === 'string' && HEX64.test(h);

export type SigAlg = 'ed25519' | 'ecdsa-p256-sha256';
export const SIG_ALGS: readonly SigAlg[] = ['ed25519', 'ecdsa-p256-sha256'];

/**
 * The operations a seat's runner signs in a room across a connection, each with the
 * event type it writes and the payload fields the relay assigns. A write's signature covers the
 * rest: the event's audience (the recipient) and every other field of its payload, as stored. So
 * the relay can neither change what the writer chose nor add a field to it without the signature
 * failing, and anyone who sees the event rebuilds the statement from it (`writeStatementFor`).
 *
 * - The writer signs the stored form: `say`'s `reply_to: 1` is `replyTo: "1"`, an absent `why` is
 *   `null`, a recipient is the participant id the relay resolves it to (or `all`).
 *   The runner's proxy sends every signed field explicitly, and the relay refuses a signed write
 *   whose signature does not verify over the event it would store.
 * - `claim` writes two events and is signed on the second, its `position_updated` (whose
 *   `claimText` is the claim); the `claim_created` before it is checked against that one, as is a
 *   `claim_updated`, which Crossroom derives from a position.
 * - `join` is not signed: what it declares (a name, a model, offers) is the seat's description,
 *   which the relay may suffix or refuse.
 */
export const WRITE_OPS = {
  say: { type: 'message', assigned: ['messageId', 'messageSeq', 'authorName', 'briefSet', 'title'] },
  request_context: { type: 'context_requested', assigned: ['requestId'] },
  decline_context: { type: 'context_requested', assigned: ['to', 'what', 'tool', 'args'] },
  share_context: { type: 'context_shared', assigned: ['itemId', 'label', 'bytes', 'check'] },
  claim: { type: 'position_updated', assigned: ['claimId', 'label', 'previousStance', 'changed', 'claimStatus'] },
  position: { type: 'position_updated', assigned: ['claimId', 'claimText', 'previousStance', 'changed', 'claimStatus'] },
  finish: { type: 'participant_finished', assigned: ['name'] },
} as const satisfies Record<string, { type: string; assigned: readonly string[] }>;
export type WriteOp = keyof typeof WRITE_OPS;
export const isWriteOp = (op: unknown): op is WriteOp => typeof op === 'string' && Object.hasOwn(WRITE_OPS, op);

/**
 * A write's signature, stored as `sig` inside E_i (rooms across a connection): the guest
 * runner's proxy signs `writeStatement` before the call and reads its own event back to check it.
 * `op` is the operation signed (`WRITE_OPS`), `key` the public key (base64url: Ed25519's raw 32
 * bytes, P-256's uncompressed point), `cn` the write's nonce (no two of one seat's writes share
 * one), `at` the writer's clock, `sig` the signature (base64url; ECDSA as r || s, 64 bytes, never
 * DER).
 */
export interface WriteSignature {
  v: 1;
  alg: SigAlg;
  op: WriteOp;
  key: string;
  cn: string;
  at: string;
  sig: string;
}

/**
 * E_i, what an event's commitment is over. `payload` is P = JSON.parse(JSON.stringify(
 * payload)): in an end-to-end room it holds the envelopes, as stored. `sig` only on a signed write.
 */
export interface EventEnvelopeV2 {
  v: 2;
  room: string;
  seq: number;
  type: string;
  actor: string;
  audience: string;
  /** `events.created_at`, as stored. */
  at: string;
  payload: unknown;
  sig?: WriteSignature;
}

const positiveSeq = (seq: number, what = 'seq') => {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new NotCanonical(`${what} is a whole number from 1`);
  return seq;
};

/** E_i from an event's columns and its payload as given. */
export function eventEnvelopeV2(e: {
  room: string;
  seq: number;
  type: string;
  actor: string;
  audience: string;
  at: string;
  payload: unknown;
  sig?: WriteSignature | null;
}): EventEnvelopeV2 {
  const env: EventEnvelopeV2 = {
    v: 2,
    room: e.room,
    seq: positiveSeq(e.seq),
    type: e.type,
    actor: e.actor,
    audience: e.audience,
    at: e.at,
    payload: envelopePayload(e.payload),
  };
  if (e.sig) env.sig = e.sig;
  return env;
}

/** c_i = hex SHA-256("parley/commit/v2\n" || n_i || "\n" || JCS(E_i)). */
export function commitmentOf(nonce: string, envelope: EventEnvelopeV2): string {
  if (!isNonce(nonce)) throw new NotCanonical('a nonce is 22 characters of base64url (16 bytes)');
  return sha256Hex(`${COMMIT_DOMAIN}\n${nonce}\n${canonicalize(envelope)}`);
}

/** h_0 = hex SHA-256("parley/chain/v2|" || room). */
export const chainStartV2 = (room: string): string => sha256Hex(`${CHAIN_DOMAIN}|${room}`);

/** h_i = hex SHA-256("parley/chain/v2\n" || h_{i-1} || "\n" || seq_i || "\n" || c_i). */
export function chainNextV2(prev: string, seq: number, commitment: string): string {
  if (!isHex64(prev) || !isHex64(commitment)) throw new NotCanonical('a head and a commitment are each 64 lowercase hex digits');
  return sha256Hex(`${CHAIN_DOMAIN}\n${prev}\n${positiveSeq(seq)}\n${commitment}`);
}

/** One event's place in the chain, as the record bundle lists them all. */
export type CommitmentEntry = readonly [seq: number, commitment: string];

/**
 * The head over a room's whole list of (seq, c), which a party that sees only some events fetches
 * whole (at most about 130 kB). The list starts at seq 1 and goes up by one: a gap is an event
 * left out, and refused.
 */
export function chainHeadV2(room: string, commitments: readonly CommitmentEntry[]): string {
  let head = chainStartV2(room);
  commitments.forEach(([seq, c], i) => {
    if (seq !== i + 1) throw new NotCanonical(`the commitments skip from seq ${i} to ${seq}`);
    head = chainNextV2(head, seq, c);
  });
  return head;
}

/** What `events.payload` holds in a v2 room before it is sealed: the payload with its nonce, and a signed write's signature. */
export interface StoredPayloadV2 {
  v: 2;
  n: string;
  p: Record<string, unknown>;
  /** A signed write's signature: `sig` in E_i, so the commitment recomputes from the row. */
  s?: WriteSignature;
}

/** `{"v":2,"n":…,"p":…}` (and `"s":…` for a signed write), the text `appendEvent` seals in a v2 room (and writes plain for the sweep's `session_ended`). */
export function wrapPayloadV2(nonce: string, payload: Record<string, unknown>, sig?: WriteSignature | null): string {
  if (!isNonce(nonce)) throw new NotCanonical('a nonce is 22 characters of base64url (16 bytes)');
  return JSON.stringify((sig ? { v: 2, n: nonce, p: payload, s: sig } : { v: 2, n: nonce, p: payload }) satisfies StoredPayloadV2);
}

/** The nonce, payload and any write signature of a v2 room's stored payload, once opened; null for anything else (a v1 payload). */
export function unwrapPayloadV2(text: string): { nonce: string; payload: Record<string, unknown>; sig?: WriteSignature } | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const w = o as Partial<StoredPayloadV2>;
  const signed = w.s !== undefined;
  if (w.v !== 2 || !isNonce(w.n) || !w.p || typeof w.p !== 'object' || Array.isArray(w.p) || Object.keys(w).length !== (signed ? 4 : 3)) return null;
  if (signed && (!w.s || typeof w.s !== 'object' || Array.isArray(w.s))) return null;
  return signed ? { nonce: w.n, payload: w.p, sig: w.s } : { nonce: w.n, payload: w.p };
}

// ---------------------------------------------------------------- statements

/**
 * The first line of each signed statement.
 *
 * `relay=` in every statement, like minutes v2's `instance=`, is the relay's public URL exactly as
 * its record bundles carry it in `relay`: `PARLEY_PUBLIC_URL` without a trailing slash
 * (the server's `publicUrl`), such as `https://parley.example` or `https://parley.acme.internal:8443`. A
 * signer takes it from there, and a verifier copies the bundle's: neither derives a host or an
 * origin from it, since two implementations that derive one disagree about ports, case and
 * internationalised names, and every signature then verifies in one and fails in the other.
 */
export const STATEMENT = {
  minutesV2: 'parley/minutes/v2',
  ledger: 'parley/ledger/v1',
  cosign: 'parley/cosign/v1',
  receipt: 'parley/receipt/v1',
  write: 'parley/write/v1',
  attest: 'parley/attest/v1',
  anchor: 'parley/anchor/v1',
  anchorLeaf: 'parley/anchor-leaf/v1',
  licence: 'parley/licence/v1',
} as const;

/**
 * A value as it goes after `key=` in a statement: a whole number from 0, or text with no control
 * character (C0, DEL, C1) and no line or paragraph separator, so no value can begin a line of its
 * own. Text a participant or a runner chose (a repository's label) goes through `inline` first.
 */
export function statementValue(v: string | number): string {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new NotCanonical('a number in a statement is a whole number from 0');
    return String(v);
  }
  if (!isWellFormedText(v)) throw new NotCanonical('a statement value is well-formed text');
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029)
      throw new NotCanonical('a statement value holds no control character or line break');
  }
  return v;
}

const statement = (first: string, fields: readonly (readonly [string, string | number])[]) =>
  [first, ...fields.map(([k, v]) => `${k}=${statementValue(v)}`)].join('\n');

/**
 * What survives being pasted and saved: line endings become LF, trailing spaces and tabs go, and so
 * do blank lines at the end. The same as minutes v1's (signing.ts `normalise`), byte for byte.
 */
export const normaliseMinutes = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');

/**
 * `body=` of minutes v2: SHA-256 of the normalised document above its trailer, as UTF-8. Minutes
 * quote participants, so a lone surrogate may be in the text; it is hashed as U+FFFD, which is what
 * a UTF-8 encoder sends for it, so the digest is of the bytes the reader holds.
 */
export const minutesBodyDigest = (body: string): string => sha256Hex(toWellFormedText(normaliseMinutes(body)));

export interface MinutesV2Fields {
  alg: SigAlg;
  /** The instance's public URL, `PARLEY_PUBLIC_URL`. */
  instance: string;
  room: string;
  seq: number;
  head: string;
  /** `minutesBodyDigest` of the document. */
  body: string;
}

/** `parley/minutes/v2\nalg=…\ninstance=…\nroom=…\nchain=v2\nseq=…\nhead=…\nbody=…`, no newline after. */
export const minutesStatementV2 = (f: MinutesV2Fields): string =>
  statement(STATEMENT.minutesV2, [
    ['alg', f.alg],
    ['instance', f.instance],
    ['room', f.room],
    ['chain', 'v2'],
    ['seq', f.seq],
    ['head', f.head],
    ['body', f.body],
  ]);

export interface LedgerFields {
  alg: SigAlg;
  /** The instance's public URL, as minutes v2's `instance=`. */
  instance: string;
  room: string;
  seq: number;
  head: string;
}

/**
 * `parley/ledger/v1\nalg=…\ninstance=…\nroom=…\nchain=v2\nseq=…\nhead=…`, no newline after: the
 * instance's signature over a v2 room's head alone, which an end-to-end room's minutes carry.
 * The browser renders those minutes, so the server holds no document to sign. It is a
 * statement of its own, never minutes v2 with a stand-in `body=`: that would read as the room's
 * signed minutes for any document that hashed to the stand-in (an empty file, for `sha256('')`).
 */
export const ledgerStatement = (f: LedgerFields): string =>
  statement(STATEMENT.ledger, [
    ['alg', f.alg],
    ['instance', f.instance],
    ['room', f.room],
    ['chain', 'v2'],
    ['seq', f.seq],
    ['head', f.head],
  ]);

export interface MinutesTrailerV2 {
  alg: SigAlg;
  /** The signer's public key, base64url. */
  key: string;
  room: string;
  seq: number;
  head: string;
  body: string;
  sig: string;
}

/** `<!-- parley-signature v2 alg=… key=… room=… seq=… head=… body=… sig=… -->`, the last line of signed minutes v2. */
export const minutesTrailerV2 = (t: MinutesTrailerV2): string =>
  `<!-- parley-signature v2 alg=${statementValue(t.alg)} key=${statementValue(t.key)} room=${statementValue(t.room)} seq=${statementValue(t.seq)} head=${statementValue(t.head)} body=${statementValue(t.body)} sig=${statementValue(t.sig)} -->`;

const TRAILER_V2 =
  /^<!-- parley-signature v2 alg=(ed25519|ecdsa-p256-sha256) key=([A-Za-z0-9_-]{43,90}) room=([A-Za-z0-9_-]{1,128}) seq=([1-9][0-9]{0,15}) head=([0-9a-f]{64}) body=([0-9a-f]{64}) sig=([A-Za-z0-9_-]{86}) -->[ \t]*$/;

/** A minutes v2 trailer read back, or null for a line that is not one. */
export function parseMinutesTrailerV2(line: string): MinutesTrailerV2 | null {
  const m = TRAILER_V2.exec(line);
  if (!m) return null;
  return { alg: m[1] as SigAlg, key: m[2]!, room: m[3]!, seq: Number(m[4]), head: m[5]!, body: m[6]!, sig: m[7]! };
}

export interface CosignFields {
  /** The relay's public URL, as its record bundles carry it (see `STATEMENT`). */
  relay: string;
  room: string;
  seq: number;
  head: string;
  role: 'host' | 'guest';
}

/** `parley/cosign/v1\nrelay=…\nroom=…\nseq=…\nhead=…\nrole=host|guest`. A co-sign signs the head, never the document. */
export const cosignStatement = (f: CosignFields): string =>
  statement(STATEMENT.cosign, [
    ['relay', f.relay],
    ['room', f.room],
    ['seq', f.seq],
    ['head', f.head],
    ['role', f.role],
  ]);

export interface CosignTrailer {
  alg: SigAlg;
  key: string;
  /** `org:<id>` or `org:<domain>`. */
  by: string;
  role: 'host' | 'guest';
  seq: number;
  head: string;
  sig: string;
}

/** `<!-- parley-cosign v1 alg=… key=… by=… role=… seq=… head=… sig=… -->`. */
export const cosignTrailer = (t: CosignTrailer): string =>
  `<!-- parley-cosign v1 alg=${statementValue(t.alg)} key=${statementValue(t.key)} by=${statementValue(t.by)} role=${statementValue(t.role)} seq=${statementValue(t.seq)} head=${statementValue(t.head)} sig=${statementValue(t.sig)} -->`;

/**
 * `seen=` of a receipt: SHA-256 of JCS(the seqs the seat was delivered), which go up strictly
 * (each once, in order), so every implementation lists them alike.
 */
export function seenDigest(seqs: readonly number[]): string {
  seqs.forEach((s, i) => {
    positiveSeq(s);
    if (i && s <= seqs[i - 1]!) throw new NotCanonical('the seqs a receipt covers go up strictly');
  });
  return sha256Hex(canonicalize([...seqs]));
}

export interface ReceiptFields {
  relay: string;
  room: string;
  /** The seat's participant id. */
  seat: string;
  through: number;
  head: string;
  seen: string;
  at: string;
}

/** `parley/receipt/v1\nrelay=…\nroom=…\nseat=…\nthrough=…\nhead=…\nseen=…\nat=…`. */
export const receiptStatement = (f: ReceiptFields): string =>
  statement(STATEMENT.receipt, [
    ['relay', f.relay],
    ['room', f.room],
    ['seat', f.seat],
    ['through', f.through],
    ['head', f.head],
    ['seen', f.seen],
    ['at', f.at],
  ]);

/** `args=` of a write: SHA-256 of JCS(the fields of the operation that are signed, `writeArgs`). */
export const writeArgsDigest = (fields: object): string => sha256Hex(canonicalize(fields));

/** What a write's signature covers of an event: `{audience, payload}`, the payload as E_i holds it less the fields the relay assigns. */
export interface WriteArgs {
  audience: string;
  payload: Record<string, unknown>;
}

/**
 * The signed fields of the event a write stored (or, for the writer, of the event it is about to
 * write: the fields the relay assigns may be absent). Refuses an operation that is not a signed
 * write, and an event of another type than the operation writes.
 */
export function writeArgs(op: string, e: { type: string; audience: string; payload: unknown }): WriteArgs {
  if (!isWriteOp(op)) throw new NotCanonical(`${op} is not a signed write`);
  const w = WRITE_OPS[op];
  if (e.type !== w.type) throw new NotCanonical(`${op} writes a ${w.type} event, not a ${e.type}`);
  const p = envelopePayload(e.payload);
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new NotCanonical('a payload is an object');
  const payload = p as Record<string, unknown>;
  for (const k of w.assigned) delete payload[k];
  return { audience: e.audience, payload };
}

/**
 * The statement a write's signature is over, rebuilt from the event as a record bundle carries
 * it, with the bundle's `relay` and `room`: the seat is the event's actor, and `op`, `cn` and `at`
 * come from its signature. A verifier checks the signature over this with `sig.key`, that the key
 * is the seat's, and that no two writes of the seat share a `cn`.
 */
export function writeStatementFor(
  relay: string,
  room: string,
  e: { type: string; actor: string; audience: string; payload: unknown; sig?: WriteSignature | null },
): string {
  if (!e.sig) throw new NotCanonical('the event carries no write signature');
  return writeStatement({ relay, room, seat: e.actor, op: e.sig.op, args: writeArgsDigest(writeArgs(e.sig.op, e)), cn: e.sig.cn, at: e.sig.at });
}

export interface WriteFields {
  relay: string;
  room: string;
  seat: string;
  op: string;
  args: string;
  cn: string;
  at: string;
}

/** `parley/write/v1\nrelay=…\nroom=…\nseat=…\nop=…\nargs=…\ncn=…\nat=…`. */
export const writeStatement = (f: WriteFields): string =>
  statement(STATEMENT.write, [
    ['relay', f.relay],
    ['room', f.room],
    ['seat', f.seat],
    ['op', f.op],
    ['args', f.args],
    ['cn', f.cn],
    ['at', f.at],
  ]);

/** What a source check at HEAD found, as an attestation says it (`FactSource['check']`'s words). */
export type AttestStatus = 'checked' | 'differs' | 'not_found' | 'unchecked';

export interface AttestFields {
  relay: string;
  room: string;
  seq: number;
  /** c_seq, the packet's own commitment. */
  commit: string;
  /** The repository's label on the runner, through `inline`. */
  repo: string;
  /** The commit the check read. */
  rev: string;
  /** SHA-256 of the path. */
  path: string;
  /** The file's git blob id. */
  blob: string;
  /** `a-b`, the lines the excerpt claims. */
  lines: string;
  /** SHA-256 of the excerpt. */
  excerpt: string;
  found: number;
  of: number;
  status: AttestStatus;
}

/** `parley/attest/v1\nrelay=…\nroom=…\nseq=…\ncommit=…\nrepo=…\nrev=…\npath=…\nblob=…\nlines=…\nexcerpt=…\nfound=…\nof=…\nstatus=…`. */
export const attestStatement = (f: AttestFields): string =>
  statement(STATEMENT.attest, [
    ['relay', f.relay],
    ['room', f.room],
    ['seq', f.seq],
    ['commit', f.commit],
    ['repo', f.repo],
    ['rev', f.rev],
    ['path', f.path],
    ['blob', f.blob],
    ['lines', f.lines],
    ['excerpt', f.excerpt],
    ['found', f.found],
    ['of', f.of],
    ['status', f.status],
  ]);

export interface AnchorLeafFields {
  /** The relay's public URL. */
  relay: string;
  room: string;
  seq: number;
  head: string;
}

/**
 * A leaf of an hourly batch's RFC 6962 tree, hex:
 * SHA-256(0x00 || "parley/anchor-leaf/v1\n" || relay || "\n" || room || "\n" || seq || "\n" || head).
 * The 0x00 is RFC 6962's leaf prefix; interior nodes are SHA-256(0x01 || left || right).
 */
export function anchorLeaf(f: AnchorLeafFields): string {
  const text = [STATEMENT.anchorLeaf, statementValue(f.relay), statementValue(f.room), statementValue(positiveSeq(f.seq)), statementValue(f.head)].join('\n');
  return hex(sha256(concat(new Uint8Array([0]), utf8(text))));
}

export interface AnchorFields {
  relay: string;
  /** The batch's hour, ISO 8601. */
  window: string;
  /** The tree's root, hex. */
  root: string;
}

/** `parley/anchor/v1\nrelay=…\nwindow=…\nroot=…\n`: signed with the separate P-256 anchoring key, and ends in a newline. */
export const anchorStatement = (f: AnchorFields): string =>
  `${statement(STATEMENT.anchor, [
    ['relay', f.relay],
    ['window', f.window],
    ['root', f.root],
  ])}\n`;

/**
 * A licence: `{v, licensee, relay, features, seats, issued_at, not_before, not_after,
 * kid}`, and the signature beside them in the document (`sig`, base64url Ed25519).
 */
export interface LicenceFields {
  v: 1;
  licensee: string;
  /** The relay it is for, its public URL. */
  relay: string;
  features: string[];
  seats: number;
  issued_at: string;
  not_before: string;
  not_after: string;
  /** Which of the embedded public keys signed it. */
  kid: string;
}
export type LicenceDocument = LicenceFields & { sig: string };

/** `parley/licence/v1\n` + JCS(the licence without its signature). */
export function licenceStatement(licence: LicenceFields | LicenceDocument): string {
  const { sig: _sig, ...fields } = licence as LicenceDocument;
  return `${STATEMENT.licence}\n${canonicalize(fields)}`;
}

// ---------------------------------------------------------------- the record bundle

/**
 * The record bundle's format (`GET /api/sessions/:id/record`, `/api/seat/record`,
 * `/api/shared/record`). Named `parley-record/v2`, it would read as the next version of the
 * project record's signed export (`RECORD_EXPORT_FORMAT`, `parley-record/v1`, @parley/shared/record):
 * a different document. So the room's record is `parley-room-record/v2`, after the chain it carries.
 */
export const ROOM_RECORD_FORMAT = 'parley-room-record/v2';

/** Who a bundle was cut for: the owner sees every event, a seat what it may see, a share the public view. */
export type RecordView = 'owner' | 'seat' | 'shared';

/**
 * One event as a bundle carries it: what its commitment is over, and its nonce. A bundle carries an
 * event only when its view shows the whole of it (for a seat or a share, when `publicEvent` leaves
 * it unchanged); an event the view shows redacted, or not at all, is in `commitments` alone, since
 * a nonce beside a partial payload lets its reader test guesses at the rest against c_i.
 */
export type RecordEvent = Omit<EventEnvelopeV2, 'v' | 'room'> & { nonce: string };

export interface RecordSignature {
  /**
   * The statement signed, whole (`minutesStatementV2`'s, or `ledgerStatement`'s over the head). A
   * bundle carries minutes v2 signatures only over minutes rendered for its own view or a narrower
   * one, never the owner's for a seat or a share: `body=` digests the whole document, and from a
   * narrower view the lines only the owner sees could be guessed and tested against it.
   */
  statement: string;
  alg: SigAlg;
  key: string;
  sig: string;
}

export interface RecordReceipt {
  seat: string;
  through: number;
  head: string;
  seen: string;
  at: string;
  alg: SigAlg;
  key: string;
  sig: string;
}

export interface RecordAttestation {
  seq: number;
  /** The statement, opened for whoever may read the packet it is about. */
  statement: string;
  status: AttestStatus;
  alg: SigAlg;
  key: string;
  sig: string;
}

export interface RecordCosignature {
  by: string;
  role: 'host' | 'guest';
  seq: number;
  head: string;
  alg: SigAlg;
  key: string;
  sig: string;
  /** How the organisation's key is vouched for: by the relay on first use (weak), or by its domain's `/.well-known/parley-keys.json`. */
  certified: 'relay-tofu' | 'domain' | null;
}

export interface RecordAnchor {
  seq: number;
  head: string;
  /** `rekor` or `local`. */
  log: string;
  window: string;
  root: string;
  leafIndex: number;
  /** How many heads its batch has: the tree size `proof` is an audit path in. Not signed: a path that reaches `root` proves membership whatever size it claims. */
  size: number;
  /** The RFC 6962 audit path from the leaf to the root, hex, leaf side first. */
  proof: string[];
  /** The log's entry and the TSA's timestamp, as they were returned; null while anchoring is pending. */
  entry: unknown;
  tsa: string | null;
}

export interface RoomRecordBundle {
  format: typeof ROOM_RECORD_FORMAT;
  /** The relay's public URL. */
  relay: string;
  room: string;
  view: RecordView;
  /** Every event's (seq, c), the ones this view does not show included. */
  commitments: CommitmentEntry[];
  head: { seq: number; head: string };
  /** The events this view shows whole, each with its nonce (see `RecordEvent`). */
  events: RecordEvent[];
  signatures: RecordSignature[];
  receipts: RecordReceipt[];
  attestations: RecordAttestation[];
  cosignatures: RecordCosignature[];
  anchors: RecordAnchor[];
}

/** `crossroom verify minutes.md [--record r.json] [--instance url] [--org acme.com] [--trusted-root file]`. */
export interface VerifyRecordOptions {
  /** Ask this instance for its key (`GET /api/signing-key`) and compare. */
  instance?: string;
  /** Check co-signatures against `https://<domain>/.well-known/parley-keys.json`. */
  org?: string;
  /** The log and TSA roots an anchor's proof and timestamp must chain to. */
  trustedRoot?: unknown;
}

/** One check a verifier made, with its result: what `crossroom verify --record` prints, line by line. */
export interface RecordCheck {
  /** `write`: a signed write's signature, rebuilt from its event (`writeStatementFor`). */
  what: 'chain' | 'inclusion' | 'minutes' | 'receipt' | 'write' | 'attestation' | 'cosignature' | 'anchor' | 'instance' | 'org';
  ok: boolean;
  /** Crossroom's words for it, never text from the record. */
  detail: string;
}

export interface RecordVerdict {
  ok: boolean;
  /** The head the commitments recompute to, or null when they do not. */
  head: string | null;
  checks: RecordCheck[];
}
