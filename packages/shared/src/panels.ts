/**
 * A Panel: a named, saved room setup. The title, the shared brief, the
 * mode, its tools, and two to six seats (more where an instance allows them), each with its name, role, lead mark, private brief and kind, and for a
 * hosted seat its runner, directory and model.
 *
 * A Panel is the owner's own. The browser keeps them in its storage and the command in
 * `~/.parley/panels/`; nothing on a server lists them, for the owner or anyone else: a
 * Panel is a private saved setup, never a directory.
 *
 * The web imports this module, so it holds no zod: `parsePanel` is written by hand, and the values
 * it reads from elsewhere come from text.ts, which loads none. The modes and runners are copies of
 * `SessionMode` and `HostedRunner` (index.ts), held to them by a test.
 */
import type { CreateSessionInput, HostedRunner, SessionMode } from './index.js';
import { defaultMaxMessages, oneLine, ROLE_MAX, ROOM_SEATS_DEFAULT, ROOM_SEATS_LIMIT, roomOptionsOf, SUBROOM_MODES, type SubroomMode } from './text.js';

export const PANEL_VERSION = 1;
/** The longest panel name, as a seat name is bounded. */
export const PANEL_NAME_MAX = 60;
/** The fewest seats a panel holds: a room of one is nobody to talk to. */
export const PANEL_SEATS_MIN = 2;

/** Copies of the create route's own bounds (`CreateSessionInput` in index.ts). */
const TITLE_MAX = 120;
const SEAT_NAME_MAX = 60;
const BRIEF_MAX = 20_000;
const MESSAGES_MIN = 2;
const MESSAGES_MAX = 500;
const CWD_MAX = 1_000;
const MODEL_MAX = 200;

/** `SessionMode`'s values, copied: index.ts builds zod schemas when it loads. */
export const PANEL_MODES: readonly SessionMode[] = ['free', 'duel', 'reconcile', 'review', 'handoff', 'custom'];
/** `HostedRunner`'s values, copied for the same reason. */
export const PANEL_RUNNERS: readonly HostedRunner[] = ['claude', 'codex', 'agy', 'grok'];

export interface PanelHosted {
  runner: HostedRunner;
  /** The directory the agent reads. Local to one machine, so `stripForExport` drops it. */
  cwd?: string;
  model?: string;
}

export interface PanelSeat {
  name: string;
  role?: string;
  lead?: boolean;
  privateBrief?: string;
  kind: 'attached' | 'hosted';
  /** Read only for a hosted seat. */
  hosted?: PanelHosted;
}

export interface PanelInput {
  version: 1;
  /** What the owner calls this setup: one line, 1 to 60 characters. */
  name: string;
  /** The room's title. The panel's name stands in when there is none. */
  title?: string;
  sharedBrief?: string;
  mode?: SessionMode;
  maxMessages?: number;
  /** The room's optional tools (`CreateSessionInput`), kept only when set. */
  board?: boolean;
  typedTools?: boolean;
  subrooms?: SubroomMode;
  sparse?: boolean;
  seats: PanelSeat[];
}

/** What a room made from a panel may set differently from it. */
export interface PanelOverrides {
  title?: string;
  sharedBrief?: string;
  mode?: SessionMode;
  maxMessages?: number;
}

/** A panel name as it is kept: on one line, without spaces at either end. */
export const panelName = (name: string): string => oneLine(name).replace(/\s+/g, ' ').trim();

/** The body of `POST /api/sessions` for a room set up as this panel says. A directory is used only by a hosted seat. */
export function panelToCreateInput(panel: PanelInput, overrides: PanelOverrides = {}): CreateSessionInput {
  const title = (overrides.title ?? panel.title ?? '').trim() || panel.name;
  return {
    title: title.slice(0, TITLE_MAX),
    mode: overrides.mode ?? panel.mode ?? 'free',
    sharedBrief: overrides.sharedBrief ?? panel.sharedBrief ?? '',
    maxMessages: overrides.maxMessages ?? panel.maxMessages ?? defaultMaxMessages(panel.seats.length),
    ...roomOptionsOf(panel),
    participants: panel.seats.map((s) => ({
      name: s.name,
      kind: s.kind,
      ...(s.privateBrief ? { privateBrief: s.privateBrief } : {}),
      ...(s.role ? { role: s.role } : {}),
      ...(s.lead ? { lead: true } : {}),
      ...(s.kind === 'hosted' && s.hosted
        ? {
            hosted: {
              runner: s.hosted.runner,
              ...(s.hosted.cwd ? { cwd: s.hosted.cwd } : {}),
              ...(s.hosted.model ? { model: s.hosted.model } : {}),
            },
          }
        : {}),
    })),
  };
}

/** The input a room was (or would be) created from, kept as a panel called `name`. */
export function createInputToPanel(input: Pick<CreateSessionInput, 'participants'> & Partial<Omit<CreateSessionInput, 'participants'>>, name: string): PanelInput {
  const panel: PanelInput = {
    version: PANEL_VERSION,
    name: panelName(name),
    seats: input.participants.map((p) => {
      const seat: PanelSeat = { name: p.name.trim(), kind: p.kind };
      const role = p.role ? oneLine(p.role).trim() : '';
      if (role) seat.role = role;
      if (p.lead) seat.lead = true;
      if (p.privateBrief?.trim()) seat.privateBrief = p.privateBrief;
      if (p.kind === 'hosted' && p.hosted) {
        seat.hosted = { runner: p.hosted.runner };
        if (p.hosted.cwd?.trim()) seat.hosted.cwd = p.hosted.cwd.trim();
        if (p.hosted.model?.trim()) seat.hosted.model = p.hosted.model.trim();
      }
      return seat;
    }),
  };
  if (input.title?.trim()) panel.title = input.title.trim();
  if (input.sharedBrief) panel.sharedBrief = input.sharedBrief;
  if (input.mode) panel.mode = input.mode;
  if (input.maxMessages !== undefined) panel.maxMessages = input.maxMessages;
  Object.assign(panel, roomOptionsOf(input));
  return panel;
}

/** The panel as it leaves this machine: a directory is local to it, and can name the person who uses it. */
export function stripForExport(panel: PanelInput): PanelInput {
  return {
    ...panel,
    seats: panel.seats.map((s) => {
      if (!s.hosted) return { ...s };
      const { cwd: _local, ...hosted } = s.hosted;
      return { ...s, hosted };
    }),
  };
}

export type PanelParse = { ok: true; panel: PanelInput } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

class Bad extends Error {}
const bad = (field: string, what: string): never => {
  throw new Bad(`${field}: ${what}`);
};

/** An optional string field, bounded; `''` and absence read as none. */
function optString(o: Record<string, unknown>, key: string, field: string, max: number, line = false): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return bad(field, 'must be text');
  const s = line ? oneLine(v).trim() : v;
  if (s.length > max) return bad(field, `at most ${max} characters`);
  return s.trim() ? s : undefined;
}

function seatOf(v: unknown, i: number): PanelSeat {
  const at = `seats[${i}]`;
  if (!isObject(v)) return bad(at, 'must be an object');
  if (typeof v.name !== 'string') return bad(`${at}.name`, 'must be text');
  const name = oneLine(v.name).trim();
  if (!name) return bad(`${at}.name`, 'must not be empty');
  if (name.length > SEAT_NAME_MAX) return bad(`${at}.name`, `at most ${SEAT_NAME_MAX} characters`);
  if (v.kind !== 'attached' && v.kind !== 'hosted') return bad(`${at}.kind`, 'must be "attached" or "hosted"');
  const seat: PanelSeat = { name, kind: v.kind };
  const role = optString(v, 'role', `${at}.role`, ROLE_MAX, true);
  if (role) seat.role = role;
  if (v.lead !== undefined && v.lead !== null && typeof v.lead !== 'boolean') return bad(`${at}.lead`, 'must be true or false');
  if (v.lead === true) seat.lead = true;
  const brief = optString(v, 'privateBrief', `${at}.privateBrief`, BRIEF_MAX);
  if (brief) seat.privateBrief = brief;
  if (seat.kind === 'hosted') {
    const h = v.hosted;
    if (!isObject(h)) return bad(`${at}.hosted`, 'a hosted seat needs a runner');
    if (typeof h.runner !== 'string' || !(PANEL_RUNNERS as readonly string[]).includes(h.runner))
      return bad(`${at}.hosted.runner`, `must be one of ${PANEL_RUNNERS.join(', ')}`);
    seat.hosted = { runner: h.runner as HostedRunner };
    const cwd = optString(h, 'cwd', `${at}.hosted.cwd`, CWD_MAX, true);
    if (cwd) seat.hosted.cwd = cwd;
    const model = optString(h, 'model', `${at}.hosted.model`, MODEL_MAX, true);
    if (model) seat.hosted.model = model;
  }
  return seat;
}

/**
 * A panel read from JSON (text or already parsed), checked field by field. Fields it does not
 * know are dropped, and so is a directory on a seat that is not hosted. The error names the field.
 *
 * `seatsMax` is the most seats it may hold: the instance's cap where a room is about to be made
 * from it (six unless the operator raised it), or `ROOM_SEATS_LIMIT` to read whatever the format
 * holds, as a list of kept panels does.
 */
export function parsePanel(json: unknown, { seatsMax = ROOM_SEATS_DEFAULT }: { seatsMax?: number } = {}): PanelParse {
  let v = json;
  if (typeof json === 'string') {
    try {
      v = JSON.parse(json) as unknown;
    } catch {
      return { ok: false, error: 'This is not JSON.' };
    }
  }
  try {
    if (!isObject(v)) return bad('panel', 'must be a JSON object');
    if (v.version !== PANEL_VERSION) return bad('version', `must be ${PANEL_VERSION}`);
    if (typeof v.name !== 'string') return bad('name', 'must be text');
    const name = panelName(v.name);
    if (!name) return bad('name', 'must not be empty');
    if (name.length > PANEL_NAME_MAX) return bad('name', `at most ${PANEL_NAME_MAX} characters`);
    const panel: PanelInput = { version: PANEL_VERSION, name, seats: [] };
    const title = optString(v, 'title', 'title', TITLE_MAX, true);
    if (title) panel.title = title;
    const brief = optString(v, 'sharedBrief', 'sharedBrief', BRIEF_MAX);
    if (brief) panel.sharedBrief = brief;
    if (v.mode !== undefined && v.mode !== null) {
      if (typeof v.mode !== 'string' || !(PANEL_MODES as readonly string[]).includes(v.mode)) return bad('mode', `must be one of ${PANEL_MODES.join(', ')}`);
      panel.mode = v.mode as SessionMode;
    }
    if (v.maxMessages !== undefined && v.maxMessages !== null) {
      const n = v.maxMessages;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < MESSAGES_MIN || n > MESSAGES_MAX)
        return bad('maxMessages', `must be a whole number from ${MESSAGES_MIN} to ${MESSAGES_MAX}`);
      panel.maxMessages = n;
    }
    for (const key of ['board', 'typedTools', 'sparse'] as const) {
      const b = v[key];
      if (b === undefined || b === null || b === false) continue;
      if (b !== true) return bad(key, 'must be true or false');
      panel[key] = true;
    }
    if (v.subrooms !== undefined && v.subrooms !== null) {
      if (typeof v.subrooms !== 'string' || !(SUBROOM_MODES as readonly string[]).includes(v.subrooms))
        return bad('subrooms', `must be one of ${SUBROOM_MODES.join(', ')}`);
      if (v.subrooms !== 'off') panel.subrooms = v.subrooms as SubroomMode;
    }
    if (!Array.isArray(v.seats)) return bad('seats', 'must be a list');
    const most = Math.min(Math.max(PANEL_SEATS_MIN, seatsMax), ROOM_SEATS_LIMIT);
    if (v.seats.length < PANEL_SEATS_MIN || v.seats.length > most)
      return bad('seats', `a panel holds ${PANEL_SEATS_MIN} to ${most} seats, not ${v.seats.length}`);
    panel.seats = v.seats.map(seatOf);
    const leads = panel.seats.flatMap((s, i) => (s.lead ? [i] : []));
    if (leads.length > 1) return bad(`seats[${leads[1]}].lead`, `seats[${leads[0]}] is the lead already, and a room has one at most`);
    return { ok: true, panel };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: e.message };
    throw e;
  }
}

/** "4 seats: Architect (lead), Security, Operations, API consumer", for a list or a card. */
export function panelSeatsLine(seats: ReadonlyArray<Pick<PanelSeat, 'name' | 'lead'>>): string {
  return `${seats.length} seats: ${seats.map((s) => (s.lead && s.name.trim().toLowerCase() !== 'lead' ? `${s.name} (lead)` : s.name)).join(', ')}`;
}
