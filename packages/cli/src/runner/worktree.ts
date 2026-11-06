/**
 * A job's own copy of the code it answers from.
 *
 * `worktree` (the default for a git repository): a repository of its own in `jobs/<jobId>/repo`,
 * outside the checkout the team works in, holding the seat's `ref` and its history and nothing
 * else: `git init`, `git fetch <dir> <commit>`, `git checkout --detach`. Tracked files only, so an
 * untracked `.env`, a build output or a local override the team never committed is not there to be
 * read, by Claude Code or by a CLI whose reads are not confined. The answer comes from one commit,
 * which the job records.
 *
 * Not `git worktree add`, which the design first named: a worktree shares its repository's refs
 * and objects, so `git show 'stash@{0}^3:.env'` prints a stashed untracked file and `git show
 * wip:notes.txt` a local branch nobody pushed, and Claude Code's allowlist lets `git show` run. A
 * fetch copies only what the commit reaches: no stash, no other branch, no other remote's refs,
 * and no path back to the team's checkout in its config.
 *
 * `live`: the directory itself, as it is. For `crossroom join` in a CI checkout, which is already
 * a clean copy of one commit, and for a directory that is not a repository at all.
 *
 * Git runs with the repository's hooks turned off (a checkout here is the runner's, not the
 * team's, and a `post-checkout` hook would run on every job) and with none of Crossroom's own
 * environment. Nothing here ever deletes anything outside the job's directory.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export type CheckoutMode = 'worktree' | 'live';

export interface Checkout {
  /** Where the agent runs. */
  cwd: string;
  mode: CheckoutMode;
  /** The commit it answers from, or null for a directory that is not a repository. */
  commit: string | null;
  /** Remove the worktree (never the team's own directory). Harmless twice. */
  remove(): Promise<void>;
}

/** The environment git runs with: this process's, less Crossroom's own and anything git would take instructions from. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(parley_|git_dir$|git_work_tree$|git_index_file$)/i.test(k)) env[k] = v;
  // Never ask for credentials or open an editor: nothing here needs the network or a person.
  env.GIT_TERMINAL_PROMPT = '0';
  // A job's repository has no remote, so an LFS smudge filter has nowhere to fetch from: pointers stay pointers.
  env.GIT_LFS_SKIP_SMUDGE = '1';
  return env;
}

export class GitError extends Error {}

/** Run git in `cwd`, with hooks off. Resolves to stdout. */
export function git(cwd: string, args: string[], hooksDir?: string): Promise<string> {
  const pre = hooksDir ? ['-c', `core.hooksPath=${hooksDir}`] : [];
  return new Promise((resolve, reject) => {
    execFile('git', [...pre, ...args], { cwd, env: gitEnv(), windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new GitError(`git ${args[0]} failed: ${String(stderr || err.message).trim().split(/\r?\n/)[0]}`));
      resolve(String(stdout));
    });
  });
}

/** Whether `dir` is inside a git work tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** A ref the runner's own config names; one that could be read as an option is refused. */
const REF = /^[A-Za-z0-9._/@^~{}-]{1,200}$/;

/** The commit `ref` names in `dir`. */
export async function resolveCommit(dir: string, ref: string): Promise<string> {
  if (!REF.test(ref) || ref.startsWith('-')) throw new GitError(`"${ref}" is not a ref this runner will check out`);
  return (await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
}

const rmDir = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

/**
 * Prepare a job's checkout. `worktree` needs a git repository: a seat configured for one in a
 * directory that is not a repository fails here rather than quietly answering from the live one.
 */
export async function prepareCheckout(o: { dir: string; jobDir: string; mode?: CheckoutMode; ref?: string }): Promise<Checkout> {
  const dir = path.resolve(o.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new GitError(`${dir} is not a directory`);
  const repo = await isGitRepo(dir);
  const mode: CheckoutMode = o.mode ?? (repo ? 'worktree' : 'live');
  if (mode === 'live') {
    let commit: string | null = null;
    if (repo) commit = await resolveCommit(dir, 'HEAD').catch(() => null);
    return { cwd: dir, mode, commit, remove: () => Promise.resolve() };
  }
  if (!repo) throw new GitError(`${dir} is not a git repository, so it cannot be checked out as a worktree; set checkout: live`);
  const commit = await resolveCommit(dir, o.ref ?? 'HEAD');
  const jobDir = path.resolve(o.jobDir);
  const target = path.join(jobDir, 'repo');
  // Empty: no template (a team's `init.templateDir` may carry hooks) and no hooks while checking out.
  const hooks = path.join(jobDir, '.no-hooks');
  mkdirSync(hooks, { recursive: true });
  const format = (await git(dir, ['rev-parse', '--show-object-format']).catch(() => 'sha1')).trim();
  try {
    await git(jobDir, ['init', '--quiet', `--template=${hooks}`, ...(format === 'sha256' ? ['--object-format=sha256'] : []), target], hooks);
    // By path, with no remote: the new repository's config never names the team's checkout.
    await git(target, ['-c', 'protocol.version=2', 'fetch', '--quiet', '--no-tags', dir, commit], hooks);
    rmSync(path.join(target, '.git', 'FETCH_HEAD'), { force: true });
    await git(target, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit], hooks);
  } catch (e) {
    if (existsSync(target)) rmDir(target);
    throw e;
  }
  let removed = false;
  return {
    cwd: target,
    mode,
    commit,
    remove: () => {
      if (!removed) {
        removed = true;
        if (existsSync(target)) rmDir(target);
      }
      return Promise.resolve();
    },
  };
}

/** Remove a worktree git knows about, and the directory whether or not it knew. For a `repo/` an earlier build left as a `git worktree`. */
export async function removeWorktree(repoDir: string, target: string): Promise<void> {
  await git(repoDir, ['worktree', 'remove', '--force', target]).catch(() => {});
  if (existsSync(target)) rmDir(target);
  await git(repoDir, ['worktree', 'prune']).catch(() => {});
}

/** The repository a worktree belongs to, read from its `.git` file (`gitdir: <repo>/.git/worktrees/<name>`). */
export function worktreeOwner(target: string): string | null {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(path.join(target, '.git'), 'utf8'));
    if (!m) return null;
    const gitdir = path.resolve(target, m[1]!.trim());
    const i = gitdir.split(path.sep).join('/').lastIndexOf('/.git/worktrees/');
    return i < 0 ? null : gitdir.slice(0, i);
  } catch {
    return null;
  }
}

/**
 * Remove every job directory under `jobsRoot` that no live job holds: what a runner that was
 * killed, or a machine that lost power, left behind. Each worktree is removed from its own
 * repository first, so git forgets it too. Returns the ids removed.
 */
export async function sweepJobDirs(jobsRoot: string, keep: ReadonlySet<string>): Promise<string[]> {
  if (!existsSync(jobsRoot)) return [];
  const gone: string[] = [];
  for (const id of readdirSync(jobsRoot)) {
    if (keep.has(id)) continue;
    const dir = path.join(jobsRoot, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const target = path.join(dir, 'repo');
    const owner = existsSync(target) ? worktreeOwner(target) : null;
    if (owner) await removeWorktree(owner, target);
    try {
      rmDir(dir);
      gone.push(id);
    } catch {
      /* held open by something; the next boot tries again */
    }
  }
  return gone;
}

/** Remove a job's directory, its worktree first. */
export async function removeJobDir(jobDir: string, checkout?: Checkout | null): Promise<void> {
  await checkout?.remove().catch(() => {});
  const target = path.join(jobDir, 'repo');
  const owner = existsSync(target) ? worktreeOwner(target) : null;
  if (owner) await removeWorktree(owner, target);
  if (existsSync(jobDir)) rmDir(jobDir);
}
