/**
 * What a runner does with each tracker read the relay leases it (runner/reads-wire.ts), from the
 * seal to the finish. It runs beside the effects loop (runner/effects/index.ts) on the runner's own
 * session.
 *
 * For each read, in this order, and nothing is read unless every step says yes:
 * 1. **It opens** under this runner's X25519 key, in the envelope it was leased in, and names this
 *    runner's relay. Otherwise it is refused `not_allowed`.
 * 2. **The runner has a credential for that tracker** (`not_configured` otherwise), each only from the
 *    runner's environment or `effects.db`, and each sent only to its own tracker:
 *    - GitHub: the team's GitHub App (`crossroom runner github setup`), an installation token for the
 *      one repository with Issues: Read (or Pull requests: Read for a pull request), to the App's API;
 *    - Jira: `PARLEY_JIRA_SITE`, `PARLEY_JIRA_EMAIL`, `PARLEY_JIRA_API_TOKEN`, to that site only: an
 *      item or a place on another site is `not_configured`;
 *    - Azure DevOps: `PARLEY_AZURE_DEVOPS_PAT` with `PARLEY_AZURE_DEVOPS_ORG`, to `https://dev.azure.com`
 *      (`PARLEY_AZURE_DEVOPS_URL` for tests and proxies) and only for that organization.
 * 3. **`effects.yml` allows reading that place** (a `tracker_read` rule, `checkTrackerRead`):
 *    `not_allowed`. No file allows nothing.
 * 4. **It is read** with the shared readers (`@parley/shared/tracker-read`), the items reported in
 *    batches no larger than the relay takes, then the read finished `done`. The tracker refusing
 *    is `not_found` (no such item, or the credential can't see it) or `tracker_error`; a failure worth
 *    trying again (the tracker didn't answer, or said to slow down) leaves the read: its lease runs
 *    out and the relay hands it over again, at most `READ_MAX_ATTEMPTS` times.
 *
 * Every credential stays a `PARLEY_*` variable or `effects.db`'s, which no agent the runner starts
 * can read (`childEnv`), and every line logged goes through `redactTokens` with each one in play.
 */
import { TRACKER_REPORT_BATCH_MAX, type TrackerProvider } from '@parley/shared/trackers';
import type { ReportedImportInput } from '@parley/shared/work';
import { reportOf } from '../trackers/report.js';
import {
  isItemUrl,
  jiraProjectOf,
  normalFilter,
  parseAzureProject,
  parseGithubRepo,
  parseGithubUrl,
  parseJiraWhere,
  readItem,
  syncItems,
  TrackerAnswerError,
  type TrackerFilter,
  type TrackerIo,
  TrackerQueryError,
} from '../trackers/io.js';
import { parseAzureWorkItemUrl } from '@parley/shared/azure-devops';
import { parseJiraIssueUrl } from '@parley/shared/trackers';
import { sameRelay } from './client.js';
import type { GithubApp } from './effects/store.js';
import { callJson, EffectHttpError, type FetchLike, serviceBase } from './effects/http.js';
import { checkTrackerRead, type EffectsFile, type LoadedEffects, type ReadPlace } from './effects/policy.js';
import type { SessionCall } from './effects/relay.js';
import { openSealedText } from './effects/seal.js';
import { redactTokens } from './keys.js';
import { type LeasedRead, LeasedRead as LeasedReadSchema, type ReadFinishInput, type ReadItemsResult, ReadPayload, READ_LEASE_WAIT_S, readAad } from './reads-wire.js';

/** The Azure DevOps credential a runner reads with, from its environment. */
export interface AzureReadConfig {
  pat: string;
  /** The one organization it may go to, lower-cased. */
  org: string;
  url: string;
}

/**
 * `PARLEY_AZURE_DEVOPS_PAT` with `PARLEY_AZURE_DEVOPS_ORG` (both, or neither: a token with no
 * organization pinned is left out, so it can't be sent to an organization a read names), and
 * `PARLEY_AZURE_DEVOPS_URL` for tests. Throws with a sentence for the operator on half a setting.
 */
export function azureReadConfigFromEnv(env: NodeJS.ProcessEnv): AzureReadConfig | null {
  const pat = env.PARLEY_AZURE_DEVOPS_PAT?.trim();
  const org = env.PARLEY_AZURE_DEVOPS_ORG?.trim().toLowerCase();
  if (!pat && !org) return null;
  if (!pat || !org) throw new Error('PARLEY_AZURE_DEVOPS_PAT and PARLEY_AZURE_DEVOPS_ORG go together: the token is sent only to the organization the second names');
  if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(org)) throw new Error('PARLEY_AZURE_DEVOPS_ORG is an organization name, such as contoso');
  return { pat, org, url: serviceBase(env.PARLEY_AZURE_DEVOPS_URL?.trim() || 'https://dev.azure.com', 'PARLEY_AZURE_DEVOPS_URL') };
}

export interface TrackerReadsOptions {
  call: SessionCall;
  identity: () => { runnerId: string; relay: string; x25519Private: string } | null;
  fetch: FetchLike;
  /** `effects.yml`, read again for every read. */
  policy: () => LoadedEffects;
  /** The team's GitHub App, as `effects.db` holds it now. */
  githubApp: () => GithubApp | null;
  /** An installation token for one repository and one permission (`GithubEffects.installationToken`). */
  githubToken: (repo: string, permission: { issues: 'read' } | { pull_requests: 'read' }) => Promise<string>;
  jira: () => { site: string; email: string; token: string } | null;
  azure: () => AzureReadConfig | null;
  log: (line: string) => void;
  /** Every credential in play, for scrubbing. */
  secrets?: () => readonly string[];
}

class ReadRefusal extends Error {
  constructor(readonly finish: ReadFinishInput) {
    super(finish.state);
  }
}
const refuse = (code: 'not_configured' | 'not_allowed'): never => {
  throw new ReadRefusal({ state: 'refused', code });
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** A report's body stays well under the relay's 512 KiB: items go in chunks of at most this many bytes and `TRACKER_REPORT_BATCH_MAX` items. */
const CHUNK_BYTES = 400 * 1024;

export class TrackerReadsRunner {
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly o: TrackerReadsOptions) {}

  private secrets(extra: readonly string[] = []): string[] {
    const j = this.o.jira();
    const a = this.o.azure();
    return [...(this.o.secrets?.() ?? []), j?.token ?? '', a?.pat ?? '', ...extra].filter(Boolean);
  }

  private log(line: string, extra: readonly string[] = []) {
    this.o.log(redactTokens(line, this.secrets(extra)));
  }

  /** A getter that sends one credential to one origin and nowhere else, never following a redirect. */
  private io(base: string, headers: Record<string, string>, secrets: string[]): TrackerIo {
    const send = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      if (!path.startsWith('/')) throw new EffectHttpError('rejected', 0, 'a path that is not on the tracker', false);
      const res = await callJson({ fetch: this.o.fetch, method, url: `${base}${path}`, headers, ...(body === undefined ? {} : { body }), what: 'reading the tracker', secrets });
      return res.json;
    };
    return { get: (p) => send('GET', p), post: (p, b) => send('POST', p, b) };
  }

  /** The getter for one read, and the place its policy is checked against. Refuses what this runner may not read. */
  private async ioFor(p: ReadPayload): Promise<{ io: TrackerIo; place: ReadPlace; anyHost: boolean; secrets: string[] }> {
    const addr = (p.kind === 'item' ? p.url : p.where)!;
    if (p.provider === 'github') {
      const ref = p.kind === 'item' ? parseGithubUrl(addr) : null;
      const repo = ref?.repo ?? parseGithubRepo(addr);
      if (!repo) return refuse('not_allowed');
      const app = this.o.githubApp();
      if (!app) return refuse('not_configured');
      const token = await this.o.githubToken(repo, ref?.kind === 'pull' ? { pull_requests: 'read' } : { issues: 'read' });
      const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'parley-runner', authorization: `Bearer ${token}` };
      return { io: this.io(app.api, headers, [token]), place: { provider: 'github', repo }, anyHost: false, secrets: [token] };
    }
    if (p.provider === 'azure') {
      const at = p.kind === 'item' ? parseAzureWorkItemUrl(addr) : parseAzureProject(addr);
      if (!at) return refuse('not_allowed');
      const c = this.o.azure();
      if (!c || c.org !== at.org.toLowerCase()) return refuse('not_configured');
      const auth = `Basic ${Buffer.from(`:${c.pat}`).toString('base64')}`;
      const headers = { accept: 'application/json', 'user-agent': 'parley-runner', 'x-tfs-fedauthredirect': 'Suppress', authorization: auth };
      return { io: this.io(c.url, headers, [c.pat, auth]), place: { provider: 'azure', org: at.org, project: at.project }, anyHost: false, secrets: [c.pat, auth] };
    }
    const c = this.o.jira();
    const item = p.kind === 'item' ? parseJiraIssueUrl(addr, { anyHost: true }) : null;
    const where = p.kind === 'sync' ? parseJiraWhere(addr, { anyHost: true }) : null;
    const site = item?.site ?? where?.site;
    if (!site) return refuse('not_allowed');
    if (!c || new URL(c.site).hostname !== new URL(site).hostname) return refuse('not_configured');
    const auth = `Basic ${Buffer.from(`${c.email}:${c.token}`).toString('base64')}`;
    // The site the operator named, whatever host the address spelt (a test points it at the loopback).
    const io = this.io(c.site, { accept: 'application/json', 'user-agent': 'parley-runner', authorization: auth }, [c.token, auth]);
    let project = item ? item.key.slice(0, item.key.lastIndexOf('-')) : where!.project;
    if (!project && where?.board != null) project = await jiraProjectOf(io, where);
    if (!project) return refuse('not_allowed');
    return { io, place: { provider: 'jira', project }, anyHost: true, secrets: [c.token, auth] };
  }

  /** Read one leased read and report it. Answers what it finished with, or null when it was left for another lease. */
  async handle(leased: LeasedRead): Promise<ReadFinishInput | null> {
    const me = this.o.identity();
    if (!me) return null;
    let p: ReadPayload;
    try {
      const text = openSealedText(leased.payload, me.x25519Private, readAad(me.runnerId, leased.id, leased.kind), (why) => new Error(why), 'a read');
      p = ReadPayload.parse(JSON.parse(text));
      if (p.readId !== leased.id || p.runnerId !== me.runnerId || p.kind !== leased.kind || !sameRelay(p.relay, me.relay)) throw new Error('not its envelope');
    } catch (e) {
      this.log(`Read ${leased.id}: it does not open here (${String((e as Error)?.message ?? e).slice(0, 200)}); refused.`);
      return await this.finish(leased.id, { state: 'refused', code: 'not_allowed' });
    }
    let secrets: string[] = [];
    try {
      const got = await this.ioFor(p);
      secrets = got.secrets;
      const loaded = this.o.policy();
      const file: EffectsFile | null = loaded.ok ? loaded.file : null;
      if (!loaded.ok) this.log(`Read ${leased.id}: ${loaded.error}; refused.`);
      if (!checkTrackerRead(file, got.place)) return await this.finish(leased.id, { state: 'refused', code: 'not_allowed' });
      const items: ReportedImportInput[] = [];
      if (p.kind === 'item') {
        if (!isItemUrl(p.provider, p.url!)) return await this.finish(leased.id, { state: 'refused', code: 'not_allowed' });
        const one = await readItem(got.io, p.provider, p.url!, { readBy: 'runner', anyHost: got.anyHost });
        items.push(reportOf(p.provider, one.url, one.read) as ReportedImportInput);
      } else {
        const filter = p.filter ? normalFilter(p.filter as Partial<TrackerFilter>) : null;
        const r = await syncItems(got.io, {
          provider: p.provider as TrackerProvider,
          where: p.where!,
          query: p.query ?? null,
          filter,
          sprint: p.sprint ?? null,
          team: p.team ?? null,
          limit: p.limit!,
          readBy: 'runner',
          anyHost: got.anyHost,
        });
        for (const s of r.items) items.push(reportOf(p.provider, s.url, s.read) as ReportedImportInput);
      }
      if (!(await this.report(leased.id, items))) return null;
      return await this.finish(leased.id, { state: 'done' });
    } catch (e) {
      if (e instanceof ReadRefusal) return await this.finish(leased.id, e.finish);
      if (e instanceof TrackerAnswerError) return await this.finish(leased.id, { state: 'failed', code: 'not_found' });
      if (e instanceof TrackerQueryError) {
        this.log(`Read ${leased.id}: ${e.message}`, secrets);
        return await this.finish(leased.id, { state: 'failed', code: 'tracker_error' });
      }
      if (e instanceof EffectHttpError) {
        if (e.code === 'not_configured') return await this.finish(leased.id, { state: 'refused', code: 'not_configured' });
        if (e.transient) {
          this.log(`Read ${leased.id}: ${e.message}; it is tried again when the relay hands it over again.`, secrets);
          return null;
        }
        this.log(`Read ${leased.id}: ${e.message}`, secrets);
        const notFound = e.code === 'not_found' || e.code === 'auth' || e.code === 'forbidden';
        return await this.finish(leased.id, notFound ? { state: 'failed', code: 'not_found' } : { state: 'failed', code: 'tracker_error' });
      }
      this.log(`Read ${leased.id}: ${String((e as Error)?.message ?? e).slice(0, 300)}`, secrets);
      return await this.finish(leased.id, { state: 'failed', code: 'tracker_error' });
    }
  }

  /** Report the items in chunks. False when the relay withdrew the read meanwhile. */
  private async report(id: string, items: readonly ReportedImportInput[]): Promise<boolean> {
    let chunk: ReportedImportInput[] = [];
    let bytes = 0;
    const send = async () => {
      if (!chunk.length) return true;
      const out = (await this.o.call('POST', `/api/runner/reads/${id}/items`, { body: { items: chunk } })) as ReadItemsResult | null;
      chunk = [];
      bytes = 0;
      const failed = (out?.results ?? []).filter((r) => !r.ok).length;
      if (failed) this.log(`Read ${id}: the relay refused ${failed} of the items reported.`);
      return out?.cancel !== true;
    };
    for (const it of items) {
      const size = Buffer.byteLength(JSON.stringify(it));
      if (chunk.length >= TRACKER_REPORT_BATCH_MAX || (chunk.length && bytes + size > CHUNK_BYTES)) if (!(await send())) return false;
      chunk.push(it);
      bytes += size;
    }
    return await send();
  }

  private async finish(id: string, input: ReadFinishInput): Promise<ReadFinishInput> {
    try {
      await this.o.call('POST', `/api/runner/reads/${id}`, { body: input });
    } catch (e) {
      this.log(`Read ${id}: the relay did not take its finish: ${(e as Error)?.message ?? e}`);
    }
    return input;
  }

  /** Lease and handle reads until `stop`. One at a time. A relay that has no reads route is asked again rarely. */
  start(o: { waitS?: number; backoffMs?: number } = {}): void {
    if (this.running) return;
    const controller = new AbortController();
    this.controller = controller;
    const backoff = o.backoffMs ?? 5000;
    this.running = (async () => {
      while (!controller.signal.aborted) {
        try {
          const asked = Date.now();
          const waitS = o.waitS ?? READ_LEASE_WAIT_S.default;
          const out = (await this.o.call('POST', '/api/runner/reads/lease', { body: { waitS, max: 1 }, timeoutMs: waitS * 1000 + 15_000, signal: controller.signal })) as {
            reads?: unknown;
          } | null;
          const reads = (Array.isArray(out?.reads) ? out.reads : []).flatMap((r) => {
            const x = LeasedReadSchema.safeParse(r);
            return x.success ? [x.data] : [];
          });
          for (const r of reads) {
            if (controller.signal.aborted) break;
            await this.handle(r);
          }
          if (!reads.length && Date.now() - asked < 1000) await sleep(backoff, controller.signal);
        } catch (e) {
          if (controller.signal.aborted) break;
          // A relay from before reads, or with the workspace off, has no such route: ask again in ten minutes.
          const status = (e as { status?: unknown })?.status;
          await sleep(status === 404 ? 10 * 60_000 : backoff, controller.signal);
          if (status !== 404) this.log(`Reads: ${(e as Error)?.message ?? e}`);
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.running?.catch(() => {});
    this.running = null;
    this.controller = null;
  }
}
