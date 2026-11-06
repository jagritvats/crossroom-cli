/**
 * What `crossroom verify --record <r.json> --org <domain>` checks of a bundle's co-signatures:
 * whether the keys that co-signed as `org:<domain>` are keys that domain publishes, at
 * `https://<domain>/.well-known/parley-keys.json`, whose format this file fixes (`ParleyKeys`).
 *
 * A bundle says how a co-signing key is vouched for (`RecordCosignature.certified`), but that is the
 * relay's word, and the relay pins a key on its first use. Only the
 * organisation can say a key is its own, and it says so by publishing it on its own domain over
 * HTTPS. So each co-signature by `org:<domain>` is reported:
 * - ok, when it verifies over the bundle's own relay, room and a head of its chain, under a key the
 *   domain lists for co-signing and has not revoked;
 * - not ok, when the domain does not list the key, has revoked it, or the signature is not over
 *   this chain (`verifyRecordBundle` reports that too; here it decides whether the domain vouches);
 * and the bundle's signed writes, receipts and attestations made with keys the domain lists for
 * those uses are counted, as the organisation's own runner's (whether each verifies is
 * `verifyRecordBundle`'s line, which `crossroom verify --record` prints beside these).
 *
 * Pure but for `fetchKeys`, which the command passes in (commands/verify-room.ts `orgKeysFetcher`,
 * https on that domain alone, no redirect): code under cosign/ fetches nothing itself, which a
 * test checks. Every detail is in Crossroom's words; nothing from the record or the fetched
 * document is printed but key fingerprints, seqs and the domain the command was given.
 */
import {
  chainNextV2,
  chainStartV2,
  cosignStatement,
  isHex64,
  type RecordCheck,
  type RoomRecordBundle,
  type SigAlg,
  writeStatementFor,
} from '@parley/shared/chain';
import { fingerprintOf, verifyStatement } from '../signing.js';

/** The format of `/.well-known/parley-keys.json`. */
export const PARLEY_KEYS_FORMAT = 'parley-keys/v1';
/** Where an organisation publishes its keys, on its own domain. */
export const parleyKeysUrl = (domain: string) => `https://${domain}/.well-known/parley-keys.json`;

/** What a published key may vouch for. A key with no `use` vouches for all of them. */
export const KEY_USES = ['cosign', 'receipt', 'write', 'attest'] as const;
export type KeyUse = (typeof KEY_USES)[number];

/**
 * `/.well-known/parley-keys.json`:
 * ```json
 * { "format": "parley-keys/v1", "org": "org:example.com",
 *   "keys": [ { "alg": "ed25519", "key": "<base64url>", "use": ["cosign", "receipt", "write", "attest"],
 *               "label": "ci runner", "revoked_at": null } ] }
 * ```
 * `org` is `org:` and the domain it is served from. `key` is base64url (Ed25519's raw 32 bytes, P-256's
 * uncompressed point), as every statement names a key. `label` is the organisation's own note and is
 * never printed. A key with `revoked_at` set vouches for nothing: a co-signature carries no time, so
 * a revoked key's co-signatures cannot be told apart by when they were made. At most 100 keys.
 */
export interface ParleyKeys {
  format: typeof PARLEY_KEYS_FORMAT;
  org: string;
  keys: ParleyKey[];
}
export interface ParleyKey {
  alg: SigAlg;
  key: string;
  use?: KeyUse[];
  label?: string;
  revoked_at?: string | null;
}

const KEY = /^[A-Za-z0-9_-]{43,90}$/;
/** A domain as `--org` takes one: lowercase labels with at least one dot, no port, no path. */
export const ORG_DOMAIN = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A published keys document for `domain`, every field checked, or null. */
export function readParleyKeys(raw: unknown, domain: string): ParleyKeys | null {
  if (!isObj(raw) || raw.format !== PARLEY_KEYS_FORMAT || raw.org !== `org:${domain}` || !Array.isArray(raw.keys) || raw.keys.length > 100) return null;
  const keys: ParleyKey[] = [];
  for (const k of raw.keys) {
    if (!isObj(k) || (k.alg !== 'ed25519' && k.alg !== 'ecdsa-p256-sha256') || typeof k.key !== 'string' || !KEY.test(k.key)) return null;
    if (k.use !== undefined && (!Array.isArray(k.use) || !k.use.every((u) => (KEY_USES as readonly unknown[]).includes(u)))) return null;
    if (k.label !== undefined && typeof k.label !== 'string') return null;
    if (k.revoked_at !== undefined && k.revoked_at !== null && typeof k.revoked_at !== 'string') return null;
    keys.push({ alg: k.alg, key: k.key, ...(k.use ? { use: k.use as KeyUse[] } : {}), ...(k.revoked_at ? { revoked_at: k.revoked_at as string } : {}) });
  }
  return { format: PARLEY_KEYS_FORMAT, org: raw.org as string, keys };
}

/** The document an organisation publishes for these keys (what `crossroom runner` prints for its key). */
export function parleyKeysDocument(domain: string, keys: ReadonlyArray<{ alg: SigAlg; key: string; label?: string; use?: KeyUse[] }>): ParleyKeys {
  return { format: PARLEY_KEYS_FORMAT, org: `org:${domain}`, keys: keys.map((k) => ({ alg: k.alg, key: k.key, use: k.use ?? [...KEY_USES], ...(k.label ? { label: k.label } : {}) })) };
}

/** Every head of the chain, h_0 to h_n, or null when the commitments do not make one. */
function heads(b: RoomRecordBundle): string[] | null {
  try {
    const out = [chainStartV2(b.room)];
    for (let i = 0; i < b.commitments.length; i++) {
      const [seq, c] = b.commitments[i]!;
      if (seq !== i + 1 || !isHex64(c)) return null;
      out.push(chainNextV2(out[i]!, seq, c));
    }
    return out;
  } catch {
    return null;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function checkCosignatures(bundle: RoomRecordBundle, domain: string, fetchKeys: (url: string) => Promise<unknown>): Promise<RecordCheck[]> {
  const org = (ok: boolean, detail: string): RecordCheck => ({ what: 'org', ok, detail });
  if (!ORG_DOMAIN.test(domain)) return [org(false, '--org takes a domain, such as example.com')];
  const url = parleyKeysUrl(domain);
  let raw: unknown;
  try {
    raw = await fetchKeys(url);
  } catch {
    return [org(false, `could not read ${url}`)];
  }
  const doc = readParleyKeys(raw, domain);
  if (!doc) return [org(false, `${url} is not a ${PARLEY_KEYS_FORMAT} document for org:${domain}`)];
  const live = doc.keys.filter((k) => !k.revoked_at);
  const vouches = (alg: string, key: string, use: KeyUse) => live.some((k) => k.alg === alg && k.key === key && (!k.use || k.use.includes(use)));
  const by = `org:${domain}`;
  const chain = heads(bundle);
  const checks: RecordCheck[] = [];

  const mine = bundle.cosignatures.filter((c) => c.by === by);
  if (!mine.length) checks.push(org(false, `no co-signature in this record is by ${by}`));
  for (const c of mine) {
    const fp = fingerprintOf(c.key);
    let over = false;
    try {
      over =
        !!chain &&
        chain[c.seq] === c.head &&
        verifyStatement(c.alg, c.key, cosignStatement({ relay: bundle.relay, room: bundle.room, seq: c.seq, head: c.head, role: c.role }), c.sig);
    } catch {
      over = false;
    }
    if (!over) checks.push(org(false, `a co-signature as ${by}, key ${fp}, is not over a head of this record's chain`));
    else if (!vouches(c.alg, c.key, 'cosign'))
      checks.push(org(false, `key ${fp} co-signed the head at event ${c.seq} as ${by}, but ${domain} does not publish it for co-signing`));
    else checks.push(org(true, `${domain} publishes key ${fp}, which co-signed the head at event ${c.seq} as the ${c.role}`));
  }

  // The organisation's own runner's other signatures, counted by key: a signed write when it also
  // verifies over its event; whether each receipt and attestation verifies is `verifyRecordBundle`'s line.
  const writes = bundle.events.filter((e) => {
    if (!e.sig || !vouches(e.sig.alg, e.sig.key, 'write')) return false;
    try {
      return verifyStatement(e.sig.alg, e.sig.key, writeStatementFor(bundle.relay, bundle.room, e), e.sig.sig);
    } catch {
      return false;
    }
  });
  if (writes.length) checks.push(org(true, `${plural(writes.length, 'signed write')} in this record ${writes.length === 1 ? 'was' : 'were'} made with keys ${domain} publishes`));
  const receipts = bundle.receipts.filter((r) => vouches(r.alg, r.key, 'receipt'));
  if (receipts.length) checks.push(org(true, `${plural(receipts.length, 'receipt')} in this record ${receipts.length === 1 ? 'was' : 'were'} signed with keys ${domain} publishes`));
  const attested = bundle.attestations.filter((a) => vouches(a.alg, a.key, 'attest'));
  if (attested.length)
    checks.push(org(true, `${plural(attested.length, 'attestation')} in this record ${attested.length === 1 ? 'was' : 'were'} signed with keys ${domain} publishes`));
  return checks;
}
