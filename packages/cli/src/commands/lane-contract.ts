/**
 * `crossroom lane contract`: contract watch. Run in the repository that owns files the other side of
 * a lane depends on (an API description, a schema, generated types), after a push: when one of those
 * files changed, it files a heads-up for the other side with what changed, so that side's agent
 * checks its own repository against the change on its next pass, with nobody typing a ticket.
 *
 * Where it runs, and with what: on the person's machine or in their CI, with git and the lane link
 * of this repository's side (`--link`, `CROSSROOM_LANE_LINK`, or the lane recorded for this
 * directory). Crossroom is never given a hook or a token for the repository: the item is filed
 * through the seat link, as that side's own agent would file it.
 *
 * Settings: `.crossroom/contract.yml` (or `--config <file>`), or `--paths` alone.
 *
 * ```yaml
 * name: api                 # optional: what the item's title says changed
 * paths:                    # git globs, from where the command runs
 *   - openapi.yaml
 *   - src/api/**
 * ignore:
 *   - "**\/*.test.ts"
 * diff: true                # put the diff of the watched files in the item, cut to fit
 * priority: 2               # optional, 1 urgent to 4 low
 * ```
 *
 * Which change: from `--base` (else the commit a GitHub Actions push event says the branch stood at
 * before, else the commit this command last looked at for this lane, kept in the data directory) to
 * `--head` (else the CI's commit, else `HEAD`). With nothing to start from, the first run only notes
 * where the branch stands.
 *
 * git matches the paths (`:(glob)` pathspecs), so no pattern is ever compiled here. A pattern may not
 * start with `:` or `-`, so the committed file can pass git neither pathspec magic nor an option, and
 * a revision may not start with `-` either.
 *
 * One item per change: the dedupe key names the contract and the head commit, so a job that runs
 * again files nothing new while that item is open.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { LANE_BODY_MAX, LANE_CITE_MAX, LANE_TITLE_MAX, type LaneFiledData, laneLinkProblem, lanePriority, type LanePriority } from '@parley/shared/lane';
import {
  CONTRACT_COMMITS_SHOWN,
  CONTRACT_FILE,
  CONTRACT_FILES_SHOWN,
  CONTRACT_PATTERNS_MAX,
  contractNameProblem,
  contractPatternProblem,
} from '@parley/shared/lane-contract';
import { oneLine } from '@parley/shared/text';
import { parse as parseYaml } from 'yaml';
import { Usage } from '../cli.js';
import type { LanePort } from './lane-mirror/engine.js';

const run = promisify(execFile);

export interface ContractConfig {
  /** '' when the repository keeps one contract and names none. */
  name: string;
  paths: string[];
  ignore: string[];
  diff: boolean;
  priority: LanePriority;
}

const KEYS = ['name', 'paths', 'ignore', 'diff', 'priority'];

function patterns(v: unknown, what: string): string[] {
  if (v === undefined || v === null || v === '') return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  if (!list.every((x) => typeof x === 'string')) throw new Usage(`${what} is a list of paths.`);
  const out = [...new Set((list as string[]).map((x) => x.trim()).filter(Boolean))];
  if (out.length > CONTRACT_PATTERNS_MAX) throw new Usage(`${what} lists at most ${CONTRACT_PATTERNS_MAX} paths.`);
  for (const p of out) {
    const problem = contractPatternProblem(p);
    if (problem) throw new Usage(`${what}: ${problem}`);
  }
  return out;
}

/** The settings for a run: the file (when there is one), then `--paths`. */
export function loadContractConfig(cwd: string, flags: Record<string, string | true | undefined>): ContractConfig {
  const file = typeof flags.config === 'string' ? path.resolve(cwd, flags.config) : path.join(cwd, CONTRACT_FILE);
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed = parseYaml(readFileSync(file, 'utf8')) as unknown;
    if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Usage(`${file} should hold settings, one per line.`);
    raw = (parsed ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(raw).filter((k) => !KEYS.includes(k));
    if (unknown.length) throw new Usage(`${file}: unknown setting ${unknown.join(', ')}. Settings: ${KEYS.join(', ')}. The lane link comes from the environment, never this file.`);
  } else if (typeof flags.config === 'string') throw new Usage(`${file} does not exist.`);
  const paths = patterns(typeof flags.paths === 'string' ? flags.paths : raw.paths, 'paths');
  if (!paths.length) throw new Usage(`Name the files the other side depends on: paths: in ${CONTRACT_FILE}, or --paths "openapi.yaml,src/api/**".`);
  const name = raw.name === undefined || raw.name === null ? '' : String(raw.name).trim();
  const nameProblem = contractNameProblem(name);
  if (nameProblem) throw new Usage(`${file}: ${nameProblem}`);
  if (raw.diff !== undefined && raw.diff !== null && typeof raw.diff !== 'boolean') throw new Usage('diff is true or false.');
  const priority = raw.priority === undefined || raw.priority === null ? 0 : lanePriority(raw.priority);
  if (priority === null) throw new Usage('priority is 1 (urgent), 2 (high), 3 (medium) or 4 (low).');
  return { name, paths, ignore: patterns(raw.ignore, 'ignore'), diff: raw.diff !== false, priority };
}

/** git, run in the repository: its output as written (a `-z` listing keeps its NULs). */
export type Git = (...args: string[]) => Promise<string>;

export const gitIn =
  (cwd: string): Git =>
  async (...args) =>
    (await run('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout;

const SHA = /^[0-9a-f]{40}$/;

/** A revision a person or a CI named, as a commit id, or null when this checkout has no such commit. */
export async function commitOf(git: Git, rev: string): Promise<string | null> {
  const r = rev.trim();
  // Never an option to git, and never more than one word of it.
  if (!r || r.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(r) || r.length > 200) throw new Usage(`${JSON.stringify(rev.slice(0, 60))} is not a commit, branch or tag name.`);
  try {
    const sha = (await git('rev-parse', '--verify', '--quiet', `${r}^{commit}`)).trim();
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed';

export interface ChangedFile {
  status: FileStatus;
  path: string;
  /** For a rename or a copy: where it was. */
  from?: string;
}

export interface ContractChange {
  base: string;
  head: string;
  files: ChangedFile[];
  /** The commits that touched a watched file, newest first: short id and subject. */
  commits: { id: string; subject: string }[];
  /** The watched files' diff, when the settings ask for it and git gave one that fits its buffer. */
  diff: string | null;
}

const STATUS: Readonly<Record<string, FileStatus>> = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied' };

/** `git diff --name-status -z` as files. A rename or a copy is followed by two paths: from, then to. */
export function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++] ?? '';
    if (!code) continue;
    const status = STATUS[code[0]!] ?? 'changed';
    if (status === 'renamed' || status === 'copied') {
      const from = parts[i++];
      const to = parts[i++];
      if (from && to) files.push({ status, path: to, from });
    } else {
      const p = parts[i++];
      if (p) files.push({ status, path: p });
    }
  }
  return files;
}

/** The pathspecs of a contract: every pattern a glob, the ignored ones excluded. */
export const pathspecs = (c: Pick<ContractConfig, 'paths' | 'ignore'>) => [...c.paths.map((p) => `:(glob)${p}`), ...c.ignore.map((p) => `:(glob,exclude)${p}`)];

/** What changed in the watched files between two commits. */
export async function contractChange(git: Git, c: ContractConfig, base: string, head: string): Promise<ContractChange> {
  const specs = pathspecs(c);
  const files = parseNameStatus(await git('diff', '--name-status', '-z', '-M', base, head, '--', ...specs));
  if (!files.length) return { base, head, files, commits: [], diff: null };
  const log = await git('log', `--format=%h%x1f%s%x1e`, '-n', String(CONTRACT_COMMITS_SHOWN + 1), `${base}..${head}`, '--', ...specs).catch(() => '');
  const commits = log
    .split('\x1e')
    .map((e) => e.trim().split('\x1f'))
    .filter(([id]) => /^[0-9a-f]{4,40}$/.test(id ?? ''))
    .map(([id, subject = '']) => ({ id: id!, subject }));
  let diff: string | null = null;
  if (c.diff) {
    // A diff past git's buffer here is left out, and the item says where to read it.
    diff = await git('diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', '-M', base, head, '--', ...specs).catch(() => null);
  }
  return { base, head, files, commits, diff };
}

/** Text from a repository as an item carries it: tabs and line breaks kept, every other control character dropped. */
export function tidy(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || (c >= 32 && c !== 127)) out += s[i];
  }
  return out;
}

const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 3).replace(/[\ud800-\udbff]$/, '')}...`);
const short = (sha: string) => sha.slice(0, 7);

/** Where the change happened, as the CI says it, for the item's words and its link. */
export interface Where {
  /** `acme/api`, or the directory's name. */
  repo: string;
  branch: string | null;
  /** The page of the change (GitHub: the comparison; Azure Repos: the head commit), when the CI names one a lane item may carry. */
  link: string | null;
}

/** A name a CI gave, as one short line of plain characters, or null. */
const plain = (v: string | undefined) => {
  const s = oneLine(v ?? '').trim();
  return s && s.length <= 200 ? s : null;
};

export function whereOf(env: NodeJS.ProcessEnv, cwd: string, base: string, head: string): Where {
  const repo = plain(env.GITHUB_REPOSITORY) ?? plain(env.BUILD_REPOSITORY_NAME) ?? path.basename(path.resolve(cwd));
  const branch = plain(env.GITHUB_REF_TYPE === 'tag' ? undefined : env.GITHUB_REF_NAME) ?? plain(env.BUILD_SOURCEBRANCHNAME);
  let link: string | null = null;
  if (env.GITHUB_REPOSITORY && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY)) {
    link = `${(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '')}/${env.GITHUB_REPOSITORY}/compare/${base}...${head}`;
  } else if (env.BUILD_REPOSITORY_URI) {
    try {
      // Azure Repos puts the organisation in the address as a user name: a link on an item carries none.
      const u = new URL(env.BUILD_REPOSITORY_URI);
      u.username = '';
      u.password = '';
      u.hash = '';
      u.search = '';
      link = `${u.href.replace(/\/+$/, '')}/commit/${head}`;
    } catch {
      link = null;
    }
  }
  return { repo, branch, link: link && !laneLinkProblem(link) ? link : null };
}

export interface ContractItem {
  title: string;
  body: string;
  expect: string;
  cite: string;
  link: string | null;
  dedupe: string;
  priority: LanePriority;
}

const fileLine = (f: ChangedFile) => (f.from ? `${f.status} ${oneLine(f.from)} -> ${oneLine(f.path)}` : `${f.status} ${oneLine(f.path)}`);

/** The heads-up for a change: what changed, the commits that did it, and as much of the diff as an item holds. */
export function composeItem(c: ContractConfig, ch: ContractChange, where: Where): ContractItem {
  const first = oneLine(ch.files[0]!.path);
  const more = ch.files.length > 1 ? ` and ${ch.files.length - 1} more` : '';
  const title = cut(`Contract changed${c.name ? ` (${c.name})` : ''}: ${first}${more} at ${short(ch.head)}`, LANE_TITLE_MAX);
  const head = [
    `Files your side depends on changed in ${where.repo}${where.branch ? ` on ${where.branch}` : ''}, from ${short(ch.base)} to ${short(ch.head)}.`,
    '',
    `Changed (${ch.files.length}):`,
    ...ch.files.slice(0, CONTRACT_FILES_SHOWN).map(fileLine),
    ...(ch.files.length > CONTRACT_FILES_SHOWN ? [`and ${ch.files.length - CONTRACT_FILES_SHOWN} more`] : []),
  ];
  if (ch.commits.length) {
    head.push('', 'Commits:', ...ch.commits.slice(0, CONTRACT_COMMITS_SHOWN).map((k) => `${k.id} ${cut(oneLine(k.subject), 120)}`));
    if (ch.commits.length > CONTRACT_COMMITS_SHOWN) head.push('and earlier ones');
  }
  const whole = where.link ? `the whole change is at ${where.link}` : `the whole change is \`git diff ${short(ch.base)} ${short(ch.head)}\` in ${where.repo}`;
  let body = tidy(head.join('\n'));
  if (c.diff) {
    if (ch.diff === null) body += `\n\nThe diff is too large to carry here: ${whole}.`;
    else {
      // Whole lines only, with room kept for the line that says where the rest is.
      const lines = tidy(ch.diff).replace(/\n+$/, '').split('\n');
      const room = LANE_BODY_MAX - body.length - 400;
      let used = 0;
      let kept = 0;
      while (kept < lines.length && used + lines[kept]!.length + 1 <= room) used += lines[kept++]!.length + 1;
      if (kept) body += `\n\nDiff:\n${lines.slice(0, kept).join('\n')}`;
      if (kept < lines.length) body += `\n\n${kept ? 'Cut here' : 'The diff does not fit here'}: ${lines.length - kept} more line${lines.length - kept === 1 ? '' : 's'}; ${whole}.`;
    }
  }
  return {
    title,
    body: body.slice(0, LANE_BODY_MAX),
    expect: 'Check your repository against this change: adapt what depends on these files, or answer that nothing does.',
    cite: cut(ch.files.map((f) => oneLine(f.path)).join(', '), LANE_CITE_MAX),
    link: where.link,
    dedupe: `contract:${c.name}:${ch.head}`,
    priority: c.priority,
  };
}

/** The commit a GitHub Actions push event says the branch stood at before, or null (another event, a new branch). */
export function eventBefore(env: NodeJS.ProcessEnv): string | null {
  if (env.GITHUB_EVENT_NAME !== 'push' || !env.GITHUB_EVENT_PATH) return null;
  try {
    const before = (JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as { before?: unknown }).before;
    return typeof before === 'string' && SHA.test(before) && !/^0+$/.test(before) ? before : null;
  } catch {
    return null;
  }
}

const stateFile = (dataDir: string) => path.join(dataDir, 'lane-contract.json');
/** A lane's contract in the state file: a digest, never the link. */
export const cursorKey = (link: string, name: string) => createHash('sha256').update(`${link}\n${name}`).digest('hex').slice(0, 24);

function readState(dataDir: string): Record<string, { head: string; at: string }> {
  try {
    const v = JSON.parse(readFileSync(stateFile(dataDir), 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, { head: string; at: string }>) : {};
  } catch {
    return {};
  }
}

function saveCursor(dataDir: string, key: string, head: string) {
  mkdirSync(dataDir, { recursive: true });
  const next = { ...readState(dataDir), [key]: { head, at: new Date().toISOString() } };
  const tmp = `${stateFile(dataDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, stateFile(dataDir));
}

export interface ContractRun {
  lane: Pick<LanePort, 'file'>;
  /** The lane link, for the state file's key only. */
  link: string;
  config: ContractConfig;
  git: Git;
  cwd: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  base?: string;
  head?: string;
  dryRun?: boolean;
}

export interface ContractResult {
  /** Where the range ran from and to; `base` null on a first run, which only notes the head. */
  base: string | null;
  head: string;
  files: number;
  /** What was filed, or would be on a dry run; null when nothing watched changed. */
  item: ContractItem | null;
  filed: LaneFiledData | null;
  primed?: true;
  dryRun?: true;
}

const SHALLOW = 'Check the repository out with its history (actions/checkout: `fetch-depth: 0`; Azure Pipelines: `fetchDepth: 0`), or name a commit this checkout has with --base.';

/** One look: the range, what changed in the watched files, and the heads-up filed for the other side. */
export async function contractOnce(o: ContractRun): Promise<ContractResult> {
  const env = o.env ?? process.env;
  const inRepo = await o.git('rev-parse', '--is-inside-work-tree').then(
    (v) => v.trim() === 'true',
    () => false,
  );
  if (!inRepo) throw new Usage(`${o.cwd} is not a git repository: run contract watch in the repository that owns the files.`);
  const headRev = o.head ?? env.GITHUB_SHA ?? env.BUILD_SOURCEVERSION ?? 'HEAD';
  const head = await commitOf(o.git, headRev);
  if (!head) throw new Usage(`This checkout has no commit ${headRev.slice(0, 60)}.`);
  const key = cursorKey(o.link, o.config.name);
  const remember = () => {
    if (!o.dryRun) saveCursor(o.dataDir, key, head);
  };

  let base: string | null = null;
  const named = o.base ?? eventBefore(env);
  if (named) {
    base = await commitOf(o.git, named);
    if (!base) throw new Usage(`This checkout has no commit ${named.slice(0, 60)}, where the change starts. ${SHALLOW}`);
  } else {
    // The commit last looked at, when this checkout still has it: a rewritten branch starts over.
    const kept = readState(o.dataDir)[key]?.head;
    if (kept && SHA.test(kept)) base = await commitOf(o.git, kept);
  }
  if (!base) {
    remember();
    return { base: null, head, files: 0, item: null, filed: null, primed: true };
  }
  if (base === head) {
    remember();
    return { base, head, files: 0, item: null, filed: null };
  }
  const change = await contractChange(o.git, o.config, base, head);
  if (!change.files.length) {
    remember();
    return { base, head, files: 0, item: null, filed: null };
  }
  const item = composeItem(o.config, change, whereOf(env, o.cwd, base, head));
  if (o.dryRun) return { base, head, files: change.files.length, item, filed: null, dryRun: true };
  const filed = await o.lane.file({
    kind: 'heads_up',
    title: item.title,
    body: item.body,
    expect: item.expect,
    cite: item.cite,
    dedupe: item.dedupe,
    ...(item.link ? { links: item.link } : {}),
    ...(item.priority ? { priority: String(item.priority) } : {}),
  });
  remember();
  return { base, head, files: change.files.length, item, filed };
}

/** What a run says it did, for the person or the CI log. Never the link. */
export function contractLines(r: ContractResult): string[] {
  const range = r.base ? `between ${short(r.base)} and ${short(r.head)}` : `at ${short(r.head)}`;
  if (r.primed) return [`First run: noted where this branch stands (${short(r.head)}). Later runs file what changed after it; --base <commit> starts from one you name.`];
  if (!r.item) return [`Nothing the other side depends on changed ${range}.`];
  const n = `${r.files} watched file${r.files === 1 ? '' : 's'} changed ${range}`;
  if (r.dryRun) return [`Would file a heads-up for the other side: ${n}.`, '', r.item.title, '', r.item.body];
  if (r.filed?.duplicate) return [`${n}: already filed as ${r.filed.id}, which is still open.`];
  return [`Filed ${r.filed?.id ?? 'a heads-up'} for the other side: ${n}.`];
}
