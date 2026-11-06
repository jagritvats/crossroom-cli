/**
 * The workspace contract: work items, artifacts and their revisions, reviews, meetings,
 * knowledge, guests and the request/response shapes of every planned route.
 *
 * Rules every shape here follows:
 * - Project objects are private to the project's readers (`requireReader`); a stranger and a
 *   missing object get the one `WORK_GONE` 404.
 * - Content (titles, briefs, criteria, notes, bodies) is sealed under the project key at rest.
 *   Participant-written text is never printed unquoted into markdown (`inline`/`quote`).
 * - Additive. Nothing here reinterprets an old room or record as accepted work. A source's
 *   identity that is unknown stays unknown (`repo: null`).
 *
 * Pure: zod and nothing from Node. The web may import values from here only where zod's cost is
 * acceptable; otherwise `import type`.
 */
import { z } from 'zod';
import { SYNC_EVERY_HOURS, type SyncEveryHours, TRACKER_LIMITS, TRACKER_READ_ITEMS_MAX, TRACKER_REPORT_BATCH_MAX, type TrackerProvider, type TrackerReadCode, type TrackerReadKind, type TrackerReadState, type TrackerSnapshot } from './trackers.js';

// ---------------------------------------------------------------- ids and refusals

export const WORK_PREFIX = 'work_';
export const ARTIFACT_PREFIX = 'art_';
export const REVISION_PREFIX = 'rev_';
export const REVIEW_PREFIX = 'rvw_';
export const MEETING_PREFIX = 'mtg_';
export const DECISION_PREFIX = 'dec_';
export const ACTION_PREFIX = 'act_';
export const KNOWLEDGE_PREFIX = 'kn_';
export const GUEST_PREFIX = 'gst_';
export const WORKSPACE_PREFIX = 'ws_';
/** A guest link's token, `/guest#g=<token>`; only its hash is stored. */
export const GUEST_TOKEN_PREFIX = 'gt_';
const RANDOM = '[A-Za-z0-9_-]{22}';
const idOf = (prefix: string) => new RegExp(`^${prefix}${RANDOM}$`);
export const WORK_ID = idOf(WORK_PREFIX);
export const ARTIFACT_ID = idOf(ARTIFACT_PREFIX);
export const REVISION_ID = idOf(REVISION_PREFIX);
export const REVIEW_ID = idOf(REVIEW_PREFIX);
export const MEETING_ID = idOf(MEETING_PREFIX);
export const DECISION_ID = idOf(DECISION_PREFIX);
export const ACTION_ID = idOf(ACTION_PREFIX);
export const KNOWLEDGE_ID = idOf(KNOWLEDGE_PREFIX);
export const GUEST_ID = idOf(GUEST_PREFIX);

/** The one 404 for a project object that is missing or not the caller's to see. */
export const WORK_GONE = 'no such item in this project, or you are not allowed to see it';
/** The one 404 for a guest link that is unknown, revoked or expired. */
export const GUEST_GONE = 'this link does not open anything';
/** A write against a version that has moved on: the answer carries the current item. */
export const STALE_VERSION = 'this item changed since you read it';
/** A review against a revision whose digest is not the one it was written for. */
export const STALE_REVISION = 'that revision is not the one the review was written for';

const Iso = z.string().min(1).max(40);
const Text = (max: number) => z.string().max(max);
const Title = z.string().trim().min(1).max(200);
/** A sha256 digest, lower-case hex. */
export const Digest = z.string().regex(/^[0-9a-f]{64}$/);
export type Digest = z.infer<typeof Digest>;

export const MAX_BRIEF_CHARS = 20_000;
export const MAX_CRITERIA = 30;
export const MAX_CRITERION_CHARS = 500;
export const MAX_ARTIFACT_BODY_CHARS = 200_000;
export const MAX_AGENDA = 30;
export const MAX_PRE_READS = 20;

export const Criteria = z.array(z.string().trim().min(1).max(MAX_CRITERION_CHARS)).max(MAX_CRITERIA);

// ---------------------------------------------------------------- source identity

/**
 * Where a piece of knowledge or work came from. `repo` and `revision` are null when unknown, and a
 * legacy source (a free string) reads as `provider: 'unknown'`, never guessed.
 */
export const SourceProvider = z.enum(['github', 'azure', 'jira', 'parley', 'manual', 'unknown']);
export type SourceProvider = z.infer<typeof SourceProvider>;
export const SourceRef = z
  .object({
    provider: SourceProvider,
    /** `owner/name`, or null where unknown. */
    repo: z.string().max(200).nullable(),
    path: z.string().max(1000),
    /** A commit SHA or tag, or null where unknown. */
    revision: z.string().max(200).nullable(),
  })
  .strict();
export type SourceRef = z.infer<typeof SourceRef>;

// ---------------------------------------------------------------- work items

export const WorkState = z.enum(['proposed', 'accepted', 'working', 'blocked', 'ready_for_review', 'accepted_outcome', 'cancelled']);
export type WorkState = z.infer<typeof WorkState>;
export const WORK_STATE_LABEL: Readonly<Record<WorkState, string>> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  working: 'Working',
  blocked: 'Blocked',
  ready_for_review: 'Ready for review',
  accepted_outcome: 'Outcome accepted',
  cancelled: 'Cancelled',
};
/**
 * Moves the server allows, by `POST .../transition`. `accepted_outcome` is reachable from
 * `ready_for_review` only, and only by the owner or an accepted review (`acceptOutcome`), never
 * by an agent or a run. A cancelled item is final.
 */
export const WORK_TRANSITIONS: Readonly<Record<WorkState, readonly WorkState[]>> = {
  proposed: ['accepted', 'cancelled'],
  accepted: ['working', 'blocked', 'cancelled'],
  working: ['blocked', 'ready_for_review', 'cancelled'],
  blocked: ['accepted', 'working', 'cancelled'],
  ready_for_review: ['working', 'accepted_outcome', 'cancelled'],
  accepted_outcome: [],
  cancelled: [],
};

/**
 * Who has a piece of work. `account` is a person and `team` a team. `seat` is one seat in one room (a
 * participant id), and `agent` a team's standing agent, the one a project's People tab lists (a standing
 * seat id), which answers from its team's runner in any room it is seated in.
 */
export const Delegate = z
  .object({ kind: z.enum(['seat', 'account', 'team', 'agent']), ref: z.string().min(1).max(200) })
  .strict();
export type Delegate = z.infer<typeof Delegate>;

// ---------------------------------------------------------------- what a tracker says (`@parley/shared/trackers`)

const L = TRACKER_LIMITS;
const word = (max: number) => z.string().max(max);
export const TrackerLinkSchema = z
  .object({
    kind: z.enum(['pull_request', 'work_item', 'commit', 'branch', 'web']),
    relation: word(L.word),
    url: z.url().max(L.url),
    title: word(L.linkTitle),
    state: word(L.word),
  })
  .strict();
export const TrackerCommentSchema = z
  .object({ author: word(L.person).nullable(), at: z.string().max(40).nullable(), text: z.string().max(L.comment + 1) })
  .strict();
export const TrackerIterationSchema = z
  .object({ name: word(L.word * 2), path: word(L.iterationPath), start: z.string().max(40).nullable(), end: z.string().max(40).nullable() })
  .strict();
/**
 * What a mirrored item's tracker says about it (`TrackerSnapshot` in `@parley/shared/trackers`),
 * kept in its sealed source. A work list leaves `comments` out; one item carries them.
 */
export const TrackerSnapshotSchema = z
  .object({
    key: word(L.key),
    type: word(L.word),
    state: word(L.word),
    assignee: word(L.person).nullable(),
    iteration: TrackerIterationSchema.nullable(),
    labels: z.array(word(L.label)).max(L.labels),
    priority: word(L.word),
    points: z.number().finite().min(0).max(100_000).nullable(),
    links: z.array(TrackerLinkSchema).max(L.links),
    comments: z.array(TrackerCommentSchema).max(L.comments),
    commentCount: z.number().int().min(0).max(1_000_000),
    updatedAt: z.string().max(40).nullable(),
    readAt: z.string().max(40),
    readBy: z.enum(['crossroom', 'account', 'runner']),
  })
  .strict();
type SnapshotMatches = z.infer<typeof TrackerSnapshotSchema> extends TrackerSnapshot ? (TrackerSnapshot extends z.infer<typeof TrackerSnapshotSchema> ? true : never) : never;
const snapshotMatches: SnapshotMatches = true;
void snapshotMatches;

export const WorkSource = z
  .object({
    /** `native`: Crossroom holds the truth. `external`: the provider does, and Crossroom mirrors it. */
    authority: z.enum(['native', 'external']),
    provider: SourceProvider.optional(),
    url: z.string().max(2000).optional(),
    externalId: z.string().max(200).optional(),
    /** What the tracker said when it was last read; absent for an item made here, or imported before this was kept. */
    snapshot: TrackerSnapshotSchema.optional(),
  })
  .strict();
export type WorkSource = z.infer<typeof WorkSource>;

export const AssignmentState = z.enum(['proposed', 'accepted', 'declined', 'countered']);
export type AssignmentState = z.infer<typeof AssignmentState>;
export const Assignment = z
  .object({
    state: AssignmentState,
    /** Who made the latest move: `account:<id>`. */
    by: z.string().max(200),
    note: Text(1000),
  })
  .strict();
export type Assignment = z.infer<typeof Assignment>;

export interface WorkItem {
  id: string;
  projectId: string;
  title: string;
  brief: string;
  criteria: string[];
  state: WorkState;
  ownerAccountId: string;
  delegate: Delegate | null;
  dependsOn: string[];
  expectedArtifactId: string | null;
  /** When an owner wants to look at it again; past it, an `action_due` item waits. */
  reviewPoint: string | null;
  source: WorkSource;
  assignment: Assignment | null;
  /** Bumped by every write. A PATCH carries the one it read. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const WorkEventKind = z.enum([
  'created',
  'edited',
  'transition',
  'assignment',
  'artifact_linked',
  'run_linked',
  'run_outcome',
  'external_update',
  'comment_sent',
  'imported',
]);
export type WorkEventKind = z.infer<typeof WorkEventKind>;
/** One line of an item's history. `detail` is sealed text: quote it when printing. */
export interface WorkEvent {
  id: string;
  workId: string;
  kind: WorkEventKind;
  /** `account:<id>`, `seat:<id>`, `system`. */
  actor: string;
  from: WorkState | null;
  to: WorkState | null;
  detail: string;
  at: string;
}

// ---------------------------------------------------------------- artifacts and review

export const ArtifactKind = z.enum(['markdown', 'text', 'link']);
export type ArtifactKind = z.infer<typeof ArtifactKind>;
export const ArtifactAudience = z.enum(['project', 'reviewers', 'private']);
export type ArtifactAudience = z.infer<typeof ArtifactAudience>;

/** Where a revision stands: derived from its reviews, never stored. A new revision starts `unreviewed`. */
export const RevisionStatus = z.enum(['unreviewed', 'changes_requested', 'accepted', 'superseded']);
export type RevisionStatus = z.infer<typeof RevisionStatus>;
export const REVISION_STATUS_LABEL: Readonly<Record<RevisionStatus, string>> = {
  unreviewed: 'Unreviewed',
  changes_requested: 'Changes requested',
  accepted: 'Accepted',
  superseded: 'Superseded',
};
/** The one 404 for an artifact or revision that is missing, or private to someone else. */
export const ARTIFACT_GONE = 'no such artifact in this project, or you are not allowed to see it';

export interface Artifact {
  id: string;
  projectId: string;
  title: string;
  kind: ArtifactKind;
  audience: ArtifactAudience;
  criteria: string[];
  latestRevision: number;
  /** The latest revision's status. */
  latestStatus: RevisionStatus;
  /** Who accepted the latest revision, when it is accepted. */
  latestAcceptedBy?: RevisionAcceptance;
  createdAt: string;
  updatedAt: string;
}

/** Whether a reviewer was a member of the project or a guest holding a link, recorded when the review was posted. */
export type ReviewStanding = 'member' | 'guest';

/** Who accepted a revision, and as what. A guest's acceptance is always labelled so (`acceptedLabel`). */
export interface RevisionAcceptance {
  standing: ReviewStanding;
  /** `account:<id>`. */
  by: string;
}

/** The words a reader sees for an acceptance: a guest's is never shown as a member's. */
export const acceptedLabel = (a: RevisionAcceptance | undefined, name?: string): string =>
  a?.standing === 'guest' ? `accepted by guest ${name ?? a.by.replace(/^account:/, '')}` : 'accepted';

export interface ArtifactRevision {
  id: string;
  artifactId: string;
  /** 1, 2, 3... Revisions are immutable; a change is a new one. */
  n: number;
  /** sha256 of the body (or of the link's URL for a link), lower-case hex. */
  digest: Digest;
  /** True for a link that can change under the reviewer (a URL not pinned to a commit). */
  mutable: boolean;
  url?: string;
  authorKind: 'account' | 'seat' | 'system';
  authorRef: string;
  /** Derived from the reviews of this revision alone: accepting revision 2 says nothing of revision 1. */
  status: RevisionStatus;
  /** Set when `status` is `accepted`: the review that accepted it. */
  acceptedBy?: RevisionAcceptance;
  createdAt: string;
}

export const ReviewVerdict = z.enum(['comment', 'request_changes', 'accept', 'supersede']);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;
export interface Review {
  id: string;
  revisionId: string;
  /** The digest the reviewer read. A review against a moved revision is refused (409). */
  revisionDigest: Digest;
  verdict: ReviewVerdict;
  criteriaChecked: number[];
  note: string;
  by: string;
  /** Member or guest, as recorded when the review was posted. */
  standing: ReviewStanding;
  at: string;
}

// ---------------------------------------------------------------- meetings

export const MeetingState = z.enum(['draft', 'open', 'minutes_proposed', 'closed']);
export type MeetingState = z.infer<typeof MeetingState>;
export const MeetingLimits = z
  .object({
    minutes: z.number().int().min(1).max(24 * 60),
    turns: z.number().int().min(1).max(500),
    usd: z.number().min(0).max(1000).optional(),
  })
  .strict();
export type MeetingLimits = z.infer<typeof MeetingLimits>;
export const AgendaItem = z.object({ title: Title, note: Text(2000).optional() }).strict();
export type AgendaItem = z.infer<typeof AgendaItem>;
/** A pre-read: one revision of one artifact, pinned by digest. */
export const PreRead = z.object({ artifactId: z.string().min(1).max(100), revision: z.number().int().min(1), digest: Digest.optional() }).strict();
export type PreRead = z.infer<typeof PreRead>;

export interface Meeting {
  id: string;
  projectId: string;
  title: string;
  question: string;
  agenda: AgendaItem[];
  preReads: PreRead[];
  /** The project room the meeting opened, or null before it opens. */
  sessionId: string | null;
  limits: MeetingLimits;
  state: MeetingState;
  /** Moves on every edit; a PATCH may carry the one it read, and a stale one is refused (409). */
  version: number;
  /** When the room's time limit runs out (opened + `limits.minutes`), or null before it opens. */
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const ProposalState = z.enum(['proposed', 'accepted', 'rejected']);
export type ProposalState = z.infer<typeof ProposalState>;
export interface Decision {
  id: string;
  meetingId: string;
  text: string;
  state: ProposalState;
  /** Positions that disagreed: disputed claims are recorded here, not dropped. */
  dissent: string[];
  /** A person changed the proposed wording; a regeneration then leaves the row alone. */
  edited: boolean;
}
export const ActionState = z.enum(['proposed', 'accepted', 'declined']);
export type ActionState = z.infer<typeof ActionState>;
export interface ActionItem {
  id: string;
  meetingId: string;
  text: string;
  state: ActionState;
  ownerAccountId: string | null;
  /** What done looks like. An action cannot be accepted without an owner and at least one. */
  criteria: string[];
  /** The work item an accepted action became. */
  workItemId: string | null;
  edited: boolean;
}
export interface ProposedMinutes {
  meetingId: string;
  /** Derived from the room's deterministic minutes; regenerating replaces proposed rows only. */
  summary: string;
  decisions: Decision[];
  actions: ActionItem[];
  openQuestions: string[];
  generatedAt: string;
}

// ---------------------------------------------------------------- knowledge

export const KnowledgeKind = z.enum(['decision', 'finding', 'open_question', 'artifact']);
export type KnowledgeKind = z.infer<typeof KnowledgeKind>;
export const KnowledgeAcceptance = z.enum(['proposed', 'accepted', 'rejected']);
export type KnowledgeAcceptance = z.infer<typeof KnowledgeAcceptance>;
export const KnowledgeAudience = z.enum(['project', 'reviewers']);
export type KnowledgeAudience = z.infer<typeof KnowledgeAudience>;
export interface KnowledgeEntry {
  id: string;
  projectId: string;
  kind: KnowledgeKind;
  text: string;
  sources: SourceRef[];
  audience: KnowledgeAudience;
  acceptance: KnowledgeAcceptance;
  /** The latest source re-check, or null if it never ran. */
  lastCheck: { at: string; result: 'matches' | 'differs' | 'not_found' | 'path_only' | 'unchecked' } | null;
  createdAt: string;
  /** Where the entry comes from: a written entry, a promoted fact, an accepted decision or an accepted artifact revision. */
  origin: KnowledgeOrigin;
  /**
   * What kind of statement it is, so a reader tells them apart: `quoted_fact` (a promoted fact, with the
   * signed minutes behind it), `accepted_decision` (a person accepted it), `artifact` (an accepted
   * revision) or `inference` (a written finding or question that nobody has checked against a source).
   */
  basis: KnowledgeBasis;
  /** The account that wrote it, or null for a derived entry. */
  author: string | null;
  decidedAt: string | null;
  /** The object it came from (a fact label, a decision id or `art_...#n`), null for a written entry. */
  ref: string | null;
  /** The meeting an accepted decision was made in (plain id), so a reader can open it. Absent on every other entry. */
  meetingId?: string;
}
export const KnowledgeOrigin = z.enum(['entry', 'fact', 'decision', 'artifact']);
export type KnowledgeOrigin = z.infer<typeof KnowledgeOrigin>;
export const KnowledgeBasis = z.enum(['quoted_fact', 'accepted_decision', 'artifact', 'inference']);
export type KnowledgeBasis = z.infer<typeof KnowledgeBasis>;

// ---------------------------------------------------------------- guests and workspaces

export const GuestObject = z
  .object({ kind: z.enum(['artifact_revision', 'meeting_minutes']), id: z.string().min(1).max(100) })
  .strict();
export type GuestObject = z.infer<typeof GuestObject>;
export interface GuestGrant {
  id: string;
  projectId: string;
  objects: GuestObject[];
  role: 'reviewer';
  expiresAt: string;
  createdBy: string;
  revokedAt?: string | null;
}

export const WorkspaceKind = z.enum(['personal', 'org']);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;
export interface WorkspaceSummary {
  id: string;
  kind: WorkspaceKind;
  name: string;
  /** The caller's role there: owner, admin, member... */
  role: string;
}

// ---------------------------------------------------------------- route shapes

/** `GET /api/workspaces` */
export interface WorkspacesResult {
  workspaces: WorkspaceSummary[];
}
/** `POST /api/workspaces` (an organisation) and `POST /api/workspaces/personal` (idempotent, no body). */
export const CreateWorkspaceInput = z.object({ name: Title }).strict();
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInput>;
export interface WorkspaceResult {
  workspace: WorkspaceSummary;
  /** The workspace's first team, the lead team of a project made there at once. */
  leadTeamId?: string;
}

/** `GET /api/projects/:p/work?state=&delegate=` */
export interface WorkListResult {
  items: WorkItem[];
}
/** `POST /api/projects/:p/work` */
export const CreateWorkInput = z
  .object({
    title: Title,
    brief: Text(MAX_BRIEF_CHARS).default(''),
    criteria: Criteria.default([]),
    delegate: Delegate.nullable().default(null),
    dependsOn: z.array(z.string().max(100)).max(30).default([]),
    expectedArtifactId: z.string().max(100).nullable().default(null),
    reviewPoint: Iso.nullable().default(null),
  })
  .strict();
export type CreateWorkInput = z.infer<typeof CreateWorkInput>;
/** `PATCH /api/projects/:p/work/:w` carries the `version` it read; a stale one answers 409 with the current item. */
export const PatchWorkInput = z
  .object({
    version: z.number().int().min(1),
    title: Title.optional(),
    brief: Text(MAX_BRIEF_CHARS).optional(),
    criteria: Criteria.optional(),
    delegate: Delegate.nullable().optional(),
    dependsOn: z.array(z.string().max(100)).max(30).optional(),
    expectedArtifactId: z.string().max(100).nullable().optional(),
    reviewPoint: Iso.nullable().optional(),
  })
  .strict();
export type PatchWorkInput = z.infer<typeof PatchWorkInput>;
export interface WorkResult {
  item: WorkItem;
  history: WorkEvent[];
}
export interface StaleWorkResult {
  error: typeof STALE_VERSION;
  current: WorkItem;
}
/** `POST /api/projects/:p/work/:w/assignment` */
export const AssignmentInput = z
  .object({ action: z.enum(['propose', 'accept', 'decline', 'counter']), delegate: Delegate.optional(), note: Text(1000).default('') })
  .strict();
export type AssignmentInput = z.infer<typeof AssignmentInput>;
/** `POST /api/projects/:p/work/:w/transition` */
export const TransitionInput = z.object({ to: WorkState, version: z.number().int().min(1), note: Text(1000).default('') }).strict();
export type TransitionInput = z.infer<typeof TransitionInput>;
/**
 * `GET`/`PUT /api/projects/:p/brief`: the project's objective. A PUT carries the `version` it read
 * (0 for a project with no objective yet); a stale one answers 409 with the current brief.
 */
export const ProjectBriefInput = z.object({ objective: Text(MAX_BRIEF_CHARS), version: z.number().int().min(0) }).strict();
export type ProjectBriefInput = z.infer<typeof ProjectBriefInput>;
export interface ProjectBriefResult {
  objective: string;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}
export interface StaleBriefResult {
  error: typeof STALE_VERSION;
  current: ProjectBriefResult;
}

/** `GET /api/projects/:p/artifacts` */
export interface ArtifactListResult {
  artifacts: Artifact[];
}
/** `POST /api/projects/:p/artifacts` creates the artifact and its first revision. */
export const CreateArtifactInput = z
  .object({
    title: Title,
    kind: ArtifactKind,
    audience: ArtifactAudience.default('project'),
    criteria: Criteria.default([]),
    body: Text(MAX_ARTIFACT_BODY_CHARS).optional(),
    url: z.url().max(2000).optional(),
  })
  .strict();
export type CreateArtifactInput = z.infer<typeof CreateArtifactInput>;
/** `POST /api/projects/:p/artifacts/:art/revisions` */
export const CreateRevisionInput = z
  .object({ body: Text(MAX_ARTIFACT_BODY_CHARS).optional(), url: z.url().max(2000).optional() })
  .strict();
export type CreateRevisionInput = z.infer<typeof CreateRevisionInput>;
export interface ArtifactResult {
  artifact: Artifact;
  revisions: ArtifactRevision[];
}
export interface RevisionResult {
  revision: ArtifactRevision;
  /** The body; absent for a link. Participant text: quote it when printing. */
  body?: string;
  reviews: Review[];
}
/** `GET .../artifacts/:art/diff?from=&to=` */
export interface DiffLine {
  op: 'same' | 'add' | 'del';
  text: string;
}
export interface DiffResult {
  from: number;
  to: number;
  lines: DiffLine[];
}
/** `POST .../revisions/:rev/reviews` */
export const CreateReviewInput = z
  .object({
    revisionDigest: Digest,
    verdict: ReviewVerdict,
    criteriaChecked: z.array(z.number().int().min(0).max(MAX_CRITERIA)).max(MAX_CRITERIA).default([]),
    note: Text(4000).default(''),
  })
  .strict();
export type CreateReviewInput = z.infer<typeof CreateReviewInput>;
export interface ReviewPosted {
  review: Review;
  /** The revision's status after this review. */
  status: RevisionStatus;
  /** True when this review accepted the revision. */
  accepted: boolean;
}

/** `GET /api/projects/:p/meetings` */
export interface MeetingListResult {
  meetings: Meeting[];
}
/**
 * Rooms opened for project work. `POST /api/projects/:p/room-links` opens a room for a
 * work item ("Discuss in a room"); `GET` lists every link of the project, so a room's page, a work
 * item and a meeting can each find theirs. The title is the linked object's own, read under the
 * project key.
 */
export const DiscussInput = z.object({ workId: z.string().regex(WORK_ID) }).strict();
export type DiscussInput = z.infer<typeof DiscussInput>;
export interface RoomLink {
  sessionId: string;
  /** Exactly one of these is set. */
  workId: string | null;
  meetingId: string | null;
  /** The linked object's title, or null when it cannot be read any more. */
  title: string | null;
  /** The room's status (`live` | `ended`), or null once the room is gone. */
  status: string | null;
  createdAt: string;
}
export interface RoomLinksResult {
  links: RoomLink[];
}
/** The answer to opening a room for a work item: the room, and each seat's link, shown once. */
export interface DiscussResult {
  link: RoomLink;
  seats: MeetingSeat[];
}

// ---------------------------------------------------------------- agent operations on project work

/**
 * Three seat operations offered in a project room: `work` reads the
 * work item or meeting the room was opened for, `submit` hands text in as an artifact revision of
 * that item, `report` moves the item between working, blocked and ready for review. A seat never
 * reads anything else of the project, and never accepts an outcome (`accepted_outcome` is a
 * person's act on the server).
 */
/** The longest text one `submit` carries, and the note one `report` carries. */
export const SEAT_SUBMIT_MAX = 30_000;
export const SEAT_NOTE_MAX = 500;
/** How often one seat may submit and report in one room: every call writes to the project's record. */
export const SEAT_SUBMITS_MAX = 10;
export const SEAT_REPORTS_MAX = 20;
/** The most characters of an item's brief `work` hands a seat. */
export const SEAT_BRIEF_MAX = 6000;
/** The states a seat may report. `accepted_outcome` is never among them. */
export const SEAT_REPORT_STATES = ['working', 'blocked', 'ready_for_review'] as const;
export type SeatReportState = (typeof SEAT_REPORT_STATES)[number];
/** What a project room that was opened for nothing answers `work`, `submit` and `report`. */
export const NOT_LINKED = 'This room is not linked to project work, so there is nothing here to read, submit to or report on.';

/**
 * `submit(body)`, as a tool schema's raw shape. Kept bare: every character of these schemas and
 * their descriptions is in the tool list of every agent in a project room (a test holds
 * the whole list to 9,200). An empty body is refused by the artifact's own check (`NEEDS_BODY`).
 */
export const SubmitOpArgs = {
  body: z.string().max(SEAT_SUBMIT_MAX),
};
/** `report(state, note?)`, as a tool schema's raw shape. */
export const ReportOpArgs = {
  state: z.enum(SEAT_REPORT_STATES),
  /** Longer than `SEAT_NOTE_MAX` is cut by the operation, not refused: the schema stays short. */
  note: z.string().optional(),
};

/** `OpData.work`: the object this room was opened for. Participant text throughout: fence it. */
export interface WorkOpData {
  kind: 'work' | 'meeting';
  title: string;
  /** An item's brief, or a meeting's question. */
  brief: string;
  /** An item's criteria. Empty for a meeting. */
  criteria: string[];
  /** A meeting's agenda, one title each. Empty for an item. */
  agenda: string[];
  state: string;
  /** The artifact an item expects, if it names one this seat can see. */
  expected: { title: string; revisions: number } | null;
  /** The brief was cut at `SEAT_BRIEF_MAX`. */
  cut: boolean;
}
/** `OpData.submit`. */
export interface SubmitOpData {
  revision: number;
  /** True when this submission started the item's artifact. */
  created: boolean;
}
/** `OpData.report`. */
export interface ReportOpData {
  state: WorkState;
  from: WorkState;
  /** False when the item was in that state already. */
  changed: boolean;
  /** Set when the item went through another state to get there. */
  via: WorkState | null;
}

/** `POST /api/projects/:p/meetings` */
export const CreateMeetingInput = z
  .object({
    title: Title,
    question: Text(2000).default(''),
    agenda: z.array(AgendaItem).max(MAX_AGENDA).default([]),
    preReads: z.array(PreRead).max(MAX_PRE_READS).default([]),
    limits: MeetingLimits.default({ minutes: 60, turns: 40 }),
  })
  .strict();
export type CreateMeetingInput = z.infer<typeof CreateMeetingInput>;
/** `PATCH /api/projects/:p/meetings/:m`: edits while the meeting is a draft, or proposed rows before they are accepted. */
export const PatchMeetingInput = z
  .object({
    title: Title.optional(),
    question: Text(2000).optional(),
    agenda: z.array(AgendaItem).max(MAX_AGENDA).optional(),
    preReads: z.array(PreRead).max(MAX_PRE_READS).optional(),
    limits: MeetingLimits.optional(),
  })
  .strict()
  .extend({
  version: z.number().int().min(1).optional(),
  /** New wording for proposed rows (rows already decided are refused). */
  decisions: z.array(z.object({ id: z.string().min(1).max(100), text: Text(2000).min(1) }).strict()).max(60).optional(),
  actions: z
    .array(z.object({ id: z.string().min(1).max(100), text: Text(2000).min(1), ownerAccountId: z.string().max(100).nullable().optional(), criteria: Criteria.optional() }).strict())
    .max(60)
    .optional(),
});
export type PatchMeetingInput = z.infer<typeof PatchMeetingInput>;
/** Where a seat's agent pastes its link: the room a meeting opened has these seats. */
export interface MeetingSeat {
  name: string;
  seatUrl: string;
  /** The seat's participant id and slot, so the page that opened the room can keep its link (`parley:invites:<id>`). */
  id?: string;
  slot?: number;
}
export interface MeetingResult {
  meeting: Meeting;
  minutes: ProposedMinutes | null;
  /** Only the answer to opening a meeting: the seat links, shown once. */
  seats?: MeetingSeat[];
}
/** `POST .../meetings/:m/decisions/:dec/accept` and `.../actions/:act/accept`. */
export const AcceptProposalInput = z
  .object({
    text: Text(2000).optional(),
    ownerAccountId: z.string().max(100).optional(),
    /** Replaces the action's criteria when accepting an action. */
    criteria: Criteria.optional(),
    /** Decline the proposal (a decision is rejected, an action declined) instead of accepting it. */
    reject: z.boolean().optional(),
  })
  .strict();
export type AcceptProposalInput = z.infer<typeof AcceptProposalInput>;

/** `GET /api/projects/:p/knowledge?q=&kind=` : the accepted view, scoped to the project. */
export interface KnowledgeListResult {
  entries: KnowledgeEntry[];
}
export const CreateKnowledgeInput = z
  .object({ kind: KnowledgeKind, text: Text(4000).min(1), sources: z.array(SourceRef).max(10).default([]), audience: KnowledgeAudience.default('project') })
  .strict();
export type CreateKnowledgeInput = z.infer<typeof CreateKnowledgeInput>;
/** `POST .../knowledge/:k/accept`: an admin accepts the proposal, or (`to: 'rejected'`) turns it down. */
export const KnowledgeDecisionInput = z.object({ to: z.enum(['accepted', 'rejected']).default('accepted') }).strict();
export type KnowledgeDecisionInput = z.infer<typeof KnowledgeDecisionInput>;
/** The unknown-repository label every surface prints for a source whose repository nobody recorded. */
export const UNKNOWN_REPO = 'unknown repository';

/** `POST /api/projects/:p/import` */
export const ImportInput = z.object({ url: z.url().max(2000) }).strict();
export type ImportInput = z.infer<typeof ImportInput>;
export interface ImportResult {
  item: WorkItem;
  /** True when the URL had been imported before and the item was updated, not duplicated. */
  updated: boolean;
}
/**
 * `POST /api/projects/:p/import/reported`: an item a person read from a tracker with their own token,
 * on their own machine or CI (the `crossroom` command), brought into the project. Crossroom holds no
 * tracker credential, so it can't read a private board itself: what arrives is the account's report of
 * the item, stored as an external item (authority stays with the tracker) and labelled as reported by
 * that account. Deduped on the URL's external id, as an import is.
 *
 * Everything past `assignedTo` is optional, so a report from an older command still reads: `criteria`
 * replaces the item's acceptance criteria when given, and the rest becomes `source.snapshot`.
 */
export const ReportedImportInput = z
  .object({
    provider: z.enum(['github', 'azure', 'jira']),
    /**
     * The item's address. It must parse for its provider, which gives the external id: a GitHub issue
     * or pull request, an Azure DevOps work item, or a Jira issue (`/browse/<KEY>`, a self-managed
     * site's too, since the command read it).
     */
    url: z.url().max(2000),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(MAX_BRIEF_CHARS).default(''),
    /** The tracker's own state word (Active, Resolved, Closed...), shown as it stands. */
    state: z.string().trim().max(60).default(''),
    /** The tracker's own type word (Bug, Task, User Story...). */
    type: z.string().trim().max(60).default(''),
    /** Who the tracker says it is assigned to, a display name; shown only, never matched to an account. */
    assignedTo: z.string().trim().max(120).nullable().default(null),
    /** The item's own key: `PROJ-12`, `#42`. */
    key: word(L.key).optional(),
    criteria: z.array(word(L.criterion)).max(L.criteria).optional(),
    iteration: TrackerIterationSchema.nullable().optional(),
    labels: z.array(word(L.label)).max(L.labels).optional(),
    priority: word(L.word).optional(),
    points: z.number().finite().min(0).max(100_000).nullable().optional(),
    links: z.array(TrackerLinkSchema).max(L.links).optional(),
    comments: z.array(TrackerCommentSchema).max(L.comments).optional(),
    commentCount: z.number().int().min(0).max(1_000_000).optional(),
    updatedAt: z.string().max(40).nullable().optional(),
  })
  .strict();
export type ReportedImportInput = z.infer<typeof ReportedImportInput>;

/**
 * Items an account read itself, several at once (`POST /api/projects/:p/import/reported` with
 * `{items}`, and `report_items` on `/mcp/me`): what an agent with its own access to a tracker (a
 * connector, `gh`, an API client) hands over, or a script's sync. Each is one `ReportedImportInput`;
 * the answer lists each item's outcome in order, one failing never stopping the rest.
 */
export const ReportedBatchInput = z.object({ items: z.array(ReportedImportInput).min(1).max(TRACKER_REPORT_BATCH_MAX) }).strict();
export type ReportedBatchInput = z.infer<typeof ReportedBatchInput>;
export interface ReportedBatchResult {
  results: Array<{ ok: true; item: WorkItem; updated: boolean } | { ok: false; url: string; error: string }>;
}

// ---------------------------------------------------------------- reads through a team's runner

/**
 * `POST /api/projects/:p/import/runner` (an editor): ask a team's runner to read one item with the
 * credentials its operator gave it, for an item the relay can't read itself. `runner` is a runner
 * of the project's lead team, by id or name, as a comment's runner is. Answers 202 `{read}`; the item
 * appears when the runner reports, and `GET .../tracker-reads` follows it.
 */
export const RunnerReadInput = z.object({ url: z.url().max(2000), runner: z.string().trim().min(1).max(120) }).strict();
export type RunnerReadInput = z.infer<typeof RunnerReadInput>;

export interface TrackerRead {
  id: string;
  kind: TrackerReadKind;
  provider: TrackerProvider;
  /** The item's address, or the sync's `where`. */
  target: string;
  syncId: string | null;
  /** The runner's id and name, as the fleet names it. */
  runner: { id: string; name: string };
  state: TrackerReadState;
  /** Items made, and refreshed, once done. */
  imported: number;
  refreshed: number;
  /** For an item read: the work item it made or refreshed. */
  workId: string | null;
  code: TrackerReadCode | null;
  /** `account:<id>`, or `system` for a saved sync's schedule. */
  requestedBy: string;
  createdAt: string;
  finishedAt: string | null;
}
/** `GET /api/projects/:p/tracker-reads`: the latest 50, newest first. */
export interface TrackerReadList {
  reads: TrackerRead[];
}

/**
 * A filter a person builds from choices, compiled per tracker by `compileFilter`
 * (`@parley/shared/tracker-read`, which holds the type itself and is zod-free). Every value is a literal
 * of the tracker's language once compiled; `raw` is a condition of the person's own, ANDed in.
 */
const FilterName = z.object({ name: z.string().trim().min(1).max(200) }).strict();
export const TrackerFilterSchema = z
  .object({
    assignee: z.union([z.enum(['me', 'anyone', 'unassigned']), FilterName]).default('anyone'),
    states: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    types: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    sprint: z.union([z.enum(['any', 'current']), FilterName]).default('any'),
    area: z.string().trim().max(200).nullable().default(null),
    labels: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    text: z.string().trim().max(200).nullable().default(null),
    raw: z.string().trim().max(2000).nullable().default(null),
  })
  .strict();
export type TrackerFilterInput = z.infer<typeof TrackerFilterSchema>;

/**
 * `POST /api/projects/:p/import/search` (an editor) and `search_tracker` on `/mcp/me`: one page of a
 * public repository's or project's items, read by the relay without a token. `where` is the repository,
 * project or board's address; `filter` wins over `query`. A private place answers the project's 404
 * whose words name the other ways in.
 */
export const TrackerSearchInput = z
  .object({
    provider: z.enum(['github', 'azure', 'jira']),
    where: z.url().max(2000),
    query: z.string().trim().max(2000).nullable().optional(),
    filter: TrackerFilterSchema.nullable().optional(),
    sprint: z.enum(['current']).nullable().optional(),
    team: z.string().trim().max(120).nullable().optional(),
    cursor: z.string().max(600).nullable().optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type TrackerSearchInput = z.infer<typeof TrackerSearchInput>;
export interface TrackerSearchResult {
  items: Array<{
    url: string;
    key: string;
    title: string;
    state: string;
    type: string;
    iteration: string | null;
    assignee: string | null;
    updatedAt: string | null;
    /** The work item in this project that already mirrors it, or null. */
    imported: string | null;
  }>;
  /** The next page's cursor, or null at the end. */
  next: string | null;
  /** How many match, where the tracker says. */
  total: number | null;
}

/**
 * `POST /api/projects/:p/import/discover` (an editor) and `tracker_options` on `/mcp/me`: one list a
 * public place offers a filter (`OPTION_KINDS` in `@parley/shared/tracker-read`).
 */
export const TrackerDiscoverInput = z
  .object({
    provider: z.enum(['github', 'azure', 'jira']),
    what: z.enum(['milestones', 'labels', 'projects', 'teams', 'iterations', 'types', 'boards', 'sprints', 'statuses']),
    where: z.url().max(2000),
    team: z.string().trim().max(120).nullable().optional(),
  })
  .strict();
export type TrackerDiscoverInput = z.infer<typeof TrackerDiscoverInput>;
export interface TrackerOptionView {
  value: string;
  name: string;
  detail?: string;
  start?: string | null;
  end?: string | null;
  current?: boolean;
}
export interface TrackerDiscoverResult {
  options: TrackerOptionView[];
  /** For `types` and `statuses`: the states. */
  states?: TrackerOptionView[];
}

/**
 * A saved sync (`/api/projects/:p/tracker-syncs`): a query a team's runner runs on a schedule and
 * reports, so a board stays in step with no command run by anyone. `where` and `query` are as
 * `crossroom work sync` takes them: a GitHub repository and search qualifiers, an Azure DevOps project
 * and a WIQL condition, a Jira project or board and a JQL condition. Kept sealed under the project key.
 */
export const TrackerSyncInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    provider: z.enum(['github', 'azure', 'jira']),
    where: z.url().max(2000),
    query: z.string().trim().max(2000).default(''),
    sprint: z.enum(['current']).nullable().default(null),
    /** An Azure DevOps team, for `sprint: 'current'`. */
    team: z.string().trim().max(120).nullable().default(null),
    limit: z.number().int().min(1).max(TRACKER_READ_ITEMS_MAX).default(200),
    everyHours: z.union(SYNC_EVERY_HOURS.map((h) => z.literal(h)) as [z.ZodLiteral<1>, ...z.ZodLiteral<SyncEveryHours>[]]),
    runner: z.string().trim().min(1).max(120),
    enabled: z.boolean().default(true),
    /**
     * Choices instead of a condition (`TrackerFilter`, `@parley/shared/tracker-read`): compiled into
     * the tracker's language when saved, kept beside the compiled `query` so the web can show it again.
     * With a filter, `query` rides inside it as its `raw` part, and `sprint` as its `sprint`.
     */
    filter: TrackerFilterSchema.nullable().default(null),
  })
  .strict();
export type TrackerSyncInput = z.infer<typeof TrackerSyncInput>;
/** `POST .../tracker-syncs/update`: the sync's id, its version, and the fields to change. */
export const TrackerSyncPatch = TrackerSyncInput.partial().extend({ id: z.string().min(1).max(64), version: z.number().int().min(1) }).strict();
export type TrackerSyncPatch = z.infer<typeof TrackerSyncPatch>;
/** `POST .../tracker-syncs/delete` and `/run`. */
export const TrackerSyncRef = z.object({ id: z.string().min(1).max(64) }).strict();

export interface TrackerSync {
  id: string;
  name: string;
  provider: TrackerProvider;
  where: string;
  query: string;
  sprint: 'current' | null;
  team: string | null;
  limit: number;
  everyHours: SyncEveryHours;
  runner: { id: string; name: string };
  enabled: boolean;
  /** The choices it was saved from, or null for a condition written out (`query`). */
  filter: TrackerFilterInput | null;
  version: number;
  lastRun: TrackerRead | null;
  nextRunAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface TrackerSyncList {
  syncs: TrackerSync[];
}

/**
 * A comment on the linked GitHub issue or pull request is two decisions by two calls, because the first
 * request must not be able to approve what it sends:
 * - `POST /api/projects/:p/work/:w/comment` proposes it (`CommentInput`): the text is stored sealed with
 *   its digest and target, and the project's editors and admins get an inbox item. Nothing is queued.
 * - `POST /api/projects/:p/work/:w/comment/approve` (`ApproveCommentInput`) names the stored digest; only
 *   then is the effect queued. The approver is an editor or admin, and in a project that asks for a second
 *   person (`CommentApprovalRule`) is not the one who wrote the text as it stands.
 * - `POST /api/projects/:p/work/:w/comment/edit` (`EditCommentInput`) changes a proposal's text, which
 *   gives it a new digest and takes its approval away: a comment not yet on its way is withdrawn and
 *   needs approving again (409 once it has gone to GitHub).
 * - `GET /api/projects/:p/work/:w/comments` lists the item's proposals with the rule that applies.
 */
export const CommentInput = z.object({ text: z.string().trim().min(1).max(10_000), runner: z.string().min(1).max(64) }).strict();
export type CommentInput = z.infer<typeof CommentInput>;
export const ApproveCommentInput = z.object({ id: z.string().regex(/^wcm_[A-Za-z0-9_-]{16,32}$/), digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type ApproveCommentInput = z.infer<typeof ApproveCommentInput>;
export const EditCommentInput = z.object({ id: z.string().regex(/^wcm_[A-Za-z0-9_-]{16,32}$/), text: z.string().trim().min(1).max(10_000) }).strict();
export type EditCommentInput = z.infer<typeof EditCommentInput>;
export const DIGEST_MISMATCH = 'what you approved is not what would be posted';
/** `self`: the person who wrote a comment may approve it. `second`: someone else must. */
export const CommentApprovalRule = z.enum(['self', 'second']);
export type CommentApprovalRule = z.infer<typeof CommentApprovalRule>;
/** Said in the page, beside the approve button, in these words. */
export const COMMENT_RULE_WORDS: Readonly<Record<CommentApprovalRule, string>> = {
  self: 'In a personal workspace you may approve a comment you wrote yourself.',
  second: 'This project asks for a second person: a comment has to be approved by an editor or admin other than the one who wrote it.',
};
export const SECOND_PERSON_NEEDED = COMMENT_RULE_WORDS.second;
export const COMMENT_ALREADY_SENT = 'This comment has already gone to GitHub. Propose a new one.';
export const COMMENT_GONE = 'no such comment on this item';
export type CommentProposalState = 'proposed' | 'queued' | 'posted' | 'refused' | 'failed' | 'cancelled';
export interface CommentProposal {
  id: string;
  text: string;
  digest: string;
  repo: string;
  number: number;
  runner: string;
  state: CommentProposalState;
  /** `account:<id>` of whoever wrote the text as it stands. */
  textBy: string;
  approvedBy: string | null;
  proposedAt: string;
  approvedAt: string | null;
  /** Edits since it was proposed. */
  revision: number;
  /** Whether the caller may approve this one now, and the plain reason when not. */
  canApprove: boolean;
  why: string | null;
}
export interface CommentProposed {
  proposal: CommentProposal;
  rule: CommentApprovalRule;
}
export interface CommentList {
  comments: CommentProposal[];
  rule: CommentApprovalRule;
  ruleWords: string;
}
export interface CommentQueued {
  queued: { id: string; digest: string; state: 'queued' };
}

/** `POST /api/projects/:p/work/:w/runs` : start a playbook run linked to the item. */
export const DelegateRunInput = z
  .object({ playbook: z.string().min(1).max(100), inputs: z.record(z.string(), z.string().max(4000)).default({}), preview: z.boolean().default(false) })
  .strict();
export type DelegateRunInput = z.infer<typeof DelegateRunInput>;
export interface DelegateRunResult {
  runId: string | null;
  /** The preflight: the playbook's seats, steps, gates and effects, with unknowns listed. It is an estimate; limits bind when each action happens. */
  preflight: { seats: string[]; steps: string[]; gates: string[]; effects: string[]; unknowns: string[] };
  /** The delegation, once started (absent for a preview). */
  run?: WorkRun;
}

/**
 * Where a delegation stands. `starting`: queued, the run not made yet. `running`: the run is under
 * way (a gate or a wait included). `done`: the run ended and the item is ready for review.
 * `failed` and `cancelled`: the run ended without an output, and the item is blocked. `lost`: no run
 * ever appeared for it.
 */
export const WorkRunState = z.enum(['starting', 'running', 'done', 'failed', 'cancelled', 'lost']);
export type WorkRunState = z.infer<typeof WorkRunState>;
/** A delegation of one work item to one playbook run. */
export interface WorkRun {
  id: string;
  workId: string;
  runId: string;
  playbook: string;
  state: WorkRunState;
  /** The run's verdict (`pass | fail | neutral`) once it ended. */
  result: string | null;
  /** A code saying why a run failed or was lost; never text. */
  reason: string | null;
  createdBy: string;
  createdAt: string;
  settledAt: string | null;
}
/** `GET /api/projects/:p/work/:w/runs` */
export interface WorkRunsResult {
  runs: WorkRun[];
}
/** The answer to a request that names a playbook the project has not saved yet: one of Crossroom's starters. */
export const WORK_STARTERS = ['issue-investigation', 'api-contract-change', 'design-review', 'release-readiness'] as const;
export type WorkStarter = (typeof WORK_STARTERS)[number];
/** `POST /api/projects/:p/work/:w/runs/:r/retry`: take a failed delegation up again from the step that died (no body). */
export interface RetryRunResult {
  run: WorkRun;
}
export const RUN_NOT_HELD = 'no such delegation on this item, or you are not allowed to see it';

/** `POST /api/projects/:p/guests` */
export const CreateGuestInput = z
  .object({ objects: z.array(GuestObject).min(1).max(20), expiresInDays: z.number().int().min(1).max(30).default(7) })
  .strict();
export type CreateGuestInput = z.infer<typeof CreateGuestInput>;
export interface GuestCreated {
  grant: GuestGrant;
  /** `/guest#g=<token>`; shown once. */
  link: string;
}
export interface GuestListResult {
  guests: GuestGrant[];
}
/** `GET /api/guest` (header `x-parley-guest`): only what was granted. */
export interface GuestView {
  grant: GuestGrant;
  artifacts: Array<{ artifact: Artifact; revision: ArtifactRevision; body?: string }>;
  minutes: Array<{ meetingId: string; title: string; minutes: ProposedMinutes }>;
}
/** `POST /api/guest/reviews` : a signed-in account reviews a granted revision. */
export const GuestReviewInput = CreateReviewInput.extend({ artifactId: z.string().min(1).max(100), revision: z.number().int().min(1) }).strict();
export type GuestReviewInput = z.infer<typeof GuestReviewInput>;

/** `POST /api/projects/:p/copy` : preview what a copy into an organisation project would take, then commit with a key. */
export const CopyInput = z
  .object({ preview: z.boolean().default(true), targetProjectId: z.string().max(100).optional(), idempotencyKey: z.string().min(8).max(100).optional() })
  .strict();
export type CopyInput = z.infer<typeof CopyInput>;
export interface CopyPreview {
  brief: boolean;
  workItems: number;
  artifacts: number;
  decisions: number;
  knowledge: number;
  /**
   * What a copy leaves behind, in words: credentials, grants, seats, transcripts and rooms are never
   * copied (named, so the preview can say what stays).
   */
  excluded: string[];
  /** What would be copied, by name (each clipped to one line, at most 50 a list). Participant text: print it as text. */
  lists: { workItems: string[]; artifacts: string[]; decisions: string[]; knowledge: string[] };
}
/** `POST /api/projects/:p/copy` with `preview: true` (the default). */
export interface CopyPreviewResult {
  preview: CopyPreview;
}
/** `POST /api/projects/:p/copy` with `preview: false`, a `targetProjectId` and an `idempotencyKey`. */
export interface CopyCommitResult {
  copied: CopyPreview;
  targetProjectId: string;
  /** True when the key had committed before: nothing was copied again. */
  replayed: boolean;
}
/** The refusals of a copy. A target the caller cannot write to is the project's one `ORG_GONE` 404. */
export const COPY_NEEDS_TARGET = 'Name the project to copy into.';
export const COPY_NEEDS_KEY = 'A copy needs an idempotency key of 8 to 100 characters, so a retry copies nothing twice.';
export const COPY_SAME_PROJECT = 'A project cannot be copied into itself.';
export const COPY_KEY_USED = 'That key has already been used for a different project.';
/** `GET /api/projects/:p/export?format=json|md|package`. */
export const EXPORT_FORMATS = ['json', 'md', 'package'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const PROJECT_EXPORT_FORMAT = 'parley-project-export';
export const PROJECT_PACKAGE_FORMAT = 'parley-project-package';
/**
 * `GET /api/projects/:p/handoff` : what someone taking the project over needs to read first.
 * `accepted` holds the items whose outcome a person accepted; `unfinished` every item that is not in a
 * final state (proposed ones included). Nothing here is a credential, a grant, a transcript or a seat.
 */
export interface Handoff {
  objective: string;
  accepted: WorkItem[];
  unfinished: WorkItem[];
  /** Each artifact's latest revision, with where its review stands. */
  revisions: Array<{ artifactId: string; title: string; n: number; digest: Digest; status: RevisionStatus; acceptedBy?: RevisionAcceptance }>;
  decisions: string[];
  openQuestions: string[];
  /** Repositories and paths the project may read, with no credential. */
  sources: SourceRef[];
}

// ---------------------------------------------------------------- people and agents

/** What a project member or a team holds on the project, as `GET /api/projects/:p/people` says it. */
export interface PeopleMember {
  accountId: string;
  /** The sign-in name Crossroom holds for the account, or null. Crossroom keeps no email. */
  login: string | null;
  /** The highest role the account has, directly or through a team. */
  role: 'reader' | 'editor' | 'admin';
  /** Whether the account was named directly, or only through the teams listed. */
  direct: boolean;
  teams: string[];
}
export interface PeopleTeam {
  id: string;
  name: string;
  role: 'reader' | 'editor' | 'admin';
  lead: boolean;
  members: number;
}
/** The things a person can ask of a seat, in the order the matrix shows them. */
export const SEAT_CAPABILITIES = ['status', 'message', 'request', 'pause', 'resume', 'cancel', 'artifact'] as const;
export type SeatCapability = (typeof SEAT_CAPABILITIES)[number];
export type CapabilityState = 'yes' | 'partial' | 'no';
export interface CapabilityCell {
  state: CapabilityState;
  /** One sentence saying how, or why not. */
  note: string;
}
export interface PeopleSeat {
  id: string;
  label: string;
  teamId: string;
  teamName: string;
  /** The role the seat's team holds on this project. */
  teamRole: 'reader' | 'editor' | 'admin';
  runtime: string;
  runtimeLabel: string;
  state: 'live' | 'paused' | 'rotating' | 'revoked' | 'lost';
  lastSeenAt: string | null;
  health: string[];
  /** What to do about the state or health, in a sentence, or null when nothing is wrong. */
  hint: string | null;
  capabilities: Record<SeatCapability, CapabilityCell>;
}
export interface PeopleView {
  members: PeopleMember[];
  teams: PeopleTeam[];
  seats: PeopleSeat[];
}
