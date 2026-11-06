/**
 * Crossroom shared domain model.
 *
 * Design rules:
 *  - A SESSION is the top-level primitive. Messages are first-class.
 *  - Structured semantics (claims/positions/evidence) are OPTIONAL layers.
 *  - Participants are independent external agents; Crossroom never merges their brains.
 *  - Everything that changes session state is an append-only EVENT. The event
 *    log is what agents wait on and what the human UI streams.
 */
import { z } from 'zod';
import type { BoardEntry } from './board.js';
import type { SubroomView } from './subrooms.js';
import { LANE_AUTONOMY, type LaneAutonomy, type LaneItem, type LaneTally } from './lane.js';
import type { WriteSignature } from './chain.js';
import type { RoomAccess } from './org.js';
import type { StandingRuntime } from './runner.js';
import { ROLE_MAX, ROOM_SEATS_DEFAULT, ROOM_SEATS_LIMIT, SUBROOM_MODES, type Offer } from './text.js';

/** What the published schema says of a room's seats: the bound is the ceiling, the instance's cap is less. */
export const SEATS_DESCRIPTION = `The seats, up to the instance's limit: ${ROOM_SEATS_DEFAULT} by default (roomSeatsMax in /api/features), ${ROOM_SEATS_LIMIT} at most.`;

// ---------- Modes ----------
export const SessionMode = z.enum(['free', 'duel', 'reconcile', 'review', 'handoff', 'custom']);
export type SessionMode = z.infer<typeof SessionMode>;
/** Whether a room's lead may open sub-rooms: off, after asking the owner, or without asking. */
export const SubroomMode = z.enum(SUBROOM_MODES);
export type SubroomMode = z.infer<typeof SubroomMode>;

export const SessionStatus = z.enum(['open', 'active', 'ended']);
export type SessionStatus = z.infer<typeof SessionStatus>;

// ---------- Participants ----------
/**
 * - `hosted`: Crossroom runs the agent itself, on this machine (runners/).
 * - `attached`: an agent someone is already running takes the seat through its link.
 * - `standing`: an agent a team runs on its own machine (`crossroom runner`) answers an ask link.
 *   Only the relay makes one, when an ask opens a room: the create API refuses it
 *   (`CreatableKind`). It has a `standing_seat_id`, no private brief (the team's runner holds the
 *   seat's instructions), and no token anyone but the team's runner ever sees.
 */
export const ParticipantKind = z.enum(['hosted', 'attached', 'standing']);
export type ParticipantKind = z.infer<typeof ParticipantKind>;

/** The kinds a room's creator may ask for. A standing seat comes only from an ask link. */
export const CreatableKind = z.enum(['hosted', 'attached']);
export type CreatableKind = z.infer<typeof CreatableKind>;

export const Reachability = z.enum(['push', 'poll', 'unknown']);
export type Reachability = z.infer<typeof Reachability>;

export const HostedRunner = z.enum(['claude', 'codex', 'agy', 'grok']);
export type HostedRunner = z.infer<typeof HostedRunner>;

export const HostedConfig = z.object({
  runner: HostedRunner,
  /** Working directory the hosted agent may read. This is the private context boundary. */
  cwd: z.string().optional(),
  model: z.string().optional(),
  /**
   * Extra CLI args. Every adapter appends these AFTER its own allow/deny lists, so they can
   * turn a read-only agent into a writing one. Templates in this repo may set them; the HTTP
   * API may not (see HostedConfigInput).
   */
  extraArgs: z.array(z.string()).optional(),
});
export type HostedConfig = z.infer<typeof HostedConfig>;

/**
 * Hosted config as accepted over HTTP.
 *
 * `extraArgs` is omitted and the object is strict, so a request carrying it is refused rather
 * than quietly stripped: on a local instance, creating a session spawns a logged-in agent CLI,
 * and an escape hatch that overrides the sandbox flags is not something a request should carry.
 */
export const HostedConfigInput = HostedConfig.omit({ extraArgs: true }).strict();
export type HostedConfigInput = z.infer<typeof HostedConfigInput>;

/**
 * A standing seat as its runner declared it when the ask opened the room, kept on
 * the participant: the agent renames its seat on `join`, and the runner may declare the seat
 * differently later, but this says who answered this room and how. Metadata the relay wrote,
 * never a participant's words. `confined` is true only for Claude Code with `--restricted`: for
 * Codex and Grok the seat's reads are not confined to its checkout, and the asker is told so.
 */
export interface StandingSeatInfo {
  /** The seat's label (`SEAT_LABEL` in `@parley/shared/runner`), e.g. `payments-api`. */
  label: string;
  runtime: StandingRuntime;
  confined: boolean;
}

export interface Participant {
  id: string;
  sessionId: string;
  slot: number; // 0 = A, 1 = B, ...
  name: string;
  kind: ParticipantKind;
  /** Declared by the agent on join, e.g. "claude-code", "codex", "gemini-cli", "custom". */
  provider: string | null;
  model: string | null;
  /** Private brief: visible only to this participant and the session owner. */
  privateBrief: string | null;
  /**
   * What the seat is in the room for, one line the owner wrote ("Security", "owns the billing
   * service"). Public: every seat and every reader of the room sees it. Absent when unset.
   */
  role?: string;
  /**
   * Present when `role` is not the owner's words but the description the seat's team declared for
   * its standing seat, taken because the owner gave that seat no role. Every reader prints it as the
   * team's ("described by its team"), never as the owner's. Absent on every other seat.
   */
  roleByTeam?: true;
  /** Present on the room's one lead seat, which the owner chose. Absent on every other seat. */
  lead?: true;
  hosted: HostedConfig | null;
  joinedAt: string | null;
  /**
   * When the owner invited a person to this seat (the room page's "Invite a person"). A live room
   * with a joined seat and an invited one not yet joined waits on its own, longer clock
   * (`Lifecycle.waitingEndMinutes`), because the person it is waiting for may be hours away.
   */
  invitedAt: string | null;
  leftAt: string | null;
  finishedAt: string | null;
  reachability: Reachability;
  lastSeenAt: string | null;
  /** Hosted-runner status for the UI. */
  runnerState: 'idle' | 'starting' | 'thinking' | 'waiting' | 'stopped' | 'error' | null;
  runnerNote: string | null;
  /** What this seat said it will run for the others on request, as it last declared it. */
  offers: Offer[];
  /** Present only on a `standing` seat: who answers, and whether its reads are confined. */
  standing?: StandingSeatInfo;
  /**
   * Present only on the other organisation's seat in a room across a connection: which
   * connection it came across. The owner's view alone: `redactSnapshot` drops it.
   */
  connectionId?: string;
  /** With `connectionId`: the guest relay the seat is reached through (directory `relays.id`), null on one relay. */
  viaRelay?: string | null;
}

export interface Session {
  id: string;
  /**
   * Set when the room's organisation's compliance access holds a wrap of the room's key:
   * read keyless from `room_keys`, so every reader of the
   * room is told who else can open it.
   */
  complianceAccess?: true;
  title: string;
  mode: SessionMode;
  /** Shared brief: visible to every participant. Topic, goal, rules. */
  sharedBrief: string;
  status: SessionStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  outcome: string | null;
  /** Soft cap on agent messages before Crossroom asks agents to wrap up. */
  maxMessages: number;
  /**
   * The next deadline that changes this room, or null where the instance keeps rooms forever.
   *
   * It means different things either side of the end, which is the honest way to show one
   * date: while the room is live it is when Crossroom will end it on its own, and once it has
   * ended it is when the room and everything in it are deleted.
   */
  expiresAt: string | null;
  /**
   * End-to-end encrypted: what participants and the owner wrote arrives here as `e1.`
   * envelopes that only a holder of the room key can open (see e2ee.ts). The server keeps the
   * room, delivers it and derives the ledger, but cannot read it.
   */
  e2ee: boolean;
  /** An envelope of a known text, so a client can tell whether a key it was handed opens this room. */
  e2eeCheck: string | null;
  /**
   * When the owner asked to keep the room past its deletion date. The ask is counted and changes
   * no date.
   */
  keepRequestedAt: string | null;
  /**
   * The room's record version (packages/shared/src/chain.ts): 2 commits to every event under a
   * nonce sealed in its payload, 1 is the hash chain every room made before chain v2 has.
   */
  chainVersion?: 1 | 2;
}

/**
 * What the start page's room list shows beside a room (`POST /api/sessions/lookup`), read from
 * columns that are never sealed, so it costs no decryption and says nothing a room's own page
 * does not.
 */
export interface RoomAttention {
  /** Questions an agent put to the owner that are still open, while the room is live. */
  yourTurn: number;
  /** Seats the owner invited a person to that no agent has taken yet, by letter. */
  waitingFor: string[];
  /** The room's last event, or its creation: when it last moved. */
  lastActivityAt: string;
  /** In a lane only: its open items and which side they wait on (`tallyLane`). */
  lane?: LaneTally;
}
export type RoomSummary = Session & { attention?: RoomAttention };

// ---------- Messages ----------
export const MessageKind = z.enum(['say', 'human', 'system']);
export type MessageKind = z.infer<typeof MessageKind>;

export interface Message {
  id: string;
  sessionId: string;
  seq: number;
  /** participant id, or 'human', or 'system' */
  author: string;
  authorName: string;
  kind: MessageKind;
  text: string;
  replyTo: string | null;
  /**
   * The seats it was addressed to (`@C`, `to=C`), as participant ids. Absent when it was for
   * everyone, which is every message in a room of two. Everyone sees it either way.
   */
  mentions?: string[];
  createdAt: string;
}

// ---------- Context exchange ----------
export const ContextKind = z.enum([
  'text',
  'summary',
  'code',
  'file_excerpt',
  'log',
  'schema',
  'tool_output',
  'url',
  'artifact',
]);
export type ContextKind = z.infer<typeof ContextKind>;

export interface ContextRequest {
  id: string;
  sessionId: string;
  from: string; // participant id or 'human'
  to: string; // participant id, 'all', or 'human' for the session owner
  what: string;
  why: string | null;
  /** A tool the addressee offered, when the request names one; `args` is what to run it on. */
  tool: string | null;
  args: string | null;
  status: 'open' | 'fulfilled' | 'declined';
  createdAt: string;
  resolvedAt: string | null;
  /**
   * A typed call (`call_tool`, `@parley/shared/typed-tools`): `tool` is a tool the addressee
   * declared with a schema, and `args` is canonical JSON checked against it. Absent otherwise.
   */
  typed?: true;
}

export interface ContextItem {
  id: string;
  sessionId: string;
  /** Short label like X1, X2 for citation. */
  label: string;
  from: string; // participant id or 'human'
  to: string; // participant id or 'all'
  kind: ContextKind;
  title: string;
  /** The sender's one-line description of the packet, in a sparse room; absent when it gave none. */
  about?: string;
  body: string;
  /** Sender-claimed provenance, e.g. "backend/src/api/checkout.ts:40-72" or a URL. */
  source: string | null;
  inReplyTo: string | null; // context request id
  bytes: number;
  createdAt: string;
  /** What Crossroom found in the cited file, for a seat it runs; null when it did not look. */
  check?: SourceCheck | null;
  /**
   * The packet named a source, which this view does not show: a direct packet, redacted for a
   * reader who is not the owner. Set only there, so the record can still count it as sourced.
   */
  sourced?: boolean;
}

/**
 * Crossroom's own reading of a packet's source (sourcecheck.ts in the client), made only for seats
 * it runs, whose directory it knows. `found` of `of` is how many of the body's lines are in the
 * cited lines of the cited files; `files` is how many of those files it read, or for `not_found`,
 * how many were missing.
 */
export interface SourceCheck {
  status: 'checked' | 'partial' | 'differs' | 'not_found';
  found: number;
  of: number;
  files: number;
  /**
   * The full id of the commit the files were read at, when the source named one (`a.ts@abc1234`,
   * `git show abc1234:a.ts`); absent when they were read from the working tree, or from more than
   * one commit.
   */
  commit?: string;
}

// ---------- Optional structured semantics ----------
export const Stance = z.enum(['support', 'oppose', 'uncertain', 'insufficient_evidence']);
export type Stance = z.infer<typeof Stance>;

/**
 * Derived from the latest position of every participant who has joined, never set by hand.
 *
 * `agreed` and `rejected` are both unanimity — everyone supports it, or everyone opposes it.
 * They used to be one value, which made "both agents checked and the claim is false" read as
 * "agreed" in the minutes, the opposite of what happened.
 *
 * An owner ruling does not change it. The status is the one plain-text record of what the
 * agents found (the stats and the signal read it without a key), so a claim the owner settled
 * keeps the status the agents left it in, and is settled when `Claim.resolution` is set.
 */
export const ClaimStatus = z.enum(['open', 'agreed', 'rejected', 'disputed']);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export interface Claim {
  id: string;
  sessionId: string;
  label: string; // C1, C2 ...
  text: string;
  createdBy: string;
  status: ClaimStatus;
  /** The owner's ruling, once the room has ended; null until then. Settled = not null. */
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Position {
  id: string;
  claimId: string;
  participantId: string;
  stance: Stance;
  reason: string | null;
  /** Context item labels cited as evidence (X1, X3 ...). */
  evidence: string[];
  /** Previous stance of the same participant on the same claim, if any (for change tracking). */
  previousStance: Stance | null;
  createdAt: string;
}

// ---------- Events ----------
export const EventType = z.enum([
  'session_created',
  'session_started',
  'session_ended',
  'participant_joined',
  'participant_left',
  'participant_finished',
  'participant_state',
  // A `message` payload carries { messageId, messageSeq, authorName, text, replyTo },
  // plus { briefSet: true, title } when this first message became the session's
  // shared brief and title (see the server's `say`).
  'message',
  'context_requested',
  'context_shared',
  'claim_created',
  'position_updated',
  // Something happened to a claim that no single position describes. Payload:
  // { claimId, label, claimText, kind, by, byName, from, to, evidence, status } where `kind`
  // is 'conceded' (moved to the stance the other side already held) or 'withdrawn' (the
  // claim's own author now opposes it). This is the line the minutes are written for.
  'claim_updated',
  'human_note',
  'nudge',
  // A seat declared, changed or withdrew its tool offers. Payload: { name, slot, offers }, where
  // `offers` is the whole list as it now stands ([] when withdrawn). One event per real change.
  'offers_declared',
  // The owner ruled on a claim after the room ended. Payload: { claimId, label, claimText,
  // resolution, agents, revised } where `agents` is the status the agents left the claim in and
  // `revised` says an earlier ruling was replaced. Its own event, because `claim_updated` means
  // a participant giving way, and a ruling is nobody's concession.
  'claim_settled',
  // The owner renamed the room. Payload: { from, title }. Audience 'human': the title is the
  // owner's label for the room, not the brief, so no agent is told and no public view shows it.
  'session_renamed',
  // The owner gave a live room more room (the server's `extendRoom`). Payload: { maxMessages, added },
  // where `added` is 0 when the owner only kept it open. Audience 'human': no agent is told in
  // words, and the event itself restarts the idle clock.
  'room_extended',
  // The owner added a seat to a live room (the server's `addSeat`). Payload: { name, slot, kind, seats,
  // role?, lead? }, the seat as the owner set it up and the room's seat count after it. Audience
  // 'all': every agent is told, since its briefing listed the seats as they were at its `join`.
  'seat_added',
  // A standing seat's team is holding one of its packets for review, or has decided on it
  // (the server's `noteHold`). Payload: { holdId, kind, bytes, why } when held, and
  // { holdId, resolution } when decided. Shape only: the packet itself never reaches the relay
  // until it is approved, and then it arrives as an ordinary `context_shared`.
  'context_held',
  // Projects, policy and playbooks. Each is content-free.
  // A packet a project's policy holds for a person of the answering team (`review.reviewers:
  // team`), raised in the team's inbox: { holdId, kind, bytes, why }. Audience 'all'.
  'packet_held',
  // That hold decided on the team's page: { holdId, resolution: approved | refused | expired }. An
  // approved packet then arrives as an ordinary `context_shared`. Audience 'all'.
  'packet_released',
  // A runner posted (or refused) an effect a playbook asked for, such as a check run:
  // { effectId, kind, state }. Crossroom's own record: stored for 'all', never delivered to an agent.
  'effect_posted',
  // A seat read the project's record through `record`: { labels, count }. Addressed to that
  // seat, so its page and the owner see which facts it was shown; no other reader.
  'record_consulted',
  // What a playbook did in its room, in Crossroom's constant words with trusted variables only (a
  // gate waiting, a verdict read): { runId, step, note }. Stored for 'all', never delivered to an agent.
  'playbook_note',
  // Chain v2, signatures and compliance. Each is content-free but `brief_set`.
  // A v2 room records each seat's private brief in the chain, so the seat can check later that the
  // brief it was given is the one the record holds: { brief }. Addressed to that seat,
  // never delivered to an agent (its agent read the brief at `join`): on its page and to the owner.
  'brief_set',
  // A compliance holder of the room's organisation read the room: { by, at },
  // `by` being `compliance:<org>`, never a person's words. Audience 'human': the owner's record,
  // never delivered to an agent nor shown in a public view. Every such read also writes an
  // audit entry, and the access itself is shown in the room header, the minutes and the guest
  // seat's briefing.
  'compliance_read',
  // A packet's source was checked at HEAD and signed by its runner:
  // { itemId, label, status, found, of }. Crossroom's own record, never delivered, and stored for its
  // packet's readers only: the packet's audience ('all', or the addressee of a direct one) with its
  // sender as actor, so a direct packet's verdict reaches neither a share link nor a third seat.
  'packet_attested',
  // A seat's runner refused to sign a receipt because a commitment it received did not recompute:
  // { participantId, seq, reason }. Stored for 'all', never delivered to an agent.
  'receipt_disputed',
  // A party to an ended room accepted its minutes as a fair record (the server's `acceptMinutes`):
  // { by: 'owner' | 'seat', participantId?, note? }. The owner's actor is 'human', a seat's its
  // participant id; each party writes at most one. The name printed is looked up from the room's
  // participants when the minutes are rendered, never kept here. Stored for 'all', never delivered
  // to an agent: Crossroom's record, shown on seat pages and in the minutes.
  'minutes_accepted',
  // A seat's agent is waiting on its own user, or has stopped waiting (the server's `setAttention`):
  // { kind: 'approval' | 'question' | 'away' | null }. `approval` is a permission or approval prompt
  // in the agent's own session, which its plugin's hooks report; `question` is the agent ending a
  // turn to ask its user (`ASKING_USER`); `away` is the agent saying it steps away (`say away=1`,
  // whose message says why). Content-free: no tool name, no prompt text. The actor is the
  // seat. Stored for 'all', never delivered to an agent: the others read it in an empty `wait`.
  // `side-room` is a seat whose agent took the link to a side room it called (`call_agent`).
  'participant_attention',
  // An account's own agents (`call_agent`, a registered operation). Each is about one call, by id.
  // A seat asked for one of the agents of the account that holds the room, which asks the owner
  // first: { callId, seat, why, brief?, expiresAt }. Addressed to the asking seat and never
  // delivered to it (its reply said so already): on its page and to the owner, who approves or
  // declines it.
  'agent_call_requested',
  // A call's side room is open: { callId, seat, sideRoomId }. Addressed to the asking seat, which
  // takes its seat link with `call_agent call=<id>`; never a token in the event.
  'agent_call_opened',
  // The owner declined a call: { callId, seat }. Addressed to the asking seat.
  'agent_call_declined',
  // A call's side room ended, and its recap came back: { callId, seat, askerId, recap, cut }, the
  // side room's digest as a stranger may read it, clipped. Stored for 'all'.
  'side_room_recap',
  // A key on the room's board was set or deleted (`board_set`, or the owner's PUT): { key, version,
  // by, deleted? }, `by` being the participant id or 'human'; the value stays in `board_entries`.
  // Stored for 'all', never delivered to an agent: a board change wakes nobody, and the next
  // delivery names the keys that changed (`WaitData.boardChanged`).
  'board_updated',
  // A seat declared a typed tool, or declared one again under its name (`declare_tool`,
  // @parley/shared/typed-tools): { name, slot, tool, description, inputSchema, outputSchema?,
  // replaced? }, the schemas as canonical JSON text. Delivered to every seat, so the others learn
  // what they can call. A typed call is a `context_requested` with `typed` and `input` (the args
  // parsed), and its result a `context_shared` with `typed`, `tool` and `data` (or `failed`).
  'tool_declared',
  // Sub-rooms (@parley/shared/subrooms). The lead proposed one, in a room whose owner decides each
  // ({ id, title, why, seats, budget }, sealed): for 'human' alone, never delivered to an agent.
  'subroom_proposed',
  // A sub-room was opened or refused ({ id, state, title, childId?, budget?, reason?, auto? }):
  // addressed to the lead, so the owner's decision wakes its wait. Opened without asking, the lead's
  // own doing, so it is never delivered back to it.
  'subroom_decided',
  // A sub-room ended, and what its seats closed with (`SubroomEndedPayload`), sealed in the parent:
  // delivered to every seat. Written once the parent's key is in hand, never by the keyless sweep.
  'subroom_ended',
  // One of the room's webhooks (@parley/shared/webhooks) turned itself off after too many failures
  // in a row: { webhookId, host, failures }. For 'human' alone: the owner set it, and no agent, seat
  // page or share link is told. Written once the room's key is in hand, never by the delivery worker
  // keyless: it is owed then, and the owner's next read writes it.
  'webhook_disabled',
  // Lanes (@parley/shared/lane). A side filed an item: { itemId, label, n, kind, title }, `label` its L<n>,
  // the title the filer's words. Delivered to the other side; `publicEvent` drops the title.
  'lane_item_filed',
  // An item moved, or took a note: { itemId, label, n, from, to, version, by }, `by` a seat's letter or
  // 'owner'. Content-free; the note itself lives sealed in `lane_notes`. Delivered to every seat.
  'lane_item_updated',
  // A side's autonomy changed: { side, autonomy, previous, by }, `side` the seat's letter, `by` that
  // seat's letter or 'owner'. Content-free, delivered to every seat: the other side's next delivery
  // says how far this side's agent now goes.
  'lane_settings',
]);
export type EventType = z.infer<typeof EventType>;

/**
 * What a seat's agent is waiting on its own user for: a prompt to approve, a question it asked, or
 * its return, after it said it was stepping away, or its return from a side room it called one of
 * the owner's agents into (`side-room`).
 */
export type SeatAttention = 'approval' | 'question' | 'away' | 'side-room';

export interface ParleyEvent {
  id: string;
  sessionId: string;
  seq: number;
  type: EventType;
  actor: string; // participant id | 'human' | 'system'
  /** Recipients: 'all' or a participant id (direct context). */
  audience: string;
  payload: Record<string, unknown>;
  createdAt: string;
  /**
   * Chain v2's nonce for this event (@parley/shared/chain), unwrapped from the sealed
   * payload by the row mapper of a v2 room. Absent in a v1 room.
   * It travels only with the whole event: the server's public view drops it from every event whose
   * payload it redacts, since beside a partial payload it lets the reader test guesses at what was
   * taken out against the event's commitment.
   */
  nonce?: string;
  /**
   * A signed write's signature, `sig` in E_i, unwrapped with the nonce. It goes
   * with the nonce: `publicEvent` drops both from an event whose payload it redacts.
   */
  sig?: WriteSignature;
}

// ---------- Full state snapshot for the UI ----------
export interface SessionSnapshot {
  session: Session;
  participants: Participant[];
  messages: Message[];
  contextRequests: ContextRequest[];
  contextItems: ContextItem[];
  claims: Claim[];
  positions: Position[];
  events: ParleyEvent[];
  /**
   * Who can open this room, on the owner's snapshot only: absent for a room only this
   * browser holds, and never on a public or seat view.
   */
  access?: RoomAccess;
  /**
   * The room's board (`@parley/shared/board`), on the owner's snapshot of a room created with a
   * board only, `[]` while it is empty. Absent from every other room, and from every view that is
   * not the owner's (`redactSnapshot` builds its own object): a seat reads the board through its
   * `board` operation, and a share link shows no value (its `board_updated` events name the keys
   * that changed, as the conversation does to everyone who can read the room).
   */
  board?: BoardEntry[];
  /**
   * The room's sub-rooms and proposals (@parley/shared/subrooms), on the owner's snapshot of a room
   * that allows them, or that has any. Absent from every other view: `redactSnapshot` builds its own.
   */
  subrooms?: SubroomView[];
  /**
   * A lane's items (@parley/shared/lane), newest last, each with its latest note: on the owner's
   * snapshot and on the seat page of either side (`seatView`), never in a share link's view.
   */
  lane?: LaneItem[];
  /** Each lane side's autonomy, by seat letter, beside `lane`. */
  laneAutonomy?: Record<string, LaneAutonomy>;
}

/**
 * Why a seat is quiet, as the owner's page asks for it (`GET /api/sessions/:id/liveness`).
 * Only what the snapshot does not already carry: the snapshot has join, finish, last-seen,
 * reachability and runner state.
 */
export interface SeatLiveness {
  participantId: string;
  /** A long-poll open right now: the agent's own `wait`, or its Stop hook holding it. */
  listening: 'wait' | 'hook' | null;
  /** Events this seat would be shown that it has not been shown yet. */
  unseen: number;
  /** Last time this seat's Stop hook called in, or null if it never has. */
  hookSeenAt: string | null;
  /** Its agent ended a turn to ask its own user something, and has done nothing since. */
  askingUser: boolean;
  /**
   * What its agent is waiting on its own user for right now, and since when: a prompt to approve
   * in its own session, or a question it ended a turn to ask. Null when it waits on nobody; absent
   * from a server that predates it.
   */
  attention?: { kind: SeatAttention; since: string } | null;
  /** One sentence the owner can act on, or null when there is nothing to explain. */
  verdict: string | null;
}

// ---------- API payloads ----------
export const CreateParticipantInput = z.object({
  name: z.string().min(1).max(60),
  // Never `standing`: that seat is the relay's to make, from an ask link (POST /api/ask).
  kind: CreatableKind,
  privateBrief: z.string().max(20_000).optional(),
  /** What the seat is here for, one line, public to the room. `''` means none. */
  role: z.string().max(ROLE_MAX).optional(),
  /** The room's lead seat: at most one per room. */
  lead: z.boolean().optional(),
  hosted: HostedConfigInput.optional(),
  /** In a lane only (@parley/shared/lane): how far this side's agent goes with an item. `pr` unless set. */
  autonomy: z.enum(LANE_AUTONOMY).optional(),
});
export type CreateParticipantInput = z.infer<typeof CreateParticipantInput>;

export const CreateSessionInput = z.object({
  title: z.string().min(1).max(120),
  mode: SessionMode.default('free'),
  sharedBrief: z.string().max(20_000).default(''),
  maxMessages: z.number().int().min(2).max(500).default(40),
  // The ceiling the code supports. The instance's own cap (6 unless its operator raised it) is
  // checked where a room is made (the server's `createSession`), since a schema can't read the environment.
  participants: z
    .array(CreateParticipantInput)
    .min(1)
    .max(ROOM_SEATS_LIMIT)
    .describe(SEATS_DESCRIPTION),
  /** A shared board the room's seats read and write (a later part builds it). Off unless set. */
  board: z.boolean().optional(),
  /** Tools a seat declares with a schema, and calls checked against it (a later part builds them). */
  typedTools: z.boolean().optional(),
  /** Whether the room's lead may open sub-rooms, and whether it asks the owner first. Off unless set. */
  subrooms: SubroomMode.optional(),
  /**
   * Sparse context (`@parley/shared/sparse`): a packet shared with everyone reaches the other agents
   * as a card (title, description, size, source), opened whole on demand. Off unless set.
   */
  sparse: z.boolean().optional(),
  /**
   * A lane (@parley/shared/lane): two sides that file items for each other and work them later. Two
   * attached seats, no meeting clock, and four more operations. Off unless set.
   */
  lane: z.boolean().optional(),
  /**
   * Create the room in this project: its members may then read it, as the room's header
   * says. Needs an editor of the project, and is chosen here or never: no room moves into a
   * project later. Absent for every anonymous room.
   */
  projectId: z.string().min(1).max(64).optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInput>;

export interface CreateSessionResult {
  session: Session;
  /**
   * `inviteToken` is the participant's only credential and is returned exactly once.
   * The same token addresses the seat two ways: `seatUrl` for an agent that is already
   * running (paste the link into its chat; it drives Crossroom over plain HTTP) and
   * `mcpUrl` for an agent started fresh with an MCP config.
   */
  participants: Array<Participant & { inviteToken: string; mcpUrl: string; seatUrl: string }>;
}

/** Shape of the `wait` tool result delivered to agents. */
export interface Delivery {
  seq: number;
  type: EventType;
  from: string;
  at: string;
  text: string;
  data?: Record<string, unknown>;
  /**
   * Crossroom's own line about the entry, printed after its fence, where no participant can write.
   * Built from facts Crossroom established (a source check), never from participant text.
   */
  note?: string;
}

export { ROLE_MAX, ROOM_SEATS_DEFAULT, ROOM_SEATS_LIMIT, SLOT_LETTERS, SUBROOM_MODES, slotLetter } from './text.js';
export type { Offer, RoomOptions } from './text.js';
