/**
 * Claude Code's recent sessions, read from its own records: `<config>/projects/<folder>/<id>.jsonl`,
 * one file per session. Only a bounded head and tail of each file are read, and only an allowlist
 * of fields is kept (its folder, how it was started, its title and its first prompt).
 */
import path from 'node:path';
import { isRecord, listDir, modifiedAt, parseJson, readPart, samePath, str } from './files.js';
import { SESSION_ID } from './probe.js';

/** What the probe keeps of one session. */
export interface ClaudeSessionInfo {
  sessionId: string;
  /** Its title: the one it was given, else Claude's own, else its first prompt. */
  summary: string;
  lastModified: number;
  customTitle?: string;
  firstPrompt?: string;
  cwd?: string;
}

/** The two reads the probe makes, so tests can stand one in. */
export interface ClaudeSessions {
  listSessions(options: { dir?: string; limit?: number; includeProgrammatic?: boolean }): Promise<ClaudeSessionInfo[]>;
  getSessionInfo(id: string): Promise<ClaudeSessionInfo | undefined>;
}

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
/** Files looked at for one listing, newest first: enough for any `--limit`, bounded for a large history. */
const FILES_MAX = 2000;
const PROJECTS_MAX = 2000;
const TITLE_MAX = 1000;

const SESSION_FILE = /^([0-9A-Za-z][0-9A-Za-z_-]{0,199})\.jsonl$/;

interface Read {
  info: ClaudeSessionInfo;
  /** `claude -p` and SDK programs record an `sdk-` entrypoint. */
  programmatic: boolean;
}

const lines = (text: string) => text.split('\n').map((line) => line.replace(/\r$/, ''));

function promptOf(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true || !isRecord(entry.message)) return undefined;
  const content = entry.message.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join(' ')
        : '';
  const trimmed = text.trim();
  // Commands, hook output and tool results arrive as tagged text; they are not what the person asked.
  if (!trimmed || trimmed.startsWith('<')) return undefined;
  return trimmed.slice(0, TITLE_MAX);
}

async function readSession(file: string, id: string, root: string, lastModified: number): Promise<Read | undefined> {
  const head = await readPart(file, HEAD_BYTES, { root });
  if (!head) return undefined;
  let cwd: string | undefined;
  let entrypoint: string | undefined;
  let firstPrompt: string | undefined;
  const headLines = lines(head.text);
  // A line cut by the read's end is not guessed at.
  if (!head.whole) headLines.pop();
  for (const line of headLines) {
    const entry = parseJson(line);
    if (!isRecord(entry)) continue;
    cwd ??= str(entry.cwd);
    entrypoint ??= str(entry.entrypoint, 80);
    firstPrompt ??= promptOf(entry);
    if (cwd && entrypoint && firstPrompt) break;
  }
  const tail = head.whole ? head : await readPart(file, TAIL_BYTES, { root, fromEnd: true });
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let summary: string | undefined;
  if (tail) {
    const tailLines = lines(tail.text);
    if (!tail.whole) tailLines.shift();
    for (const line of tailLines.reverse()) {
      const entry = parseJson(line);
      if (!isRecord(entry)) continue;
      if (entry.type === 'custom-title') customTitle ??= str(entry.customTitle, TITLE_MAX);
      else if (entry.type === 'ai-title') aiTitle ??= str(entry.aiTitle, TITLE_MAX);
      else if (entry.type === 'summary') summary ??= str(entry.summary, TITLE_MAX);
    }
  }
  return {
    info: {
      sessionId: id,
      summary: customTitle ?? aiTitle ?? summary ?? firstPrompt ?? '',
      lastModified,
      ...(customTitle ? { customTitle } : {}),
      ...(firstPrompt ? { firstPrompt } : {}),
      ...(cwd ? { cwd } : {}),
    },
    programmatic: entrypoint?.startsWith('sdk') === true,
  };
}

/** Claude's session records under `configDir` (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
export function claudeRecords(configDir: string): ClaudeSessions {
  const projects = path.join(configDir, 'projects');
  const sessionFiles = async () => {
    const folders = (await listDir(projects)).slice(0, PROJECTS_MAX);
    const found: { file: string; id: string; at: number }[] = [];
    for (const folder of folders) {
      for (const name of await listDir(path.join(projects, folder))) {
        const match = SESSION_FILE.exec(name);
        if (!match) continue;
        const file = path.join(projects, folder, name);
        const at = await modifiedAt(file);
        if (at !== undefined) found.push({ file, id: match[1]!, at });
      }
    }
    return found.sort((a, b) => b.at - a.at).slice(0, FILES_MAX);
  };
  return {
    async listSessions({ dir, limit = 50, includeProgrammatic = true }) {
      const out: ClaudeSessionInfo[] = [];
      for (const { file, id, at } of await sessionFiles()) {
        if (out.length >= limit) break;
        const read = await readSession(file, id, configDir, at);
        if (!read || (read.programmatic && !includeProgrammatic)) continue;
        if (dir && !(read.info.cwd && samePath(read.info.cwd, dir))) continue;
        out.push(read.info);
      }
      return out;
    },
    async getSessionInfo(id) {
      if (!SESSION_ID.test(id)) return undefined;
      for (const folder of (await listDir(projects)).slice(0, PROJECTS_MAX)) {
        const file = path.join(projects, folder, id + '.jsonl');
        const at = await modifiedAt(file);
        if (at === undefined) continue;
        return (await readSession(file, id, configDir, at))?.info;
      }
      return undefined;
    },
  };
}
