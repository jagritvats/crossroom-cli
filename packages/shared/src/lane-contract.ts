/**
 * Contract watch for a lane (`@parley/shared/lane-contract`): the files one side's repository keeps
 * that the other side depends on (an API description, a schema, generated types), and what the
 * person copies to have every push that changes one of them filed as a heads-up for the other side.
 *
 * `crossroom lane contract` does the work, in the repository of the side that owns the files, on
 * that person's machine or in their CI: it reads the change with git and files the item through the
 * lane link. Nothing here holds, asks for or sends a credential. This module only names the limits
 * and writes text for the person to copy: `.crossroom/contract.yml`, and a CI job that runs the
 * command on each push to the default branch.
 *
 * No zod, so the web app imports it as it is.
 */
import { yamlScalar } from './lane-mirror.js';

/** The settings file, in the repository whose files are watched. Committed; it never holds a link or a token. */
export const CONTRACT_FILE = '.crossroom/contract.yml';

/** Patterns a contract may list (`paths` and `ignore`, each), and how long one may be. */
export const CONTRACT_PATTERNS_MAX = 50;
export const CONTRACT_PATTERN_MAX = 200;
/** A contract's name: what the item's title says changed, when a repository keeps more than one. */
export const CONTRACT_NAME_MAX = 40;
/** Changed files and commits an item lists by name; the rest are counted. */
export const CONTRACT_FILES_SHOWN = 60;
export const CONTRACT_COMMITS_SHOWN = 20;

export interface ContractSetup {
  /** Optional: `api`, `events schema`. */
  name?: string;
  /** What the other side depends on, as git globs from the repository's root: `openapi.yaml`, `src/api/**`. */
  paths: string[];
  /** Files under `paths` that are no part of the contract: `**\/*.test.ts`. */
  ignore?: string[];
  /** Put the change itself (the diff of the watched files, cut to fit an item) in the item. On by default. */
  diff?: boolean;
  /** The item's priority, 1 urgent to 4 low; 0 or absent for none. */
  priority?: number;
}

/**
 * Why a pattern can't be watched, or null when it can. A pattern is a path or a git glob (`*` within
 * a directory, `**` across them), relative to where the command runs. One that starts with `:` would
 * be read by git as pathspec magic of its own, `-` as an option, and `/` or `..` leave the repository.
 */
export function contractPatternProblem(raw: string): string | null {
  const p = raw.trim();
  if (!p) return 'A path is empty.';
  if (p.length > CONTRACT_PATTERN_MAX) return `A path is at most ${CONTRACT_PATTERN_MAX} characters.`;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 32 || c === 127) return 'A path may not hold a control character.';
  }
  if (p.startsWith(':') || p.startsWith('-')) return `${p.slice(0, 40)}: a path may not start with ":" or "-".`;
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return `${p.slice(0, 40)}: paths are relative to the repository, never absolute.`;
  if (p.split(/[\\/]/).includes('..')) return `${p.slice(0, 40)}: a path may not climb out of the repository with "..".`;
  return null;
}

/** Why a name can't be used, or null. Letters, digits, spaces and `._-`, starting with a letter or digit. */
export function contractNameProblem(raw: string): string | null {
  const n = raw.trim();
  if (!n) return null;
  if (n.length > CONTRACT_NAME_MAX) return `name is at most ${CONTRACT_NAME_MAX} characters.`;
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(n) ? null : 'name takes letters, digits, spaces, dots, dashes and underscores.';
}

/** Why a setup can't be written yet, or null. */
export function contractSetupProblem(s: ContractSetup): string | null {
  const paths = s.paths.map((p) => p.trim()).filter(Boolean);
  if (!paths.length) return 'Name at least one path the other side depends on.';
  if (paths.length > CONTRACT_PATTERNS_MAX || (s.ignore?.length ?? 0) > CONTRACT_PATTERNS_MAX) return `A contract lists at most ${CONTRACT_PATTERNS_MAX} paths.`;
  for (const p of [...paths, ...(s.ignore ?? []).map((x) => x.trim()).filter(Boolean)]) {
    const problem = contractPatternProblem(p);
    if (problem) return problem;
  }
  return contractNameProblem(s.name ?? '');
}

/** A pattern as a YAML list item: quoted whenever YAML would read `*`, `!` or a leading bracket as its own. */
const yamlPattern = (p: string) => (/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(p) ? yamlScalar(p) : JSON.stringify(p));

/** `.crossroom/contract.yml` for a setup. */
export function contractYaml(s: ContractSetup): string {
  const clean = (l: string[] | undefined) => (l ?? []).map((p) => p.trim()).filter(Boolean);
  const lines = ['# Crossroom contract watch: a push that changes one of these files is filed as a heads-up', "# for the other side of the lane. The lane link comes from the environment, never this file."];
  const name = s.name?.trim();
  if (name) lines.push(`name: ${yamlScalar(name)}`);
  lines.push('paths:', ...clean(s.paths).map((p) => `  - ${yamlPattern(p)}`));
  const ignore = clean(s.ignore);
  if (ignore.length) lines.push('ignore:', ...ignore.map((p) => `  - ${yamlPattern(p)}`));
  if (s.diff === false) lines.push('diff: false');
  if (s.priority) lines.push(`priority: ${s.priority}`);
  return `${lines.join('\n')}\n`;
}

/** The commands, in the repository that owns the files: what it would file first, then filing. */
export const contractCommands = (): string[] => ['crossroom lane contract --dry-run --base HEAD~1', 'crossroom lane contract'];

/**
 * A GitHub Actions workflow that runs the watch on every push to the default branch. The push event
 * names the commit the branch stood at before, so the job keeps no state; the checkout takes the
 * whole history, because that commit is not in a shallow one.
 */
export function contractWorkflow(branch = 'main'): string[] {
  return [
    '# .github/workflows/crossroom-contract.yml',
    'name: crossroom contract watch',
    'on:',
    `  push: { branches: [${branch}] }`,
    'permissions: { contents: read }',
    'concurrency: { group: crossroom-contract, cancel-in-progress: false }',
    'jobs:',
    '  contract:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with: { fetch-depth: 0 }',
    '      - uses: actions/setup-node@v4',
    '        with: { node-version: 22 }',
    '      - run: npx --yes crossroom lane contract',
    '        env:',
    '          CROSSROOM_LANE_LINK: ${{ secrets.CROSSROOM_LANE_LINK }}',
  ];
}

/**
 * The same as an Azure Pipelines job. Azure names no earlier commit, so the command keeps the commit
 * it last looked at in its data directory, which the pipeline's cache carries between runs; the
 * first run only notes where the branch stands.
 */
export function contractPipeline(branch = 'main', stateDir = '.crossroom-lane-state'): string[] {
  return [
    '# azure-pipelines-crossroom-contract.yml',
    `trigger: { branches: { include: [${branch}] } }`,
    'pool: { vmImage: ubuntu-latest }',
    'variables:',
    `  PARLEY_DATA: $(Pipeline.Workspace)/${stateDir}`,
    'steps:',
    '  - checkout: self',
    '    fetchDepth: 0',
    '  - task: Cache@2',
    '    inputs:',
    "      key: '\"crossroom-contract\" | \"$(Build.BuildId)\"'",
    "      restoreKeys: '\"crossroom-contract\"'",
    '      path: $(PARLEY_DATA)',
    '  - task: NodeTool@0',
    "    inputs: { versionSpec: '22.x' }",
    '  - script: npx --yes crossroom lane contract',
    '    env:',
    '      CROSSROOM_LANE_LINK: $(CROSSROOM_LANE_LINK)',
  ];
}

/** `crossroom lane ci contract`: both jobs, and what they need. */
export function contractRecipes(): string {
  return [
    'Run contract watch in CI, in the repository that owns the files the other side depends on. Each',
    'push to the default branch that changes one of them files a heads-up for the other side, with what',
    `changed. The paths come from ${CONTRACT_FILE}, committed. The one secret is`,
    "CROSSROOM_LANE_LINK, the lane link of this repository's side (`crossroom lane list` prints it):",
    "store it in the CI's secret store, never in the repository.",
    '',
    ...contractWorkflow(),
    '',
    ...contractPipeline(),
    '',
    'GitHub Actions tells the job where the branch stood before the push. Azure Pipelines does not, so',
    "there the command remembers the last commit it looked at (a commit id, in the pipeline's cache) and",
    'its first run only notes where the branch stands.',
  ].join('\n');
}
