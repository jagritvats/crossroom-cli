/**
 * Analytics without ranking: an organisation's, a team's and a project's rooms over
 * time, as maps keyed by id, never as arrays ordered by a metric. A list of teams sorted by
 * how many rooms they ran is a leaderboard, which Crossroom never keeps, so no shape here can carry
 * one: counts live in records keyed by id or week, and the one array, the edges between teams, is
 * sorted by `(from, to)`.
 *
 * Sources: `room_facts` (content-free, outliving deleted rooms), `runner_jobs`, `policy_events` and
 * `facts`. "Files cited most" needs sealed sources opened, so only the team's own members see it.
 *
 * Pure: zod and nothing from Node. The web app may import from here with `import type` only,
 * so its bundle carries no zod.
 */
import { z } from 'zod';

/** `?weeks=` on every analytics route: 8 unless asked, at most 52. */
export const AnalyticsQuery = z.object({ weeks: z.coerce.number().int().min(1).max(52).default(8) }).strict();
export type AnalyticsQuery = z.infer<typeof AnalyticsQuery>;

/** Counts for one week (keyed by the ISO date of its Monday, UTC). */
export interface WeekCounts {
  rooms: number;
  bothJoined: number;
  crossed: number;
  claimed: number;
  asks: number;
  asksAnswered: number;
  factsFiled: number;
  refused: number;
}

/** Keyed by week, oldest first by key order only: read it through `Object.keys(...).sort()`. */
export type Weekly = Record<string, WeekCounts>;

/**
 * How long gates waited before a decision or a timeout, in buckets by the minutes from
 * `run_steps.started_at` to `ended_at`: under 15 minutes, under an hour, under 4, under a day, and
 * longer. Keyed by bucket name, never ordered by count.
 */
export const GATE_WAIT_BUCKETS = ['lt15m', 'lt1h', 'lt4h', 'lt1d', 'ge1d'] as const;
export type GateWaitBucket = (typeof GATE_WAIT_BUCKETS)[number];

/**
 * What a week's playbook runs came to, from the runs that ended in it (dry runs
 * left out). Every denominator counts failed and cancelled runs too: a rate is `done / (done +
 * failed + cancelled)`, never over the runs that went well alone.
 */
export interface OutcomeWeek {
  runs: { done: number; failed: number; cancelled: number };
  /** Each ended run's result. */
  verdicts: { pass: number; fail: number; neutral: number };
  /** Effects by what became of them (`effects.state`). */
  effects: { posted: number; failed: number; refused: number };
  /** Gates that ended: decided by a person, or timed out. */
  gates: { decided: number; timedOut: number };
  /** Minutes those gates waited, summed, and how many fell in each bucket. */
  gateWaitMinutes: number;
  gateWaits: Record<GateWaitBucket, number>;
}
/**
 * What a week's standing-seat jobs cost, as their runners reported it (`runner_jobs.cost_usd`,
 * `tokens_in`, `tokens_out`; rechecks left out). `jobsCosted` of `jobs` reported a cost at all, so a
 * reader sees how much of the spend is known. Owners, admins and auditors only.
 */
export interface SpendWeek {
  jobs: number;
  jobsCosted: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/** An ask from one team's project to another team's standing seat, counted. Sorted by `(from, to)`, never by `rooms`. */
export interface TeamEdge {
  from: string;
  to: string;
  rooms: number;
}

/** `GET /api/orgs/:o/analytics` (an owner, admin, member or auditor). */
export interface OrgAnalytics {
  orgId: string;
  weeks: string[];
  total: Weekly;
  /** Keyed by team id. */
  teams: Record<string, Weekly>;
  /** Keyed by project id. */
  projects: Record<string, Weekly>;
  edges: TeamEdge[];
  /** The organisation's playbook runs, keyed by week (members and up). */
  outcomes?: Record<string, OutcomeWeek>;
  /** Its standing seats' cost, keyed by week: owners, admins and auditors only, absent for anyone else. */
  spend?: Record<string, SpendWeek>;
}
/** `GET /api/teams/:t/analytics`. `filesCited` only for the team's own members, since it opens sealed sources. */
export interface TeamAnalytics {
  teamId: string;
  weeks: string[];
  total: Weekly;
  /** Keyed by standing seat id. */
  seats: Record<string, Weekly>;
  /** Keyed by path. */
  filesCited?: Record<string, number>;
  /** The team's standing seats' cost, keyed by week: owners, admins and auditors only. */
  spend?: Record<string, SpendWeek>;
}
/**
 * What a project's work came to in one week, counted from columns that are never
 * sealed. A sum and counts, never a ratio: a reader divides, and sees how few there are. No person is
 * named, so there is nothing to rank: a record, never a leaderboard.
 * - `accepted`: work items whose outcome was accepted this week (`accepted_outcome`);
 * - `acceptHours`: the hours from creation to acceptance, summed over those items;
 * - `reviews` and `changesRequested`: artifact reviews that decided a revision, and of those the ones
 *   that asked for changes (a comment decides nothing and is not counted);
 * - `interventions`: times a person moved an item back or stopped it: sent back from review,
 *   blocked, or cancelled after it had started.
 */
export interface WorkWeek {
  accepted: number;
  acceptHours: number;
  reviews: number;
  changesRequested: number;
  interventions: number;
}

/** `GET /api/projects/:p/analytics`. */
export interface ProjectAnalytics {
  projectId: string;
  weeks: string[];
  total: Weekly;
  /** Keyed by fact kind. */
  facts: Record<string, number>;
  /** The project's playbook runs, keyed by week. */
  outcomes?: Record<string, OutcomeWeek>;
  /** The cost of standing seats in its rooms, keyed by week: owners, admins and auditors only. */
  spend?: Record<string, SpendWeek>;
  /** The project's work, keyed by week; absent while the `workspace` flag is off. */
  work?: Record<string, WorkWeek>;
}
