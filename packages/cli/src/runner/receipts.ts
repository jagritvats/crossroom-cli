/**
 * The runner's part of chain v2 for one seat: a `Forwarder` wrapper for a job's
 * route to its relay (runner/proxy.ts), between the policy gate and the relay (the
 * runner's route to the relay is one seam). It
 * - **signs every write** the agent sends, when the seat signs its writes (rooms across a
 *   connection): the event the relay will store is predicted (runner/write-sign.ts), signed, and the
 *   call goes out with every default made explicit and the signature in `_meta`
 *   (`WRITE_SIG_META`), where the relay checks it over the event it is about to store.
 *   A write it cannot predict is refused here; nothing unsigned leaves;
 * - **reads the room back and receipts it**: after a `wait` that delivered something (at most every
 *   `RECEIPT_EVERY_MS`), after `finish` and a share, and when the job settles, it fetches the
 *   seat's own record (`GET /api/seat/record`, which moves nothing), recomputes every commitment of
 *   every event it is shown whole, the head over all of them, and the head at its last receipt, and
 *   checks that each of its own writes since it began signing carries its own signature over that
 *   very event (a `claim_created` or `claim_updated` of its own against the signed
 *   `position_updated` it comes from). Then it signs `parley/receipt/v1` through the head. On any
 *   mismatch it signs nothing, then or later, and reports a dispute (`receipt_disputed`);
 * - **attests the packets it shared** that cite a file, from its checkout (runner/attest.ts);
 * - **co-signs the head** once the room has ended, as its organisation (runner/cosign.ts).
 *
 * Everything after the call runs in the background, one pass at a time, and never delays or changes
 * the agent's answer; a failure is logged in Crossroom's words and the agent goes on. The seat's token
 * travels only in `x-parley-seat`, to the job's own relay, with no redirect followed; nothing here
 * logs a body, a header or a token.
 */
import type { Participant } from '@parley/shared';
import {
  chainNextV2,
  chainStartV2,
  commitmentOf,
  eventEnvelopeV2,
  isHex64,
  isNonce,
  isWriteOp,
  ROOM_RECORD_FORMAT,
  type RoomRecordBundle,
  receiptStatement,
  seenDigest,
  WRITE_OPS,
  type WriteSignature,
  writeStatementFor,
} from '@parley/shared/chain';
import { E2EE_ENVELOPES_HEADER } from '@parley/shared/e2ee';
import { WRITE_SIG_META } from '../cosign/write-wire.js';
import type { DisputeReason } from './dispute-reasons.js';
import { verifyStatement } from '../signing.js';
import { type AttestSource, attestPacket, type SharedPacket } from './attest.js';
import { cosignBody } from './cosign.js';
import { type FetchLike, type Forwarder, gateAnswer, type ProxiedRequest } from './proxy.js';
import type { StatementSigner } from './signer.js';
import { predictWrite, type SeatContext, signWrite } from './write-sign.js';

/** At most one receipt pass this often, but at the end. */
export const RECEIPT_EVERY_MS = 5_000;

// ---------------------------------------------------------------- checking a seat's record

export interface SeatBundleCheckOptions {
  /** The seat's room and its own participant id, as `GET /api/seat` names them. */
  room: string;
  me: string;
  /** The last receipt this runner signed: the head at that point must not have moved. */
  prev?: { through: number; head: string } | null;
  /** When the seat signs its writes: its key, and the last seq before its first signed write. */
  writes?: { key: string; since: number } | null;
}

export type SeatBundleCheck =
  | { ok: true; through: number; head: string; seen: string }
  | { ok: false; reason: DisputeReason; through: number; seqs: number[] };

const WRITE_TYPES: ReadonlySet<string> = new Set(Object.values(WRITE_OPS).map((w) => w.type));

/** Check a seat's record bundle before signing a receipt over it (see the module's comment). */
export function checkSeatBundle(b: RoomRecordBundle, o: SeatBundleCheckOptions): SeatBundleCheck {
  const no = (reason: DisputeReason, seqs: number[] = [], through = Number.isSafeInteger(b?.head?.seq) ? b.head.seq : 0): SeatBundleCheck => ({
    ok: false,
    reason,
    through: Math.max(0, through),
    seqs: seqs.slice(0, 50),
  });
  if (!b || b.format !== ROOM_RECORD_FORMAT || b.view !== 'seat' || b.room !== o.room || !Array.isArray(b.commitments) || !Array.isArray(b.events))
    return no('malformed_record', [], 0);
  // Every head, h_0 to h_n, from the full list of commitments.
  const heads = [chainStartV2(b.room)];
  for (let i = 0; i < b.commitments.length; i++) {
    const entry = b.commitments[i];
    if (!Array.isArray(entry) || entry[0] !== i + 1 || !isHex64(entry[1])) return no('head_mismatch', [i + 1]);
    heads.push(chainNextV2(heads[i]!, entry[0], entry[1]));
  }
  const n = b.commitments.length;
  if (b.head?.seq !== n || b.head.head !== heads[n]) return no('head_mismatch');
  // What it is shown whole recomputes, from the event and its nonce, to its listed commitment.
  const wrong: number[] = [];
  let last = 0;
  for (const e of b.events) {
    if (!Number.isSafeInteger(e?.seq) || e.seq <= last || e.seq > n) return no('malformed_record', [e?.seq].filter(Number.isSafeInteger) as number[]);
    last = e.seq;
    let c: string | null = null;
    try {
      c = isNonce(e.nonce)
        ? commitmentOf(e.nonce, eventEnvelopeV2({ room: b.room, seq: e.seq, type: e.type, actor: e.actor, audience: e.audience, at: e.at, payload: e.payload, sig: e.sig ?? null }))
        : null;
    } catch {
      c = null;
    }
    if (c !== b.commitments[e.seq - 1]![1]) wrong.push(e.seq);
  }
  if (wrong.length) return no('commitment_mismatch', wrong);
  // What it receipted before still stands.
  if (o.prev && heads[o.prev.through] !== o.prev.head) return no('history_changed', [o.prev.through]);
  // Its own writes, from its first signed one on, each carry its own signature over that very event.
  if (o.writes) {
    const { key, since } = o.writes;
    const mine = b.events.filter((e) => e.actor === o.me && e.seq > since);
    const unsigned: number[] = [];
    const forged: number[] = [];
    const cns = new Set<string>();
    const signedPosition = (claimId: unknown, where: (seq: number) => boolean, text?: unknown) =>
      mine.some(
        (p) =>
          p.type === 'position_updated' &&
          !!p.sig &&
          where(p.seq) &&
          (p.payload as { claimId?: unknown }).claimId === claimId &&
          (text === undefined || (p.payload as { claimText?: unknown }).claimText === text),
      );
    for (const e of mine) {
      if (WRITE_TYPES.has(e.type)) {
        const sig = e.sig as WriteSignature | undefined;
        if (!sig) {
          unsigned.push(e.seq);
          continue;
        }
        let holds = false;
        try {
          holds = sig.key === key && WRITE_OPS[sig.op]?.type === e.type && verifyStatement(sig.alg, sig.key, writeStatementFor(b.relay, b.room, e), sig.sig);
        } catch {
          holds = false;
        }
        if (!holds || cns.has(sig.cn)) forged.push(e.seq);
        cns.add(sig.cn);
      } else if (e.type === 'claim_created') {
        const p = e.payload as { claimId?: unknown; text?: unknown };
        if (!signedPosition(p.claimId, (s) => s > e.seq, p.text)) unsigned.push(e.seq);
      } else if (e.type === 'claim_updated') {
        if (!signedPosition((e.payload as { claimId?: unknown }).claimId, (s) => s < e.seq)) unsigned.push(e.seq);
      }
    }
    if (forged.length) return no('forged_write', forged);
    if (unsigned.length) return no('unsigned_write', unsigned);
  }
  const seen = seenDigest(b.events.map((e) => e.seq));
  return { ok: true, through: n, head: heads[n]!, seen };
}

// ---------------------------------------------------------------- the route

export interface SigningOptions {
  /** The relay's base URL, as the job's route reaches it. */
  relay: string;
  seatToken: string;
  fetch: FetchLike;
  signer: StatementSigner;
  /** Sign every write (a seat in a room across a connection). */
  signWrites?: boolean;
  /** Attest the packets this seat shares that cite a file, from this checkout. */
  attest?: AttestSource | null;
  /** Co-sign the room's head once it ends, as this organisation (`org:<domain>` or `org:<id>`). */
  cosignAs?: string | null;
  /** At most one receipt pass this often, but at the end (`RECEIPT_EVERY_MS`). */
  receiptEveryMs?: number;
  now?: () => number;
  /** Told what happened, in Crossroom's words: disputes, refusals, failures. Never a token or a body. */
  log?: (line: string) => void;
}

export interface Dispute {
  reason: DisputeReason;
  through: number;
  seqs: number[];
}

export interface SigningRoute {
  /** The job's forwarder: put it in `proxy.add({ forward })` in place of the relay's own. */
  forward: Forwarder;
  /** Read the room back and receipt it now, and co-sign it if it has ended: at the job's end. */
  settle(): Promise<void>;
  disputes(): readonly Dispute[];
  /** The receipts the relay kept, in order. */
  receipts(): readonly { through: number; head: string }[];
  /** The packets attested, by seq. */
  attested(): readonly number[];
  /** Whether the head was co-signed. */
  cosigned(): boolean;
}

interface RpcCall {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown; _meta?: Record<string, unknown> } & Record<string, unknown>;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The seat view `GET /api/seat` answers with, as far as this reads it. */
interface SeatView {
  seat: string;
  session: { id: string; status: string; e2ee?: boolean };
  participants: Participant[];
  claims: Array<{ id: string; label: string }>;
  contextRequests: Array<{ id: string; from: string }>;
  events?: Array<{ seq: number }>;
}

/** Wrap a job's forwarder (the relay's, after the policy gate) with the seat's signatures. */
export function signingRoute(inner: Forwarder, o: SigningOptions): SigningRoute {
  const base = o.relay.replace(/\/+$/, '');
  const now = o.now ?? Date.now;
  const every = o.receiptEveryMs ?? RECEIPT_EVERY_MS;
  const log = (line: string) => {
    try {
      o.log?.(line);
    } catch {
      /* a logger that throws is not a reason to lose the call */
    }
  };

  let relayUrl: string | null = null;
  /** No receipts, attestations or co-signatures: a v1 room, a seat that is gone, or a dispute raised. */
  let off = false;
  /** Writes go out unsigned: a v1 room or an end-to-end one (whose egress signs over its envelopes). */
  let unsignable = false;
  /** The last seq the seat had seen before its first signed write, once it signed one. */
  let since: number | null = null;
  let last: { through: number; head: string } | null = null;
  let role: 'host' | 'guest' = 'host';
  let lastPass = Number.NEGATIVE_INFINITY;
  let chain: Promise<void> = Promise.resolve();
  let cosignedHead = false;
  const disputes: Dispute[] = [];
  const kept: { through: number; head: string }[] = [];
  const attested = new Set<number>();

  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: any }> => {
    const res = await o.fetch(`${base}${path}`, {
      method,
      headers: { 'x-parley-seat': o.seatToken, accept: 'application/json', ...extra, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
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

  /**
   * The seat page. `envelopes` asks for an end-to-end room as stored (`x-parley-e2ee: envelopes`),
   * which the relay otherwise refuses (409): the write path reads only whether the room is end to end.
   */
  const seatView = async (envelopes = false): Promise<SeatView | null> => {
    const r = await call('GET', '/api/seat', undefined, envelopes ? { [E2EE_ENVELOPES_HEADER]: 'envelopes' } : {});
    if (r.status === 404 || r.status === 401 || r.status === 410) {
      off = true;
      return null;
    }
    return r.status === 200 && r.json?.snapshot ? (r.json.snapshot as SeatView) : null;
  };

  const record = async (): Promise<RoomRecordBundle | null> => {
    const r = await call('GET', '/api/seat/record');
    if (r.status === 409 || r.status === 404) {
      // A v1 room has no record to receipt; a seat that opens nothing is gone.
      off = true;
      unsignable = true;
      return null;
    }
    if (r.status !== 200 || !r.json) return null;
    relayUrl ??= typeof r.json.relay === 'string' ? r.json.relay : null;
    return r.json as RoomRecordBundle;
  };

  /** The room as the seat sees it, for a prediction, or null when this write goes out unsigned. */
  const context = async (): Promise<SeatContext | null> => {
    const v = await seatView(true);
    if (!v) throw new Error('the relay did not show this seat its room');
    if (v.session.e2ee) unsignable = true;
    if (!relayUrl && !unsignable) await record();
    if (unsignable || !relayUrl) return null;
    if (since === null) since = Math.max(0, ...(v.events ?? []).map((e) => e.seq));
    return { room: v.session.id, relay: relayUrl, me: v.seat, participants: v.participants, claims: v.claims, requests: v.contextRequests };
  };

  const pass = async () => {
    if (off) return;
    const v = await seatView();
    if (!v || off) return;
    const b = await record();
    if (!b || off) return;
    const check = checkSeatBundle(b, { room: v.session.id, me: v.seat, prev: last, writes: o.signWrites && !unsignable && since !== null ? { key: o.signer.key, since } : null });
    if (!check.ok) {
      off = true;
      const d: Dispute = { reason: check.reason, through: check.through, seqs: check.seqs };
      disputes.push(d);
      log(`signed no receipt for this seat: the relay's record failed the check (${d.reason}${d.seqs.length ? `, events ${d.seqs.join(', ')}` : ''}); reported as a dispute`);
      const r = await call('POST', '/api/seat/receipts', { dispute: { through: d.through, reason: d.reason, ...(d.seqs.length ? { seqs: d.seqs } : {}) } });
      if (r.status !== 200) log(`the relay did not record the dispute (${r.status})`);
      return;
    }
    if (check.through > (last?.through ?? 0)) {
      const at = new Date(now()).toISOString();
      const statement = receiptStatement({ relay: b.relay, room: b.room, seat: v.seat, through: check.through, head: check.head, seen: check.seen, at });
      const r = await call('POST', '/api/seat/receipts', {
        through: check.through,
        head: check.head,
        seen: check.seen,
        at,
        alg: o.signer.alg,
        key: o.signer.key,
        sig: o.signer.sign(statement),
      });
      if (r.status === 200) {
        last = { through: check.through, head: check.head };
        kept.push(last);
        if (r.json?.role === 'guest' || r.json?.role === 'host') role = r.json.role;
      } else log(`the relay did not keep the receipt through event ${check.through} (${r.status})`);
    }
    if (o.attest)
      for (const e of b.events) {
        if (e.type !== 'context_shared' || e.actor !== v.seat || attested.has(e.seq)) continue;
        attested.add(e.seq);
        const body = await attestPacket(o.attest, { seq: e.seq, commit: b.commitments[e.seq - 1]![1], payload: e.payload as SharedPacket['payload'] }, { relay: b.relay, room: b.room }, o.signer);
        if (!body) continue;
        const r = await call('POST', '/api/seat/attestations', body);
        if (r.status !== 200) log(`the relay did not keep the attestation of event ${e.seq} (${r.status})`);
      }
    if (o.cosignAs && !cosignedHead && v.session.status === 'ended' && last?.through === check.through) {
      const r = await call('POST', '/api/seat/cosign', cosignBody(o.signer, { relay: b.relay, room: b.room, seq: check.through, head: check.head }, role, o.cosignAs));
      if (r.status === 200) cosignedHead = true;
      else log(`the relay did not keep the co-signature (${r.status})`);
    }
  };

  const kick = (final: boolean) => {
    if (off) return chain;
    const t = now();
    if (!final && t - lastPass < every) return chain;
    lastPass = t;
    chain = chain
      .then(() => pass())
      .catch((e: unknown) => log(`could not read the room back to receipt it: ${e instanceof Error ? e.message : 'unknown error'}`));
    return chain;
  };

  /** A tool call answered here, refused, in the era the client speaks. */
  const refuse = (m: RpcCall, req: ProxiedRequest, message: string): Response => {
    const modern = !req.headers.get('mcp-session-id') && typeof m.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === 'string';
    const answer = gateAnswer(m as never, { action: 'refuse', rule: 'signature', message }, modern);
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  };

  const forward: Forwarder = async (req) => {
    let msg: RpcCall | null = null;
    if (req.method === 'POST' && req.body?.length) {
      try {
        const parsed = JSON.parse(decoder.decode(req.body)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as RpcCall).method === 'tools/call') msg = parsed as RpcCall;
      } catch {
        msg = null;
      }
    }
    const name = typeof msg?.params?.name === 'string' ? msg.params.name : null;
    let out = req;
    if (msg && name && o.signWrites && isWriteOp(name)) {
      const args = msg.params?.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) return refuse(msg, req, 'Refused: this call could not be signed, so it was not sent.');
      let ctx: SeatContext | null;
      try {
        ctx = await context();
      } catch {
        return refuse(msg, req, 'Refused: this runner signs every write it sends, and could not read the room to sign this one, so it was not sent. Try again.');
      }
      if (ctx) {
        const p = predictWrite(name, args as Record<string, unknown>, ctx);
        if (!p.ok) return refuse(msg, req, `Refused: this runner signs every write it sends, and could not sign this one (${p.message}), so it was not sent.`);
        const sig = signWrite(o.signer, ctx, name, p.event);
        const params = { ...msg.params, arguments: p.args, _meta: { ...(msg.params?._meta ?? {}), [WRITE_SIG_META]: sig } };
        out = { ...req, body: encoder.encode(JSON.stringify({ ...msg, params })) as Uint8Array<ArrayBuffer> };
      }
    }
    const res = await inner(out);
    if (!name || res.status !== 200 || !(name === 'wait' || name === 'finish' || name === 'share_context')) return res;
    // Read the answer whole, so the next pass knows whether anything was delivered, and hand on the same bytes.
    const text = await res.text();
    const answered = new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    if (name !== 'wait' || text.includes('<<parley:')) void kick(false);
    return answered;
  };

  return {
    forward,
    settle: () => kick(true),
    disputes: () => disputes,
    receipts: () => kept,
    attested: () => [...attested],
    cosigned: () => cosignedHead,
  };
}
