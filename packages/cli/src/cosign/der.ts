/**
 * Just enough ASN.1 DER to ask a timestamp authority for a timestamp and to check the one it
 * returns (RFC 3161, a CMS SignedData of RFC 5652): a strict reader and a small writer.
 *
 * The reader takes single-byte tags (every tag RFC 3161 and X.509 use), definite lengths in their
 * shortest form only, and nothing past the end of its input. It throws `DerError` for anything
 * else; callers that read what somebody else wrote catch it and answer in Crossroom's words.
 */

export class DerError extends Error {}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8: 0x0c,
  PRINTABLE: 0x13,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** One element: its tag byte, and where its whole encoding and its content lie in `buf`. */
export interface Der {
  tag: number;
  /** The element's bytes, header included. */
  raw: Uint8Array;
  content: Uint8Array;
}

/** The element starting at `at`, and where the next one starts. */
export function readOne(buf: Uint8Array, at = 0): { node: Der; next: number } {
  if (at + 2 > buf.length) throw new DerError('truncated');
  const tag = buf[at]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError('a multi-byte tag');
  let len = buf[at + 1]!;
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new DerError('an indefinite length');
    if (n > 4 || at + 2 + n > buf.length) throw new DerError('a length too long');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i]!;
    if (len < 0x80 || buf[at + 2] === 0) throw new DerError('a length not in its shortest form');
    head += n;
  }
  const end = at + head + len;
  if (end > buf.length) throw new DerError('truncated');
  return { node: { tag, raw: buf.subarray(at, end), content: buf.subarray(at + head, end) }, next: end };
}

/** The one element `buf` holds, refusing anything after it. */
export function readDer(buf: Uint8Array): Der {
  const { node, next } = readOne(buf, 0);
  if (next !== buf.length) throw new DerError('bytes after the end');
  return node;
}

/** A constructed element's children. */
export function children(node: Der): Der[] {
  if (!(node.tag & 0x20)) throw new DerError('not a constructed element');
  const out: Der[] = [];
  let at = 0;
  while (at < node.content.length) {
    const r = readOne(node.content, at);
    out.push(r.node);
    at = r.next;
  }
  return out;
}

/** `node`, which must carry `tag`. */
export function expectTag(node: Der | undefined, tag: number, what: string): Der {
  if (!node || node.tag !== tag) throw new DerError(`${what} is missing`);
  return node;
}

/** An OBJECT IDENTIFIER's dotted form. */
export function readOid(node: Der): string {
  expectTag(node, TAG.OID, 'an object identifier');
  const b = node.content;
  if (b.length === 0) throw new DerError('an empty object identifier');
  const parts: number[] = [];
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * 128 + (b[i]! & 0x7f);
    if (v > Number.MAX_SAFE_INTEGER) throw new DerError('an object identifier too long');
    if (!(b[i]! & 0x80)) {
      parts.push(v);
      v = 0;
    } else if (i === b.length - 1) throw new DerError('a truncated object identifier');
  }
  const first = parts.shift()!;
  const a = first < 40 ? 0 : first < 80 ? 1 : 2;
  return [a, first - a * 40, ...parts].join('.');
}

/** An INTEGER, as a bigint. */
export function readInt(node: Der): bigint {
  expectTag(node, TAG.INTEGER, 'an integer');
  const b = node.content;
  if (b.length === 0) throw new DerError('an empty integer');
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  if (b[0]! & 0x80) v -= 1n << BigInt(b.length * 8);
  return v;
}

/** A GeneralizedTime (`YYYYMMDDHHMMSS[.f*]Z`) or a UTCTime (`YYMMDDHHMMSSZ`). */
export function readTime(node: Der): Date {
  const s = Buffer.from(node.content).toString('latin1');
  const m =
    node.tag === TAG.GENERALIZED_TIME
      ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,9}))?Z$/.exec(s)
      : node.tag === TAG.UTC_TIME
        ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
        : null;
  if (!m) throw new DerError('a time not in UTC');
  const year = node.tag === TAG.UTC_TIME ? (Number(m[1]) >= 50 ? 1900 : 2000) + Number(m[1]) : Number(m[1]);
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms));
  if (Number.isNaN(d.getTime())) throw new DerError('a time that is no date');
  return d;
}

// ---------------------------------------------------------------- writing

const concat = (parts: readonly Uint8Array[]) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));

/** A TLV with `tag` around `content`. */
export function tlv(tag: number, content: Uint8Array): Uint8Array {
  const n = content.length;
  let head: number[];
  if (n < 0x80) head = [tag, n];
  else {
    const len: number[] = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) len.unshift(v & 0xff);
    head = [tag, 0x80 | len.length, ...len];
  }
  return concat([new Uint8Array(head), content]);
}

export const seq = (...parts: Uint8Array[]) => tlv(TAG.SEQUENCE, concat(parts));

/** A SET OF, its elements sorted by their encodings as DER requires. */
export const setOf = (...parts: Uint8Array[]) => tlv(TAG.SET, concat([...parts].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))));

/** `[n]` around `content`: EXPLICIT (constructed) unless `primitive`. */
export const ctx = (n: number, content: Uint8Array, primitive = false) => tlv((primitive ? 0x80 : 0xa0) | n, content);

export function int(v: bigint | number): Uint8Array {
  let x = BigInt(v);
  if (x < 0n) throw new DerError('a negative integer');
  const out: number[] = [];
  do {
    out.unshift(Number(x & 0xffn));
    x >>= 8n;
  } while (x > 0n);
  if (out[0]! & 0x80) out.unshift(0);
  return tlv(TAG.INTEGER, new Uint8Array(out));
}

export function oid(dotted: string): Uint8Array {
  const p = dotted.split('.').map(Number);
  const out: number[] = [];
  const push = (v: number) => {
    const chunk: number[] = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) chunk.unshift(0x80 | (x & 0x7f));
    out.push(...chunk);
  };
  push(p[0]! * 40 + p[1]!);
  for (const v of p.slice(2)) push(v);
  return tlv(TAG.OID, new Uint8Array(out));
}

export const octets = (b: Uint8Array) => tlv(TAG.OCTET_STRING, b);
export const bits = (b: Uint8Array) => tlv(TAG.BIT_STRING, concat([new Uint8Array([0]), b]));
export const bool = (b: boolean) => tlv(TAG.BOOLEAN, new Uint8Array([b ? 0xff : 0]));
export const nul = () => tlv(TAG.NULL, new Uint8Array());
export const utf8String = (s: string) => tlv(TAG.UTF8, new Uint8Array(Buffer.from(s, 'utf8')));

const two = (n: number) => String(n).padStart(2, '0');
export const generalizedTime = (d: Date) =>
  tlv(
    TAG.GENERALIZED_TIME,
    new Uint8Array(
      Buffer.from(`${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`, 'latin1'),
    ),
  );
export const utcTime = (d: Date) =>
  tlv(
    TAG.UTC_TIME,
    new Uint8Array(
      Buffer.from(`${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`, 'latin1'),
    ),
  );
