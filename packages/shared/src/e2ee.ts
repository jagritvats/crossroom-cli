/**
 * End-to-end encrypted rooms.
 *
 * An opt-in room whose content the server never sees in the clear. The key is 32 random bytes
 * made in the owner's browser; it travels only in URL fragments (`#e=`), which browsers and
 * curl never send to a server. Everything a person or an agent writes into the room is
 * encrypted before it leaves their machine, and decrypted only on another machine holding the
 * key: the owner's browser, or the seat helper an agent runs.
 *
 *   e1.<b64url(iv)>.<b64url(ciphertext | tag)>    AES-256-GCM, AAD parley/e2ee/v1|<field class>
 *
 * The field class in the AAD stops a ciphertext being moved to stand for a different kind of
 * field (a private brief served up as a message). It cannot bind a value to a row, because the
 * browser encrypts a room's title and briefs before the room has an id; the per-room key is
 * what ties a ciphertext to its room.
 *
 * What stays visible to the server, by design, because the room cannot work without it: seat
 * names and letters, who said something when, sizes, packet labels and kinds, stances, which
 * labels were cited, claim status. The minutes' structure, not their words.
 *
 * Runs unchanged in browsers and Node 19+ (WebCrypto on `globalThis.crypto`).
 */
import type { EventType, ParleyEvent, SessionSnapshot } from './index.js';
import type { JoinData, OpData, StatusData, WaitData } from './render.js';
import { CLOSE_OUT_FIELDS, CLOSE_OUT_MAX, type CloseOutField, closeOutItems, closeOutProblem } from './text.js';

const PREFIX = 'e1.';
const AAD = 'parley/e2ee/v1|';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const CHECK_TEXT = 'parley-e2ee-check-v1';

/**
 * The seat helper an agent runs to take part in an end-to-end room, pinned to an exact
 * version: the command is printed by the server, and a range would let a later release
 * (or a compromised one) run on agents' machines unasked.
 */
export const SEAT_HELPER = 'crossroom-seat@0.1.3';

/** The shell command for one call through the helper. */
export const helperCommand = (link: string, op: string, args = '') => `npx -y ${SEAT_HELPER} '${link}' ${op}${args ? ` ${args}` : ''}`;

/** Every kind of field that is encrypted, which is also what its AAD names. */
export type FieldClass =
  | 'check'
  | 'session.title'
  | 'session.brief'
  | 'session.outcome'
  | 'seat.brief'
  | 'message.text'
  | 'request.what'
  | 'request.why'
  | 'request.reason'
  | 'packet.title'
  | 'packet.body'
  | 'packet.source'
  | 'claim.text'
  | 'claim.resolution'
  | 'position.reason'
  | 'finish.summary'
  | 'finish.decisions'
  | 'finish.actions'
  | 'finish.open';

// ---------------- encoding ----------------

function toB64u(bytes: Uint8Array): string {
  let bin = '';
  // Chunked: spreading 60 kB into one call overruns the argument limit in some engines.
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

// ---------------- keys ----------------

/** A new room key, as it travels in a link. */
export function generateRoomKey(): string {
  const b = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(b);
  return toB64u(b);
}

/** Looks like a room key: 32 bytes of base64url. Says nothing about which room it opens. */
export const isRoomKey = (s: string) => /^[A-Za-z0-9_-]{43}$/.test(s);

/** Async throughout, so a malformed key is a rejected promise rather than a synchronous throw. */
export async function importRoomKey(key: string): Promise<CryptoKey> {
  if (!isRoomKey(key)) throw new Error('not a Crossroom room key');
  const raw = fromB64u(key);
  return await globalThis.crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ---------------- fields ----------------

export const isEnvelope = (v: unknown): v is string => typeof v === 'string' && /^e1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/.test(v);

/**
 * The longest envelope `n` UTF-16 units of plaintext can become: at most three UTF-8 bytes per
 * unit, a 16-byte tag, base64url's four characters per three bytes, and the framing. The
 * server checks envelopes against this; the plaintext limit itself is the client's to enforce.
 */
export const envelopeMax = (n: number) => PREFIX.length + 16 + 1 + Math.ceil(((3 * n + 16) * 4) / 3);

/** Encrypt one field. Empty stays empty: "no brief" is not a secret and the server needs to see it. */
export async function encryptField(key: CryptoKey, cls: FieldClass, plain: string): Promise<string> {
  if (plain === '') return '';
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8.encode(AAD + cls) },
    key,
    utf8.encode(plain),
  );
  return `${PREFIX}${toB64u(iv)}.${toB64u(new Uint8Array(ct))}`;
}

/** Decrypt one field written as any of `classes`. Throws if none fits. */
export async function decryptField(key: CryptoKey, classes: FieldClass | FieldClass[], value: string): Promise<string> {
  if (!isEnvelope(value)) throw new Error('not an encrypted Crossroom value');
  const [, iv, ct] = value.split('.') as [string, string, string];
  for (const cls of Array.isArray(classes) ? classes : [classes]) {
    try {
      const plain = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64u(iv) as BufferSource, additionalData: utf8.encode(AAD + cls) },
        key,
        fromB64u(ct) as BufferSource,
      );
      return fromUtf8.decode(plain);
    } catch {
      /* try the next class */
    }
  }
  throw new Error('this value does not open with this room key');
}

/** Stored with the room so a client can tell whether a key it was handed is this room's. */
export const makeCheck = (key: CryptoKey) => encryptField(key, 'check', CHECK_TEXT);

export async function verifyCheck(key: CryptoKey, check: string | null | undefined): Promise<boolean> {
  if (!check) return false;
  try {
    return (await decryptField(key, 'check', check)) === CHECK_TEXT;
  } catch {
    return false;
  }
}

// ---------------- which fields ----------------

export interface SealedArg {
  cls: FieldClass;
  /** Plaintext bounds, which only a client holding the plaintext can check. */
  min?: number;
  max: number;
}

/**
 * The single list of what is encrypted in an end-to-end room, per place it enters the server.
 * The server derives its envelope checks from it, the helper and the browser their encryption.
 */
export const E2EE_FIELDS = {
  /** Seat operations, by argument. */
  ops: {
    join: {},
    status: {},
    wait: {},
    say: { text: { cls: 'message.text', min: 1, max: 8000 } },
    request_context: { what: { cls: 'request.what', min: 3, max: 2000 }, why: { cls: 'request.why', max: 1000 } },
    decline_context: { reason: { cls: 'request.reason', min: 3, max: 1000 } },
    share_context: {
      title: { cls: 'packet.title', min: 1, max: 200 },
      body: { cls: 'packet.body', min: 1, max: 60_000 },
      source: { cls: 'packet.source', max: 400 },
    },
    claim: { text: { cls: 'claim.text', min: 5, max: 1000 }, reason: { cls: 'position.reason', max: 2000 } },
    position: { reason: { cls: 'position.reason', max: 2000 } },
    // The close-out lists travel as one envelope each, split into items once opened (`closeOutItems`).
    finish: {
      summary: { cls: 'finish.summary', min: 10, max: 4000 },
      decisions: { cls: 'finish.decisions', max: CLOSE_OUT_MAX },
      actions: { cls: 'finish.actions', max: CLOSE_OUT_MAX },
      open: { cls: 'finish.open', max: CLOSE_OUT_MAX },
    },
    // The project record (project rooms only). Nothing it takes is encrypted: its one content
    // argument, the query, is refused in an end-to-end room (`E2EE_REFUSED`), since the server
    // searches the record in the clear and could not read an encrypted query.
    record: {},
    // Project work (project rooms only). Their content arguments are refused in an
    // end-to-end room (`E2EE_REFUSED`), and the server does not offer them there at all.
    work: {},
    submit: {},
    report: {},
    // The room board. A room with a board is never end-to-end (its create refuses
    // `board`), so nothing here is encrypted, and their arguments are refused (`E2EE_REFUSED`).
    board: {},
    board_set: {},
    // Typed tools: likewise never in an end-to-end room (its create refuses
    // `typedTools`), so nothing here is encrypted and their content arguments are refused.
    declare_tool: {},
    call_tool: {},
    tool_result: {},
    // Sub-rooms: never in an end-to-end room (its create refuses `subrooms`), so
    // nothing here is encrypted and the plan's text is refused.
    open_room: {},
    subrooms: {},
    // A sparse room's: never an end-to-end room (its create refuses `sparse`), so
    // nothing here is encrypted, and the words to search for are refused.
    context: {},
    // A lane's: never an end-to-end room (its create refuses `lane`), so nothing here
    // is encrypted.
    items: {},
    file: {},
    update: {},
    verify: {},
    pass: {},
    autonomy: {},
  } satisfies Record<keyof OpData, Record<string, SealedArg>>,
  /** The owner's own writes. */
  owner: {
    title: { cls: 'session.title', min: 1, max: 120 },
    sharedBrief: { cls: 'session.brief', max: 20_000 },
    privateBrief: { cls: 'seat.brief', max: 20_000 },
    note: { cls: 'message.text', min: 1, max: 8000 },
    nudge: { cls: 'message.text', min: 1, max: 4000 },
    outcome: { cls: 'session.outcome', max: 4000 },
    // A packet the owner shares, answering a request or volunteering evidence. The same classes
    // as an agent's packet, because it is opened wherever an agent's is.
    packetTitle: { cls: 'packet.title', min: 1, max: 200 },
    packetBody: { cls: 'packet.body', min: 1, max: 60_000 },
    packetSource: { cls: 'packet.source', max: 400 },
    // The owner's ruling on a claim, once the room has ended.
    resolution: { cls: 'claim.resolution', min: 3, max: 2000 },
  } satisfies Record<string, SealedArg>,
  /** Event payloads, by event type and field. */
  events: {
    // A v2 room records the shared brief in its first event too.
    session_created: { title: 'session.title', sharedBrief: 'session.brief' },
    // `title` is there when the message became the brief; it is the room's title, unchanged.
    message: { text: 'message.text', title: 'session.title' },
    human_note: { text: 'message.text' },
    nudge: { text: 'message.text' },
    context_requested: { what: 'request.what', why: 'request.why', reason: 'request.reason' },
    context_shared: { title: 'packet.title', body: 'packet.body', source: 'packet.source' },
    claim_created: { text: 'claim.text' },
    position_updated: { claimText: 'claim.text', reason: 'position.reason' },
    claim_updated: { claimText: 'claim.text', reason: 'position.reason' },
    claim_settled: { claimText: 'claim.text', resolution: 'claim.resolution' },
    participant_finished: { summary: 'finish.summary', decisions: 'finish.decisions', actions: 'finish.actions', open: 'finish.open' },
    session_ended: { outcome: 'session.outcome' },
    // Chain v2: a v2 room's record of a seat's private brief, which in an
    // end-to-end room is the envelope the owner's browser made, as `participants.private_brief` is.
    brief_set: { brief: 'seat.brief' },
  } satisfies Partial<Record<EventType, Record<string, FieldClass>>>,
} as const;

/**
 * Arguments an end-to-end room refuses outright, for now: tool offers, and the tool and args of
 * a typed request. They are content, so they would have to be encrypted, and the seat helper
 * does not encrypt them yet. Refusing is the honest middle: the server answers 400 before
 * anything is recorded, and the helper refuses them before it sends anything at all. Decide
 * whether to support them before `crossroom-seat` is published, while the helper can still change.
 */
/**
 * The header a runner hosting a seat sends to read an end-to-end room's seat page and stream as
 * stored, ciphertext and all (`x-parley-e2ee: envelopes`). A person's page never sends it.
 */
export const E2EE_ENVELOPES_HEADER = 'x-parley-e2ee';

export const E2EE_REFUSED = {
  join: ['offers'],
  request_context: ['tool', 'args'],
  // The record's search runs on the server over facts it opens under the project key, so a query
  // it could not read would search for nothing; and a plaintext one would be content in the clear.
  record: ['query'],
  // A submission's text and a report's note would be stored in the clear in the project's record.
  submit: ['body', 'title'],
  report: ['note'],
  // The board's keys and values would be stored in the clear.
  board: ['key'],
  board_set: ['key', 'value'],
  // A declaration, a call's args and a result would be stored in the clear.
  declare_tool: ['name', 'description', 'input_schema', 'output_schema'],
  call_tool: ['tool', 'args'],
  tool_result: ['result', 'error'],
  // A sub-room's plan would be stored in the clear.
  open_room: ['title', 'brief', 'seats', 'why'],
  // A search runs on the server over packets it opens, so a query it could not read finds nothing.
  context: ['q'],
} as const satisfies Partial<Record<keyof OpData, readonly string[]>>;

/**
 * A shared brief is the owner's, or, in a room opened with no topic, the first message copied
 * over by the server — which is a message's ciphertext. Both are this room's words.
 */
const BRIEF: FieldClass[] = ['session.brief', 'message.text'];

/**
 * Values the server writes itself, in the clear, in an encrypted room: how a room ended when
 * Crossroom ended it ("Ended automatically after 1h without activity.", "All participants
 * finished."). Nothing else may be plaintext. A plaintext value anywhere else is either a bug
 * or a server putting words in someone's mouth, and it is shown as such, never as theirs.
 */
const SYSTEM_PLAIN: ReadonlySet<FieldClass> = new Set(['session.outcome']);

/** What a reader sees in place of a value that should have been encrypted and is not. */
export const NOT_FROM_THIS_ROOM = '[unreadable: not encrypted with this room key]';

// The zod schemas for these rooms (`envelopeArg`, `CreateE2eeSessionInput`) live in
// `e2ee-schema.ts`: this module runs in the browser, and only the server validates. The type
// is re-exported so the browser can still name the request body it builds.
export type { CreateE2eeSessionInput } from './e2ee-schema.js';

// ---------------- opening what the server sends ----------------

/** Decrypts values of one room, and knows which plaintext it may let through. */
export class RoomCipher {
  private constructor(readonly key: CryptoKey) {}

  static async fromKey(key: string) {
    return new RoomCipher(await importRoomKey(key));
  }

  seal(cls: FieldClass, plain: string) {
    return encryptField(this.key, cls, plain);
  }

  async open(classes: FieldClass | FieldClass[], v: string | null | undefined): Promise<string | null> {
    if (v === null || v === undefined) return null;
    if (v === '') return '';
    const list = Array.isArray(classes) ? classes : [classes];
    if (!isEnvelope(v)) return list.some((c) => SYSTEM_PLAIN.has(c)) ? v : NOT_FROM_THIS_ROOM;
    try {
      return await decryptField(this.key, list, v);
    } catch {
      return NOT_FROM_THIS_ROOM;
    }
  }

  private async text(classes: FieldClass | FieldClass[], v: string) {
    return (await this.open(classes, v)) ?? '';
  }

  async event(ev: ParleyEvent): Promise<ParleyEvent> {
    const fields = (E2EE_FIELDS.events as Partial<Record<EventType, Record<string, FieldClass>>>)[ev.type];
    if (!fields) return ev;
    const payload: Record<string, unknown> = { ...ev.payload };
    for (const [k, cls] of Object.entries(fields)) {
      if (typeof payload[k] === 'string') payload[k] = await this.open(cls, payload[k] as string);
    }
    // A close-out list was sealed as the one string the seat sent: opened, it becomes the items the
    // server would have stored in an ordinary room, so every reader sees one shape.
    if (ev.type === 'participant_finished')
      for (const f of CLOSE_OUT_FIELDS) {
        if (typeof payload[f] !== 'string') continue;
        const items = closeOutItems(payload[f] as string);
        if (items.length) payload[f] = items;
        else delete payload[f];
      }
    return { ...ev, payload };
  }

  async snapshot<S extends SessionSnapshot>(snap: S): Promise<S> {
    const s = snap.session;
    return {
      ...snap,
      session: {
        ...s,
        title: await this.text('session.title', s.title),
        sharedBrief: await this.text(BRIEF, s.sharedBrief),
        outcome: await this.open('session.outcome', s.outcome),
      },
      participants: await Promise.all(snap.participants.map(async (p) => ({ ...p, privateBrief: await this.open('seat.brief', p.privateBrief) }))),
      messages: await Promise.all(snap.messages.map(async (m) => ({ ...m, text: await this.text('message.text', m.text) }))),
      contextRequests: await Promise.all(
        snap.contextRequests.map(async (r) => ({ ...r, what: await this.text('request.what', r.what), why: await this.open('request.why', r.why) })),
      ),
      contextItems: await Promise.all(
        snap.contextItems.map(async (i) => ({
          ...i,
          title: await this.text('packet.title', i.title),
          body: await this.text('packet.body', i.body),
          source: await this.open('packet.source', i.source),
        })),
      ),
      claims: await Promise.all(
        snap.claims.map(async (c) => ({ ...c, text: await this.text('claim.text', c.text), resolution: await this.open('claim.resolution', c.resolution) })),
      ),
      positions: await Promise.all(snap.positions.map(async (p) => ({ ...p, reason: await this.open('position.reason', p.reason) }))),
      events: await Promise.all(snap.events.map((e) => this.event(e))),
    };
  }

  async join(d: JoinData): Promise<JoinData> {
    return {
      ...d,
      session: { ...d.session, title: await this.text('session.title', d.session.title), sharedBrief: await this.text(BRIEF, d.session.sharedBrief) },
      me: { ...d.me, privateBrief: await this.open('seat.brief', d.me.privateBrief) },
      messages: await Promise.all(d.messages.map(async (m) => ({ ...m, text: await this.text('message.text', m.text) }))),
      items: await Promise.all(
        d.items.map(async (i) => ({
          ...i,
          title: await this.text('packet.title', i.title),
          body: await this.text('packet.body', i.body),
          source: await this.open('packet.source', i.source),
        })),
      ),
      openRequests: await Promise.all(
        d.openRequests.map(async (r) => ({ ...r, what: await this.text('request.what', r.what), why: await this.open('request.why', r.why) })),
      ),
      claims: await Promise.all(d.claims.map(async (c) => ({ ...c, text: await this.text('claim.text', c.text) }))),
    };
  }

  async status(d: StatusData): Promise<StatusData> {
    return { ...d, title: await this.text('session.title', d.title) };
  }

  async wait(d: WaitData): Promise<WaitData> {
    return { ...d, events: await Promise.all(d.events.map((e) => this.event(e))) };
  }

  /**
   * Encrypt a seat operation's arguments, after checking them as plaintext: the server can
   * only see how long the envelope is, so the real limits are enforced here.
   */
  async sealArgs(op: keyof OpData, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fields = E2EE_FIELDS.ops[op] as Record<string, SealedArg>;
    const out = { ...args };
    for (const [k, spec] of Object.entries(fields)) {
      const v = out[k];
      if (v === undefined || v === null) continue;
      const plain = String(v);
      if (spec.min !== undefined && plain.length < spec.min) throw new Error(`${k} must be at least ${spec.min} characters`);
      if (plain.length > spec.max) throw new Error(`${k} must be at most ${spec.max} characters`);
      // The server cannot count a sealed list's items, so the helper refuses what it would.
      const problem = op === 'finish' && (CLOSE_OUT_FIELDS as readonly string[]).includes(k) ? closeOutProblem(k as CloseOutField, plain) : null;
      if (problem) throw new Error(problem);
      out[k] = await this.seal(spec.cls, plain);
    }
    return out;
  }
}
