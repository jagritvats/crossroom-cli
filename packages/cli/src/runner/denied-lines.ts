/**
 * Deny by content: an index of the lines of every file a seat's deny list covers, so a
 * packet that quotes a denied file is refused even when its source names another file, or none.
 *
 * Built once per job, from the job's checkout: what git tracks there, and what it does not (the
 * `.env` a `.gitignore` keeps out of git, a submodule's files), since a job that answers from the
 * live directory has its agent working among them whatever its runtime; a worktree made at the
 * answering commit holds none. For a runtime whose reads are not confined, the seat's live
 * directory is read too, since such an agent can reach it from a worktree. Then:
 * - every line of a denied file goes in under every key `deniedLineKeys` gives it (the line as a
 *   viewer, a diff or a quote would show it, `@parley/shared/policy`), keys of `DENIED_LINE_MIN`
 *   characters or more;
 * - every key a line of an allowed tracked file gives comes out again, so a line that is also in
 *   an allowed file (a licence header, `import React from 'react';`) never refuses a packet;
 * - `has(key)` is what `checkOutbound` asks of each key of each line of an outbound call.
 *
 * Keys are kept as 8 bytes of an HMAC-SHA256 under a key made for this index alone, so the index
 * holds no line of a denied file, and a copy of it confirms no guess about one.
 *
 * Bounds (`INDEX_BOUNDS`): 20,000 files, 1 MiB a file, 2 million lines, and 200,000 entries listed
 * among what git does not track, and again in a live directory. Past a bound in what is denied
 * (or untracked files git could not list), the index says `partial`, and the egress
 * policy refuses what could quote a file it never read (egress-policy.ts, `onPartial`). Past a bound
 * in what is allowed, it is not partial: fewer lines come out, so the index refuses more, never less.
 * A binary file (a NUL in its first 8 KiB) and a symbolic link are never read.
 *
 * The honest limit: a paraphrase of a denied line, or a line cut short of 16 characters, is not in
 * the index. The docs say so (SECURITY.md, "The deny list, and its limits").
 */
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { type Dirent, lstatSync, readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { DENIED_LINE_MIN, deniedLineKeys, deniedPaths, normaliseLine } from '@parley/shared/policy';
import { LINE_BREAK } from '@parley/shared/text';

export const INDEX_BOUNDS = { files: 20_000, bytesPerFile: 1 << 20, lines: 2_000_000, listed: 200_000 } as const;
export type IndexBounds = { -readonly [K in keyof typeof INDEX_BOUNDS]: number };

/** What `RunnerOnly.deniedLines` takes, and what the index knows about itself. */
export interface DeniedLineIndex {
  has(key: string): boolean;
  readonly partial: boolean;
  /** How many keys it holds. */
  readonly size: number;
  readonly stats: IndexStats;
}

export interface IndexStats {
  deniedFiles: number;
  allowedFiles: number;
  deniedLines: number;
  skippedBinary: number;
  skippedLinks: number;
  /** Why the index is partial, if it is: which bound, and where. Paths, never contents. */
  partial: string[];
}

/**
 * Collects keys: `addDenied` for each denied file's text, `subtractAllowed` for each allowed one's,
 * in any order (a subtraction is remembered until the end), then `build`. Tests use it directly;
 * `buildDeniedLines` feeds it from disk.
 */
export class DeniedLinesBuilder {
  private readonly secret = randomBytes(32);
  private readonly denied = new Set<string>();
  private readonly allowed = new Set<string>();
  private lines = 0;
  readonly stats: IndexStats = { deniedFiles: 0, allowedFiles: 0, deniedLines: 0, skippedBinary: 0, skippedLinks: 0, partial: [] };

  constructor(private readonly bounds: IndexBounds = { ...INDEX_BOUNDS }) {}

  /** The index's own name for a key. */
  private tag(key: string): string {
    return createHmac('sha256', this.secret).update(key, 'utf8').digest('hex').slice(0, 16);
  }

  /** A denied file's text. False once the line bound is reached (the index is then partial). */
  addDenied(text: string, where = 'a denied file'): boolean {
    this.stats.deniedFiles++;
    for (const line of text.split(LINE_BREAK)) {
      if (this.lines >= this.bounds.lines) {
        this.markPartial(`more than ${this.bounds.lines} lines in denied files, from ${where} on`);
        return false;
      }
      this.lines++;
      if (normaliseLine(line).length < DENIED_LINE_MIN) continue;
      this.stats.deniedLines++;
      for (const k of deniedLineKeys(line)) this.denied.add(this.tag(k));
    }
    return true;
  }

  /** An allowed file's text: its lines' keys stop counting as denied. */
  subtractAllowed(text: string) {
    this.stats.allowedFiles++;
    for (const line of text.split(LINE_BREAK)) {
      if (normaliseLine(line).length < DENIED_LINE_MIN) continue;
      for (const k of deniedLineKeys(line)) this.allowed.add(this.tag(k));
    }
  }

  /** How many denied keys it holds so far, before any allowed line is taken out. */
  get deniedKeys(): number {
    return this.denied.size;
  }

  markPartial(why: string) {
    if (!this.stats.partial.includes(why) && this.stats.partial.length < 20) this.stats.partial.push(why);
  }

  build(): DeniedLineIndex {
    const keys = new Set<string>();
    for (const k of this.denied) if (!this.allowed.has(k)) keys.add(k);
    this.denied.clear();
    this.allowed.clear();
    const tag = (k: string) => this.tag(k);
    const stats = { ...this.stats, partial: [...this.stats.partial] };
    return {
      has: (key: string) => typeof key === 'string' && key.length >= DENIED_LINE_MIN && keys.has(tag(key)),
      partial: stats.partial.length > 0,
      size: keys.size,
      stats,
    };
  }
}

/** An index that holds nothing: for a seat whose deny list names no file. */
export const EMPTY_INDEX: DeniedLineIndex = new DeniedLinesBuilder().build();

/**
 * The environment git runs in here: enough to find itself and its config, and nothing named like a
 * secret (the runner's own environment may hold the team's keys).
 */
function gitEnv(): NodeJS.ProcessEnv {
  const keep = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|TMP|TEMP|TMPDIR|LANG|LC_ALL|LC_CTYPE)$/i;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (keep.test(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

/** What `git -C root <args>` printed, or null when it failed (`root` is not a git checkout, say). */
function gitOut(root: string, args: readonly string[]): string | null {
  const r = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null;
}

/** The files git tracks in `root` (`git ls-files -z`), repository-relative with `/`; null when `root` is not a git checkout. */
export function trackedFiles(root: string): string[] | null {
  // Relative to `root` (no `--full-name`), which is what every read below resolves them against.
  const out = gitOut(root, ['ls-files', '-z']);
  return out === null ? null : out.split('\0').filter(Boolean);
}

/**
 * The files in a git checkout that `trackedFiles` does not name, repository-relative with `/`:
 * untracked ones, ignored ones included (the `.env` a `.gitignore` keeps out of git), and those
 * inside a submodule, which git lists as one entry. A directory git reports whole (an untracked
 * one, or a submodule) is walked (`walkFiles`) unless `skip` names it, and `limit` bounds the
 * entries listed in all; `truncated` says it was reached. A checkout made at a commit for the job
 * has none of these. The live directory has them, and an agent working there reads them whatever
 * its runtime. Null when git cannot list them.
 */
export function unlistedFiles(root: string, limit: number = INDEX_BOUNDS.listed, skip: ReadonlySet<string> = new Set()): { files: string[]; truncated: boolean } | null {
  // No `--exclude-standard`: what a `.gitignore` names is listed too. `--directory` gives a
  // directory git knows nothing of as one entry, so `node_modules/` costs one line.
  const others = gitOut(root, ['ls-files', '-z', '--others', '--directory']);
  const staged = gitOut(root, ['ls-files', '-z', '--stage']);
  if (others === null || staged === null) return null;
  const files: string[] = [];
  const dirs: string[] = [];
  for (const e of others.split('\0')) {
    if (!e) continue;
    if (e.endsWith('/')) dirs.push(e.slice(0, -1));
    else files.push(e);
  }
  // `<mode> <object> <stage>\t<path>`: mode 160000 is a submodule.
  for (const line of staged.split('\0')) {
    const tab = line.indexOf('\t');
    if (tab > 0 && line.startsWith('160000 ')) dirs.push(line.slice(tab + 1));
  }
  if (files.length > limit) return { files: files.slice(0, limit), truncated: true };
  let listed = files.length;
  for (const d of dirs) {
    // As the walk itself skips them, at any depth: `vendor/lib`, `packages/app/node_modules`.
    if (d.split('/').some((seg) => seg === '.git' || skip.has(seg))) continue;
    const walked = walkFiles(path.join(root, ...d.split('/')), limit - listed, skip);
    for (const f of walked.files) files.push(`${d}/${f}`);
    listed += walked.listed;
    if (walked.truncated) return { files, truncated: true };
  }
  return { files, truncated: false };
}

/** Whether two paths name one directory. */
const sameDir = (a: string, b: string) => path.relative(path.resolve(a), path.resolve(b)) === '';

/**
 * Directories a live checkout fills with other people's code (installed dependencies) and with
 * caches, which the walk of one does not enter unless a deny glob names them. `node_modules` alone
 * passes the listing bound in an ordinary JavaScript repository, and a walk stopped by it would
 * leave the index partial. Build output (`dist`, `build`, `target`) is walked: a team's own
 * configuration can be copied into it.
 */
export const HEAVY_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.turbo',
  '.parcel-cache',
  '.cache',
]);

/** The heavy directories a deny list does not name as a segment of any of its globs: the ones a walk may skip. */
export function skippable(deny: readonly string[]): ReadonlySet<string> {
  const named = new Set(deny.flatMap((g) => g.replace(/\\/g, '/').split('/')));
  return new Set([...HEAVY_DIRS].filter((d) => !named.has(d)));
}

/**
 * Every file under `dir`, repository-relative with `/`, not following links, never into `.git` or
 * a directory named in `skip`, up to `limit` entries. Breadth first, so the files nearest the top,
 * where a `.env` usually is, are listed before a bound is reached. `truncated` says the walk
 * stopped at the limit; `listed` is how many entries it counted against it.
 */
export function walkFiles(dir: string, limit: number = INDEX_BOUNDS.listed, skip: ReadonlySet<string> = new Set()): { files: string[]; truncated: boolean; listed: number } {
  const files: string[] = [];
  let seen = 0;
  const queue: string[] = [''];
  for (let at = 0; at < queue.length; at++) {
    const rel = queue[at]!;
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === '.git' || (e.isDirectory() && skip.has(e.name))) continue;
      if (++seen > limit) return { files, truncated: true, listed: limit };
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) queue.push(child);
      else if (e.isFile()) files.push(child);
    }
  }
  return { files, truncated: false, listed: seen };
}

type ReadResult = { text: string; truncated: boolean } | { skipped: 'binary' | 'link' | 'missing' };

/** Up to `max` bytes of a regular file inside `root` as UTF-8, never through a link, never outside `root`. */
async function readInside(root: string, rel: string, max: number): Promise<ReadResult> {
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return { skipped: 'missing' };
  try {
    // Every component, not only the file: a tracked symbolic link to a directory would otherwise
    // lead the read out of the checkout.
    let at = base;
    for (const part of path.relative(base, full).split(path.sep)) {
      at = path.join(at, part);
      if (lstatSync(at).isSymbolicLink()) return { skipped: 'link' };
    }
    if (!lstatSync(full).isFile()) return { skipped: 'missing' };
  } catch {
    return { skipped: 'missing' };
  }
  const fh = await open(full, 'r');
  try {
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fh.read(buf, 0, max + 1, 0);
    const bytes = buf.subarray(0, Math.min(bytesRead, max));
    if (bytes.subarray(0, 8192).includes(0)) return { skipped: 'binary' };
    return { text: bytes.toString('utf8'), truncated: bytesRead > max };
  } finally {
    await fh.close();
  }
}

/**
 * A repository-relative path in the one form `deniedPaths` answers with: `/` for `\`, no drive
 * letter, no `.` or empty segment, `..` applied. A match is looked up by this form, so a path given
 * as `config/./prod/db.yml` or `config\prod\db.yml` is still the denied file it names.
 */
function norm(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/|$)/, '').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export interface BuildOptions {
  /** The job's checkout: the worktree at the answering commit. */
  root: string;
  /** The seat's deny globs, as the policy holds them. */
  deny: readonly string[];
  /** The checkout's directory name, and whether paths ignore case there, as `deniedPaths` takes them. */
  repo?: string;
  nocase?: boolean;
  /**
   * The checkout's files, repository-relative. Default: what git tracks there together with what
   * it does not (`unlistedFiles`: an untracked or ignored `.env`, a submodule's files), or every
   * file under it when it is not a git checkout. So a checkout that is the live directory has its
   * untracked denied files indexed whatever the runtime: an agent working there can read them.
   */
  files?: readonly string[];
  /**
   * The seat's live directory, for a runtime whose reads are not confined to a checkout made for
   * the job: every file there the deny list covers, tracked or not, is indexed as denied too. Its
   * other files are not read.
   */
  live?: string;
  bounds?: Partial<IndexBounds>;
}

/**
 * Build a job's index from disk: denied files first, from the checkout (tracked or not) and then
 * the live directory, so the bounds are spent where they matter; then every allowed tracked file,
 * to take their lines back out.
 */
export async function buildDeniedLines(o: BuildOptions): Promise<DeniedLineIndex> {
  const bounds: IndexBounds = { ...INDEX_BOUNDS, ...o.bounds };
  const b = new DeniedLinesBuilder(bounds);
  if (!o.deny.length) return b.build();
  const opts = { nocase: !!o.nocase };

  let files = o.files ? [...o.files] : trackedFiles(o.root);
  // What git does not track in the checkout: denied ones are indexed like the live directory's,
  // and the others are not read. Left to the live walk below when that is this same directory.
  let unlisted: string[] = [];
  if (!files) {
    const walked = walkFiles(o.root, bounds.listed, skippable(o.deny));
    if (walked.truncated) b.markPartial(`more than ${bounds.listed} entries under the checkout`);
    files = walked.files;
  } else if (!o.files && !(o.live && sameDir(o.live, o.root))) {
    const u = unlistedFiles(o.root, bounds.listed, skippable(o.deny));
    if (!u) b.markPartial('the files git does not track in the checkout could not be listed');
    else {
      if (u.truncated) b.markPartial(`more than ${bounds.listed} entries git does not track under the checkout`);
      unlisted = u.files;
    }
  }
  const denied = new Set(deniedPaths(files.map(norm), o.deny, o.repo, opts));
  const deniedHere = files.filter((f) => denied.has(norm(f)));
  const allowedHere = files.filter((f) => !denied.has(norm(f)));

  const queue: { root: string; rel: string }[] = deniedHere.map((rel) => ({ root: o.root, rel }));
  if (unlisted.length) {
    const unlistedDenied = new Set(deniedPaths(unlisted, o.deny, o.repo, opts));
    for (const rel of unlisted) if (unlistedDenied.has(rel)) queue.push({ root: o.root, rel });
  }
  if (o.live) {
    const walked = walkFiles(o.live, bounds.listed, skippable(o.deny));
    if (walked.truncated) b.markPartial(`more than ${bounds.listed} entries under the live directory`);
    const liveDenied = new Set(deniedPaths(walked.files, o.deny, o.repo, opts));
    for (const rel of walked.files) if (liveDenied.has(rel)) queue.push({ root: o.live, rel });
  }

  let deniedCount = 0;
  const read = new Set<string>();
  for (const f of queue) {
    // A tracked file of a live directory given as the checkout too comes up twice: read once.
    const full = path.resolve(f.root, f.rel);
    if (read.has(full)) continue;
    read.add(full);
    if (++deniedCount > bounds.files) {
      b.markPartial(`more than ${bounds.files} denied files`);
      break;
    }
    const r = await readInside(f.root, f.rel, bounds.bytesPerFile);
    if ('skipped' in r) {
      if (r.skipped === 'binary') b.stats.skippedBinary++;
      if (r.skipped === 'link') b.stats.skippedLinks++;
      continue;
    }
    if (r.truncated) b.markPartial(`${f.rel} is larger than ${bounds.bytesPerFile} bytes`);
    if (!b.addDenied(r.text, f.rel)) break;
  }

  // Nothing denied was read (`.git`, which every policy denies, is never listed): no allowed file
  // has anything to take out, so none is read.
  if (!b.deniedKeys) return b.build();
  let allowedCount = 0;
  let allowedLines = 0;
  for (const rel of allowedHere) {
    if (++allowedCount > bounds.files || allowedLines > bounds.lines) break;
    const r = await readInside(o.root, rel, bounds.bytesPerFile);
    if ('skipped' in r || r.truncated) continue;
    allowedLines += r.text.length ? r.text.split(LINE_BREAK).length : 0;
    b.subtractAllowed(r.text);
  }
  return b.build();
}
