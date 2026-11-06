/**
 * A runner's identity keys and the tokens it mints, node:crypto only.
 *
 * - **X25519** is what the relay seals each job to (`sealJob`, jobseal.ts). Its private key never
 *   leaves `runner.db`; only the raw public key goes to the relay, in `RegisterInput.publicKeys`.
 * - **Ed25519** is registered beside it, for what the runner signs: a
 *   seat's first jobs may need no signature, but a key the relay pinned at the first registration is what later ones (receipts,
 *   federation) will be checked against, and a key that appears only later proves nothing.
 * - **Ask tokens** are minted here, on the runner, and never by the relay: the relay learns only
 *   `sha256(token)` (`AskDeclaration.hash`). The runner keeps the token itself in `runner.db`, so the
 *   dispatch check can prove that a job came from an ask on a link it issued (`askHash`).
 *
 * Both private keys are PKCS8 DER in base64url, both public keys raw in base64url (43 characters),
 * the forms `newJobKeys` and `RegisterInput` use.
 *
 * `redactTokens` is the one scrub every runner log line and error goes through: the
 * three token shapes a runner handles by prefix, and any other secret by its exact value.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, randomBytes, sign, verify } from 'node:crypto';
import { newJobKeys } from '../jobseal.js';

export interface RunnerKeys {
  /** Raw, base64url: what the relay seals jobs to. */
  x25519Public: string;
  /** PKCS8 DER, base64url: what `openJob` takes. */
  x25519Private: string;
  /** Raw, base64url. */
  ed25519Public: string;
  /** PKCS8 DER, base64url. */
  ed25519Private: string;
}

/** Why a stored key cannot be used. The message names the key's role, never the key. */
export class RunnerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerKeyError';
  }
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const rawPublic = (key: KeyObject): string => String(key.export({ format: 'jwk' }).x);

/** A fresh pair of each: the X25519 pair from jobseal's own generator, so the forms cannot drift. */
export function newRunnerKeys(): RunnerKeys {
  const x = newJobKeys();
  const ed = generateKeyPairSync('ed25519');
  return {
    x25519Public: x.publicKey,
    x25519Private: x.privateKey,
    ed25519Public: rawPublic(ed.publicKey),
    ed25519Private: b64u(ed.privateKey.export({ format: 'der', type: 'pkcs8' })),
  };
}

function privateKeyOf(der: string, type: 'x25519' | 'ed25519'): KeyObject {
  let key: KeyObject;
  try {
    const bytes = Buffer.from(der, 'base64url');
    if (!bytes.length || bytes.toString('base64url') !== der) throw new Error();
    key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  } catch {
    throw new RunnerKeyError(`this runner's ${type} private key is not PKCS8 in base64url`);
  }
  if (key.asymmetricKeyType !== type) throw new RunnerKeyError(`this runner's ${type} private key is not an ${type} key`);
  return key;
}

/**
 * Checks that each private key opens as its kind and derives the public key stored beside it. A
 * runner whose keys disagree would register a public key it cannot open jobs for, and every job
 * sealed to it would be refused as `bad_seal`: better to refuse to start and say which key.
 */
export function checkRunnerKeys(k: RunnerKeys): void {
  for (const type of ['x25519', 'ed25519'] as const) {
    const priv = privateKeyOf(type === 'x25519' ? k.x25519Private : k.ed25519Private, type);
    const pub = type === 'x25519' ? k.x25519Public : k.ed25519Public;
    if (rawPublic(createPublicKey(priv)) !== pub) throw new RunnerKeyError(`this runner's ${type} public key is not its private key's`);
  }
}

/** The public half, in the shape `RegisterInput.publicKeys` takes. */
export const publicKeysOf = (k: RunnerKeys): { x25519: string; ed25519: string } => ({ x25519: k.x25519Public, ed25519: k.ed25519Public });

/** An Ed25519 signature over `data` with this runner's key, base64url. */
export function signAsRunner(k: Pick<RunnerKeys, 'ed25519Private'>, data: string | Uint8Array): string {
  return b64u(sign(null, typeof data === 'string' ? Buffer.from(data, 'utf8') : data, privateKeyOf(k.ed25519Private, 'ed25519')));
}

/** Whether `signature` is this public key's over `data`. False for anything malformed, never a throw. */
export function verifyRunnerSignature(ed25519Public: string, data: string | Uint8Array, signature: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: ed25519Public }, format: 'jwk' });
    return verify(null, typeof data === 'string' ? Buffer.from(data, 'utf8') : data, key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- tokens

/**
 * An ask token as this runner mints it: `ak_` and 32 random bytes in base64url. The prefix is for
 * people and scanners (a token pasted in the wrong place is recognisable); the relay reads the token
 * as opaque bytes and keeps only their hash. It fits the ask link's shape (`ASK_LINK`,
 * commands/ask-link.ts) and `StartSeatPayload.ask.token`.
 */
export const ASK_TOKEN_PREFIX = 'ak_';
export const ASK_TOKEN = /^ak_[A-Za-z0-9_-]{43}$/;
export const newAskToken = (): string => `${ASK_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** What the relay holds for an ask token (`AskDeclaration.hash`), and what the dispatch check looks up. */
export const askHash = (token: string): string => sha256Hex(token);

/** What every redacted token reads as. */
export const REDACTED = '***';

/**
 * Tokens by shape: a runner token (`rt_`), a runner session (`rs_`), an ask token (`ak_`), and a
 * token in a Crossroom path (`/j/<token>`, `/mcp/<token>`, `/ask/<token>`), as the server's
 * hosted runner's `redact` reads paths. A seat token has no prefix of its own, so it is scrubbed by value.
 */
const TOKEN_SHAPES = /\b(?:rt|rs|ak)_[A-Za-z0-9_-]{16,}|(?<=\/(?:j|mcp|ask)\/)[A-Za-z0-9_-]{8,}/g;

/**
 * `text` with every token this runner knows of taken out: each of `known` by its exact value (the
 * runner token, seat tokens, ask tokens, anything else a caller holds), then every token shape.
 * Values under 8 characters are skipped, since they would scrub ordinary words.
 */
export function redactTokens(text: string, known: readonly (string | null | undefined)[] = []): string {
  let out = String(text);
  const values = [...new Set(known.filter((k): k is string => typeof k === 'string' && k.length >= 8))].sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join(REDACTED);
  return out.replace(TOKEN_SHAPES, REDACTED);
}
