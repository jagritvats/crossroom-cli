/**
 * Source check: for a seat Crossroom runs, open the file a packet's source
 * names, in that seat's own directory, and count how many of the packet's lines are in the lines
 * it cites.
 *
 * Until this, a packet's source was only what its sender said. The check changes that for hosted
 * seats, whose directory the owner gave Crossroom; an attached seat's files are on a machine Crossroom
 * cannot see, so its packets stay unchecked.
 *
 * It reports counts, not a verdict. Real packets mix the file's lines with a sentence introducing
 * them, a code fence, a "..." where lines were skipped, and line numbers are often a few out. So:
 * - fences, elisions, blank and very short lines, a line naming the cited file, and a short label
 *   ending in a colon count for nothing either way;
 * - a line is found if it is one of the cited lines, give or take `SLACK`, after whitespace is
 *   collapsed; a long line is also found inside a longer file line, one cut short with "..." is
 *   found by its start, and one quoted (`> `, quotation marks, backticks) by what it quotes;
 * - `checked` means every counted line was found, `partial` some, `differs` none, and
 *   `not_found` that no cited file exists in the directory.
 *
 * `text` and `summary` packets say they are prose, so none of their lines being in the file is
 * reported as nothing rather than as `differs`. `tool_output`, `url` and `artifact` packets cite
 * something other than a file and are never checked.
 *
 * The commit form: a source may name a commit, as `git show <sha>:<path>`, `<path>@<sha>` or
 * `<path>:<lines> @ <sha>`. Then the file is read as it was at that commit, from the repository the
 * seat's directory is in, and the result records the commit's full id. Only an object id counts as
 * a commit (7 to 40 hex digits): a branch, a tag or `HEAD~1` names nothing fixed, so such a source
 * is not checked. `git show <sha> -- <path>` prints a diff, not the file, and is not checked either.
 * A commit that is not in the repository is `not_found`, unless the repository is shallow or a
 * partial clone, where a missing object says nothing and the file stays unchecked.
 *
 * Confinement: a path resolves inside the seat's directory or is not read, and so does whatever a
 * symlink points at. At a commit, a path is looked up only below the seat's directory in the
 * repository (a seat in a monorepo's `backend/` never reads `frontend/`). git is found by absolute
 * path on the server's PATH, never in the seat's directory, and run without a shell, with fixed
 * arguments: the commit and path go to `git cat-file` on stdin, where neither can start an option.
 * Its environment drops every `GIT_*` and `PARLEY_*` variable, and git may not fetch, prompt, take
 * a lock or follow replace refs; it reads objects only, never the index or the working tree, so no
 * hook, filter or textconv driver runs. Files over `MAX_BYTES`, and binary files, are
 * not read. Everything is read synchronously, since it happens while a packet is stored, and is
 * bounded so that it stays cheap: at most eight files (`parseSource`), `MAX_LINES` counted lines, and
 * `GIT_BUDGET_MS` for all the git calls of one packet (four processes at most, whatever it cites).
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ContextKind, SourceCheck } from '@parley/shared';
import { type CitedFile, parseSource } from '@parley/shared/sources';
import { canonical } from './paths.js';

export { type CitedFile, parseSource };

const MAX_BYTES = 1024 * 1024;
/** Lines around a cited range that still count: line numbers are often a few out. */
const SLACK = 5;
/** Counted body lines at most; a packet is at most 60,000 characters anyway. */
const MAX_LINES = 500;
/** Normalised lines shorter than this (`}`, `]);`) match anywhere, so they count for nothing. */
const MIN_CHARS = 4;
/** A line this long may also be found inside a longer line of the file. */
const SUBSTRING_MIN = 12;
/** Past this many cited lines, only whole lines are compared, to keep the check cheap. */
const SUBSTRING_MAX_WINDOW = 3000;
/** All the git calls one packet's check may make, together. The packet is stored after them. */
const GIT_BUDGET_MS = 3000;
/** A commit as a source may name one: an abbreviated or full object id, and nothing else. */
const SHA = /^[0-9a-f]{7,40}$/;

const CHECKED_KINDS: ReadonlySet<ContextKind> = new Set(['code', 'file_excerpt', 'log', 'schema', 'text', 'summary']);
const PROSE_KINDS: ReadonlySet<ContextKind> = new Set(['text', 'summary']);

const normalise = (line: string) => line.replace(/\s+/g, ' ').trim();

/** `  12\tcode`, `12: code`, `12 | code`: line numbers an agent copied from a viewer. */
const NUMBERED = /^\s*\d+(?:\t| ?[:|] ?)/;
const FENCE = /^(```|~~~)/;
/** "CheckoutRequest schema:", "Client:": a short label, with no code in it, introducing lines. */
const LABEL = /^[^`=(){}[\];"'<>]{1,48}:$/;
const ELISION = /^(\.\.\.|…|\[\.\.\.\]|(\/\/|#|--|\*|\/\*|<!--)\s*(\.\.\.|…).*)$/;

/** The body lines worth looking for, numbers stripped when most lines carry them. */
export function countedLines(body: string): string[] {
  let lines = body.split(/\r\n|[\n\r]/);
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length >= 2 && nonEmpty.filter((l) => NUMBERED.test(l)).length >= nonEmpty.length * 0.6) {
    lines = lines.map((l) => l.replace(NUMBERED, ''));
  }
  return lines
    .map(normalise)
    .filter((l) => l.length >= MIN_CHARS && !FENCE.test(l) && !ELISION.test(l))
    .slice(0, MAX_LINES);
}

type Resolved = { file: string } | { missing: true } | { refused: true };

/** `real` is inside `root`, and is not `root` itself. */
function inside(root: string, real: string): boolean {
  const rel = path.relative(root, real);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function resolveInside(root: string, cited: string): Resolved {
  const tryPath = (p: string): Resolved => {
    const target = path.resolve(root, p);
    if (!inside(root, target)) return { refused: true };
    let real: string;
    try {
      // Both sides through `canonical`: JS realpath keeps an 8.3 root as written but prints a link's
      // target long, and the two would then disagree about a file inside.
      real = canonical(target);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { missing: true } : { refused: true };
    }
    // A symlink inside the directory that points out of it.
    if (!inside(root, real)) return { refused: true };
    try {
      const st = statSync(real);
      return st.isFile() && st.size <= MAX_BYTES ? { file: real } : { refused: true };
    } catch {
      return { refused: true };
    }
  };
  const clean = cited.replace(/\\/g, '/').replace(/^\.\//, '');
  const first = tryPath(clean);
  // "payments/src/charge.js" from the seat whose directory is payments/.
  const parts = clean.split('/');
  if ('missing' in first && parts.length > 1 && parts[0] === path.basename(root)) {
    const again = tryPath(parts.slice(1).join('/'));
    if (!('missing' in again)) return again;
  }
  return first;
}

// ---------------- the commit form ----------------

/** One cited file at a commit: its bytes, or missing (at a commit that exists, if `commit`), or not read. */
type AtCommit = { buf: Buffer; commit: string } | { missing: true; commit?: string } | { refused: true };

type Answer = { oid: string; type: string; size: number } | 'missing' | 'unknown';

/**
 * The environment git runs in: the server's, without anything that could point git elsewhere
 * (`GIT_DIR`, `GIT_CONFIG_PARAMETERS`...) or that is Crossroom's own, and with every way for a read to
 * reach the network or a person, write a lock, or read a replacement object turned off.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|PARLEY_)/i.test(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
}

let gitPath: string | null | undefined;

/**
 * git as an absolute path, found once on the server's PATH. Only absolute entries count, so the
 * seat's directory is never searched and a repository holding its own `git.exe` is never run in
 * git's place; and only the executable itself, never a `.cmd`, which needs a shell.
 */
function gitBin(): string | null {
  if (gitPath !== undefined) return gitPath;
  gitPath = null;
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(dir)) continue;
    const full = path.join(dir, name);
    try {
      accessSync(full, constants.X_OK);
      if (statSync(full).isFile()) return (gitPath = full);
    } catch {
      /* keep looking */
    }
  }
  return gitPath;
}

/** git's stdout, or null when it failed, is missing, or ran out of the check's time. No shell, ever. */
function runGit(cwd: string, deadline: number, args: string[], input?: string, maxBuffer = 256 * 1024): Buffer | null {
  const bin = gitBin();
  const timeout = deadline - Date.now();
  if (!bin || timeout <= 0) return null;
  try {
    // `protocol.allow=never` stops a partial clone's lazy fetch on a git older than GIT_NO_LAZY_FETCH.
    return execFileSync(bin, ['-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args], {
      cwd,
      env: gitEnv(),
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      timeout,
      maxBuffer,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/**
 * Where a cited path may be in the repository, as paths from its top. `git show <sha>:<path>`
 * names one place, the one git itself reads. Any other form is read from the seat's directory
 * first, then from the top, then without the directory's own name in front. Only paths below the
 * seat's directory are ever returned, so a commit reaches no file the working-tree check would
 * refuse.
 */
function repoPaths(root: string, prefix: string, c: CitedFile): string[] {
  const cited = c.path.replace(/\\/g, '/');
  const clean = cited.replace(/^\.\//, '');
  const out = new Set<string>();
  const add = (fromSeat: string) => {
    const target = path.resolve(root, fromSeat);
    if (!inside(root, target)) return;
    const p = prefix + path.relative(root, target).split(path.sep).join('/');
    // One query per line on git's stdin.
    if (!/[\0\r\n]/.test(p)) out.add(p);
  };
  if (c.fromTop) {
    // From the seat's directory, where Crossroom runs the seat, only with `./` or `../` in front. A
    // path from the top that is not below the seat is not read, and nothing else is tried: in a
    // monorepo the seat's `package.json` is not the one git showed.
    if (/^\.\.?\//.test(cited)) add(clean);
    else if (clean.startsWith(prefix)) add(clean.slice(prefix.length));
    return [...out];
  }
  add(clean);
  if (prefix && clean.startsWith(prefix)) add(clean.slice(prefix.length));
  const parts = clean.split('/');
  if (parts.length > 1 && parts[0] === path.basename(root)) add(parts.slice(1).join('/'));
  return [...out];
}

/** One line of `git cat-file --batch-check`. */
function answer(raw: string | undefined): Answer {
  const line = raw?.replace(/\r$/, '');
  const m = line?.match(/^([0-9a-f]{40}|[0-9a-f]{64}) (blob|tree|commit|tag) (\d+)$/);
  if (m) return { oid: m[1]!, type: m[2]!, size: Number(m[3]) };
  return line?.endsWith(' missing') ? 'missing' : 'unknown';
}

/** `git cat-file --batch` output: each blob asked for, in order, until anything is not as expected. */
function blobs(out: Buffer, oids: string[]): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  let at = 0;
  for (const oid of oids) {
    const nl = out.indexOf(10, at);
    if (nl < 0) break;
    const head = out.toString('latin1', at, nl).match(/^([0-9a-f]+) blob (\d+)$/);
    if (!head || head[1] !== oid) break;
    const start = nl + 1;
    const end = start + Number(head[2]);
    if (end > out.length) break;
    found.set(oid, out.subarray(start, end));
    at = end + 1;
  }
  return found;
}

/**
 * Every cited file that names a commit, read at it. A file missing from the result was not read:
 * the directory is not in a git repository, git is not installed or failed, the commit is
 * ambiguous, or a missing object says nothing because the repository is shallow or partial.
 */
function readAtCommits(root: string, cited: CitedFile[]): Map<CitedFile, AtCommit> {
  const out = new Map<CitedFile, AtCommit>();
  const wanted = cited.filter((c) => c.commit && SHA.test(c.commit));
  if (!wanted.length) return out;
  const deadline = Date.now() + GIT_BUDGET_MS;
  // git works out where the seat is in the repository from its cwd, so it gets the directory as the
  // disk spells it: on Windows an owner may have typed `backend` for `Backend`.
  let cwd = root;
  try {
    cwd = realpathSync.native(root);
  } catch {
    /* keep root */
  }
  const info = runGit(cwd, deadline, ['rev-parse', '--is-inside-work-tree', '--is-shallow-repository', '--show-prefix']);
  const [inTree, shallow, prefix = ''] = info ? info.toString('utf8').split('\n').map((l) => l.replace(/\r$/, '')) : [];
  if (inTree !== 'true') return out;

  const files = wanted.map((c) => ({ c, paths: repoPaths(root, prefix, c) }));
  const commitQuery = (c: CitedFile) => `${c.commit}^{commit}`;
  const queries = [...new Set(files.flatMap(({ c, paths }) => [commitQuery(c), ...paths.map((p) => `${commitQuery(c)}:${p}`)]))];
  const checked = runGit(cwd, deadline, ['cat-file', '--batch-check'], `${queries.join('\n')}\n`);
  if (!checked) return out;
  const lines = checked.toString('utf8').split('\n');
  const answers = new Map(queries.map((q, i) => [q, answer(lines[i])]));

  // "Not there" is only worth saying where every object would be: not a shallow clone, whose
  // history stops, and not a partial one, whose blobs arrive on demand. Partial is git's own test
  // (`repo_has_promisor_remote`): `extensions.partialClone`, or any remote with `promisor` set,
  // which is all a current `clone --filter` writes. Anything unclear counts as partial.
  let complete: boolean | undefined;
  const trustMissing = () => {
    if (complete === undefined) {
      const config = shallow === 'true' ? null : runGit(cwd, deadline, ['config', '--list']);
      complete =
        config !== null && !/^(?:extensions\.partialclone=.|remote\..+\.promisor(?:$|=(?!(?:false|no|off|0)?\r?$)))/im.test(config.toString('utf8'));
    }
    return complete;
  };

  const chosen = new Map<CitedFile, { oid: string; size: number; commit: string }>();
  for (const { c, paths } of files) {
    // Every way it could be read leads out of the seat's directory, whatever the commit.
    if (!paths.length) {
      out.set(c, { refused: true });
      continue;
    }
    const commit = answers.get(commitQuery(c));
    if (commit === 'missing') {
      if (trustMissing()) out.set(c, { missing: true });
      continue;
    }
    // Ambiguous, or anything else git answered: not checked. git resolves a short id as a branch or
    // tag of that name before it tries objects, so the commit must also start with the id cited.
    if (!commit || commit === 'unknown' || commit.type !== 'commit' || !commit.oid.startsWith(c.commit!)) continue;
    let settled = false;
    for (const p of paths) {
      const a = answers.get(`${commitQuery(c)}:${p}`);
      if (a === 'missing') continue;
      settled = true;
      if (a && a !== 'unknown' && a.type === 'blob' && a.size <= MAX_BYTES) chosen.set(c, { oid: a.oid, size: a.size, commit: commit.oid });
      else out.set(c, { refused: true });
      break;
    }
    if (!settled && trustMissing()) out.set(c, { missing: true, commit: commit.oid });
  }
  if (!chosen.size) return out;

  const sizes = new Map([...chosen.values()].map((x) => [x.oid, x.size]));
  const oids = [...sizes.keys()];
  const total = [...sizes.values()].reduce((n, s) => n + s, 0);
  const read = runGit(cwd, deadline, ['cat-file', '--batch'], `${oids.join('\n')}\n`, total + oids.length * 128 + 1024);
  const bufs = read ? blobs(read, oids) : new Map<string, Buffer>();
  for (const [c, { oid, commit }] of chosen) {
    const buf = bufs.get(oid);
    if (buf) out.set(c, { buf, commit });
  }
  return out;
}

/** The cited lines of one file, widened by SLACK, or all of it. Null for a binary file. */
function citedLines(buf: Buffer, ranges: Array<[number, number]>): string[] | null {
  if (buf.subarray(0, 8000).includes(0)) return null;
  const all = buf.toString('utf8').split(/\r\n|[\n\r]/);
  if (!ranges.length) return all.map(normalise);
  const keep = new Set<number>();
  for (const [a, b] of ranges) {
    for (let i = Math.max(1, a - SLACK); i <= Math.min(all.length, b + SLACK); i++) keep.add(i - 1);
  }
  return [...keep].sort((x, y) => x - y).map((i) => normalise(all[i]!));
}

/** The one commit every file came from, or undefined when one came from the working tree or they differ. */
function oneCommit(places: Array<string | undefined>): string | undefined {
  const first = places[0];
  return first && places.every((p) => p === first) ? first : undefined;
}

/**
 * Check one packet. `root` is the seat's working directory. Null when there was nothing Crossroom
 * could check: an attached seat is never passed here, but a source that is not a file, a kind
 * that cites none, a directory that does not exist, or a body with no line worth looking for all
 * give null too, as does a prose packet none of whose lines are in the file.
 *
 * `commit` is set when every file counted (read, or for `not_found` missing) was looked up at the
 * same commit. A source that mixes the working tree with a commit, or two commits, records none.
 */
export function checkSource(root: string, source: string | null, body: string, kind: ContextKind): SourceCheck | null {
  if (!CHECKED_KINDS.has(kind)) return null;
  const cited = parseSource(source);
  if (!cited.length) return null;
  let realRoot: string;
  try {
    realRoot = canonical(root);
  } catch {
    return null;
  }

  const atCommit = readAtCommits(realRoot, cited);
  const exact = new Set<string>();
  const window: string[] = [];
  const readAt: Array<string | undefined> = [];
  const missingAt: Array<string | undefined> = [];
  for (const c of cited) {
    let buf: Buffer;
    let commit: string | undefined;
    if (c.commit) {
      const r = atCommit.get(c);
      if (r && 'missing' in r) missingAt.push(r.commit);
      if (!r || !('buf' in r)) continue;
      buf = r.buf;
      commit = r.commit;
    } else {
      const r = resolveInside(realRoot, c.path);
      if ('missing' in r) missingAt.push(undefined);
      if (!('file' in r)) continue;
      buf = readFileSync(r.file);
    }
    const lines = citedLines(buf, c.ranges);
    if (!lines) continue;
    readAt.push(commit);
    for (const l of lines) {
      if (!l) continue;
      exact.add(l);
      window.push(l);
    }
  }
  const read = readAt.length;
  const at = (places: Array<string | undefined>) => {
    const commit = oneCommit(places);
    return commit ? { commit } : {};
  };
  if (!read) return missingAt.length ? { status: 'not_found', found: 0, of: 0, files: missingAt.length, ...at(missingAt) } : null;

  const names = cited.flatMap((c) => {
    const p = c.path.replace(/\\/g, '/');
    return [p.toLowerCase(), p.split('/').at(-1)!.toLowerCase()];
  });
  const substrings = window.length <= SUBSTRING_MAX_WINDOW;
  const matches = (line: string) => {
    if (exact.has(line)) return true;
    if (!substrings) return false;
    const cut = line.replace(/\s*(\.\.\.|…)$/, '');
    if (cut !== line && cut.length >= MIN_CHARS) return window.some((w) => w.startsWith(cut));
    return line.length >= SUBSTRING_MIN && window.some((w) => w.includes(line));
  };
  // The same line quoted: `> line`, "line", `line`, as agents wrap a sentence from a document.
  const isFound = (line: string) => {
    if (matches(line)) return true;
    const bare = line.replace(/^>\s?/, '').replace(/^["“'`](.*)["”'`]$/, '$1').trim();
    return bare !== line && bare.length >= MIN_CHARS && matches(bare);
  };

  let found = 0;
  let of = 0;
  for (const line of countedLines(body)) {
    if (isFound(line)) {
      found++;
      of++;
    } else if (!names.some((n) => line.toLowerCase().includes(n)) && !LABEL.test(line)) {
      // A line naming the cited file ("src/a.ts:17", "From docs/api.yaml §3.2:"), or a short
      // label ending in a colon ("CheckoutRequest schema:"), introduces the excerpt; it is not
      // claimed to be in the file.
      of++;
    }
  }
  if (!of) return null;
  if (found === of) return { status: 'checked', found, of, files: read, ...at(readAt) };
  if (found) return { status: 'partial', found, of, files: read, ...at(readAt) };
  return PROSE_KINDS.has(kind) ? null : { status: 'differs', found, of, files: read, ...at(readAt) };
}
