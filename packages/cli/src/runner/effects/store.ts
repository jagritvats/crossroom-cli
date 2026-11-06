/**
 * The runner's effects store: `effects.db`, beside `runner.db` under the runner's home. Its
 * tables are the E0 step (runner/effects/migrations).
 *
 * It holds the answering team's own credentials for posting, which is why nothing in it ever goes
 * to the relay: the GitHub App's PEM, client secret and webhook secret, as
 * `crossroom runner github setup` received them from GitHub. It also holds what makes effects at
 * least once rather than twice: every effect id this runner was handed, and what it did with it.
 *
 * **Who may read it.** As runner.db: on POSIX the file is created empty with mode 0600 (its
 * directory 0700 when this makes it) before SQLite writes a byte, and `-wal` and `-shm` take the
 * file's mode. `secure_delete` is on (sqlite-open.ts), so a forgotten App's PEM is overwritten in the file,
 * not left in its free pages.
 *
 * A file of its own rather than more steps on runner.db's track: the effects loop owns
 * this track outright, and runner.db's belongs to the runner host, whose steps other parts add.
 */
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openSqlite } from '../../sqlite-open.js';
import { preparePrivateFile } from '../store.js';
import { EFFECT_STEPS } from './migrations/index.js';

export const EFFECTS_DB = 'effects.db';
export const effectsDbPath = (home: string) => path.join(home, EFFECTS_DB);

/** A GitHub App as the manifest conversion answered it (`POST /app-manifests/{code}/conversions`). */
export interface GithubApp {
  appId: number;
  slug: string;
  name: string;
  owner: string;
  htmlUrl: string;
  /** The REST API it lives on: `https://api.github.com`, or a GitHub Enterprise Server's `/api/v3`. */
  api: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string | null;
  /** The App's private key (PEM), which signs its JWTs. */
  pem: string;
  createdAt: string;
}

/**
 * What this runner did with an effect:
 * - `posting`: it started to post, and has not recorded the answer. The post may have landed, so
 *   the next attempt looks for the effect's marker before posting again.
 * - `posted`, `refused`, `failed`: done, with a code (runner/effects/wire.ts, `EffectCode`).
 */
export type SeenState = 'posting' | 'posted' | 'refused' | 'failed';

export interface SeenRow {
  effectId: string;
  kind: string;
  target: string;
  state: SeenState;
  code: string | null;
  remoteId: string | null;
  attempts: number;
  receivedAt: string;
  doneAt: string | null;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const seenOf = (r: any): SeenRow => ({
  effectId: String(r.effect_id),
  kind: String(r.kind),
  target: String(r.target),
  state: String(r.state) as SeenState,
  code: str(r.code),
  remoteId: str(r.remote_id),
  attempts: Number(r.attempts),
  receivedAt: String(r.received_at),
  doneAt: str(r.done_at),
});

const appOf = (r: any): GithubApp => ({
  appId: Number(r.app_id),
  slug: String(r.slug),
  name: String(r.name),
  owner: String(r.owner),
  htmlUrl: String(r.html_url),
  api: String(r.api),
  clientId: String(r.client_id),
  clientSecret: String(r.client_secret),
  webhookSecret: str(r.webhook_secret),
  pem: String(r.pem),
  createdAt: String(r.created_at),
});

export class EffectsStore {
  private constructor(
    readonly db: DatabaseSync,
    readonly file: string,
    private readonly now: () => number,
  ) {}

  /** Open (making it, 0600, when it is not there) the store at `file`. */
  static open(file: string, o: { now?: () => number } = {}): EffectsStore {
    if (file !== ':memory:') preparePrivateFile(file);
    return new EffectsStore(openSqlite(file, EFFECT_STEPS), file, o.now ?? Date.now);
  }

  private iso() {
    return new Date(this.now()).toISOString();
  }

  close() {
    try {
      this.db.close();
    } catch {
      // Closed already.
    }
  }

  // -------------------------------------------------------------- effects seen

  seen(effectId: string): SeenRow | null {
    const r = this.db.prepare('SELECT * FROM effects_seen WHERE effect_id = ?').get(effectId);
    return r ? seenOf(r) : null;
  }

  /**
   * About to post: the effect is `posting`, with one attempt more. Answers the row as it was before,
   * or null for an effect never seen, so the caller knows whether an earlier attempt may have
   * landed. An effect already done is left as it is.
   */
  begin(effectId: string, kind: string, target: string): SeenRow | null {
    const before = this.seen(effectId);
    if (before && before.state !== 'posting') return before;
    const at = this.iso();
    this.db
      .prepare(
        `INSERT INTO effects_seen (effect_id, kind, target, state, attempts, received_at) VALUES (?, ?, ?, 'posting', 1, ?)
         ON CONFLICT(effect_id) DO UPDATE SET attempts = attempts + 1`,
      )
      .run(effectId, kind, target, at);
    return before;
  }

  /** Done with an effect: posted, refused or failed, with its code, and the service's id for what was posted. */
  finish(effectId: string, kind: string, target: string, state: Exclude<SeenState, 'posting'>, code: string, remoteId: string | null = null) {
    const at = this.iso();
    this.db
      .prepare(
        `INSERT INTO effects_seen (effect_id, kind, target, state, code, remote_id, attempts, received_at, done_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(effect_id) DO UPDATE SET state = excluded.state, code = excluded.code, remote_id = COALESCE(excluded.remote_id, remote_id), done_at = excluded.done_at`,
      )
      .run(effectId, kind, target, state, code, remoteId, at, at);
  }

  // -------------------------------------------------------------- the GitHub App

  githubApp(): GithubApp | null {
    const r = this.db.prepare('SELECT * FROM github_app WHERE id = 1').get();
    return r ? appOf(r) : null;
  }

  saveGithubApp(app: Omit<GithubApp, 'createdAt'> & { createdAt?: string }) {
    this.db
      .prepare(
        `INSERT INTO github_app (id, app_id, slug, name, owner, html_url, api, client_id, client_secret, webhook_secret, pem, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET app_id = excluded.app_id, slug = excluded.slug, name = excluded.name, owner = excluded.owner,
           html_url = excluded.html_url, api = excluded.api, client_id = excluded.client_id, client_secret = excluded.client_secret,
           webhook_secret = excluded.webhook_secret, pem = excluded.pem, created_at = excluded.created_at`,
      )
      .run(app.appId, app.slug, app.name, app.owner, app.htmlUrl, app.api, app.clientId, app.clientSecret, app.webhookSecret, app.pem, app.createdAt ?? this.iso());
  }

  /** Forget the App: its PEM and secrets are overwritten in the file (`secure_delete`). Answers whether there was one. */
  forgetGithubApp(): boolean {
    return Number(this.db.prepare('DELETE FROM github_app WHERE id = 1').run().changes) > 0;
  }

  // -------------------------------------------------------------- pull requests the poll reported

  prSeen(repo: string, number: number, headSha: string): boolean {
    return !!this.db.prepare('SELECT 1 AS ok FROM pr_seen WHERE repo = ? AND number = ? AND head_sha = ?').get(repo.toLowerCase(), number, headSha);
  }

  notePr(repo: string, number: number, headSha: string) {
    this.db.prepare('INSERT OR IGNORE INTO pr_seen (repo, number, head_sha, seen_at) VALUES (?, ?, ?, ?)').run(repo.toLowerCase(), number, headSha, this.iso());
  }

  /**
   * Every secret this store holds, for scrubbing from anything the runner prints or reports, and for
   * the known-secret scan every job's egress check runs (`RunnerOnly.knownSecrets`): an agent whose
   * reads are not confined can read this file, whose TEXT pages are plain. The App's client and
   * webhook secrets, and its PEM in the forms a copy of it takes (`pemForms`), since the scan's
   * `private_key` pattern knows only the armoured whole. The scan adds each one's encodings.
   */
  knownSecrets(): string[] {
    const app = this.githubApp();
    if (!app) return [];
    return [...new Set([...pemForms(app.pem), app.clientSecret, ...(app.webhookSecret ? [app.webhookSecret] : [])])];
  }
}

/** A line of a PEM's body shorter than this is not looked for alone: the last line can be a few characters. */
export const PEM_LINE_MIN = 16;

/**
 * A PEM as a leak of it could read: whole; its body without the BEGIN and END lines (and any
 * `Name: value` header), on one line; and each line of its body, so a copy with the armour cut
 * off, re-wrapped or cut short is still found. Each is a secret for the known-secret scan, which
 * also looks for its base64, hex and URL encodings.
 */
export function pemForms(pem: string): string[] {
  const body = pem
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^-----(BEGIN|END) /.test(l) && !/^[A-Za-z-]+:/.test(l));
  return [...new Set([pem, body.join(''), ...body.filter((l) => l.length >= PEM_LINE_MIN)])];
}
