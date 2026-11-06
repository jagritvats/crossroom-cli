/**
 * The runner's end-to-end egress for a seat in an end-to-end project's room: a
 * `Forwarder` wrapper for a job's route to its relay (runner/proxy.ts), last before the relay, in
 * this order: the policy gate, then signing and receipts, then this, then the relay.
 *
 * The relay holds only ciphertext in such a room, and refuses MCP for it (409), so the agent's CLI
 * could not take part on its own. This does it for the agent, on the runner's machine:
 * - **the key:** it asks the relay what the seat's runner may open (`GET /api/seat/e2ee-keys`): the
 *   project key wrapped to this runner's X25519 key (`runner:<id>`, made in a member's browser), each
 *   epoch's previous key under the next (`epoch:<e-1>`), and the room's key under the project key
 *   (`project:<id>:<epoch>`). It opens them with the runner's private key, which never leaves
 *   runner.db, and keeps the room key only if it opens the room's own key check (`e2ee_check`);
 * - **plain MCP to the agent:** it answers the CLI's MCP itself (`initialize`, `tools/list`,
 *   `tools/call`, stateless, on the SDK's own transport), with the ten operations' plaintext schemas
 *   (as the server defines them), so the agent never sees an envelope or a key;
 * - **each call:** it checks the plaintext limits and seals every content argument with the room key
 *   (`RoomCipher.sealArgs`, the `packages/seat` code), refuses what an end-to-end room cannot carry
 *   yet (`E2EE_REFUSED`) before anything is sent, calls the seat's operation itself
 *   (`POST /api/seat/op/:op` with `x-parley-seat`, `?format=json`), opens the answer, and renders it
 *   here with `@parley/shared/render`, the renderer the relay uses for an ordinary room. So the text
 *   the agent reads, fences and all, is made on this machine, and nothing the agent or the other
 *   side wrote reaches the relay but as ciphertext.
 * A seat in an ordinary room goes straight to `inner`, untouched. Whether a room is ordinary is the
 * relay's word the first time this runner asks; once the relay has called a room end to end, the
 * runner records it (runner.db `e2ee_rooms`), and never again believes the room ordinary: a later
 * ordinary answer gets every call refused (`DOWNGRADED`), since a room never stops being end to
 * end and the relay would otherwise read what the agent writes. A seat whose key this runner cannot
 * open yet (no member has given this runner the project's key) gets every call refused in Crossroom's
 * words, and nothing is sent; it asks again at most every `KEY_RETRY_MS`.
 *
 * The seat's token travels only in `x-parley-seat`, to the job's own relay, never with a redirect
 * followed. Nothing here logs a body, a header, a key or a token.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject, randomBytes } from 'node:crypto';
import { E2EE_REFUSED, importRoomKey, RoomCipher, verifyCheck } from '@parley/shared/e2ee';
import {
  briefing,
  type OpData,
  type OpName,
  renderClaimed,
  renderDeclined,
  renderFinished,
  renderPosition,
  renderRequested,
  renderSay,
  renderShared,
  renderStatus,
  renderWait,
} from '@parley/shared/render';
import { SERVER_INFO, TOOL_SURFACE } from '../tool-surface.js';
import type { SeatKeysView } from './seat-keys-view.js';
import { TOOL_NAMES, type ToolName } from '../tool-names.js';
import type { FetchLike, Forwarder, ProxiedRequest } from './proxy.js';

// ---------------------------------------------------------------- the constructions (the browser's too)

/**
 * The project key sealed to one recipient's X25519 key: `jobseal`'s construction, its info and AAD
 * its own. `e1.<b64u(iv)>.<b64u(ephemeral public key ‖ ciphertext ‖ tag)>`, so the column holding it
 * reads as what it is, ciphertext from a browser (`client-cipher`).
 */
export const PROJECT_KEY_INFO = 'parley/project-key/v1';
export const projectKeyAad = (project: string, epoch: number, recipient: string) => `${PROJECT_KEY_INFO}|${project}|${epoch}|${recipient}`;
/** The previous epoch's key under the next one's, AES-256-GCM. */
export const chainAad = (project: string, from: number, to: number) => `parley/project-key-chain/v1|${project}|${from}|${to}`;
/** A room's key (its 32 raw bytes) under the project key at an epoch, AES-256-GCM. */
export const roomKeyAad = (project: string, epoch: number, room: string) => `parley/room-key/v1|${project}|${epoch}|${room}`;

const IV = 12;
const TAG = 16;
const RAW = 32;

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
function unb64u(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const out = Buffer.from(text, 'base64url');
  return out.toString('base64url') === text ? out : null;
}

/** The two parts of an `e1.` value, or null for anything else. */
function parts(v: string): { iv: Buffer; body: Buffer } | null {
  const m = /^e1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/.exec(v);
  const iv = m ? unb64u(m[1]!) : null;
  const body = m ? unb64u(m[2]!) : null;
  return iv && body && iv.length === IV && body.length > TAG ? { iv, body } : null;
}

const xPublic = (raw: Buffer): KeyObject => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(raw) }, format: 'jwk' });
const rawOf = (key: KeyObject): Buffer => Buffer.from(String(key.export({ format: 'jwk' }).x), 'base64url');

function agree(priv: KeyObject, pub: KeyObject): Buffer {
  const shared = diffieHellman({ privateKey: priv, publicKey: pub });
  let any = 0;
  for (const b of shared) any |= b;
  // A small-order public key gives an all-zero secret anyone can compute.
  if (shared.length !== RAW || any === 0) throw new Error('the key agreement gave no usable secret');
  return shared;
}

const derive = (shared: Buffer, eph: Buffer, recipient: Buffer, info: string) => Buffer.from(hkdfSync('sha256', shared, Buffer.concat([eph, recipient]), info, RAW));

/** AES-256-GCM under `key` (32 raw bytes), as an `e1.` value. */
export function sealUnder(key: Uint8Array, plain: Uint8Array, aad: string, iv: Uint8Array = randomBytes(IV)): string {
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG });
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return `e1.${b64u(iv)}.${b64u(ct)}`;
}

/** The mirror of `sealUnder`. Throws for anything that does not open under `key` and `aad`. */
export function openUnder(key: Uint8Array, value: string, aad: string): Buffer {
  const p = parts(value);
  if (!p) throw new Error('not an e1. value');
  const d = createDecipheriv('aes-256-gcm', key, p.iv, { authTagLength: TAG });
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(p.body.subarray(p.body.length - TAG));
  return Buffer.concat([d.update(p.body.subarray(0, p.body.length - TAG)), d.final()]);
}

/** Seal to a recipient's raw X25519 public key (base64url). */
export function sealTo(recipientX25519: string, plain: Uint8Array, info: string, aad: string, o: { iv?: Uint8Array; eph?: KeyObject } = {}): string {
  const raw = unb64u(recipientX25519);
  if (!raw || raw.length !== RAW) throw new Error("the recipient's X25519 key is not 32 bytes of base64url");
  const pub = xPublic(raw);
  const eph = o.eph ?? generateKeyPairSync('x25519').privateKey;
  const ephRaw = rawOf(createPublicKey(eph));
  const key = derive(agree(eph, pub), ephRaw, raw, info);
  const iv = o.iv ?? randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG });
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return `e1.${b64u(iv)}.${b64u(Buffer.concat([ephRaw, ct]))}`;
}

/** Open a value sealed to this runner, with its X25519 private key (PKCS8 DER in base64url, as runner.db keeps it). */
export function openSealed(privatePkcs8: string, value: string, info: string, aad: string): Buffer {
  const p = parts(value);
  if (!p || p.body.length < RAW + TAG + 1) throw new Error('not a sealed key');
  const der = unb64u(privatePkcs8);
  if (!der) throw new Error("the runner's private key is not base64url");
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  if (priv.asymmetricKeyType !== 'x25519') throw new Error("the runner's private key is not an X25519 key");
  const ephRaw = p.body.subarray(0, RAW);
  const key = derive(agree(priv, xPublic(ephRaw)), ephRaw, rawOf(createPublicKey(priv)), info);
  const d = createDecipheriv('aes-256-gcm', key, p.iv, { authTagLength: TAG });
  d.setAAD(Buffer.from(aad, 'utf8'));
  const body = p.body.subarray(RAW);
  d.setAuthTag(body.subarray(body.length - TAG));
  return Buffer.concat([d.update(body.subarray(0, body.length - TAG)), d.final()]);
}

/**
 * The room's key, opened from what the relay holds for this runner: its newest project key, the
 * epochs before it down the chain, then the room's wrap at its epoch. Only a key that opens the
 * room's own check is returned, so a wrap of another room, or of a key the relay chose, opens
 * nothing here. Null when this runner holds no key that opens the room.
 */
export async function openRoomKey(view: SeatKeysView, runnerId: string, runnerKey: string): Promise<string | null> {
  const project = view.project;
  if (!project) return null;
  const recipient = `runner:${runnerId}`;
  const keys = new Map<number, Buffer>();
  for (const w of [...view.projectKeys].filter((k) => k.recipient === recipient).sort((a, b) => b.epoch - a.epoch)) {
    if (keys.has(w.epoch)) continue;
    try {
      const pk = openSealed(runnerKey, w.wrapped, PROJECT_KEY_INFO, projectKeyAad(project, w.epoch, recipient));
      if (pk.length === RAW) keys.set(w.epoch, pk);
    } catch {
      /* not this runner's, or changed since: the next one */
    }
  }
  const chain = new Map(view.chain.map((c) => [c.epoch, c.wrapped]));
  for (const top of [...keys.keys()].sort((a, b) => b - a))
    for (let e = top; e > 1 && keys.has(e) && !keys.has(e - 1) && chain.has(e); e--) {
      try {
        const prev = openUnder(keys.get(e)!, chain.get(e)!, chainAad(project, e - 1, e));
        if (prev.length !== RAW) break;
        keys.set(e - 1, prev);
      } catch {
        break;
      }
    }
  for (const rk of view.roomKeys) {
    const m = /^project:(.+):(\d{1,9})$/.exec(rk.holder);
    if (!m || m[1] !== project) continue;
    const epoch = Number(m[2]);
    const pk = keys.get(epoch);
    if (!pk) continue;
    try {
      const raw = openUnder(pk, rk.wrapped, roomKeyAad(project, epoch, view.room));
      if (raw.length !== RAW) continue;
      const key = b64u(raw);
      if (await verifyCheck(await importRoomKey(key), view.check)) return key;
    } catch {
      /* the next wrap */
    }
  }
  return null;
}

// ---------------------------------------------------------------- the route

/** How often a seat whose key this runner cannot open yet asks the relay again. */
export const KEY_RETRY_MS = 5_000;

export const LOCKED =
  "This room is end-to-end encrypted, and this runner holds no key that opens it yet: a member of the project has to give this runner the project's key (End-to-end encryption, on the project's page). Nothing was sent.";

/** What a seat's calls get once the relay calls a room ordinary that it, or this runner's record, called end to end before. */
export const DOWNGRADED =
  "The relay now says this room is not end-to-end encrypted, though this runner has seen it end to end, and a room never stops being end to end. Nothing was sent: what the agent writes here would reach the relay in the clear.";

/**
 * The rooms this runner has seen end to end (runner.db `e2ee_rooms`), so the relay's word that one
 * is ordinary is never taken after it, by this job or a later one, before or after a restart.
 */
export interface E2eeRoomMemory {
  known(): boolean;
  note(): void;
}

export interface E2eeEgressOptions {
  /** The rooms this runner has seen end to end. Absent: only this egress's own answers count. */
  remember?: E2eeRoomMemory;
  /** The relay's base URL, as the job's route reaches it. */
  relay: string;
  seatToken: string;
  fetch: FetchLike;
  /** This runner's id, as the relay knows it (`runner:<id>` is the recipient it wraps to). */
  runnerId: string;
  /** This runner's X25519 private key, PKCS8 DER in base64url, as runner.db keeps it. */
  runnerKey: string;
  now?: () => number;
  /** Told what happened, in Crossroom's words. Never a token, a key or a body. */
  log?: (line: string) => void;
}

export type EgressMode = 'unknown' | 'plain' | 'e2ee' | 'locked';

export interface E2eeEgress {
  /** The job's forwarder: put it between the signing route (runner/receipts.ts) and the relay's own. */
  forward: Forwarder;
  mode(): EgressMode;
}

type Renderer = (d: never, c: RoomCipher) => Promise<string> | string;
/** What each operation's answer reads as, opened and rendered here: `packages/seat`'s table, without the shell recipes. */
const RENDER: { [K in OpName]?: Renderer } = {
  join: async (d: OpData['join'], c) => briefing(await c.join(d)),
  status: async (d: OpData['status'], c) => renderStatus(await c.status(d)),
  wait: async (d: OpData['wait'], c) => renderWait(await c.wait(d)),
  say: (d: OpData['say']) => renderSay(d),
  request_context: (d: OpData['request_context']) => renderRequested(d),
  decline_context: (d: OpData['decline_context']) => renderDeclined(d),
  share_context: (d: OpData['share_context']) => renderShared(d),
  claim: (d: OpData['claim']) => renderClaimed(d),
  position: (d: OpData['position']) => renderPosition(d),
  finish: (d: OpData['finish']) => renderFinished(d),
};

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true as const });

/** Wrap a job's forwarder (the relay's) with the seat's end-to-end work. */
export function e2eeEgress(inner: Forwarder, o: E2eeEgressOptions): E2eeEgress {
  const base = o.relay.replace(/\/+$/, '');
  const now = o.now ?? Date.now;
  const log = (line: string) => {
    try {
      o.log?.(line);
    } catch {
      /* a logger that throws is not a reason to lose the call */
    }
  };
  let mode: EgressMode = 'unknown';
  /** What a call is answered while no key is open: no key yet, or a relay that went back on its word. */
  let refusal = LOCKED;
  let cipher: RoomCipher | null = null;
  let lastTry = Number.NEGATIVE_INFINITY;
  let settling: Promise<void> | null = null;

  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; json: any }> => {
    const res = await o.fetch(`${base}${path}`, {
      method,
      headers: { 'x-parley-seat': o.seatToken, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };

  // A record that cannot be read counts as having seen the room end to end, so it fails closed.
  const isRemembered = () => {
    try {
      return o.remember?.known() ?? false;
    } catch {
      return true;
    }
  };
  const remember = () => {
    try {
      o.remember?.note();
    } catch {
      log("could not record that this seat's room is end to end");
    }
  };

  /** Learn whether the seat's room is end to end, and open its key if it is. A failure to reach the relay decides nothing. */
  const settle = async () => {
    if (mode === 'locked' && now() - lastTry < KEY_RETRY_MS) return;
    // Asked here rather than of the seat page, which refuses an end-to-end room (409).
    const keys = await call('GET', '/api/seat/e2ee-keys');
    if (keys.status !== 200 || typeof keys.json?.e2ee !== 'boolean') return;
    if (!keys.json.e2ee) {
      // A room is end to end from its creation or never. Once the relay, or this runner's record,
      // has called it end to end, an ordinary answer is a relay asking for the agent's words in the
      // clear: it is refused, and asked again only at the retry interval.
      if (mode === 'locked' || isRemembered()) {
        if (refusal !== DOWNGRADED) log('the relay now calls this seat\'s room ordinary, though it was end to end; nothing is sent');
        mode = 'locked';
        refusal = DOWNGRADED;
        lastTry = now();
        return;
      }
      mode = 'plain';
      return;
    }
    remember();
    mode = 'locked';
    refusal = LOCKED;
    lastTry = now();
    const key = await openRoomKey(keys.json as SeatKeysView, o.runnerId, o.runnerKey);
    if (!key) {
      log('this seat is in an end-to-end room, and no key this runner holds opens it yet');
      return;
    }
    cipher = await RoomCipher.fromKey(key);
    mode = 'e2ee';
  };
  const settleOnce = async () => {
    settling ??= settle()
      .catch((e: unknown) => log(`could not read this seat's room from the relay: ${e instanceof Error ? e.message : 'unknown error'}`))
      .finally(() => {
        settling = null;
      });
    await settling;
  };

  /** One operation, end to end: sealed here, sent, opened and rendered here. */
  const operate = async (name: ToolName, args: Record<string, unknown>, signal: AbortSignal) => {
    const c = cipher;
    if (!c) return fail(refusal);
    const refused = ((E2EE_REFUSED as Partial<Record<string, readonly string[]>>)[name] ?? []).filter((k) => args[k] !== undefined && args[k] !== '');
    if (refused.length) return fail(`${refused.join(' and ')} ${refused.length === 1 ? 'is' : 'are'} not available in end-to-end encrypted rooms yet; nothing was sent.`);
    let sealed: Record<string, unknown>;
    try {
      sealed = await c.sealArgs(name as keyof OpData, args);
    } catch (e) {
      // A plaintext limit, checked here because the relay sees only the envelope's length.
      return fail(`${(e as Error).message}; nothing was sent.`);
    }
    let res: { status: number; json: any };
    try {
      res = name === 'status' ? await call('GET', '/api/seat/op/status', undefined, signal) : await call('POST', `/api/seat/op/${name}`, sealed, signal);
    } catch {
      return fail('The relay did not answer; nothing is known to have been sent. Try again.');
    }
    if (!res.json?.ok) return fail(typeof res.json?.error === 'string' ? res.json.error : `The relay refused the call (HTTP ${res.status}).`);
    const render = RENDER[name];
    if (!render) return fail(`${name} is not a call this runner makes in an end-to-end room.`);
    return ok(await render(res.json.data as never, c));
  };

  /** The agent's MCP, answered here: stateless, one server and transport per request, as the relay's own fallback. */
  const serve = async (req: ProxiedRequest): Promise<Response> => {
    if (req.method !== 'POST')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } }), {
        status: 405,
        headers: { 'content-type': 'application/json', allow: 'POST' },
      });
    const server = new McpServer(
      { ...SERVER_INFO },
      {
        instructions:
          'You are connected to an end-to-end encrypted Crossroom room. Call `join` first to get your briefing, then alternate `say` and `wait` until you `finish` or the session ends; an empty `wait` means call it again.',
      },
    );
    for (const name of TOOL_NAMES) {
      const t = TOOL_SURFACE[name];
      server.registerTool(name, { title: t.title, description: t.description, inputSchema: t.schema, annotations: t.annotations }, async (args: Record<string, unknown>) => {
        try {
          return await operate(name, args, req.signal);
        } catch (e) {
          return fail(e instanceof Error ? e.message : 'the call failed');
        }
      });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      const headers = new Headers(req.headers);
      if (!headers.has('accept')) headers.set('accept', 'application/json, text/event-stream');
      return await transport.handleRequest(new Request('http://127.0.0.1/mcp', { method: 'POST', headers, body: req.body ?? undefined, signal: req.signal }));
    } finally {
      queueMicrotask(() => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    }
  };

  const forward: Forwarder = async (req) => {
    if (mode === 'unknown' || mode === 'locked') await settleOnce();
    if (mode === 'plain') return inner(req);
    // Unknown still (the relay could not be reached): nothing goes out, since in an end-to-end room
    // the agent's words would reach the relay in the clear.
    if (mode === 'unknown')
      return new Response(JSON.stringify({ error: "the relay did not say whether this seat's room is end to end, so nothing was sent" }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    return serve(req);
  };

  return { forward, mode: () => mode };
}
