/**
 * A write's signature, made on the runner before the call leaves it: what the
 * relay will store for one of the signed operations (`WRITE_OPS`, @parley/shared/chain), predicted
 * from the agent's arguments and the room as the seat sees it, and the seat's signature over that.
 *
 * The prediction is the server's own rules for the fields the writer
 * signs (`writeArgs`: the audience and every payload field the relay does not assign):
 * - a recipient (`to`) resolves by participant id, then seat letter, then name, as
 *   the server's `resolveRecipient` does; with no `to`, a request goes to the only other seat, and a packet
 *   to everyone but a reply in a room of more than two, which goes to the seat that asked;
 * - an absent `why`, `reason`, `source`, `in_reply_to` or `reply_to` is stored as null, an absent
 *   `kind` as `text`, absent `evidence` as `[]`; a tool request's tool by the name its seat offered
 *   it under, its args collapsed to one line;
 * - `position` names a claim by its label, as stored;
 * - `say`'s addressees (`mentions`) come from `resolveMentions`, as the server reads them, and go out
 *   as participant ids in `to` (or `to=all`); the key is absent from the payload when nobody is named.
 * Every one of those defaults then goes out explicitly (`to` as a participant id, the claim's
 * label), so the relay has nothing left to choose, and a relay that stores anything else than what
 * was signed refuses the call or is caught when anyone reads the event.
 *
 * Arguments the prediction cannot read (a recipient that names nobody, an unknown claim, a tool
 * the seat does not offer, a field of the wrong type) are refused here, before anything leaves: a
 * runner that signs its writes sends none unsigned. The words say what to fix, as the relay's would.
 */
import { randomBytes } from 'node:crypto';
import type { ContextRequest } from '@parley/shared';
import { type WriteOp, type WriteSignature, writeArgs, writeArgsDigest, writeStatement } from '@parley/shared/chain';
import { MentionError, matchSeat, resolveMentions } from '@parley/shared/mentions';
import { aboutText } from '@parley/shared/sparse';
import { CLOSE_OUT_FIELDS, closeOutItems, closeOutProblem, findOffer, type Offer, oneLine, slotLetter } from '@parley/shared/text';
import type { StatementSigner } from './signer.js';

/** The room as the seat sees it, as much of it as a prediction reads (from `GET /api/seat`). */
export interface SeatContext {
  /** The room's id. */
  room: string;
  /** The relay's public URL, exactly as its record bundles carry it (`relay`). */
  relay: string;
  /** The seat's own participant id. */
  me: string;
  participants: ReadonlyArray<{ id: string; slot: number; name: string; provider?: string | null; offers?: readonly Offer[] }>;
  /** An end-to-end room, whose text the relay cannot read for mentions. Such a room signs nothing today. */
  e2ee?: boolean;
  claims: ReadonlyArray<{ id: string; label: string }>;
  requests: ReadonlyArray<Pick<ContextRequest, 'id' | 'from'>>;
}

/** The event a write stores, as far as its signature covers it. */
export interface PredictedEvent {
  type: string;
  audience: string;
  payload: Record<string, unknown>;
}

export type Prediction = { ok: true; args: Record<string, unknown>; event: PredictedEvent } | { ok: false; message: string };

const no = (why: string): Prediction => ({ ok: false, message: why });
const str = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown) => v === undefined || v === null || typeof v === 'string';
const optInt = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isInteger(v));
const optList = (v: unknown) => v === undefined || v === null || (Array.isArray(v) && v.every(str));

/** As the server's `resolveRecipient`: an id, then a seat letter, then a name, in separate passes. */
function resolve(ctx: SeatContext, to: unknown, { owner }: { owner: boolean }): { id: string } | { error: string } {
  const others = ctx.participants.filter((p) => p.id !== ctx.me);
  if (to === undefined || to === null || to === '' || to === 'other') {
    if (others.length === 1) return { id: others[0]!.id };
    return { error: `there are ${others.length} other participants, so say which one with to=${others.map((p) => slotLetter(p.slot)).join(' or to=')}` };
  }
  if (!str(to)) return { error: 'to is a seat letter, a name, all or human' };
  if (to === 'all') return { id: 'all' };
  const want = to.trim().toLowerCase();
  if (want === 'human' || want === 'owner') return owner ? { id: 'human' } : { error: 'the session owner already reads everything in this room: use to=all, or a seat' };
  const hit = matchSeat(others, to)[0];
  return hit ? { id: hit.id } : { error: `no participant "${oneLine(to).slice(0, 60)}" here` };
}

/** What a write will store, and its arguments with every default made explicit. */
export function predictWrite(op: WriteOp, args: Record<string, unknown>, ctx: SeatContext): Prediction {
  const a = args;
  switch (op) {
    case 'say': {
      if (!str(a.text) || !optInt(a.reply_to) || !optStr(a.to)) return no('say takes text, to as text, and reply_to as a message number');
      const replyTo = a.reply_to ? String(a.reply_to) : null;
      // Who it is for, by the rule the server applies (`resolveMentions`); then sent as participant
      // ids, or `all`, so the relay resolves nothing of its own.
      let ids: string[];
      try {
        ids = resolveMentions({ text: a.text, to: a.to as string | null | undefined, seats: ctx.participants, me: ctx.me, parseText: !ctx.e2ee }).ids;
      } catch (e) {
        if (e instanceof MentionError) return no(e.message);
        throw e;
      }
      const payload = { text: a.text, replyTo, ...(ids.length ? { mentions: ids } : {}) };
      return { ok: true, args: { ...a, to: ids.length ? ids.join(',') : 'all' }, event: { type: 'message', audience: 'all', payload } };
    }
    case 'request_context': {
      if (!str(a.what) || !optStr(a.why) || !optStr(a.tool) || !optStr(a.args)) return no('request_context takes what, and why, to, tool and args as text');
      const to = resolve(ctx, a.to, { owner: true });
      if ('error' in to) return no(to.error);
      const asked = str(a.tool) ? a.tool.trim() : '';
      const argsText = str(a.args) ? oneLine(a.args) : '';
      let tool: string | null = null;
      if (asked) {
        const seat = ctx.participants.find((p) => p.id === to.id);
        const hit = seat ? findOffer([...(seat.offers ?? [])], asked) : undefined;
        if (!hit) return no(`"${oneLine(asked).slice(0, 40)}" is not a tool that seat offers`);
        tool = hit.name;
      }
      const payload: Record<string, unknown> = { to: to.id, what: a.what, why: a.why ?? null, ...(tool ? { tool, args: argsText || null } : {}) };
      return { ok: true, args: { ...a, to: to.id }, event: { type: 'context_requested', audience: 'all', payload } };
    }
    case 'decline_context': {
      if (!str(a.request_id) || !str(a.reason)) return no('decline_context takes request_id and reason');
      return { ok: true, args: { ...a }, event: { type: 'context_requested', audience: 'all', payload: { requestId: a.request_id, declined: true, reason: a.reason } } };
    }
    case 'share_context': {
      if (!str(a.title) || !str(a.body) || !optStr(a.kind) || !optStr(a.source) || !optStr(a.in_reply_to) || !optStr(a.about))
        return no('share_context takes title and body, and kind, source, in_reply_to and about as text');
      let to: string;
      if (a.to === 'all') to = 'all';
      else if (a.to !== undefined && a.to !== null && a.to !== '') {
        const r = resolve(ctx, a.to, { owner: false });
        if ('error' in r) return no(r.error);
        to = r.id;
      } else if (!a.in_reply_to || ctx.participants.length <= 2) to = 'all';
      else {
        const asked = ctx.requests.find((r) => r.id === a.in_reply_to);
        to = asked && asked.from !== ctx.me && asked.from !== 'human' ? asked.from : 'all';
      }
      // A sparse room's description, as the server stores it: one line, and only where one was given.
      const about = str(a.about) ? aboutText(a.about) : '';
      const payload = { to, kind: a.kind ?? 'text', title: a.title, ...(about ? { about } : {}), body: a.body, source: a.source ?? null, inReplyTo: a.in_reply_to ?? null };
      return { ok: true, args: { ...a, to }, event: { type: 'context_shared', audience: to, payload } };
    }
    case 'claim': {
      if (!str(a.text) || !str(a.stance) || !optStr(a.reason) || !optList(a.evidence)) return no('claim takes text and stance, reason as text and evidence as a list of labels');
      const payload = { claimText: a.text, stance: a.stance, reason: a.reason ?? null, evidence: a.evidence ?? [] };
      return { ok: true, args: { ...a }, event: { type: 'position_updated', audience: 'all', payload } };
    }
    case 'position': {
      if (!str(a.claim) || !str(a.stance) || !optStr(a.reason) || !optList(a.evidence)) return no('position takes claim and stance, reason as text and evidence as a list of labels');
      const ref = a.claim;
      const claim = ctx.claims.find((c) => c.label === ref.toUpperCase()) ?? ctx.claims.find((c) => c.id === ref);
      if (!claim) return no(`unknown claim ${oneLine(ref).slice(0, 20)}`);
      const payload = { label: claim.label, stance: a.stance, reason: a.reason ?? null, evidence: a.evidence ?? [] };
      return { ok: true, args: { ...a, claim: claim.label }, event: { type: 'position_updated', audience: 'all', payload } };
    }
    case 'finish': {
      if (!str(a.summary)) return no('finish takes a summary');
      // The close-out lists as the server stores them: split into items, an empty one left out.
      const lists: Record<string, string[]> = {};
      for (const f of CLOSE_OUT_FIELDS) {
        const v = a[f];
        if (v === undefined || v === null || v === '') continue;
        if (!str(v)) return no(`finish takes ${f} as text, items separated by ";"`);
        const problem = closeOutProblem(f, v);
        if (problem) return no(problem);
        const items = closeOutItems(v);
        if (items.length) lists[f] = items;
      }
      return { ok: true, args: { ...a }, event: { type: 'participant_finished', audience: 'all', payload: { summary: a.summary, ...lists } } };
    }
  }
}

/** A fresh write nonce: 16 random bytes, base64url. */
export const newWriteNonce = (): string => randomBytes(16).toString('base64url');

/**
 * The seat's signature over the event a write will store (`parley/write/v1`). Also what an
 * end-to-end seat's egress signs once it has sealed the arguments, over the envelopes it will
 * store (runner/e2ee-egress.ts).
 */
export function signWrite(
  signer: StatementSigner,
  at: { relay: string; room: string; me: string },
  op: WriteOp,
  event: PredictedEvent,
  o: { cn?: string; at?: string } = {},
): WriteSignature {
  const cn = o.cn ?? newWriteNonce();
  const when = o.at ?? new Date().toISOString();
  const statement = writeStatement({ relay: at.relay, room: at.room, seat: at.me, op, args: writeArgsDigest(writeArgs(op, event)), cn, at: when });
  return { v: 1, alg: signer.alg, op, key: signer.key, cn, at: when, sig: signer.sign(statement) };
}
