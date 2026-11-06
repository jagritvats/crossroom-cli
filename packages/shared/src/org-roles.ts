/**
 * Who may do what in an organisation and on a project: the one table, for the server and the web
 * app alike. Zod-free and import-free on purpose, so the browser can import its values
 * instead of keeping copies that drift. `org.ts` re-exports all of it
 * and builds its zod enums from the role lists here.
 */

/** A member's role in an organisation (`memberships.role`). */
export const ORG_ROLES = ['owner', 'admin', 'member', 'auditor'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** What `project_access` grants on a project's rooms. */
export const PROJECT_ROLES = ['reader', 'editor', 'admin'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** What a project role needs on one of the project's rooms (see `PROJECT_ROLE_NEEDS`). */
export type ProjectNeed = 'read' | 'write' | 'admin';

/**
 * What a project role allows on one of the project's rooms, in the terms of the server's reader
 * check:
 * - read, for a reader: the snapshot, liveness, the wait, the event stream, the minutes;
 * - write, for an editor: a note, context, ending the room, settling a claim, keeping it longer,
 *   renaming it, a nudge, the owner's claims;
 * - admin, for a project admin: deleting and re-running the room, and everything that widens who
 *   reads it or runs something under the owner's credentials: share links, inviting a person, a
 *   seat's replaced link, a hosted seat's log, and starting or stopping a hosted seat.
 * The owner token holds all three in a room made in no project. In a project's room it, and an
 * account holding it, hold what the room's creator's project role allows now, and nothing once the
 * creator has no standing on the project. Each owner route declares its need, and the server's
 * tests pin it: a new route that could widen who reads a room needs `admin`.
 */
export const PROJECT_ROLE_NEEDS: Readonly<Record<ProjectRole, readonly ProjectNeed[]>> = {
  reader: ['read'],
  editor: ['read', 'write'],
  admin: ['read', 'write', 'admin'],
};
/** Whether `role` allows `need`. No role allows nothing. */
export const projectRoleAllows = (role: ProjectRole | null | undefined, need: ProjectNeed): boolean =>
  !!role && (PROJECT_ROLE_NEEDS[role]?.includes(need) ?? false);

/** What each organisation role may do about the organisation itself. Never a room: that is `project_access`. */
export const ORG_ACTIONS = {
  view: ['owner', 'admin', 'member', 'auditor'],
  invite: ['owner', 'admin'],
  manage_members: ['owner', 'admin'],
  create_team: ['owner', 'admin'],
  create_project: ['owner', 'admin', 'member'],
  read_audit: ['owner', 'admin', 'auditor'],
  read_analytics: ['owner', 'admin', 'member', 'auditor'],
  // What standing seats' jobs cost, in analytics: never a member's.
  read_spend: ['owner', 'admin', 'auditor'],
  billing: ['owner'],
  sso: ['owner', 'admin'],
  // Which key provider holds the organisation's key: the owner's alone.
  kms: ['owner'],
  // Acting for the organisation on its connections with others: an admin keeps them.
  connections: ['owner', 'admin'],
  delete: ['owner'],
} as const satisfies Record<string, readonly OrgRole[]>;
export type OrgAction = keyof typeof ORG_ACTIONS;
/**
 * The refusal a change that would leave an organisation with no active owner gets (409), and the
 * words a page says beside the control it disables for the last owner.
 */
export const LAST_OWNER = 'A workspace keeps at least one owner. Make someone else an owner first.';

/** Whether `role` may do `action`. No role may do nothing. */
export const orgCan = (role: OrgRole | null | undefined, action: OrgAction): boolean =>
  !!role && (ORG_ACTIONS[action] as readonly OrgRole[]).includes(role);
