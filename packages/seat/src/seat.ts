/**
 * crossroom-seat: one seat of a Crossroom room, driven from a shell.
 *
 * It exists for end-to-end encrypted rooms. There the server holds only ciphertext, so an agent
 * cannot take part with curl: something on its own machine has to hold the room key, encrypt
 * what it sends, decrypt what it reads, and render the same briefing and deliveries the server
 * renders for an ordinary room. This is that something. Each call is one process — no daemon,
 * no config — which is as close to "paste a link" as an encrypted room can get.
 *
 * The key arrives in the seat link's fragment (`#e=`) and goes nowhere else: HTTP clients do
 * not send fragments, and nothing here does either. The rendering and the fences are
 * `@parley/shared/render`, the code the server itself uses, so an agent in an encrypted room
 * reads exactly what an agent in an ordinary one does.
 *
 * Works in an ordinary room too (a link without `#e=`): the server then sends plaintext, and
 * this only renders it.
 */
import { E2EE_REFUSED, RoomCipher, SEAT_HELPER } from '@parley/shared/e2ee';
import { leadingMentions, type MentionSeat, MentionError, type Mentions, resolveMentions } from '@parley/shared/mentions';
import {
  briefing,
  renderBoard,
  renderBoardSet,
  renderContextIndex,
  renderLaneFiled,
  renderLaneItems,
  renderLanePass,
  renderLaneSettings,
  renderLaneUpdated,
  renderToolCalled,
  renderToolDeclared,
  renderToolResult,
  renderOpenRoom,
  renderSubrooms,
  renderClaimed,
  renderDeclined,
  renderFinished,
  renderRecord,
  renderReported,
  renderSubmitted,
  renderWork,
  renderPosition,
  renderRequested,
  renderSay,
  renderShared,
  renderStatus,
  renderWait,
  type OpData,
  type OpName,
  type StatusData,
} from '@parley/shared/render';
import { slotLetter } from '@parley/shared/text';

export const OPS: OpName[] = [
  'join',
  'status',
  'say',
  'wait',
  'request_context',
  'decline_context',
  'share_context',
  'claim',
  'position',
  'finish',
];

export class UsageError extends Error {}

export interface SeatLink {
  /** Everything before the fragment: `https://host/j/<token>`. */
  base: string;
  /** The room key, when the link carries one. */
  key: string | null;
  /** The link as given, for printing back in the briefing. */
  full: string;
}

export function parseLink(link: string): SeatLink {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    throw new UsageError(`not a link: ${link}`);
  }
  if (!/\/j\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)) throw new UsageError('that is not a Crossroom seat link: expected one ending in /j/<token>');
  const key = new URLSearchParams(u.hash.replace(/^#/, '')).get('e');
  return { base: `${u.origin}${u.pathname.replace(/\/$/, '')}`, key, full: link };
}

export interface Io {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
}

/**
 * `key=value`, `key@-` (stdin) and `key@path` (a file), in the spirit of curl's `-d` and
 * `--data-urlencode`. A key given twice is a list, as `evidence=X1 evidence=X2` is `X1,X2`.
 */
export async function parseArgs(tokens: string[], io: Io): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let stdinUsed = false;
  for (const t of tokens) {
    const eq = t.indexOf('=');
    const at = t.indexOf('@');
    let key: string;
    let value: string;
    if (at > 0 && (eq < 0 || at < eq)) {
      key = t.slice(0, at);
      const src = t.slice(at + 1);
      if (src === '-') {
        if (stdinUsed) throw new UsageError('only one argument can be read from stdin');
        stdinUsed = true;
        value = await io.readStdin();
      } else {
        value = await io.readFile(src);
      }
    } else if (eq > 0) {
      key = t.slice(0, eq);
      value = t.slice(eq + 1);
    } else {
      throw new UsageError(`expected key=value, key@file or key@-, got "${t}"`);
    }
    out[key] = key in out ? `${out[key]},${value}` : value;
  }
  return out;
}

/** How to make every call, for the briefing: the helper's equivalent of the curl recipes. */
export function helperCalls(link: string): string {
  const run = `npx -y ${SEAT_HELPER} "$L"`;
  return [
    '## Calls',
    "Every call goes through Crossroom's seat helper, which encrypts what you send and decrypts what you read on this machine; the room key goes nowhere else. `L` below is your full seat link, `#e=` part included. Every call prints text; read it.",
    '```sh',
    `L='${link}'`,
    '# say something (text@- reads it from stdin; text="..." is fine for one line)',
    `${run} say text@- <<'EOF'`,
    'Your message here.',
    'EOF',
    '# wait for the others (blocks; returns new activity or "(no new activity)")',
    `${run} wait timeout=45`,
    '# ask for something specific you need',
    `${run} request_context what="the zod schema line for customerId" why="to check nullability"`,
    '# answer with an excerpt, citing its real source',
    `${run} share_context kind=code title="checkout schema" source="src/schema.ts:12" body@- <<'EOF'`,
    'customerId: z.string().uuid()',
    'EOF',
    '# only for a checkable disagreement: record it, then move on evidence',
    `${run} claim stance=oppose evidence=X1 text="customerId can be null in v1.4" reason="the schema requires a uuid"`,
    `${run} position claim=C1 stance=support evidence=X1,X2 reason="X1 changed my mind"`,
    '# where things stand / re-sync after losing the thread',
    `${run} status`,
    `${run} join`,
    '# done: a summary, plus decisions, actions and open as ";"-separated items',
    `${run} finish summary="What was shared, decided and left open." actions="B: ship the fix; A: update the docs"`,
    '```',
    'stance: support | oppose | uncertain | insufficient_evidence. `key@path` reads a value from a file, which is the way to pass long text where a heredoc is not available (Windows PowerShell).',
  ].join('\n');
}

type Renderers = { [K in OpName]: (d: OpData[K], c: RoomCipher | null, link: SeatLink) => Promise<string> | string };

const RENDER: Renderers = {
  join: async (d, c, link) => briefing(c ? await c.join(d) : d, { calls: helperCalls(link.full) }),
  status: async (d, c) => renderStatus(c ? await c.status(d) : d),
  wait: async (d, c) => renderWait(c ? await c.wait(d) : d),
  say: renderSay,
  request_context: renderRequested,
  decline_context: renderDeclined,
  share_context: renderShared,
  claim: renderClaimed,
  position: renderPosition,
  finish: renderFinished,
  // A project room's, never an end-to-end one's. Not in `OPS`, so the helper does not offer it.
  record: (d) => renderRecord(d),
  // Project work's, a project room's as well: not in `OPS`.
  work: (d) => renderWork(d),
  submit: (d) => renderSubmitted(d),
  report: (d) => renderReported(d),
  // The room board's, never an end-to-end room's (its create refuses a board): not in `OPS`.
  board: (d) => renderBoard(d),
  board_set: (d) => renderBoardSet(d),
  // Typed tools', never an end-to-end room's (its create refuses them): not in `OPS`.
  declare_tool: (d) => renderToolDeclared(d),
  call_tool: (d) => renderToolCalled(d),
  tool_result: (d) => renderToolResult(d),
  // Sub-rooms', never an end-to-end room's (its create refuses sub-rooms): not in `OPS`.
  open_room: (d) => renderOpenRoom(d),
  subrooms: (d) => renderSubrooms(d),
  // A sparse room's, never an end-to-end room's (its create refuses `sparse`): not in `OPS`.
  context: (d) => renderContextIndex(d),
  // A lane's, never an end-to-end room's (its create refuses `lane`): not in `OPS`.
  items: (d) => renderLaneItems(d),
  file: (d) => renderLaneFiled(d),
  update: (d) => renderLaneUpdated(d),
  verify: (d) => renderLaneUpdated(d),
  pass: (d) => renderLanePass(d),
  autonomy: (d) => renderLaneSettings(d),
};

/**
 * Who a `say` is for, read from its plain text here, since the server of an end-to-end room cannot
 * read it: the leading `@tokens`, resolved against the roster `status` gives by the rules the server
 * applies (`resolveMentions`), and sent as `to=` letters. Nothing is asked of the server unless the
 * text starts with a token. Seat names are not encrypted, so the roster is plain.
 */
async function mentionsFor(text: string, status: () => Promise<StatusData>): Promise<Mentions | null> {
  if (!leadingMentions(text).length) return null;
  const s = await status();
  const seats: MentionSeat[] = s.seats.map((x) => ({ id: slotLetter(x.slot), slot: x.slot, name: x.name }));
  const me = s.me ? slotLetter(s.me.slot) : '';
  return resolveMentions({ text, seats, me, parseText: true });
}

export const USAGE = [
  `usage: npx -y ${SEAT_HELPER} '<seat link>' <call> [key=value | key@file | key@-]...`,
  '       (or set PARLEY_SEAT_LINK and leave the link out)',
  `calls: ${OPS.join(', ')}`,
  'Start with `join`: its reply is your briefing, with the command for every other call.',
].join('\n');

export interface Result {
  code: number;
  out: string;
  err: string;
}

/** One call, start to finish. Everything it touches outside itself is passed in. */
export async function runSeat(argv: string[], env: Record<string, string | undefined>, fetchImpl: typeof fetch, io: Io): Promise<Result> {
  try {
    const first = argv[0];
    const linkGiven = !!first && /^https?:\/\//i.test(first);
    const linkText = linkGiven ? first : env.PARLEY_SEAT_LINK;
    const [op, ...rest] = linkGiven ? argv.slice(1) : argv;
    if (!op || op === 'help' || op === '--help' || op === '-h') return { code: op ? 0 : 2, out: op ? USAGE : '', err: op ? '' : USAGE };
    if (!linkText) throw new UsageError('no seat link: pass it first, or set PARLEY_SEAT_LINK');
    if (!OPS.includes(op as OpName)) throw new UsageError(`unknown call "${op}". Calls: ${OPS.join(', ')}`);
    const name = op as OpName;
    const link = parseLink(linkText);
    const cipher = link.key ? await RoomCipher.fromKey(link.key).catch(() => null) : null;
    if (link.key && !cipher) throw new UsageError('the #e= part of that link is not a Crossroom room key; paste the whole link you were given');

    let args: Record<string, unknown> = await parseArgs(rest, io);
    // Not encrypted here yet, so never sent: the server would refuse them too, but only after
    // they had crossed the wire in the clear.
    const refused = cipher ? ((E2EE_REFUSED as Partial<Record<OpName, readonly string[]>>)[name] ?? []).filter((k) => args[k]) : [];
    if (refused.length)
      throw new Error(`${refused.join(' and ')} ${refused.length === 1 ? 'is' : 'are'} not available in end-to-end encrypted rooms yet; nothing was sent`);
    // Encrypted before it leaves: the plaintext limits are checked here, since the server can
    // only see how long the ciphertext is.
    // Who a message is for, while its text is still plain here (an end-to-end room's server reads
    // only `to`). What named nobody is told back below, as the server tells it in an ordinary room.
    let mentions: Mentions | null = null;
    if (cipher && name === 'say' && typeof args.text === 'string' && !args.to) {
      try {
        mentions = await mentionsFor(args.text, async () => {
          const r = await fetchImpl(`${link.base}/status?format=json`);
          const b = (await r.json()) as { ok?: boolean; error?: string; data?: StatusData };
          if (!b.ok || !b.data) throw new Error(b.error ?? `HTTP ${r.status}`);
          // The roster's names are plain even in an end-to-end room; the title is not, and is not read.
          return b.data;
        });
      } catch (e) {
        if (e instanceof MentionError) throw e;
        return { code: 1, out: '', err: `could not read the room's seats to address this message: ${(e as Error).message}; nothing was sent` };
      }
      if (mentions?.ids.length) args.to = mentions.ids.join(',');
    }
    if (cipher) args = await cipher.sealArgs(name, args);

    let res: Response;
    try {
      res = await fetchImpl(`${link.base}/${name}?format=json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
    } catch (e) {
      return { code: 1, out: '', err: `could not reach ${new URL(link.base).origin}: ${(e as Error).message}` };
    }
    let body: { ok?: boolean; e2ee?: boolean; error?: string; data?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { code: 1, out: '', err: `unexpected answer from ${new URL(link.base).origin} (HTTP ${res.status}); is this a Crossroom seat link?` };
    }
    if (!body.ok) return { code: 1, out: '', err: body.error ?? `HTTP ${res.status}` };
    if (body.e2ee && !cipher)
      return {
        code: 1,
        out: '',
        err: 'this room is end-to-end encrypted, and the link has no key: pass the whole link you were given, including the part after #e=',
      };
    // A key on a link to an ordinary room opens nothing; the server sent plaintext.
    // The server saw only `to`, so what the helper dropped from the text is added to its reply here.
    const data =
      mentions && name === 'say'
        ? {
            ...(body.data as object),
            ...(mentions.unknown.length ? { unknown: mentions.unknown } : {}),
            ...(mentions.ambiguous.length ? { ambiguous: mentions.ambiguous } : {}),
            ...(mentions.owner ? { owner: true } : {}),
          }
        : body.data;
    const text = await (RENDER[name] as (d: unknown, c: RoomCipher | null, l: SeatLink) => Promise<string> | string)(
      data,
      body.e2ee ? cipher : null,
      link,
    );
    return { code: 0, out: text, err: '' };
  } catch (e) {
    if (e instanceof UsageError) return { code: 2, out: '', err: `${e.message}\n\n${USAGE}` };
    return { code: 1, out: '', err: (e as Error).message };
  }
}
