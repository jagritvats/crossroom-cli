/**
 * The only way discovery reads another program's files. Every read is bounded, and a name that
 * could hold a credential is refused before anything is opened: discovery walks the person's real
 * home directory, beside sign-in tokens, session keys and service passwords it must never touch.
 *
 * A name is only what a directory says, so every read also names the harness's own directory it
 * must stay in. The file is resolved (links, junctions, 8.3 names) and must lie inside that
 * directory's own resolved path, be a regular file, and not resolve to a refused name; the file
 * opened must be the one checked.
 */
import { constants } from 'node:fs';
import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { insideLocation, sameLocation } from '../paths.js';

/** Names discovery never opens, whatever directory they sit in. */
const FORBIDDEN = [
  /\.key$/i,
  /\.pem$/i,
  /^auth\.json$/i,
  /credential/i,
  /secret/i,
  /token/i,
  /password/i,
  /^service\.json$/i,
  /^\.env/i,
];

/**
 * A name as Windows resolves it, in one case: an NTFS stream suffix (`auth.json::$DATA` opens
 * `auth.json`) and trailing dots and spaces (`auth.json.` too) are dropped before any test. The
 * last segment is taken after either separator on every platform: on POSIX `path.basename` keeps
 * `C:\x\auth.json:s` whole, and the stream cut then left `c`, which no pattern refuses.
 */
export function normalizedName(file: string): string {
  let name = path.win32.basename(file);
  const stream = name.indexOf(':');
  if (stream >= 0) name = name.slice(0, stream);
  return name.replace(/[. ]+$/, '').toLowerCase();
}

export function forbidden(file: string): boolean {
  const name = normalizedName(file);
  return FORBIDDEN.some((pattern) => pattern.test(name));
}

export class ForbiddenFile extends Error {
  constructor() {
    super('Discovery does not open credential files.');
  }
}

/** Where a read must stay: the harness's own directory, such as `~/.claude`. */
export interface ReadScope {
  root: string;
}
/**
 * Whether two stats name one file: the same inode on the same device. Node 22.13 on Windows gives
 * `dev` 0n from a stat by path, while a stat of the open handle carries the volume's serial (22.22
 * gives the serial from both), so on Windows alone a 0n device is taken as unknown, never as a
 * match on its own: the inode must still be equal.
 */
export function sameFile(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }, platform: NodeJS.Platform = process.platform): boolean {
  if (a.ino !== b.ino) return false;
  return a.dev === b.dev || (platform === 'win32' && (a.dev === 0n || b.dev === 0n));
}

/** Never follow a link the final name was swapped for, and never wait on a pipe. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Opens `file` for reading only when it resolves inside `root` to a regular file with an allowed
 * name, and is still that file once open; otherwise undefined. A refused name throws before any
 * file system call.
 */
async function openWithin(file: string, scope: ReadScope): Promise<FileHandle | undefined> {
  if (forbidden(file)) throw new ForbiddenFile();
  let real: string;
  let root: string;
  try {
    [real, root] = await Promise.all([realpath(file), realpath(scope.root)]);
  } catch {
    return undefined;
  }
  // A link named like a session file can point at anything: what it resolves to is held to the
  // same rules, and to the harness's own directory.
  if (forbidden(real) || !within(real, root)) return undefined;
  let checked;
  try {
    checked = await stat(real, { bigint: true });
  } catch {
    return undefined;
  }
  if (!checked.isFile()) return undefined;
  let handle: FileHandle | undefined;
  try {
    handle = await open(real, OPEN_FLAGS);
    const opened = await handle.stat({ bigint: true });
    if (opened.isFile() && sameFile(opened, checked)) return handle;
  } catch {
    /* Gone, or not readable. */
  }
  await handle?.close().catch(() => {});
  return undefined;
}

/** The whole file as text, or undefined when it is missing, unreadable or larger than `maxBytes`. */
export async function readSmall(file: string, maxBytes: number, scope: ReadScope): Promise<string | undefined> {
  const handle = await openWithin(file, scope);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    if (size > maxBytes) return undefined;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** At most `maxBytes` from the start (or, with `fromEnd`, the end) of a file. */
export async function readPart(file: string, maxBytes: number, scope: ReadScope & { fromEnd?: boolean }): Promise<{ text: string; whole: boolean } | undefined> {
  const handle = await openWithin(file, scope);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, scope.fromEnd ? size - length : 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), whole: length === size };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The first line of a file, when it ends within `maxBytes`; a longer line is not guessed at. */
export async function readFirstLine(file: string, maxBytes: number, scope: ReadScope): Promise<string | undefined> {
  const part = await readPart(file, maxBytes, scope);
  if (!part) return undefined;
  const end = part.text.indexOf('\n');
  if (end >= 0) return part.text.slice(0, end).replace(/\r$/, '');
  return part.whole ? part.text : undefined;
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export async function modifiedAt(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

export function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const str = (value: unknown, max = 4096): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
export const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
export const time = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
};

/** Folders here are compared without case where the platform's usual file system ignores it. */
const foldCase = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Same directory, the way this platform compares paths, as written or by real path: a session
 * records its cwd as its CLI saw it, which may be the long name of a folder asked for by its 8.3
 * name, or the target of a link.
 */
export function samePath(a: string, b: string): boolean {
  return sameLocation(a, b, { foldCase });
}

/** True when `child` is `parent` or inside it, as written or by real path, like `samePath`. */
export function insidePath(child: string, parent: string): boolean {
  return insideLocation(child, parent, { foldCase });
}

/** True when `child` is `parent` or inside it, read lexically: for paths already resolved. */
export function within(child: string, parent: string): boolean {
  const fold = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  const relative = path.relative(fold(path.resolve(parent)), fold(path.resolve(child)));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
