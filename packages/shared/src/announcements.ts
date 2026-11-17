/**
 * Announcements: short lines whoever runs a Crossroom shows to the people who use it, an offer or
 * a piece of news, each placed on the app's pages, on the site's landing page, on the pricing page,
 * or any of them.
 *
 * - `GET /api/admin/announcements` (the admin token in `x-parley-admin`): every one, newest first.
 * - `POST /api/admin/announcements` with `AnnouncementInput`: adds one; `.../update` with the input
 *   and its `id` replaces it; `.../delete` with `{id}` removes it. Each is recorded on the instance's
 *   audit chain.
 * - `GET /api/announcements?where=app|pricing|site`: what is live there now, as
 *   `{announcements: ShownAnnouncement[]}`, newest first. No credential. The pricing page's list
 *   also carries the instance's own offer for Crossroom's agent while that offer stands
 *   (`HOUSE_OFFER_ID`).
 *
 * The words are plain text, one line, and every page prints them as text, never as markup. A link
 * goes to an `https:` address or to a path on the app's own address.
 *
 * Pure, with no zod and nothing from Node, so the web app may import it as a value.
 */

export const ANNOUNCEMENT_KINDS = ['offer', 'news'] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

/** Where one shows: the app's pages (not a room's or a seat's), the site's landing page, the pricing page. */
export const ANNOUNCEMENT_PLACES = ['app', 'site', 'pricing'] as const;
export type AnnouncementPlace = (typeof ANNOUNCEMENT_PLACES)[number];

export const ANNOUNCEMENT_TEXT_MAX = 200;
export const ANNOUNCEMENT_LABEL_MAX = 40;
export const ANNOUNCEMENT_URL_MAX = 500;
/** The most an instance keeps: the operator deletes old ones to add more. */
export const ANNOUNCEMENTS_MAX = 50;

/** The id the pricing page's offer for Crossroom's agent goes by: never a stored row's. */
export const HOUSE_OFFER_ID = 'house';

export interface Announcement {
  id: string;
  kind: AnnouncementKind;
  text: string;
  linkLabel: string | null;
  linkUrl: string | null;
  where: AnnouncementPlace[];
  /** ISO times; null for "from now" and "until deleted". */
  startsAt: string | null;
  endsAt: string | null;
  /** Whether a reader may hide it (the app's strip and the site's). */
  dismissible: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What a page is given: no times but its end, nothing about where else it shows. */
export interface ShownAnnouncement {
  id: string;
  kind: AnnouncementKind;
  text: string;
  linkLabel: string | null;
  linkUrl: string | null;
  dismissible: boolean;
  endsAt: string | null;
}

export interface AnnouncementInput {
  kind: AnnouncementKind;
  text: string;
  linkLabel?: string | null;
  linkUrl?: string | null;
  where: AnnouncementPlace[];
  startsAt?: string | null;
  endsAt?: string | null;
  dismissible?: boolean;
}

/** The input as stored: every field present, the words trimmed, the times in ISO form. */
export interface CheckedAnnouncement {
  kind: AnnouncementKind;
  text: string;
  linkLabel: string | null;
  linkUrl: string | null;
  where: AnnouncementPlace[];
  startsAt: string | null;
  endsAt: string | null;
  dismissible: boolean;
}

export interface AnnouncementList {
  announcements: Announcement[];
}
export interface ShownAnnouncements {
  announcements: ShownAnnouncement[];
}

export const ANNOUNCEMENT_NOT_FOUND = 'No announcement has that id.';
export const ANNOUNCEMENTS_FULL = `This Crossroom keeps at most ${ANNOUNCEMENTS_MAX} announcements: delete an old one first.`;
export const ANNOUNCEMENT_WHERE_WRONG = `where is one of ${ANNOUNCEMENT_PLACES.join(', ')}`;

const cp = (n: number) => String.fromCharCode(n);
// Control characters, DEL, the C1 block and the two line separators: an announcement is one line.
const CONTROL = new RegExp(`[${cp(0)}-${cp(0x1f)}${cp(0x7f)}-${cp(0x9f)}${cp(0x2028)}${cp(0x2029)}]`);
const KEYS = new Set(['kind', 'text', 'linkLabel', 'linkUrl', 'where', 'startsAt', 'endsAt', 'dismissible']);
/** The latest an end may be: five years out, so a typo in the year is caught. */
const END_MAX_MS = 5 * 366 * 24 * 60 * 60 * 1000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Why `url` can't be an announcement's link, or null when it can: an `https:` address with no
 * user name or password, or a path on the app's own address (`/pricing`, never `//host`).
 */
export function linkProblem(url: string): string | null {
  if (url.length > ANNOUNCEMENT_URL_MAX) return `A link is at most ${ANNOUNCEMENT_URL_MAX} characters.`;
  if (CONTROL.test(url) || /\s|\\/.test(url)) return 'A link has no spaces, backslashes or control characters.';
  if (url.startsWith('/')) return url.startsWith('//') ? 'A path starts with one slash.' : null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'A link is an https:// address or a path starting with /.';
  }
  if (u.protocol !== 'https:') return 'A link is an https:// address or a path starting with /.';
  if (u.username || u.password) return 'A link names no user or password.';
  return null;
}

/** The link as stored: a path as given, an address as the URL parser writes it. */
const linkOf = (url: string) => (url.startsWith('/') ? url : new URL(url).href);

function timeOf(v: unknown, what: string): { at: string | null } | { error: string } {
  if (v === undefined || v === null || v === '') return { at: null };
  if (typeof v !== 'string' || v.length > 40) return { error: `${what} is a date and time.` };
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return { error: `${what} is a date and time.` };
  return { at: new Date(t).toISOString() };
}

/**
 * `AnnouncementInput`, checked: the stored form, or the first thing wrong with it in words the
 * operator can act on. An unknown key is refused, never dropped.
 */
export function checkAnnouncement(body: unknown, now: number = Date.now()): { ok: true; value: CheckedAnnouncement } | { ok: false; error: string } {
  const no = (error: string) => ({ ok: false as const, error });
  if (!isObject(body)) return no('Send an announcement as a JSON object.');
  const extra = Object.keys(body).filter((k) => !KEYS.has(k));
  if (extra.length) return no(`Unknown field: ${extra[0]}.`);
  const { kind, text, linkLabel, linkUrl, where, startsAt, endsAt, dismissible } = body;
  if (typeof kind !== 'string' || !(ANNOUNCEMENT_KINDS as readonly string[]).includes(kind)) return no(`kind is one of ${ANNOUNCEMENT_KINDS.join(', ')}.`);
  if (typeof text !== 'string' || !text.trim()) return no('Write the announcement.');
  const words = text.trim();
  if (words.length > ANNOUNCEMENT_TEXT_MAX) return no(`An announcement is at most ${ANNOUNCEMENT_TEXT_MAX} characters.`);
  if (CONTROL.test(words)) return no('An announcement is one line of plain text.');
  const label = typeof linkLabel === 'string' ? linkLabel.trim() : '';
  const url = typeof linkUrl === 'string' ? linkUrl.trim() : '';
  if (linkLabel !== undefined && linkLabel !== null && typeof linkLabel !== 'string') return no('linkLabel is text.');
  if (linkUrl !== undefined && linkUrl !== null && typeof linkUrl !== 'string') return no('linkUrl is text.');
  if (label.length > ANNOUNCEMENT_LABEL_MAX) return no(`A link's words are at most ${ANNOUNCEMENT_LABEL_MAX} characters.`);
  if (CONTROL.test(label)) return no("A link's words are one line of plain text.");
  if (!!label !== !!url) return no('A link needs both its words and its address.');
  if (url) {
    const why = linkProblem(url);
    if (why) return no(why);
  }
  if (!Array.isArray(where) || !where.length) return no('Choose where it shows.');
  const places = new Set<AnnouncementPlace>();
  for (const w of where) {
    if (typeof w !== 'string' || !(ANNOUNCEMENT_PLACES as readonly string[]).includes(w)) return no(`It shows on ${ANNOUNCEMENT_PLACES.join(', ')}.`);
    places.add(w as AnnouncementPlace);
  }
  const start = timeOf(startsAt, 'startsAt');
  if ('error' in start) return no(start.error);
  const end = timeOf(endsAt, 'endsAt');
  if ('error' in end) return no(end.error);
  if (end.at && Date.parse(end.at) > now + END_MAX_MS) return no('endsAt is within five years.');
  if (start.at && end.at && Date.parse(end.at) <= Date.parse(start.at)) return no('It ends after it starts.');
  if (dismissible !== undefined && typeof dismissible !== 'boolean') return no('dismissible is true or false.');
  return {
    ok: true,
    value: {
      kind: kind as AnnouncementKind,
      text: words,
      linkLabel: label || null,
      linkUrl: url ? linkOf(url) : null,
      where: ANNOUNCEMENT_PLACES.filter((p) => places.has(p)),
      startsAt: start.at,
      endsAt: end.at,
      dismissible: dismissible ?? true,
    },
  };
}

/** Whether `a` shows at `now`: started (or no start) and not ended. */
export function isLive(a: Pick<Announcement, 'startsAt' | 'endsAt'>, now: number = Date.now()): boolean {
  if (a.startsAt && Date.parse(a.startsAt) > now) return false;
  if (a.endsAt && Date.parse(a.endsAt) <= now) return false;
  return true;
}

/** What a page is given of one. */
export const shownOf = (a: Announcement): ShownAnnouncement => ({
  id: a.id,
  kind: a.kind,
  text: a.text,
  linkLabel: a.linkLabel,
  linkUrl: a.linkUrl,
  dismissible: a.dismissible,
  endsAt: a.endsAt,
});

/** `?where=`, checked: the place, or null for anything else. */
export const placeOf = (v: unknown): AnnouncementPlace | null =>
  typeof v === 'string' && (ANNOUNCEMENT_PLACES as readonly string[]).includes(v) ? (v as AnnouncementPlace) : null;

/** Whole dollars bare ("$5"), anything else to the cent. */
const dollars = (micro: number) => {
  const cents = Math.floor(micro / 10_000);
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
};

/**
 * The pricing page's offer for Crossroom's agent, while the instance offers it on credits: what a
 * person's grant of the operator's live offer is and for how long. `endsAt` is when that offer stops
 * taking claims, or null for an offer with no end.
 */
export function houseOffer(o: { grantMicro: number; days: number; endsAt: string | null }): ShownAnnouncement {
  return {
    id: HOUSE_OFFER_ID,
    kind: 'offer',
    // One line on a wide screen and two on a phone, beside its tag and link.
    text: `${dollars(o.grantMicro)} of credit for Crossroom's agent, yours to spend in your workspace or a team's, for ${o.days} days once claimed.`,
    linkLabel: 'Claim it',
    linkUrl: '/w',
    dismissible: false,
    endsAt: o.endsAt,
  };
}
