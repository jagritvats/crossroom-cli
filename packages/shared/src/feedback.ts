/**
 * Bug reports and feedback a person sends from the web app, and the
 * operator's list of them.
 *
 * - `POST /api/feedback` with `FeedbackInput`: no credential. Answers `{ok: true}`. The message and
 *   the contact are sealed at rest under the instance's key, never a room's.
 *   Limited per network and for the whole instance; past either it answers 429 `{error}`.
 * - `GET /api/admin/feedback?status=`: `FeedbackPage`, newest first, the admin token in
 *   `x-parley-admin`. `status` narrows to one state.
 * - `POST /api/admin/feedback/:f` with `{status}`: marks one, answering the item.
 *
 * What a report carries beyond the words typed: the kind, the page it was sent from as one of the
 * analytics' fixed page names (never the path, which can hold a room id), the kind of client in one
 * word, and the app's build. Never a room id, a token, an address or the browser's id.
 *
 * Pure, with no zod and nothing from Node, so the web app may import it as a value.
 */

export const FEEDBACK_KINDS = ['bug', 'idea', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_STATUSES = ['new', 'seen', 'done'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_CONTACT_MAX = 200;

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  /** How to answer, if the sender wants an answer: an email or a handle, as typed. */
  contact?: string;
  /** `location.pathname` where the form was opened; the server keeps only its page name. */
  path?: string;
}

export interface FeedbackItem {
  id: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  /** Null where the instance's key that sealed it cannot be had now. */
  message: string | null;
  contact: string | null;
  page: string;
  client: string;
  createdAt: string;
  handledAt: string | null;
}

export interface FeedbackPage {
  items: FeedbackItem[];
  counts: Record<FeedbackStatus, number>;
}

export const FEEDBACK_THANKS = 'Thanks. Whoever runs this Crossroom reads every report.';
export const FEEDBACK_TOO_MANY = 'Too many reports from here just now. Try again in a while.';
export const FEEDBACK_INPUT_WRONG = 'A report needs a kind (bug, idea or other) and a message of at most 4000 characters.';

/** The input checked, or null. Lengths are counted in UTF-16 units, as the form's `maxLength` does. */
export function parseFeedback(raw: unknown): FeedbackInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== 'string' || !(FEEDBACK_KINDS as readonly string[]).includes(r.kind)) return null;
  if (typeof r.message !== 'string') return null;
  const message = r.message.trim();
  if (message.length === 0 || message.length > FEEDBACK_MESSAGE_MAX) return null;
  if (r.contact !== undefined && (typeof r.contact !== 'string' || r.contact.length > FEEDBACK_CONTACT_MAX)) return null;
  if (r.path !== undefined && (typeof r.path !== 'string' || r.path.length > 2000)) return null;
  return {
    kind: r.kind as FeedbackKind,
    message,
    ...(typeof r.contact === 'string' && r.contact.trim() ? { contact: r.contact.trim() } : {}),
    ...(typeof r.path === 'string' ? { path: r.path } : {}),
  };
}
