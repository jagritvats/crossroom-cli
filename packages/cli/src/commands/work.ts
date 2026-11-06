/**
 * `crossroom work` (workspace I6): a project's work items from the terminal, signed in with
 * `crossroom login`'s API token, or with an account API key in `CROSSROOM_API_KEY` for an agent or
 * a CI job (commands/relay-call.ts carries the rules for both).
 *
 * - `crossroom work list [--project <p>] [--workspace <w>] [--state <state>] [--json]`: the items of
 *   one project, or of every project the account holds (at most 25, one request each).
 * - `crossroom work show <id> [--project <p>] [--workspace <w>] [--json]`: one item, its brief,
 *   criteria and history. Without `--project` it is looked for in the account's projects.
 * - `crossroom work new "<title>" --project <p> [--brief "<text>" | --brief-file <file|->]
 *   [--criterion "<text>"]... [--expects <artifact id>] [--json]`: a native item, proposed.
 * - `crossroom work update <id> [--title ..] [--brief ..|--brief-file ..] [--criterion ..]...
 *   [--review <YYYY-MM-DD|none>]`: reads the item's version and PATCHes with it; `--criterion`
 *   replaces the criteria. A version that moved meanwhile changes nothing, and says so.
 * - `crossroom work move <id> <state>`: a state by its words ("ready for review") or its id; a move
 *   the item can't make is refused before anything is sent, naming the moves it can.
 * - `crossroom work assign <id> <person|team|agent|me|none>`: by sign-in name, team name or agent
 *   label from the project's People (`team:`, `agent:` or `person:` in front picks one kind). `me`
 *   proposes and accepts at once, as the web's "Take it" does; `none` leaves it with nobody.
 * - `crossroom work import <url> --project <p>`: a GitHub issue or pull request, an Azure DevOps work
 *   item, or a Jira issue. With that tracker's token in the environment (work-trackers.ts and
 *   work-azure.ts name the variables) the item is read here with it, by the shared reader, and sent as a
 *   report, so a private board works; without one the relay reads it, which only a public project (or a
 *   Jira Cloud site anyone may browse) allows, and its refusal of a private item says what to set.
 * - `crossroom work sync <where> --project <p> [--query "<q>"] [--sprint current] [--team "<t>"]
 *   [--limit <n>]`: `<where>` is a GitHub repository (q: search qualifiers, default `is:open`), an Azure
 *   DevOps project or board (q: a WIQL condition), or a Jira project or board (q: a JQL condition, kept
 *   to the project, default `statusCategory != Done`). `--sprint current` keeps to the sprint in
 *   progress (Jira's open sprints; Azure DevOps' current iteration, which is a team's: `--team` or a
 *   board address names it; GitHub has none). Every item is read here with the token and reported one
 *   by one. Each is deduped, so a schedule that runs it keeps a board in step. `--assignee`, `--state`,
 *   `--type`, `--area` and `--label` build a filter instead, compiled into the tracker's language
 *   (`compileFilter`, `@parley/shared/tracker-read`), with `--query` ANDed in; "me" is whoever the token is.
 * - `crossroom work room <id>`: "Discuss in a room": opens a project room for the item and prints
 *   each seat's link once, with the line to paste into an agent.
 * - `crossroom work rooms <project>`: the project's live rooms, newest first, with what each was
 *   opened for (`GET /api/projects/:p/rooms` and `.../room-links`).
 * - `crossroom work join <room> [--replace]`: "Join with my agent" (connect-teams A5): a seat in a
 *   project room bound to this account (`POST /api/sessions/:id/seats/mine`), its link printed once
 *   with the line to paste, never an owner key. A second call names the same seat, with a new link
 *   while no agent is in it; `--replace` moves it to a new agent, taking out the one there.
 *
 * `<p>` is a project's id or its name (commands/project-pick.ts). Everything an item holds was
 * written by a person or an agent, so it is printed through `line` and `block`, never raw.
 */
import type { AccountView } from '@parley/shared/accounts';
import type { SeatTaken } from '@parley/shared/bound-seats';
import { seatPrompt } from '@parley/shared/deeplink';
import type { ProjectRoom, ProjectRoomsResult } from '@parley/shared/org';
import { slotLetter } from '@parley/shared/text';
import {
  CreateWorkInput,
  type Delegate,
  type DiscussResult,
  type ImportResult,
  PatchWorkInput,
  type PeopleView,
  type RoomLink,
  type RoomLinksResult,
  STALE_VERSION,
  type WorkItem,
  type WorkListResult,
  type WorkResult,
  WORK_GONE,
  WORK_STATE_LABEL,
  WORK_TRANSITIONS,
  WorkState,
} from '@parley/shared/work';
import { type AzureWorkItemRef, isAzureHost, parseAzureWorkItemUrl } from '@parley/shared/azure-devops';
import { ORG_GONE } from '@parley/shared/org';
import { isJiraCloudHost, type JiraIssueRef, parseJiraIssueUrl, type TrackerProvider } from '@parley/shared/trackers';
import { type Args, Usage } from '../cli.js';
import { type GithubItemRef, githubItemUrl, parseGithubUrl } from '../trackers/github.js';
import { normalFilter, type TrackerFilter, type TrackerRead } from '../trackers/io.js';
import { registerCommand } from './index.js';
import {
  block,
  type Client,
  flag,
  get,
  line,
  listProjects,
  MAX_PROJECTS_SEARCHED,
  pickProject,
  type ProjectRef,
  readText,
  realStdin,
  type StdinReader,
} from './project-pick.js';
import { call, type FetchLike, realFetch, RelayRefused, signedIn } from './relay-call.js';
import { azureToken, DEFAULT_QUERY, NO_TOKEN, parseAzureProject, queryAzureItems, readAzureItem, SYNC_MAX } from './work-azure.js';
import {
  GITHUB_DEFAULT_QUERY,
  GITHUB_NO_SPRINT,
  GITHUB_NO_TOKEN,
  githubToken,
  JIRA_DEFAULT_QUERY,
  JIRA_NO_TOKEN,
  jiraToken,
  parseGithubRepo,
  parseJiraWhere,
  readGithubWithToken,
  readJiraWithToken,
  reportOf,
  type Synced,
  syncGithub,
  syncJira,
  tokenWord,
} from './work-trackers.js';

const USAGE = [
  'Usage: crossroom work list [--project <p>] [--workspace <w>] [--state <state>] [--json]',
  '       crossroom work show <id> [--project <p>] [--workspace <w>] [--json]',
  '       crossroom work new "<title>" --project <p> [--brief "<text>" | --brief-file <file|->] [--criterion "<text>"]... [--expects <artifact id>] [--json]',
  '       crossroom work update <id> [--title "<t>"] [--brief "<text>" | --brief-file <file|->] [--criterion "<text>"]... [--review <YYYY-MM-DD|none>] [--json]',
  '       crossroom work move <id> <state> [--note "<text>"] [--json]',
  '       crossroom work assign <id> <person|team|agent|me|none> [--note "<text>"] [--json]',
  '       crossroom work import <github, azure devops or jira item url> --project <p> [--json]',
  '       crossroom work sync <github repo | azure devops project or board | jira project or board url> --project <p>',
  '                           [--query "<search qualifiers | WIQL | JQL condition>"] [--sprint current] [--team "<team>"] [--limit <n>] [--json]',
  '                           [--assignee me|none|<name>] [--state "<state>"]... [--type "<type>"]... [--area "<area>"] [--label "<label>"]...',
  '       crossroom work room <id> [--json]',
  '       crossroom work rooms <project> [--json]',
  '       crossroom work join <room> [--replace] [--json]',
  '  Each takes --project <p> and --workspace <w> to say where the item is.',
  '  Tokens are read here and never sent to Crossroom: GITHUB_TOKEN or GH_TOKEN; AZURE_DEVOPS_PAT;',
  '  JIRA_EMAIL with JIRA_API_TOKEN (Jira Cloud), or JIRA_PAT with JIRA_SITE (a self-managed Jira).',
].join('\n');

const FORMS = ['list', 'show', 'new', 'update', 'move', 'assign', 'import', 'sync', 'room', 'rooms', 'join'] as const;
type Form = (typeof FORMS)[number];

/** What a command reaches the world through; tests pass their own. */
export interface WorkDeps {
  fetch: FetchLike;
  stdin: StdinReader;
  /** What reaches a tracker (GitHub, Azure DevOps, Jira) with the person's token; the relay's fetch when absent. */
  tracker?: FetchLike;
  /** The same, by its older name, for Azure DevOps. */
  azure?: FetchLike;
  /** Where the token is read from; `process.env` when absent. */
  env?: NodeJS.ProcessEnv;
}
const realDeps: WorkDeps = { fetch: realFetch, stdin: realStdin };

type ImportTarget =
  | { provider: 'azure'; url: string; ref: AzureWorkItemRef }
  | { provider: 'github'; url: string; ref: GithubItemRef }
  | { provider: 'jira'; url: string; ref: JiraIssueRef };

/** The tracker item an address names, checked before anything is read or sent. */
function importTarget(url: string): ImportTarget {
  if (isAzureHost(url)) {
    const ref = parseAzureWorkItemUrl(url);
    if (!ref) throw new Usage(`${line(url)} is not the address of an Azure DevOps work item. Open the item and copy the address from the browser. Nothing was sent.`);
    return { provider: 'azure', url: ref.url, ref };
  }
  if (/^https:\/\/(www\.)?github\.com\//i.test(url.trim())) {
    const ref = parseGithubUrl(url);
    if (!ref) throw new Usage(`${line(url)} is not the address of a GitHub issue or pull request. Nothing was sent.`);
    return { provider: 'github', url: githubItemUrl(ref), ref };
  }
  const jira = parseJiraIssueUrl(url, { anyHost: true });
  if (jira) return { provider: 'jira', url: jira.url, ref: jira };
  throw new Usage(`${line(url)} is not a GitHub, Azure DevOps or Jira address. Give the issue's, pull request's or work item's https:// page. Nothing was sent.`);
}

/** What to set to read an item here, by tracker. */
const NEEDS_TOKEN: Readonly<Record<TrackerProvider, string>> = { github: GITHUB_NO_TOKEN, azure: NO_TOKEN, jira: JIRA_NO_TOKEN };

/** An item's state in words, and what is sealed in it made safe to print. */
const stateWord = (s: WorkItem['state']) => WORK_STATE_LABEL[s] ?? s;

const whoIs = (item: WorkItem) => (item.delegate ? `${item.delegate.kind} ${line(item.delegate.ref)}` : 'nobody yet');

function listLines(p: ProjectRef, items: WorkItem[]): string[] {
  const where = p.workspace.kind === 'personal' ? 'personal workspace' : line(p.workspace.name);
  const out = [`${line(p.name)} (${where}, ${p.id})`];
  if (!items.length) out.push('  no work yet');
  const wide = Math.max(0, ...items.map((i) => stateWord(i.state).length));
  for (const i of items) out.push(`  ${i.id}  ${stateWord(i.state).padEnd(wide)}  ${line(i.title)}`);
  return out;
}

function showLines(p: ProjectRef, r: WorkResult): string[] {
  const i = r.item;
  const out = [`${i.id}  ${stateWord(i.state)}  ${line(i.title)}`, `  project   ${line(p.name)} (${p.id})`, `  delegate  ${whoIs(i)}`];
  if (i.expectedArtifactId) out.push(`  expects   artifact ${i.expectedArtifactId}`);
  if (i.reviewPoint) out.push(`  review    ${i.reviewPoint.slice(0, 10)}`);
  if (i.source.authority === 'external') out.push(`  source    ${i.source.provider ?? 'external'}${i.source.url ? `: ${line(i.source.url)}` : ''}`);
  if (i.dependsOn.length) out.push(`  after     ${i.dependsOn.join(', ')}`);
  if (i.brief.trim()) out.push('', 'Brief', ...block(i.brief).split('\n').map((l) => (l ? `  ${l}` : '')));
  if (i.criteria.length) out.push('', 'Criteria', ...i.criteria.map((c, n) => `  ${n + 1}. ${line(c)}`));
  if (r.history.length) {
    out.push('', 'History');
    for (const h of r.history) {
      const move = h.from && h.to ? `${stateWord(h.from)} -> ${stateWord(h.to)}` : h.to ? stateWord(h.to) : '';
      const detail = line(h.detail);
      out.push(`  ${h.at.slice(0, 16).replace('T', ' ')}  ${h.kind}${move ? `  ${move}` : ''}  by ${line(h.actor)}${detail ? `  ${detail}` : ''}`);
    }
  }
  return out;
}

/** A flag's values: once, or repeated. */
const valuesOf = (args: Args, name: string): string[] => {
  const many = args.values?.[name];
  if (many) return many;
  const one = args.flags[name];
  if (one === true) throw new Usage(`--${name} needs a value.`);
  return one === undefined ? [] : [one];
};

/**
 * The filter `sync`'s flags build, or null when none is given: `--assignee me|none|<name>`,
 * `--state`, `--type` and `--label` (each repeatable), `--area`, with `--sprint current` and `--query`
 * (ANDed in as the person's own condition). Compiled for the tracker by the shared readers.
 */
function syncFilter(args: Args, sprint: boolean): TrackerFilter | null {
  const assignee = flag(args, 'assignee');
  const states = valuesOf(args, 'state');
  const types = valuesOf(args, 'type');
  const labels = valuesOf(args, 'label');
  const area = flag(args, 'area');
  if (assignee === undefined && !states.length && !types.length && !labels.length && area === undefined) return null;
  return normalFilter({
    assignee: assignee === undefined ? 'anyone' : assignee === 'me' ? 'me' : assignee === 'none' ? 'unassigned' : { name: assignee },
    states,
    types,
    labels,
    area: area ?? null,
    sprint: sprint ? 'current' : 'any',
    raw: flag(args, 'query') ?? null,
  });
}

/** The criteria a user gave: `--criterion` once or repeated. */
function criteriaOf(args: Args): string[] {
  const many = args.values?.criterion;
  if (many) return many;
  const one = args.flags.criterion;
  if (one === true) throw new Usage('--criterion needs a value.');
  return one === undefined ? [] : [one];
}

/** Input zod refused, in the first complaint's own words, before anything is sent. */
function checked<T>(r: { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }): T {
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw new Usage(`${first?.path.length ? `${first.path.map(String).join('.')}: ` : ''}${first?.message ?? 'that is not valid'}. Nothing was sent.`);
}

export async function workCommand(args: Args, out: (line: string) => void, deps: WorkDeps = realDeps): Promise<number> {
  const form = args.positional[0];
  const rest = args.positional.slice(1);
  const json = args.flags.json === true;
  if (!(FORMS as readonly string[]).includes(form ?? '')) throw new Usage(USAGE);
  const { relay, token } = signedIn(args);
  const c: Client = { relay, token, fetchImpl: deps.fetch };
  const project = flag(args, 'project');
  const workspace = flag(args, 'workspace');

  if (form === 'list') {
    if (rest.length) throw new Usage(USAGE);
    const state = flag(args, 'state');
    if (state !== undefined && !WorkState.safeParse(state).success)
      throw new Usage(`--state is one of ${WorkState.options.join(', ')}; got "${line(state)}".`);
    const query = state ? `?state=${encodeURIComponent(state)}` : '';
    let chosen: ProjectRef[];
    let capped = false;
    if (project) chosen = [await pickProject(c, project, workspace, USAGE)];
    else {
      const all = await listProjects(c, workspace);
      capped = all.length > MAX_PROJECTS_SEARCHED;
      chosen = all.slice(0, MAX_PROJECTS_SEARCHED);
    }
    const listed: { project: ProjectRef; items: WorkItem[] }[] = [];
    for (const p of chosen) listed.push({ project: p, items: (await get<WorkListResult>(c, `/api/projects/${encodeURIComponent(p.id)}/work${query}`)).items });
    if (json) out(JSON.stringify(listed, null, 2));
    else if (!listed.length) out('You hold no project yet. Make one in the web app, then `crossroom work new` can add to it.');
    else {
      listed.forEach((l, n) => {
        if (n) out('');
        for (const x of listLines(l.project, l.items)) out(x);
      });
      if (capped) out(`\nOnly the first ${MAX_PROJECTS_SEARCHED} projects are listed. Name one with --project.`);
    }
    return 0;
  }

  if (form === 'show') {
    const id = rest[0];
    if (!id || rest.length > 1) throw new Usage(USAGE);
    const found = await findItem(c, id, project, workspace);
    if (json) out(JSON.stringify({ project: found.project, ...found.result }, null, 2));
    else for (const x of showLines(found.project, found.result)) out(x);
    return 0;
  }

  if (form === 'rooms') {
    const which = rest[0] ?? project;
    if (!which || rest.length > 1) throw new Usage(`Say which project, by its id or name: crossroom work rooms <project>.\n${USAGE}`);
    const p = await pickProject(c, which, workspace, USAGE);
    const base = `/api/projects/${encodeURIComponent(p.id)}`;
    const rooms = (await get<ProjectRoomsResult>(c, `${base}/rooms`)).rooms.filter((r) => r.status !== 'ended');
    const links = new Map((await get<RoomLinksResult>(c, `${base}/room-links`)).links.map((l) => [l.sessionId, l] as const));
    if (json) out(JSON.stringify({ project: p, rooms: rooms.map((r) => ({ ...r, for: links.get(r.id) ?? null })) }, null, 2));
    else for (const x of roomsLines(p, rooms, links)) out(x);
    return 0;
  }

  if (form === 'join') {
    const room = rest[0];
    if (!room || rest.length > 1) throw new Usage(USAGE);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(room)) throw new Usage(`${line(room)} is not a room's id. \`crossroom work rooms <project>\` lists them. Nothing was sent.`);
    const seat = await call<SeatTaken>(relay, token, deps.fetch, 'POST', `/api/sessions/${encodeURIComponent(room)}/seats/mine`, args.flags.replace === true ? { replace: true } : {});
    if (json) out(JSON.stringify(seat, null, 2));
    else for (const x of joinLines(seat)) out(x);
    return 0;
  }

  if (form !== 'new') return more(form as Exclude<Form, 'list' | 'show' | 'new' | 'rooms' | 'join'>, args, rest, c, project, workspace, json, out, deps);

  // new
  const title = rest[0];
  if (!title || rest.length > 1) throw new Usage(USAGE);
  if (!project) throw new Usage(`Say which project the item is for, with --project <id or name>.\n${USAGE}`);
  const inline = flag(args, 'brief');
  const file = flag(args, 'brief-file');
  if (inline !== undefined && file !== undefined) throw new Usage('Give the brief with --brief or with --brief-file, not both.');
  const brief = file !== undefined ? await readText(file, 'a brief', deps.stdin) : (inline ?? '');
  const expects = flag(args, 'expects');
  const input = checked(CreateWorkInput.safeParse({ title, brief, criteria: criteriaOf(args), ...(expects ? { expectedArtifactId: expects } : {}) }));
  const p = await pickProject(c, project, workspace, USAGE);
  const made = await call<WorkResult>(relay, token, deps.fetch, 'POST', `/api/projects/${encodeURIComponent(p.id)}/work`, input);
  if (json) out(JSON.stringify({ project: p, ...made }, null, 2));
  else {
    out(`Made ${made.item.id} in ${line(p.name)}: ${line(made.item.title)}`);
    out(`${stateWord(made.item.state)}. \`crossroom work show ${made.item.id} --project ${p.id}\` shows it.`);
  }
  return 0;
}

/** A state as a person types it: its id (`ready_for_review`) or its words (`ready for review`, `Outcome accepted`). */
export function stateOf(word: string): WorkState | null {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const w = norm(word);
  for (const s of WorkState.options) if (s === w || norm(WORK_STATE_LABEL[s]) === w) return s;
  return null;
}

const stateList = (states: readonly WorkState[]) => states.map((s) => `"${WORK_STATE_LABEL[s].toLowerCase()}" (${s})`).join(', ');

/** A review point as `--review` takes it: a day, or `none` to clear it. Noon UTC, so the day reads the same everywhere. */
export function reviewOf(raw: string): string | null {
  const day = raw.trim();
  if (day.toLowerCase() === 'none') return null;
  const at = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T12:00:00.000Z`) : null;
  if (!at || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day)
    throw new Usage(`--review is a day as YYYY-MM-DD, or none to clear it; got "${line(raw)}". Nothing was sent.`);
  return at.toISOString();
}

/** A write the relay refused because the item moved on since it was read, said plainly. */
function stale(e: unknown, id: string): unknown {
  if (e instanceof RelayRefused && e.status === 409 && e.message.endsWith(STALE_VERSION))
    return new Usage(`${line(id)} changed while this ran: someone else wrote to it just now. Nothing was changed. Run \`crossroom work show ${line(id)}\` and try again.`);
  return e;
}

const delegateWord = (people: PeopleView, d: Delegate): string => {
  if (d.kind === 'account') {
    const m = people.members.find((x) => x.accountId === d.ref);
    return m?.login ? line(m.login) : 'that person';
  }
  if (d.kind === 'team') return `team ${line(people.teams.find((t) => t.id === d.ref)?.name ?? d.ref)}`;
  if (d.kind === 'agent') return `agent ${line(people.seats.find((x) => x.id === d.ref)?.label ?? d.ref)}`;
  return `seat ${line(d.ref)}`;
};

/**
 * Who `assign` means: a member by sign-in name, a team by name, or a team's agent by its label, from
 * the project's People. `person:`, `team:` or `agent:` in front picks the kind when a word names two.
 */
export function delegateOf(people: PeopleView, raw: string): Delegate {
  const m = /^(person|team|agent):(.+)$/i.exec(raw.trim());
  const kind = m ? (m[1]!.toLowerCase() as 'person' | 'team' | 'agent') : null;
  const name = (m ? m[2]! : raw).trim().replace(/^@/, '').toLowerCase();
  const found: { d: Delegate; word: string }[] = [];
  if (!kind || kind === 'person')
    for (const p of people.members) if (p.login?.toLowerCase() === name) found.push({ d: { kind: 'account', ref: p.accountId }, word: `person:${line(p.login)}` });
  if (!kind || kind === 'team') for (const t of people.teams) if (t.name.toLowerCase() === name) found.push({ d: { kind: 'team', ref: t.id }, word: `team:${line(t.name)}` });
  if (!kind || kind === 'agent') for (const x of people.seats) if (x.label.toLowerCase() === name) found.push({ d: { kind: 'agent', ref: x.id }, word: `agent:${line(x.label)}` });
  if (found.length === 1) return found[0]!.d;
  if (found.length > 1) throw new Usage(`"${line(raw)}" names more than one: ${found.map((f) => f.word).join(', ')}. Say which with one of those.`);
  const names = [
    ...people.members.flatMap((p) => (p.login ? [line(p.login)] : [])),
    ...people.teams.map((t) => `team:${line(t.name)}`),
    ...people.seats.map((x) => `agent:${line(x.label)}`),
  ];
  throw new Usage(`Nobody on this project is called "${line(raw)}".${names.length ? ` It has: ${names.slice(0, 20).join(', ')}${names.length > 20 ? ', …' : ''}.` : ''} Or say me, or none.`);
}

/** The lines `work room` prints: each seat's link once, the first for whoever runs it. */
export function roomLines(p: ProjectRef, item: WorkItem, r: DiscussResult, relay: string): string[] {
  const out = [`Opened a room for ${item.id} in ${line(p.name)}: ${line(item.title)}`, `The project's members open it signed in: ${relay}/s/${r.link.sessionId}`, ''];
  r.seats.forEach((seat, n) => {
    out.push(n === 0 ? `${line(seat.name)}, for you or your agent. Paste this into it:` : `${line(seat.name)}, for whoever should bring their agent. Send them this line:`);
    out.push(`  ${seatPrompt(seat.seatUrl)}`);
  });
  out.push('', "Each link is its seat's only key, shown this once: send each to one person, never where others can read it.");
  return out;
}

/** A project's live rooms, newest first: what each was opened for is the project's words, printed through `line`. */
export function roomsLines(p: ProjectRef, rooms: readonly ProjectRoom[], links: ReadonlyMap<string, RoomLink>): string[] {
  const out = [`${line(p.name)} (${p.id})`];
  if (!rooms.length) {
    out.push('  no live room. `crossroom work room <item>` opens one for a work item.');
    return out;
  }
  for (const r of rooms) {
    const l = links.get(r.id);
    const what = l ? `${l.workId ? 'work' : 'meeting'}: ${line(l.title ?? (l.workId ? 'a work item' : 'a meeting'))}` : '';
    const state = r.lane ? `lane, ${r.lane.open} open item${r.lane.open === 1 ? '' : 's'}` : r.status === 'active' ? 'running' : 'waiting for agents';
    out.push(`  ${r.id}  ${state}${what ? `  for ${what}` : ''}`);
  }
  out.push('', 'Take a seat in one for your own agent: crossroom work join <room>');
  return out;
}

/** The seat `join` took: its link and the line to paste, or why there is no new link. Never an owner key. */
export function joinLines(seat: SeatTaken): string[] {
  const letter = slotLetter(seat.slot);
  if (!seat.seatUrl || !seat.pasteLine)
    return [`Your agent is already in seat ${letter} of ${seat.sessionId}, so no new link was made.`, 'Run it again with --replace only to move the seat to another agent: the one there now is taken out.'];
  return [
    `Seat ${letter} in ${seat.sessionId} is yours${seat.created ? '' : ' (the seat you took before, with a new link)'}. Paste this into your agent:`,
    '',
    `  ${seat.pasteLine}`,
    '',
    `Its page, to watch the room as this seat: ${seat.pageUrl}`,
    'The link is the seat\'s only key, and it ends if you stop being able to write in the project.',
  ];
}

async function more(
  form: Exclude<Form, 'list' | 'show' | 'new' | 'rooms' | 'join'>,
  args: Args,
  rest: string[],
  c: Client,
  project: string | undefined,
  workspace: string | undefined,
  json: boolean,
  out: (line: string) => void,
  deps: WorkDeps,
): Promise<number> {
  const send = <T>(method: string, path: string, body: unknown) => call<T>(c.relay, c.token, c.fetchImpl, method, path, body);
  const workPath = (p: ProjectRef, id: string, tail = '') => `/api/projects/${encodeURIComponent(p.id)}/work/${encodeURIComponent(id)}${tail}`;

  if (form === 'import') {
    const url = rest[0];
    if (!url || rest.length > 1) throw new Usage(USAGE);
    if (!project) throw new Usage(`Say which project the item goes into, with --project <id or name>.\n${USAGE}`);
    const env = deps.env ?? process.env;
    const reach = deps.tracker ?? deps.azure ?? deps.fetch;
    const target = importTarget(url);
    // With a token the item is read here, before anything goes to Crossroom.
    let read: TrackerRead | null = null;
    if (target.provider === 'azure') {
      const tok = azureToken(env);
      if (tok) read = await readAzureItem(reach, tok, target.ref);
    } else if (target.provider === 'github') {
      const tok = githubToken(env);
      if (tok) read = await readGithubWithToken(reach, tok, target.ref);
    } else {
      const tok = jiraToken(env, target.ref.site);
      if (tok) read = await readJiraWithToken(reach, tok, target.ref);
      else if (!isJiraCloudHost(new URL(target.ref.site).hostname)) throw new Usage(`Crossroom reads Jira Cloud only; a self-managed Jira is read here with your token. ${JIRA_NO_TOKEN} Nothing was sent.`);
    }
    const p = await pickProject(c, project, workspace, USAGE);
    const base = `/api/projects/${encodeURIComponent(p.id)}`;
    let r: ImportResult;
    try {
      r = read ? await send<ImportResult>('POST', `${base}/import/reported`, reportOf(target.provider, target.url, read)) : await send<ImportResult>('POST', `${base}/import`, { url });
    } catch (e) {
      // Without a token the relay read it, and a private item answers as a missing one: say what to set.
      if (!read && e instanceof RelayRefused && e.status === 404 && !e.message.endsWith(ORG_GONE))
        throw new Usage(`${line(url)} could not be read without a token: it is private, or it does not exist. To read it here with your own token, ${NEEDS_TOKEN[target.provider]} Nothing was imported.`);
      throw e;
    }
    if (json) out(JSON.stringify({ project: p, ...r }, null, 2));
    else out(`${r.updated ? 'Refreshed' : 'Imported'} ${r.item.id} in ${line(p.name)}: ${line(r.item.title)}${read ? ` (read with ${tokenWord(target.provider)})` : ''}`);
    return 0;
  }

  if (form === 'sync') {
    const where = rest[0];
    if (!where || rest.length > 1) throw new Usage(USAGE);
    if (!project) throw new Usage(`Say which project the items go into, with --project <id or name>.\n${USAGE}`);
    const env = deps.env ?? process.env;
    const reach = deps.tracker ?? deps.azure ?? deps.fetch;
    const rawLimit = flag(args, 'limit');
    const limit = rawLimit === undefined ? 200 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > SYNC_MAX) throw new Usage(`--limit is a whole number from 1 to ${SYNC_MAX}.`);
    const sprintFlag = flag(args, 'sprint');
    if (sprintFlag !== undefined && sprintFlag !== 'current') throw new Usage('--sprint takes one value: current (the sprint or iteration in progress).');
    const sprint = sprintFlag === 'current';
    const team = flag(args, 'team');
    const filter = syncFilter(args, sprint);
    const queryOf = (fallback: string, what: string): string | TrackerFilter => {
      const q = flag(args, 'query') ?? fallback;
      if (!q.trim() || q.length > 2000) throw new Usage(`--query is ${what}, at most 2,000 characters.`);
      return filter ?? q;
    };
    let provider: TrackerProvider;
    let found: { items: Synced[]; more: boolean };
    let tokFrom: string;
    const repo = parseGithubRepo(where);
    const az = repo ? null : parseAzureProject(where);
    const jw = repo || az ? null : parseJiraWhere(where, { anyHost: true });
    if (repo) {
      provider = 'github';
      if (sprint) throw new Usage(GITHUB_NO_SPRINT);
      if (filter && (filter.area !== null)) throw new Usage('GitHub has no areas: leave --area out. Nothing was sent.');
      const tok = githubToken(env);
      if (!tok) throw new Usage(`Syncing reads the repository with your own token. ${GITHUB_NO_TOKEN}`);
      tokFrom = tok.from;
      found = await syncGithub(reach, tok, repo, queryOf(GITHUB_DEFAULT_QUERY, 'GitHub search qualifiers'), limit);
    } else if (az) {
      provider = 'azure';
      const at = team ? { ...az, team } : az;
      if (sprint && !at.team)
        throw new Usage('The current iteration is a team\'s: name it with --team "<team>", or give the team\'s board address (…/_boards/board/t/<team>/…). Nothing was sent.');
      const tok = azureToken(env);
      if (!tok) throw new Usage(`Syncing reads the board with your own token. ${NO_TOKEN}`);
      tokFrom = tok.from;
      found = await queryAzureItems(reach, tok, at, queryOf(DEFAULT_QUERY, 'a WIQL condition'), limit, { sprint: sprint && !filter });
    } else if (jw) {
      provider = 'jira';
      const tok = jiraToken(env, jw.site);
      if (!tok) throw new Usage(`Syncing reads Jira with your own token. ${JIRA_NO_TOKEN}`);
      tokFrom = tok.from;
      found = await syncJira(reach, tok, jw, queryOf(JIRA_DEFAULT_QUERY, 'a JQL condition'), sprint && !filter, limit);
    } else
      throw new Usage(
        `${line(where)} is not a GitHub repository, an Azure DevOps project or a Jira project or board address. Give https://github.com/<owner>/<repo>, https://dev.azure.com/<organisation>/<project>, or https://<site>.atlassian.net/browse/<KEY>. Nothing was sent.`,
      );
    const p = await pickProject(c, project, workspace, USAGE);
    const path = `/api/projects/${encodeURIComponent(p.id)}/import/reported`;
    const done: { id: string; externalId: string; updated: boolean; title: string }[] = [];
    let stopped: string | null = null;
    for (const it of found.items) {
      try {
        const r = await send<ImportResult>('POST', path, reportOf(provider, it.url, it.read));
        done.push({ id: r.item.id, externalId: it.externalId, updated: r.updated, title: r.item.title });
      } catch (e) {
        // A refusal stops the run where it is: what came in stays in, and the next run carries on.
        if (!(e instanceof RelayRefused)) throw e;
        stopped = e.message;
        break;
      }
    }
    const added = done.filter((d) => !d.updated).length;
    if (json) out(JSON.stringify({ project: p, provider, read: found.items.length, more: found.more, items: done, ...(stopped ? { stopped } : {}) }, null, 2));
    else {
      for (const d of done) out(`${d.updated ? 'refreshed' : 'imported '} ${d.id}  ${line(d.externalId)}  ${line(d.title)}`);
      out(`${found.items.length ? `${added} imported, ${done.length - added} refreshed` : 'Nothing matched the query'} in ${line(p.name)}, read with ${tokenWord(provider)} (${tokFrom}).`);
      if (found.more) out(`More items match than --limit ${limit}: the most recently changed were taken.`);
      if (stopped) out(`Stopped after ${done.length} of ${found.items.length}: ${line(stopped)}`);
    }
    return stopped ? 1 : 0;
  }

  const id = rest[0];
  if (!id) throw new Usage(USAGE);

  if (form === 'update') {
    if (rest.length > 1) throw new Usage(USAGE);
    const inline = flag(args, 'brief');
    const file = flag(args, 'brief-file');
    if (inline !== undefined && file !== undefined) throw new Usage('Give the brief with --brief or with --brief-file, not both.');
    const title = flag(args, 'title');
    const review = flag(args, 'review');
    const criteria = args.flags.criterion === undefined ? undefined : criteriaOf(args);
    if (title === undefined && inline === undefined && file === undefined && criteria === undefined && review === undefined)
      throw new Usage(`Say what to change: --title, --brief or --brief-file, --criterion (replaces them all) or --review.\n${USAGE}`);
    const brief = file !== undefined ? await readText(file, 'a brief', deps.stdin) : inline;
    const changes = {
      ...(title !== undefined ? { title } : {}),
      ...(brief !== undefined ? { brief } : {}),
      ...(criteria !== undefined ? { criteria } : {}),
      ...(review !== undefined ? { reviewPoint: reviewOf(review) } : {}),
    };
    // Checked with a stand-in version before anything is asked of the relay.
    const { version: _, ...valid } = checked(PatchWorkInput.safeParse({ version: 1, ...changes }));
    const found = await findItem(c, id, project, workspace);
    let r: WorkResult;
    try {
      r = await send<WorkResult>('PATCH', workPath(found.project, found.result.item.id), { ...valid, version: found.result.item.version });
    } catch (e) {
      throw stale(e, id);
    }
    if (json) out(JSON.stringify({ project: found.project, ...r }, null, 2));
    else out(`Updated ${r.item.id} in ${line(found.project.name)} (${Object.keys(changes).join(', ')}): ${line(r.item.title)}`);
    return 0;
  }

  if (form === 'move') {
    const word = rest.slice(1).join(' ');
    if (!word) throw new Usage(USAGE);
    const to = stateOf(word);
    if (!to) throw new Usage(`"${line(word)}" is not a state. The states: ${stateList(WorkState.options)}.`);
    const note = flag(args, 'note') ?? '';
    const found = await findItem(c, id, project, workspace);
    const item = found.result.item;
    if (item.state === to) throw new Usage(`${item.id} is ${stateWord(to).toLowerCase()} already. Nothing was sent.`);
    const can = WORK_TRANSITIONS[item.state];
    if (!can.includes(to))
      throw new Usage(
        `${item.id} is ${stateWord(item.state).toLowerCase()}, and can't become ${stateWord(to).toLowerCase()} from there. ${can.length ? `It can move to ${stateList(can)}.` : 'It is finished: it moves no further.'} Nothing was sent.`,
      );
    let r: WorkResult;
    try {
      r = await send<WorkResult>('POST', workPath(found.project, item.id, '/transition'), { to, version: item.version, note });
    } catch (e) {
      throw stale(e, id);
    }
    if (json) out(JSON.stringify({ project: found.project, ...r }, null, 2));
    else out(`Moved ${item.id} from ${stateWord(item.state)} to ${stateWord(r.item.state)}: ${line(r.item.title)}`);
    return 0;
  }

  if (form === 'assign') {
    const who = rest.slice(1).join(' ').trim();
    if (!who) throw new Usage(USAGE);
    const note = flag(args, 'note') ?? '';
    const found = await findItem(c, id, project, workspace);
    const item = found.result.item;
    const p = found.project;
    let r: WorkResult;
    let said: string;
    if (who.toLowerCase() === 'none') {
      try {
        r = await send<WorkResult>('PATCH', workPath(p, item.id), { version: item.version, delegate: null });
      } catch (e) {
        throw stale(e, id);
      }
      said = `Nobody has ${item.id} now.`;
    } else if (who.toLowerCase() === 'me') {
      const me = await get<AccountView>(c, '/api/account');
      if (!me.signedIn) throw new Usage(`${c.relay} does not say who this account is. Nothing was sent.`);
      const delegate: Delegate = { kind: 'account', ref: me.account.id };
      await send<WorkResult>('POST', workPath(p, item.id, '/assignment'), { action: 'propose', delegate, note });
      r = await send<WorkResult>('POST', workPath(p, item.id, '/assignment'), { action: 'accept', note: '' });
      said = `${item.id} is yours.`;
    } else {
      const people = await get<PeopleView>(c, `/api/projects/${encodeURIComponent(p.id)}/people`);
      const delegate = delegateOf(people, who);
      r = await send<WorkResult>('POST', workPath(p, item.id, '/assignment'), { action: 'propose', delegate, note });
      said = `Asked ${delegateWord(people, delegate)} to take ${item.id}; it is theirs once they accept.`;
    }
    if (json) out(JSON.stringify({ project: p, ...r }, null, 2));
    else out(`${said} ${line(r.item.title)}`);
    return 0;
  }

  // room
  if (rest.length > 1) throw new Usage(USAGE);
  const found = await findItem(c, id, project, workspace);
  const r = await send<DiscussResult>('POST', `/api/projects/${encodeURIComponent(found.project.id)}/room-links`, { workId: found.result.item.id });
  if (json)
    out(
      JSON.stringify(
        {
          project: found.project,
          workId: found.result.item.id,
          link: r.link,
          roomUrl: `${c.relay}/s/${r.link.sessionId}`,
          seats: r.seats.map((s) => ({ name: s.name, seatUrl: s.seatUrl, paste: seatPrompt(s.seatUrl) })),
        },
        null,
        2,
      ),
    );
  else for (const x of roomLines(found.project, found.result.item, r, c.relay)) out(x);
  return 0;
}

/** The item `id` names: in the project given, or the first of the account's projects that has it. */
async function findItem(c: Client, id: string, project: string | undefined, workspace: string | undefined): Promise<{ project: ProjectRef; result: WorkResult }> {
  const path = (p: ProjectRef) => `/api/projects/${encodeURIComponent(p.id)}/work/${encodeURIComponent(id)}`;
  if (project) {
    const p = await pickProject(c, project, workspace, USAGE);
    try {
      return { project: p, result: await get<WorkResult>(c, path(p)) };
    } catch (e) {
      throw gone(e, id, p);
    }
  }
  const all = await listProjects(c, workspace);
  for (const p of all.slice(0, MAX_PROJECTS_SEARCHED)) {
    try {
      return { project: p, result: await get<WorkResult>(c, path(p)) };
    } catch (e) {
      if (!(e instanceof RelayRefused) || e.status !== 404) throw e;
    }
  }
  throw new Usage(`No work item ${line(id)} in ${all.length > MAX_PROJECTS_SEARCHED ? `the first ${MAX_PROJECTS_SEARCHED} of your projects` : 'your projects'}. Pass --project if it is in one you cannot list.`);
}

function gone(e: unknown, id: string, p: ProjectRef): unknown {
  if (e instanceof RelayRefused && e.status === 404 && e.message.endsWith(WORK_GONE)) return new Usage(`${line(p.name)} has no work item ${line(id)}.`);
  return e;
}

registerCommand({
  name: 'work',
  topic: 'workspace',
  usage: 'crossroom work list|show|new|update|move|assign|import|sync|room|rooms|join [--project <p>]',
  summary: "a project's work items, and rooms opened on them",
  more: [
    { usage: 'list [--state <s>] [--json] | show <id> | new "<title>" --project <p> [--brief "<text>" | --brief-file <file|->] [--criterion "<text>"]...' },
    { usage: '[--expects <artifact id>]', summary: 'new: the artifact the item should produce' },
    { usage: 'update <id> [--title "<t>"] [--brief "<text>"] [--criterion "<text>"]... [--review <YYYY-MM-DD|none>]' },
    { usage: 'move <id> <state> [--note "<text>"] | assign <id> <person|team|agent|me|none> [--note "<text>"] | room <id>' },
    { usage: 'import <github, azure devops or jira url> --project <p>' },
    { usage: 'sync <github repo | azure devops or jira project url> --project <p> [--query "<q>"] [--sprint current] [--team "<t>"] [--limit <n>]' },
    { usage: '[--assignee me|none|<name>] [--state <s>]... [--type <t>]... [--area <a>] [--label <l>]...', summary: 'sync: only the items that match' },
    { usage: 'rooms <project> | join <room> [--replace]: a seat of your own, for your agent' },
  ],
  order: 181,
  run(args) {
    return workCommand(args, (l) => console.log(l));
  },
});
