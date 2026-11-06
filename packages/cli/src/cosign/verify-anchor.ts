/**
 * What `crossroom verify --record <r.json> --trusted-root <file>` checks of a bundle's anchors,
 * offline, from the bundle and the trusted root alone. commands/verify-room.ts calls it. For each anchor, in order, and the first that fails is its line:
 *
 * 1. its head is the record's head at its seq (recomputed from the bundle's commitments);
 * 2. its leaf, recomputed from the relay, the room, the seq and the head with RFC 6962's 0x00, walks
 *    its audit path to the batch's root (so a path proves membership whatever size it claims: no
 *    interior node is a leaf);
 * 3. the log entry is a hashedrekord of the batch's `parley/anchor/v1` statement, signed with an
 *    anchoring key the trusted root pins for this relay (`parleyAnchoringKeys`);
 * 4. the entry is in its log: its leaf under the root of a checkpoint signed by a log the trusted
 *    root names (`tlogs`, sigstore's trusted root format), or, for a relay's own log, by its pinned
 *    anchoring key, under that log's origin;
 * 5. where the trusted root names a TSA (`timestampAuthorities`), an RFC 3161 timestamp over the
 *    entry's signature, chained to it, no earlier than the batch's hour.
 *
 * A pending anchor (no entry yet) is a check that fails: nothing yet proves when that head existed.
 * Every detail is Crossroom's words with numbers and an hour Crossroom checked the shape of; nothing the
 * record says is printed (verify-room.ts prints these lines).
 */
import { createPublicKey, X509Certificate } from 'node:crypto';
import { anchorLeaf, anchorStatement, isHex64, type RecordAnchor, type RecordCheck, type RoomRecordBundle } from '@parley/shared/chain';
import { verifyInclusion } from './merkle.js';
import { prefixHeads } from './record-verify.js';
import { checkLogEntry, claimsSign, type LogKey, localOrigin, readEntryBody } from './rekor.js';
import { checkTimestamp } from './tsa.js';

/** An hour as a batch's window carries it. */
const WINDOW = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/;
/** How much earlier than its hour a TSA's clock may read and still be believed. */
const SKEW_MS = 5 * 60_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

function fromB64(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0 || !s.length) return null;
  const b = Buffer.from(s, 'base64');
  return b.toString('base64') === s ? new Uint8Array(b) : null;
}

interface TsaRoot {
  certs: X509Certificate[];
  start: Date | null;
  end: Date | null;
}

interface Trusted {
  logs: LogKey[];
  tsas: TsaRoot[];
  /** PKIX DER of each anchoring key pinned for the bundle's relay. */
  anchoring: Uint8Array[];
}

const keyOf = (pk: unknown) => {
  const raw = isObj(pk) ? fromB64(pk.rawBytes) : null;
  return raw ? createPublicKey({ key: Buffer.from(raw), format: 'der', type: 'spki' }) : null;
};

const dateOf = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);

/** The trusted root, or why it cannot be read. */
function readTrusted(raw: unknown, relay: string): Trusted | string {
  if (!isObj(raw)) return 'the trusted root is not a JSON object';
  try {
    const logs: LogKey[] = [];
    for (const t of Array.isArray(raw.tlogs) ? raw.tlogs : []) {
      const key = isObj(t) ? keyOf(t.publicKey) : null;
      if (!key) return 'a log in the trusted root has no key Crossroom can read';
      logs.push({ key });
    }
    const tsas: TsaRoot[] = [];
    for (const t of Array.isArray(raw.timestampAuthorities) ? raw.timestampAuthorities : []) {
      const list = isObj(t) && isObj(t.certChain) && Array.isArray(t.certChain.certificates) ? t.certChain.certificates : null;
      const certs = (list ?? []).map((c) => (isObj(c) ? fromB64(c.rawBytes) : null));
      if (!certs.length || certs.some((c) => !c)) return 'a TSA in the trusted root has no certificate Crossroom can read';
      const valid = isObj(t) && isObj(t.validFor) ? t.validFor : {};
      tsas.push({ certs: certs.map((c) => new X509Certificate(Buffer.from(c!))), start: dateOf(valid.start), end: dateOf(valid.end) });
    }
    const anchoring: Uint8Array[] = [];
    for (const k of Array.isArray(raw.parleyAnchoringKeys) ? raw.parleyAnchoringKeys : []) {
      if (!isObj(k) || typeof k.relay !== 'string') return 'an anchoring key in the trusted root names no relay';
      const key = keyOf(k.publicKey);
      if (!key) return 'an anchoring key in the trusted root is not one Crossroom can read';
      if (k.relay === relay) anchoring.push(new Uint8Array(key.export({ type: 'spki', format: 'der' })));
    }
    if (!logs.length && !anchoring.length) return 'the trusted root names no log and pins no anchoring key';
    return { logs, tsas, anchoring };
  } catch {
    return 'the trusted root holds a key or a certificate Crossroom cannot read';
  }
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** One anchor's line. */
function checkOne(bundle: RoomRecordBundle, a: RecordAnchor, heads: string[] | null, t: Trusted): RecordCheck {
  const fail = (detail: string): RecordCheck => ({ what: 'anchor', ok: false, detail });
  if (!isObj(a) || !isInt(a.seq, 1)) return fail('an anchor names no event');
  const at = `seq ${a.seq}`;
  if (!isHex64(a.head) || typeof a.window !== 'string' || !WINDOW.test(a.window) || !isHex64(a.root) || !isInt(a.leafIndex) || !Array.isArray(a.proof))
    return fail(`${at}: the anchor is not one Crossroom can read`);
  if (a.log !== 'rekor' && a.log !== 'local') return fail(`${at}: the anchor names a log Crossroom does not know`);
  if (!isInt(a.size, 1)) return fail(`${at}: the anchor does not say how many heads its batch has`);
  if (!heads) return fail(`${at}: the record's commitments make no chain, so no anchored head can be checked`);
  if (heads[a.seq] !== a.head) return fail(`${at}: the anchored head is not the record's head at that event`);
  let leaf: string;
  try {
    leaf = anchorLeaf({ relay: bundle.relay, room: bundle.room, seq: a.seq, head: a.head });
  } catch {
    return fail(`${at}: the anchor is not one Crossroom can read`);
  }
  if (!verifyInclusion(a.leafIndex, a.size, leaf, a.proof as string[], a.root)) return fail(`${at}: the head is not in the tree of its batch`);
  if (a.entry === null || a.entry === undefined) return fail(`${at}: anchoring pending, so nothing proves yet when this head existed`);

  const statement = anchorStatement({ relay: bundle.relay, window: a.window, root: a.root });
  const claims = readEntryBody(a.entry);
  if (!claims) return fail(`${at}: the log entry is not a hashedrekord Crossroom can read`);
  if (!claimsSign(claims, statement)) return fail(`${at}: the log entry is not the signed statement of this batch`);
  if (!t.anchoring.some((k) => same(k, claims.publicKey))) return fail(`${at}: the batch is signed with an anchoring key the trusted root does not pin for this relay`);
  const logKeys = a.log === 'rekor' ? t.logs : t.anchoring.map((k) => ({ key: createPublicKey({ key: Buffer.from(k), format: 'der', type: 'spki' }) }));
  if (!logKeys.length) return fail(`${at}: the trusted root names no log to check the entry against`);
  const e = checkLogEntry(a.entry, logKeys, a.log === 'local' ? localOrigin(bundle.relay) : undefined);
  if (!e.ok) return fail(`${at}: ${e.reason}`);

  let when: string;
  if (t.tsas.length) {
    const token = fromB64(a.tsa);
    if (!token) return fail(`${at}: not timestamped, and the trusted root names a TSA`);
    let reason = 'it does not check out';
    let genTime: Date | null = null;
    for (const r of t.tsas) {
      const c = checkTimestamp(token, claims.signature, { trusted: r.certs });
      if (!c.ok) {
        reason = c.reason;
        continue;
      }
      if ((r.start && c.genTime < r.start) || (r.end && c.genTime > r.end)) {
        reason = 'its time is outside the period the trusted root gives its TSA';
        continue;
      }
      genTime = c.genTime;
      break;
    }
    if (!genTime) return fail(`${at}: the timestamp fails: ${reason}`);
    if (genTime.getTime() < Date.parse(a.window) - SKEW_MS) return fail(`${at}: the timestamp is earlier than the hour of its batch`);
    when = `, timestamped ${genTime.toISOString()}`;
  } else when = a.tsa ? ', its timestamp unchecked: the trusted root names no TSA' : ', not timestamped';
  const where = a.log === 'rekor' ? 'the public log' : "the relay's own log";
  return {
    what: 'anchor',
    ok: true,
    detail: `${at}: in the batch for ${a.window} (head ${a.leafIndex + 1} of ${a.size}), entry ${e.logIndex + 1} of ${e.treeSize} in ${where}${when}`,
  };
}

export function checkAnchors(bundle: RoomRecordBundle, trustedRoot: unknown): RecordCheck[] {
  const anchors = Array.isArray(bundle.anchors) ? bundle.anchors : [];
  if (!anchors.length) return [{ what: 'anchor', ok: false, detail: 'the record carries no anchor: its room is in no organisation that anchors, or none was cut yet' }];
  const t = readTrusted(trustedRoot, bundle.relay);
  if (typeof t === 'string') return [{ what: 'anchor', ok: false, detail: t }];
  const heads = prefixHeads(bundle.room, bundle.commitments);
  return anchors.map((a) => checkOne(bundle, a, heads, t));
}
