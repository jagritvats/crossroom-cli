/**
 * The `crossroom` command's subcommands, as a registry. Each says how it is called, what it does and
 * how it runs, and `crossroom help` is built from them (`helpText` in cli.ts).
 *
 * A new subcommand is a new file here that calls `registerCommand` at its top level, plus one
 * import line in client.ts. cli.ts loads client.ts dynamically when `run` starts, so a command file may
 * import anything from cli.ts: by the time it loads, cli.ts has finished loading. This module
 * imports nothing from cli.ts at run time, so both can import it.
 */
import type { Args } from '../cli.js';

/** One line of `crossroom help`: how to call something, and what it does. */
export interface HelpLine {
  /** The left column: `crossroom <name> ...` with its arguments and flags. */
  usage: string;
  /** The right column. A line without one prints its usage alone. */
  summary?: string;
}

/** Another way to call a command, with a help line of its own, printed under the command's own. */
export interface HelpForm {
  usage: string;
  summary: string;
  order: number;
}

export interface Command {
  /** The word after `crossroom`. */
  name: string;
  /** Other words that run it, like `start` for `serve`. The help does not list them. */
  aliases?: string[];
  /** Its help line's right column: what it does, in a few words. */
  summary: string;
  /** Its help line's left column. `crossroom <name>` when left out. */
  usage?: string;
  /** Lines printed under its help line, indented further, for flags that do not fit on it. */
  more?: HelpLine[];
  /**
   * The help topic it is listed under (`HELP_TOPICS`): `crossroom help <topic>` prints the topic's
   * commands whole, and the overview names each. A command with none is listed under "Other
   * commands" at the end of `crossroom help all`; every command Crossroom ships names one,
   * which a registry test checks.
   */
  topic?: HelpTopic;
  /**
   * Its line in the overview, for the topic the overview prints whole (`start`): a short form of
   * `usage`, such as `crossroom new "<topic>"`. `crossroom <name>` when left out.
   */
  synopsis?: string;
  /**
   * Where its help line sits within its topic, lowest first. Commands with the same order keep the
   * order they registered in. The commands in builtin.ts take 10 to 140 in steps of 10; a command
   * without an order is listed after all of them.
   */
  order?: number;
  /** Other forms of the command that the help lists on a line of their own. */
  forms?: HelpForm[];
  /**
   * Flags it takes that never take a value, beyond the shared ones in cli.ts (`SWITCHES`). The
   * words are read before the command is known, so a switch declared here is a switch for every
   * command, as the shared ones are.
   */
  switches?: string[];
  /**
   * Deprecated and frozen: the sentence it says on stderr each time it runs (never under
   * `--service`, where a service's log would repeat it at every start). It still runs exactly as
   * before, but `crossroom help` leaves it out, and `crossroom <name> --help` prints its own lines
   * with the sentence.
   */
  deprecated?: string;
  /**
   * Its own help, for `crossroom <name> --help`. Without one, `--help` prints the whole program's
   * help, as it always did.
   */
  help?: () => string;
  /**
   * Run it. `say` writes a line to stderr, for progress; results go to stdout (`console.log`).
   * The number is the exit code. A mistake the user can fix is a thrown `Usage` (cli.ts), which
   * exits 2 with its message alone; anything else thrown exits 1 with its stack.
   */
  run(args: Args, say: (line: string) => void): Promise<number> | number;
}

/** After every order builtin.ts uses, so a command that names none comes last. */
export const DEFAULT_ORDER = 1000;

/** `run` answers `help` (and `--help`) before it looks for a command, so none can take the word. */
const RESERVED = new Set(['help']);

const WORD = /^[a-z][a-z0-9-]*$/;

const registered: Command[] = [];

/** Every registered command, in the order it registered. */
export const COMMANDS: readonly Command[] = registered;

/** The command a word runs, by its name or one of its aliases. */
export function findCommand(word: string): Command | undefined {
  return registered.find((c) => c.name === word || (c.aliases?.includes(word) ?? false));
}

/**
 * Add a command. Throws if one of its words is taken, reserved or not a command word, or a switch
 * is not a flag name. Returns what removes it again, for tests.
 */
export function registerCommand(cmd: Command): () => void {
  const words = [cmd.name, ...(cmd.aliases ?? [])];
  for (const w of words) {
    if (!WORD.test(w)) throw new Error(`"${w}" cannot name a command: use lowercase letters, digits and hyphens.`);
    if (RESERVED.has(w)) throw new Error(`"${w}" is reserved: \`crossroom ${w}\` is answered before any command runs.`);
    if (findCommand(w)) throw new Error(`There is already a command "${w}".`);
  }
  if (new Set(words).size !== words.length) throw new Error(`Command "${cmd.name}" names one word twice.`);
  for (const s of cmd.switches ?? []) if (!WORD.test(s)) throw new Error(`"${s}" cannot be a switch: give it without the leading --.`);
  registered.push(cmd);
  return () => {
    const i = registered.indexOf(cmd);
    if (i >= 0) registered.splice(i, 1);
  };
}

/** The switches registered commands declare, for `parseArgs`. */
export function commandSwitches(): Set<string> {
  return new Set(registered.flatMap((c) => c.switches ?? []));
}

/** Every `--flag` a command's own help names: its usage, the lines under it and its forms. */
export function helpFlags(c: Command): Set<string> {
  const text = [c.usage ?? '', c.summary, ...(c.more ?? []).flatMap((l) => [l.usage, l.summary ?? '']), ...(c.forms ?? []).flatMap((f) => [f.usage, f.summary])].join(' ');
  return new Set([...text.matchAll(/--([a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]!));
}

/**
 * Flags the code reads that no command's help names: ones a plugin, a service unit or a test passes,
 * and older spellings kept working. `knownFlags` adds them to what the help names, and
 * a test fails on a flag the code reads that is in neither, so a new flag is either
 * documented in its command's help or listed here on purpose.
 */
export const UNLISTED_FLAGS: readonly string[] = [
  // The plugin's hooks and skills and the background service units pass these; nobody types them.
  'seat', 'service', 'service-env',
  // Flags of commands whose help line has no room for them.
  'api', 'cancel-move', 'config', 'data', 'description', 'github', 'issues', 'link', 'minutes', 'move', 'provider', 'since', 'site', 'team-token', 'to', 'workspace',
  // Older names: `panel open --server`, from before every command took `--instance`.
  'server',
];

/** Every flag any command takes, as far as Crossroom knows: the help's, the switches and `UNLISTED_FLAGS`. */
export function knownFlags(shared: Iterable<string> = []): Set<string> {
  const known = new Set<string>([...shared, ...commandSwitches(), ...UNLISTED_FLAGS]);
  for (const c of registered) for (const f of helpFlags(c)) known.add(f);
  return known;
}

/** The edit distance between two short words, for "did you mean". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** Words people type for a flag that has another name here. */
const FLAG_SYNONYMS: Record<string, string> = { url: 'relay', server: 'relay', endpoint: 'relay', origin: 'relay', topic: 'title', quiet: 'no-open' };

/**
 * The flag someone probably meant by one Crossroom doesn't know: a known synonym, else the nearest
 * of the command's own flags, else of every flag, within two edits. Null when nothing is close.
 */
export function suggestFlag(name: string, command: Command | undefined, known: Set<string>): string | null {
  const own = command ? helpFlags(command) : new Set<string>();
  const syn = FLAG_SYNONYMS[name];
  if (syn && (own.has(syn) || known.has(syn))) return syn;
  for (const pool of [own, known]) {
    let best: string | null = null;
    let bestD = 3;
    for (const f of pool) {
      const dd = distance(name, f);
      if (dd < bestD) [best, bestD] = [f, dd];
    }
    if (best) return best;
  }
  return null;
}

/**
 * The help's topics, in the order the overview and `crossroom help all` print them. A topic's id is
 * what `crossroom help <topic>` takes, so none may be a command's name (a registry test checks it); an alias
 * may share one, since the help lists no alias (`start` is `serve`'s).
 */
export const HELP_TOPICS = [
  { id: 'start', title: 'Start a room' },
  { id: 'follow', title: 'Follow and finish a room' },
  { id: 'lanes', title: 'Lanes: items for another repository, worked on its next pass' },
  { id: 'computer', title: 'Your own agents and this computer' },
  { id: 'workspace', title: 'Your account and workspace' },
  { id: 'plugin', title: 'Seats this computer holds (the plugins run these)' },
] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number]['id'];

/** Where a command with no topic is listed. */
const OTHER = { id: 'other', title: 'Other commands' } as const;

/** The help's right column starts here, unless the left one is too long for it. */
export const HELP_COLUMN = 48;

/** One help line: the left column indented, then the right one at `column` or two spaces on. */
export function helpLine(line: HelpLine, indent = '  ', column = HELP_COLUMN): string {
  const left = `${indent}${line.usage}`;
  if (!line.summary) return left;
  return left.length + 2 <= column ? `${left.padEnd(column)}${line.summary}` : `${left}  ${line.summary}`;
}

/** A command's own lines: its usage, the flags under it, then its other forms. */
export function commandHelpLines(c: Command): string[] {
  return [
    helpLine({ usage: c.usage ?? `crossroom ${c.name}`, summary: c.summary }),
    ...(c.more ?? []).map((l) => helpLine(l, '        ')),
    ...[...(c.forms ?? [])].sort((a, b) => a.order - b.order).map((f) => helpLine(f)),
  ];
}

/** The commands a topic lists, by their order (stable: equal orders keep the order they registered in). Deprecated ones never. */
export function commandsIn(topic: HelpTopic | 'other'): Command[] {
  return registered
    .filter((c) => !c.deprecated && (c.topic ?? 'other') === topic)
    .sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER));
}

/** A topic by its id, or undefined. `other` is a topic only while some command has none. */
export function helpTopic(id: string): { id: HelpTopic | 'other'; title: string } | undefined {
  const t = HELP_TOPICS.find((x) => x.id === id);
  if (t) return t;
  return id === OTHER.id && commandsIn('other').length ? OTHER : undefined;
}

/** A topic's page: its title, then each of its commands whole. */
export function topicLines(id: HelpTopic | 'other'): string[] {
  const t = helpTopic(id);
  if (!t) return [];
  return [t.title, '', ...commandsIn(t.id).flatMap(commandHelpLines)];
}

/** Every topic's page, one after another: what `crossroom help all` lists. */
export function helpLines(): string[] {
  const ids = [...HELP_TOPICS.map((t) => t.id), ...(commandsIn('other').length ? [OTHER.id] : [])] as Array<HelpTopic | 'other'>;
  return ids.filter((id) => commandsIn(id).length).flatMap((id, i) => [...(i ? [''] : []), ...topicLines(id)]);
}

/** The overview's own column: the start commands' short forms are narrower than the full usage. */
export const OVERVIEW_COLUMN = 36;

/** What a person wants, and the command for it: the start topic's commands overlap, so the overview says which fits. */
const WHICH_ONE: ReadonlyArray<readonly [string, string]> = [
  ['your agents, in panes of this terminal', 'crossroom new "<topic>" --launch claude,codex'],
  ['a session that already knows the code', 'crossroom sessions, then --resume <agent>:<id>'],
  ['seats someone handed you', 'crossroom launch <seat link>...'],
  ["someone else's agent, or a teammate's", 'crossroom new "<topic>", then hand on the line it prints'],
  ['a quick answer from another folder', 'crossroom ask <dir> "<question>" (the agent runs out of sight)'],
  ['one of your own agents, wherever it runs', 'crossroom call <agent> "<what you need>"'],
];

/**
 * The overview `crossroom help` prints: how to start a room, whole, with which command fits when;
 * then each other topic in a line, with the commands it holds.
 */
export function overviewLines(): string[] {
  const start = HELP_TOPICS[0];
  const lines = [
    `${start.title}:`,
    ...commandsIn(start.id).map((c) => helpLine({ usage: c.synopsis ?? `crossroom ${c.name}`, summary: c.summary }, '  ', OVERVIEW_COLUMN)),
    '',
    'Which one:',
    ...WHICH_ONE.map(([want, use]) => helpLine({ usage: want, summary: use }, '  ', OVERVIEW_COLUMN + 8)),
    '',
    'More, by topic (crossroom help <topic>):',
  ];
  const others = [...HELP_TOPICS.slice(1), ...(commandsIn('other').length ? [OTHER] : [])];
  for (const t of others) {
    const names = commandsIn(t.id).map((c) => c.name);
    if (names.length) lines.push(helpLine({ usage: t.id, summary: `${t.title}: ${names.join(', ')}` }, '  ', 14));
  }
  lines.push(helpLine({ usage: 'all', summary: 'every command, with every flag' }, '  ', 14));
  return lines;
}
