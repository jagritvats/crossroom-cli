/**
 * Codex threads on this computer.
 *
 * Live: Codex keeps `thread-writer-locks/<threadId>.lock` while a thread is open, and leaves the
 * file behind when it closes, so only a held lock counts.
 * Recent: the driver's `thread/list`; when that fails, the first line of each rollout under
 * `sessions/YYYY/MM/DD/`, copied through an allowlist. That line carries the base instructions
 * and the creator's account ids, which are never copied. `auth.json` and the sandbox secrets
 * are never opened.
 */
import path from 'node:path';
import type { LiveSurface } from '@parley/shared/sessions';
import type { NativeSession } from './native.js';
import { isRecord, listDir, modifiedAt, parseJson, readFirstLine, readPart, samePath, str } from './files.js';
import type { LiveState, ProbeContext, ProbeSession, SessionProbe } from './probe.js';

const META_MAX = 256 * 1024;
const INDEX_MAX = 2 * 1024 * 1024;
const ROLLOUTS_MAX = 5000;
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** A thread id names a file here, so it can never carry a path. */
export const CODEX_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,99}$/;
const LOCK = /^([0-9A-Za-z][0-9A-Za-z_-]{0,99})\.lock$/;

export const codexDir = (env: NodeJS.ProcessEnv, home: string) => env.CODEX_HOME || path.join(home, '.codex');
export const codexLockFile = (dir: string, threadId: string) => path.join(dir, 'thread-writer-locks', threadId + '.lock');

/**
 * What a thread's recorded source and originator say about it. The desktop app records
 * `codex_work_desktop`; a subagent's source names its parent; `exec` threads are scripted runs,
 * which may be Crossroom's own room seats.
 */
export function codexOrigin(
  source: unknown,
  originator?: string,
  parentId?: string,
): { kind: 'interactive' | 'exec' | 'subagent'; surface: LiveSurface } {
  const name = typeof source === 'string' ? source : isRecord(source) ? Object.keys(source)[0] : undefined;
  if (parentId || (name && /^sub_?agent/i.test(name))) return { kind: 'subagent', surface: 'background' };
  const kind = name === 'exec' ? 'exec' : 'interactive';
  if (originator && /desktop/i.test(originator)) return { kind, surface: 'desktop' };
  if (name === 'vscode' || originator === 'codex_vscode') return { kind, surface: 'vscode' };
  if (name === 'cli' || originator === 'codex_cli_rs') return { kind, surface: 'terminal' };
  return { kind, surface: 'unknown' };
}

interface RolloutMeta {
  id: string;
  cwd?: string;
  originator?: string;
  version?: string;
  kind: 'interactive' | 'exec' | 'subagent';
  surface: LiveSurface;
}

/** The allowlisted fields of a rollout's `session_meta` line. */
function meta(line: string | undefined): RolloutMeta | undefined {
  const value = parseJson(line);
  if (!isRecord(value) || value.type !== 'session_meta' || !isRecord(value.payload)) return undefined;
  const payload = value.payload;
  const id = str(payload.id, 100);
  if (!id || !CODEX_ID.test(id)) return undefined;
  const originator = str(payload.originator, 100);
  return {
    id,
    cwd: str(payload.cwd),
    originator,
    version: str(payload.cli_version, 80),
    ...codexOrigin(payload.source, originator, str(payload.parent_thread_id, 100)),
  };
}

type Rollout = { file: string; id: string; mtime: number };
async function rollouts(dir: string): Promise<Rollout[]> {
  const root = path.join(dir, 'sessions');
  const found: { file: string; id: string }[] = [];
  const desc = (names: string[], pattern: RegExp) => names.filter((name) => pattern.test(name)).sort().reverse();
  outer: for (const year of desc(await listDir(root), /^\d{4}$/))
    for (const month of desc(await listDir(path.join(root, year)), /^\d{2}$/))
      for (const day of desc(await listDir(path.join(root, year, month)), /^\d{2}$/))
        for (const name of desc(await listDir(path.join(root, year, month, day)), ROLLOUT)) {
          found.push({ file: path.join(root, year, month, day, name), id: ROLLOUT.exec(name)![1]! });
          if (found.length >= ROLLOUTS_MAX) break outer;
        }
  // A resumed thread keeps its old file name, so recency is the file's last write.
  const stamped = await Promise.all(found.map(async (entry) => ({ ...entry, mtime: (await modifiedAt(entry.file)) ?? 0 })));
  return stamped.sort((a, b) => b.mtime - a.mtime);
}

/** Thread names from `session_index.jsonl`; a later line renames. */
async function titles(dir: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const part = await readPart(path.join(dir, 'session_index.jsonl'), INDEX_MAX, { root: dir, fromEnd: true });
  if (!part) return names;
  const lines = part.text.split('\n');
  if (!part.whole) lines.shift();
  for (const line of lines) {
    const value = parseJson(line);
    if (!isRecord(value)) continue;
    const id = str(value.id, 100);
    const name = str(value.thread_name, 1000);
    if (id && name) names.set(id, name);
  }
  return names;
}

function liveState(held: boolean | undefined, surface: LiveSurface): LiveState | null {
  if (held === false) return null;
  // Unknown (no lsof) counts as open: resuming a thread that is open elsewhere is the mistake to avoid.
  return held ? { lock: true, status: 'unknown', surface, exit: 'lock' } : { status: 'unknown', surface, exit: 'none' };
}

const fromMeta = (entry: RolloutMeta, title: string | undefined, lastActiveAt: number | undefined): ProbeSession => ({
  nativeId: entry.id,
  cwd: entry.cwd,
  title,
  lastActiveAt,
  live: null,
  source: 'files',
  nativeVersion: entry.version,
  kind: entry.kind,
  originator: entry.originator,
});

const fromNative = (session: NativeSession): ProbeSession => ({
  nativeId: session.id,
  cwd: session.cwd,
  title: session.title,
  lastActiveAt: session.updatedAt,
  live: null,
  source: 'server',
  nativeVersion: session.version,
  kind: session.kind ?? (session.parentId ? 'subagent' : 'interactive'),
  originator: session.originator,
});

export function codexProbe(ctx: ProbeContext): SessionProbe {
  const dir = codexDir(ctx.env, ctx.home);
  const surfaces = new Map<string, LiveSurface>();
  const held = async (id: string) => {
    const file = codexLockFile(dir, id);
    return (await ctx.process.locksHeld([file])).get(file);
  };
  const findMeta = async (id: string, all: Rollout[]) => {
    for (const entry of all) {
      if (entry.id !== id) continue;
      const found = meta(await readFirstLine(entry.file, META_MAX, { root: dir }));
      if (found?.id === id) return { meta: found, mtime: entry.mtime };
    }
    return undefined;
  };
  return {
    harness: 'codex',
    async live(id) {
      return CODEX_ID.test(id) ? liveState(await held(id), surfaces.get(id) ?? 'unknown') : null;
    },
    async list(options) {
      const lockDir = path.join(dir, 'thread-writer-locks');
      const lockIds = (await listDir(lockDir))
        .map((name) => LOCK.exec(name)?.[1])
        .filter((id): id is string => !!id)
        .slice(0, 2000);
      const heldFiles = await ctx.process.locksHeld(lockIds.map((id) => codexLockFile(dir, id)));
      const locks = new Map(lockIds.map((id) => [id, heldFiles.get(codexLockFile(dir, id))]));
      const sessions = new Map<string, ProbeSession>();
      let source: ProbeSession['source'] = 'files';
      let truncated = false;
      let all: Promise<Rollout[]> | undefined;
      const files = () => (all ??= rollouts(dir));
      const names = await titles(dir);
      if (!options.liveOnly) {
        const driver = ctx.driver();
        try {
          if (!driver.listSessions) throw new Error('This Codex adapter cannot list threads');
          const listed = await driver.listSessions({ limit: options.limit, directory: options.directory, signal: options.signal });
          for (const session of listed) {
            if (session.surface) surfaces.set(session.id, session.surface);
            sessions.set(session.id, fromNative(session));
          }
          truncated = listed.length >= options.limit;
          source = 'server';
        } catch {
          // Read the rollouts themselves, newest first, until enough top-level threads are found.
          let read = 0;
          for (const entry of await files()) {
            if (sessions.size >= options.limit) {
              truncated = true;
              break;
            }
            if (++read > options.limit * 4 + 100 || options.signal.aborted) break;
            const found = meta(await readFirstLine(entry.file, META_MAX, { root: dir }));
            if (!found || found.id !== entry.id || found.kind === 'subagent') continue;
            if (options.directory && !(found.cwd && samePath(found.cwd, options.directory))) continue;
            surfaces.set(found.id, found.surface);
            sessions.set(found.id, fromMeta(found, names.get(found.id), entry.mtime));
          }
        }
      }
      // A thread that is open belongs in the report even when the listing did not reach it.
      for (const [id, state] of locks) {
        if (state === false || sessions.has(id) || options.signal.aborted) continue;
        const found = await findMeta(id, await files());
        if (!found || found.meta.kind === 'subagent') continue;
        if (options.directory && !(found.meta.cwd && samePath(found.meta.cwd, options.directory))) continue;
        surfaces.set(id, found.meta.surface);
        sessions.set(id, fromMeta(found.meta, names.get(id), found.mtime));
      }
      let unknown = 0;
      for (const session of sessions.values()) {
        const state = locks.has(session.nativeId) ? locks.get(session.nativeId) : false;
        if (state === undefined) unknown++;
        session.live = liveState(state, surfaces.get(session.nativeId) ?? 'unknown');
        session.title ??= names.get(session.nativeId);
      }
      return {
        sessions: [...sessions.values()],
        source,
        truncated,
        ...(unknown
          ? { detail: 'Crossroom cannot tell which Codex threads are open on this computer (install lsof), so it offers copies of them only.' }
          : {}),
      };
    },
    async find(id) {
      if (!CODEX_ID.test(id)) return undefined;
      const found = await findMeta(id, await rollouts(dir));
      if (!found) return undefined;
      surfaces.set(id, found.meta.surface);
      const session = fromMeta(found.meta, (await titles(dir)).get(id), found.mtime);
      session.live = liveState(await held(id), found.meta.surface);
      return session;
    },
  };
}
