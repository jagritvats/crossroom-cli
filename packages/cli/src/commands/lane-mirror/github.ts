/**
 * GitHub Issues for `crossroom lane mirror` (types.ts has the contract and the rules).
 *
 * - The token is the person's own: `GITHUB_TOKEN` or `GH_TOKEN`, else what `gh auth token` prints.
 *   A fine-grained token needs Issues read and write on the one repository, and Metadata read.
 * - An issue carries the lane's label (`crossroom` by default) and the marker in its body, so `find`
 *   lists the label's issues and reads their bodies: the search API lags a fresh issue by seconds.
 *   GitHub drops the labels of an issue made by a token without push access, without saying so;
 *   then `find` falls back to the search API, and `create` says the label is missing.
 * - Trusted means push access, as the repository's own permission check answers it
 *   (`/collaborators/<login>/permission`: admin, maintain or write), unless the config lists people
 *   by numeric id or login. An answer is remembered for an hour.
 * - Comments are read per changed issue (`/issues/<n>/comments?since=`), never the repository's
 *   whole comment stream, which pull requests share.
 * - GitHub's issues open and close; `stateMap` has no meaning here.
 */
import type { LaneKind, LaneState } from '@parley/shared/lane';
import {
  type AdapterOptions,
  type Changes,
  type ExternalComment,
  type ExternalIssue,
  type IssueRef,
  type OutItem,
  type Person,
  parseMarker,
  type TrackerAdapter,
  TrackerError,
  TrustCache,
  trackerFetch,
} from './types.js';

const API = 'https://api.github.com';
const PAGES = 10;
/**
 * GitHub Actions' `GITHUB_TOKEN` is an installation token, which `GET /user` refuses (403): it acts
 * as the github-actions[bot] user, whose id this is, so its own comments are still known as its own.
 */
export const GITHUB_ACTIONS_BOT_ID = '41898282';
export const GITHUB_KIND_LABELS: Partial<Record<LaneKind, string>> = { bug: 'bug', task: 'enhancement', question: 'question' };

interface GhUser {
  id: number;
  login: string;
}
interface GhIssue {
  id: number;
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string } | string>;
  user: GhUser;
  closed_by?: GhUser | null;
  updated_at: string;
  pull_request?: unknown;
}
interface GhComment {
  id: number;
  body: string | null;
  user: GhUser;
  created_at: string;
  updated_at?: string;
}

export function githubAdapter(o: AdapterOptions): TrackerAdapter {
  const cfg = o.config;
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.target)) throw new TrackerError(`target for GitHub is owner/repo, not "${cfg.target}".`);
  const base = o.base ?? API;
  const fetcher = o.fetcher ?? fetch;
  const repo = `/repos/${cfg.target}`;
  const warnings: string[] = [];
  /** The `Date` of the latest answer: GitHub's clock, not this machine's. */
  let serverDate: number | null = null;
  const call = async <T>(path: string, init: RequestInit & { json?: unknown } = {}) => {
    const r = await trackerFetch(fetcher, base, path, {
      ...init,
      headers: { authorization: `Bearer ${o.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    const d = Date.parse(r.headers.get('date') ?? '');
    serverDate = Number.isFinite(d) ? d : null;
    return r.body as T;
  };

  const trust = new TrustCache();
  async function person(u: GhUser): Promise<Person> {
    const id = String(u.id);
    // A numeric id or a login: both are GitHub's to give out, one account each.
    if (cfg.trusted.length) return { id, name: u.login, trusted: cfg.trusted.includes(id) || cfg.trusted.includes(u.login) };
    let t = trust.get(id);
    if (t === undefined) {
      try {
        const p = await call<{ permission?: string }>(`${repo}/collaborators/${encodeURIComponent(u.login)}/permission`);
        t = p.permission === 'admin' || p.permission === 'write' || p.permission === 'maintain';
      } catch (e) {
        if (!(e instanceof TrackerError) || (e.status !== 404 && e.status !== 403)) throw e;
        t = false;
      }
      trust.set(id, t);
    }
    return { id, name: u.login, trusted: t };
  }

  const ref = (i: GhIssue): IssueRef => ({ id: String(i.number), key: `#${i.number}`, url: i.html_url });
  const labelsOf = (i: GhIssue) => i.labels.map((l) => (typeof l === 'string' ? l : l.name));
  async function issueOf(i: GhIssue, closer?: GhUser | null): Promise<ExternalIssue> {
    const body = i.body ?? '';
    return {
      ...ref(i),
      title: i.title,
      body,
      open: i.state === 'open',
      labels: labelsOf(i),
      author: await person(i.user),
      closedBy: i.state === 'closed' && closer ? await person(closer) : null,
      marker: parseMarker(body)?.marker ?? null,
      updatedAt: i.updated_at,
    };
  }

  /**
   * The label's issues, pull requests left out, `since` when given, oldest change first, so a run
   * that stops at the page cap has read everything up to its last issue. `more` when it stopped there.
   */
  async function labelled(since?: string): Promise<{ list: GhIssue[]; more: boolean; read: number | null }> {
    const out: GhIssue[] = [];
    let read: number | null = null;
    for (let page = 1; page <= PAGES; page++) {
      const q = new URLSearchParams({ labels: cfg.label, state: 'all', per_page: '100', page: String(page), sort: 'updated', direction: 'asc' });
      if (since) q.set('since', since);
      const list = await call<GhIssue[]>(`${repo}/issues?${q}`);
      read ??= serverDate;
      out.push(...list.filter((i) => !i.pull_request));
      if (list.length < 100) return { list: out, more: false, read };
    }
    return { list: out, more: true, read };
  }

  const labelsFor = (item: OutItem) => [...new Set([cfg.label, ...cfg.labels, ...(cfg.kindMap[item.kind] ?? GITHUB_KIND_LABELS[item.kind] ?? '').split(',').filter(Boolean)])];

  let me: Promise<string> | undefined;
  function whoami(): Promise<string> {
    me ??= call<GhUser>('/user').then(
      (u) => String(u.id),
      (e: unknown) => {
        // GITHUB_TOKEN in Actions may not read /user: it is the github-actions[bot] account.
        if (e instanceof TrackerError && (e.status === 401 || e.status === 403)) return GITHUB_ACTIONS_BOT_ID;
        throw e;
      },
    );
    me.catch(() => {
      me = undefined;
    });
    return me;
  }

  /** Of several issues carrying the marker, the one this token wrote. */
  async function pick(hits: GhIssue[]): Promise<GhIssue | undefined> {
    if (hits.length < 2) return hits[0];
    const id = await whoami();
    return hits.find((i) => String(i.user.id) === id) ?? hits[0];
  }

  /** Every comment on issue `n` changed after `since`, oldest first; `more` when the page cap stopped it. */
  async function commentsOf(n: number, since: string): Promise<{ list: GhComment[]; more: boolean }> {
    const out: GhComment[] = [];
    for (let page = 1; page <= PAGES; page++) {
      const q = new URLSearchParams({ since, per_page: '100', page: String(page) });
      const got = await call<GhComment[]>(`${repo}/issues/${n}/comments?${q}`);
      out.push(...got);
      if (got.length < 100) return { list: out, more: false };
    }
    return { list: out, more: true };
  }

  return {
    provider: 'github',
    warnings,
    whoami,
    async find(marker) {
      const has = (i: GhIssue) => !i.pull_request && parseMarker(i.body ?? '')?.marker === marker;
      let hit = await pick((await labelled()).list.filter(has));
      if (!hit) {
        // Not under the label: GitHub dropped it (a token without push access), or someone took it off.
        const q = new URLSearchParams({ q: `repo:${cfg.target} "${marker}" in:body`, per_page: '20' });
        const found = await call<{ items?: GhIssue[] }>(`/search/issues?${q}`);
        hit = await pick((found.items ?? []).filter(has));
      }
      return hit ? issueOf(hit, hit.closed_by) : null;
    },
    async create(item) {
      const made = await call<GhIssue>(`${repo}/issues`, { method: 'POST', json: { title: item.title, body: item.body, labels: labelsFor(item) } });
      if (!labelsOf(made).some((l) => l.toLowerCase() === cfg.label.toLowerCase()))
        warnings.push(
          `#${made.number} was made without the label "${cfg.label}": GitHub drops labels for a token without push access to ${cfg.target}. Inbound reads only labelled issues; give the token Issues write and push, or label it by hand.`,
        );
      return issueOf(made);
    },
    async update(r, item) {
      await call(`${repo}/issues/${r.id}`, { method: 'PATCH', json: { title: item.title, body: item.body } });
    },
    async setState(r, state: LaneState) {
      await call(`${repo}/issues/${r.id}`, { method: 'PATCH', json: state === 'closed' ? { state: 'closed', state_reason: 'completed' } : { state: 'open' } });
    },
    async comment(r, text) {
      await call(`${repo}/issues/${r.id}/comments`, { method: 'POST', json: { body: text } });
    },
    async link(r, url) {
      await call(`${repo}/issues/${r.id}/comments`, { method: 'POST', json: { body: `Linked: ${url}` } });
    },
    async mark(r, marker) {
      const i = await call<GhIssue>(`${repo}/issues/${r.id}`);
      if (parseMarker(i.body ?? '')?.marker === marker) return;
      await call(`${repo}/issues/${r.id}`, { method: 'PATCH', json: { body: `${i.body ?? ''}\n\n${marker}`.trimStart() } });
    },
    async changes(cursor): Promise<Changes> {
      const started = Date.now();
      const since = cursor ?? new Date(started - 86_400_000).toISOString();
      const { list, more, read } = await labelled(since);
      // A minute of overlap, on GitHub's clock when it said the time (a fast clock here would skip
      // changes): what changed while this ran is read again next time, and the engine skips what it
      // already copied.
      let next = (read ?? started) - 60_000;
      if (more) {
        const last = Date.parse(list.at(-1)?.updated_at ?? '');
        // Oldest change first: what was not read changed at or after the last issue read.
        next = Number.isFinite(last) ? last : Date.parse(since);
        warnings.push(`GitHub had more changed issues than ${PAGES * 100}; the rest are read on the next run.`);
      }
      const issues: ExternalIssue[] = [];
      const comments: ExternalComment[] = [];
      for (const i of list) {
        // The list carries no closer: read a closed issue that is the lane's whole, for `closed_by`.
        const closer = i.state === 'closed' && parseMarker(i.body ?? '') ? (await call<GhIssue>(`${repo}/issues/${i.number}`)).closed_by : null;
        issues.push(await issueOf(i, closer));
        const got = await commentsOf(i.number, since);
        if (got.more) {
          const last = Date.parse(got.list.at(-1)?.updated_at ?? got.list.at(-1)?.created_at ?? '');
          next = Number.isFinite(last) ? Math.min(next, last) : Date.parse(since);
          warnings.push(`#${i.number} has more new comments than ${PAGES * 100}; the rest are read on the next run.`);
        }
        for (const c of got.list) comments.push({ id: String(c.id), issue: ref(i), body: c.body ?? '', author: await person(c.user), createdAt: c.created_at });
      }
      return { issues, comments, cursor: new Date(next).toISOString() };
    },
  };
}
