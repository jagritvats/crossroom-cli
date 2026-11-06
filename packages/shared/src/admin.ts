/**
 * The instance's own admin routes: what whoever runs a Crossroom reads about
 * it and what they act on: an account's suspension, and a plan granted to a workspace without
 * payment. Every call carries the instance's
 * `PARLEY_ADMIN_TOKEN` in `x-parley-admin` (`ADMIN_HEADER`), the header only, never the query
 * string; without it, or with another, every route answers 403 `{error}`.
 *
 * Nothing here lists a room: rooms are private to their owners, and the operator is not handed a
 * list of them. Nothing here is sealed content: names, slugs, logins, times and counts.
 *
 * Pure, with no zod and nothing from Node, so the web app may import it as a value.
 *
 * - `GET /api/admin/audit`: the instance's own audit chain (an admin's actions, an account's on
 *   itself, a runner's, an organisation's deletion), as `AuditPage` (@parley/shared/org) newest
 *   first, with the same query as an organisation's (`AuditQuery`: `before`, `actor`, `action`,
 *   `kind`, `since`, `until`) and `actors`. Reading it records nothing. A bad parameter is a 400
 *   naming it.
 * - `GET /api/admin/orgs?q=&after=`: `AdminOrgsPage`, newest first, `ADMIN_PAGE` a page. `q` narrows
 *   to an id, name or slug containing it (any case); `after` is the previous page's `next`.
 * - `GET /api/admin/accounts?q=&after=`: `AdminAccountsPage`, the same way; `q` matches an id or a
 *   login.
 * - `POST /api/admin/accounts/:a/suspend` with `{suspended: boolean}`: `SuspendResult`. Suspends or
 *   restores the account, recorded on the instance's chain as `account.suspend` or
 *   `account.restore` by `admin`; asking for what already holds changes and records nothing
 *   (`changed: false`). An account that does not exist, or was deleted, is 404 `ADMIN_NO_ACCOUNT`; a
 *   body that is not `{suspended: true|false}` is 400 `SUSPEND_INPUT_WRONG`.
 *
 * - `GET /api/admin/plan-grants`: `AdminPlanGrantsPage`, every plan the operator granted, newest
 *   first, lapsed ones included (`inForce` says which hold).
 * - `POST /api/admin/plan-grants` with `PlanGrantInput`: grants the workspace a plan without payment,
 *   replacing any grant it had, recorded on the instance's chain as `org.plan_grant`. A workspace
 *   that does not exist, or was deleted, is 404 `ADMIN_NO_ORG`; a wrong body is 400
 *   `PLAN_GRANT_INPUT_WRONG`.
 * - `POST /api/admin/plan-grants/revoke` with `{orgId}`: ends the grant, recorded as
 *   `org.plan_revoke`; a workspace with no grant changes nothing (`changed: false`).
 *
 * A grant is never touched by billing. While it is in force the workspace is on the higher of the
 * granted plan and the plan it pays for; once it lapses or is revoked, on the plan it pays for.
 *
 * What a suspension stops and what it does not is SECURITY.md's ("Suspending an account").
 */

/** The header the admin token travels in, and only there. */
export const ADMIN_HEADER = 'x-parley-admin';

/** Rows per page of the organisation and account lists. */
export const ADMIN_PAGE = 50;

/** The longest `q` the lists take. */
export const ADMIN_Q_MAX = 100;

export const ADMIN_NO_ACCOUNT = 'no such account';
export const SUSPEND_INPUT_WRONG = 'expected {suspended: true} or {suspended: false}';
export const ADMIN_Q_WRONG = `q is at most ${ADMIN_Q_MAX} characters of one line`;
export const ADMIN_AFTER_WRONG = "after is the id of a row already listed: the previous page's next";

/** An organisation as the operator sees it: its metadata and a count, never what it holds. */
export interface AdminOrg {
  id: string;
  name: string;
  slug: string;
  /** `org`, or `personal`: the single-owner workspace an account gets for itself. */
  kind: 'org' | 'personal';
  /** The billed plan: `free | starter | team`. */
  plan: string;
  /** The operator's grant, lapsed or not, or null for none. Absent from an older server. */
  grant?: AdminPlanGrant | null;
  createdAt: string;
  deletedAt: string | null;
  /** Members standing now: not suspended by the organisation, their accounts not deleted. */
  members: number;
  /** Who created it, and their login while they have one. */
  creator: { id: string; login: string | null } | null;
}

/** The plans the operator may grant. */
export const GRANTABLE_PLANS = ['starter', 'team', 'enterprise'] as const;
export type GrantablePlanName = (typeof GRANTABLE_PLANS)[number];

/** The longest note the operator may keep on a grant. */
export const PLAN_GRANT_NOTE_MAX = 200;

export const ADMIN_NO_ORG = 'no such workspace';
export const PLAN_GRANT_INPUT_WRONG = `expected {orgId, plan: starter|team|enterprise, expiresAt?: a future ISO time or null, note?: one line of at most ${PLAN_GRANT_NOTE_MAX} characters}`;
export const PLAN_REVOKE_INPUT_WRONG = 'expected {orgId}';

/** A plan the operator granted a workspace. */
export interface AdminPlanGrant {
  orgId: string;
  plan: GrantablePlanName;
  grantedAt: string;
  /** When it lapses; null for until revoked. */
  expiresAt: string | null;
  /** The operator's own note, or ''. */
  note: string;
  /** Whether it holds now (not lapsed). */
  inForce: boolean;
}

/** One grant in the list, with the workspace it names. */
export interface AdminPlanGrantRow extends AdminPlanGrant {
  org: { name: string; slug: string; kind: 'org' | 'personal'; plan: string; deletedAt: string | null } | null;
}

export interface AdminPlanGrantsPage {
  grants: AdminPlanGrantRow[];
}

/** `POST /api/admin/plan-grants`'s body. */
export interface PlanGrantInput {
  orgId: string;
  plan: GrantablePlanName;
  /** An ISO time in the future; null or absent for until revoked. */
  expiresAt?: string | null;
  note?: string;
}

/** What a grant or a revocation answers: the workspace as it stands now. */
export interface PlanGrantResult {
  org: AdminOrg;
  /** False for a revocation of a workspace that had no grant. */
  changed: boolean;
}

export interface AdminOrgsPage {
  orgs: AdminOrg[];
  /** Pass as `after` for the next page; null on the last. */
  next: string | null;
}

/** How an account signs in, as the operator sees it: the provider's subject stays on the server. */
export interface AdminIdentity {
  /** `github`, `google`, `microsoft`, or an organisation's IdP (`sso`). */
  provider: string;
  login: string;
  lastLoginAt: string | null;
}

export interface AdminAccount {
  id: string;
  createdAt: string;
  plan: string;
  deletedAt: string | null;
  /** When the operator suspended it, or null. */
  suspendedAt: string | null;
  /** Its sign-ins at the instance's providers; empty for a deleted account. */
  identities: AdminIdentity[];
  /** Its latest sign-in through any provider or organisation IdP, or null. */
  lastSignInAt: string | null;
  /** The organisations it stands in now (personal workspaces included). */
  orgs: number;
}

export interface AdminAccountsPage {
  accounts: AdminAccount[];
  next: string | null;
}

/** `POST /api/admin/accounts/:a/suspend`'s body. */
export interface SuspendInput {
  suspended: boolean;
}

export interface SuspendResult {
  account: AdminAccount;
  /** False when the account already stood as asked: nothing was written or recorded. */
  changed: boolean;
}
