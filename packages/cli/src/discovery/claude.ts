/**
 * Claude Code sessions on this computer.
 *
 * Live: `claude agents --json`, which Claude documents for scripting, enriched from
 * `~/.claude/sessions/<pid>.json`. That directory also holds `<pid>.<hash>.key` files, so only
 * names that are a bare pid with `.json` are opened, only when small, and only an allowlist of
 * fields is copied: never the messaging socket or the bridge session.
 * Recent: its own session records under `projects/` (claude-records.ts).
 */
import path from 'node:path';
import type { LiveSurface } from '@parley/shared/sessions';
import { resolveBin } from '../runners/adapters.js';
import { claudeRecords, type ClaudeSessions } from './claude-records.js';
import type { NativeSession } from './native.js';
import { isRecord, listDir, num, parseJson, readSmall, samePath, str } from './files.js';
import { fileTimeToMs, sameProcess } from './process.js';
import { SESSION_ID, SESSION_STATUS, type LiveHint, type LiveState, type ProbeContext, type ProbeSession, type SessionProbe } from './probe.js';

export const SESSION_FILE = /^\d+\.json$/;
const SESSION_FILE_MAX = 64 * 1024;
const SESSION_FILES_MAX = 512;
const AGENTS_TIMEOUT_MS = 6000;
const AGENTS_MAX_BYTES = 512 * 1024;

/** Where recent sessions are read from; tests stand one in. */
export type ClaudeSdk = ClaudeSessions;

/** The allowlisted copy of one live Claude process's record. */
interface LiveRecord {
  pid: number;
  sessionId: string;
  cwd?: string;
  status?: string;
  kind?: string;
  entrypoint?: string;
  procStart?: string;
  startedAt?: number;
  name?: string;
  version?: string;
}

function allowlisted(value: unknown): LiveRecord | undefined {
  if (!isRecord(value)) return undefined;
  const pid = num(value.pid);
  const sessionId = str(value.sessionId, 200);
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || !sessionId) return undefined;
  return {
    pid,
    sessionId,
    cwd: str(value.cwd),
    status: str(value.status, 40),
    kind: str(value.kind, 40),
    entrypoint: str(value.entrypoint, 80),
    procStart: str(value.procStart, 40),
    startedAt: num(value.startedAt),
    name: str(value.name, 1000),
    version: str(value.version, 80),
  };
}

export const claudeDir = (ctx: Pick<ProbeContext, 'home' | 'env'>) =>
  ctx.env.CLAUDE_CONFIG_DIR || path.join(ctx.home, '.claude');

async function sessionFiles(ctx: ProbeContext): Promise<LiveRecord[]> {
  const dir = path.join(claudeDir(ctx), 'sessions');
  const names = (await listDir(dir)).filter((name) => SESSION_FILE.test(name)).slice(0, SESSION_FILES_MAX);
  const records = await Promise.all(
    names.map(async (name) => {
      const record = allowlisted(parseJson(await readSmall(path.join(dir, name), SESSION_FILE_MAX, { root: claudeDir(ctx) })));
      // The file is named after its process; a record that names another pid is not trusted.
      return record && record.pid === Number(name.slice(0, -'.json'.length)) ? record : undefined;
    }),
  );
  return records.filter((record): record is LiveRecord => record !== undefined);
}

async function agentsCli(ctx: ProbeContext): Promise<LiveRecord[]> {
  const binary = ctx.driver().executable ?? resolveBin('claude');
  if (!binary) throw new Error('Claude Code is not on PATH');
  const out = await ctx.process.run(binary, ['agents', '--json'], { timeoutMs: AGENTS_TIMEOUT_MS, maxBytes: AGENTS_MAX_BYTES });
  const value = parseJson(out);
  if (!Array.isArray(value)) throw new Error('claude agents --json printed something other than a list');
  return value.map(allowlisted).filter((record): record is LiveRecord => record !== undefined);
}

export function claudeSurface(record: Pick<LiveRecord, 'kind' | 'entrypoint'>): LiveSurface {
  if (record.kind === 'background') return 'background';
  if (record.entrypoint === 'claude-vscode') return 'vscode';
  if (record.entrypoint === 'cli') return 'terminal';
  return 'unknown';
}

/** `claude -p` and SDK programs (a Crossroom room seat among them) record an `sdk-` entrypoint. */
const claudeKind = (record: LiveRecord): ProbeSession['kind'] => (record.entrypoint?.startsWith('sdk') ? 'exec' : 'interactive');

/** Claude records its process's creation time; on Windows that is a FILETIME, exact to the tick. */
const recordedStart = (record: LiveRecord) =>
  process.platform === 'win32' && record.procStart ? fileTimeToMs(record.procStart) : undefined;

function liveState(record: LiveRecord, procStart?: number): LiveState {
  return {
    pid: record.pid,
    ...(procStart !== undefined ? { procStart: String(procStart) } : {}),
    status: SESSION_STATUS(record.status),
    surface: claudeSurface(record),
    exit: 'pid',
  };
}

const fromNative = (session: NativeSession): ProbeSession => ({
  nativeId: session.id,
  cwd: session.cwd,
  title: session.title,
  lastActiveAt: session.updatedAt,
  live: null,
  source: 'sdk',
  nativeVersion: session.version,
});

export function claudeProbe(ctx: ProbeContext, sdk: ClaudeSdk = claudeRecords(claudeDir(ctx))): SessionProbe {
  const live = async (id: string, hint?: LiveHint): Promise<LiveState | null> => {
    if (hint?.pid) {
      if (!(await sameProcess(ctx.process, hint.pid, { start: hint.procStart ? Number(hint.procStart) : undefined }))) return null;
      const record = allowlisted(parseJson(await readSmall(path.join(claudeDir(ctx), 'sessions', hint.pid + '.json'), SESSION_FILE_MAX, { root: claudeDir(ctx) })));
      return liveState(record ?? { pid: hint.pid, sessionId: id }, hint.procStart ? Number(hint.procStart) : undefined);
    }
    for (const record of await sessionFiles(ctx)) {
      if (record.sessionId !== id || !ctx.process.alive(record.pid)) continue;
      const start = recordedStart(record);
      if (await sameProcess(ctx.process, record.pid, { start, after: start === undefined ? record.startedAt : undefined }))
        return liveState(record, start);
    }
    return null;
  };
  return {
    harness: 'claude',
    live,
    async list(options) {
      const files = await sessionFiles(ctx);
      let records: LiveRecord[];
      let liveSource: ProbeSession['source'] = 'cli';
      let detail: string | undefined;
      try {
        const byPid = new Map(files.map((record) => [record.pid, record]));
        records = (await agentsCli(ctx)).map((record) => {
          const file = byPid.get(record.pid);
          return { ...record, entrypoint: file?.entrypoint, procStart: file?.procStart, version: file?.version };
        });
      } catch {
        // Older Claude Code, or one that is not on PATH (the VS Code extension brings its own).
        liveSource = 'files';
        records = files.filter((record) => ctx.process.alive(record.pid));
      }
      if (options.directory) records = records.filter((record) => record.cwd && samePath(record.cwd, options.directory!));
      const sessions = new Map<string, ProbeSession>();
      let source: ProbeSession['source'] = liveSource;
      let truncated = false;
      if (!options.liveOnly) {
        try {
          const driver = ctx.driver();
          const listed = driver.listSessions
            ? (await driver.listSessions({ limit: options.limit, directory: options.directory, signal: options.signal })).map(fromNative)
            : (await sdk.listSessions({ dir: options.directory, limit: options.limit, includeProgrammatic: false })).map((info) =>
                fromNative({ id: info.sessionId, cwd: info.cwd, title: info.customTitle ?? info.summary, updatedAt: info.lastModified }),
              );
          for (const session of listed) sessions.set(session.nativeId, session);
          truncated = listed.length >= options.limit;
          source = 'sdk';
        } catch (error) {
          detail = 'Recent Claude sessions could not be listed: ' + (error instanceof Error ? error.message : String(error));
        }
      }
      for (const record of records) {
        const state = liveState(record, recordedStart(record));
        const known = sessions.get(record.sessionId);
        if (known) {
          known.live = state;
          known.nativeVersion ??= record.version;
          known.kind ??= claudeKind(record);
          known.lastActiveAt = Math.max(known.lastActiveAt ?? 0, record.startedAt ?? 0) || undefined;
        } else
          sessions.set(record.sessionId, {
            nativeId: record.sessionId,
            cwd: record.cwd,
            title: record.name,
            lastActiveAt: record.startedAt,
            live: state,
            source: liveSource,
            nativeVersion: record.version,
            kind: claudeKind(record),
          });
      }
      return { sessions: [...sessions.values()], source, truncated, detail };
    },
    async find(id) {
      if (!SESSION_ID.test(id)) return undefined;
      const record = (await sessionFiles(ctx)).find((entry) => entry.sessionId === id);
      const info = await sdk.getSessionInfo(id).catch(() => undefined);
      if (!record && !info) return undefined;
      let state: LiveState | null = null;
      if (record && ctx.process.alive(record.pid)) {
        const start = recordedStart(record);
        if (await sameProcess(ctx.process, record.pid, { start, after: start === undefined ? record.startedAt : undefined }))
          state = liveState(record, start ?? (await ctx.process.startedAt(record.pid)));
      }
      return {
        nativeId: id,
        cwd: info?.cwd ?? record?.cwd,
        title: info ? (info.customTitle ?? info.summary) : record?.name,
        lastActiveAt: info?.lastModified ?? record?.startedAt,
        live: state,
        source: info ? 'sdk' : 'files',
        nativeVersion: record?.version,
        ...(record ? { kind: claudeKind(record) } : {}),
      };
    },
  };
}
