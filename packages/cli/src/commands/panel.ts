/**
 * `crossroom panel list | open <name|file>`: rooms set up from a Panel, a
 * saved room setup with a role per seat and one lead. The panels are this computer's own, as JSON
 * files in `<data>/panels/` (a file the web app exports goes there as it is), plus the built-in
 * panels the create page offers.
 *
 * `open` makes the room through the instance's create route (the hosted one unless `--instance`
 * names another), keeps its owner token in cli-rooms.json as `ask` keeps one, and prints the owner's
 * link and each seat's link with its letter, name and role. A seat the panel gives a runner and a
 * folder is taken by an agent this computer starts there (commands/local-agent.ts): the room is on
 * the instance, the agent and the folder stay here. A relative folder is read from the panel file's.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { type PanelInput, panelSeatsLine, panelToCreateInput, parsePanel } from '@parley/shared/panels';
import { firstLine, slotLetter } from '@parley/shared/text';
import { dataDir, pickRunner, privateLink, type SavedRoom, saveRoom, text, Usage } from '../cli.js';
import { runnerAvailability } from '../runners/hosted.js';
import { checkConfinement, type LocalAgent, shellArg, startLocalAgent } from './local-agent.js';
import { DEFAULT_INSTANCE } from './instance.js';
import { chosenInstance } from './relay-call.js';
import { roomSeatsMax } from '../seat-cap.js';
import { BUILT_IN_PANELS } from '@parley/shared/panels-builtin';
import { registerCommand } from './index.js';

const USAGE = 'Usage: crossroom panel list [--json] | open <name|file> [--title <t>] [--instance <url>] [--no-start] [--unconfined-reads-ok]';

/** Where this computer keeps its panels: `<data>/panels/*.json`. */
export const panelsDir = () => path.join(dataDir(), 'panels');

/** A panel this computer keeps, or the reason its file could not be read as one. */
export interface PanelFile {
  file: string;
  panel?: PanelInput;
  error?: string;
}

/** Every `*.json` in the panels folder, read and checked, by file name. */
export function panelFiles(): PanelFile[] {
  const dir = panelsDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json'));
  } catch {
    return [];
  }
  return names.sort().map((n) => readPanelFile(path.join(dir, n)));
}

function readPanelFile(file: string): PanelFile {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    return { file, error: `it could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  // Held to this computer's cap (`PARLEY_ROOM_SEATS_MAX`, which the local Crossroom reads too, six
  // unless raised). Another Crossroom (`--server`) refuses past its own, in its own words, and
  // `open` passes that on.
  const r = parsePanel(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw, { seatsMax: roomSeatsMax() });
  return r.ok ? { file, panel: r.panel } : { file, error: r.error };
}

/** What `open` was given, found: a file's panel and where it came from, or a built-in one. */
export interface FoundPanel {
  panel: PanelInput;
  /** The file it was read from, or null for a built-in panel. */
  file: string | null;
}

const lower = (s: string) => s.trim().toLowerCase();

/**
 * The panel a word names: a path to a file, a file in the panels folder by its name (with or without
 * `.json`), a kept panel by the name inside it, or a built-in panel by its id or name.
 */
export function findPanel(word: string, cwd = process.cwd()): FoundPanel {
  const tryFile = (file: string): FoundPanel | null => {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const f = readPanelFile(file);
    if (!f.panel) throw new Usage(`${file} is not a panel Crossroom can read: ${f.error}`);
    return { panel: f.panel, file };
  };
  const asPath = path.resolve(cwd, word);
  const kept = path.join(panelsDir(), word);
  const found = tryFile(asPath) ?? tryFile(kept) ?? (word.toLowerCase().endsWith('.json') ? null : tryFile(`${kept}.json`));
  if (found) return found;
  const byName = panelFiles().find((f) => f.panel && lower(f.panel.name) === lower(word));
  if (byName?.panel) return { panel: byName.panel, file: byName.file };
  const builtIn = BUILT_IN_PANELS.find((p) => p.id === word || p.id === `panel-${lower(word)}` || lower(p.panel.name) === lower(word));
  if (builtIn) return { panel: builtIn.panel, file: null };
  throw new Usage(`No panel called "${firstLine(word, 60)}": not a file, not in ${panelsDir()}, and not a built-in one. \`crossroom panel list\` shows them.`);
}

/** The panels as `crossroom panel list` prints them. */
export function listText(files: PanelFile[]): string {
  const lines: string[] = [];
  lines.push(files.length ? `Yours, in ${panelsDir()}:` : `None of your own yet. Put a panel's .json file (the create page's Export) in ${panelsDir()}.`);
  for (const f of files) {
    const name = path.basename(f.file, '.json');
    lines.push(f.panel ? `  ${name}  ${firstLine(f.panel.name, 60)}\n            ${panelSeatsLine(f.panel.seats)}` : `  ${name}  not a panel Crossroom can read: ${f.error}`);
  }
  lines.push('', 'Built in:');
  for (const p of BUILT_IN_PANELS) lines.push(`  ${p.id.replace(/^panel-/, '')}  ${p.panel.name}\n            ${panelSeatsLine(p.panel.seats)}`);
  lines.push('', '`crossroom panel open <name|file>` makes a room from one.');
  return lines.join('\n');
}

/** The room `open` made: its owner's link and each seat's. */
export interface OpenedPanel {
  roomId: string;
  title: string;
  ownerUrl: string;
  seats: Array<{ letter: string; name: string; role?: string; lead?: boolean; kind: string; seatUrl: string; agent?: { runtime: string; dir: string; log?: string } }>;
  /** The blanks the shared brief still holds, such as `[the design]`, for a reminder. */
  blanks: string[];
}

/**
 * The panel's body for the create route, and the agent each seat with a runner gets on this
 * computer, by slot. Every seat is attached: the instance starts nothing. A relative folder is read
 * from the panel file's folder.
 */
export function bodyFor(found: FoundPanel, title?: string): { body: ReturnType<typeof panelToCreateInput>; agents: Map<number, { runtime: string; dir: string; model?: string }> } {
  const body = panelToCreateInput(found.panel, title ? { title } : {});
  const from = found.file ? path.dirname(found.file) : process.cwd();
  const agents = new Map<number, { runtime: string; dir: string; model?: string }>();
  body.participants = body.participants.map((p, slot) => {
    if (p.kind !== 'hosted' || !p.hosted) return p;
    const { hosted, ...rest } = p;
    agents.set(slot, { runtime: hosted.runner, dir: path.resolve(from, hosted.cwd ?? '.'), ...(hosted.model ? { model: hosted.model } : {}) });
    return { ...rest, kind: 'attached' as const };
  });
  return { body, agents };
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${res.status} ${res.statusText}`;
}

export async function openPanel(
  word: string,
  opts: { title?: string; base: string; noStart?: boolean; unconfinedOk?: boolean },
  _say: (line: string) => void,
): Promise<OpenedPanel> {
  const found = findPanel(word);
  const { body, agents } = bodyFor(found, opts.title);
  // Every agent is checked before the room exists: a CLI that is missing, or a Codex seat nobody
  // said may read outside its folder, opens nothing.
  const available = runnerAvailability();
  const local = new Map<number, LocalAgent>();
  for (const [slot, a] of agents) {
    const runner = pickRunner(available, a.runtime);
    const agent: LocalAgent = { runtime: runner.id, label: runner.label, dir: a.dir, ...(a.model ? { model: a.model } : {}), unconfinedOk: !!opts.unconfinedOk };
    if (!opts.noStart) checkConfinement(agent);
    if (!existsSync(agent.dir) || !statSync(agent.dir).isDirectory()) throw new Usage(`Seat ${slotLetter(slot)}'s folder, ${agent.dir}, is not a directory. Nothing was opened.`);
    local.set(slot, agent);
  }
  const base = opts.base;
  // Never follows a redirect: the answer carries the room's only owner token.
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
  });
  if (!res.ok) throw new Usage(`Crossroom refused the room: ${await errorOf(res)}`);
  const created = (await res.json()) as {
    session: { id: string; title: string; createdAt: string };
    ownerToken: string;
    participants: Array<{ slot: number; name: string; role?: string; lead?: boolean; kind: string; seatUrl: string }>;
  };
  const dirs = [...new Set([...local.values()].map((a) => a.dir))];
  const saved: SavedRoom = {
    id: created.session.id,
    owner: created.ownerToken,
    title: created.session.title,
    createdAt: created.session.createdAt,
    base,
    ...(dirs.length ? { dirs } : {}),
  };
  saveRoom(saved);
  return {
    roomId: saved.id,
    title: saved.title,
    ownerUrl: privateLink(saved),
    seats: created.participants.map((p) => {
      const agent = local.get(p.slot);
      const started = agent && !opts.noStart ? startLocalAgent(p.seatUrl, agent, { roomId: saved.id, letter: slotLetter(p.slot) }) : null;
      return {
        letter: slotLetter(p.slot),
        name: p.name,
        ...(p.role ? { role: p.role } : {}),
        ...(p.lead ? { lead: true } : {}),
        kind: p.kind,
        seatUrl: p.seatUrl,
        ...(agent ? { agent: { runtime: agent.runtime, dir: agent.dir, ...(started ? { log: started.log } : {}) } } : {}),
      };
    }),
    blanks: [...new Set(body.sharedBrief.match(/\[[^\]\n]{1,60}\]/g) ?? [])],
  };
}

/** What `open` prints: the owner's link first, then a seat a block. */
export function openedText(o: OpenedPanel): string {
  const lines = [`Opened "${firstLine(o.title, 80)}". Your private link (it is the room's only key; keep it):`, `  ${o.ownerUrl}`, '', 'Paste each link into the agent that takes the seat:'];
  for (const s of o.seats) {
    lines.push(`  ${s.letter} · ${firstLine(s.name, 60)}${s.lead ? ' (lead)' : ''}${s.role ? `: ${firstLine(s.role, 160)}` : ''}`);
    if (!s.agent) lines.push(`    ${s.seatUrl}`);
    else if (s.agent.log) lines.push(`    A ${s.agent.runtime} agent takes this seat on this computer, in ${s.agent.dir}. Its log: ${s.agent.log}`);
    else lines.push(`    For a ${s.agent.runtime} agent in ${s.agent.dir} (not started, --no-start): crossroom join ${s.seatUrl} --dir ${shellArg(s.agent.dir)} --with ${s.agent.runtime}`);
  }
  if (o.blanks.length) lines.push('', `The shared brief still holds ${o.blanks.join(', ')}: tell the agents what fills it in your first message, or save a copy of the panel with it filled in.`);
  return lines.join('\n');
}

registerCommand({
  name: 'panel',
  topic: 'start',
  synopsis: 'crossroom panel open <name>',
  usage: 'crossroom panel list|open <name|file> [--title <t>]',
  summary: 'a room set up from a saved panel: a role for each agent, one to lead',
  more: [
    { usage: '[--instance <url>] [--json]', summary: `your panels are .json files in the data directory's panels folder` },
    { usage: '[--no-start] [--unconfined-reads-ok]', summary: 'a seat with a runner and a folder is taken by an agent started on this computer' },
  ],
  order: 46,
  async run(args, say) {
    const action = args.positional[0] ?? 'list';
    switch (action) {
      case 'list': {
        const files = panelFiles();
        if (args.flags.json)
          console.log(
            JSON.stringify(
              {
                yours: files.map((f) => ({ file: f.file, ...(f.panel ? { panel: f.panel } : { error: f.error }) })),
                builtIn: BUILT_IN_PANELS.map((p) => ({ id: p.id, panel: p.panel })),
              },
              null,
              2,
            ),
          );
        else console.log(listText(files));
        return 0;
      }
      case 'open': {
        const word = args.positional[1];
        if (!word || args.positional.length > 2) throw new Usage(USAGE);
        // `--server` was this command's own name for the instance before every command took `--instance`.
        const named = text(args.flags.server);
        const base = chosenInstance(named ? { ...args, flags: { ...args.flags, instance: named } } : args, DEFAULT_INSTANCE);
        const opened = await openPanel(
          word,
          { title: text(args.flags.title), base, noStart: args.flags['no-start'] === true, unconfinedOk: args.flags['unconfined-reads-ok'] === true },
          say,
        );
        console.log(args.flags.json ? JSON.stringify(opened, null, 2) : openedText(opened));
        return 0;
      }
      default:
        throw new Usage(USAGE);
    }
  },
});
