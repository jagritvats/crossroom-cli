/**
 * A filter a person builds from choices (who, which states, which types, which sprint, an area,
 * labels, words), compiled into each tracker's own language: WIQL for Azure DevOps, JQL for Jira,
 * search qualifiers for GitHub. A sync stores the compiled condition beside the filter, so the web can
 * show the filter again and the runner runs the condition as it stands.
 *
 * Every value a person typed is a literal of its language and nothing more: one line, controls
 * dropped, cut short, and escaped as that language escapes (`'` doubled in WIQL, `\` and `"` escaped
 * in JQL, `"` dropped in a GitHub qualifier, which has no escape). `raw` is the one part that is the
 * person's own condition, ANDed in, in parentheses: a person's own words in their own tracker, run
 * with whatever credential reads.
 *
 * "me" is whoever's credential reads: the person's own token in the command or the browser, the
 * runner's account through a runner. The relay reads with no credential, so it refuses `me`
 * (`ME_NEEDS_A_CREDENTIAL`).
 */
import type { TrackerProvider } from '../trackers.js';
import { TrackerQueryError } from './io.js';

export type FilterAssignee = 'me' | 'anyone' | 'unassigned' | { name: string };
export type FilterSprint = 'any' | 'current' | { name: string };

export interface TrackerFilter {
  assignee: FilterAssignee;
  /** The tracker's state words: Active, In Progress; on GitHub `open`, `closed`, `merged`. */
  states: string[];
  /** Bug, Task, User Story; on GitHub `issue` or `pull request`. */
  types: string[];
  sprint: FilterSprint;
  /** Azure DevOps' area path (`UNDER`), Jira's component; GitHub has none and ignores it. */
  area: string | null;
  /** Every one must be there: Azure DevOps tags, Jira labels, GitHub labels. */
  labels: string[];
  /** Words in the title (Azure DevOps), the text (Jira), anywhere (GitHub). */
  text: string | null;
  /** An advanced condition in the tracker's own language, ANDed in. */
  raw: string | null;
}

export const EMPTY_FILTER: TrackerFilter = { assignee: 'anyone', states: [], types: [], sprint: 'any', area: null, labels: [], text: null, raw: null };

export const FILTER_LIMITS = { value: 200, list: 20, raw: 2000 } as const;

export const ME_NEEDS_A_CREDENTIAL =
  "\"Assigned to me\" means whoever's credential reads, and Crossroom reads public trackers with none. Name the person instead, or search with your own token (in the browser, or the crossroom command), or through a team's runner.";
export const GITHUB_NO_CURRENT_SPRINT = 'GitHub has no sprints: choose a milestone by name instead.';
export const GITHUB_STATES = 'On GitHub a state is open, closed or merged.';
export const GITHUB_TYPES = 'On GitHub a type is issue or pull request.';
export const GITHUB_LOGIN = 'That is not a GitHub login.';
export const NEEDS_TEAM = "The current sprint is a team's: choose the team.";

/** One line, no controls, no line breaks, cut at `max` without splitting a surrogate pair. */
export function filterValue(v: unknown, max: number = FILTER_LIMITS.value): string {
  if (typeof v !== 'string') return '';
  // Every C0 and C1 control, DEL, and the line and paragraph separators.
  let out = '';
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? ' ' : ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length <= max) return out;
  let end = max;
  const code = out.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return out.slice(0, end).trim();
}

const values = (list: readonly unknown[] | undefined) => [...new Set((list ?? []).slice(0, FILTER_LIMITS.list).map((v) => filterValue(v)).filter(Boolean))];

/** A filter as one a person may have sent: every field bounded, anything unknown dropped. */
export function normalFilter(f: Partial<TrackerFilter> | null | undefined): TrackerFilter {
  const a = f?.assignee;
  const assignee: FilterAssignee =
    a === 'me' || a === 'unassigned' ? a : a && typeof a === 'object' && filterValue((a as { name?: unknown }).name) ? { name: filterValue((a as { name: string }).name) } : 'anyone';
  const s = f?.sprint;
  const sprint: FilterSprint = s === 'current' ? s : s && typeof s === 'object' && filterValue((s as { name?: unknown }).name) ? { name: filterValue((s as { name: string }).name) } : 'any';
  return {
    assignee,
    states: values(f?.states),
    types: values(f?.types),
    sprint,
    area: filterValue(f?.area) || null,
    labels: values(f?.labels),
    text: filterValue(f?.text) || null,
    raw: filterValue(f?.raw, FILTER_LIMITS.raw) || null,
  };
}

// ---------------------------------------------------------------- the languages

/** A WIQL string literal: single quotes doubled. */
export const wiqlString = (s: string) => `'${filterValue(s).replace(/'/g, "''")}'`;
/** A JQL string literal: backslashes and double quotes escaped, so a reserved word or an operator is only a word. */
export const jqlString = (s: string) => `"${filterValue(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** A GitHub qualifier's value: quoted, with any double quote dropped (GitHub's search has no escape for one). */
export const githubValue = (s: string) => `"${filterValue(s).replace(/"/g, ' ').replace(/\s+/g, ' ').trim()}"`;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface CompileOptions {
  /** Azure DevOps: the project and team the current sprint is read in (`@CurrentIteration('[project]\team')`). */
  project?: string | null;
  team?: string | null;
}

/**
 * The filter in the tracker's language, every part ANDed: WIQL (without `SELECT`, the condition a
 * query's `WHERE` takes), JQL (without the project or the order), or GitHub qualifiers (without
 * `repo:`). A filter that chooses no state keeps to what isn't finished (`OPEN_BY_DEFAULT`); one that
 * chooses every state compiles to nothing on GitHub. Throws `TrackerQueryError` for what the tracker can't say.
 */
export function compileFilter(provider: TrackerProvider, filter: Partial<TrackerFilter>, o: CompileOptions = {}): string {
  const f = normalFilter(filter);
  if (provider === 'azure') return compileWiql(f, o);
  if (provider === 'jira') return compileJql(f);
  return compileGithub(f);
}

/**
 * With no state chosen and no condition of the person's own, a filter keeps to what isn't finished: what
 * a browse or a sync is for by default. Choosing states (every one, for everything) or writing a
 * condition says otherwise.
 */
export const OPEN_BY_DEFAULT: Readonly<Record<TrackerProvider, string>> = {
  github: 'is:open',
  azure: "[System.State] NOT IN ('Closed', 'Done', 'Removed')",
  jira: 'statusCategory != Done',
};
const openByDefault = (f: TrackerFilter) => f.states.length === 0 && !f.raw;

function compileWiql(f: TrackerFilter, o: CompileOptions): string {
  const parts: string[] = [];
  if (openByDefault(f)) parts.push(OPEN_BY_DEFAULT.azure);
  if (f.assignee === 'me') parts.push('[System.AssignedTo] = @Me');
  else if (f.assignee === 'unassigned') parts.push("[System.AssignedTo] = ''");
  else if (typeof f.assignee === 'object') parts.push(`[System.AssignedTo] = ${wiqlString(f.assignee.name)}`);
  if (f.states.length) parts.push(`[System.State] IN (${f.states.map(wiqlString).join(', ')})`);
  if (f.types.length) parts.push(`[System.WorkItemType] IN (${f.types.map(wiqlString).join(', ')})`);
  if (f.sprint === 'current') {
    const team = filterValue(o.team ?? '');
    const project = filterValue(o.project ?? '');
    if (!team) throw new TrackerQueryError(NEEDS_TEAM);
    // The macro's argument is one literal naming `[project]\team`.
    parts.push(`[System.IterationPath] = @CurrentIteration(${wiqlString(project ? `[${project}]\\${team}` : team)})`);
  } else if (typeof f.sprint === 'object') {
    const name = f.sprint.name;
    const project = filterValue(o.project ?? '');
    parts.push(`[System.IterationPath] UNDER ${wiqlString(name.includes('\\') || !project ? name : `${project}\\${name}`)}`);
  }
  if (f.area) parts.push(`[System.AreaPath] UNDER ${wiqlString(f.area)}`);
  for (const l of f.labels) parts.push(`[System.Tags] CONTAINS ${wiqlString(l)}`);
  if (f.text) parts.push(`[System.Title] CONTAINS ${wiqlString(f.text)}`);
  if (f.raw) parts.push(`(${checkCondition(f.raw)})`);
  return parts.join(' AND ');
}

function compileJql(f: TrackerFilter): string {
  const parts: string[] = [];
  if (openByDefault(f)) parts.push(OPEN_BY_DEFAULT.jira);
  if (f.assignee === 'me') parts.push('assignee = currentUser()');
  else if (f.assignee === 'unassigned') parts.push('assignee is EMPTY');
  else if (typeof f.assignee === 'object') parts.push(`assignee = ${jqlString(f.assignee.name)}`);
  if (f.states.length) parts.push(`status in (${f.states.map(jqlString).join(', ')})`);
  if (f.types.length) parts.push(`issuetype in (${f.types.map(jqlString).join(', ')})`);
  if (f.sprint === 'current') parts.push('sprint in openSprints()');
  else if (typeof f.sprint === 'object') parts.push(`sprint = ${jqlString(f.sprint.name)}`);
  if (f.area) parts.push(`component = ${jqlString(f.area)}`);
  for (const l of f.labels) parts.push(`labels = ${jqlString(l)}`);
  if (f.text) parts.push(`text ~ ${jqlString(f.text)}`);
  if (f.raw) parts.push(`(${checkCondition(f.raw)})`);
  return parts.join(' AND ');
}

const GH_STATE: Record<string, string> = { open: 'open', opened: 'open', closed: 'closed', merged: 'merged' };
const GH_TYPE: Record<string, 'issue' | 'pr'> = { issue: 'issue', issues: 'issue', 'pull request': 'pr', 'pull requests': 'pr', pr: 'pr', pull: 'pr' };

function compileGithub(f: TrackerFilter): string {
  const parts: string[] = [];
  if (f.assignee === 'me') parts.push('assignee:@me');
  else if (f.assignee === 'unassigned') parts.push('no:assignee');
  else if (typeof f.assignee === 'object') {
    const login = f.assignee.name.replace(/^@/, '');
    if (!LOGIN.test(login)) throw new TrackerQueryError(GITHUB_LOGIN);
    parts.push(`assignee:${login}`);
  }
  const states = new Set<string>();
  for (const s of f.states) {
    const st = GH_STATE[s.toLowerCase()];
    if (!st) throw new TrackerQueryError(GITHUB_STATES);
    states.add(st);
  }
  // `is:open` with `is:closed` is nothing; merged is a closed pull request.
  if (openByDefault(f)) parts.push(OPEN_BY_DEFAULT.github);
  else if (states.size === 1) parts.push(`is:${[...states][0]}`);
  else if (states.size === 2 && states.has('closed') && states.has('merged')) parts.push('is:closed');
  const types = new Set<string>();
  for (const t of f.types) {
    const ty = GH_TYPE[t.toLowerCase()];
    if (!ty) throw new TrackerQueryError(GITHUB_TYPES);
    types.add(ty);
  }
  if (types.size === 1) parts.push(`is:${[...types][0]}`);
  if (f.sprint === 'current') throw new TrackerQueryError(GITHUB_NO_CURRENT_SPRINT);
  if (typeof f.sprint === 'object') parts.push(`milestone:${githubValue(f.sprint.name)}`);
  for (const l of f.labels) parts.push(`label:${githubValue(l)}`);
  if (f.text) parts.push(githubValue(f.text));
  if (f.raw) parts.push(f.raw);
  return parts.join(' ');
}

export const UNBALANCED = 'That condition opens or closes a parenthesis or a quote it does not match, so it could reach past the project it is kept to.';

/**
 * A person's own condition (`raw`, a sync's or a search's `query`) as WIQL or JQL takes it inside
 * `(...)`: its parentheses balanced outside its quotes, and every quote closed, so it can't close the
 * parenthesis that keeps it to one project. Answers it as one line; throws `TrackerQueryError` otherwise.
 */
export function checkCondition(s: string): string {
  const line = filterValue(s, FILTER_LIMITS.raw);
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) {
        // WIQL doubles a single quote inside a literal.
        if (quote === "'" && line[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) throw new TrackerQueryError(UNBALANCED);
  }
  if (depth !== 0 || quote) throw new TrackerQueryError(UNBALANCED);
  return line;
}

/** Whether a filter asks for "me", which only a credential can answer. */
export const asksForMe = (f: Partial<TrackerFilter> | null | undefined) => f?.assignee === 'me' || (typeof f?.raw === 'string' && /@me\b|currentUser\(\)/i.test(f.raw));
