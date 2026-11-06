/**
 * Sealing an effect to one runner, node:crypto only: the relay seals, the runner opens.
 *
 * The same construction as a job's seal (jobseal.ts), in a domain of its own:
 *
 *   aad  = `parley/effect/v1|${runnerId}|${effectId}|${kind}`
 *   seal:  eph = X25519 keypair; shared = diffieHellman(eph.private, runnerPublic), refused if all
 *          zero; key = hkdfSync('sha256', shared, salt = ephRaw || runnerPubRaw,
 *          info = 'parley/effect/v1', 32); AES-256-GCM with a 12-byte iv and the aad
 *          → `j1.${b64u(ephRaw)}.${b64u(iv || ciphertext || tag)}`
 *
 * The HKDF info and the AAD differ from a job's, so a sealed job never opens as an effect and a
 * sealed effect never opens as a job: a relay cannot replay one kind of instruction as the other.
 * The prefix stays `j1.`, since it names the envelope (and `effects.payload` is classified
 * `runner-cipher` for that shape), not what is inside it.
 *
 * What the seal does not say, as for jobs, is who sealed it: anyone with the runner's public key
 * can seal an effect to it. The runner's own checks (runner/effects/loop.ts) are what make an
 * effect one it posts: the envelope, the relay, the clock, and above all its own policy
 * (`effects.yml`), which no relay can widen.
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
import { EFFECT_SEALED_MAX, type EffectKindName, EffectPayload } from './wire.js';

export const EFFECT_SEAL_PREFIX = 'j1.';
export const EFFECT_SEAL_INFO = 'parley/effect/v1';

/** What a sealed effect is bound to: its runner, its id and its kind. */
export const effectAad = (runnerId: string, effectId: string, kind: string) => `${EFFECT_SEAL_INFO}|${runnerId}|${effectId}|${kind}`;

/** Why a sealed effect did not open: the code the runner reports for it. */
export class EffectSealError extends Error {
  constructor(
    readonly code: 'bad_seal' | 'envelope_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'EffectSealError';
  }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

function unb64u(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const out = Buffer.from(text, 'base64url');
  return out.toString('base64url') === text ? out : null;
}

function publicFromRaw(raw: string): KeyObject | null {
  if (!RAW_KEY.test(raw) || !unb64u(raw)) return null;
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' });
  } catch {
    return null;
  }
}

const rawOf = (key: KeyObject): Buffer => Buffer.from(String(key.export({ format: 'jwk' }).x), 'base64url');

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
    if (who === 'seal') throw new Error(`cannot seal this effect: ${message}`);
    throw new EffectSealError('bad_seal', `this effect does not open: ${message}`);
  }
  return shared;
}

const derive = (shared: Buffer, ephRaw: Buffer, runnerRaw: Buffer) =>
  Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephRaw, runnerRaw]), EFFECT_SEAL_INFO, KEY_BYTES));

/**
 * Seal an effect to a runner's X25519 public key (raw, base64url), bound to `effectAad` of the
 * payload's own ids. The payload is checked first, so the relay never queues an effect its runner
 * could not read.
 */
export function sealEffect(payload: EffectPayload, runnerX25519Public: string): string {
  const p = EffectPayload.parse(payload);
  return sealText(JSON.stringify(p), effectAad(p.runnerId, p.effectId, p.kind), runnerX25519Public, 'effect');
}

/**
 * Open a sealed effect with the runner's X25519 private key (PKCS8, base64url), under the AAD of
 * the envelope it was leased in. Throws `EffectSealError`: `bad_seal` for one that does not open,
 * `envelope_mismatch` for a payload whose own runner, id or kind differ from the envelope's.
 */
export function openEffect(sealed: string, runnerX25519Private: string, envelope: { runnerId: string; effectId: string; kind: EffectKindName | string }): EffectPayload {
  const bad = (why: string) => new EffectSealError('bad_seal', `this effect does not open: ${why}`);
  const plain = openSealedText(sealed, runnerX25519Private, effectAad(envelope.runnerId, envelope.effectId, envelope.kind), bad, 'an effect');

  let payload: EffectPayload;
  try {
    payload = EffectPayload.parse(JSON.parse(plain));
  } catch {
    throw bad('what it holds is not an effect this runner knows');
  }
  if (payload.runnerId !== envelope.runnerId || payload.effectId !== envelope.effectId || payload.kind !== envelope.kind)
    throw new EffectSealError('envelope_mismatch', "this effect's own runner, id or kind is not its envelope's");
  return payload;
}

// ---------------------------------------------------------------- any JSON, sealed to a runner

/**
 * `text` sealed to a runner's X25519 key under `aad`, as an effect is (`j1.`): what a tracker read
 * on the relay is sealed with. `what` names it in an error. At most `EFFECT_SEALED_MAX`.
 */
export function sealText(text: string, aad: string, runnerX25519Public: string, what: string): string {
  const runnerPub = publicFromRaw(runnerX25519Public);
  if (!runnerPub) throw new Error(`cannot seal this ${what}: the runner's X25519 public key is not 32 bytes of base64url`);
  const eph = generateKeyPairSync('x25519');
  const ephRaw = rawOf(eph.publicKey);
  const key = derive(agree(eph.privateKey, runnerPub, 'seal'), ephRaw, rawOf(runnerPub));
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const sealed = `${EFFECT_SEAL_PREFIX}${b64u(ephRaw)}.${b64u(Buffer.concat([iv, ct, cipher.getAuthTag()]))}`;
  if (sealed.length > EFFECT_SEALED_MAX) throw new Error(`cannot seal this ${what}: it is larger than an effect may be`);
  return sealed;
}

/** The text `sealText` sealed, opened with the runner's private key under the same `aad`; `bad` makes the refusal. */
export function openSealedText(sealed: string, runnerX25519Private: string, aad: string, bad: (why: string) => Error, what: string): string {
  if (typeof sealed !== 'string' || sealed.length > EFFECT_SEALED_MAX || !sealed.startsWith(EFFECT_SEAL_PREFIX)) throw bad('it is not a j1. seal');
  const parts = sealed.slice(EFFECT_SEAL_PREFIX.length).split('.');
  if (parts.length !== 2) throw bad('it is not a j1. seal');
  const ephPub = publicFromRaw(parts[0] as string);
  const body = unb64u(parts[1] as string);
  if (!ephPub) throw bad('its ephemeral key is not an X25519 key');
  if (!body || body.length < IV_BYTES + TAG_BYTES + 1) throw bad(`it is too short to hold ${what}`);
  let priv: KeyObject;
  try {
    const der = unb64u(runnerX25519Private);
    if (!der) throw new Error();
    priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch {
    throw bad("the runner's private key is not PKCS8 in base64url");
  }
  if (priv.asymmetricKeyType !== 'x25519') throw bad("the runner's private key is not an X25519 key");
  let key: Buffer;
  try {
    key = derive(agree(priv, ephPub, 'open'), rawOf(ephPub), rawOf(createPublicKey(priv)));
  } catch (e) {
    if (e instanceof EffectSealError) throw bad('the key agreement gave no usable secret (a small-order or invalid X25519 key)');
    throw e;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([decipher.update(body.subarray(IV_BYTES, body.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw bad('it was sealed to another key, under another envelope, or changed since');
  }
}
