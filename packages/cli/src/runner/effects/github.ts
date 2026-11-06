/**
 * The runner's GitHub App: registered from a manifest by
 * `crossroom runner github setup` (commands/runner-github.ts), kept in `effects.db`, and used for
 * three effects, a pull request comment, a check run and an issue, and for the poll that reports
 * pull requests to the relay.
 *
 * - **The App's own credential never leaves the runner.** Its PEM signs a JWT (RS256, ten minutes
 *   at most, as GitHub allows) in this process; the JWT is exchanged for an installation token
 *   scoped to the one repository and the one permission the call needs, cached until five minutes
 *   before it expires, in memory only.
 * - **Nothing posted acts on GitHub** (`inertForGithub`): no mention notifies, no reference links
 *   another issue, and no link hides its address, since nobody reads an automated post first.
 * - **Every post carries its marker** (`<!-- parley-effect:<id> -->`, or the check run's
 *   `external_id`), and the effects loop looks for a post that may have landed before (`find`)
 *   before it posts again, so an effect handed over twice is posted once.
 * - **The manifest asks for what the effects need and no more:** pull requests and checks to
 *   write, contents and metadata to read, issues only when asked, no webhook (the runner polls, and
 *   stays outbound only).
 */
import { createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import { callJson, EffectHttpError, type FetchLike, seg, serviceBase } from './http.js';
import type { GithubApp } from './store.js';
import { type EffectPayload, effectMarker } from './wire.js';

export const GITHUB_WEB = 'https://github.com';
export const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
/** GitHub allows an App JWT ten minutes; this asks for nine, back-dated one for clock drift. */
const JWT_SECONDS = 540;
const TOKEN_MARGIN_MS = 5 * 60_000;
/** Pages of comments, check runs or issues looked through for a marker before an effect is posted again. */
const RECOVERY_PAGES = 10;
/** Pages of 100 open pull requests the poll's first pass over a repository reads. */
const PULL_PAGES = 20;
/** The most files a pull request's list gives (GitHub's own cap), and the longest path kept. */
export const PULL_FILES_MAX = 3000;
export const PULL_FILE_PATH_MAX = 500;

/** The web and API bases for GitHub, or a GitHub Enterprise Server at `web` (`<web>/api/v3`). */
export function githubBases(o: { web?: string; api?: string } = {}): { web: string; api: string } {
  const web = serviceBase(o.web ?? GITHUB_WEB, 'The GitHub address');
  const api = serviceBase(o.api ?? (web === GITHUB_WEB ? GITHUB_API : `${web}/api/v3`), "GitHub's API address");
  return { web, api };
}

// ---------------------------------------------------------------- the manifest

export interface ManifestOptions {
  /** The App's name on GitHub: unique there, at most 34 characters. */
  name: string;
  /** Its homepage: the relay the runner answers for. */
  url: string;
  /** `http://127.0.0.1:<port>/github/callback`, where setup waits for GitHub's redirect. */
  redirectUrl: string;
  /** Ask for issues: write too, for `issue` effects. */
  issues?: boolean;
}

/** The manifest `crossroom runner github setup` posts to GitHub (docs: "Registering a GitHub App from a manifest"). */
export function githubManifest(o: ManifestOptions) {
  return {
    name: o.name.slice(0, 34),
    url: o.url,
    description: "Posts a Crossroom runner's effects: pull request comments and check runs a team's playbooks ask for.",
    public: false,
    redirect_url: o.redirectUrl,
    // The runner polls; GitHub sends it nothing, and it listens for nothing.
    hook_attributes: { url: o.url, active: false },
    default_permissions: {
      pull_requests: 'write',
      checks: 'write',
      contents: 'read',
      metadata: 'read',
      ...(o.issues ? { issues: 'write' } : {}),
    },
    default_events: [],
  };
}

/** Where setup's page sends the manifest: an organisation's new-App page, or the signed-in user's. */
export function manifestAction(web: string, owner: string | null, state: string): string {
  const base = owner ? `${web}/organizations/${seg(owner)}/settings/apps/new` : `${web}/settings/apps/new`;
  return `${base}?state=${seg(state)}`;
}

const Conversion = z.looseObject({
  id: z.number().int().positive(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  owner: z.looseObject({ login: z.string().min(1).max(100) }),
  html_url: z.string().url(),
  client_id: z.string().min(1).max(200),
  client_secret: z.string().min(1).max(500),
  webhook_secret: z.string().max(500).nullable().optional(),
  pem: z.string().includes('PRIVATE KEY'),
});

/** `POST /app-manifests/{code}/conversions`: the App GitHub made from the manifest, with its PEM and secrets. */
export async function convertManifest(o: { fetch: FetchLike; api: string; code: string }): Promise<Omit<GithubApp, 'createdAt'>> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(o.code)) throw new EffectHttpError('rejected', 0, 'that is not a manifest code GitHub gives', false);
  const res = await callJson({
    fetch: o.fetch,
    method: 'POST',
    url: `${o.api}/app-manifests/${seg(o.code)}/conversions`,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': API_VERSION, 'user-agent': 'parley-runner' },
    what: 'exchanging the manifest code',
    secrets: [o.code],
  });
  const r = Conversion.safeParse(res.json);
  if (!r.success) throw new EffectHttpError('rejected', res.status, "GitHub's answer is not an App", false);
  const a = r.data;
  // The PEM must be a key this runner can sign with, or every effect would fail later.
  createPrivateKey(a.pem);
  return {
    appId: a.id,
    slug: a.slug,
    name: a.name,
    owner: a.owner.login,
    htmlUrl: a.html_url,
    api: o.api,
    clientId: a.client_id,
    clientSecret: a.client_secret,
    webhookSecret: a.webhook_secret ?? null,
    pem: a.pem,
  };
}

// ---------------------------------------------------------------- the App at work

const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/**
 * A zero-width space, as the entity GitHub decodes, so no invisible character is in this file. The
 * passes below put `&ZW;` in its place, which escaped text cannot hold (every `&` in it is `&amp;`
 * by then) and which no pass matches, and the entity goes in last: its own `#8` is a reference.
 */
const ZW = '&ZW;';
const ZW_ENTITY = '&#8203;';

/**
 * An effect's text as GitHub is given it: still markdown, but nothing in it acts. A digest holds
 * participants' words, which `inline` and `quote` keep from forging a section, and which the owner
 * read before a manual "Copy as PR comment". Nobody reads an automated post first, and GitHub acts
 * on what it renders, under the App's name:
 * - `@user` and `@org/team` notify: a zero-width space after every `@` before a letter or digit;
 * - `#12`, `owner/repo#12`, `GH-12` and an issue's or pull request's URL put a "mentioned this"
 *   entry in that issue's timeline, another repository's included: the same space breaks each;
 * - a link or an image shows words or a picture of the writer's choosing: `[text](url)` becomes
 *   `text (url)`, so the address shows, and any `](`, `][` or `]:` left (nested brackets, reference
 *   links and their definitions) is broken;
 * - raw HTML (`<a href>`, `<img>`) is escaped, and so is every `&`, since `&#64;` is an `@` to
 *   GitHub and `&#35;` a `#`. An HTML comment is left, as it acts on nothing.
 * Crossroom's own words hold none of these but the room's link, which keeps its address. A code span
 * shows the escapes as they are: harmless, and the digest's only spans are Crossroom's.
 */
export function inertForGithub(md: string): string {
  return md
    .replace(/&/g, '&amp;')
    .replace(/<(?=[A-Za-z/])/g, '&lt;')
    .replace(/!?\[([^[\]\n]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/g, '$1 ($2)')
    .replace(/\](?=[([:])/g, `]${ZW}`)
    .replace(/\b(https?):\/\/(?=[^\s/]+\/[^\s/]+\/[^\s/]+\/(?:issues|pull|pulls|discussions)\/\d)/gi, `$1:${ZW}//`)
    .replace(/@(?=[A-Za-z0-9])/g, `@${ZW}`)
    .replace(/#(?=\d)/g, `#${ZW}`)
    .replace(/\b(gh)-(?=\d)/gi, `$1${ZW}-`)
    .replaceAll(ZW, ZW_ENTITY);
}

/** An App JWT (RS256): `iss` the App's id, issued a minute back, for `JWT_SECONDS`. */
export function appJwt(app: Pick<GithubApp, 'appId' | 'pem'>, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iat, exp: iat + 60 + JWT_SECONDS, iss: String(app.appId) }));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), createPrivateKey(app.pem));
  return `${head}.${body}.${b64u(sig)}`;
}

/** The one permission each use of an installation token needs. */
export type Permission = { pull_requests: 'write' } | { pull_requests: 'read' } | { checks: 'write' } | { issues: 'write' } | { issues: 'read' };

export interface PullSummary {
  number: number;
  title: string;
  body: string;
  author: string;
  headSha: string;
  headRef: string;
  baseRef: string;
}

export interface GithubOptions {
  fetch: FetchLike;
  /** The App, as `effects.db` holds it now; null until `crossroom runner github setup` has run. */
  app: () => GithubApp | null;
  now?: () => number;
}

export class GithubEffects {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly now: () => number;

  constructor(private readonly o: GithubOptions) {
    this.now = o.now ?? Date.now;
  }

  private mustApp(): GithubApp {
    const app = this.o.app();
    if (!app) throw new EffectHttpError('not_configured', 0, 'this runner has no GitHub App: run `crossroom runner github setup`', false);
    return app;
  }

  /** Every credential in play, for scrubbing: the App's secrets and the installation tokens held. */
  secrets(): string[] {
    const app = this.o.app();
    return [...(app ? [app.pem, app.clientSecret, app.webhookSecret ?? ''] : []), ...[...this.tokens.values()].map((t) => t.token)].filter(Boolean);
  }

  private headers(bearer: string): Record<string, string> {
    return { accept: 'application/vnd.github+json', 'x-github-api-version': API_VERSION, 'user-agent': 'parley-runner', authorization: `Bearer ${bearer}` };
  }

  private async call(method: 'GET' | 'POST', url: string, bearer: string, what: string, body?: unknown) {
    return await callJson({ fetch: this.o.fetch, method, url, headers: this.headers(bearer), body, what, secrets: [bearer, ...this.secrets()] });
  }

  /** A token for one repository and one permission, from the App's installation on it. */
  async installationToken(repo: string, permission: Permission): Promise<string> {
    const app = this.mustApp();
    const key = `${app.appId}|${repo.toLowerCase()}|${JSON.stringify(permission)}`;
    const held = this.tokens.get(key);
    if (held && held.expiresAt - this.now() > TOKEN_MARGIN_MS) return held.token;
    const [owner, name] = repo.split('/') as [string, string];
    const jwt = appJwt(app, this.now());
    const inst = await this.call('GET', `${app.api}/repos/${seg(owner)}/${seg(name)}/installation`, jwt, `finding the App's installation on ${repo}`);
    const id = (inst.json as { id?: unknown } | null)?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) throw new EffectHttpError('not_found', inst.status, `the App is not installed on ${repo}`, false);
    const tok = await this.call('POST', `${app.api}/app/installations/${seg(id)}/access_tokens`, jwt, `an installation token for ${repo}`, {
      repositories: [name],
      permissions: permission,
    });
    const t = tok.json as { token?: unknown; expires_at?: unknown } | null;
    if (typeof t?.token !== 'string' || !t.token) throw new EffectHttpError('rejected', tok.status, 'GitHub answered no installation token', false);
    const expiresAt = typeof t.expires_at === 'string' ? Date.parse(t.expires_at) : Number.NaN;
    this.tokens.set(key, { token: t.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.now() + 30 * 60_000 });
    return t.token;
  }

  private repoUrl(app: GithubApp, repo: string) {
    const [owner, name] = repo.split('/') as [string, string];
    return `${app.api}/repos/${seg(owner)}/${seg(name)}`;
  }

  /** Each page of a list, until `found` says what it was looking for is there, or the pages run out. */
  private async search<T>(url: (page: number) => string, token: string, what: string, found: (items: unknown[]) => T | null): Promise<T | null> {
    for (let page = 1; page <= RECOVERY_PAGES; page++) {
      const res = await this.call('GET', url(page), token, what);
      const items = Array.isArray(res.json) ? res.json : Array.isArray((res.json as any)?.check_runs) ? (res.json as any).check_runs : [];
      const hit = found(items);
      if (hit !== null) return hit;
      if (items.length < 100) return null;
    }
    return null;
  }

  private notGithub(p: EffectPayload): never {
    throw new EffectHttpError('kind_off', 0, `${p.kind} is not a GitHub effect`, false);
  }

  /**
   * This effect's post, if an earlier attempt made it: a comment or an issue carrying its marker,
   * or a check run whose `external_id` is the effect's id. Its id, or null. Reads only.
   */
  async find(p: EffectPayload): Promise<string | null> {
    const app = this.mustApp();
    if (p.kind === 'pr_comment') {
      const token = await this.installationToken(p.target.repo, { pull_requests: 'write' });
      const base = `${this.repoUrl(app, p.target.repo)}/issues/${seg(p.target.number)}/comments`;
      const marker = effectMarker(p.effectId);
      return await this.search((page) => `${base}?per_page=100&page=${page}`, token, 'looking for the comment posted before', (items) => {
        const c = items.find((i: any) => typeof i?.body === 'string' && i.body.includes(marker)) as any;
        return c ? String(c.id) : null;
      });
    }
    if (p.kind === 'check_run') {
      const token = await this.installationToken(p.target.repo, { checks: 'write' });
      // Still "Parley": a repository's branch protection may require a check by this name.
      const name = `Parley: ${p.playbook}`;
      return await this.search(
        (page) => `${this.repoUrl(app, p.target.repo)}/commits/${seg(p.target.sha)}/check-runs?check_name=${seg(name)}&filter=all&per_page=100&page=${page}`,
        token,
        'looking for the check run posted before',
        (items) => {
          const c = items.find((i: any) => i?.external_id === p.effectId) as any;
          return c ? String(c.id) : null;
        },
      );
    }
    if (p.kind === 'issue') {
      const token = await this.installationToken(p.target.repo, { issues: 'write' });
      const creator = seg(`${app.slug}[bot]`);
      const marker = effectMarker(p.effectId);
      return await this.search(
        (page) => `${this.repoUrl(app, p.target.repo)}/issues?state=all&creator=${creator}&sort=created&direction=desc&per_page=100&page=${page}`,
        token,
        'looking for the issue opened before',
        (items) => {
          const c = items.find((i: any) => typeof i?.body === 'string' && i.body.includes(marker)) as any;
          return c ? String(c.number ?? c.id) : null;
        },
      );
    }
    return this.notGithub(p);
  }

  /** Post the effect, carrying its marker. Answers GitHub's id for what was posted. */
  async post(p: EffectPayload): Promise<string | null> {
    const app = this.mustApp();
    if (p.kind === 'pr_comment') {
      const token = await this.installationToken(p.target.repo, { pull_requests: 'write' });
      const res = await this.call('POST', `${this.repoUrl(app, p.target.repo)}/issues/${seg(p.target.number)}/comments`, token, 'posting a PR comment', {
        body: `${inertForGithub(p.text)}\n\n${effectMarker(p.effectId)}`,
      });
      return idOf(res.json);
    }
    if (p.kind === 'check_run') {
      const token = await this.installationToken(p.target.repo, { checks: 'write' });
      const conclusion = p.verdict === 'fail' ? 'failure' : p.verdict === 'pass' ? 'success' : 'neutral';
      const res = await this.call('POST', `${this.repoUrl(app, p.target.repo)}/check-runs`, token, 'posting a check run', {
        name: `Parley: ${p.playbook}`,
        head_sha: p.target.sha,
        status: 'completed',
        conclusion,
        external_id: p.effectId,
        output: { title: p.title, summary: inertForGithub(p.text) },
      });
      return idOf(res.json);
    }
    if (p.kind === 'issue') {
      const token = await this.installationToken(p.target.repo, { issues: 'write' });
      const res = await this.call('POST', `${this.repoUrl(app, p.target.repo)}/issues`, token, 'opening an issue', { title: p.title, body: `${inertForGithub(p.text)}\n\n${effectMarker(p.effectId)}` });
      const n = (res.json as { number?: unknown } | null)?.number;
      return typeof n === 'number' ? String(n) : idOf(res.json);
    }
    return this.notGithub(p);
  }

  /**
   * The open pull requests of a repository, most recently updated first: what the poll reports.
   * `all` pages through every one (up to `PULL_PAGES` pages of 100), which the poll's first pass
   * over a repository needs, so a pull request open all along is never reported when it is next
   * touched; later passes read the first page only, where anything new or updated comes first.
   */
  async openPulls(repo: string, o: { all?: boolean } = {}): Promise<PullSummary[]> {
    const app = this.mustApp();
    const token = await this.installationToken(repo, { pull_requests: 'read' });
    const out: PullSummary[] = [];
    const per = o.all ? 100 : 30;
    for (let page = 1; page <= (o.all ? PULL_PAGES : 1); page++) {
      const res = await this.call('GET', `${this.repoUrl(app, repo)}/pulls?state=open&sort=updated&direction=desc&per_page=${per}&page=${page}`, token, `listing ${repo}'s pull requests`);
      if (!Array.isArray(res.json)) break;
      for (const pr of res.json as any[]) {
        if (typeof pr?.number !== 'number' || typeof pr?.head?.sha !== 'string') continue;
        out.push({
          number: pr.number,
          title: typeof pr.title === 'string' ? pr.title : '',
          body: typeof pr.body === 'string' ? pr.body : '',
          author: typeof pr.user?.login === 'string' ? pr.user.login : '',
          headSha: pr.head.sha,
          headRef: typeof pr.head.ref === 'string' ? pr.head.ref : '',
          baseRef: typeof pr.base?.ref === 'string' ? pr.base.ref : '',
        });
      }
      if (res.json.length < per) break;
    }
    return out;
  }

  /**
   * The paths a pull request changes (`GET /repos/{repo}/pulls/{n}/files`), for the relay's
   * `on: runner` triggers that filter on paths: at most `PULL_FILES_MAX`, as GitHub lists
   * them, and none longer than `PULL_FILE_PATH_MAX`. A renamed file counts under its old name too.
   */
  async pullFiles(repo: string, number: number): Promise<string[]> {
    const app = this.mustApp();
    const token = await this.installationToken(repo, { pull_requests: 'read' });
    const out = new Set<string>();
    const per = 100;
    for (let page = 1; page <= PULL_FILES_MAX / per; page++) {
      const res = await this.call('GET', `${this.repoUrl(app, repo)}/pulls/${seg(number)}/files?per_page=${per}&page=${page}`, token, `listing pull request ${number}'s files`);
      if (!Array.isArray(res.json)) break;
      for (const f of res.json as any[])
        for (const name of [f?.filename, f?.previous_filename])
          if (typeof name === 'string' && name.length > 0 && name.length <= PULL_FILE_PATH_MAX && out.size < PULL_FILES_MAX) out.add(name);
      if (res.json.length < per) break;
    }
    return [...out];
  }
}

function idOf(json: unknown): string | null {
  const id = (json as { id?: unknown } | null)?.id;
  return typeof id === 'number' || typeof id === 'string' ? String(id) : null;
}
