/**
 * RFC 3161 timestamps for anchoring. Rekor v2 gives an entry no
 * integrated time, so each batch's signature is timestamped by a timestamp authority (TSA): the
 * TSA signs SHA-256 of the signature's bytes and the time it saw them, which proves the batch, and
 * so every head in it, existed by then.
 *
 * - `requestTimestamp` asks a TSA (through the fetch it is handed: the server's is `safeFetch`,
 *   I15), with a nonce and `certReq`, and keeps the token only once it checks out against itself.
 * - `checkTimestamp` checks a token offline: the CMS SignedData's one signer, its signed attributes
 *   (content type TSTInfo, the message digest of the TSTInfo), the signature under a certificate
 *   that carries the time-stamping purpose and was valid at the time it states, the imprint of the
 *   data, the nonce when one was asked for, and, given trusted certificates, a chain to one of them.
 *
 * Nothing here trusts a certificate because the token carries it: with `trusted` given, the signer
 * must chain to one of those, which `crossroom verify --trusted-root` reads from the file it is given.
 */
import { createHash, randomBytes, verify as verifySig, X509Certificate } from 'node:crypto';
import { children, type Der, DerError, expectTag, int, nul, octets, oid, readDer, readInt, readOid, readTime, seq, TAG, bool } from './der.js';

export const OID = {
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ecdsaSha384: '1.2.840.10045.4.3.3',
  ecdsaSha512: '1.2.840.10045.4.3.4',
  rsa: '1.2.840.113549.1.1.1',
  rsaSha256: '1.2.840.113549.1.1.11',
  rsaSha384: '1.2.840.113549.1.1.12',
  rsaSha512: '1.2.840.113549.1.1.13',
  ecPublicKey: '1.2.840.10045.2.1',
  timeStamping: '1.3.6.1.5.5.7.3.8',
} as const;

const HASH_OF: Readonly<Record<string, 'sha256' | 'sha384' | 'sha512'>> = {
  [OID.sha256]: 'sha256',
  [OID.sha384]: 'sha384',
  [OID.sha512]: 'sha512',
};
/** A signature algorithm's hash, or null where the digest algorithm names it (a bare key type). */
const SIG_HASH: Readonly<Record<string, 'sha256' | 'sha384' | 'sha512' | null>> = {
  [OID.ecdsaSha256]: 'sha256',
  [OID.ecdsaSha384]: 'sha384',
  [OID.ecdsaSha512]: 'sha512',
  [OID.rsaSha256]: 'sha256',
  [OID.rsaSha384]: 'sha384',
  [OID.rsaSha512]: 'sha512',
  [OID.rsa]: null,
  [OID.ecPublicKey]: null,
};

const digest = (alg: string, data: Uint8Array) => new Uint8Array(createHash(alg).update(data).digest());
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** A TimeStampReq for SHA-256 of `data`, asking for the TSA's certificate (`certReq`). */
export function timestampRequest(data: Uint8Array, nonce: bigint): Uint8Array {
  return seq(int(1), seq(seq(oid(OID.sha256), nul()), octets(digest('sha256', data))), int(nonce), bool(true));
}

/** A fresh positive 64-bit nonce. */
export const freshNonce = (): bigint => BigInt(`0x${randomBytes(8).toString('hex')}`) | 1n;

/** The token in a TimeStampResp whose status is granted (0) or granted with modifications (1). */
export function tokenOfResponse(resp: Uint8Array): Uint8Array {
  const top = children(expectTag(readDer(resp), TAG.SEQUENCE, 'a timestamp response'));
  const status = readInt(children(expectTag(top[0], TAG.SEQUENCE, "the response's status"))[0]!);
  if (status !== 0n && status !== 1n) throw new DerError(`the authority refused (status ${status})`);
  return new Uint8Array(expectTag(top[1], TAG.SEQUENCE, 'a timestamp token').raw);
}

export type TimestampCheck = { ok: true; genTime: Date; signer: X509Certificate } | { ok: false; reason: string };

/** A certificate's validity as dates. */
const validity = (c: X509Certificate) => ({ from: new Date(c.validFrom), to: new Date(c.validTo) });

/** Whether a certificate is for time-stamping (its extended key usage names it). */
function forTimestamps(c: X509Certificate): boolean {
  const eku = (c as X509Certificate & { extKeyUsage?: string[] }).extKeyUsage ?? c.keyUsage;
  return Array.isArray(eku) && eku.includes(OID.timeStamping);
}

/** Whether `cert` chains to one of `trusted`, through CA certificates from either list, each valid at `at`. */
function chainsTo(cert: X509Certificate, pool: readonly X509Certificate[], trusted: readonly X509Certificate[], at: Date): boolean {
  let cur = cert;
  for (let depth = 0; depth < 6; depth++) {
    const v = validity(cur);
    if (!(v.from <= at && at <= v.to)) return false;
    if (trusted.some((t) => t.raw.equals(cur.raw))) return true;
    const issuer = [...trusted, ...pool].find((c) => c.ca && !c.raw.equals(cur.raw) && cur.checkIssued(c) && cur.verify(c.publicKey));
    if (!issuer) return false;
    cur = issuer;
  }
  return false;
}

/** The parts of a token's SignedData that the checks read. */
interface Parsed {
  tstInfo: Uint8Array;
  certs: X509Certificate[];
  digestAlg: string;
  signedAttrs: Der;
  sigHash: string;
  signature: Uint8Array;
}

function parseToken(token: Uint8Array): Parsed {
  const ci = children(expectTag(readDer(token), TAG.SEQUENCE, 'a content info'));
  if (readOid(ci[0]!) !== OID.signedData) throw new DerError('not a signed-data content info');
  const sdWrap = children(expectTag(ci[1], 0xa0, 'the signed data'));
  const sd = children(expectTag(sdWrap[0], TAG.SEQUENCE, 'the signed data'));
  let i = 2; // version, digestAlgorithms
  const encap = children(expectTag(sd[i++], TAG.SEQUENCE, 'the encapsulated content'));
  if (readOid(encap[0]!) !== OID.tstInfo) throw new DerError('the content is not a TSTInfo');
  const eWrap = children(expectTag(encap[1], 0xa0, 'the TSTInfo'));
  const tstInfo = expectTag(eWrap[0], TAG.OCTET_STRING, 'the TSTInfo').content;
  const certs: X509Certificate[] = [];
  if (sd[i]?.tag === 0xa0) {
    for (const c of children(sd[i]!)) if (c.tag === TAG.SEQUENCE) certs.push(new X509Certificate(Buffer.from(c.raw)));
    i++;
  }
  if (sd[i]?.tag === 0xa1) i++;
  const signers = children(expectTag(sd[i], TAG.SET, 'the signer infos'));
  if (signers.length !== 1) throw new DerError('a timestamp has exactly one signer');
  const si = children(expectTag(signers[0], TAG.SEQUENCE, 'the signer info'));
  // version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature
  const digestAlg = HASH_OF[readOid(children(expectTag(si[2], TAG.SEQUENCE, 'the digest algorithm'))[0]!)];
  if (!digestAlg) throw new DerError('a digest algorithm Crossroom does not check');
  const signedAttrs = expectTag(si[3], 0xa0, 'the signed attributes');
  const sigAlgOid = readOid(children(expectTag(si[4], TAG.SEQUENCE, 'the signature algorithm'))[0]!);
  if (!(sigAlgOid in SIG_HASH)) throw new DerError('a signature algorithm Crossroom does not check');
  const sigHash = SIG_HASH[sigAlgOid] ?? digestAlg;
  const signature = expectTag(si[5], TAG.OCTET_STRING, 'the signature').content;
  return { tstInfo, certs, digestAlg, signedAttrs, sigHash, signature };
}

/** The one value of a signed attribute, or null. */
function attribute(attrs: Der, type: string): Der | null {
  let found: Der | null = null;
  for (const a of children(attrs)) {
    const parts = children(expectTag(a, TAG.SEQUENCE, 'an attribute'));
    if (readOid(parts[0]!) !== type) continue;
    if (found) throw new DerError('an attribute given twice');
    const values = children(expectTag(parts[1], TAG.SET, "an attribute's values"));
    if (values.length !== 1) throw new DerError('an attribute with more than one value');
    found = values[0]!;
  }
  return found;
}

/**
 * Check a timestamp token over `data`. With `trusted`, the signer must chain to one of them (the
 * token's own certificates may stand between); without it, the token is checked against itself
 * alone, which is what the server does as it takes a token from the TSA it chose.
 */
export function checkTimestamp(token: Uint8Array, data: Uint8Array, opts: { trusted?: readonly X509Certificate[]; nonce?: bigint } = {}): TimestampCheck {
  try {
    const p = parseToken(token);
    // The signed attributes: what the signature is over, as a SET OF.
    const ct = attribute(p.signedAttrs, OID.contentType);
    if (!ct || readOid(ct) !== OID.tstInfo) return { ok: false, reason: 'its signed content type is not a TSTInfo' };
    const md = attribute(p.signedAttrs, OID.messageDigest);
    if (!md || !same(expectTag(md, TAG.OCTET_STRING, 'the message digest').content, digest(p.digestAlg, p.tstInfo)))
      return { ok: false, reason: 'its signed digest is not of its TSTInfo' };
    const signedBytes = new Uint8Array(p.signedAttrs.raw);
    signedBytes[0] = TAG.SET;

    // The TSTInfo: version, policy, imprint, serial, time, then accuracy, ordering and the nonce.
    const tst = children(expectTag(readDer(p.tstInfo), TAG.SEQUENCE, 'the TSTInfo'));
    const imprint = children(expectTag(tst[2], TAG.SEQUENCE, 'the message imprint'));
    const imprintAlg = HASH_OF[readOid(children(expectTag(imprint[0], TAG.SEQUENCE, "the imprint's algorithm"))[0]!)];
    if (!imprintAlg) return { ok: false, reason: 'its imprint uses a hash Crossroom does not check' };
    if (!same(expectTag(imprint[1], TAG.OCTET_STRING, 'the imprint').content, digest(imprintAlg, data)))
      return { ok: false, reason: 'it timestamps other data' };
    const genTime = readTime(expectTag(tst[4], TAG.GENERALIZED_TIME, 'the time'));
    if (opts.nonce !== undefined) {
      const nonce = tst.slice(5).find((n) => n.tag === TAG.INTEGER);
      if (!nonce || readInt(nonce) !== opts.nonce) return { ok: false, reason: 'its nonce is not the one asked for' };
    }

    // The signer: whichever certificate's key the signature verifies under.
    const pool = [...p.certs, ...(opts.trusted ?? [])];
    const signer = pool.find((c) => {
      try {
        return verifySig(p.sigHash, signedBytes, c.publicKey, p.signature);
      } catch {
        return false;
      }
    });
    if (!signer) return { ok: false, reason: 'its signature verifies under no certificate it names or you trust' };
    if (!forTimestamps(signer)) return { ok: false, reason: 'its signer is not certified for time-stamping' };
    const v = validity(signer);
    if (!(v.from <= genTime && genTime <= v.to)) return { ok: false, reason: "its time is outside its signer's certificate" };
    if (opts.trusted && !chainsTo(signer, p.certs, opts.trusted, genTime)) return { ok: false, reason: 'its signer does not chain to a TSA you trust' };
    return { ok: true, genTime, signer };
  } catch (e) {
    return { ok: false, reason: e instanceof DerError ? `it is not a timestamp token (${e.message})` : 'it is not a timestamp token' };
  }
}

/** A failure to get a timestamp, in Crossroom's words. */
export class TsaError extends Error {}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => Promise<Response>;

/** The most a timestamp response may be: a token with a chain of a few certificates. */
export const TSA_MAX_BYTES = 64 * 1024;

/** Ask the TSA at `url` to timestamp `data`, and answer its token once it checks out against itself. */
export async function requestTimestamp(url: string, data: Uint8Array, send: FetchLike): Promise<Uint8Array> {
  const nonce = freshNonce();
  let res: Response;
  try {
    res = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/timestamp-query', accept: 'application/timestamp-reply' },
      body: timestampRequest(data, nonce),
    });
  } catch (e) {
    throw new TsaError(`the timestamp authority could not be reached (${(e as Error)?.name ?? 'error'})`);
  }
  if (!res.ok) throw new TsaError(`the timestamp authority answered ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.length > TSA_MAX_BYTES) throw new TsaError('the timestamp authority answered with too much');
  let token: Uint8Array;
  try {
    token = tokenOfResponse(body);
  } catch (e) {
    throw new TsaError(`the timestamp authority answered with no token (${e instanceof DerError ? e.message : 'unreadable'})`);
  }
  const check = checkTimestamp(token, data, { nonce });
  if (!check.ok) throw new TsaError(`the timestamp authority's token does not check out: ${check.reason}`);
  return token;
}
