/**
 * `crossroom runner github setup [--org <owner>] [--port <n>]`: a GitHub App for this runner's
 * effects (effects run only on runners), registered from a manifest.
 *
 * 1. A page on `127.0.0.1:<port>` (any free port unless `--port` names one) form-POSTs the
 *    manifest to `https://github.com/organizations/<org>/settings/apps/new?state=<random>`, or to
 *    the signed-in user's `settings/apps/new` without `--org`: `{name, url, public: false,
 *    default_permissions: {pull_requests: write, checks: write, contents: read, metadata: read},
 *    redirect_url: http://127.0.0.1:<port>/github/callback, hook_attributes: {active: false}}`,
 *    and `issues: write` with `--issues`.
 * 2. The callback checks `state` (in constant time, once), then `POST /app-manifests/{code}/conversions`
 *    returns the App's id, PEM and secrets, which go into `effects.db` (0600) beside `runner.db`,
 *    never to the relay and never to the terminal.
 * 3. The runner then signs an RS256 App JWT for installation tokens, polls pull requests every
 *    60 s, and posts effects only after checking each against `effects.yml` (runner/effects/). It
 *    stays outbound only.
 *
 * Also `crossroom runner github status` (what App this runner has, never its secrets) and
 * `crossroom runner github forget` (the PEM and secrets overwritten in the file). `--github <url>`
 * and `--api <url>` name a GitHub Enterprise Server (its API is `<url>/api/v3` unless `--api`
 * says otherwise); the page's server answers only on the loopback, to a Host of its own.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { type Args, text, Usage } from '../cli.js';
import { loadConfig, runnerHome } from '../runner/config.js';
import { convertManifest, githubBases, githubManifest, manifestAction } from '../runner/effects/github.js';
import type { FetchLike } from '../runner/effects/http.js';
import { EffectsStore, effectsDbPath } from '../runner/effects/store.js';

/** What a test puts in place of the network and the clock (`wireGithubSetup`). */
export interface GithubSetupDeps {
  fetch?: FetchLike;
  /** How long setup waits for GitHub's redirect before giving up. Ten minutes by default. */
  timeoutMs?: number;
  /** Called with the page's address once it is listening (a test opens it). */
  listening?: (url: string) => void;
}
let deps: GithubSetupDeps = {};
/** Put stand-ins in place (tests); `{}` puts the real ones back. */
export function wireGithubSetup(d: GithubSetupDeps): void {
  deps = d;
}

/**
 * The relay `crossroom runner init` uses when none is named (commands/runner.ts `DEFAULT_RELAY`), as
 * the App's homepage. Written out, not imported: runner.ts imports this module, so its constant is
 * not set yet while this one loads.
 */
const FALLBACK_HOMEPAGE = 'https://app.crossroom.dev';
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function page(title: string, body: string, extra: Record<string, string> = {}) {
  return {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
    body: `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem">${body}</body></html>`,
  };
}

/**
 * A yes/no flag. `--issues` and `--replace` are switches of the runner command (commands/runner.ts),
 * so each stands alone; `--issues=1` and `--issues=no` still read as written.
 */
const on = (v: string | true | undefined) => v === true || (typeof v === 'string' && !/^(0|false|no|off)$/i.test(v.trim()));

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function setup(args: Args, say: (line: string) => void): Promise<number> {
  const home = runnerHome();
  const owner = text(args.flags.org) ?? null;
  if (owner !== null && !OWNER.test(owner)) throw new Usage('--org names a GitHub organisation, such as acme.');
  let bases: { web: string; api: string };
  try {
    bases = githubBases({ ...(text(args.flags.github) ? { web: text(args.flags.github)! } : {}), ...(text(args.flags.api) ? { api: text(args.flags.api)! } : {}) });
  } catch (e) {
    throw new Usage((e as Error).message);
  }
  const portFlag = text(args.flags.port);
  const port = portFlag === undefined ? 0 : Number(portFlag);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Usage('--port is a port number.');
  let homepage = FALLBACK_HOMEPAGE;
  try {
    homepage = loadConfig(home)?.relay ?? FALLBACK_HOMEPAGE;
  } catch {
    // A runner.yml that does not check says nothing about the App's homepage.
  }
  const name = (text(args.flags.name) ?? `Crossroom runner ${loadName(home)}`).slice(0, 34);

  const store = EffectsStore.open(effectsDbPath(home));
  try {
    const had = store.githubApp();
    if (had && !on(args.flags.replace)) {
      say(`This runner has a GitHub App already: ${had.slug} (id ${had.appId}, ${had.owner}). \`crossroom runner github forget\` first, or pass --replace.`);
      return 1;
    }
    const state = randomBytes(24).toString('base64url');
    const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
    let settle!: (r: { ok: true; slug: string; appId: number; owner: string; htmlUrl: string } | { ok: false; why: string }) => void;
    const outcome = new Promise<Parameters<typeof settle>[0]>((resolve) => {
      settle = resolve;
    });
    let used = false;
    let bound = 0;
    const server = http.createServer((req, res) => {
      const send = (status: number, p: { headers: Record<string, string>; body: string }) => {
        res.writeHead(status, p.headers);
        res.end(p.body);
      };
      // Only this machine, and only under the address this setup printed: another page's script
      // reaching it through a name that resolves here (DNS rebinding) sends another Host.
      const host = String(req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${bound}` && host !== `localhost:${bound}`) return send(421, page('Crossroom', '<p>Not this address.</p>'));
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${bound}`);
      if (req.method !== 'GET') return send(405, page('Crossroom', '<p>Nothing to post here.</p>'));
      if (url.pathname === '/') {
        if (used) return send(410, page('Crossroom', '<p>This setup is finished. Run it again for another App.</p>'));
        const manifest = githubManifest({ name, url: homepage, redirectUrl: `http://127.0.0.1:${bound}/github/callback`, issues: on(args.flags.issues) });
        const action = manifestAction(bases.web, owner, state);
        return send(
          200,
          page(
            'Crossroom: register the GitHub App',
            `<h1>Register this runner's GitHub App</h1><p>GitHub opens with the App filled in. Check it, then create it${owner ? ` for ${esc(owner)}` : ''}.</p>` +
              `<form method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form>` +
              '<script>document.forms[0].submit()</script>',
            { 'content-security-policy': `default-src 'none'; script-src 'unsafe-inline'; form-action ${bases.web}; style-src 'unsafe-inline'` },
          ),
        );
      }
      if (url.pathname === '/github/callback') {
        const code = url.searchParams.get('code') ?? '';
        const given = url.searchParams.get('state') ?? '';
        if (used) return send(410, page('Crossroom', '<p>This setup is finished.</p>'));
        if (!sameSecret(given, state) || !code) return send(400, page('Crossroom', "<p>That is not GitHub's answer to this setup. Nothing was saved.</p>"));
        used = true;
        void convertManifest({ fetch: fetchFn, api: bases.api, code })
          .then((app) => {
            store.saveGithubApp(app);
            send(
              200,
              page(
                'Crossroom: GitHub App registered',
                `<h1>Registered ${esc(app.slug)}</h1><p>Install it on the repositories this runner posts to:</p><p><a href="${esc(`${app.htmlUrl}/installations/new`)}">${esc(app.htmlUrl)}/installations/new</a></p>`,
              ),
            );
            settle({ ok: true, slug: app.slug, appId: app.appId, owner: app.owner, htmlUrl: app.htmlUrl });
          })
          .catch((e: unknown) => {
            send(502, page('Crossroom', '<p>GitHub did not hand over the App. Nothing was saved; run the setup again.</p>'));
            settle({ ok: false, why: (e as Error).message });
          });
        return;
      }
      return send(404, page('Crossroom', '<p>Nothing here.</p>'));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const a = server.address();
        bound = typeof a === 'object' && a ? a.port : port;
        resolve();
      });
    });
    const local = `http://127.0.0.1:${bound}/`;
    say(`Open ${local} in a browser signed in to GitHub${owner ? ` as an owner of ${owner}` : ''}. It sends the App's manifest to GitHub; this waits for GitHub's answer.`);
    deps.listening?.(local);
    // Once GitHub has answered, the exchange runs to its end: giving up then would close the store
    // under it, and the App would exist on GitHub with its only key thrown away.
    const timer = setTimeout(() => {
      if (!used) settle({ ok: false, why: 'GitHub did not answer within ten minutes' });
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const r = await outcome;
    clearTimeout(timer);
    // Give the last page a moment to reach the browser before the server goes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A browser keeps its connection open; closing the server alone would wait for it.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    if (!r.ok) {
      say(`No GitHub App was registered: ${r.why}.`);
      return 1;
    }
    say(`Registered the GitHub App ${r.slug} (id ${r.appId}) for ${r.owner}. Its key is in ${effectsDbPath(home)}, on this machine only.`);
    say(`Install it on the repositories this runner posts to: ${r.htmlUrl}/installations/new, and list what it may post in effects.yml.`);
    return 0;
  } finally {
    store.close();
  }
}

function loadName(home: string): string {
  try {
    return loadConfig(home)?.name ?? 'runner';
  } catch {
    return 'runner';
  }
}

function status(say: (line: string) => void): number {
  const home = runnerHome();
  const store = EffectsStore.open(effectsDbPath(home));
  try {
    const app = store.githubApp();
    if (!app) {
      say('This runner has no GitHub App yet: `crossroom runner github setup [--org <owner>]`.');
      return 1;
    }
    say(`GitHub App ${app.slug} (id ${app.appId}), owned by ${app.owner}, on ${app.api}, registered ${app.createdAt}. Its key stays in ${effectsDbPath(home)}.`);
    return 0;
  } finally {
    store.close();
  }
}

function forget(say: (line: string) => void): number {
  const home = runnerHome();
  const store = EffectsStore.open(effectsDbPath(home));
  try {
    const app = store.githubApp();
    if (!store.forgetGithubApp() || !app) {
      say('This runner has no GitHub App to forget.');
      return 1;
    }
    say(`Forgot the GitHub App ${app.slug}: its key is gone from this machine. Delete the App on GitHub too, at ${app.htmlUrl}.`);
    return 0;
  } finally {
    store.close();
  }
}

export async function runnerGithub(args: Args, say: (line: string) => void): Promise<number> {
  const sub = args.positional[1];
  switch (sub) {
    case 'setup':
      return await setup(args, say);
    case 'status':
      return status(say);
    case 'forget':
      return forget(say);
    default:
      throw new Usage('`crossroom runner github` takes setup [--org <owner>], status or forget.');
  }
}
