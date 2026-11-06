/**
 * Organisations, teams and projects, fleets under teams, sign-in per organisation and the
 * audit log: every body and answer of `/api/orgs/*`, `/api/teams/*`,
 * `/api/projects/*` (access and rooms), `/api/sso/*`, and the "who can open this room" label.
 *
 * The rule: membership alone grants no room. A room is readable by a project's
 * members only when it was created in that project, which is chosen at creation and shown in the
 * room ("Checkout v2 (14 members)"), and every refusal is the one 404 a stranger gets.
 *
 * Enum-like values are validated here in code, never by CHECK constraints. Pure: zod and nothing
 * from Node. The web app may import from here with `import type` only.
 */
import { z } from 'zod';
import { isSameOriginPath } from './accounts.js';
import type { CliHealth, StandingRuntime } from './runner.js';
import { oneLine } from './text.js';
import { ORG_ROLES, PROJECT_ROLES } from './org-roles.js';

// ---------------------------------------------------------------- ids and names

/** Id prefixes, so an id says what it names in a log line. The rest is 16 random bytes, base64url. */
export const ORG_PREFIX = 'org_';
export const TEAM_PREFIX = 'team_';
export const PROJECT_PREFIX = 'proj_';
export const INVITATION_PREFIX = 'inv_';
const RANDOM = '[A-Za-z0-9_-]{22}';
export const ORG_ID = new RegExp(`^${ORG_PREFIX}${RANDOM}$`);
export const TEAM_ID = new RegExp(`^${TEAM_PREFIX}${RANDOM}$`);
export const PROJECT_ID = new RegExp(`^${PROJECT_PREFIX}${RANDOM}$`);

/** An organisation's slug: lowercase letters, digits and inner hyphens, unique on the instance. */
export const ORG_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** Slugs no organisation may take: they read as parts of Crossroom itself. */
export const RESERVED_SLUGS: readonly string[] = ['admin', 'api', 'app', 'auth', 'help', 'new', 'orgs', 'parley', 'security', 'settings', 'terms', 'www'];

/**
 * A name an organisation gives its own things (itself, a team, a project): one line, collapsed with
 * `oneLine` as the owner's titles are, since it is printed outside any fence (the room header).
 */
export const OrgName = z.string().max(200).transform(oneLine).pipe(z.string().min(1).max(80));

// ---------------------------------------------------------------- roles

/** A member's role in an organisation (`memberships.role`). The lists, and who may do what, are in org-roles.ts. */
export const OrgRole = z.enum(ORG_ROLES);
export type OrgRole = z.infer<typeof OrgRole>;
/** A member's role in a team (`team_members.role`). A maintainer mints the team's runner tokens. */
export const TeamRole = z.enum(['maintainer', 'member']);
export type TeamRole = z.infer<typeof TeamRole>;
/** What `project_access` grants on a project's rooms. */
export const ProjectRole = z.enum(PROJECT_ROLES);
export type ProjectRole = z.infer<typeof ProjectRole>;
/**
 * An organisation's plan. `orgs.plan` is the billed plan, set only by the billing webhook (Free,
 * Starter or Team); Enterprise is never billed here, only granted by the instance's operator
 * (`plan_grants`). What a workspace has is the higher of the two (`higherPlan`).
 */
export const OrgPlan = z.enum(['free', 'starter', 'team', 'enterprise']);
export type OrgPlan = z.infer<typeof OrgPlan>;
/** `orgs.plan` (or a grant's plan) as stored, read as a plan: anything this build does not know is Free. */
export const readPlan = (v: unknown): OrgPlan => (v === 'enterprise' ? 'enterprise' : v === 'team' ? 'team' : v === 'starter' ? 'starter' : 'free');
/** Whether a plan is a paid one (anything but Free), billed or granted. */
export const paidPlan = (plan: OrgPlan): boolean => plan !== 'free';
const PLAN_RANK: Readonly<Record<OrgPlan, number>> = { free: 0, starter: 1, team: 2, enterprise: 3 };
/** The more generous of two plans: a grant never lowers a plan the workspace pays for. */
export const higherPlan = (a: OrgPlan, b: OrgPlan | null | undefined): OrgPlan => (b && PLAN_RANK[b] > PLAN_RANK[a] ? b : a);
/** At least Team: Team itself, or Enterprise. */
export const teamOrAbove = (plan: OrgPlan): boolean => PLAN_RANK[plan] >= PLAN_RANK.team;
/** What the `record` seat operation may show a seat in a project room (`projects.record_for_seats`). */
export const RecordScope = z.enum(['none', 'room', 'project']);
export type RecordScope = z.infer<typeof RecordScope>;

// What a project role allows on a room, and what an organisation role may do: org-roles.ts, which
// the web app imports as a value (it holds no zod).
export { ORG_ACTIONS, ORG_ROLES, PROJECT_ROLES, type OrgAction, orgCan, PROJECT_ROLE_NEEDS, type ProjectNeed, projectRoleAllows } from './org-roles.js';

/** Who `project_access` names: an account, or a team (whose members then hold the role). */
export const AccessPrincipal = z.string().regex(/^(account|team):[A-Za-z0-9_-]{1,64}$/, 'account:<id> or team:<id>');
export type AccessPrincipal = z.infer<typeof AccessPrincipal>;

/**
 * The one 404 body for every organisation, team and project route: no such thing, or not yours.
 * Two answers would tell a non-member which organisations and projects exist.
 */
export const ORG_GONE = 'no such organisation, team or project, or you are not a member of it';

// ---------------------------------------------------------------- organisations and members

/** `POST /api/orgs`: the caller becomes its owner. Under the edge's create limit. */
export const CreateOrgInput = z
  .object({
    name: OrgName,
    slug: z
      .string()
      .regex(ORG_SLUG, 'lowercase letters, digits and hyphens')
      .refine((s) => !RESERVED_SLUGS.includes(s), 'that name is reserved'),
    // Where its database lives, one of the regions the instance's operator offers
    // (keys/residency.ts in the client). Absent: the instance's own data directory.
    region: z.string().max(32).optional(),
  })
  .strict();
export type CreateOrgInput = z.infer<typeof CreateOrgInput>;

/** An organisation as a member sees it (`GET /api/orgs`, `GET /api/orgs/:o`). */
export interface OrgView {
  id: string;
  name: string;
  slug: string;
  /** The plan in force: billed or granted, or Team where the instance lends Team to every workspace. */
  plan: OrgPlan;
  /**
   * The plan paid for or granted by the operator, without the lend: what badges and "Upgrade" read,
   * so a workspace on Free is never shown as on Team. Absent from a server before it: read `plan`.
   */
  billedPlan?: OrgPlan;
  /** The caller's own role. */
  role: OrgRole;
  createdAt: string;
  /** `personal` for the single-owner workspace an account gets for itself; absent means an organisation. */
  kind?: 'org' | 'personal';
}
export interface MemberView {
  accountId: string;
  role: OrgRole;
  /** The provider's handle, for recognising people; never an email. */
  login: string | null;
  suspended: boolean;
  createdAt: string;
}
/** `GET /api/orgs/:o`: the organisation, its teams and projects; its members for an owner or admin. */
export interface OrgDetail extends OrgView {
  teams: TeamView[];
  projects: ProjectView[];
  members?: MemberView[];
}

/** An invitation's token: `x-parley-invite`, shown once in `InvitationResult.url`'s fragment and kept as its hash. */
export const INVITE_HEADER = 'x-parley-invite';
export const INVITE_TOKEN_PREFIX = 'pi_';
export const INVITE_TOKEN = /^pi_[A-Za-z0-9_-]{43}$/;
export const INVITE_DAYS = 7;
export const INVITE_DAYS_MAX = 30;
/** The project roles an invitation can grant: an admin is made by a project admin, not handed out by a link. */
export const InvitationAccess = z.enum(['reader', 'editor']);
export type InvitationAccess = z.infer<typeof InvitationAccess>;
/** `POST /api/orgs/:o/invitations` (owner or admin). Under the edge's create limit. */
export const CreateInvitationInput = z
  .object({
    role: OrgRole.exclude(['owner']).default('member'),
    days: z.number().int().min(1).max(INVITE_DAYS_MAX).default(INVITE_DAYS),
    // Where the invitee lands after accepting (workspace A1): a project the inviter holds, or one work item in it.
    destination: z
      .object({
        project: z.string().regex(new RegExp(`^${PROJECT_PREFIX}${RANDOM}$`)),
        work: z.string().regex(/^work_[A-Za-z0-9_-]{22}$/).optional(),
        // Deliberate access: the project role the invitee gets on accepting. Left out, accepting opens no room.
        access: InvitationAccess.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CreateInvitationInput = z.infer<typeof CreateInvitationInput>;
export interface InvitationResult {
  id: string;
  role: OrgRole;
  expiresAt: string;
  /** `<publicUrl>/orgs/join#i=<token>`: the only place the token ever appears. */
  url: string;
}
/**
 * `GET /api/orgs/:o/invitations` (owner or admin): one invitation that could still make someone a
 * member. Never its token or link: only the token's hash is kept, so a link is shown once, when made.
 */
export interface PendingInvitation {
  id: string;
  role: Exclude<OrgRole, 'owner'>;
  /** The account that made it. */
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  destination?: InvitationDestination;
}
export interface PendingInvitationsResult {
  invitations: PendingInvitation[];
}
/** `POST /api/orgs/:o/invitations/withdraw` (owner or admin): `{ok: true}` whether or not it was still waiting. */
export const WithdrawInvitationInput = z.object({ id: z.string().regex(new RegExp(`^${INVITATION_PREFIX}[A-Za-z0-9_-]{1,64}$`)) }).strict();
export type WithdrawInvitationInput = z.infer<typeof WithdrawInvitationInput>;
/** `POST /api/orgs/invitations/accept`: a signed-in account with the token in `x-parley-invite`. Used once. */
export interface AcceptInvitationResult {
  org: OrgView;
  /** Where the inviter sent them, if anywhere. */
  destination?: InvitationDestination;
}
export interface InvitationDestination {
  project: string;
  work?: string;
  /**
   * In a preview: the role accepting would give on the project. In an accept answer: the role it did
   * give. Absent when the invitation grants nothing, or the grant no longer stands.
   */
  access?: InvitationAccess;
}
/** `PATCH /api/orgs/:o/members/:a` (owner or admin): a new role, or a suspension. The last owner cannot be demoted. */
export const MemberPatchInput = z.object({ role: OrgRole.optional(), suspended: z.boolean().optional() }).strict();
export type MemberPatchInput = z.infer<typeof MemberPatchInput>;

/**
 * `GET /api/orgs/invitations/preview`, the token in `x-parley-invite` (a signed-in account): what an
 * invitation would make its holder, read and never spent, so the join page names the organisation
 * before the press. Every token that would make nobody a member is the one 404 accepting it answers
 * (`INVITE_GONE`), so the preview confirms nothing a token that opens nothing could not.
 */
export interface InvitationPreview {
  org: { name: string };
  role: OrgRole;
  expiresAt: string;
  /** The caller is a member of that organisation already, so accepting would be refused (409). */
  member: boolean;
  destination?: InvitationDestination;
}

/**
 * `DELETE /api/orgs/:o` (its owner; anyone else, an admin of it included, gets the one `ORG_GONE`
 * 404): the organisation's slug, typed as the confirmation. Its subscription is cancelled first,
 * then its members, rooms, teams, projects and their keys go, and every member's calls in flight end.
 */
export const DeleteOrgInput = z.object({ confirm: z.string().max(80) }).strict();
export type DeleteOrgInput = z.infer<typeof DeleteOrgInput>;

// ---------------------------------------------------------------- teams

/** `POST /api/orgs/:o/teams` (owner or admin). */
export const CreateTeamInput = z.object({ name: OrgName }).strict();
export type CreateTeamInput = z.infer<typeof CreateTeamInput>;
/** `PUT /api/teams/:t/members/:a` (a maintainer, or an organisation owner or admin). */
export const TeamMemberInput = z.object({ role: TeamRole.default('member') }).strict();
export type TeamMemberInput = z.infer<typeof TeamMemberInput>;
export interface TeamView {
  id: string;
  name: string;
  members: number;
  /** The caller's own role in it, if any. */
  role: TeamRole | null;
  createdAt: string;
}
/**
 * `GET /api/teams/:t/members` (a member of the team, or an owner or admin of its organisation; anyone
 * else gets the one `ORG_GONE` 404): who is in the team, as `TeamView.members` counts them (active
 * members of the organisation, never an auditor), by provider handle and never an email.
 */
export interface TeamMemberView {
  accountId: string;
  login: string | null;
  role: TeamRole;
}

// ---------------------------------------------------------------- projects

/** `POST /api/orgs/:o/projects` (a member of the lead team, or an owner or admin). */
export const CreateProjectInput = z
  .object({
    name: OrgName,
    leadTeamId: z.string().regex(TEAM_ID),
    /** Days an ended room of the project is kept; absent is the instance's. Never shorter than the instance's. */
    retentionDays: z.number().int().min(0).max(3650).optional(),
    recordForSeats: RecordScope.default('room'),
  })
  .strict();
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;
/** `PUT /api/projects/:p/access` (a project admin): grant or change a role. */
export const ProjectAccessInput = z.object({ principal: AccessPrincipal, role: ProjectRole }).strict();
export type ProjectAccessInput = z.infer<typeof ProjectAccessInput>;
/** `DELETE /api/projects/:p/access` (a project admin): revoke. Calls already let in with it are refused. */
export const ProjectAccessRevokeInput = z.object({ principal: AccessPrincipal }).strict();
export type ProjectAccessRevokeInput = z.infer<typeof ProjectAccessRevokeInput>;
/**
 * `PATCH /api/projects/:p` (a project admin): the project's own settings, any of them, at least one.
 * - `name`: the project's name, as a team's is.
 * - `retentionDays`: days an ended room of the project is kept; `null` is the instance's own. The
 *   instance's limits bind as at creation (never shorter than the instance keeps a room).
 * - `commentApproval`: who may approve a GitHub comment; `default` is `self` in a personal workspace and
 *   `second` in an organisation's.
 * - `allowGuestAccept`: whether a guest's acceptance of an artifact revision counts.
 * - `acknowledgeShorter`: not a setting. A shorter `retentionDays` deletes the rooms that already ended
 *   beyond the new period at the next sweep, minutes included, so the server answers 409 until the
 *   caller says it knows (`RETENTION_SHORTER`). A change that deletes nothing needs no acknowledgement.
 * One audit entry per request.
 */
export const PatchProjectInput = z
  .object({
    name: OrgName.optional(),
    retentionDays: z.number().int().min(0).max(3650).nullable().optional(),
    commentApproval: z.enum(['default', 'self', 'second']).optional(),
    allowGuestAccept: z.boolean().optional(),
    acknowledgeShorter: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.entries(v).some(([k, x]) => x !== undefined && k !== 'acknowledgeShorter'), { message: 'name something to change' });
export type PatchProjectInput = z.infer<typeof PatchProjectInput>;
export const NOTHING_TO_CHANGE = 'name something to change';

/**
 * How many days a project keeps an ended room: its own number, `null` for the instance's (which is
 * for ever where the instance deletes nothing), 0 for until someone deletes it. `Infinity` is for ever.
 */
export function retentionKept(days: number | null, instanceDays: number): number {
  if (days === 0) return Number.POSITIVE_INFINITY;
  if (days === null) return instanceDays > 0 ? instanceDays : Number.POSITIVE_INFINITY;
  return days;
}

/** Whether moving from one retention to another makes ended rooms go sooner. */
export const retentionShortens = (from: number | null, to: number | null, instanceDays: number): boolean => retentionKept(to, instanceDays) < retentionKept(from, instanceDays);

/** The 409 for a shorter retention that would delete `rooms` ended rooms at the next sweep, until `acknowledgeShorter` is sent. */
export const RETENTION_SHORTER = (rooms: number, days: number): string =>
  `${rooms} ended ${rooms === 1 ? 'room is' : 'rooms are'} older than ${days} days. Keeping rooms for ${days} days deletes ${rooms === 1 ? 'it' : 'them'}, minutes included, within minutes of saving, and this cannot be undone. Send acknowledgeShorter to go ahead.`;

/** What a project's settings page shows (`ProjectDetail.settings`), for every role; only an admin changes them. */
export interface ProjectSettings {
  /** The stored choice: `default` follows the workspace. */
  commentApproval: 'default' | 'self' | 'second';
  /** What applies now: the choice, or the workspace's default. */
  commentRule: 'self' | 'second';
  /** A personal workspace has one member, so a comment's second person does not apply to it. */
  personal: boolean;
  allowGuestAccept: boolean;
  /** Days this instance keeps an ended room (0: it deletes none), the floor for `retentionDays`. */
  instanceRetentionDays: number;
}
export interface ProjectView {
  id: string;
  /** The organisation that holds it, so a page can name it without searching the account's organisations. */
  orgId: string;
  name: string;
  leadTeamId: string;
  recordForSeats: RecordScope;
  retentionDays: number | null;
  /** How many accounts can open its rooms, teams expanded: the number the room header shows. */
  members: number;
  /** The caller's own role on it, if any. */
  role: ProjectRole | null;
  createdAt: string;
}
export interface ProjectAccessEntry {
  principal: AccessPrincipal;
  role: ProjectRole;
  grantedBy: string;
  grantedAt: string;
}
/** `GET /api/projects/:p`: the project, and who can open its rooms. */
export interface ProjectDetail extends ProjectView {
  access: ProjectAccessEntry[];
  settings: ProjectSettings;
}
/**
 * `GET /api/projects/:p/rooms` (a reader): the project's rooms, from columns that are never sealed,
 * so the list loads no room key. A room's title is read by opening it (`GET /api/sessions/:id`).
 */
export interface ProjectRoom {
  id: string;
  status: 'open' | 'active' | 'ended';
  createdAt: string;
  createdBy: string;
  endedAt: string | null;
  /**
   * Present only on a lane (@parley/shared/lane): its open items and which side each waits on, counted
   * from plain columns as the dashboard does (`laneTallies`), so nothing sealed is read for it.
   */
  lane?: { open: number; waiting: Record<string, number>; overdue: number };
}
export interface ProjectRoomsResult {
  rooms: ProjectRoom[];
}

// ---------------------------------------------------------------- who can open a room

/**
 * "Who can open this room", part of the owner's snapshot (`access`): this browser only,
 * an account's custody, or a project's members. Shown in the room's header, so a widening chosen
 * at creation is never invisible.
 */
export interface RoomAccess {
  custody: 'browser' | 'account' | 'project';
  project?: { id: string; name: string; members: number };
  /**
   * In a room created in a project, the project role the caller's own access rests on: its own, or,
   * for the room's owner token and an account holding it, the room's creator's. The
   * room's page offers only what that role allows (`PROJECT_ROLE_NEEDS`). Absent
   * where the snapshot could not say, and in every other room.
   */
  role?: ProjectRole;
}
/**
 * The header's words for it: "This browser", "Your account", "Checkout v2 (14 members)". Where the
 * snapshot says less than it should, the words fail toward the wider reading, never the narrower:
 * a project room whose project could not be named (soft-deleted, or not loaded) is still readable
 * by that project's members, so it reads "A project's members", never "This browser".
 */
export function accessLabel(a: RoomAccess | null | undefined): string {
  if (a?.custody === 'project')
    return a.project ? `${a.project.name} (${a.project.members} member${a.project.members === 1 ? '' : 's'})` : "A project's members";
  if (a?.custody === 'account') return 'Your account';
  return 'This browser';
}

// ---------------------------------------------------------------- fleets

/** `POST /api/teams/:t/runner-tokens` (a maintainer). The token is shown once, like a self-served one. */
export const TeamRunnerTokenInput = z
  .object({
    name: OrgName,
    maxSeats: z.number().int().min(1).max(50).default(5),
    expiresAt: z.iso.datetime().optional(),
    /** CIDR ranges the runner may register from; absent means anywhere. */
    networks: z.array(z.string().regex(/^[0-9a-fA-F:.]+\/\d{1,3}$/)).max(20).optional(),
  })
  .strict();
export type TeamRunnerTokenInput = z.infer<typeof TeamRunnerTokenInput>;
/**
 * `POST /api/teams/:t/runners/claim` (a maintainer): an anonymous runner joins the team's fleet.
 * A runner token is `rt_` and 24 random bytes (`RUNNER_TOKEN` in `@parley/shared/runner`).
 */
export const ClaimRunnerInput = z.object({ runnerToken: z.string().regex(/^rt_[A-Za-z0-9_-]{32}$/, 'a runner token (rt_…)') }).strict();
export type ClaimRunnerInput = z.infer<typeof ClaimRunnerInput>;
/**
 * A runner of the team's fleet as its page shows it (`GET /api/teams/:t/runners`, a team member or
 * an owner or admin of its organisation): unsealed columns and the runner's own capabilities.
 * `POST /api/teams/:t/runners/revoke` (`{runnerId}`, a maintainer) revokes one for good and
 * answers `{runnerId, seats}`.
 */
export interface TeamRunnerView {
  id: string;
  name: string;
  version: string | null;
  os: string | null;
  /** It registered its keys at least once. */
  registered: boolean;
  /** It holds a live session and called within `RUNNER_LOST_MINUTES`. */
  online: boolean;
  lastSeenAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
  maxSeats: number;
  /** Seats it holds now, revoked ones left out. */
  seats: number;
  clis: Array<{ id: StandingRuntime; available: boolean; health: CliHealth }>;
  /** The team's last stop-all: a runner that sees it change stops every agent it runs. */
  stopRequestedAt: string | null;
}
/** `POST /api/teams/:t/seats/:s/<control>` (a maintainer). Rotate travels to the runner as `control.rotate` in its lease. */
export const SeatControl = z.enum(['pause', 'resume', 'rotate']);
export type SeatControl = z.infer<typeof SeatControl>;
/** A team's standing seat on the fleet page (`GET /api/teams/:t/seats`): unsealed columns and the runner's health codes only. */
export interface TeamSeatView {
  id: string;
  label: string;
  runnerId: string;
  runnerName: string;
  runtime: string;
  confined: boolean;
  state: 'live' | 'paused' | 'rotating' | 'revoked' | 'lost';
  /** The runner's `clis[].health` codes (`CliHealth`), which the page maps to fixes ("Run `grok login`"). */
  health: string[];
  lastSeenAt: string | null;
}
/** `GET /api/teams/:t/ledger`: what the team's agents sent, at the report level each seat's policy allows. Never a body. */
export interface LedgerEntryView {
  seatId: string;
  at: string;
  op: string;
  kind: string | null;
  bytes: number | null;
  decision: string;
  rule: string | null;
  /** The cited source, at the `entries` level only. */
  source?: string | null;
}

// ---------------------------------------------------------------- sign-in per organisation

/** A DNS name as an organisation claims one: lower-case labels, a letter TLD. */
export const DOMAIN_NAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `PUT /api/orgs/:o/sso` (owner or admin): an OIDC provider for the organisation. https only; private addresses refused. */
export const IdpConfigInput = z
  .object({
    issuer: z.url({ protocol: /^https$/ }).max(300),
    clientId: z.string().min(1).max(300),
    clientSecret: z.string().min(1).max(500),
    /**
     * The email domains it signs in. Listing one proves nothing: only a domain this organisation
     * verified by DNS (`domain_claims.verified_at`) may be enforced, or lead an email to a link.
     */
    domains: z.array(z.string().regex(DOMAIN_NAME)).max(20).default([]),
    /** Members on those domains must sign in through it. Refused until every domain is verified. */
    enforce: z.boolean().default(false),
  })
  .strict();
export type IdpConfigInput = z.infer<typeof IdpConfigInput>;
/** `POST /api/orgs/:o/domains` (owner or admin): claim a domain, proved by a DNS TXT record. */
export const DomainClaimInput = z.object({ domain: z.string().regex(DOMAIN_NAME) }).strict();
export type DomainClaimInput = z.infer<typeof DomainClaimInput>;
/** The TXT record that proves a domain: its name and the value it must hold. */
export const domainTxtName = (domain: string) => `_parley-challenge.${domain}`;
export interface DomainClaimView {
  domain: string;
  txtName: string;
  txtValue: string;
  verifiedAt: string | null;
}

/**
 * Which account a sign-in through an organisation's IdP lands in.
 *
 * The account its `(iss, sub)` already signs in to, or a new one: an email address never picks an
 * account by itself, as it never does for GitHub, Google or Microsoft.
 * The IdP is chosen by whoever owns the organisation, and any signed-in account can make an
 * organisation and point it at an issuer of its own, so an ID token's `email_verified: true` is
 * that owner's word. Linked by email as first written, an IdP at `idp.attacker.example` asserting
 * `victim@acme.com` signed its owner in to the victim's account, and so into every room the
 * account holds.
 *
 * Not even for a new subject under the issuer the account already signs in with: OpenID Connect
 * makes only `(iss, sub)` stable (Core §5.7), and an IdP that gives a leaver's address to a new hire
 * says `email_verified: true` for both. Linked by email "under the same issuer", the new hire landed
 * in the leaver's account. A new subject is a new person,
 * and gets a new account.
 *
 * So an identity joins an existing account only when that account asked for it: it started the
 * link while signed in with a credential of its own, from Crossroom's own page, before the IdP was
 * asked (`POST /api/sso/:o/link`). An address is then at most a further check the server may
 * make on that link, where `ssoEmailMayLink` holds, and it may be stricter, never looser (the
 * server reads no address at all):
 * - the account confirmed the link itself, as above; nothing else ever makes one;
 * - the ID token's `email_verified` is `true` itself, never a string or a number;
 * - the address's domain is exactly one this organisation proved by DNS (`domain_claims` with
 *   `verified_at` set): never one only listed in `idp_configs.domains`, never a subdomain of a
 *   proved one, and never another organisation's proof.
 */
export interface SsoEmailLink {
  /** The ID token's `email_verified`, as it came. */
  emailVerified: unknown;
  /** The ID token's `email`, as it came. */
  email: unknown;
  /** This organisation's domains whose DNS record was read (`domain_claims.verified_at` set). */
  provedDomains: readonly string[];
  /** The account started this link itself, signed in with its own credential, from Crossroom's own page. */
  confirmedByAccount: boolean;
}

/** The domain of an email address, lower-cased, or null for anything that is not one address. */
export function emailDomain(email: unknown): string | null {
  if (typeof email !== 'string' || email.length > 320) return null;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return null;
  const domain = email.slice(at + 1).toLowerCase();
  return DOMAIN_NAME.test(domain) ? domain : null;
}

/**
 * Whether an organisation's sign-in may join an identity to an existing account, where the server
 * reads its email at all (`SsoEmailLink`): only a link the account itself started, never a sign-in
 * that arrives on its own, whoever the issuer.
 */
export function ssoEmailMayLink(o: SsoEmailLink): boolean {
  if (o.confirmedByAccount !== true) return false;
  if (o.emailVerified !== true) return false;
  const domain = emailDomain(o.email);
  return !!domain && o.provedDomains.includes(domain);
}

/** What `PUT /api/orgs/:o/sso` answers: the configuration, never its client secret. */
export interface IdpConfigView {
  id: string;
  issuer: string;
  clientId: string;
  domains: string[];
  enforce: boolean;
  /** Where the IdP sends the browser back: the redirect URI to register with it. */
  redirectUri: string;
  createdAt: string;
}
/**
 * `GET /api/orgs/:o/sso` (an owner or admin, held to enforced sign-in like the organisation's other
 * sign-in routes): the provider as saved, or
 * null, and every domain claimed, so the settings page shows them after a reload, and a save that
 * only rotates the secret keeps what is required. Never the client secret. A GET that writes nothing.
 */
export interface SsoSettingsView {
  idp: IdpConfigView | null;
  domains: DomainClaimView[];
}

/**
 * `POST /api/sso/:o/link` (a member's signed-in browser, same-origin): link an identity at the
 * organisation's IdP to the caller's own account. `return` is where the browser lands afterwards, a
 * path on this site. Answers `SsoLinkResult`, the IdP's URL for the page to open.
 */
export const SsoLinkInput = z.object({ return: z.string().refine(isSameOriginPath, 'return must be a path on this site').optional() }).strict();
export type SsoLinkInput = z.infer<typeof SsoLinkInput>;
export interface SsoLinkResult {
  url: string;
}

/**
 * The 403 an organisation that enforces sign-in through its IdP gives a member (not an owner) whose
 * credential holds no proof from it under a day old (`SSO_PROOF_HOURS`):
 * `{error: SSO_REQUIRED, link}`,
 * where `link` is the POST from the member's own browser for the way in the organisation enforces:
 * `ssoLinkPath(orgId)` for its OpenID Connect provider, or `samlLinkPath(orgId)`
 * (`/api/orgs/:o/saml/link`, @parley/shared/enterprise) for its SAML IdP. A page offers it
 * only on a person's press of a button naming the organisation, never on its own.
 */
export const SSO_REQUIRED =
  "This organisation asks its members to confirm who they are at its own identity provider once a day. Link your account to it again from this browser to go on.";
export const ssoLinkPath = (orgId: string) => `/api/sso/${orgId}/link`;
export interface SsoRequiredBody {
  error: typeof SSO_REQUIRED;
  link: string;
}

// ---------------------------------------------------------------- the audit log

/** An audit entry as `GET /api/orgs/:o/audit` shows it to an admin or auditor. `detail` is metadata, never room content. */
export interface AuditEntry {
  id: number;
  at: string;
  /** `account:<id>`, `owner`, `admin`, `runner:<id>`, `system`. */
  actor: string;
  action: string;
  targetKind: string;
  /** For a room, the keyed digest the log names it by, never its id. */
  targetId: string;
  detail: Record<string, unknown> | null;
  prevHash: string;
  hash: string;
}
export interface AuditPage {
  entries: AuditEntry[];
  /** The chain's head as the directory keeps it, and whether the entries recompute to it. */
  head: string | null;
  verified: boolean;
  /**
   * Where the next page starts: with `order: 'desc'`, the id to send as `before`; otherwise (oldest
   * first, `after`), the id to send as `after`. Null on the last page.
   */
  next: number | null;
  /** `desc`: newest first (`before` and the filters). Absent or `asc`: oldest first (`after`). */
  order?: 'asc' | 'desc';
  /**
   * The display login of each account this page names, as an actor (`account:<id>`) or a target of
   * kind `account`, keyed by account id (`acct_…`); none of any account the page does not name. An
   * account with no login (deleted) is absent: show its id.
   */
  actors?: Record<string, string>;
}

/**
 * The query of a newest-first page of an audit log (`GET /api/orgs/:o/audit`, `GET /api/admin/audit`),
 * as query-string parameters. Any of them (or `order=desc`) asks for newest first; `after` asks for
 * the old oldest-first page and may not be combined with them. Each refused with a 400 naming it.
 * - `before`: an entry id, the previous page's `next`.
 * - `actor`: `account:<id>`, `admin`, `system`, `runner:<id>`… exactly.
 * - `action`: an action (`org.member.update`) or its group (`org.member`, `org`), whole words only.
 * - `kind`: a target kind (`account`, `org`, `team`, `project`, `room`, `flag`…) exactly.
 * - `since`, `until`: `YYYY-MM-DD` or an ISO instant ending in `Z`. `since` is inclusive; `until`
 *   is exclusive, and a bare date means the end of that day (UTC).
 */
export interface AuditQuery {
  before?: number;
  actor?: string;
  action?: string;
  kind?: string;
  since?: string;
  until?: string;
}
