/**
 * Which project a `crossroom work`, `artifact` or `project` command means, and a few things they all
 * print or read.
 *
 * A project is named by its id, or by its name within the workspaces `GET /api/workspaces` lists
 * for the account (`--workspace` narrows it by a workspace's name or id when two hold the same
 * name). Only projects the account can open at all are candidates: a project the account holds no
 * role on answers the relay's one 404, so naming it would say nothing a list had not.
 *
 * Text that came from a relay is a stranger's words as far as this terminal goes: a title or a
 * brief another participant wrote can carry escape sequences, so everything printed goes through
 * `line` or `block`, which blank every control character and separator.
 */
import { createReadStream, statSync } from 'node:fs';
import type { OrgDetail, ProjectView } from '@parley/shared/org';
import type { WorkspacesResult, WorkspaceSummary } from '@parley/shared/work';
import { LINE_BREAK } from '@parley/shared/text';
import { type Args, text, Usage } from '../cli.js';
import { call, type FetchLike } from './relay-call.js';

/** The most projects a command that looks through all of them asks about: each is one request. */
export const MAX_PROJECTS_SEARCHED = 25;

export interface ProjectRef {
  id: string;
  name: string;
  role: ProjectView['role'];
  workspace: Pick<WorkspaceSummary, 'id' | 'name' | 'kind'>;
}

/** A relay and the account's token, with the way to reach it. What every request here is made with. */
export interface Client {
  relay: string;
  token: string;
  fetchImpl: FetchLike;
}

export const get = <T>(c: Client, path: string) => call<T>(c.relay, c.token, c.fetchImpl, 'GET', path);

/** A character as it prints: itself, or a space where it is a control, a separator or a bidirectional override. */
function safeChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  const blank = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
  return blank ? ' ' : ch;
}

/** One line of participant-written text: breaks and controls become spaces, so it cannot start a line of its own. */
export const line = (s: string): string => [...s].map(safeChar).join('').replace(/\s+/g, ' ').trim();

/** Several lines of participant-written text: line breaks kept (any kind becomes a newline), every other control blanked. */
export const block = (s: string): string =>
  s
    .split(LINE_BREAK)
    .map((l) => [...l].map(safeChar).join('').trimEnd())
    .join('\n');

/** The projects of every workspace the account is in (or of the one `--workspace` names), most recent workspaces first as the relay lists them. */
export async function listProjects(c: Client, workspace?: string): Promise<ProjectRef[]> {
  const all = (await get<WorkspacesResult>(c, '/api/workspaces')).workspaces;
  const named = workspace?.toLowerCase();
  const chosen = named === undefined ? all : all.filter((w) => w.id === workspace || w.name.toLowerCase() === named || (named === 'personal' && w.kind === 'personal'));
  if (workspace !== undefined && chosen.length === 0)
    throw new Usage(`You are not in a workspace called "${line(workspace)}" on ${c.relay}.${all.length ? ` Yours: ${all.map((w) => line(w.name)).join(', ')}.` : ''}`);
  const out: ProjectRef[] = [];
  for (const w of chosen) {
    const detail = await get<OrgDetail>(c, `/api/orgs/${encodeURIComponent(w.id)}`);
    for (const p of detail.projects) if (p.role) out.push({ id: p.id, name: p.name, role: p.role, workspace: { id: w.id, name: w.name, kind: w.kind } });
  }
  return out;
}

const where = (p: ProjectRef) => `${line(p.name)} in ${p.workspace.kind === 'personal' ? 'your personal workspace' : line(p.workspace.name)} (${p.id})`;

/** The project a user named, by id or by name, or a line saying which projects there are. */
export async function pickProject(c: Client, named: string | undefined, workspace?: string, usage = ''): Promise<ProjectRef> {
  if (!named) throw new Usage(`Name a project, by id or by name.${usage ? ` ${usage}` : ''}`);
  const projects = await listProjects(c, workspace);
  const byId = projects.find((p) => p.id === named);
  if (byId) return byId;
  const lower = named.toLowerCase();
  const byName = projects.filter((p) => p.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1)
    throw new Usage(`More than one project is called "${line(named)}": ${byName.map(where).join('; ')}. Use its id, or pass --workspace <name>.`);
  throw new Usage(
    `No project called "${line(named)}" on ${c.relay}${workspace ? ` in ${line(workspace)}` : ''}.${
      projects.length ? ` Yours: ${projects.slice(0, 10).map(where).join('; ')}${projects.length > 10 ? '; …' : ''}.` : ' You hold no project yet.'
    }`,
  );
}

/** The flag's value as text, or undefined; a switch given with no value is a mistake. */
export function flag(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  if (v === true) throw new Usage(`--${name} needs a value.`);
  return text(v);
}

/** How much of a file or of stdin a command reads before it refuses: more than any field it could fill. */
export const MAX_READ_BYTES = 1_000_000;

/** What `-` reads from. Tests pass their own. */
export type StdinReader = () => Promise<Buffer>;

export const realStdin: StdinReader = async () => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk as Uint8Array);
    size += b.length;
    if (size > MAX_READ_BYTES) throw new Usage(`What came on stdin is larger than ${MAX_READ_BYTES / 1000} KB. Nothing was sent.`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
};

/**
 * A file's text, or stdin's for `-`: UTF-8 and nothing else, bounded by bytes before it is read,
 * so a binary file or a device is refused rather than turned into text.
 */
export async function readText(file: string, what: string, stdin: StdinReader = realStdin): Promise<string> {
  let buf: Buffer;
  if (file === '-') buf = await stdin();
  else {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(file);
    } catch {
      throw new Usage(`There is no file at ${line(file)}.`);
    }
    if (!st.isFile()) throw new Usage(`${line(file)} is not a file.`);
    if (st.size > MAX_READ_BYTES) throw new Usage(`${line(file)} is ${st.size} bytes, more than the ${MAX_READ_BYTES / 1000} KB ${what} can take. Nothing was sent.`);
    buf = await readFileBounded(file);
  }
  if (buf.includes(0)) throw new Usage(`${file === '-' ? 'stdin' : line(file)} is not text (it holds a NUL byte). Nothing was sent.`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new Usage(`${file === '-' ? 'stdin' : line(file)} is not UTF-8 text. Nothing was sent.`);
  }
}

async function readFileBounded(file: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const b = chunk as Buffer;
    size += b.length;
    // The file may have grown since it was measured.
    if (size > MAX_READ_BYTES) throw new Usage(`${line(file)} grew past ${MAX_READ_BYTES / 1000} KB while it was read. Nothing was sent.`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
