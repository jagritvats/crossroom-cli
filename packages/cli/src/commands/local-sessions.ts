/**
 * The agent sessions on this computer: the discovery probes (`discovery/`) run in this process,
 * each reading only what its agent leaves in its own records, so nothing is spawned to list
 * sessions: Claude Code's are read from its session files, Codex's from its rollouts, Grok's from
 * its folders. OpenCode keeps its sessions behind its own service, so it lists none here.
 *
 * What it is for: `crossroom sessions` lists them, and `crossroom launch --resume` and `crossroom
 * new --resume` reopen one in a pane of this terminal's workbench with a seat's line as its next
 * prompt.
 *
 * Registers no command, so `launch.ts` can import it without moving the registry's order.
 */
import { existsSync } from 'node:fs';
import type { DiscoveredSession, DiscoveryReport, Harness } from '@parley/shared/sessions';
import { oneLine } from '@parley/shared/text';
import { dataDir, Usage } from '../cli.js';

/** The agents whose sessions can be reopened in a pane with a new prompt, and by which flags (launch.ts). */
export const RESUMABLE = ['claude', 'codex', 'opencode'] as const;
export type ResumableAgent = (typeof RESUMABLE)[number];

export const AGENT_NAMES: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', opencode: 'OpenCode' };

/** A session id as every harness spells one (discovery/probe.ts `SESSION_ID`): nothing that could carry a path. */
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,199}$/;

export interface SessionsOptions {
  harnesses?: Harness[];
  directory?: string;
  liveOnly?: boolean;
  limit?: number;
}

/** What a session lister needs: `SessionDiscovery`'s two reads, so tests can stand one in. */
export interface SessionSource {
  report(o: SessionsOptions): Promise<DiscoveryReport>;
  find(harness: Harness, id: string): Promise<DiscoveredSession | undefined>;
}

/** Discovery in this process, with no driver: each probe falls back to its agent's own records. */
export async function localSessions(): Promise<SessionSource> {
  const { SessionDiscovery } = await import('../discovery/index.js');
  // Its own work (hosted seats) is under the data directory.
  const discovery = new SessionDiscovery({ dataDirectory: dataDir() });
  return {
    report: (o) => discovery.report({ harnesses: o.harnesses, directory: o.directory, liveOnly: o.liveOnly, limit: o.limit }),
    find: (harness, id) => discovery.find(harness, id),
  };
}

/** Whether a session can be reopened in a pane, or why not, in words for the person. */
export function resumable(s: DiscoveredSession): { ok: true } | { ok: false; why: string } {
  if (s.owner === 'parley') return { ok: false, why: 'Crossroom started it for its own work.' };
  if (!(RESUMABLE as readonly string[]).includes(s.harness)) return { ok: false, why: `${AGENT_NAMES[s.harness]} sessions can't be reopened with a new prompt from here.` };
  if (s.live) return { ok: false, why: `It is open in ${where(s.live.surface)} now: paste the seat's line into it there.` };
  if (!s.cwd) return { ok: false, why: 'Its working folder was not recorded.' };
  if (!existsSync(s.cwd)) return { ok: false, why: 'Its folder no longer exists.' };
  return { ok: true };
}

const where = (surface: string): string =>
  surface === 'vscode' ? 'VS Code' : surface === 'desktop' ? 'the desktop app' : surface === 'background' ? 'a background session' : 'a terminal';

/** `claude:<id>`, `codex:<id>`, `opencode:<id>`, or a bare id looked for under each. */
export function parseResumeSpec(spec: string): { harness?: Harness; id: string } {
  const m = /^(claude|codex|opencode|grok):(.+)$/.exec(spec.trim());
  const id = (m ? m[2]! : spec).trim();
  if (!SESSION_ID.test(id)) throw new Usage(`"${oneLine(spec).slice(0, 60)}" is not a session id. \`crossroom sessions\` lists them.`);
  return m ? { harness: m[1] as Harness, id } : { id };
}

/** A session a pane can reopen: one of the agents that takes a new prompt on resume, with its folder. */
export type ResolvedSession = DiscoveredSession & { harness: ResumableAgent; cwd: string };

/** The session a `--resume` names, checked to be one a pane can reopen. Throws a `Usage` saying why not. */
export async function resolveResume(spec: string, source: SessionSource): Promise<ResolvedSession> {
  const { harness, id } = parseResumeSpec(spec);
  const tries = harness ? [harness] : (['claude', 'codex', 'opencode'] as Harness[]);
  let found: DiscoveredSession | undefined;
  for (const h of tries) {
    found = await source.find(h, id);
    if (found) break;
  }
  if (!found) throw new Usage(`No ${harness ? `${AGENT_NAMES[harness]} ` : ''}session ${id} on this computer. \`crossroom sessions\` lists them.`);
  const ok = resumable(found);
  if (!ok.ok) throw new Usage(`${AGENT_NAMES[found.harness]} session ${id} can't be reopened in a pane. ${ok.why}`);
  return found as ResolvedSession;
}

/** Every `--resume` given, repeated or comma-separated. */
export function resumeSpecs(flag: string | true | undefined, values?: string[]): string[] {
  if (flag === undefined) return [];
  if (flag === true) throw new Usage('--resume names a session, as `crossroom sessions` prints it: claude:<id>.');
  return (values ?? [flag]).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}
