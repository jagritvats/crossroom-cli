/**
 * Connections between two organisations: the one-time code, the approvals, the
 * grants each side keeps for itself, and the API's shapes.
 *
 * There is no directory of organisations, ever: a connection exists only because an admin of
 * one side handed an admin of the other a code, out of band. Neither side can list anything of the
 * other's; each sees the other only through the connection, by an opaque alias, and labels the
 * other side wrote are shown through `inline()`.
 *
 * The web app imports from here with `import type` only, since the input schemas are zod.
 */
import { z } from 'zod';

// ---------------------------------------------------------------- the code

/**
 * `pcx1.<the proposing relay's origin, base64url>.<18 random bytes, base64url>`: the relay part says
 * where to redeem it (a peer relay's, across federation), the random part is the secret, stored only
 * as its hash. Valid `CONNECTION_CODE_HOURS`, used once.
 */
export const CONNECTION_CODE = /^pcx1\.[A-Za-z0-9_-]{4,200}\.[A-Za-z0-9_-]{24}$/;
export const CONNECTION_CODE_HOURS = 24;
/** The one answer for a code that is unknown, expired or used, and for a connection the caller's organisation is not in. */
export const CONNECTION_GONE = 'No such connection, or this code is no longer good. Ask the other organisation for a new one.';
/**
 * One admin of each side approves, or two where an organisation asks for two. How many is each
 * organisation's own setting (`orgs.connection_approvals`, 1 unless its owner sets 2 through
 * `PUT /api/orgs/:o/connection-settings`), read at each approve for every connection of that
 * organisation not yet approved. Never the other side's to choose: when the proposer picked one
 * count for both sides, a redeeming organisation whose owner wanted two of its admins asked was
 * approved by one, and nothing it could send raised the count.
 */
export const CONNECTION_APPROVALS_MAX = 2;

export type ConnectionState = 'proposed' | 'redeemed' | 'approved' | 'revoked' | 'expired';

// ---------------------------------------------------------------- grants

/**
 * What a grant lets the other side ask: one standing seat, a team's seats, or a team whose people
 * answer from the web or their own connector (`people`, connect-teams B1), with no runner behind it.
 */
export type GrantTarget = 'standing_seat' | 'team' | 'people';
export const GRANT_TARGETS = ['standing_seat', 'team', 'people'] as const;

/** Minutes a standing seat's runner has to take a question before its fallback team is asked (connect-teams B3). */
export const FALLBACK_AFTER_DEFAULT = 10;
export const FALLBACK_AFTER_MIN = 2;
export const FALLBACK_AFTER_MAX = 1440;

/** A grant's limits, each checked at the host's create, at the guest relay's dispatch and on the guest runner. */
export const GrantLimits = z
  .object({
    roomsPerDay: z.number().int().min(0).max(1000).optional(),
    asksPerDay: z.number().int().min(0).max(10_000).optional(),
    liveRooms: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type GrantLimits = z.infer<typeof GrantLimits>;

/** A grant as its own side writes it. The label is sealed under that side's key; the alias is opaque. */
export const GrantInput = z
  .object({
    target: z.enum(GRANT_TARGETS),
    targetId: z.string().min(1).max(128),
    label: z.string().min(1).max(80),
    limits: GrantLimits.default({}),
    /**
     * A team of this organisation whose people answer when a standing seat's runner does not take
     * the question: it refused it, or did not lease it within `fallbackAfter` minutes. For a
     * `standing_seat` or `team` grant only.
     */
    fallbackTeam: z.string().min(1).max(128).optional(),
    fallbackAfter: z.number().int().min(FALLBACK_AFTER_MIN).max(FALLBACK_AFTER_MAX).optional(),
  })
  .strict();
export type GrantInput = z.infer<typeof GrantInput>;

/** What the proposing side asks to be granted: kinds and limits only, never a name of the other side's. */
export const GrantProposal = z.object({ target: z.enum(GRANT_TARGETS), limits: GrantLimits.default({}) }).strict();
export type GrantProposal = z.infer<typeof GrantProposal>;

// ---------------------------------------------------------------- the API

/**
 * `POST /api/orgs/:o/connections` (an admin of A): the code is in the answer, once. It names no
 * approval count: each side's is its own organisation's (`ConnectionSettingsInput`).
 */
export const ProposeConnectionInput = z
  .object({
    note: z.string().max(500).optional(),
    proposedGrants: z.array(GrantProposal).max(20).default([]),
  })
  .strict();
export type ProposeConnectionInput = z.infer<typeof ProposeConnectionInput>;
export interface ProposeConnectionResult {
  connection: ConnectionView;
  code: string;
  expiresAt: string;
}

/** `POST /api/connections/redeem` (an admin of B, naming which of its organisations redeems). */
export const RedeemConnectionInput = z.object({ code: z.string().max(400), org: z.string().min(1).max(64) }).strict();
export type RedeemConnectionInput = z.infer<typeof RedeemConnectionInput>;

/** `PUT /api/orgs/:o/connections/:c/grants`: this side's grants, whole. The other side's are never touched. */
export const PutGrantsInput = z.object({ grants: z.array(GrantInput).max(50) }).strict();
export type PutGrantsInput = z.infer<typeof PutGrantsInput>;

/**
 * `PUT /api/orgs/:o/connection-settings` (an owner of this organisation, audited): how many of its
 * admins approve each of its connections. `GET` answers `ConnectionSettingsView` to an admin.
 */
export const ConnectionSettingsInput = z.object({ approvals: z.number().int().min(1).max(CONNECTION_APPROVALS_MAX) }).strict();
export type ConnectionSettingsInput = z.infer<typeof ConnectionSettingsInput>;
export interface ConnectionSettingsView {
  approvals: number;
}

/** A connection as one of its sides sees it. */
export interface ConnectionView {
  id: string;
  state: ConnectionState;
  /** This side's organisation, and the other's alias for display, never its id or slug. */
  side: 'a' | 'b';
  other: { alias: string; label: string | null };
  /** How many of each side's admins must approve: each side's own organisation's setting. */
  approvalsNeeded: { ours: number; theirs: number };
  /** How many of each side's admins approved. */
  approvals: { ours: number; theirs: number };
  ourGrants: GrantView[];
  /** What the other side granted us: aliases and labels, through `inline()`. */
  theirGrants: GrantView[];
  createdAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
}

export interface GrantView {
  alias: string;
  label: string;
  target: GrantTarget;
  limits: GrantLimits;
  revokedAt: string | null;
  /**
   * Where a standing seat's runner may not come, people answer after `after` minutes. This
   * side's own grant names its team (`teamId`); the other side's says only that people may answer.
   */
  fallback?: { after: number; teamId?: string };
}

// ---------------------------------------------------------------- questions people answer (connect-teams B1)

/** A question's id, as `/api/orgs/:o/answers/:q` names it: `tq_` and 16 random bytes. */
export const TEAM_QUESTION_ID = /^tq_[A-Za-z0-9_-]{22}$/;

/** A question across a connection waiting for a person on one of this organisation's teams. */
export interface TeamQuestion {
  id: string;
  /** The connection it came across, and the asking side as this side sees it: its alias and its note, never its name. */
  connectionId: string;
  from: { alias: string; label: string | null };
  /** This side's grant it came through, by its label. */
  grant: string;
  /** The team of this organisation it waits for. */
  teamId: string;
  /** The first line of the asker's question: the asker's words, to show as quoted. Never the room's content. */
  question: string;
  /** When it was put to the team: the room's opening, or the moment a runner's fallback fired. */
  askedAt: string;
}

/** `GET /api/orgs/:o/answers`. */
export interface TeamQuestionsResult {
  questions: TeamQuestion[];
}

/** `POST /api/orgs/:o/answers/:q/take`: seat B, bound to the caller, its link once. */
export interface TeamQuestionTaken {
  question: string;
  sessionId: string;
  participantId: string;
  seatUrl: string;
  mcpUrl: string;
  pageUrl: string;
  pasteLine: string;
}

/** A second member's take: who took it first, by display name. */
export const questionTakenBy = (name: string) => `${name} has already taken this question.`;
/** A people target or a fallback across two relays (federation): refused at grant time, for now. */
export const PEOPLE_NOT_FEDERATED = 'People on a team can answer only across a connection on this Crossroom, not one through another relay.';
