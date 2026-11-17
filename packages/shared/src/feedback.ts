/**
 * Bug reports and feedback a person sends from the web app, and the
 * operator's list of them.
 *
 * - `POST /api/feedback` with `FeedbackInput`: no credential. Answers `FeedbackSent`. The message, the
 *   contact and the context are sealed at rest under the instance's key, never a room's.
 *   Limited per network and for the whole instance; past either it answers 429 `{error}`.
 * - `GET /api/admin/feedback?status=&limit=`: `FeedbackPage`, newest first, the admin token in
 *   `x-parley-admin`. `status` narrows to one state; `limit` (0 to `FEEDBACK_LIST_MAX`, default the
 *   most) caps the items, and 0 answers the counts alone without opening anything sealed.
 * - `POST /api/admin/feedback/mark` with `{id, status}`: marks one, answering the item.
 *
 * What a report carries beyond the words typed: the kind, how badly a bug gets in the way if the
 * sender said, the page it was sent from as a fixed page name (never the path, which can hold a room
 * id), the kind of client in one word, and, unless the sender unticks it, `FeedbackContext`: the short
 * list the form shows before it is sent. Never a room id, a token, an address or the browser's id.
 *
 * Pure, with no zod and nothing from Node, so the web app may import it as a value.
 */

import { oneLine } from './text.js';

export const FEEDBACK_KINDS = ['bug', 'idea', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_STATUSES = ['new', 'seen', 'done'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** How badly a bug gets in the way, if the sender said. Only a bug has one. */
export const FEEDBACK_IMPACTS = ['stuck', 'annoying', 'minor'] as const;
export type FeedbackImpact = (typeof FEEDBACK_IMPACTS)[number];

export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_CONTACT_MAX = 200;
export const FEEDBACK_ERROR_MAX = 300;
/** The most items one list answers. A list per state, so nothing new is ever pushed off by old reports. */
export const FEEDBACK_LIST_MAX = 500;

export const FEEDBACK_WIDTHS = ['phone', 'tablet', 'desk'] as const;
export type FeedbackWidth = (typeof FEEDBACK_WIDTHS)[number];

/**
 * What goes with a report unless the sender unticks it, every field shown on the form first. Each is
 * a coarse word, checked by `cleanContext`: a field that does not fit its shape is dropped, not kept.
 */
export interface FeedbackContext {
  /** "Chrome 141": the browser's family and major version, never the whole user agent. */
  browser?: string;
  /** "macOS", "Android": the family alone. */
  os?: string;
  width?: FeedbackWidth;
  theme?: 'light' | 'dark';
  /** Present only when the browser said it was offline. */
  offline?: true;
  /** The hash in the app's main script name, which tells a tab left open across a deploy from a fresh one. */
  build?: string;
  /** The last failure this tab saw in the last ten minutes, through `scrubSecrets`. */
  error?: string;
}

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  /** How to answer, if the sender wants an answer: an email or a handle, as typed. */
  contact?: string;
  /** `location.pathname` where the form was opened; the server keeps only its page name. */
  path?: string;
  /** Read only for a bug. */
  impact?: FeedbackImpact;
  context?: FeedbackContext;
}

/** What `POST /api/feedback` answers: `ref` is the code the sender can quote. */
export interface FeedbackSent {
  ok: true;
  ref: string;
}

export interface FeedbackItem {
  id: string;
  /** The code the sender was shown (`feedbackRef`). */
  ref: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  impact: FeedbackImpact | null;
  /** Null where the instance's key that sealed it cannot be had now. */
  message: string | null;
  contact: string | null;
  /** Null when the sender left it out, on a report older than it, or where the key cannot be had. */
  context: FeedbackContext | null;
  page: string;
  client: string;
  createdAt: string;
  handledAt: string | null;
}

export interface FeedbackPage {
  items: FeedbackItem[];
  counts: Record<FeedbackStatus, number>;
  /** Read from every new report, not only the listed ones. */
  waiting: {
    /** New reports whose sender said they are stuck. */
    stuck: number;
    /** New bug reports. */
    bugs: number;
    /** When the oldest new report came in; null when there is none. */
    oldest: string | null;
  };
}

export const FEEDBACK_THANKS = 'Whoever runs this Crossroom reads every report.';
export const FEEDBACK_TOO_MANY = 'Too many reports from here just now. Try again in a while.';
export const FEEDBACK_INPUT_WRONG = 'A report needs a kind (bug, idea or other) and a message of at most 4000 characters.';
/** What stands where `scrubSecrets` took something out. */
export const FEEDBACK_REMOVED = '[removed]';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A report's id as a code a person can read out: `CR-` and six letters. Pure, so an old report has one too. */
export function feedbackRef(id: string): string {
  // FNV-1a over the id. Two reports sharing a code is harmless: it only finds a report for a person to read.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += CROCKFORD[h % 32];
    h = Math.floor(h / 32);
  }
  return `CR-${out}`;
}

/**
 * Text with what could open a room taken out: a key in a fragment, a seat, ask, guest or share link's
 * token, an API key, and any long unbroken token. A room's own id is reduced to `/s/:room`. A message
 * holding one of these would hand the operator a way in, so the form warns and the server applies this
 * again whatever the form did.
 */
export function scrubSecrets(text: string): string {
  return (
    text
      // A key or token in a fragment: #k=, #t=, #e=, #i=, and any later one on the same address.
      .replace(/#[a-z]=[^\s"'<>)]+/gi, `#${FEEDBACK_REMOVED}`)
      // A link whose path is the credential.
      .replace(/\/(j|ask|shared|guest)\/[^\s"'<>)?#]+/gi, `/$1/${FEEDBACK_REMOVED}`)
      .replace(/\/s\/[A-Za-z0-9_-]+/g, '/s/:room')
      // The prefixed keys Crossroom issues, then anything else shaped like a token.
      .replace(/\b(?:ak|pk|rt|cr|fb|tok|key)_[A-Za-z0-9_-]{8,}/g, FEEDBACK_REMOVED)
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, FEEDBACK_REMOVED)
  );
}

/** `text` cut to at most `max` UTF-16 units, never between the halves of a surrogate pair. */
export function cutWhole(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;

const WORDS = /^[A-Za-z][A-Za-z0-9 .+-]{0,31}$/;

/** A context's fields that fit their shape; undefined when none does. Anything else in `raw` is ignored. */
export function cleanContext(raw: unknown): FeedbackContext | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: FeedbackContext = {};
  if (typeof r.browser === 'string' && WORDS.test(r.browser)) out.browser = r.browser;
  if (typeof r.os === 'string' && WORDS.test(r.os)) out.os = r.os;
  const width = oneOf(FEEDBACK_WIDTHS, r.width);
  if (width) out.width = width;
  const theme = oneOf(['light', 'dark'] as const, r.theme);
  if (theme) out.theme = theme;
  if (r.offline === true) out.offline = true;
  if (typeof r.build === 'string' && /^[A-Za-z0-9_-]{4,16}$/.test(r.build)) out.build = r.build;
  if (typeof r.error === 'string') {
    // On one line (an error's stack ends lines with CR, LS, PS or NEL as much as LF), then scrubbed
    // before it is cut: a cut token no longer looks like one.
    const error = cutWhole(scrubSecrets(oneLine(r.error)), FEEDBACK_ERROR_MAX);
    if (error) out.error = error;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The input checked, or null. Lengths are counted in UTF-16 units, as the form's `maxLength` does. */
export function parseFeedback(raw: unknown): FeedbackInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = oneOf(FEEDBACK_KINDS, r.kind);
  if (!kind) return null;
  if (typeof r.message !== 'string') return null;
  const message = r.message.trim();
  if (message.length === 0 || message.length > FEEDBACK_MESSAGE_MAX) return null;
  if (r.contact !== undefined && (typeof r.contact !== 'string' || r.contact.length > FEEDBACK_CONTACT_MAX)) return null;
  if (r.path !== undefined && (typeof r.path !== 'string' || r.path.length > 2000)) return null;
  const impact = kind === 'bug' ? oneOf(FEEDBACK_IMPACTS, r.impact) : undefined;
  const context = cleanContext(r.context);
  return {
    kind,
    message,
    ...(typeof r.contact === 'string' && r.contact.trim() ? { contact: r.contact.trim() } : {}),
    ...(typeof r.path === 'string' ? { path: r.path } : {}),
    ...(impact ? { impact } : {}),
    ...(context ? { context } : {}),
  };
}

/** A contact that can be mailed: the operator's Reply button shows only for one of these. */
export const isEmail = (contact: string | null | undefined): boolean => !!contact && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(contact);

/** A report as markdown, for pasting into an issue. The contact stays out: an issue may be public. */
export function feedbackAsIssue(item: FeedbackItem): string {
  const c = item.context;
  const facts = [
    `Report: ${item.ref}`,
    `Kind: ${item.kind}${item.impact ? ` (${item.impact})` : ''}`,
    `Page: ${item.page}`,
    `Sent: ${item.createdAt}`,
    c?.browser || c?.os ? `Browser: ${[c.browser, c.os].filter(Boolean).join(' on ')}` : null,
    c?.width ? `Width: ${c.width}` : null,
    c?.theme ? `Theme: ${c.theme}` : null,
    c?.offline ? 'Offline when sent' : null,
    c?.build ? `Build: ${c.build}` : null,
    c?.error ? `Last error: ${c.error}` : null,
  ].filter((l): l is string => !!l);
  return `${item.message ?? '(sealed under a key this instance no longer has)'}\n\n---\n${facts.map((l) => `- ${l}`).join('\n')}\n`;
}
