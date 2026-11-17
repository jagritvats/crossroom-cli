/**
 * The beta programme: a signed-in person joins it from `/beta` or the account page, so the sign-up is
 * tied to their account. They may leave an address for beta news and promo codes, with its own
 * consent, separate from the inbox's email (which only ever says that something waits). People with
 * no account yet can use the operator's own form instead (`betaFormUrl` in `/api/features`), which
 * the operator reads where it lives.
 *
 * Zod-free and Node-free, so the web app imports it as it stands.
 */

/** Characters kept of what a person says they would use Crossroom for. */
export const BETA_NOTE_MAX = 500;
/** Characters an address may have (RFC 5321's path limit). */
export const BETA_EMAIL_MAX = 254;
/** Sign-ups an admin page lists at most. */
export const BETA_LIST_MAX = 1000;

export const BETA_INPUT_WRONG = 'expected {note?, email?, consent?}: an email needs consent: true';
export const BETA_EMAIL_WRONG = "That doesn't look like an email address.";
export const BETA_BROWSER_ONLY = "Joining the beta is done from Crossroom's own page while signed in, not with an API key.";

/** The words the consent box shows, kept here so the server can record which version was agreed to. */
export const BETA_CONSENT_TEXT = 'Email me beta news and promo codes. At most a couple of emails a month; stop them here any time.';

export interface BetaInput {
  note?: string;
  email?: string;
  consent?: boolean;
}

/** What the account's own page reads. */
export interface AccountBetaView {
  joined: boolean;
  joinedAt: string | null;
  note: string | null;
  /** The address it left, shown back to it; null for none. */
  email: string | null;
  consentAt: string | null;
}

export interface AdminBetaItem {
  accountId: string;
  /** The name the account shows, where one is known. */
  name: string | null;
  joinedAt: string;
  note: string | null;
  /** null for none, or for a seal this instance can no longer open. */
  email: string | null;
  consentAt: string | null;
}

export interface AdminBetaView {
  total: number;
  withEmail: number;
  items: AdminBetaItem[];
}

const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]{2,}$/;

/** Whether text reads as one plain email address. */
export const isBetaEmail = (v: string): boolean => v.length <= BETA_EMAIL_MAX && EMAIL.test(v);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A body checked: only the three keys, each of its type, an address that reads as one and comes with
 * consent. Blank strings are read as left out. Null for anything else.
 */
export function parseBetaInput(v: unknown): { note: string | null; email: string | null } | null {
  if (!isObject(v)) return null;
  for (const k of Object.keys(v)) if (k !== 'note' && k !== 'email' && k !== 'consent') return null;
  if (v.note !== undefined && typeof v.note !== 'string') return null;
  if (v.email !== undefined && typeof v.email !== 'string') return null;
  if (v.consent !== undefined && typeof v.consent !== 'boolean') return null;
  const note = typeof v.note === 'string' && v.note.trim() ? v.note.trim() : null;
  if (note && note.length > BETA_NOTE_MAX) return null;
  const email = typeof v.email === 'string' && v.email.trim() ? v.email.trim() : null;
  if (email && (!isBetaEmail(email) || v.consent !== true)) return null;
  return { note, email };
}

/** The operator's form address, if it is one a page may link to: https only. */
export function betaFormUrlOf(v: string | undefined | null): string | null {
  if (!v) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
