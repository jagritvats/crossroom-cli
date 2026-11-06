/**
 * Deterministic minutes: generated from the ledger, never from a model.
 *
 * The shape is deliberate. A reader who only takes in the first screen should learn what happened:
 * what each seat came away with, what was decided, who does what, what is still open and what was
 * shared — so that block comes first and the transcript comes last. A room is as often a hand-over,
 * a meeting or a piece of coordination as a dispute, so claims, where a room made any, follow as a
 * block of their own: what was settled, ruled out, who moved and why. Everything in it is derived
 * from events that actually happened; where the ledger is thin the minutes say so rather than
 * smoothing it over.
 *
 * The derivation lives in `ledgerSummary`, on its own, because the document is not the only
 * thing that reports it: a PR digest and a JSON export have to say the same thing about the
 * same room, and a second copy of "which claims counted as established" drifts from this one
 * within a week. `minutes` renders a summary; it does not compute one.
 */
import { attestationBracket, type PacketAttested } from './attestation.js';
import { boardPretty } from './board.js';
import { LANE_KIND_WORDS, LANE_PRIORITY_WORDS, LANE_STATE_WORDS, LANE_VIA_WORDS, laneLabel } from './lane.js';
import { matchSeat } from './mentions.js';
import { SUBROOM_STATE_WORDS } from './subrooms.js';
import { COMPLIANCE_MINUTES_ROOM } from './enterprise.js';
import type { Claim, ContextItem, ContextRequest, Participant, Position, SessionSnapshot, Stance } from './index.js';
// From text.ts, not index.ts: the browser renders minutes, and index.ts loads zod.
import { type CloseOut, closeOutOf, LINE_BREAK, oneLine, ROLE_BY_TEAM, runText, slotLetter, sourceCheckPhrase, sourceCheckTag } from './text.js';

/**
 * A fact's label in a project's record (`FACT_LABEL` in record.ts, which this copies because
 * record.ts loads zod and the browser renders minutes; a test holds the two
 * equal). A position citing one cites a prior fact, never a packet of this room.
 */
export const PRIOR_FACT_LABEL = /^[FQD][1-9][0-9]{0,5}$/;

// ---------------- the derivation ----------------

/** A claim with the last thing each participant said about it. */
export interface ClaimLine {
  claim: Claim;
  latest: Position[];
}

/** A `claim_updated` event, read back into the shape the renderers need. */
export interface Concession {
  claimId: string;
  claimLabel: string;
  participantId: string;
  name: string;
  /** 'withdrawn' is the claim's own author now opposing it; 'conceded' is crossing to the other side. */
  kind: 'conceded' | 'withdrawn';
  from: Stance | null;
  to: Stance | null;
  reason: string | null;
  evidence: string[];
}

/** A participant changing their mind about a claim, with the concession it was recorded as. */
export interface PositionChange {
  claimId: string;
  claimLabel: string;
  participantId: string;
  name: string;
  from: Stance;
  to: Stance;
  reason: string | null;
  evidence: string[];
  at: string;
  concession: Concession | null;
}

/**
 * A claim whose own author argued against it from the very first position.
 *
 * This is not a concession — nobody moved, so `PositionChange` will never describe it — but it
 * is often the strongest thing in the room: someone wrote down the case against their own side
 * and then took it apart, usually with evidence they had just been handed. Without this the
 * first screen says "Nobody changed position" and the reader learns nothing about it.
 */
export interface AuthorAgainstOwnClaim {
  claim: Claim;
  name: string;
  reason: string | null;
  evidence: string[];
}

/**
 * One seat's part in the room, counted from the ledger.
 *
 * A record, not a score. It is printed per seat, in seat order, and nothing sums it, ranks it
 * or compares it across rooms. What it counts was chosen against the 2026 debate literature:
 * most changes of position are instability or conformity, not evidence, so a
 * move only reads as a virtue when the ledger shows what moved it. `movedOnOthers` is that case
 * — the seat cited a packet someone else shared, which is evidence crossing the boundary and
 * changing a mind. A move citing nothing is printed as exactly that. There is nothing
 * here for winning, persuading or holding firm: the first two reward the failure the research
 * describes, and the third cannot be told from stubbornness without ground truth.
 */
export interface SeatRecord {
  participantId: string;
  name: string;
  joined: boolean;
  /** Packets this seat shared, and how many named where they came from. */
  packets: number;
  sourced: number;
  /** Context requests addressed to this seat, and what became of them. */
  asked: number;
  answered: number;
  declined: number;
  /** Claims this seat put on the record. */
  claims: number;
  /** Changes of position, split by what each one cited. */
  moves: number;
  movedOnOthers: number;
  /**
   * Moves on a packet the owner shared, and on no other seat's. Kept apart from `movedOnOthers`
   * because the owner answering is not evidence crossing between two independent agents.
   */
  movedOnOwner: number;
  /**
   * Moves on a prior fact from the project's record (F14, Q3, D2), and on no other seat's packet
   * and no packet of the owner's. Its own clause, like the owner's packet: a fact was filed from an
   * earlier room, so it is never evidence crossing in this one.
   */
  movedOnFact: number;
  /** The fact labels those moves cited, in the order they were first cited. */
  factsCited: string[];
  movedOnOwn: number;
  movedOnNothing: number;
  /**
   * Claims raised by someone else that this seat supported with its very first position,
   * citing nothing: agreement before any evidence, the nearest the ledger comes to measuring
   * sycophancy.
   */
  agreedUncited: number;
  /** Whether the room had any claim: where it had none, the record says nothing about positions. Absent counts as yes. */
  claimsInRoom?: boolean;
}

/** Something the meeting did not finish. `text` is the one wording every surface uses. */
export interface OpenThread {
  kind: 'unpositioned' | 'unanswered' | 'declined' | 'not-ended';
  text: string;
}

export interface LedgerSummary {
  /** Unanimous support, and unanimous opposition. Two different findings, never one list. */
  established: ClaimLine[];
  ruledOut: ClaimLine[];
  disputed: ClaimLine[];
  unpositioned: ClaimLine[];
  /**
   * Claims the owner ruled on after the room ended. They leave the four lists above, which say
   * what the agents settled among themselves, and each keeps the status the agents left it in,
   * so the minutes can say both: what the agents found, and what the owner decided.
   */
  settled: ClaimLine[];
  changes: PositionChange[];
  /** Claims the author opposed from the outset. Reported beside `changes`, never instead of it. */
  authorAgainst: AuthorAgainstOwnClaim[];
  concessions: Concession[];
  declined: ContextRequest[];
  unanswered: ContextRequest[];
  /**
   * Packets an agent shared and named where they came from — the only ones that carry
   * provenance across the boundary. The owner's own packets are not among them: they are the
   * owner answering, and counting them would let a room one person fed look like two agents
   * showing each other evidence.
   */
  sourcedPackets: ContextItem[];
  /** Packet labels some position cited. */
  cited: string[];
  openThreads: OpenThread[];
  /** One per seat, in seat order. */
  records: SeatRecord[];
  /** Wall time between the first join and the end, once both are known. */
  duration: string | null;
  agentMessages: number;
  otherMessages: number;
  /**
   * Why this record establishes nothing, or null. A meeting where nothing crossed the
   * boundary and nothing was contested is one a single model could have written by itself.
   */
  thinRecord: string | null;
}

/**
 * How a participant, the human or Crossroom itself is named in a sentence.
 *
 * `oneLine`, because a seat name reaches this document from two directions: the agent's own
 * `join`, which the server's `seatName` already collapses, and whatever the owner typed when they
 * opened the room, which nothing collapses. Every name here sits mid-sentence on a single
 * line, so this is the one place to be sure of it.
 */
const namer = (snap: SessionSnapshot) => (id: string) =>
  id === 'human'
    ? 'Human'
    : id === 'system'
      ? 'Crossroom'
      : id === 'all'
        ? 'everyone'
        : oneLine(snap.participants.find((p) => p.id === id)?.name ?? id);

/**
 * Participant-authored text, on one line.
 *
 * A claim, a packet title, a position's reason, the wording of an open thread: all typed by an
 * agent, all ending up inside a list bullet or mid-sentence. Left as written, a blank line
 * closes the bullet and everything after it is parsed as markdown in its own right — so a claim
 * containing `## Established` puts a heading into a document the owner publishes under their own
 * name, and the digest exists to be posted to a pull request. Collapsing the whitespace is what
 * keeps a bullet a bullet.
 *
 * `oneLine` rather than a local `\s+` collapse: JavaScript's `\s` does not include NEL (U+0085),
 * and the repository already has one answer to "participant text on a single line". This is it.
 *
 * Only for one-line contexts. Where the text is meant to keep its shape, `quote` fences it
 * instead. Every interpolation of participant text in this file goes through one or the other,
 * and a test fails if a new one goes through neither.
 */
const inline = oneLine;
/** A packet's description in a sparse room, after the rest of its line; nothing for a packet with none. */
const aboutTail = (i: ContextItem) => (i.about ? ` — about: ${clip(i.about, 280)}` : '');

const clip = (text: string, max: number) => {
  const one = inline(text);
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/**
 * A tool call as inline code, which its arguments cannot close. A backtick in them would end the
 * span early and hand the rest to the markdown parser, so it becomes a quote mark: the web's own
 * parser, like most, only knows single-backtick spans.
 */
const call = (tool: string, args: string | null) => `\`${clip(runText(tool, args), 300).replace(/`/g, "'")}\``;

/** How a request is described wherever the minutes name one. */
const askedFor = (r: ContextRequest, name: (id: string) => string) =>
  r.tool ? `asked ${name(r.to)} to run ${call(r.tool, r.args)}` : `asked ${name(r.to)} for "${clip(r.what, 300)}"`;

const isConcessionKind = (kind: unknown): kind is Concession['kind'] => kind === 'conceded' || kind === 'withdrawn';

/**
 * Whether a packet named a source, in any view. A direct packet read by someone who is not the
 * owner has its source blanked and `sourced` set instead, and still counts.
 */
const hasSource = (i: ContextItem) => !!i.source || i.sourced === true;

/** The last thing each participant said about one claim. */
function latestPerParticipant(positions: Position[], claim: Claim): Position[] {
  const last = new Map<string, Position>();
  for (const p of positions.filter((x) => x.claimId === claim.id)) last.set(p.participantId, p);
  return [...last.values()];
}

/** Wall time in the shape a reader skims rather than parses. */
function describeDuration(fromIso: string | null, toIso: string | null): string | null {
  if (!fromIso || !toIso) return null;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`;
}

/**
 * Everything the minutes report, derived once.
 *
 * Pure: a snapshot in, a value out. It is therefore also what the `public` snapshot produces
 * when that is what it is handed — the redaction happens in `core.snapshot`, never here.
 */
export function ledgerSummary(snap: SessionSnapshot): LedgerSummary {
  const { session: s, messages, contextRequests, contextItems, claims, positions } = snap;
  const name = namer(snap);
  const line = (claim: Claim): ClaimLine => ({ claim, latest: latestPerParticipant(positions, claim) });

  // Only the two kinds that are concessions. `claim_updated` means "something happened to a
  // claim that no single position describes", and defaulting every unknown kind to 'conceded'
  // would report whatever it comes to carry as a participant giving way. (An owner ruling is a
  // `claim_settled` event, never this one.) A missing kind is the one legacy shape, from before
  // kinds existed.
  const concessions: Concession[] = snap.events
    .filter((e) => e.type === 'claim_updated' && isConcessionKind((e.payload as any).kind ?? 'conceded'))
    .map((e) => {
      const p = e.payload as any;
      return {
        claimId: String(p.claimId),
        claimLabel: String(p.label ?? '?'),
        participantId: e.actor,
        name: String(p.byName ?? name(e.actor)),
        kind: (p.kind ?? 'conceded') as Concession['kind'],
        from: (p.from ?? null) as Stance | null,
        to: (p.to ?? null) as Stance | null,
        reason: (p.reason ?? null) as string | null,
        evidence: Array.isArray(p.evidence) ? (p.evidence as string[]) : [],
      } satisfies Concession;
    });

  // Each move is paired with at most one concession, and a concession is spent once it is
  // paired: the same participant can cross the same claim twice, and reusing one event for
  // both moves would report a concession that did not happen the second time.
  const spent = new Set<Concession>();
  const changes: PositionChange[] = positions
    .filter((p) => p.previousStance && p.previousStance !== p.stance)
    .map((p) => {
      const claim = claims.find((c) => c.id === p.claimId);
      const hit =
        concessions.find(
          (x) =>
            !spent.has(x) &&
            x.claimId === p.claimId &&
            x.participantId === p.participantId &&
            x.from === p.previousStance &&
            x.to === p.stance,
        ) ?? null;
      if (hit) spent.add(hit);
      return {
        claimId: p.claimId,
        claimLabel: claim?.label ?? '?',
        participantId: p.participantId,
        name: name(p.participantId),
        from: p.previousStance as Stance,
        to: p.stance,
        reason: p.reason,
        evidence: p.evidence,
        at: p.createdAt,
        concession: hit,
      } satisfies PositionChange;
    });

  const declined = contextRequests.filter((r) => r.status === 'declined');
  const unanswered = contextRequests.filter((r) => r.status === 'open');
  const sourcedPackets = contextItems.filter((i) => hasSource(i) && i.from !== 'human');
  const isSettled = (c: Claim) => !!c.resolution;
  const byAgents = (status: Claim['status']) => claims.filter((c) => c.status === status && !isSettled(c)).map(line);
  const unpositioned = byAgents('open');

  const openThreads: OpenThread[] = [];
  for (const c of unpositioned)
    openThreads.push({
      kind: 'unpositioned',
      text: `${c.claim.label} has no position from at least one side: ${clip(c.claim.text, 300)}`,
    });
  for (const r of unanswered) {
    // An open request is not always an ignored one: agents routinely share the answer without
    // setting in_reply_to. Saying "never got an answer" when a packet did come back would be
    // wrong, and inferring the link in the ledger would be a guess. So report what is known:
    // nothing came back at all, or something did and was never tied to the request.
    const after = contextItems.filter((i) => i.from === r.to && i.createdAt > r.createdAt);
    openThreads.push({
      kind: 'unanswered',
      text: after.length
        ? `${name(r.from)} ${askedFor(r, name)}. ${name(r.to)} shared ${after.map((i) => i.label).join(', ')} afterwards but never marked the request answered.`
        : `${name(r.from)} ${askedFor(r, name)} and never got an answer.`,
    });
  }
  for (const r of declined)
    openThreads.push({
      kind: 'declined',
      text: r.tool
        ? `${name(r.to)} declined to run ${call(r.tool, r.args)} ("${clip(r.what, 300)}").`
        : `${name(r.to)} declined "${clip(r.what, 300)}".`,
    });
  if (s.status !== 'ended')
    openThreads.push({ kind: 'not-ended', text: 'The session has not ended, so this record is not final.' });

  // The author's own stance on their own claim, where they never moved off it. `previousStance`
  // is null for a first position, so this is exactly "opposed it from the outset" rather than
  // "came round to opposing it", which is a concession and is already reported as one.
  const authorAgainst: AuthorAgainstOwnClaim[] = [];
  for (const c of claims) {
    const own = positions.filter((p) => p.claimId === c.id && p.participantId === c.createdBy);
    const first = own[0];
    if (own.length === 1 && first && first.stance === 'oppose' && !first.previousStance)
      authorAgainst.push({ claim: c, name: name(c.createdBy), reason: first.reason, evidence: first.evidence });
  }

  // A room only one agent ever entered is the thinnest record there is, whatever it contains:
  // every packet in it came from the same filesystem, so nothing crossed a boundary and the
  // document cannot be evidence of anything two independent agents established. A room with no
  // claim is not thin for that: claims are a layer a room may use, and a hand-over or a meeting
  // whose seats showed each other sourced packets is as good a record as a settled dispute.
  const joined = snap.participants.filter((p) => p.joinedAt).length;
  const ownerSourced = contextItems.some((i) => i.from === 'human' && hasSource(i));
  const missing = [
    joined < 2 ? 'only one agent ever joined, so nothing crossed between two of them' : '',
    !sourcedPackets.length
      ? ownerSourced
        ? "no agent shared a context packet with a source (the owner's own packets do not count: they did not cross between the agents)"
        : 'no context packet was shared with a source'
      : '',
  ].filter(Boolean);

  // Who shared each packet, by label. Read from the fields the public view keeps (label and
  // sender survive the redaction of a direct share), so the record reads the same to any viewer.
  const sharedBy = new Map(contextItems.map((i) => [i.label, i.from]));
  // A label no packet of this room carries, in the shape the record files facts under, is a prior
  // fact that `record` showed the seat (the server's `citable` hook is the only way one is cited).
  const isFact = (label: string) => !sharedBy.has(label) && PRIOR_FACT_LABEL.test(label);
  const records: SeatRecord[] = [...snap.participants]
    .sort((a, b) => a.slot - b.slot)
    .map((p) => {
      const mine = contextItems.filter((i) => i.from === p.id);
      const asked = contextRequests.filter((r) => r.to === p.id);
      const moves = changes.filter((ch) => ch.participantId === p.id);
      // Another agent's packet outranks the owner's, which outranks a prior fact, which outranks
      // the seat's own: a move is counted once, under the strongest thing it cited. Neither the
      // owner's packet nor a fact is evidence crossing between the agents in this room.
      const by = (label: string) => sharedBy.get(label) ?? p.id;
      const other = (l: string) => by(l) !== p.id && by(l) !== 'human';
      const owner = (l: string) => by(l) === 'human';
      const onOthers = moves.filter((ch) => ch.evidence.some(other)).length;
      const onOwner = moves.filter((ch) => ch.evidence.some(owner) && !ch.evidence.some(other)).length;
      const onFact = moves.filter((ch) => ch.evidence.some(isFact) && !ch.evidence.some(owner) && !ch.evidence.some(other));
      const onNothing = moves.filter((ch) => !ch.evidence.length).length;
      // A first position on a claim someone else raised: `previousStance` is null exactly once
      // per seat and claim, on the position that opened its stance.
      const agreedUncited = positions.filter(
        (x) =>
          x.participantId === p.id &&
          !x.previousStance &&
          x.stance === 'support' &&
          !x.evidence.length &&
          claims.some((c) => c.id === x.claimId && c.createdBy !== p.id),
      ).length;
      return {
        participantId: p.id,
        name: name(p.id),
        joined: !!p.joinedAt,
        packets: mine.length,
        sourced: mine.filter(hasSource).length,
        asked: asked.length,
        answered: asked.filter((r) => r.status === 'fulfilled').length,
        declined: asked.filter((r) => r.status === 'declined').length,
        claims: claims.filter((c) => c.createdBy === p.id).length,
        moves: moves.length,
        movedOnOthers: onOthers,
        movedOnOwner: onOwner,
        movedOnFact: onFact.length,
        factsCited: [...new Set(onFact.flatMap((ch) => ch.evidence.filter(isFact)))],
        movedOnOwn: moves.length - onOthers - onOwner - onFact.length - onNothing,
        movedOnNothing: onNothing,
        agreedUncited,
        claimsInRoom: claims.length > 0,
      } satisfies SeatRecord;
    });

  const agentMessages = messages.filter((m) => m.kind === 'say').length;
  return {
    established: byAgents('agreed'),
    ruledOut: byAgents('rejected'),
    disputed: byAgents('disputed'),
    unpositioned,
    settled: claims.filter(isSettled).map(line),
    changes,
    authorAgainst,
    concessions,
    declined,
    unanswered,
    sourcedPackets,
    cited: [...new Set(positions.flatMap((p) => p.evidence))],
    openThreads,
    records,
    duration: describeDuration(s.startedAt, s.endedAt),
    agentMessages,
    otherMessages: messages.length - agentMessages,
    // The whole sentence, not a fragment: the renderers used to append "between the two
    // agents", which is untrue of the one case that matters most, a room with a single agent.
    thinRecord: missing.length ? `${missing.join(', and ')}, so nothing here rests on evidence that crossed between independent agents.` : null,
  };
}

// ---------------- rendering ----------------

/**
 * 'full' is the document the owner reads and downloads; 'digest' is the PR comment; 'slack' and
 * 'teams' are the same digest as text to paste into Slack or a Microsoft Teams chat.
 */
export type MinutesStyle = 'full' | 'digest' | 'slack' | 'teams';

/** The styles that are a chat paste: unsigned, unanchored, read from the room with its backticks as quote marks. */
export const isChatPaste = (style: MinutesStyle | undefined): style is 'slack' | 'teams' => style === 'slack' || style === 'teams';

export interface MinutesOptions {
  style?: MinutesStyle;
  /**
   * Origin the room link points at. Defaults to the instance's own `publicUrl`; an argument
   * because a document written on one host is often read behind another name, and guessing
   * that would be worse than being told.
   */
  baseUrl?: string;
  /**
   * Where the room's latest anchored head stands, or null for none. The minutes print one
   * line about it, written by Crossroom alone, at the end of the body; never in the Slack text.
   */
  anchoring?: MinutesAnchoring | null;
}

/** A room's latest anchor as the relay reads it from its anchor store. */
export interface MinutesAnchoring {
  state: 'pending' | 'anchored';
  seq: number;
  /** The batch's hour, `YYYY-MM-DDTHH:00:00Z`. */
  window: string;
}

const ANCHOR_WINDOW = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/;

/**
 * The anchoring line. It holds only an integer and an hour this checks, so nothing a participant
 * wrote can reach it; anything else and the line is left out.
 */
function anchoringLine(a: MinutesAnchoring | null | undefined): string | null {
  if (!a || !Number.isSafeInteger(a.seq) || a.seq < 1 || typeof a.window !== 'string' || !ANCHOR_WINDOW.test(a.window)) return null;
  if (a.state === 'pending') return `Anchoring pending: the head at event ${a.seq} waits for its log, in the batch for ${a.window}.`;
  if (a.state === 'anchored')
    return `Anchored: the head at event ${a.seq} is in the batch for ${a.window}; \`crossroom verify --record <record.json> --trusted-root <root.json>\` checks it offline.`;
  return null;
}

/** GitHub refuses a comment body longer than this. */
export const GITHUB_COMMENT_LIMIT = 65_536;
/**
 * What a digest is allowed to be. Well under the limit, because whatever posts the comment
 * usually wraps it in a heading and a link of its own, and being refused at the API is a
 * worse failure than being a paragraph shorter.
 */
export const DIGEST_MAX_CHARS = 50_000;
/** How many lines one list in a digest may spend before the rest becomes a count. */
const DIGEST_MAX_LINES = 12;

/**
 * Markdown blockquote, line by line, so the quoted block cannot swallow what follows it.
 *
 * Split on `LINE_BREAK`, not on LF. CommonMark ends a line on a lone CR as well — and so
 * therefore do GitHub, the digest pasted into a pull request, and the web UI's own parser,
 * which normalises `\r` before it splits. A message containing a bare CR used to keep it inside
 * a `> ` line here and then break out of the quote at column 0 in every one of those readers,
 * which is a participant writing a heading into the owner's minutes. VT, FF, NEL and the two
 * Unicode separators go the same way, as they already do in the fences agents read
 * (`render.ts`) and in the names printed outside them (`text.ts`).
 */
const quote = (text: string) => text.split(LINE_BREAK).map((l) => (l.trim() ? `> ${l}` : '>'));

/** "1 claims" in a record of a real meeting reads like nobody looked at it. */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const stanceTrail = (hist: Position[]) => hist.map((h) => h.stance).join(' → ');

/**
 * One move, said in the strongest terms the ledger supports.
 *
 * A concession and the position change behind it are the same event described twice, so only
 * one of them is printed: the concession when there is one, because "withdrew their own claim"
 * is the finding, and the plain change otherwise.
 */
function moveLine(ch: PositionChange): string {
  const evidence = ch.evidence.length ? ` citing ${ch.evidence.join(', ')}` : '';
  const reason = ch.reason ? ` ${inline(ch.reason)}` : '';
  if (ch.concession?.kind === 'withdrawn')
    return `**${ch.name} withdrew this claim**, their own, and now opposes it${evidence}.${reason}`;
  if (ch.concession) return `**${ch.name} conceded** (${ch.from} → ${ch.to})${evidence}.${reason}`;
  return `Moved ${ch.from} → ${ch.to}${ch.evidence.length ? ` because of ${ch.evidence.join(', ')}` : ' (no evidence cited)'}.${reason}`;
}

/** The "Who moved" line, which names the claim because it is read away from one. */
function whoMovedLine(ch: PositionChange): string {
  const verb =
    ch.concession?.kind === 'withdrawn'
      ? 'withdrew their own claim'
      : ch.concession
        ? 'conceded'
        : 'changed position';
  return (
    `- ${ch.name} ${verb} on ${ch.claimLabel}: ${ch.from} → ${ch.to}` +
    (ch.evidence.length ? `, citing ${ch.evidence.join(', ')}` : ', **without citing evidence**') +
    (ch.reason ? `. ${inline(ch.reason)}` : '.')
  );
}

/**
 * The "argued against their own claim" line.
 *
 * Deliberately worded so it can never be mistaken for a concession: nobody moved, and saying
 * they did would invent a U-turn. What it reports is that the person who wrote the claim down
 * is the person arguing it away, which is the same evidence of good faith and is otherwise
 * invisible on the first screen.
 */
function authorAgainstLine(a: AuthorAgainstOwnClaim): string {
  return (
    `- ${a.name} registered ${a.claim.label} and opposed it from the outset` +
    (a.evidence.length ? `, citing ${a.evidence.join(', ')}` : ', **without citing evidence**') +
    (a.reason ? `. ${inline(a.reason)}` : '.')
  );
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** What the agents had made of a claim before the owner ruled on it. */
const LEFT_BY_AGENTS: Record<Claim['status'], string> = {
  open: 'the agents left it open',
  agreed: 'the agents had agreed on it',
  rejected: 'the agents had ruled it out',
  disputed: 'the agents left it disputed',
};

/**
 * One settled claim. The agents' finding comes first and the ruling second, so a reader never
 * takes the owner's decision for something the agents established.
 */
const settledLine = (c: ClaimLine, max: number | null) =>
  `- ${c.claim.label}: ${max ? clip(c.claim.text, 300) : inline(c.claim.text)} — ${LEFT_BY_AGENTS[c.claim.status] ?? `the agents left it ${c.claim.status}`}. Ruling: ${max ? clip(c.claim.resolution ?? '', max) : inline(c.claim.resolution ?? '')}`;

/**
 * A seat's record as one sentence of clauses. Every number comes from `SeatRecord`, and the
 * wording says what a count means rather than leaving a reader to guess which way is good: a
 * move on someone else's packet and a move citing nothing are different findings.
 */
export function recordText(r: SeatRecord): string {
  if (!r.joined) return 'never joined the room.';
  const parts: string[] = [];
  parts.push(
    r.packets
      ? `shared ${count(r.packets, 'packet')}, ${r.sourced === r.packets ? (r.packets === 1 ? 'with a source' : 'all with a source') : `${r.sourced} with a source`}`
      : 'shared no packets',
  );
  if (r.asked)
    parts.push(
      `answered ${r.answered} of ${count(r.asked, 'request')} addressed to it` +
        (r.declined ? `, declined ${r.declined} with a reason` : ''),
    );
  if (r.claims) parts.push(`raised ${count(r.claims, 'claim')}`);
  if (!r.moves) {
    if (r.claimsInRoom !== false) parts.push('never changed position');
  }
  else {
    const why = [
      r.movedOnOthers ? `${r.movedOnOthers} on someone else's packet` : '',
      r.movedOnOwner ? `${r.movedOnOwner} on the owner's packet` : '',
      // The labels are Crossroom's (a `citable` label, checked on the server), and still go through
      // `inline`: a snapshot rendered in a browser, or from a published file, is not the server's.
      r.movedOnFact
        ? `${r.movedOnFact} on ${r.movedOnFact === 1 ? 'a prior fact' : 'prior facts'} (${inline(r.factsCited.filter((l) => PRIOR_FACT_LABEL.test(l)).join(', '))})`
        : '',
      r.movedOnOwn ? `${r.movedOnOwn} on its own packets only` : '',
      r.movedOnNothing ? `${r.movedOnNothing} citing nothing` : '',
    ].filter(Boolean);
    // "once, on someone else's packet" rather than "once: 1 on someone else's packet".
    parts.push(
      r.moves === 1
        ? `changed position once, ${why[0]!.replace(/^1 /, '')}`
        : `changed position ${times(r.moves)}: ${why.join(', ')}`,
    );
  }
  if (r.agreedUncited)
    parts.push(`supported ${count(r.agreedUncited, 'claim')} raised by someone else on first sight, citing nothing`);
  return `${parts.join('; ')}.`;
}

/**
 * The room this record came from, without the owner key.
 *
 * Deliberately: the minutes are a document that gets downloaded, pasted into an issue and
 * mailed on, and a link carrying the key would hand the room over with it. Whoever already
 * has the key knows where it goes (`/s/<id>#k=<token>`).
 */
export const roomUrl = (base: string, sessionId: string) => `${base.replace(/\/$/, '')}/s/${sessionId}`;

/**
 * The minutes of a room, from a snapshot of it.
 *
 * Pure: whoever holds the room renders them. That is the server for an ordinary room and the
 * owner's browser for an end-to-end encrypted one, where the server holds only ciphertext —
 * the same function either way, so both rooms get the same document.
 */
export function renderMinutes(snap: SessionSnapshot, opts: { style?: MinutesStyle; baseUrl: string; anchoring?: MinutesAnchoring | null }): string {
  // For a chat, what the room holds is read with its backticks turned into quote marks (`unticked`).
  const room = isChatPaste(opts.style) ? unticked(snap) : snap;
  const sum = ledgerSummary(room);
  const url = roomUrl(opts.baseUrl, room.session.id);
  const origin = rerunLine(room, opts.baseUrl);
  if (opts.style === 'slack') return forSlack(digest(room, sum, url, origin));
  if (opts.style === 'teams') return forTeams(digest(room, sum, url, origin));
  const body = opts.style === 'digest' ? digest(room, sum, url, origin) : fullMinutes(room, sum, url, origin);
  const anchored = anchoringLine(opts.anchoring);
  return anchored ? `${body}\n\n${anchored}` : body;
}

/**
 * A room with every backtick in it turned into a quote mark, as the invite message treats the
 * title it quotes (the web app's invite message). For Copy for Slack and Copy for Teams only.
 *
 * Every string in a snapshot came from outside this file: text the agents and the owner wrote,
 * and ids, times and names of kinds, which hold no backtick. So once the digest is rendered from
 * this, the only backticks in it are the ones Crossroom writes itself, around a tool call (`call`).
 * Participant text with backticks of its own used to pair with the ones `quietMentions` adds:
 * "a`b @here c`d" became "a`b `@here` c`d", which Slack reads as two spans with @here between them.
 */
function unticked<T>(v: T): T {
  if (typeof v === 'string') return v.replace(/`/g, "'") as T;
  if (Array.isArray(v)) return v.map(unticked) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unticked(x)])) as T;
  return v;
}

/** Slack refuses a message over 40,000 characters; this leaves room for whatever wraps it. */
export const SLACK_MAX_CHARS = 39_000;

/**
 * The digest as text to paste into a Slack message.
 *
 * A translation of the digest's own layout, never a second renderer, so the two cannot say
 * different things about one room. Only line starts Crossroom wrote are rewritten (`## ` headings,
 * `- ` bullets and the `  - ` under them); participant text never starts a line here, since the digest keeps it inline or
 * behind `> `. The inline rewrites (`**bold**` to `*bold*`, `[text](url)` to `text (url)`) run over
 * participant text too, which only shows its links' real addresses.
 *
 * Then the one thing a paste can do in Slack that it cannot in a pull request: `@channel`,
 * `@here` and `@everyone` typed into Slack's composer notify everyone in the channel. Any of them
 * in participant text is set as code (`quietMentions`), so an agent cannot page a team through
 * the owner's paste. Crossroom's own words contain none of them. The digest is rendered from the room
 * with its backticks turned into quote marks (`unticked`), so participant text cannot pair with the
 * backticks that adds and leave a mention outside the code.
 */
function forSlack(md: string): string {
  const lines = md.split('\n').map((l) => {
    if (l === '>' || l.startsWith('> ')) return l;
    const s = l.startsWith('## ') ? `*${l.slice(3)}*` : l.startsWith('- ') ? `• ${l.slice(2)}` : l.startsWith('  - ') ? `    ◦ ${l.slice(4)}` : l;
    return s.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
  });
  return clampTo(quietMentions(lines.join('\n')), SLACK_MAX_CHARS);
}

/** A Teams chat message holds about 28 KB; this leaves room for whatever wraps it. */
export const TEAMS_MAX_BYTES = 27_000;

/** A markdown link with an http(s) address, as the digest writes one. */
const LINK = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g;

/**
 * The digest as text to paste into a Microsoft Teams chat or channel.
 *
 * A translation of the digest's own layout, as `forSlack` is, never a second renderer. Teams' compose
 * box reads `**bold**`, `_italic_`, `- ` lists, `> ` quotes and code spans as the digest writes them,
 * so those stay. Only line starts Crossroom wrote are rewritten: a `## ` heading becomes a bold line.
 * Links become `text (url)`, so a link shows its real address, participant text's included.
 *
 * Mentions: Teams pages a person only when one is picked from its list, never from pasted text, but
 * `@channel`, `@here` and `@everyone` are set as code all the same (`quietMentions`), and so is an
 * `@word` that opens a line (behind `> ` or a bullet too). As for Slack, the digest is rendered from
 * the room with its backticks as quote marks (`unticked`), so no participant text pairs with them.
 *
 * Cut at a line boundary under `TEAMS_MAX_BYTES` of UTF-8, saying so.
 */
function forTeams(md: string): string {
  const translated = md
    .split('\n')
    .map((l) => (l.startsWith('## ') ? `**${l.slice(3)}**` : l).replace(LINK, '$1 ($2)'))
    .join('\n');
  const lines = quietMentions(translated)
    .split('\n')
    .map((l) => l.replace(/^((?:> |- | {2}- )?)@([^\s`]+)/, '$1`@$2`'));
  return clampBytes(lines.join('\n'), TEAMS_MAX_BYTES);
}

/**
 * `text` cut at a line boundary so that it, and the note saying it was cut, fit in `max` bytes of
 * UTF-8. A line with no break in reach is cut between code points, never inside a surrogate pair.
 */
function clampBytes(text: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return text;
  const note = '\n\n_Truncated here: this recap was longer than one Teams message holds. The full recap is in the room._';
  const room = max - enc.encode(note).length;
  // By code point, so a cut never lands between the halves of a pair.
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const n = enc.encode(ch).length;
    if (bytes + n > room) break;
    bytes += n;
    end += ch.length;
  }
  const cut = text.slice(0, end);
  const atLine = cut.lastIndexOf('\n');
  return `${(atLine > 0 ? cut.slice(0, atLine) : cut).trimEnd()}${note}`;
}

/**
 * `@channel`, `@here` and `@everyone` set as code, so text pasted into Slack's composer pages
 * nobody. Every paste Crossroom offers for Slack goes through this one function (Copy for Slack, and
 * the web app's invite message), so the two cannot drift.
 *
 * Both callers turn the backticks of the text they quote into quote marks first, which this cannot
 * do for them: it cannot tell which backticks are Crossroom's. So every code span left is one Crossroom
 * wrote (a tool call, in Copy for Slack), and a mention inside one is left as it is. It is quiet
 * there already, and wrapping it would split the span in two with the mention between them.
 */
export function quietMentions(text: string): string {
  return text
    .split(/(`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/@(channel|here|everyone)\b/gi, '`@$1`')))
    .join('');
}

/**
 * The line saying which room this one re-runs, or null. Read from the `session_created` payload,
 * where only the server's own "run again" route puts it. The earlier room's title was typed by its
 * owner or taken from an agent's first message, so it is collapsed like any other title.
 */
function rerunLine(snap: SessionSnapshot, base: string): string | null {
  const p = snap.events.find((e) => e.type === 'session_created')?.payload as { rerunOf?: { id?: unknown; title?: unknown; swapped?: unknown } } | undefined;
  const r = p?.rerunOf;
  if (!r || typeof r.id !== 'string') return null;
  return `Re-run of "${clip(String(r.title ?? ''), 200)}" (${roomUrl(base, r.id)})${r.swapped === true ? ", with the two seats' agents swapped" : ''}.`;
}

// ---------------- acceptance ----------------

/** The longest note a party may leave when it accepts the minutes. */
export const ACCEPT_NOTE_MAX = 500;

/** One party's acceptance of an ended room's minutes as a fair record: a `minutes_accepted` event, read back. */
export interface MinutesAcceptance {
  by: 'owner' | 'seat';
  /** The seat's participant id, or null for the owner. */
  participantId: string | null;
  /** The acceptor's own words, or null. Participant text: print it only through `quote`. */
  note: string | null;
  /** Crossroom's clock, when the event was stored. */
  at: string;
}

/** A `minutes_accepted` event read back, or null for one that is not shaped as Crossroom writes it. */
export function acceptanceOf(e: { type?: string; actor: string; createdAt: string; payload: Record<string, unknown> }): MinutesAcceptance | null {
  if (e.type !== undefined && e.type !== 'minutes_accepted') return null;
  const note = typeof e.payload?.note === 'string' && e.payload.note.trim() ? e.payload.note.trim().slice(0, ACCEPT_NOTE_MAX) : null;
  // The actor column says who accepted: 'human' is the owner, anything else a seat's id.
  return e.actor === 'human'
    ? { by: 'owner', participantId: null, note, at: e.createdAt }
    : { by: 'seat', participantId: e.actor, note, at: e.createdAt };
}

/** Who has accepted the minutes, in the order they did, each party once (the first acceptance stands). */
export function acceptances(snap: Pick<SessionSnapshot, 'events'>): MinutesAcceptance[] {
  const seen = new Set<string>();
  const out: MinutesAcceptance[] = [];
  for (const e of snap.events) {
    const a = e.type === 'minutes_accepted' ? acceptanceOf(e) : null;
    if (!a) continue;
    const key = a.participantId ?? 'owner';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** "the owner", "Beta (B)": one acceptor as a sentence names them. */
function acceptorName(a: MinutesAcceptance, snap: SessionSnapshot): string {
  if (a.by === 'owner') return 'the owner';
  const p = snap.participants.find((x) => x.id === a.participantId);
  return p ? `${inline(p.name)} (${slotLetter(p.slot)})` : 'a seat';
}

const acceptedSentence = (list: MinutesAcceptance[], snap: SessionSnapshot) => {
  const who = list.map((a) => acceptorName(a, snap));
  return `Accepted as a fair record by ${who.length > 1 ? `${who.slice(0, -1).join(', ')} and ${who.at(-1)}` : who[0]}.`;
};

/**
 * The block of the full minutes that records who accepted them, or no lines. Crossroom writes the
 * heading and the sentences; a seat's name goes through `inline` and a note through `quote`, so
 * what a party typed cannot become a section of the document it is signed into. It sits at the end
 * of the body, so Crossroom's signature, which follows, covers it.
 */
function acceptedBlock(snap: SessionSnapshot): string[] {
  const list = acceptances(snap);
  if (!list.length) return [];
  const out = ['', '## Accepted as a fair record', '', acceptedSentence(list, snap)];
  for (const a of list) {
    out.push('', `**${a.by === 'owner' ? 'The owner' : acceptorName(a, snap)}** · accepted ${a.at}`);
    if (a.note) out.push('', ...quote(a.note));
  }
  return out;
}

// ---------------- what happened: outcome, close-outs, what was shared ----------------

/**
 * A seat as the recap names it wherever it attributes something to one: the outcome's line, a
 * decision, an action, a question left open, a seat's packets. One helper, so a seat reads the same
 * in every block (and a role, once seats have one, is added here and nowhere else). The name went
 * through `oneLine` on the server and goes through it again here, for a snapshot from a browser.
 */
export function seatLabel(p: Pick<Participant, 'name' | 'slot'>): string {
  return `${inline(p.name)} (${slotLetter(p.slot)})`;
}

/**
 * The seat an action names as its owner, by a seat letter or a seat's exact name before a colon at
 * its start ("B: ship the fix", "Payments agent: page on-call"), and the task after it. Null when
 * the action names no seat, or names one ambiguously. Letters win over names (`matchSeat`'s
 * passes), so a seat that called itself "C" never takes seat C's actions.
 */
export function actionOwner<P extends Pick<Participant, 'id' | 'slot' | 'name'>>(item: string, participants: readonly P[]): { seat: P; task: string } | null {
  const m = /^\s*@?([^:\n]{1,60}?)\s*:\s+(\S[\s\S]*)$/.exec(item);
  if (!m) return null;
  const hits = matchSeat(participants, m[1]!);
  return hits.length === 1 ? { seat: hits[0]!, task: m[2]!.trim() } : null;
}

/** A seat's close-out, with the seat it came from. */
export interface SeatCloseOut extends CloseOut {
  participantId: string;
}

/**
 * Every seat's `finish`, in seat order: its summary, and the decisions, actions and questions it
 * left open (`closeOutOf`, which reads a payload from before those fields as a summary alone).
 */
export function closeOuts(snap: Pick<SessionSnapshot, 'participants' | 'events'>): SeatCloseOut[] {
  const order = new Map(snap.participants.map((p) => [p.id, p.slot]));
  return snap.events
    .filter((e) => e.type === 'participant_finished')
    .map((e) => ({ participantId: e.actor, ...closeOutOf(e.payload) }))
    .sort((a, b) => (order.get(a.participantId) ?? 99) - (order.get(b.participantId) ?? 99));
}

/**
 * The blocks of the first screen that every room has, whatever it was for: what each seat said it
 * came to (Outcome), what was decided and who does what, what is still open, and what was shared.
 * Each block is left out when it would be empty. Every item is a seat's own words on one line,
 * attributed to it; nothing is merged or summarised. `max` clips the participant text (the digest),
 * or null keeps it whole (the full recap); `cap` shortens a long list (the digest's `capped`).
 */
function whatHappened(
  snap: SessionSnapshot,
  sum: LedgerSummary,
  o: { max: number | null; cap: (lines: string[], what: string) => string[]; packet: (i: ContextItem) => string },
): string[] {
  const out: string[] = [];
  const seatOf = (id: string) => snap.participants.find((p) => p.id === id);
  const who = (id: string) => {
    const p = seatOf(id);
    return p ? seatLabel(p) : namer(snap)(id);
  };
  const text = (t: string, max: number) => (o.max === null ? inline(t) : clip(t, Math.min(max, o.max)));
  const block = (label: string, lines: string[]) => {
    if (lines.length) out.push('', `**${label}.**`, '', ...lines);
  };
  const finished = closeOuts(snap);

  // The outcome: the room's own ending first, then each seat's summary under its name. The owner's
  // words keep their shape behind `> `; Crossroom's own ending ("All participants finished.") is one line.
  const outcome: string[] = [];
  const s = snap.session;
  if (s.outcome?.trim()) {
    const byOwner = snap.events.some((e) => e.type === 'session_ended' && e.actor === 'human');
    if (byOwner) outcome.push('The owner ended the room:', '', ...quote(o.max === null ? s.outcome : clip(s.outcome, o.max)), '');
    else outcome.push(`${text(s.outcome, 400)}`, '');
  }
  // A seat's role (owner-written) sits beside its name here, the one place the recap reads by seat;
  // item attributions below stay name and letter, since `## Participants` already gives the roles.
  for (const f of finished) {
    const seat = seatOf(f.participantId);
    const role = seat?.role;
    outcome.push(`- **${who(f.participantId)}**${role ? ` · ${text(role, 160)}${seat?.roleByTeam ? ` ${ROLE_BY_TEAM}` : ''}` : ''}: ${text(f.summary, 600)}`);
  }
  if (outcome.at(-1) === '') outcome.pop();
  block('Outcome', outcome);

  const items = (field: 'decisions' | 'actions' | 'open') =>
    finished.flatMap((f) => (f[field] ?? []).map((item) => `- ${text(item, 300)} — ${who(f.participantId)}`));
  // An action that names its owner first ("B: ship the fix") is printed under that seat, with who
  // noted it, so a seat's own list never reads as if it owns what it handed to another.
  const actions = finished.flatMap((f) =>
    (f.actions ?? []).map((item) => {
      const owned = actionOwner(item, snap.participants);
      if (!owned) return `- ${text(item, 300)} — ${who(f.participantId)}`;
      const owner = who(owned.seat.id);
      return `- ${text(owned.task, 300)} — owner ${owner}${owned.seat.id === f.participantId ? '' : `; noted by ${who(f.participantId)}`}`;
    }),
  );
  block('Decisions', o.cap(items('decisions'), 'decisions'));
  block('Actions', o.cap(actions, 'actions'));

  // Still open: what the seats said is open, then what the room itself left so: requests nobody
  // answered or that were declined, and a room not yet ended. Claims left open are the Claims
  // block's, never these.
  const threads = sum.openThreads.filter((t) => t.kind !== 'unpositioned').map((t) => `- ${t.text}`);
  block('Still open', o.cap([...items('open'), ...threads], 'open items'));

  // What crossed, by seat (the owner last), each packet with its label and source.
  const senders = [...[...snap.participants].sort((a, b) => a.slot - b.slot).map((p) => p.id), 'human'];
  const shared: string[] = [];
  for (const id of senders) {
    const mine = snap.contextItems.filter((i) => i.from === id);
    if (!mine.length) continue;
    shared.push(`- ${id === 'human' ? 'The owner' : who(id)} shared ${count(mine.length, 'packet')}:`);
    shared.push(...o.cap(mine.map((i) => `- ${o.packet(i)}`), 'packets').map((l) => `  ${l}`));
  }
  // What came back from side rooms a seat called one of the owner's agents into (`side_room_recap`):
  // the side room's own digest, its seats' words, quoted whole in the recap and clipped in the digest.
  for (const e of snap.events) {
    if (e.type !== 'side_room_recap') continue;
    const p = (e.payload ?? {}) as { seat?: unknown; askerId?: unknown; recap?: unknown; cut?: unknown };
    const head = `- ${who(String(p.askerId ?? ''))} called ${inline(String(p.seat ?? ''))} into a side room`;
    const recap = String(p.recap ?? '');
    if (o.max === null) shared.push(`${head}. Its recap${p.cut ? ', shortened' : ''}:`, '', ...quote(recap), '');
    else shared.push(`${head}: ${clip(recap, Math.min(400, o.max))}`);
  }
  if (shared.at(-1) === '') shared.pop();
  block('Shared', shared);
  return out;
}

/**
 * The claims, as one block printed only when the room has any: claims are a layer some rooms use,
 * and a room that never needed one reads no word about them. Inside it, everything the ledger has
 * always said: what every position supports or opposes, who moved and on what, what is disputed,
 * what the owner ruled, and which claims nobody took a side on.
 */
function claimsBlock(snap: SessionSnapshot, sum: LedgerSummary, o: { digest: boolean; cap: (lines: string[], what: string) => string[] }): string[] {
  if (!snap.claims.length) return [];
  const name = namer(snap);
  const out: string[] = [];
  const text = (t: string) => (o.digest ? clip(t, 300) : inline(t));
  const tally = [
    sum.established.length ? `${sum.established.length} established` : '',
    sum.ruledOut.length ? `${sum.ruledOut.length} ruled out` : '',
    sum.disputed.length ? `${sum.disputed.length} disputed` : '',
    sum.settled.length ? `${sum.settled.length} settled by the owner` : '',
    sum.unpositioned.length ? `${sum.unpositioned.length} without a position from every side` : '',
  ].filter(Boolean);
  out.push('', `**Claims.** ${count(snap.claims.length, 'claim')} on the record${tally.length ? `: ${tally.join(', ')}` : ''}.`);

  out.push('', '**Established.**', '');
  out.push(
    ...o.cap(
      sum.established.length
        ? sum.established.map((c) => `- ${c.claim.label}: ${text(c.claim.text)}${o.digest ? '' : ' — every position supports it.'}`)
        : // Past two seats (the incident template) there are no two sides to speak of.
          [`- Nothing ${o.digest ? '' : 'was put to a claim that '}${snap.participants.length > 2 ? 'every seat' : 'both sides'} then agreed on.`],
      'agreed claims',
    ),
  );

  // Ruled out is its own block, not a footnote under Established. A claim both agents checked
  // and rejected used to be listed among the settled ones, which told a reader skimming the
  // first screen the exact opposite of what the room found.
  if (sum.ruledOut.length) {
    out.push('', '**Ruled out.**', '');
    out.push(...o.cap(sum.ruledOut.map((c) => `- ${c.claim.label}: ${text(c.claim.text)} — **not true**; every position opposes it.`), 'rejected claims'));
  }

  out.push('', '**Who moved.**', '');
  const moved = [...sum.changes.map(whoMovedLine), ...sum.authorAgainst.map(authorAgainstLine)];
  out.push(...o.cap(moved.length ? moved : ['- Nobody changed position.'], 'changes'));

  // The digest names disputed claims only when there are some, as it always has.
  if (!o.digest || sum.disputed.length) out.push('', '**Still disputed.**', '');
  if (!sum.disputed.length) {
    if (!o.digest) out.push('- Nothing is left in open disagreement.');
  } else if (o.digest) out.push(...o.cap(sum.disputed.map((c) => `- ${c.claim.label}: ${clip(c.claim.text, 300)}`), 'disputed claims'));
  else
    for (const c of sum.disputed) {
      out.push(`- ${c.claim.label}: ${inline(c.claim.text)}`);
      for (const p of c.latest)
        out.push(`  - ${name(p.participantId)} ${p.stance}${p.reason ? `: ${inline(p.reason)}` : ''}${p.evidence.length ? ` (${p.evidence.join(', ')})` : ''}`);
    }

  if (sum.settled.length) {
    out.push('', '**Settled by the owner.**', '');
    out.push(...o.cap(sum.settled.map((c) => settledLine(c, o.digest ? 400 : null)), 'settled claims'));
  }

  const unpositioned = sum.openThreads.filter((t) => t.kind === 'unpositioned').map((t) => `- ${t.text}`);
  if (unpositioned.length) {
    out.push('', '**Left open.**', '');
    out.push(...o.cap(unpositioned, 'open claims'));
  }
  return out;
}

const uncapped = (lines: string[]) => lines;

function fullMinutes(snap: SessionSnapshot, sum: LedgerSummary, url: string, origin: string | null): string {
  const { session: s, participants, messages, contextRequests, contextItems, claims, positions } = snap;
  const name = namer(snap);
  const out: string[] = [];
  const cited = new Set(sum.cited);
  const answerTo = (r: ContextRequest) => contextItems.find((i) => i.inReplyTo === r.id);
  // The sending side's runner's signed claim about a packet's source, the latest of each:
  // a bracket of Crossroom's words and checked forms, beside the source check, never the runner's text.
  const attestedOf = new Map<string, PacketAttested>();
  for (const e of snap.events) {
    const a = e.type === 'packet_attested' ? (e.payload as unknown as PacketAttested) : null;
    if (a && typeof a.itemId === 'string') attestedOf.set(a.itemId, a);
  }
  const attestTag = (i: ContextItem) => {
    const a = attestedOf.get(i.id);
    return a ? ` ${attestationBracket(a)}` : '';
  };
  // A sparse room's description (`@parley/shared/sparse`) goes last, through `clip` like every field a participant wrote.
  const packetLine = (i: ContextItem) =>
    `**${i.label}** [${i.kind}]${checkTag(i)}${attestTag(i)} "${clip(i.title, 200)}" from ${name(i.from)}${i.to !== 'all' ? ` to ${name(i.to)}` : ''}${i.source ? ` — source: ${clip(i.source, 400)}` : ''}${aboutTail(i)}`;

  // `inline`, although the owner typed it: a heading is one line, and a title with a break in it
  // would end the heading and start whatever followed. In a document only the owner reads that
  // is their own broken page; in a digest pasted into a pull request, or anything a stranger
  // reads later, it is a section nobody wrote. An end-to-end room's title reaches this function
  // straight from the owner's browser, so collapsing it where the room is created is not enough.
  // A lane says what it is in its heading: its recap is a list of items, not a meeting's minutes.
  out.push(`# ${snap.lane ? 'Lane recap' : 'Minutes'}: ${inline(s.title)}`);
  out.push('');
  // Only the owner's view has the event (its audience is the owner), so only their minutes say
  // it. The first title may be an agent's first message, so it is clipped onto the line.
  const renames = snap.events.filter((e) => e.type === 'session_renamed');
  if (renames.length) {
    const first = String((renames[0]!.payload as { from?: unknown }).from ?? '');
    out.push(`Renamed by the owner${first ? `; first titled "${clip(first, 200)}"` : ''}.`);
    out.push('');
  }
  // Said plainly, because these documents get published and a reader who clicks it gets the
  // private-room 404. That is the product working, but an unexplained dead link reads as the
  // product broken.
  out.push(`Room: ${url} — ${s.complianceAccess ? COMPLIANCE_MINUTES_ROOM : 'private; only its owner can open it'}.`);
  out.push('');
  if (origin) {
    out.push(origin);
    out.push('');
  }
  // A lane has no mode to speak of (it is always `free`, which would read as a meeting's choice).
  out.push(
    `${snap.lane ? 'An async lane' : `Mode: ${s.mode}`}. Status: ${s.status}. Started: ${s.startedAt ?? '—'}. Ended: ${s.endedAt ?? '—'}.` +
      (sum.duration ? ` Ran ${sum.duration}.` : ''),
  );
  if (s.sharedBrief.trim()) {
    out.push('');
    out.push('**Brief.**');
    out.push('');
    out.push(...quote(s.sharedBrief));
  }

  // ---------- the first screen ----------
  // What happened leads, whatever the room was for; the claims follow only where there are any.
  out.push('');
  out.push('## In short');
  const shortPacket = (i: ContextItem) =>
    `**${i.label}** [${i.kind}]${checkTag(i)}${attestTag(i)} "${clip(i.title, 200)}"${i.to !== 'all' ? ` to ${name(i.to)}` : ''}${i.source ? ` — source: ${clip(i.source, 400)}` : ''}`;
  out.push(...whatHappened(snap, sum, { max: null, cap: uncapped, packet: shortPacket }));
  out.push(...claimsBlock(snap, sum, { digest: false, cap: uncapped }));

  // The honest footnote. A meeting where nothing crossed the boundary and nothing was
  // contested is one a single model could have written by itself, and the minutes should
  // say so rather than looking substantial.
  // A lane is items, not packets: "shared no packets" would say a working lane did nothing.
  if (sum.thinRecord && !snap.lane) {
    out.push('');
    out.push(`_Thin record: ${sum.thinRecord}_`);
  }
  // A lane's items are what it did, so they come straight after In short, before who took part.
  out.push(...laneBlock(snap));

  // ---------- the detail ----------
  out.push('');
  out.push('## Participants');
  out.push('');
  for (const p of participants) {
    // `provider` and `model` are declared by the agent on `join` and land on one line here, so
    // they are collapsed like every other thing a participant chose to call itself.
    // The role is the owner's words, one line by rule, and the lead mark is Crossroom's: both sit
    // beside the name, so a seat with neither prints exactly as it always did. A role that is the
    // seat's team's own description says so after it, in Crossroom's words.
    out.push(
      `- **${inline(p.name)}** (${slotLetter(p.slot)}${p.lead ? ', lead' : ''})${p.role ? `: ${inline(p.role)}${p.roleByTeam ? ` ${ROLE_BY_TEAM}` : ''}` : ''} — ${p.kind}${p.provider ? `, ${clip(p.provider, 60)}` : ''}${p.model ? ` / ${clip(p.model, 80)}` : ''}${p.finishedAt ? ', finished' : ''}`,
    );
    // A lane's record is its items, above: "shared no packets" would say a working side did nothing.
    const r = snap.lane ? undefined : sum.records.find((x) => x.participantId === p.id);
    if (r) out.push(`  - Record: ${recordText(r)}`);
    // The owner took the seat back from an agent by replacing its link. Crossroom
    // writes this line from its own events; nothing in it is the seat's.
    const replaced = snap.events.filter(
      (e) => e.type === 'participant_left' && e.actor === p.id && (e.payload as { reason?: unknown } | null)?.reason === 'link_replaced',
    ).length;
    if (replaced)
      out.push(`  - The owner replaced this seat's link ${replaced === 1 ? 'once' : `${replaced} times`} while an agent held it, which removed that agent from the room.`);
    // A seat the owner added once the room was running (the server's `addSeat`): Crossroom's words, matched
    // by the letter Crossroom assigned, so a reader knows its agent arrived partway through.
    if (snap.events.some((e) => e.type === 'seat_added' && (e.payload as { slot?: unknown } | null)?.slot === slotLetter(p.slot)))
      out.push('  - The owner added this seat while the room was running, so its agent joined partway through.');
    // What it said it would run, as it last declared it. The names are one token by rule; the
    // descriptions are the seat's own words, so they are clipped onto the line.
    if (p.offers?.length)
      out.push(`  - Offers: ${p.offers.map((o) => `\`${o.name}\` — ${clip(o.description, 160)}`).join('; ')}`);
  }

  if (claims.length) {
    out.push('');
    out.push('## Claims');
    for (const c of claims) {
      out.push('');
      out.push(`### ${c.label} — ${c.status}${c.resolution ? ', settled by the owner' : ''}`);
      out.push('');
      out.push(...quote(c.text));
      // Without this blank line the next paragraph is a lazy continuation of the quote and
      // CommonMark folds "Raised by …" into the claim's own words.
      out.push('');
      out.push(`Raised by ${name(c.createdBy)}.${c.resolution ? ` Settled by the owner: ${inline(c.resolution)}` : ''}`);
      out.push('');
      const ps = positions.filter((p) => p.claimId === c.id);
      const byP = new Map<string, Position[]>();
      for (const p of ps) byP.set(p.participantId, [...(byP.get(p.participantId) ?? []), p]);
      for (const [pid, hist] of byP) {
        const last = hist[hist.length - 1]!;
        out.push(
          `- **${name(pid)}**: ${stanceTrail(hist)}${last.reason ? ` — ${inline(last.reason)}` : ''}${last.evidence.length ? ` (evidence: ${last.evidence.join(', ')})` : ''}`,
        );
        // A participant's moves belong under that participant. Emitting them in a pass of
        // their own put one agent's change beneath another agent's position whenever a claim
        // had more than one mover.
        for (const ch of sum.changes.filter((x) => x.claimId === c.id && x.participantId === pid))
          out.push(`  - ${moveLine(ch)}`);
      }
    }
  }

  if (contextRequests.length || contextItems.length) {
    out.push('');
    out.push('## Context exchanged');
    out.push('');
    for (const r of contextRequests) {
      const a = answerTo(r);
      if (!r.tool) {
        out.push(`- ${name(r.from)} asked ${name(r.to)}: "${clip(r.what, 300)}" — ${r.status}${a ? ` (answered with ${a.label})` : ''}`);
        continue;
      }
      // A tool request is fulfilled by a packet, and only the packet says what ran. When the
      // answer was not marked as the tool's output, say so rather than let "fulfilled" imply it.
      const outcome =
        r.status === 'fulfilled' && a
          ? `fulfilled with ${a.label}${a.kind === 'tool_output' ? '' : `, a ${a.kind} packet rather than the tool's output`}`
          : r.status;
      out.push(`- ${name(r.from)} ${askedFor(r, name)} ("${clip(r.what, 300)}"): ${outcome}`);
    }
    for (const i of contextItems) {
      out.push(`- ${packetLine(i)} (${i.bytes} bytes)${cited.has(i.label) ? ' — cited as evidence' : ''}`);
    }
  }

  out.push(...boardBlock(snap, name));
  out.push(...subroomsBlock(snap, url.replace(/\/s\/[^/]*$/, '')));

  // The transcript is an appendix, and each message keeps the shape its author gave it.
  // Collapsing newlines made every multi-line message one unreadable line, which is exactly
  // what agents use to show a diff, a stack trace or a list — the parts worth reading twice.
  // A lane is items, not messages: an empty transcript says nothing there, so it is left out.
  if (!snap.lane || messages.length) {
    out.push('');
    out.push(`## Appendix: transcript (${count(sum.agentMessages, 'agent message')}, ${sum.otherMessages} human/system)`);
  }
  for (const m of messages) {
    out.push('');
    // Who it was addressed to (`@C`), when anyone was: seat names, so each goes through `inline`.
    const to = m.mentions?.length ? ` → ${m.mentions.map((id) => inline(name(id))).join(', ')}` : '';
    out.push(`**${inline(m.authorName)}**${to} · ${m.createdAt}`);
    out.push('');
    out.push(...quote(m.text));
  }
  out.push(...acceptedBlock(snap));
  out.push('');
  out.push('_Generated by Crossroom from the session ledger; no model summarisation involved._');
  return out.join('\n');
}

/**
 * The room's board as it ended, in the owner's minutes only (the snapshot carries `board` for the
 * owner alone): each key with its version and who set it last, then its value. A key is Crossroom's
 * charset (`BOARD_KEY`) on the way in; here it is collapsed (`inline`) and kept out of closing its
 * code span all the same, since a snapshot may reach this from anywhere, and the name is `name`'s. The value is JSON a participant or the owner wrote, laid out indented and
 * quoted line by line (`quote`, which splits on every line terminator), so no character in it can
 * start a heading or a list of its own. Printed only when the board holds a key.
 */
/**
 * A lane's items (`@parley/shared/lane`), where the snapshot carries them (the owner's, and either
 * side's seat page): one line each in Crossroom's words (label, kind, state, who filed it), the title
 * collapsed onto it (`inline`), and its latest note quoted. Printed only in a lane.
 */
/** A link's words in the recap: host and path, with nothing markdown would read as a mark. */
const linkWords = (l: string) => {
  const u = new URL(l);
  return `${u.host}${u.pathname === '/' ? '' : u.pathname}`.replace(/[[\]*_`\\]/g, '');
};

function laneBlock(snap: SessionSnapshot): string[] {
  const items = snap.lane;
  if (!items) return [];
  const out = ['', '## Lane'];
  if (!items.length) return [...out, '', 'Nothing was filed.'];
  const open = items.filter((i) => i.state !== 'closed').length;
  out.push('', `${items.length} item${items.length === 1 ? '' : 's'} filed, ${open} still open.`);
  // A side by its name and letter, "web (A)", as the Participants list below calls it; a side still
  // called by its letter alone ("Side A") is not named twice.
  const side = (letter: string) => {
    const p = snap.participants.find((x) => slotLetter(x.slot) === letter);
    if (!p) return `side ${inline(letter)}`;
    const n = inline(p.name);
    return n === `Side ${letter}` ? n : `${n} (${letter})`;
  };
  for (const i of items) {
    const meta = [i.priority ? LANE_PRIORITY_WORDS[i.priority] : '', i.dueAt ? `due ${i.dueAt.slice(0, 10)}` : '', i.via ? `from ${LANE_VIA_WORDS[i.via]}` : '']
      .filter(Boolean)
      .map((m) => ` · ${m}`)
      .join('');
    out.push('', `- **${laneLabel(i.n)}** · ${LANE_KIND_WORDS[i.kind]} · ${LANE_STATE_WORDS[i.state]}${meta} · filed by ${side(i.filedBy)}: ${inline(i.title)}`);
    // Sub-bullets, the one nesting every reader of the recap parses (the web's parser reads no
    // autolinks or indented paragraphs). Links were checked and stored as the URL parser writes
    // them; each prints as its host and path in Crossroom's words, never a label a side chose.
    const links = (i.links ?? []).filter((l) => /^https:\/\/[^\s<>()[\]]+$/.test(l));
    if (links.length) out.push(`  - Links: ${links.map((l) => `[${linkWords(l)}](${l})`).join(' · ')}`);
    if (i.last && (i.last.note || i.last.ref)) {
      const by = i.last.by === 'owner' ? 'the owner' : side(i.last.by);
      out.push(`  - Latest, from ${by}: ${i.last.note ? inline(clip(i.last.note, 300)) : ''}${i.last.ref ? `${i.last.note ? ' ' : ''}(ref: ${inline(clip(i.last.ref, 200))})` : ''}`);
    }
  }
  return out;
}

function boardBlock(snap: SessionSnapshot, name: (id: string) => string): string[] {
  const entries = snap.board ?? [];
  if (!entries.length) return [];
  const out = ['', '## Board'];
  for (const e of entries) {
    out.push('');
    out.push(`**\`${inline(e.key).replace(/`/g, "'")}\`** · version ${e.version} · set last by ${e.updatedBy === 'human' ? 'the owner' : inline(name(e.updatedBy))}`);
    out.push('');
    out.push(...quote(boardPretty(e.value)));
  }
  return out;
}

/**
 * The room's sub-rooms, in the owner's minutes only (the snapshot carries `subrooms` for the owner
 * alone): each child's title and the lead's reason, collapsed onto the line (`inline`), what became
 * of it in Crossroom's words, the outcome it ended with, and a link the owner's browser opens with the
 * key it holds (never the key itself). Printed only when the room had any.
 */
function subroomsBlock(snap: SessionSnapshot, base: string): string[] {
  const rows = snap.subrooms ?? [];
  if (!rows.length) return [];
  const out = ['', '## Sub-rooms', ''];
  for (const r of rows) {
    const state =
      r.state === 'opened' ? (r.childStatus === 'deleted' ? 'opened, since deleted' : r.childStatus === 'ended' ? 'opened, ended' : 'opened, still live') : SUBROOM_STATE_WORDS[r.state];
    const outcome = r.report?.outcome ? ` Outcome: ${inline(r.report.outcome)}` : '';
    const link = r.childId && r.childStatus !== 'deleted' ? ` (${roomUrl(base, r.childId)})` : '';
    out.push(`- **${inline(r.title)}** · ${state}${link}. Why: ${inline(r.why)}.${outcome}`);
    if (r.state === 'refused' && r.reason) out.push(`  The owner's reason: ${inline(r.reason)}`);
    for (const f of ['decisions', 'actions', 'open'] as const) {
      const items = r.report?.[f] ?? [];
      if (items.length) out.push(`  ${f === 'open' ? 'Still open' : f === 'decisions' ? 'Decisions' : 'Actions'}: ${items.map(inline).join('; ')}`);
    }
  }
  return out;
}

/**
 * A packet as a comment outside the room may describe it.
 *
 * A direct share is named, not described. Its title and source are exactly the two fields
 * `core.snapshot(id, 'public')` blanks — a title is written to describe its body ("prod .env
 * for the staging host") — so reading only the fields that survive that redaction keeps this
 * line the same sentence under either viewer, and means an owner snapshot handed here by
 * mistake spills less than it might. That second part is a mitigation, not the guarantee.
 * The guarantee is the caller passing the public viewer.
 */
const digestPacketLine = (i: ContextItem, name: (id: string) => string) =>
  i.to === 'all'
    ? `- **${i.label}** [${i.kind}]${checkTag(i)} "${clip(i.title, 100)}" from ${name(i.from)}${i.source ? ` — source: ${clip(i.source, 200)}` : ''}${aboutTail(i)}`
    : `- **${i.label}** [${i.kind}] ${name(i.from)} → ${name(i.to)}, ${i.bytes} bytes — sent directly; the contents stay in the room.`;

/**
 * Crossroom's source check on a packet, as a bracket after its label and kind: `[source checked: all
 * 12 lines are in the cited file]`. It comes before anything the sender wrote on the line, so a
 * title or source that imitates it reads as what it is, text later in the line. Counts only.
 */
const checkTag = (i: ContextItem) => (i.check ? ` [${sourceCheckTag(i.check)}: ${sourceCheckPhrase(i.check)}]` : '');

/** Long lists crowd out the summary a digest exists to lead with. */
function capped(lines: string[], what: string): string[] {
  if (lines.length <= DIGEST_MAX_LINES) return lines;
  return [...lines.slice(0, DIGEST_MAX_LINES), `- …and ${lines.length - DIGEST_MAX_LINES} more ${what} in the room.`];
}

/**
 * The digest: the ledger with no transcript, short enough to post as a comment.
 *
 * PRIVACY CONTRACT. This is written to be pasted somewhere public, usually a pull request,
 * so it must be rendered from `core.snapshot(id, 'public')` — the viewer that blanks the
 * title, body and source of every direct share. Nothing here re-does that redaction; there
 * is one copy of it and it is in `core`. A caller that hands this an owner snapshot is
 * publishing an owner's room, whatever this function does.
 */
function digest(snap: SessionSnapshot, sum: LedgerSummary, url: string, origin: string | null): string {
  const { session: s, participants, contextItems } = snap;
  const name = namer(snap);
  const out: string[] = [];
  const seats = participants.map((p) => `${name(p.id)} (${slotLetter(p.slot)})`);
  const seatList = seats.length > 2 ? `${seats.slice(0, -1).join(', ')} and ${seats.at(-1)}` : seats.join(' and ');

  out.push(`## Crossroom: ${inline(s.title)}`);
  out.push('');
  out.push(
    `[The room](${url}) (private${snap.session.complianceAccess ? ', open to compliance access' : ''}) · ${seatList} · ` +
      `${count(sum.agentMessages, 'message')}, ${count(contextItems.length, 'packet')}${snap.claims.length ? `, ${count(snap.claims.length, 'claim')}` : ''}` +
      (sum.duration ? ` · ran ${sum.duration}` : ''),
  );
  if (origin) {
    out.push('');
    out.push(origin);
  }
  if (s.sharedBrief.trim()) {
    out.push('');
    // `clip` already collapses to one line; the quote is there for the leading `> `.
    out.push(...quote(clip(s.sharedBrief, 400)));
  }

  out.push(...whatHappened(snap, sum, { max: 600, cap: capped, packet: (i) => digestPacketLine(i, name).slice(2) }));
  out.push(...claimsBlock(snap, sum, { digest: true, cap: capped }));

  // Per seat, in seat order, and never totalled: which side shared, answered and moved on what.
  out.push('');
  out.push('**Record.**');
  out.push('');
  for (const r of sum.records) out.push(`- ${r.name}: ${recordText(r)}`);

  // A lane is items, not packets: "shared no packets" would say a working lane did nothing.
  if (sum.thinRecord && !snap.lane) {
    out.push('');
    out.push(`_Thin record: ${sum.thinRecord}_`);
  }

  // One line: who accepted the minutes, never what they said in their notes.
  const accepted = acceptances(snap);
  if (accepted.length) {
    out.push('');
    out.push(acceptedSentence(accepted, snap));
  }

  out.push('');
  out.push(`_Deterministic minutes from the [Crossroom ledger](${url}); no model summarisation involved. The transcript stays in the room._`);
  return clampDigest(out.join('\n'));
}

/** Last defence on length, and it says when it fires: a silently halved record is a lie. */
const clampDigest = (text: string) => clampTo(text, DIGEST_MAX_CHARS);

function clampTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = '\n\n_Truncated here: this digest was longer than one comment holds. The full minutes are in the room._';
  const room = max - note.length;
  const cut = text.slice(0, room);
  const atLine = cut.lastIndexOf('\n');
  return `${(atLine > 0 ? cut.slice(0, atLine) : cut).trimEnd()}${note}`;
}
