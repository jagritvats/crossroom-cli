/**
 * `crossroom sessions`: the agent sessions on this computer, newest first, found in this process
 * (local-sessions.ts) with no host running. Each line ends with the spec `--resume` takes
 * (`claude:<id>`), so a session already holding the context a room needs joins it through
 * `crossroom new --resume` or `crossroom launch --resume`, reopened in a pane of this terminal's
 * workbench. A session open somewhere now is shown as such: its line goes in where it is open.
 *
 * Titles and folders are what each session recorded about itself, printed through `line`
 * (project-pick.ts), so none can move the cursor or start a line of its own.
 */
import os from 'node:os';
import path from 'node:path';
import type { DiscoveredSession, Harness } from '@parley/shared/sessions';
import { type Args, Usage, text } from '../cli.js';
import { registerCommand } from './index.js';
import { AGENT_NAMES, localSessions, resumable, type SessionSource, type SessionsOptions } from './local-sessions.js';
import { line } from './project-pick.js';

const HARNESSES: readonly Harness[] = ['claude', 'codex', 'grok', 'opencode'];
/** Listed unless `--with` says otherwise: OpenCode's sessions sit behind its own service, which Crossroom doesn't start. */
const DEFAULT_HARNESSES: Harness[] = ['claude', 'codex', 'grok'];

export function age(now: number, at: number | undefined): string {
  if (at === undefined) return '-';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 14 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`;
  return `${Math.floor(minutes / (7 * 24 * 60))}w`;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const clipStart = (s: string, max: number) => (s.length > max ? `…${s.slice(s.length - max + 1)}` : s);

function folderOf(cwd: string | undefined, home: string): string {
  if (!cwd) return '-';
  const c = line(cwd);
  return clipStart(home && c.startsWith(home) ? `~${c.slice(home.length)}` : c, 32);
}

const stateOf = (s: DiscoveredSession): string => {
  if (!s.live) return 'idle';
  const where = s.live.surface === 'vscode' ? 'VS Code' : s.live.surface === 'desktop' ? 'desktop app' : s.live.surface === 'background' ? 'background' : 'terminal';
  return `open (${where})`;
};

/** `claude:<id>`: what `--resume` takes. */
export const specOf = (s: DiscoveredSession): string => `${s.harness}:${s.nativeId}`;

export interface SessionsView {
  text: string;
  json: Array<{ agent: Harness; id: string; resume: string; folder?: string; title: string; lastActiveAt?: number; open: boolean; resumable: boolean; why?: string }>;
}

/** The listing as a table and as JSON, sessions Crossroom started for itself left out. */
export async function sessionsView(o: SessionsOptions, source: SessionSource, now = Date.now(), home = os.homedir()): Promise<SessionsView> {
  const report = await source.report(o);
  const shown = report.sessions.filter((s) => s.owner !== 'parley');
  const json = shown.map((s) => {
    const r = resumable(s);
    return {
      agent: s.harness,
      id: s.nativeId,
      resume: specOf(s),
      ...(s.cwd ? { folder: s.cwd } : {}),
      title: line(s.title),
      ...(s.lastActiveAt !== undefined ? { lastActiveAt: s.lastActiveAt } : {}),
      open: s.live !== null,
      resumable: r.ok,
      ...(r.ok ? {} : { why: r.why }),
    };
  });
  const lines: string[] = [];
  if (!shown.length) lines.push(o.directory ? 'No agent sessions found for this folder.' : 'No agent sessions found on this computer.');
  else {
    const rows = [
      ['AGENT', 'STATE', 'AGE', 'FOLDER', 'TITLE', 'RESUME'],
      ...shown.map((s) => [AGENT_NAMES[s.harness], stateOf(s), age(now, s.lastActiveAt), folderOf(s.cwd, home), clip(line(s.title), 40), line(specOf(s))]),
    ];
    const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
    for (const r of rows) lines.push(r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!))).join('  '));
  }
  for (const p of report.probes) {
    if (p.harness === 'opencode' && !p.ok) {
      lines.push("OpenCode: its sessions sit behind its own service, which this command does not start. Take an id from OpenCode's own session list, and --resume opencode:<id> reopens it.");
      continue;
    }
    if (!p.ok) lines.push(`${AGENT_NAMES[p.harness]}: could not list sessions. ${line(p.detail ?? '')}`);
  }
  if (report.truncated) lines.push('More sessions exist. Raise --limit (up to 200), or narrow it with --here or --with.');
  const first = shown.find((s) => resumable(s).ok);
  if (first) {
    lines.push('', 'Bring one into a room, reopened in a pane of this terminal with the room as its next prompt:');
    lines.push(`  crossroom new "<what the room is for>" --resume ${specOf(first)}`);
    lines.push(`  crossroom launch <seat link> --resume ${specOf(first)}`);
  }
  if (shown.some((s) => s.live)) lines.push('', "A session that is open now joins from where it is: paste the seat's line into it.");
  return { text: lines.join('\n'), json };
}

function optionsOf(args: Args): SessionsOptions {
  const withFlag = text(args.flags.with);
  const harnesses = withFlag
    ? withFlag.split(',').map((h) => {
        const v = h.trim().toLowerCase();
        if (!(HARNESSES as readonly string[]).includes(v)) throw new Usage(`--with takes ${HARNESSES.join(', ')}; "${line(h).slice(0, 40)}" is not one.`);
        return v as Harness;
      })
    : DEFAULT_HARNESSES;
  const limitFlag = text(args.flags.limit);
  if (limitFlag !== undefined && !/^\d{1,3}$/.test(limitFlag)) throw new Usage('--limit takes a number up to 200.');
  return {
    harnesses,
    ...(args.flags.here === true ? { directory: path.resolve(process.cwd()) } : {}),
    ...(args.flags.live === true ? { liveOnly: true } : {}),
    ...(limitFlag !== undefined ? { limit: Math.min(200, Math.max(1, Number(limitFlag))) } : { limit: 20 }),
  };
}

registerCommand({
  name: 'sessions',
  topic: 'start',
  synopsis: 'crossroom sessions',
  usage: 'crossroom sessions [--with claude,codex,grok] [--here] [--live]',
  summary: 'agent sessions already on this computer, to bring in with --resume',
  more: [{ usage: '[--limit <n>] [--json]', summary: 'then: crossroom new "<topic>" --resume claude:<id>, or crossroom launch <link> --resume …' }],
  order: 18,
  switches: ['here', 'live'],
  async run(args) {
    const view = await sessionsView(optionsOf(args), await localSessions());
    console.log(args.flags.json === true ? JSON.stringify(view.json, null, 2) : view.text);
    return 0;
  },
});
