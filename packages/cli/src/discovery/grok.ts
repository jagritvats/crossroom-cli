/**
 * Grok sessions on this computer.
 *
 * Live: `~/.grok/active_sessions.json`, each entry checked against its process.
 * Recent: `~/.grok/sessions/<cwd>/<id>/summary.json`, through an allowlist. The summary also holds
 * the conversation's own summaries and Grok's home path, which are never copied, and the chat
 * history beside it is never opened.
 */
import path from 'node:path';
import { isRecord, listDir, modifiedAt, num, parseJson, readSmall, samePath, str, time } from './files.js';
import { sameProcess } from './process.js';
import type { LiveHint, LiveState, ProbeContext, ProbeSession, SessionProbe } from './probe.js';

const ACTIVE_MAX = 256 * 1024;
const SUMMARY_MAX = 64 * 1024;
const DIRS_MAX = 1000;
const SESSIONS_MAX = 5000;
/** A session id names a directory here, so it can never carry a path. */
export const GROK_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,99}$/;

export const grokDir = (ctx: Pick<ProbeContext, 'home' | 'env'>) => ctx.env.GROK_HOME || path.join(ctx.home, '.grok');

interface Active {
  id: string;
  pid: number;
  cwd?: string;
  openedAt?: number;
}

async function actives(dir: string): Promise<Active[]> {
  const value = parseJson(await readSmall(path.join(dir, 'active_sessions.json'), ACTIVE_MAX, { root: dir }));
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = str(entry.session_id, 100);
    const pid = num(entry.pid);
    if (!id || !GROK_ID.test(id) || !pid || !Number.isSafeInteger(pid) || pid <= 0) return [];
    return [{ id, pid, cwd: str(entry.cwd), openedAt: time(entry.opened_at) }];
  });
}

interface Summary {
  id: string;
  cwd?: string;
  title?: string;
  lastActiveAt?: number;
  kind: 'interactive' | 'subagent';
}

function summary(text: string | undefined, id: string): Summary | undefined {
  const value = parseJson(text);
  if (!isRecord(value)) return undefined;
  const info = isRecord(value.info) ? value.info : {};
  if (str(info.id, 100) !== id) return undefined;
  const kind = str(value.session_kind, 80);
  return {
    id,
    cwd: str(info.cwd),
    title: str(value.generated_title, 1000),
    lastActiveAt: time(value.last_active_at) ?? time(value.updated_at),
    kind: kind && /sub.?agent/i.test(kind) ? 'subagent' : 'interactive',
  };
}

function liveState(active: Active): LiveState {
  return { pid: active.pid, status: 'unknown', surface: 'unknown', exit: 'pid' };
}

async function candidates(dir: string): Promise<{ file: string; id: string; mtime: number }[]> {
  const root = path.join(dir, 'sessions');
  const found: { file: string; id: string }[] = [];
  outer: for (const folder of (await listDir(root)).slice(0, DIRS_MAX))
    for (const id of await listDir(path.join(root, folder))) {
      if (!GROK_ID.test(id)) continue;
      found.push({ file: path.join(root, folder, id, 'summary.json'), id });
      if (found.length >= SESSIONS_MAX) break outer;
    }
  const stamped = await Promise.all(found.map(async (entry) => ({ ...entry, mtime: await modifiedAt(entry.file) })));
  return stamped
    .filter((entry): entry is { file: string; id: string; mtime: number } => entry.mtime !== undefined)
    .sort((a, b) => b.mtime - a.mtime);
}

export function grokProbe(ctx: ProbeContext): SessionProbe {
  const dir = grokDir(ctx);
  const live = async (id: string, hint?: LiveHint): Promise<LiveState | null> => {
    if (hint?.pid) {
      return (await sameProcess(ctx.process, hint.pid, { start: hint.procStart ? Number(hint.procStart) : undefined }))
        ? { pid: hint.pid, procStart: hint.procStart, status: 'unknown', surface: 'unknown', exit: 'pid' }
        : null;
    }
    for (const active of await actives(dir))
      if (active.id === id && (await sameProcess(ctx.process, active.pid, { after: active.openedAt }))) return liveState(active);
    return null;
  };
  return {
    harness: 'grok',
    live,
    async list(options) {
      // Listing only asks whether each pid exists: a stale entry whose pid was reused reads as open, the safe mistake.
      const open = (await actives(dir)).filter(
        (active) => ctx.process.alive(active.pid) && (!options.directory || (active.cwd && samePath(active.cwd, options.directory))),
      );
      const byId = new Map(open.map((active) => [active.id, active]));
      const sessions = new Map<string, ProbeSession>();
      let truncated = false;
      const all = await candidates(dir);
      const wanted = options.liveOnly ? all.filter((entry) => byId.has(entry.id)) : all;
      let read = 0;
      for (const entry of wanted) {
        if (sessions.size >= options.limit && !byId.has(entry.id)) {
          truncated = true;
          continue;
        }
        if (++read > options.limit * 4 + 100 + byId.size || options.signal.aborted) break;
        const found = summary(await readSmall(entry.file, SUMMARY_MAX, { root: dir }), entry.id);
        if (!found || found.kind === 'subagent') continue;
        if (options.directory && !(found.cwd && samePath(found.cwd, options.directory))) continue;
        const active = byId.get(found.id);
        sessions.set(found.id, {
          nativeId: found.id,
          cwd: found.cwd ?? active?.cwd,
          title: found.title,
          lastActiveAt: found.lastActiveAt ?? entry.mtime,
          live: active ? liveState(active) : null,
          source: 'files',
        });
      }
      for (const active of open)
        if (!sessions.has(active.id))
          sessions.set(active.id, {
            nativeId: active.id,
            cwd: active.cwd,
            lastActiveAt: active.openedAt,
            live: liveState(active),
            source: 'files',
          });
      return { sessions: [...sessions.values()], source: 'files', truncated };
    },
    async find(id) {
      if (!GROK_ID.test(id)) return undefined;
      const entry = (await candidates(dir)).find((candidate) => candidate.id === id);
      const found = entry ? summary(await readSmall(entry.file, SUMMARY_MAX, { root: dir }), id) : undefined;
      const active = (await actives(dir)).find((candidate) => candidate.id === id);
      if (!found && !active) return undefined;
      let state: LiveState | null = null;
      if (active && (await sameProcess(ctx.process, active.pid, { after: active.openedAt }))) {
        const start = await ctx.process.startedAt(active.pid);
        state = { ...liveState(active), ...(start !== undefined ? { procStart: String(start) } : {}) };
      }
      return {
        nativeId: id,
        cwd: found?.cwd ?? active?.cwd,
        title: found?.title,
        lastActiveAt: found?.lastActiveAt ?? entry?.mtime ?? active?.openedAt,
        live: state,
        source: 'files',
        kind: found?.kind,
      };
    },
  };
}
