/**
 * `may_ask` grants, on the runner's side: which projects' and teams' rooms a
 * standing seat may be dispatched into, beyond the asks its own link opens.
 *
 * How a grant works:
 * - For every `may_ask` entry of a seat's policy (`project:<id>`, `team:<id>`), the runner mints a
 *   grant token (`sg_`, 32 random bytes) and uploads it once (`POST /api/runner/grants`). The relay
 *   keeps its sha256, and the token sealed under the organisation key (`seat_grants`), because a
 *   dispatch into one of that project's rooms carries it, sealed to this runner with the rest of
 *   the job (`payload.grant`).
 * - The runner keeps the hash only (`GrantBook`, `<home>/grants.json`, 0600): a copy of the
 *   runner's files cannot forge a grant, and nothing a grant opens is ever in a file.
 * - A dispatch naming a grant is taken only if its token's hash is the one this runner minted for
 *   that seat and that very principal (`GrantBook.check`). A project A grant presented for a
 *   project B dispatch fails: this runner never minted a B grant for that token. And the grant
 *   must name the project (or team) the seat page says the room is in; a room whose project the
 *   runner was not told is refused, never waved through.
 *
 * The bound: a relay that is compromised can seal whatever it likes to this runner, but
 * it holds only the grants this runner uploaded, so it can seat the agent only in rooms it claims
 * belong to a project the team allowed: no more than a member of an allowed project could do by
 * opening a room there. It can never widen the list.
 *
 * An account's own grant (`account:<accountId>`: the seat may be called into a side room from a
 * room that account holds) is the account's, made at the relay from its personal workspace, not
 * minted here. The runner keeps the account ids its last sync was told of (`GrantsResult.accounts`,
 * `noteAccounts`) and takes a call job only for one of them (`checkCall`): a relay can call the seat
 * in for no account it did not name at the sync, which the seat's own team made it.
 *
 * Wire shapes (`GrantsInput`, `GrantsResult`, `LinkInput`, `DispatchGrant`, `DispatchRoom`) are
 * `@parley/shared/runner`'s, re-exported here for the runner's own callers.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ACCOUNT_ID,
  accountPrincipal,
  DispatchCall,
  DispatchGrant,
  type DispatchRoom,
  GRANT_PRINCIPAL,
  GRANT_TOKEN,
  GRANT_TOKEN_PREFIX,
  type GrantEntry,
  GRANTS_PER_SEAT,
  GrantsInput,
  type GrantsResult,
  LinkInput,
  type RunnerReason,
  SEAT_LABEL,
} from '@parley/shared/runner';
import { preparePrivateFile } from './store.js';

export { DispatchGrant, type DispatchRoom, GRANT_PRINCIPAL, GRANT_TOKEN, GRANT_TOKEN_PREFIX, type GrantEntry, GRANTS_PER_SEAT, GrantsInput, type GrantsResult, LinkInput };

// ---------------------------------------------------------------- tokens and principals

export const newGrantToken = (): string => `${GRANT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
export const grantHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** The project a `project:<id>` principal names, or null for a team's. */
export const projectOf = (principal: string): string | null => (principal.startsWith('project:') ? principal.slice('project:'.length) : null);

// ---------------------------------------------------------------- the book

interface BookEntry {
  principal: string;
  hash: string;
  createdAt: string;
  /** The relay answered it live. A grant never uploaded is minted again: its token was never kept. */
  uploaded: boolean;
}
/** `accounts`: by seat label, the account ids the relay last said hold a live grant to it. Absent in a book from before account calls. */
type BookFile = { v: 1; seats: Record<string, BookEntry[]>; accounts?: Record<string, string[]> };

/** Why a dispatch's grant was refused, for the log. Never the token. */
export type GrantRefusal = 'no_grant' | 'bad_grant' | 'unknown_grant' | 'wrong_project' | 'wrong_team' | 'room_unknown' | 'ask_links_off';

export type GrantVerdict = { ok: true; principal: string | null } | { ok: false; why: GrantRefusal; reason: RunnerReason };

/** The `RunnerReason` a refused grant is reported with: the credential this job carries is not one this runner minted for that seat and room. */
export const GRANT_REFUSED_REASON: RunnerReason = 'grant_refused';

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * The grants this runner minted, by seat label, as hashes. Kept in `<home>/grants.json` (0600,
 * made before it is written, like runner.db), written whole and renamed into place, so a crash
 * mid-write never leaves half a file. In memory only when `file` is null (tests).
 */
export class GrantBook {
  private seats: Record<string, BookEntry[]>;
  private accountsBySeat: Record<string, string[]>;

  private constructor(
    private readonly file: string | null,
    seats: Record<string, BookEntry[]>,
    private readonly now: () => number,
    accounts: Record<string, string[]> = Object.create(null),
  ) {
    this.seats = seats;
    this.accountsBySeat = accounts;
  }

  static fileIn(home: string): string {
    return path.join(home, 'grants.json');
  }

  /** The book at `file`, or an empty one. A file that does not parse is read as holding nothing: every grant is minted again. */
  static open(file: string | null, o: { now?: () => number } = {}): GrantBook {
    let seats: Record<string, BookEntry[]> = Object.create(null);
    let accounts: Record<string, string[]> = Object.create(null);
    if (file) {
      preparePrivateFile(file);
      try {
        const raw = readFileSync(file, 'utf8');
        const parsed = raw.trim() ? (JSON.parse(raw) as BookFile) : null;
        if (parsed?.v === 1 && parsed.seats && typeof parsed.seats === 'object') {
          seats = sanitise(parsed.seats);
          if (parsed.accounts && typeof parsed.accounts === 'object') accounts = sanitiseAccounts(parsed.accounts);
        }
      } catch {
        seats = Object.create(null);
        accounts = Object.create(null);
      }
    }
    return new GrantBook(file, seats, o.now ?? Date.now, accounts);
  }

  private save() {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    preparePrivateFile(tmp);
    writeFileSync(tmp, JSON.stringify({ v: 1, seats: this.seats, accounts: this.accountsBySeat } satisfies BookFile));
    renameSync(tmp, this.file);
  }

  /** The grants a seat holds, as hashes, uploaded or not. */
  entries(label: string): readonly Readonly<BookEntry>[] {
    return this.seats[label] ?? [];
  }

  /**
   * What to upload for a seat whose policy names `principals` now: the hash of every grant the
   * relay holds already, and a fresh token for each principal that has none (or whose upload never
   * went through). The fresh tokens are returned only to be sent: the book keeps their hashes.
   * A principal the policy no longer names is dropped here, and the upload revokes it at the relay.
   */
  plan(label: string, principals: readonly string[]): GrantsInput {
    if (!SEAT_LABEL.test(label)) throw new Error('that is not a seat label');
    const wanted = [...new Set(principals)];
    for (const p of wanted) if (!GRANT_PRINCIPAL.test(p)) throw new Error(`may_ask names ${p.slice(0, 60)}, which is not project:<id> or team:<id>`);
    if (wanted.length > GRANTS_PER_SEAT) throw new Error(`a seat may hold ${GRANTS_PER_SEAT} grants; its policy names ${wanted.length}`);
    const had = new Map(this.entries(label).map((e) => [e.principal, e]));
    const next: BookEntry[] = [];
    const grants: GrantEntry[] = [];
    const at = new Date(this.now()).toISOString();
    for (const principal of wanted) {
      const e = had.get(principal);
      if (e?.uploaded) {
        next.push(e);
        grants.push({ principal, hash: e.hash });
      } else {
        const token = newGrantToken();
        next.push({ principal, hash: grantHash(token), createdAt: at, uploaded: false });
        grants.push({ principal, token });
      }
    }
    this.seats[label] = next;
    this.save();
    return { seat: label, grants };
  }

  /**
   * The relay's answer to an upload: the principals it holds are live, and those it says it does
   * not hold (`missing`) are not, so the next plan mints them again instead of sending their hash.
   */
  noteUploaded(label: string, result: Pick<GrantsResult, 'grants' | 'missing'>): void {
    const live = new Set(result.grants.map((g) => g.principal));
    const gone = new Set(result.missing ?? []);
    for (const e of this.seats[label] ?? []) {
      if (live.has(e.principal)) e.uploaded = true;
      else if (gone.has(e.principal)) e.uploaded = false;
    }
    this.save();
  }

  /** A seat taken out of the configuration: its grants go too. */
  forget(label: string): void {
    delete this.seats[label];
    delete this.accountsBySeat[label];
    this.save();
  }

  /** The accounts the relay last said may call the seat in (`GrantsResult.accounts`). */
  accounts(label: string): readonly string[] {
    return this.accountsBySeat[label] ?? [];
  }

  /**
   * The relay's word on which accounts hold a live grant to the seat, as its grants' sync answered:
   * the list replaces what was kept, so a grant the account took back goes at the next sync.
   */
  noteAccounts(label: string, accountIds: readonly string[]): void {
    if (!SEAT_LABEL.test(label)) return;
    const ids = [...new Set(accountIds.filter((a) => typeof a === 'string' && ACCOUNT_ID.test(a)))].sort();
    if (ids.length) this.accountsBySeat[label] = ids;
    else delete this.accountsBySeat[label];
    this.save();
  }

  /**
   * Whether a call job for `label` may start, as far as grants go: the call is well formed and names
   * an account the relay said, at the seat's last sync, holds a live grant to it.
   */
  checkCall(label: string, call: unknown): GrantVerdict {
    const c = DispatchCall.safeParse(call);
    if (!c.success) return { ok: false, why: 'bad_grant', reason: GRANT_REFUSED_REASON };
    if (!this.accounts(label).includes(c.data.accountId)) return { ok: false, why: 'no_grant', reason: GRANT_REFUSED_REASON };
    return { ok: true, principal: accountPrincipal(c.data.accountId) };
  }

  /**
   * Whether a job for `label` may start, as far as grants go:
   * - with no grant, only when the seat's policy takes ask links (`may_ask.ask_links`, on unless
   *   it says false): the job came from an ask on its own link, which the dispatch check proves;
   * - with a grant, only when it is well formed, this runner minted it for this seat and this very
   *   principal (its token's hash compared in constant time), the relay answered it live, and the
   *   seat page puts the room in the project (or the team) the grant names. A room whose project or
   *   team the caller does not know (`room` absent, or null where the grant needs it) is refused:
   *   the grant's own principal is the relay's word too, so it can never stand in for the room's.
   */
  check(label: string, grant: unknown, o: { askLinks?: boolean; room?: DispatchRoom } = {}): GrantVerdict {
    if (grant === undefined || grant === null) {
      return o.askLinks === false ? { ok: false, why: 'ask_links_off', reason: GRANT_REFUSED_REASON } : { ok: true, principal: null };
    }
    const g = DispatchGrant.safeParse(grant);
    if (!g.success) return { ok: false, why: 'bad_grant', reason: GRANT_REFUSED_REASON };
    const entry = this.entries(label).find((e) => e.principal === g.data.principal && e.uploaded);
    if (!entry) return { ok: false, why: 'no_grant', reason: GRANT_REFUSED_REASON };
    if (!sameHash(grantHash(g.data.token), entry.hash)) return { ok: false, why: 'unknown_grant', reason: GRANT_REFUSED_REASON };
    const project = projectOf(g.data.principal);
    const team = project === null ? g.data.principal.slice('team:'.length) : null;
    const where = project !== null ? o.room?.project : o.room?.team;
    if (where === undefined || where === null) return { ok: false, why: 'room_unknown', reason: GRANT_REFUSED_REASON };
    if (project !== null && where !== project) return { ok: false, why: 'wrong_project', reason: GRANT_REFUSED_REASON };
    if (team !== null && where !== team) return { ok: false, why: 'wrong_team', reason: GRANT_REFUSED_REASON };
    return { ok: true, principal: g.data.principal };
  }
}

/** Only well-formed account ids under well-formed labels survive a file someone edited. */
function sanitiseAccounts(raw: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = Object.create(null);
  for (const [label, list] of Object.entries(raw)) {
    if (!SEAT_LABEL.test(label) || !Array.isArray(list)) continue;
    const ids = list.filter((a): a is string => typeof a === 'string' && ACCOUNT_ID.test(a));
    if (ids.length) out[label] = ids;
  }
  return out;
}

/** Only well-formed entries survive a file someone edited. */
function sanitise(raw: Record<string, unknown>): Record<string, BookEntry[]> {
  const out: Record<string, BookEntry[]> = Object.create(null);
  for (const [label, list] of Object.entries(raw)) {
    if (!SEAT_LABEL.test(label) || !Array.isArray(list)) continue;
    out[label] = list.filter(
      (e): e is BookEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as BookEntry).principal === 'string' &&
        GRANT_PRINCIPAL.test((e as BookEntry).principal) &&
        typeof (e as BookEntry).hash === 'string' &&
        /^[0-9a-f]{64}$/.test((e as BookEntry).hash) &&
        typeof (e as BookEntry).uploaded === 'boolean',
    );
  }
  return out;
}

/**
 * One seat's grants synced with its relay: plan, upload, note. `upload` is the relay client's call
 * (`POST /api/runner/grants`, in runner/client.ts); an upload that fails
 * leaves the fresh grants un-uploaded, so the next sync mints them again rather than send a hash
 * the relay never heard of. A grant the relay says it does not hold (`missing`: the seat was
 * declared anew under a new runner, say, with this book kept) is minted again and sent at once, so
 * a stale book never holds a seat's grants back.
 */
export async function syncGrants(
  book: GrantBook,
  label: string,
  principals: readonly string[],
  upload: (input: GrantsInput) => Promise<GrantsResult>,
): Promise<GrantsResult> {
  let result = await upload(book.plan(label, principals));
  book.noteUploaded(label, result);
  if (result.missing?.length) {
    result = await upload(book.plan(label, principals));
    book.noteUploaded(label, result);
  }
  // A relay that reads account calls says which accounts may call the seat; one that does not, nothing.
  if (result.accounts !== undefined) book.noteAccounts(label, result.accounts);
  return result;
}
