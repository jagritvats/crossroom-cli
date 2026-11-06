/**
 * Reading a room record bundle back from a file and checking it: its shape, its chain of
 * commitments, and every signature it carries. Building a bundle is the server's
 * work; this half imports shared code and signing.ts only, so `crossroom verify --record`
 * checks a bundle without carrying the server.
 */
import {
  type CommitmentEntry,
  chainNextV2,
  chainStartV2,
  commitmentOf,
  cosignStatement,
  eventEnvelopeV2,
  isHex64,
  isNonce,
  isWriteOp,
  ledgerStatement,
  minutesStatementV2,
  ROOM_RECORD_FORMAT,
  type RecordAttestation,
  type RecordCheck,
  type RecordCosignature,
  type RecordEvent,
  type RecordReceipt,
  type RecordSignature,
  type RecordVerdict,
  type RecordView,
  type RoomRecordBundle,
  receiptStatement,
  SIG_ALGS,
  STATEMENT,
  type SigAlg,
  statementValue,
  WRITE_OPS,
  type WriteSignature,
  writeStatementFor,
} from '@parley/shared/chain';
import { fingerprintOf, verifyMinutes, verifyStatement } from '../signing.js';

// ---------------------------------------------------------------- reading a bundle back

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const isAlg = (v: unknown): v is SigAlg => (SIG_ALGS as readonly unknown[]).includes(v);
const ROOM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[A-Za-z0-9_-]{43,90}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
/** Text that may go after `key=` in a statement: no control character, no line break. */
const isValue = (v: unknown): v is string => {
  try {
    return typeof v === 'string' && v.length > 0 && v.length <= 2048 && statementValue(v) === v;
  } catch {
    return false;
  }
};
const VIEWS: readonly RecordView[] = ['owner', 'seat', 'shared'];

const isWriteSig = (s: unknown): s is WriteSignature =>
  isObj(s) && s.v === 1 && isAlg(s.alg) && isWriteOp(s.op) && typeof s.key === 'string' && KEY.test(s.key) && isValue(s.cn) && isValue(s.at) && typeof s.sig === 'string' && SIG.test(s.sig);

const isEvent = (e: unknown): e is RecordEvent =>
  isObj(e) &&
  isInt(e.seq, 1) &&
  isValue(e.type) &&
  isValue(e.actor) &&
  isValue(e.audience) &&
  isValue(e.at) &&
  isObj(e.payload) &&
  isNonce(e.nonce) &&
  (e.sig === undefined || isWriteSig(e.sig));

const signed = (x: Record<string, unknown>) => isAlg(x.alg) && typeof x.key === 'string' && KEY.test(x.key) && typeof x.sig === 'string' && SIG.test(x.sig);

const isSignature = (s: unknown): s is RecordSignature => isObj(s) && typeof s.statement === 'string' && s.statement.length <= 4096 && signed(s);
const isReceipt = (r: unknown): r is RecordReceipt =>
  isObj(r) && isValue(r.seat) && isInt(r.through, 1) && isHex64(r.head) && isHex64(r.seen) && isValue(r.at) && signed(r);
const isAttestation = (a: unknown): a is RecordAttestation =>
  isObj(a) && isInt(a.seq, 1) && typeof a.statement === 'string' && a.statement.length <= 4096 && isValue(a.status) && signed(a);
const isCosignature = (c: unknown): c is RecordCosignature =>
  isObj(c) &&
  isValue(c.by) &&
  (c.role === 'host' || c.role === 'guest') &&
  isInt(c.seq, 1) &&
  isHex64(c.head) &&
  (c.certified === null || c.certified === 'relay-tofu' || c.certified === 'domain') &&
  signed(c);

/** A bundle read back from a file: its shape checked field by field, or a sentence saying what is wrong with it. */
export function readRecordBundle(raw: unknown): { ok: true; bundle: RoomRecordBundle } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!isObj(raw) || raw.format !== ROOM_RECORD_FORMAT) return no(`it is not a ${ROOM_RECORD_FORMAT} record bundle`);
  if (!isValue(raw.relay)) return no("its relay is not a URL Crossroom could have written");
  if (typeof raw.room !== 'string' || !ROOM_ID.test(raw.room)) return no("its room is not a room id");
  if (!VIEWS.includes(raw.view as RecordView)) return no('its view is not owner, seat or shared');
  const list = (k: string, ok: (x: unknown) => boolean) => Array.isArray(raw[k]) && (raw[k] as unknown[]).every(ok);
  if (!list('commitments', (c) => Array.isArray(c) && c.length === 2 && isInt(c[0], 1) && isHex64(c[1]))) return no('its commitments are not pairs of a seq and a digest');
  if (!isObj(raw.head) || !isInt(raw.head.seq) || !isHex64(raw.head.head)) return no('its head is not a seq and a digest');
  if (!list('events', isEvent)) return no('an event in it is not one as a bundle carries it');
  if (!list('signatures', isSignature)) return no('a signature in it is not one as a bundle carries it');
  if (!list('receipts', isReceipt)) return no('a receipt in it is not one as a bundle carries it');
  if (!list('attestations', isAttestation)) return no('an attestation in it is not one as a bundle carries it');
  if (!list('cosignatures', isCosignature)) return no('a co-signature in it is not one as a bundle carries it');
  if (!list('anchors', isObj)) return no('an anchor in it is not an object');
  return { ok: true, bundle: raw as unknown as RoomRecordBundle };
}

// ---------------------------------------------------------------- checking a bundle

/**
 * Every head of the chain, h_0 to h_n, from a bundle's commitments: `heads[k]` is the head after
 * event k, what a receipt, a co-signature or signed minutes at seq k name. Null when the list
 * skips a seq or holds something that is not a digest.
 */
export function prefixHeads(room: string, commitments: readonly CommitmentEntry[]): string[] | null {
  const heads = [chainStartV2(room)];
  for (let i = 0; i < commitments.length; i++) {
    const [seq, c] = commitments[i]!;
    if (seq !== i + 1 || !isHex64(c)) return null;
    heads.push(chainNextV2(heads[i]!, seq, c));
  }
  return heads;
}

/** A statement's lines after the first, as `key=value`, or null for one with a line that is not, or a key twice. */
function statementFields(statement: string): { first: string; f: Map<string, string> } | null {
  const [first, ...rest] = statement.split('\n');
  const f = new Map<string, string>();
  for (const line of rest) {
    const eq = line.indexOf('=');
    if (eq < 1 || f.has(line.slice(0, eq))) return null;
    f.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return { first: first ?? '', f };
}

const seqOf = (v: string | undefined): number | null => (v !== undefined && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listed = (seqs: number[]) => (seqs.length > 5 ? `${seqs.slice(0, 5).join(', ')} and ${seqs.length - 5} more` : seqs.join(', '));

/**
 * Check a bundle from its own view, offline: that its commitments recompute to its head, that each
 * event it shows whole recomputes to its commitment (a party that sees only some events verifies
 * their inclusion this way), each signature, receipt, attestation and co-signature over the chain,
 * each signed write, and, given signed minutes, that they verify and name a head of this chain.
 * Anchors are `checkAnchors`'s (with `--trusted-root`), and whose keys co-signed
 * `checkCosignatures`'s (with `--org`). Every detail is in Crossroom's words, never text from the record.
 */
export function verifyRecordBundle(raw: unknown, o: { minutes?: string } = {}): RecordVerdict {
  const read = readRecordBundle(raw);
  if (!read.ok) return { ok: false, head: null, checks: [{ what: 'chain', ok: false, detail: `the record cannot be read: ${read.reason}` }] };
  const b = read.bundle;
  const checks: RecordCheck[] = [];
  const add = (what: RecordCheck['what'], ok: boolean, detail: string) => checks.push({ what, ok, detail });
  const n = b.commitments.length;
  const heads = prefixHeads(b.room, b.commitments);
  const headAt = (seq: number) => (heads && seq >= 0 && seq <= n ? heads[seq]! : null);

  // The chain: the commitments, from seq 1 up by one, recompute to the head the record names.
  if (!heads) add('chain', false, 'the commitments skip an event, or hold something that is not a digest');
  else if (b.head.seq !== n) add('chain', false, `the record names its head at event ${b.head.seq}, but lists ${plural(n, 'commitment')}`);
  else if (b.head.head !== heads[n]) add('chain', false, 'the commitments recompute to another head than the one the record names');
  else add('chain', true, `the ${plural(n, 'commitment')} recompute to the head the record names, at event ${n}`);

  // Inclusion: each event shown whole recomputes, from itself and its nonce, to its listed commitment.
  const commitmentAt = new Map(b.commitments.map(([seq, c]) => [seq, c] as const));
  const wrong: number[] = [];
  const twice = new Set<number>();
  const seen = new Set<number>();
  for (const e of b.events) {
    if (seen.has(e.seq)) twice.add(e.seq);
    seen.add(e.seq);
    let c: string | null = null;
    try {
      c = commitmentOf(e.nonce, eventEnvelopeV2({ room: b.room, seq: e.seq, type: e.type, actor: e.actor, audience: e.audience, at: e.at, payload: e.payload, sig: e.sig ?? null }));
    } catch {
      c = null;
    }
    if (!c || c !== commitmentAt.get(e.seq)) wrong.push(e.seq);
  }
  if (twice.size) add('inclusion', false, `events ${listed([...twice])} are listed twice`);
  else if (wrong.length) add('inclusion', false, `${wrong.length === 1 ? 'event' : 'events'} ${listed(wrong)} ${wrong.length === 1 ? 'does' : 'do'} not recompute to ${wrong.length === 1 ? 'its commitment' : 'their commitments'}`);
  else
    add(
      'inclusion',
      true,
      `${plural(b.events.length, 'event')} of ${n} ${b.events.length === 1 ? 'is' : 'are'} shown whole in this ${b.view} view, and each recomputes to its commitment; the other ${n - b.events.length} ${n - b.events.length === 1 ? 'is' : 'are'} held by ${n - b.events.length === 1 ? 'its commitment' : 'their commitments'} alone`,
    );

  checkWrites(b, add);

  // Signed minutes given beside the record: they verify on their own, and name a head of this chain.
  if (o.minutes !== undefined) {
    const v = verifyMinutes(o.minutes);
    if (!v.ok) add('minutes', false, `the minutes do not verify on their own: ${v.reason}`);
    else if (v.version !== 2) add('minutes', false, 'these are minutes v1, which name no point of a record: check them with `crossroom verify` alone');
    else if (v.room !== b.room) add('minutes', false, 'the minutes are of another room than this record');
    else if (v.instance !== b.relay) add('minutes', false, 'the minutes name another instance than the relay this record is from');
    else if (headAt(v.seq!) !== v.head) add('minutes', false, `the head the minutes were signed at, event ${v.seq}, is not in this record's chain`);
    else add('minutes', true, `signed with key ${v.fingerprint} at event ${v.seq}, whose head is in this record's chain`);
  }

  for (const s of b.signatures) checkSignature(b, s, headAt, add);

  for (const r of b.receipts) {
    let statement: string | null = null;
    try {
      statement = receiptStatement({ relay: b.relay, room: b.room, seat: r.seat, through: r.through, head: r.head, seen: r.seen, at: r.at });
    } catch {
      statement = null;
    }
    const fp = fingerprintOf(r.key);
    if (!statement || !verifyStatement(r.alg, r.key, statement, r.sig)) add('receipt', false, `a receipt claiming key ${fp} does not verify`);
    else if (headAt(r.through) !== r.head) add('receipt', false, `a receipt by key ${fp} names a head at event ${r.through} that is not this chain's`);
    else add('receipt', true, `a seat's runner, key ${fp}, signed that it received the events through ${r.through}, whose head is this chain's`);
  }

  for (const a of b.attestations) {
    const fp = fingerprintOf(a.key);
    const parsed = statementFields(a.statement);
    const f = parsed?.f;
    const ok =
      parsed?.first === STATEMENT.attest &&
      f?.get('relay') === b.relay &&
      f.get('room') === b.room &&
      seqOf(f.get('seq')) === a.seq &&
      f.get('commit') === commitmentAt.get(a.seq) &&
      f.get('status') === a.status;
    if (!ok) add('attestation', false, `an attestation by key ${fp} is not about a packet of this record`);
    else if (!verifyStatement(a.alg, a.key, a.statement, a.sig)) add('attestation', false, `an attestation claiming key ${fp} does not verify`);
    else
      add('attestation', true, `the packet at event ${a.seq} carries an attestation signed by key ${fp}: its sharing side's own claim about the source, not Crossroom's check`);
  }

  for (const c of b.cosignatures) {
    let statement: string | null = null;
    try {
      statement = cosignStatement({ relay: b.relay, room: b.room, seq: c.seq, head: c.head, role: c.role });
    } catch {
      statement = null;
    }
    const fp = fingerprintOf(c.key);
    const vouched =
      c.certified === 'domain'
        ? 'its domain vouches for the key'
        : c.certified === 'relay-tofu'
          ? 'only the relay vouches for the key, on first use'
          : 'nothing vouches for the key';
    if (!statement || !verifyStatement(c.alg, c.key, statement, c.sig)) add('cosignature', false, `a co-signature claiming key ${fp} does not verify`);
    else if (headAt(c.seq) !== c.head) add('cosignature', false, `a co-signature by key ${fp} names a head at event ${c.seq} that is not this chain's`);
    else add('cosignature', true, `key ${fp} co-signed the head at event ${c.seq} as the ${c.role}; ${vouched} (--org checks whose it is)`);
  }

  return { ok: checks.every((c) => c.ok), head: heads ? heads[n]! : null, checks };
}

/** Minutes v2 or the ledger signature, as the record carries them: rebuilt from their fields, and over a head of this chain. */
function checkSignature(b: RoomRecordBundle, s: RecordSignature, headAt: (seq: number) => string | null, add: (what: RecordCheck['what'], ok: boolean, detail: string) => void) {
  const parsed = statementFields(s.statement);
  const f = parsed?.f;
  const fp = fingerprintOf(s.key);
  const seq = seqOf(f?.get('seq'));
  const kind = parsed?.first === STATEMENT.minutesV2 ? 'minutes' : parsed?.first === STATEMENT.ledger ? 'ledger' : null;
  let canonical = false;
  try {
    if (f && seq !== null && kind) {
      const fields = { alg: s.alg, instance: b.relay, room: b.room, seq, head: f.get('head') ?? '' };
      const rebuilt = kind === 'minutes' ? minutesStatementV2({ ...fields, body: f.get('body') ?? '' }) : ledgerStatement(fields);
      canonical = rebuilt === s.statement && isHex64(f.get('head')) && (kind === 'ledger' || isHex64(f.get('body')));
    }
  } catch {
    canonical = false;
  }
  const what = kind === 'ledger' ? 'chain' : 'minutes';
  if (!kind) return add('minutes', false, `a signature by key ${fp} is over a statement this verifier does not know`);
  if (!canonical || seq === null) return add(what, false, `a signature by key ${fp} is not over this record's relay and room`);
  if (!verifyStatement(s.alg, s.key, s.statement, s.sig)) return add(what, false, `a signature claiming key ${fp} does not verify`);
  if (headAt(seq) !== f!.get('head')) return add(what, false, `a signature by key ${fp} names a head at event ${seq} that is not this chain's`);
  // Whose key it is, the bundle cannot say: `--instance` asks the instance (commands/verify-room.ts).
  add(
    what,
    true,
    kind === 'ledger'
      ? `key ${fp} signed the head at event ${seq} as the relay's ledger signature`
      : `key ${fp} signed minutes over the head at event ${seq}, for a document this view may read`,
  );
}

/**
 * Signed writes (rooms across a connection): each signature verifies over the statement
 * rebuilt from its event, no two writes of one seat share a write nonce (`cn`), and a seat that
 * signs any write signs all of them: an unsigned event of a type `WRITE_OPS` names, from such a
 * seat, is flagged. Whose key it is (certified as a co-signing key is) is `--org`'s question.
 */
function checkWrites(b: RoomRecordBundle, add: (what: RecordCheck['what'], ok: boolean, detail: string) => void) {
  const writeTypes = new Set<string>(Object.values(WRITE_OPS).map((w) => w.type));
  const signers = new Set(b.events.filter((e) => e.sig).map((e) => e.actor));
  if (!signers.size) return;
  const bad: number[] = [];
  const cns = new Map<string, Set<string>>();
  const reused: number[] = [];
  const keys = new Map<string, Set<string>>();
  for (const e of b.events) {
    if (!e.sig) continue;
    let ok = false;
    try {
      ok = verifyStatement(e.sig.alg, e.sig.key, writeStatementFor(b.relay, b.room, e), e.sig.sig);
    } catch {
      ok = false;
    }
    if (!ok) bad.push(e.seq);
    const mine = cns.get(e.actor) ?? new Set<string>();
    if (mine.has(e.sig.cn)) reused.push(e.seq);
    mine.add(e.sig.cn);
    cns.set(e.actor, mine);
    keys.set(e.actor, (keys.get(e.actor) ?? new Set<string>()).add(e.sig.key));
  }
  const unsigned = b.events.filter((e) => !e.sig && signers.has(e.actor) && writeTypes.has(e.type)).map((e) => e.seq);
  const total = b.events.filter((e) => e.sig).length;
  if (bad.length) add('write', false, `the write signature${bad.length === 1 ? '' : 's'} of event${bad.length === 1 ? '' : 's'} ${listed(bad)} ${bad.length === 1 ? 'does' : 'do'} not verify`);
  if (reused.length) add('write', false, `event${reused.length === 1 ? '' : 's'} ${listed(reused)} reuse${reused.length === 1 ? 's' : ''} a write nonce its seat signed before`);
  if (!bad.length && !reused.length) {
    const fps = [...keys.values()].flatMap((k) => [...k]).map(fingerprintOf);
    add('write', true, `${plural(total, 'signed write')} verif${total === 1 ? 'ies' : 'y'}, from ${plural(signers.size, 'seat')} (key${fps.length === 1 ? '' : 's'} ${fps.join(', ')}); --org checks whose keys they are`);
  }
  // A seat whose runner signs its writes signs every one (the runner refuses to receipt a view
  // in which it is the actor of an event it did not sign), so an unsigned one is the relay's.
  if (unsigned.length) add('write', false, `event${unsigned.length === 1 ? '' : 's'} ${listed(unsigned)} ${unsigned.length === 1 ? 'is a write' : 'are writes'} with no signature, from a seat that signs its others`);
}
