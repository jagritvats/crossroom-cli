/**
 * The runner's local page: `crossroom runner page` serves it on the answering
 * team's own machine, for the person who runs the runner. It lists the seats, the jobs (each with
 * a link to its seat's page on the relay, `${relay}/seat#t=<seat token>`), the outbound ledger, and
 * the packets held for review, with Approve and Refuse.
 *
 * It holds that team's secrets on screen, so every guard below is on purpose:
 * - It binds 127.0.0.1 (or ::1) and nothing else: `startRunnerPage` throws for any other address.
 * - A `Host` other than the loopback address and port it listens on is refused, so a DNS-rebinding
 *   page (evil.example resolving to 127.0.0.1) gets nothing.
 * - Everything but the empty shell needs the page key: 32 random bytes made at each start, handed
 *   out once in the URL's fragment (`#k=`), which a browser never sends. The shell's script moves
 *   it into `sessionStorage` and out of the address bar, and sends it as `x-parley-runner-page`.
 *   A missing key and a wrong one get the same 401. A cross-site page can neither set that header
 *   (the page answers no CORS preflight) nor read an answer.
 * - A POST also needs an `Origin` equal to the page's own and a JSON body, and `Sec-Fetch-Site`,
 *   when the browser sends it, must be `same-origin`.
 * - A GET changes nothing. Approve and Refuse are POSTs, and they are the page's only writes.
 * - Every value is escaped as it is rendered. Titles, sources and bodies are agent-written, and the
 *   CSP (a nonce for the one script and the one stylesheet, nothing else) would stop a script that
 *   got through anyway.
 * - The page logs nothing, and never echoes an action's error: an error can carry a path or a URL.
 *
 * What the page shows comes from a `RunnerPageSource` (`runnerDbSource` reads R0's tables in
 * `runner.db`), and what Approve and Refuse do is `RunnerPageActions`: replaying a held call through
 * the seat's own token and waking its CLI is the review's job, not the page's.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { oneLine } from '@parley/shared/text';
import { HOLD_ID } from '@parley/shared/runner';

/** The header the page's script sends its key in. */
export const PAGE_KEY_HEADER = 'x-parley-runner-page';
/** The one 401 body, for a missing key and a wrong one alike. */
export const PAGE_REFUSED = 'This page needs the key it was opened with. Run crossroom runner page again and open the link it prints.';
/** The addresses the page may listen on. */
export const PAGE_HOSTS = ['127.0.0.1', '::1'] as const;
export type PageHost = (typeof PAGE_HOSTS)[number];
/** The most a refusal's reason may say; it is collapsed to one line before it goes anywhere. */
export const REASON_MAX = 500;
const BODY_MAX = 4096;
const JOBS_SHOWN = 100;
const LEDGER_SHOWN = 100;

// ---------------------------------------------------------------- what the page reads

export interface PageSeat {
  label: string;
  paused: boolean;
  registered: boolean;
  askEpoch: number;
  rotatedAt: string | null;
}
export interface PageJob {
  id: string;
  label: string;
  sessionId: string;
  participantId: string;
  state: string;
  refusedReason: string | null;
  receivedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  costUsd: number | null;
  commitSha: string | null;
  /** The seat's token, for its seat page link only. Never rendered as text. */
  seatToken: string | null;
}
export interface PageOutbound {
  id: number;
  at: string;
  jobId: string;
  label: string;
  op: string;
  toSeat: string | null;
  packetLabel: string | null;
  kind: string | null;
  title: string | null;
  source: string | null;
  bytes: number | null;
  decision: string;
  rule: string | null;
}
export interface PageHeld {
  id: string;
  jobId: string;
  label: string | null;
  op: string | null;
  /** The held call's arguments as the agent sent them, parsed; null when they do not parse. */
  args: Record<string, unknown> | null;
  /** Which rule held it (`review:path`, `secret:jwt`), and what it matched, as the ledger has them. */
  rule: string | null;
  detail: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decision: string | null;
  reason: string | null;
}

export interface RunnerPageSource {
  /** The relay this runner registered with, where every seat page is; null before `init`. */
  relay(): string | null;
  /** The runner's name, from its config, when there is one. */
  name?(): string | null;
  seats(): PageSeat[];
  /** Newest first. */
  jobs(limit: number): PageJob[];
  /** Newest first. */
  outbound(limit: number): PageOutbound[];
  /** Undecided first, then newest first. */
  held(): PageHeld[];
}

/** What an action answers. The page turns each code into a fixed sentence and a status. */
export type HoldAction = { ok: true } | { ok: false; code: 'unknown' | 'decided' | 'expired' | 'failed' };

export interface RunnerPageActions {
  /** Send the held call on as it stands, through the seat's own token, and wake its CLI. */
  approve(holdId: string): Promise<HoldAction>;
  /** Refuse it for good; the reason goes to the seat's agent. */
  refuse(holdId: string, reason: string): Promise<HoldAction>;
}

/** The R0 tables of `runner.db` (runner/migrations/000-runner.ts), read and never written. */
export function runnerDbSource(db: DatabaseSync, o: { name?: string | null } = {}): RunnerPageSource {
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    relay: () => str((db.prepare('SELECT relay FROM identity WHERE id = 1').get() as { relay?: unknown } | undefined)?.relay),
    name: () => o.name ?? null,
    seats: () =>
      (db.prepare('SELECT label, ask_epoch, paused_at, registered_at, rotated_at FROM seats ORDER BY label').all() as any[]).map((r) => ({
        label: String(r.label),
        paused: r.paused_at !== null,
        registered: r.registered_at !== null,
        askEpoch: Number(r.ask_epoch),
        rotatedAt: str(r.rotated_at),
      })),
    jobs: (limit) =>
      (
        db
          .prepare(
            `SELECT id, label, session_id, participant_id, seat_token, state, refused_reason, received_at, started_at, ended_at, cost_usd, commit_sha
             FROM jobs ORDER BY received_at DESC, id LIMIT ?`,
          )
          .all(limit) as any[]
      ).map((r) => ({
        id: String(r.id),
        label: String(r.label),
        sessionId: String(r.session_id),
        participantId: String(r.participant_id),
        state: String(r.state),
        refusedReason: str(r.refused_reason),
        receivedAt: String(r.received_at),
        startedAt: str(r.started_at),
        endedAt: str(r.ended_at),
        costUsd: num(r.cost_usd),
        commitSha: str(r.commit_sha),
        seatToken: str(r.seat_token),
      })),
    outbound: (limit) =>
      (
        db
          .prepare(
            `SELECT id, at, job_id, label, op, to_seat, packet_label, kind, title, source, bytes, decision, rule
             FROM outbound ORDER BY id DESC LIMIT ?`,
          )
          .all(limit) as any[]
      ).map((r) => ({
        id: Number(r.id),
        at: String(r.at),
        jobId: String(r.job_id),
        label: String(r.label),
        op: String(r.op),
        toSeat: str(r.to_seat),
        packetLabel: str(r.packet_label),
        kind: str(r.kind),
        title: str(r.title),
        source: str(r.source),
        bytes: num(r.bytes),
        decision: String(r.decision),
        rule: str(r.rule),
      })),
    held: () =>
      (
        db
          .prepare(
            `SELECT h.id, h.job_id, h.args_json, h.created_at, h.expires_at, h.decided_at, h.decision, h.reason, o.label, o.op, o.rule, o.detail
             FROM held h LEFT JOIN outbound o ON o.id = h.outbound_id
             ORDER BY (h.decided_at IS NOT NULL), h.created_at DESC LIMIT 50`,
          )
          .all() as any[]
      ).map((r) => ({
        id: String(r.id),
        jobId: String(r.job_id),
        label: str(r.label),
        op: str(r.op),
        args: parseArgs(r.args_json),
        rule: str(r.rule),
        detail: str(r.detail),
        createdAt: String(r.created_at),
        expiresAt: String(r.expires_at),
        decidedAt: str(r.decided_at),
        decision: str(r.decision),
        reason: str(r.reason),
      })),
  };
}

function parseArgs(json: unknown): Record<string, unknown> | null {
  try {
    const v = JSON.parse(String(json));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- rendering

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text or an attribute value, escaped: every value the page shows goes through this. */
export const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]!);

const when = (iso: string | null) => (iso ? `${iso.replace('T', ' ').slice(0, 16)} UTC` : '');
const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 12)}…` : id);

/**
 * A seat's page on the relay, the token in the fragment so it never reaches a server log. Only an
 * http(s) relay gets a link: anything else (a `javascript:` URL in a hand-edited config) gets none.
 */
export function seatPageUrl(relay: string | null, seatToken: string | null): string | null {
  if (!relay || !seatToken) return null;
  let u: URL;
  try {
    u = new URL(relay);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/seat#t=${encodeURIComponent(seatToken)}`;
}

const table = (head: string[], rows: string[], empty: string) =>
  rows.length
    ? `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
    : `<p class="empty">${esc(empty)}</p>`;

function renderSeats(seats: PageSeat[]): string {
  return table(
    ['Seat', 'State', 'Ask link epoch', 'Rotated'],
    seats.map(
      (s) =>
        `<tr><td><code>${esc(s.label)}</code></td><td>${s.paused ? 'paused' : s.registered ? 'active' : 'not registered yet'}</td><td>${esc(s.askEpoch)}</td><td>${esc(when(s.rotatedAt))}</td></tr>`,
    ),
    'No seats yet. Add one with crossroom runner add.',
  );
}

function renderJobs(jobs: PageJob[], relay: string | null): string {
  return table(
    ['Seat', 'State', 'Room', 'Received', 'Ended', 'Cost', ''],
    jobs.map((j) => {
      // A job the dispatch check refused was never this runner's seat: no link into its room.
      const url = j.state === 'refused' ? null : seatPageUrl(relay, j.seatToken);
      const state = j.refusedReason ? `${j.state} (${j.refusedReason})` : j.state;
      const link = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open its seat page</a>` : '';
      return `<tr><td><code>${esc(j.label)}</code></td><td>${esc(state)}</td><td><code title="${esc(j.sessionId)}">${esc(shortId(j.sessionId))}</code></td><td>${esc(when(j.receivedAt))}</td><td>${esc(when(j.endedAt))}</td><td>${j.costUsd === null ? '' : `$${esc(j.costUsd.toFixed(2))}`}</td><td>${link}</td></tr>`;
    }),
    'No jobs yet. A job arrives when someone asks one of these seats.',
  );
}

function renderOutbound(rows: PageOutbound[]): string {
  return table(
    ['When', 'Seat', 'Operation', 'To', 'What', 'Source', 'Bytes', 'Decision', 'Rule'],
    rows.map((r) => {
      const what = [r.packetLabel, r.kind ? `[${r.kind}]` : null, r.title].filter(Boolean).join(' ');
      return `<tr class="d-${esc(r.decision)}"><td>${esc(when(r.at))}</td><td><code>${esc(r.label)}</code></td><td>${esc(r.op)}</td><td>${esc(r.toSeat ?? '')}</td><td>${esc(what)}</td><td><code>${esc(r.source ?? '')}</code></td><td>${esc(r.bytes ?? '')}</td><td>${esc(r.decision)}</td><td>${esc(r.rule ?? '')}</td></tr>`;
    }),
    'Nothing has left this machine yet.',
  );
}

const ARG_FIELDS = ['to', 'kind', 'title', 'source', 'in_reply_to'] as const;
const TEXT_FIELDS = ['body', 'text', 'summary', 'reason'] as const;

function renderHeldArgs(args: Record<string, unknown> | null): string {
  if (!args) return '<p class="empty">Its arguments could not be read.</p>';
  const known = new Set<string>([...ARG_FIELDS, ...TEXT_FIELDS]);
  const dl = ARG_FIELDS.filter((k) => args[k] !== undefined && args[k] !== '')
    .map((k) => `<dt>${esc(k)}</dt><dd>${esc(typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k]))}</dd>`)
    .join('');
  const texts = TEXT_FIELDS.filter((k) => typeof args[k] === 'string' && args[k] !== '')
    .map((k) => `<p class="field">${esc(k)}</p><pre>${esc(args[k])}</pre>`)
    .join('');
  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !known.has(k)));
  const other = Object.keys(rest).length ? `<p class="field">other arguments</p><pre>${esc(JSON.stringify(rest, null, 2))}</pre>` : '';
  return `${dl ? `<dl>${dl}</dl>` : ''}${texts}${other}`;
}

function renderHeld(held: PageHeld[], now: number): string {
  if (!held.length) return '<p class="empty">Nothing is held for review.</p>';
  return held
    .map((h) => {
      const expired = !h.decidedAt && Date.parse(h.expiresAt) <= now;
      const open = !h.decidedAt && !expired;
      const state = h.decidedAt
        ? `${esc(h.decision ?? 'decided')} ${esc(when(h.decidedAt))}${h.reason ? `: ${esc(h.reason)}` : ''}`
        : expired
          ? 'expired without a decision'
          : `waiting for a decision until ${esc(when(h.expiresAt))}`;
      const why = [h.rule, h.detail].filter(Boolean).map(esc).join(': ');
      const actions = open
        ? `<div class="actions"><button type="button" data-approve="${esc(h.id)}">Approve and send</button>` +
          `<form data-refuse="${esc(h.id)}"><input name="reason" maxlength="${REASON_MAX}" required placeholder="Why it is refused (its agent is told)" aria-label="Reason for refusing"><button type="submit">Refuse</button></form></div>`
        : '';
      return `<article class="held${open ? ' open' : ''}" data-hold="${esc(h.id)}"><header><code>${esc(h.label ?? '')}</code> ${esc(h.op ?? '')} <span class="muted">held ${esc(when(h.createdAt))}${why ? `, by ${why}` : ''}</span></header>${renderHeldArgs(h.args)}<p class="state">${state}</p>${actions}</article>`;
    })
    .join('');
}

/** The page's regions, rendered from the source now. Exported for tests. */
export function renderState(source: RunnerPageSource, now = Date.now()) {
  const relay = source.relay();
  const held = source.held();
  return {
    relay: esc(relay ?? 'not set: run crossroom runner init'),
    name: esc(source.name?.() ?? ''),
    heldCount: held.filter((h) => !h.decidedAt && Date.parse(h.expiresAt) > now).length,
    held: renderHeld(held, now),
    seats: renderSeats(source.seats()),
    jobs: renderJobs(source.jobs(JOBS_SHOWN), relay),
    outbound: renderOutbound(source.outbound(LEDGER_SHOWN)),
  };
}

// ---------------------------------------------------------------- the shell

// The web app's look (styles.css tokens), copied: this page is served by the runner, not the app.
const STYLE = `
:root{--bg:#f7f5ef;--fg:#1d2027;--muted:#46494f;--line:#d6d1c5;--line2:#c3bdaf;--panel:#efece4;--btn:#e7e3d9;--mark:#6b5900;--bad:#a32720;--badsoft:rgba(163,39,32,.08);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#171a1f;--fg:#ece7dc;--muted:#aaa79a;--line:#333944;--line2:#434a58;--panel:#1e222a;--btn:#262b34;--mark:#f2e85c;--bad:#f0797f;--badsoft:rgba(240,121,127,.12);color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14.5px/1.5 'Segoe UI',system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1000px;margin:0 auto;padding:32px 24px 48px}
h1,h2{font-family:'Palatino Linotype',Palatino,'Iowan Old Style',Georgia,serif;font-weight:400}
h1{font-size:30px;line-height:1.15;margin:0 0 8px}h2{font-size:20px;margin:32px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.muted,.empty{color:var(--muted)}#status{min-height:1.4em}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;font-size:13px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:500;color:var(--muted);white-space:nowrap}
code,pre{font-family:Consolas,'Cascadia Mono','SF Mono',Menlo,monospace;font-size:12.5px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:10px 12px;margin:6px 0}
.held{border:1px solid var(--line);border-left:3px solid var(--line2);border-radius:6px;padding:14px 18px;margin:12px 0;background:var(--panel)}.held.open{border-left-color:var(--mark)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:8px 0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}.field{margin:8px 0 0;color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}.actions form{display:flex;gap:8px;flex:1;min-width:240px}
input{flex:1;min-width:0;font:inherit;padding:8px 11px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px}
button{font:500 13.5px/1 'Segoe UI',system-ui,sans-serif;padding:9px 14px;min-height:34px;border-radius:6px;border:1px solid var(--line2);background:var(--btn);color:var(--fg);cursor:pointer}
button[data-approve]{background:var(--fg);border-color:var(--fg);color:var(--bg);font-weight:600}
form[data-refuse] button{background:transparent;border-color:var(--bad);color:var(--bad)}form[data-refuse] button:hover{background:var(--badsoft)}
:focus-visible{outline:2px solid var(--mark);outline-offset:2px}
.d-refused td,.d-refused_after_review td{color:var(--bad)}.d-held td{color:var(--mark)}
@media (max-width:640px){main{padding:20px 16px 32px}}
`;

/**
 * The page's script: find the key, keep it for this tab only, take it out of the address bar, and
 * fill the regions from `/state` every few seconds while the tab is shown. A reason being typed is
 * never overwritten by a refresh.
 */
const SCRIPT = `
(() => {
  const H = ${JSON.stringify(PAGE_KEY_HEADER)};
  const SLOT = 'parley-runner-page-key';
  const $ = (id) => document.getElementById(id);
  const status = $('status');
  const say = (t) => { status.textContent = t; };
  let key = new URLSearchParams(location.hash.slice(1)).get('k');
  try { if (key) sessionStorage.setItem(SLOT, key); else key = sessionStorage.getItem(SLOT); } catch {}
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (!key) { say(${JSON.stringify(PAGE_REFUSED)}); return; }
  const last = {};
  let timer = null;
  const busy = (el) => el.contains(document.activeElement) || [...el.querySelectorAll('input')].some((i) => i.value);
  async function load(force) {
    let r;
    try { r = await fetch('/state', { headers: { [H]: key }, cache: 'no-store' }); } catch { say('The runner is not answering. Is crossroom runner page still running?'); return; }
    if (r.status === 401) { say(${JSON.stringify(PAGE_REFUSED)}); if (timer) clearInterval(timer); return; }
    if (!r.ok) { say('The page could not read the runner (' + r.status + ').'); return; }
    const s = await r.json();
    for (const k of ['held', 'seats', 'jobs', 'outbound']) {
      const el = $(k);
      if (!force && (s[k] === last[k] || (k === 'held' && busy(el)))) continue;
      el.innerHTML = s[k];
      last[k] = s[k];
    }
    $('relay').innerHTML = s.relay;
    $('name').innerHTML = s.name;
    $('held-count').textContent = s.heldCount ? '(' + s.heldCount + ' waiting)' : '';
    document.title = (s.heldCount ? '(' + s.heldCount + ') ' : '') + 'Crossroom runner';
  }
  async function act(id, what, body) {
    let r;
    try {
      r = await fetch('/held/' + encodeURIComponent(id) + '/' + what, { method: 'POST', headers: { [H]: key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch { say('The runner is not answering.'); return; }
    const j = await r.json().catch(() => ({}));
    say(r.ok ? (what === 'approve' ? 'Approved: the packet is on its way to the room.' : 'Refused: its agent is told why.') : (j.error || 'That did not work.'));
    await load(true);
  }
  document.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('button[data-approve]') : null;
    if (!b) return;
    if (!confirm('Send this packet to the room as it stands? The other side will read it.')) return;
    void act(b.dataset.approve, 'approve', {});
  });
  document.addEventListener('submit', (e) => {
    const f = e.target instanceof Element ? e.target.closest('form[data-refuse]') : null;
    if (!f) return;
    e.preventDefault();
    const reason = f.elements.reason.value.trim();
    if (!reason) return;
    void act(f.dataset.refuse, 'refuse', { reason });
  });
  void load(true);
  timer = setInterval(() => { if (!document.hidden) void load(false); }, 5000);
})();
`;

function shell(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Crossroom runner</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<h1>Crossroom runner <span id="name" class="muted"></span></h1>
<p class="muted">Relay: <span id="relay"></span>. This page is on this machine only, and it shows what this runner's seats sent.</p>
<p id="status" role="status" aria-live="polite"></p>
<h2>Held for review <span id="held-count" class="muted"></span></h2>
<section id="held" aria-label="Held for review"></section>
<h2>Seats</h2>
<section id="seats" aria-label="Seats"></section>
<h2>Jobs</h2>
<section id="jobs" aria-label="Jobs"></section>
<h2>Outbound ledger</h2>
<section id="outbound" aria-label="Outbound ledger"></section>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- the server

export interface RunnerPage {
  /** The one link to the page, key included in its fragment. Print it; never put it in argv. */
  url: string;
  port: number;
  host: PageHost;
  close(): Promise<void>;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Security headers every answer carries, HTML or not. */
const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
} as const;

export async function startRunnerPage(o: {
  source: RunnerPageSource;
  actions: RunnerPageActions;
  /** 0 (the default) takes a free port. */
  port?: number;
  host?: PageHost;
  /** For tests: what "now" is when deciding whether a hold has expired. */
  now?: () => number;
}): Promise<RunnerPage> {
  const host = o.host ?? '127.0.0.1';
  if (!(PAGE_HOSTS as readonly string[]).includes(host)) throw new Error(`The runner page listens on loopback only (${PAGE_HOSTS.join(' or ')}), not ${String(host)}`);
  const key = randomBytes(32).toString('base64url');
  const keyDigest = digest(key);
  const now = o.now ?? Date.now;
  let port = 0;
  /** The Host values this page answers to: its own address and port, and `localhost` for it. */
  const hosts = () => (host === '::1' ? [`[::1]:${port}`, `localhost:${port}`] : [`127.0.0.1:${port}`, `localhost:${port}`]);

  const send = (res: http.ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...BASE_HEADERS, 'content-type': type, ...extra });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
  const keyOk = (req: http.IncomingMessage) => {
    const given = req.headers[PAGE_KEY_HEADER];
    return typeof given === 'string' && timingSafeEqual(digest(given), keyDigest);
  };
  /** The body, or null past `BODY_MAX` (read to its end but not kept, so the answer still arrives). Only a key holder gets this far. */
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string | null>((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= BODY_MAX) chunks.push(c);
      });
      req.on('end', () => resolve(size > BODY_MAX ? null : Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(null));
    });

  const HOLD_PATH = /^\/held\/([^/]+)\/(approve|refuse)$/;
  const ANSWERS: Record<Exclude<HoldAction, { ok: true }>['code'], [number, string]> = {
    unknown: [404, 'No such held packet.'],
    decided: [409, 'That packet has been decided already.'],
    expired: [409, 'That packet waited too long and expired; its agent was told.'],
    failed: [502, 'The runner could not do that. Its log says why.'],
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // DNS rebinding: a page that resolves its own name to this address still sends its own Host.
    if (!hosts().includes(String(req.headers.host ?? ''))) return json(res, 403, { error: 'wrong host' });
    const url = new URL(req.url ?? '/', 'http://page.invalid');
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/') {
      const nonce = randomBytes(16).toString('base64');
      return send(res, 200, 'text/html; charset=utf-8', shell(nonce), {
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
    if (method === 'GET' && url.pathname === '/state') {
      if (!keyOk(req)) return json(res, 401, { error: PAGE_REFUSED });
      return json(res, 200, renderState(o.source, now()));
    }
    const m = HOLD_PATH.exec(url.pathname);
    if (m) {
      if (method !== 'POST') return json(res, 405, { error: 'POST only' });
      if (!keyOk(req)) return json(res, 401, { error: PAGE_REFUSED });
      const site = req.headers['sec-fetch-site'];
      if (req.headers.origin !== `http://${req.headers.host}` || (site !== undefined && site !== 'same-origin'))
        return json(res, 403, { error: 'cross-origin request refused' });
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'send JSON' });
      // A hold id is URL-safe as it stands (`HOLD_ID`), so nothing is decoded: `%zz` is simply not one.
      const id = m[1]!;
      if (!HOLD_ID.test(id)) return json(res, 404, { error: ANSWERS.unknown[1] });
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = raw === null ? null : JSON.parse(raw || '{}');
      } catch {
        body = null;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'send a JSON object' });
      let result: HoldAction;
      if (m[2] === 'approve') {
        result = await o.actions.approve(id).catch((): HoldAction => ({ ok: false, code: 'failed' }));
      } else {
        const given = (body as { reason?: unknown }).reason;
        const reason = typeof given === 'string' ? oneLine(given).slice(0, REASON_MAX) : '';
        if (!reason) return json(res, 400, { error: 'Say why it is refused: its agent is told.' });
        result = await o.actions.refuse(id, reason).catch((): HoldAction => ({ ok: false, code: 'failed' }));
      }
      if (result.ok) return json(res, 200, { ok: true });
      const [status, error] = ANSWERS[result.code] ?? ANSWERS.failed;
      return json(res, status, { error });
    }
    if (url.pathname === '/' || url.pathname === '/state') return json(res, 405, { error: 'GET only' });
    return json(res, 404, { error: 'no such page' });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'The page hit an error.' });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const shown = host === '::1' ? `[::1]:${port}` : `127.0.0.1:${port}`;
  return {
    url: `http://${shown}/#k=${key}`,
    port,
    host,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
