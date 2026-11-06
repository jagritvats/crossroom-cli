/**
 * Comparing two paths the way the file system sees them.
 *
 * Node's JS `realpathSync` follows links but keeps each name as it was written, 8.3 short names
 * included (`C:\Users\RUNNER~1\...`, Windows CI's temp directory), while git, the CLIs and
 * `realpathSync.native` print the long name. Two spellings of one folder then compared unequal: a
 * Git repository reached by its short name read as a plain folder.
 *
 * The rule: canonicalise only to compare, and never store what `canonical` returns. A registered
 * root, a chat's directory and an adopted cwd keep the spelling they were given.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';

const gone = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * The real path of `p`: links followed, 8.3 names expanded, each name in the case it is stored in.
 * Throws when `p` does not exist. The native call fails on some RAM and virtual drives (and on a
 * file it cannot open, such as one held exclusively); JS realpath still follows the links there,
 * keeping names as written.
 */
export function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch (error) {
    if (gone(error)) throw error;
    return realpathSync(p);
  }
}

/**
 * `p` resolved as far as it exists: its longest existing ancestor through `canonical`, the rest as
 * written. Throws only when a part that exists cannot be resolved.
 */
export function canonicalPrefix(p: string): string {
  const absolute = path.resolve(p);
  const rest: string[] = [];
  let head = absolute;
  for (;;) {
    let real: string;
    try {
      real = canonical(head);
    } catch (error) {
      if (!gone(error)) throw error;
      const parent = path.dirname(head);
      if (parent === head) return absolute;
      rest.unshift(path.basename(head));
      head = parent;
      continue;
    }
    return path.join(real, ...rest);
  }
}

export interface Compare {
  /** Compare without regard to case. Defaults to Windows only. */
  foldCase?: boolean;
}
const FOLD = process.platform === 'win32';

function key(p: string, foldCase: boolean) {
  return foldCase ? p.toLowerCase() : p;
}
function resolved(p: string): string {
  try {
    return canonicalPrefix(p);
  } catch {
    return path.resolve(p);
  }
}
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/**
 * Whether `a` and `b` name one location: as written, or by their real paths. A part that does not
 * exist is compared as written. Only ever widens a lexical match, for checks where a missed match is
 * the mistake; a check that must refuse when unsure calls `canonical` itself.
 */
export function sameLocation(a: string, b: string, { foldCase = FOLD }: Compare = {}): boolean {
  if (key(path.resolve(a), foldCase) === key(path.resolve(b), foldCase)) return true;
  return key(resolved(a), foldCase) === key(resolved(b), foldCase);
}

/** Whether `child` is `parent` or inside it, as written or by their real paths, like `sameLocation`. */
export function insideLocation(child: string, parent: string, { foldCase = FOLD }: Compare = {}): boolean {
  if (contains(key(path.resolve(parent), foldCase), key(path.resolve(child), foldCase))) return true;
  return contains(key(resolved(parent), foldCase), key(resolved(child), foldCase));
}
