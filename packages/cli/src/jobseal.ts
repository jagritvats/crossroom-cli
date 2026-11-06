/**
 * Sealing a job to one runner, node:crypto only: the relay seals, the runner opens.
 *
 *   aad  = `parley/job/v1|${runnerId}|${jobId}|${kind}`
 *   seal:  eph = X25519 keypair; shared = diffieHellman(eph.private, runnerPublic), refused if all
 *          zero (a small-order point); key = hkdfSync('sha256', shared, salt = ephRaw || runnerPubRaw,
 *          info = 'parley/job/v1', 32); AES-256-GCM with a 12-byte iv and the aad
 *          → `j1.${b64u(ephRaw)}.${b64u(iv || ciphertext || tag)}`
 *   open:  the mirror, with the runner's private key (PKCS8, in runner.db).
 *
 * The seal binds the job's id, so the id comes first: whoever queues a job makes it with
 * `newJobId()`, puts it in the payload as `jobId`, seals, and passes the same id to
 * the relay's `JobQueue.enqueue`. The queue never picks one, since the runner refuses a job
 * whose envelope id is not the one it was sealed under.
 *
 * Once the job row is committed the relay forgets the seat token: it keeps `sha(seatToken)` as the
 * seat's `invite_token_hash`, the room key wrapped under that token, and this ciphertext, so a copy
 * of its database cannot take a standing seat.
 *
 * What the seal promises, and what it does not:
 * - Only the holder of the runner's X25519 private key opens it. The salt binds both public keys,
 *   so a ciphertext re-pointed at another runner's key, or given another ephemeral key, opens
 *   nothing.
 * - The AAD binds the runner, the job id and the kind, so a job leased under another envelope
 *   (another runner's lease, another job's id) fails to open, and `openJob` then checks the
 *   payload's own ids against the envelope as well.
 * - Each kind opens only through its own opener, against its own schema: `openJob` a `start_seat`
 *   payload, `openRecheckJob` a `recheck` one. A payload of one kind never opens as the other,
 *   whichever kind its envelope claims.
 * - A small-order public key (either side's) gives an all-zero shared value, which would make the
 *   key a constant anyone can compute. OpenSSL already refuses to derive one; this refuses it again
 *   rather than rely on that.
 * - It does not say who sealed it: anyone with the runner's public key can seal a job to it. The
 *   runner's dispatch check is what proves the job came through its relay: the ask
 *   token's hash and epoch, the relay's origin, and the seat page read back with the seat token.
 *
 * Every failure to open throws a `JobSealError` whose `reason` is the `RunnerReason` the runner
 * reports (`bad_seal` or `envelope_mismatch`), and whose message names no key, token or payload.
 *
 * Here rather than in `@parley/shared`: the shared package has no Node types, and giving it them
 * would change the lockfile. Both the relay and `runner/` import from here.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import { type JobKind, RecheckPayload, StartSeatPayload } from '@parley/shared/runner';

export const JOB_SEAL_PREFIX = 'j1.';
export const JOB_SEAL_INFO = 'parley/job/v1';

/** A payload of either kind, as `sealJob` takes it. */
export type JobPayload = StartSeatPayload | RecheckPayload;

/** What a sealed job is bound to: its runner, its id and its kind. Anything else opens nothing. */
export const jobAad = (runnerId: string, jobId: string, kind: JobKind) => `${JOB_SEAL_INFO}|${runnerId}|${jobId}|${kind}`;

/** A fresh job id in the shape `JOB_ID` checks: random, never derived from the room it serves. */
export const newJobId = (): string => `job_${randomBytes(16).toString('base64url')}`;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** An X25519 key, raw, is 32 bytes: 43 characters of unpadded base64url. */
const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;
/**
 * The longest sealed string `openJob` reads. A `StartSeatPayload` is well under 2 KB at its schema's
 * limits; this leaves room for other kinds without letting a lease hand the runner megabytes.
 */
export const MAX_SEALED_CHARS = 16_384;
/**
 * The longest sealed `recheck` job: it carries the packet bodies it checks (up to eight), so more than a `start_seat` job, and still bounded, since five come in one lease
 * answer. The relay leaves out sources that would take a request past it.
 */
export const MAX_RECHECK_SEALED_CHARS = 262_144;

/** The longest sealed payload of a kind: what `JobQueue.enqueue` and `openJob` accept. */
export const maxSealedChars = (kind: JobKind) => (kind === 'recheck' ? MAX_RECHECK_SEALED_CHARS : MAX_SEALED_CHARS);

/** Why a sealed job did not open: the `RunnerReason` the runner reports for it. */
export class JobSealError extends Error {
  constructor(
    readonly reason: 'bad_seal' | 'envelope_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'JobSealError';
  }
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** Decodes base64url, refusing anything that is not its one canonical spelling. */
function unb64u(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const out = Buffer.from(text, 'base64url');
  return out.toString('base64url') === text ? out : null;
}

/** An X25519 public key from its raw base64url form, or null for anything else. */
function publicFromRaw(raw: string): KeyObject | null {
  if (!RAW_KEY.test(raw) || !unb64u(raw)) return null;
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' });
  } catch {
    return null;
  }
}

const rawOf = (key: KeyObject): Buffer => Buffer.from(String(key.export({ format: 'jwk' }).x), 'base64url');

/**
 * The shared value of an X25519 agreement, refused where it is all zero (a small-order public
 * key) or where the library itself refuses. Compared without an early exit, though nothing secret
 * rides on how long the comparison takes.
 */
function agree(privateKey: KeyObject, publicKey: KeyObject, who: 'seal' | 'open'): Buffer {
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey, publicKey });
  } catch {
    shared = Buffer.alloc(KEY_BYTES);
  }
  let any = 0;
  for (const b of shared) any |= b;
  if (shared.length !== KEY_BYTES || any === 0) {
    const message = 'the key agreement gave no usable secret (a small-order or invalid X25519 key)';
    if (who === 'seal') throw new Error(`cannot seal this job: ${message}`);
    throw new JobSealError('bad_seal', `this job does not open: ${message}`);
  }
  return shared;
}

const jobKey = (shared: Buffer, ephRaw: Buffer, runnerRaw: Buffer) =>
  Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephRaw, runnerRaw]), JOB_SEAL_INFO, KEY_BYTES));

/**
 * A runner's X25519 keypair in the forms the contracts use: the public key raw in base64url (what
 * `RegisterInput.publicKeys.x25519` carries and `sealJob` takes), the private key as PKCS8 DER in
 * base64url (what runner.db keeps and `openJob` takes).
 */
export function newJobKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: b64u(rawOf(publicKey)), privateKey: b64u(privateKey.export({ format: 'der', type: 'pkcs8' })) };
}

/** A payload checked against its own kind's schema, which `kind` picks: nothing else is sealed or opened. */
function parseByKind(payload: unknown, kind: unknown): JobPayload {
  if (kind === 'start_seat') return StartSeatPayload.parse(payload);
  if (kind === 'recheck') return RecheckPayload.parse(payload);
  throw new Error('no job kind is called that');
}

/**
 * Seal a payload to a runner's X25519 public key (raw, base64url), bound to `jobAad` of the payload's
 * own ids and kind. The payload is checked against its kind's schema first (`StartSeatPayload` or
 * `RecheckPayload`), so the relay cannot queue a job the runner would refuse to parse.
 */
export function sealJob(payload: JobPayload, runnerX25519Public: string): string {
  const p = parseByKind(payload, (payload as { kind?: unknown } | null)?.kind);
  const runnerPub = publicFromRaw(runnerX25519Public);
  if (!runnerPub) throw new Error("cannot seal this job: the runner's X25519 public key is not 32 bytes of base64url");
  const eph = generateKeyPairSync('x25519');
  const ephRaw = rawOf(eph.publicKey);
  const key = jobKey(agree(eph.privateKey, runnerPub, 'seal'), ephRaw, rawOf(runnerPub));
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(jobAad(p.runnerId, p.jobId, p.kind), 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(p), 'utf8'), cipher.final()]);
  const sealed = `${JOB_SEAL_PREFIX}${b64u(ephRaw)}.${b64u(Buffer.concat([iv, ct, cipher.getAuthTag()]))}`;
  // Never a seal the queue would refuse to hold or the runner to open.
  if (sealed.length > maxSealedChars(p.kind)) throw new JobTooLarge();
  return sealed;
}

/** A payload whose seal would be longer than its kind allows (`maxSealedChars`). Names nothing of the payload. */
export class JobTooLarge extends Error {
  constructor() {
    super('cannot seal this job: it is longer than a job of its kind may be');
    this.name = 'JobTooLarge';
  }
}

/**
 * Open a sealed `start_seat` job with the runner's X25519 private key (PKCS8, base64url), under the
 * AAD of the envelope the relay leased it in. Throws a `JobSealError` for a seal that does not open
 * (`bad_seal`), or a payload whose own runner, job or kind differ from the envelope's
 * (`envelope_mismatch`): the dispatch check's first two steps. A `recheck` job never opens here,
 * whatever its envelope says: its payload is not a `StartSeatPayload` (`openRecheckJob` opens it).
 */
export function openJob(sealed: string, runnerX25519Private: string, envelope: { runnerId: string; jobId: string; kind: JobKind }): StartSeatPayload {
  const p = openAs(sealed, runnerX25519Private, envelope, 'start_seat');
  return p as StartSeatPayload;
}

/**
 * Open a sealed `recheck` job, as `openJob` opens a `start_seat` one: under its envelope's AAD, so a
 * `start_seat` seal (whose AAD names that kind) never opens here, and its payload checked as a
 * `RecheckPayload` whose own runner, job and kind are the envelope's.
 */
export function openRecheckJob(sealed: string, runnerX25519Private: string, envelope: { runnerId: string; jobId: string; kind: JobKind }): RecheckPayload {
  const p = openAs(sealed, runnerX25519Private, envelope, 'recheck');
  return p as RecheckPayload;
}

function openAs(sealed: string, runnerX25519Private: string, envelope: { runnerId: string; jobId: string; kind: JobKind }, want: JobKind): JobPayload {
  const bad = (why: string) => new JobSealError('bad_seal', `this job does not open: ${why}`);
  if (typeof sealed !== 'string' || sealed.length > maxSealedChars(want) || !sealed.startsWith(JOB_SEAL_PREFIX)) throw bad('it is not a j1. seal');
  const parts = sealed.slice(JOB_SEAL_PREFIX.length).split('.');
  if (parts.length !== 2) throw bad('it is not a j1. seal');
  const ephPub = publicFromRaw(parts[0] as string);
  const body = unb64u(parts[1] as string);
  if (!ephPub) throw bad('its ephemeral key is not an X25519 key');
  if (!body || body.length < IV_BYTES + TAG_BYTES + 1) throw bad('it is too short to hold a job');

  let priv: KeyObject;
  try {
    const der = unb64u(runnerX25519Private);
    if (!der) throw new Error();
    priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch {
    throw bad("the runner's private key is not PKCS8 in base64url");
  }
  if (priv.asymmetricKeyType !== 'x25519') throw bad("the runner's private key is not an X25519 key");

  const key = jobKey(agree(priv, ephPub, 'open'), rawOf(ephPub), rawOf(createPublicKey(priv)));
  let plain: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(jobAad(envelope.runnerId, envelope.jobId, envelope.kind), 'utf8'));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    plain = Buffer.concat([decipher.update(body.subarray(IV_BYTES, body.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw bad('it was sealed to another key, under another envelope, or changed since');
  }

  let payload: JobPayload;
  try {
    // The kind this call opens, never the kind the plaintext names: a payload of the other kind,
    // under an envelope that claims this one, fails its schema here.
    payload = parseByKind(JSON.parse(plain), want);
  } catch {
    throw bad('what it holds is not a job this runner knows');
  }
  if (payload.runnerId !== envelope.runnerId || payload.jobId !== envelope.jobId || payload.kind !== envelope.kind)
    throw new JobSealError('envelope_mismatch', "this job's own runner, id or kind is not its envelope's");
  return payload;
}
