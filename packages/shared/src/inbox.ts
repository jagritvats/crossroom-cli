/**
 * The inbox: the things that wait on a person, computed from room state and stored
 * only so they can be acknowledged and escalated, and the channels a person is told through.
 *
 * An item is a pointer, never text: its kind, the id of what it is about, the room. It resolves
 * when its source does (the question is answered, the hold decided, the gate passed), and a
 * reconciler recomputes items from the state columns every ten minutes, so the inbox can never
 * drift into a task list of its own. Email and push carry no content and no token: they say that
 * something waits, and the page shows what.
 *
 * Pure: zod and nothing from Node. The web app may import from here with `import type` only,
 * so its bundle carries no zod.
 */
import { z } from 'zod';

/**
 * The twelve kinds. `assignment`, `artifact_review` and `action_due` are the workspace's (behind the `workspace`
 * flag): a proposed assignment to an account, an artifact revision waiting for a review, and a
 * work item or action past its review point.
 * The first eight: `dead_step` is for a project's lead team: a step of a
 * playbook run whose job ran out of attempts, so the run failed. It resolves on a retry, on a
 * cancel, or after `DEAD_STEP_DAYS`.
 */
export const InboxKind = z.enum(['owner_question', 'held_packet', 'gate', 'ruling', 'stale_fact', 'waiting_invite', 'seat_attention', 'dead_step', 'assignment', 'artifact_review', 'action_due', 'comment_approval', 'room_wants_agent', 'question_for_team']);
export type InboxKind = z.infer<typeof InboxKind>;

/** Whether an item of a kind blocks a room or a run until someone acts, and so escalates. */
export const BLOCKING: Readonly<Record<InboxKind, boolean>> = {
  owner_question: true,
  held_packet: true,
  gate: true,
  ruling: false,
  stale_fact: false,
  waiting_invite: false,
  seat_attention: false,
  // The run has ended (failed): nothing waits on it, so it never escalates.
  dead_step: false,
  // A person's answer to an assignment, a review or an overdue item is wanted, but no room or run stops for it.
  assignment: false,
  artifact_review: false,
  action_due: false,
  // A proposed GitHub comment waits for a second decision; nothing stops for it.
  comment_approval: false,
  // A room has a seat for someone's agent; the room goes on without it.
  room_wants_agent: false,
  // A room across a connection waits for a person on the team; it goes on without them, on its clock.
  question_for_team: false,
};

/** Days a `dead_step` item stays open with nobody retrying or cancelling its run. */
export const DEAD_STEP_DAYS = 7;

/** What each kind is about, which `ref` names. */
export const INBOX_REF: Readonly<Record<InboxKind, string>> = {
  owner_question: 'a context request addressed to the owner',
  held_packet: 'a packet a team holds for review',
  gate: "a playbook run's gate step",
  ruling: 'a claim an ended room left for the owner to settle',
  stale_fact: 'a fact whose sources changed',
  waiting_invite: 'a seat a room waits on a person for',
  seat_attention: "a standing seat whose runner needs its team (a sign-in, a limit)",
  dead_step: "a playbook run's step whose job ran out of attempts (`<run>:<step>:<item>`, as a gate's)",
  assignment: 'a work item proposed to an account (`<project>:<work>`)',
  artifact_review: 'an artifact revision waiting for a review (`<project>:<artifact>:<n>`)',
  action_due: 'a work item or action past its review point (`<project>:<work>`)',
  comment_approval: 'a proposed GitHub comment waiting for an editor or admin to approve it (`wcm_...`)',
  room_wants_agent: "a project room with an open seat for a member's own agent (the room's id)",
  question_for_team: "another organisation's question across a connection waiting for a person on one of the account's teams (`<org>:<question>`)",
};

/** Minutes an item stays unread before an email goes. */
export const EMAIL_DELAY_MINUTES = 10;
/** Minutes a blocking item waits between notifying one person and the next on call. */
export const ESCALATE_MINUTES = 15;
/** Minutes between the reconciler's passes. */
export const RECONCILE_MINUTES = 10;

/** An item as `GET /api/inbox` lists it: a pointer, and the words the page shows are its own, from `kind`. */
export interface InboxItem {
  id: string;
  kind: InboxKind;
  ref: string;
  sessionId: string | null;
  /** `account:<id>`, or `team:<id>` for a team's queue. */
  principal: string;
  blocking: boolean;
  createdAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  escalationLevel: number;
  /**
   * A `gate`'s project: the one its run is in, whose page of waiting gates (`/p/<project>/gates`,
   * `POST /api/projects/:p/gates/:g`) is where the gate is approved or refused. Absent for every
   * other kind, and for a gate whose playbook is gone.
   */
  projectId?: string;
  /** A workspace item's project and the tab of it where it is acted on (`work`, `artifacts` or `meetings`). */
  projectTab?: 'work' | 'artifacts' | 'meetings';
  /** The object in that tab the item is about, so the link opens it and not the list. */
  projectObject?: InboxObject;
}
/**
 * What a workspace item points at inside its project: a work item, an artifact and the revision waiting,
 * a meeting, or a proposed comment (with the work item it is on). Ids and a number, never text.
 */
export interface InboxObject {
  work?: string;
  artifact?: string;
  rev?: number;
  meeting?: string;
  comment?: string;
}
export interface InboxResult {
  items: InboxItem[];
}
/**
 * `GET /api/inbox/summary`: counts and nothing else, for the service worker (`/sw.js`), the
 * favicon and VS Code's status bar. A push carries no payload; the worker fetches this.
 */
export interface InboxSummary {
  unread: number;
  blocking: number;
  oldestBlockingAt: string | null;
}

// ---------------------------------------------------------------- notification channels

export const NotifyChannel = z.enum(['email', 'push', 'vscode']);
export type NotifyChannel = z.infer<typeof NotifyChannel>;

/**
 * The push services a subscription's endpoint may be on. Anything else is refused: an endpoint is
 * a URL the server would POST to, so an open list is SSRF.
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  '*.notify.windows.com',
];
export function isPushServiceUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h));
}

/** `POST /api/account/notify` (a signed-in account): add a channel. An address is used only once verified. */
export const NotifyInput = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('email'), address: z.email().max(254) }).strict(),
  z
    .object({
      channel: z.literal('push'),
      subscription: z
        .object({
          endpoint: z.url().max(2000).refine(isPushServiceUrl, 'not a known push service'),
          keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/) }).strict(),
        })
        .strict(),
    })
    .strict(),
  z.object({ channel: z.literal('vscode') }).strict(),
]);
export type NotifyInput = z.infer<typeof NotifyInput>;
/** `DELETE /api/account/notify`: remove one channel. */
export const NotifyDeleteInput = z.object({ id: z.string().min(1).max(64) }).strict();
export type NotifyDeleteInput = z.infer<typeof NotifyDeleteInput>;
export interface NotifyChannelView {
  id: string;
  channel: NotifyChannel;
  /** `a…@example.com` or the push service's host: enough to recognise, never the whole address. */
  hint: string;
  verified: boolean;
  createdAt: string;
}
/**
 * `GET /api/account/notify`: the account's channels, whether this Crossroom can send email, and
 * whether it can push, with the key a browser subscribes under (`applicationServerKey`), null
 * whenever web push is not set up here.
 */
export interface NotifyChannelsResult {
  channels: NotifyChannelView[];
  email: { configured: boolean };
  push: { configured: boolean; publicKey: string | null };
}
/**
 * `POST /api/account/notify`'s answer, 201 for a new channel and 200 for one the account already
 * has: the channel, and for an address whether the email with its code went.
 */
export interface NotifyAddResult {
  channel: NotifyChannelView;
  verification?: 'sent' | 'failed';
}
/**
 * `POST /api/account/notify/verify`: the six-digit code from the verification email, for the
 * address it was sent to. The email carries no link that does anything; the code is entered on
 * `/settings`. Answers `{channel}`.
 */
export const NotifyVerifyInput = z.object({ id: z.string().min(1).max(64), code: z.string().regex(/^[0-9]{6}$/) }).strict();
export type NotifyVerifyInput = z.infer<typeof NotifyVerifyInput>;

// ---------------------------------------------------------------- who is on call for a team

/** How a team's rota turns: a different person on call each week (Mondays 00:00 UTC), each day, or never. */
export const ROTATIONS = ['weekly', 'daily', 'none'] as const;
export type Rotation = (typeof ROTATIONS)[number];
/** People on one team's rota at most. */
export const ROTA_MAX = 20;

/**
 * `PUT /api/teams/:t/oncall` (a team maintainer, or an owner or admin of the team's organisation):
 * the rota, in order, each account once and every one a member of the team, and how it turns. An
 * empty list clears it, and the team's maintainers stand in. Answers `RotaView`.
 */
export const OncallInput = z
  .object({
    accounts: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
      .max(ROTA_MAX)
      .refine((a) => new Set(a).size === a.length, 'each account once'),
    rotation: z.enum(ROTATIONS).default('weekly'),
  })
  .strict();
export type OncallInput = z.infer<typeof OncallInput>;

/** A team's rota as `PUT /api/teams/:t/oncall` answers it. */
export interface RotaView {
  teamId: string;
  rotation: Rotation;
  /** In rota order, members only. */
  accounts: string[];
  /** Who hears a new item first right now, or null for a team with nobody to tell. */
  onCall: string | null;
  /** True when the team has no rota of its own and its maintainers stand in. */
  maintainers: boolean;
}

/** The email provider's key and sender (`email` flag `configured`). Either provider. */
export const EMAIL_ENV = { postmark: 'PARLEY_POSTMARK_TOKEN', resend: 'PARLEY_RESEND_KEY', from: 'PARLEY_EMAIL_FROM' } as const;
/** Web push's VAPID keys (`webpush` flag `configured`). */
export const VAPID_ENV = { publicKey: 'PARLEY_VAPID_PUBLIC', privateKey: 'PARLEY_VAPID_PRIVATE', subject: 'PARLEY_VAPID_SUBJECT' } as const;
