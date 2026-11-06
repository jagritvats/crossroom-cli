/**
 * A project's home: the Overview tab and the Activity tab.
 *
 * - `GET /api/projects/:p/overview` (`ProjectOverview`, a reader): the objective, the deliverable the
 *   project is working toward, who owns open work, what to do next, and what waits on the caller.
 * - `GET /api/projects/:p/activity?before=&limit=` (`ActivityResult`, a reader): what changed,
 *   newest first, from the work item history, artifact revisions and reviews, and meetings.
 *
 * Both are read-only, behind the project principal and the `workspace` flag. Everything in them is
 * opened with the project's key for this one answer; none of it is stored anywhere else. Text a
 * participant wrote (a title, a history line) is a plain string for the page to print as text, never
 * as markup. Counts are of the project as a whole: no person is ranked.
 *
 * Pure: types only, so the web may import it with `import type`.
 */
import type { ProjectRole } from './org.js';
import type { ActionState, RevisionStatus, WorkEventKind, WorkState } from './work.js';

/** The artifact the project is working toward now. */
export interface OverviewDeliverable {
  artifactId: string;
  title: string;
  latestRevision: number;
  status: RevisionStatus;
  /** Whether an open work item expects it (otherwise it is only the most recently changed artifact). */
  expected: boolean;
}

/** Open work held by one account. A map of who holds what, in account-id order, never an ordering by count. */
export interface OverviewOwner {
  accountId: string;
  open: number;
  readyForReview: number;
  blocked: number;
}

/** Why something is on the next-actions list: Crossroom's words are chosen from this, never from the item. */
export type NextReason = 'review' | 'blocked' | 'assignment' | 'overdue' | 'active' | 'accepted_action';

export interface OverviewNext {
  /** `work` (an item, in `id`) or `action` (an accepted meeting action not yet turned into work). */
  kind: 'work' | 'action';
  id: string;
  title: string;
  reason: NextReason;
  state: WorkState | ActionState;
  ownerAccountId: string | null;
}

/** Something the caller is waiting on in this project: the inbox's workspace kinds, with a title. */
export interface OverviewAttention {
  kind: 'assignment' | 'artifact_review' | 'action_due' | 'comment_approval';
  /** The thing waited on: a work item, an artifact, an action, or (for `comment_approval`) the proposed comment. */
  ref: string;
  /** The item a proposed comment is on, for `comment_approval` (its `ref` is the comment). */
  workId?: string;
  title: string;
  tab: 'work' | 'artifacts' | 'meetings';
}

export interface ProjectOverview {
  projectId: string;
  name: string;
  role: ProjectRole;
  objective: string;
  objectiveVersion: number;
  deliverable: OverviewDeliverable | null;
  /** Items by state, every state present. */
  counts: Record<WorkState, number>;
  owners: OverviewOwner[];
  /** At most `NEXT_MAX`, most pressing first. */
  next: OverviewNext[];
  attention: OverviewAttention[];
  /** How many meetings and artifacts the project holds, for the tabs. */
  totals: { work: number; artifacts: number; meetings: number };
}
export const NEXT_MAX = 8;

export type ActivityWhat =
  | { area: 'work'; kind: WorkEventKind }
  | { area: 'artifact'; kind: 'revision' }
  | { area: 'review'; kind: 'comment' | 'request_changes' | 'accept' | 'supersede' }
  | { area: 'meeting'; kind: 'created' | 'opened' }
  | { area: 'decision'; kind: 'accepted' | 'declined' }
  | { area: 'action'; kind: 'accepted' | 'declined' };

export interface ActivityEntry {
  /** Stable across reads: the source row's id. */
  id: string;
  at: string;
  what: ActivityWhat;
  /** `account:<id>`, `seat:<id>`, `system`, or empty where the source does not say. */
  actor: string;
  /** What it was about: the item's, artifact's or meeting's id and title. */
  subject: { id: string; title: string };
  /** A work item's move, where it was one. */
  from?: WorkState | null;
  to?: WorkState | null;
  /** A work history line (participant text: print as text), clipped. */
  detail?: string;
  /** For a revision: its number. */
  revision?: number;
  /** For a review: set to `guest` when a guest left it. */
  standing?: 'member' | 'guest';
}

export interface ActivityResult {
  entries: ActivityEntry[];
  /** More older entries exist; ask again with `before` set to the last entry's `at`. */
  more: boolean;
}
export const ACTIVITY_DEFAULT = 50;
export const ACTIVITY_MAX = 100;
export const ACTIVITY_DETAIL_MAX = 200;
