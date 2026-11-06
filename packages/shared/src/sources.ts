/**
 * The files and line ranges a packet's source names, as agents write them (`parseSource`). Pure,
 * with no Node APIs: Crossroom's source check (sourcecheck.ts in the client) reads the files it
 * returns, and a standing seat's policy (`pathsNamedIn` in ./policy.ts) denies any source whose
 * paths include a denied one, so the two can never disagree about what a source names.
 */

export interface CitedFile {
  path: string;
  /** Inclusive, 1-based. Empty means the whole file. */
  ranges: Array<[number, number]>;
  /** The commit the source reads the file at, lower-case hex as cited. Absent: the working tree. */
  commit?: string;
  /**
   * The path is as `git show <sha>:<path>` reads it: from the repository's top wherever git runs,
   * or from where it runs (the seat's directory) when it starts `./` or `../`.
   */
  fromTop?: true;
}

/** At most this many files are read from one source. */
const MAX_FILES = 8;

/** Looks like a path: no spaces, not a URL, and either a directory in it or an extension. */
function looksLikePath(p: string): boolean {
  if (!p || /\s/.test(p) || p.includes('://') || p.startsWith('-')) return false;
  return /[\\/]/.test(p) || /\.[A-Za-z0-9]{1,10}$/.test(p);
}

/**
 * `w.replace(/^[`'"]+|[`'"]+$/g, '')`, in time linear in the word: that regular expression
 * backtracks from every character of a long run of quotes that something else follows.
 */
function unquote(w: string): string {
  const quote = (c: string | undefined) => c === '`' || c === "'" || c === '"';
  let a = 0;
  let b = w.length;
  while (a < b && quote(w[a])) a++;
  while (b > a && quote(w[b - 1])) b--;
  return w.slice(a, b);
}

/**
 * `a.ts@abc1234`, `a.ts:10-20 @ abc1234`, `a.ts@abc1234:10-20`: an item with the commit it names
 * taken out. The `@` must follow the item's first word and the id must end there, so a scoped
 * package (`node_modules/@types/x.d.ts`), `icon@2x.png` or an address is not read as a commit.
 */
function splitCommit(item: string): { text: string; commit?: string } {
  const m = item.match(/^(\S+?)\s*@\s*([0-9a-fA-F]{7,40})(?=$|[\s:#`'"])([\s\S]*)$/);
  return m ? { text: m[1]! + m[3]!, commit: m[2]!.toLowerCase() } : { text: item };
}

/**
 * `git show abc1234:src/a.ts`, the one git command whose output is a file at a commit: what it
 * names after the colon (the path, with any `:10-20`) and the commit. Null for any other git
 * command (`git show abc1234 -- a.ts` prints a diff; `git show HEAD:a.ts` names no fixed commit),
 * undefined for a segment that is not git at all.
 */
function gitShow(segment: string): { item: string; commit: string } | null | undefined {
  const words = segment.trim().split(/\s+/).map(unquote);
  if (words[0] !== 'git') return undefined;
  if (words[1] !== 'show') return null;
  const m = words
    .slice(2)
    .find((w) => !w.startsWith('-'))
    ?.match(/^([0-9a-fA-F]{7,40}):(.+)$/);
  return m ? { item: m[2]!, commit: m[1]!.toLowerCase() } : null;
}

/**
 * `segment.replace(/\s*\(.*$/, '')`, in time linear in the segment: that regular expression
 * backtracks from every whitespace character, and a standing seat's policy runs this on a source
 * before any size limit applies (`pathsNamedIn`). Its `.` matches no line terminator, so what it
 * drops is the first `(` after the last one, the whitespace before that `(`, and the rest.
 */
function dropNote(segment: string): string {
  let from = 0;
  for (let i = segment.length - 1; i >= 0; i--) {
    const c = segment.charCodeAt(i);
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) {
      from = i + 1;
      break;
    }
  }
  const open = segment.indexOf('(', from);
  if (open < 0) return segment;
  let end = open;
  while (end > 0 && /\s/.test(segment[end - 1]!)) end--;
  return segment.slice(0, end);
}

/**
 * The files and line ranges a source names, as agents write them: `src/a.ts:40-72`,
 * `docs/api.yaml:25-29,78-86`, `a.ts:17; b.ts:16-31`, `a.ts:1-9 (asker repo)`, `a.ts#L10-L20`,
 * and at a commit: `git show abc1234:a.ts`, `a.ts@abc1234`, `a.ts:10-20 @ abc1234`.
 * Anything that is not a path (a command, a URL, "Slack search, #team-orders") gives nothing.
 */
export function parseSource(source: string | null | undefined): CitedFile[] {
  if (!source) return [];
  const out: CitedFile[] = [];
  for (const segment of source.split(';')) {
    // A note in parentheses after the path is the agent's, not part of it.
    const plain = dropNote(segment);
    // "git show bb3469f -- a.ts, b.ts" is a command, commas and all: only `git show <sha>:<path>`
    // names a file.
    const show = gitShow(plain);
    if (show === null) continue;
    const items = (show ? show.item : plain).split(',');
    if (!show) {
      // Any other command's first word is no path either.
      const lead = unquote(splitCommit(items[0]?.trim() ?? '').text.split(/\s+/)[0] ?? '');
      if (!looksLikePath(lead.replace(/(?::|#L)\d.*$/, ''))) continue;
    }
    for (const raw of items) {
      const { text, commit: named } = splitCommit(raw.trim());
      const commit = named ?? show?.commit;
      const fromTop = show && !named;
      // "docs/api.yaml §3.2" names the file by its first word.
      const item = unquote(text.split(/\s+/)[0] ?? '');
      if (!item) continue;
      const cont = item.match(/^L?(\d+)(?:\s*-\s*L?(\d+))?$/);
      if (cont) {
        // "78-86" after "docs/api.yaml:25-29,": another range of the file before it, and a commit
        // at the end of the list ("25-29,78-86 @ abc1234") is that file's.
        const last = out.at(-1);
        if (last && last.ranges.length) {
          last.ranges.push(range(cont[1]!, cont[2]));
          if (commit && !last.commit) last.commit = commit;
        }
        continue;
      }
      const m = item.match(/^((?:[A-Za-z]:[\\/])?[^:#\s]+?)(?:(?::|#L)(\d+)(?:\s*-\s*L?(\d+))?)?:?$/);
      if (!m || !looksLikePath(m[1]!)) continue;
      out.push({ path: m[1]!, ranges: m[2] ? [range(m[2], m[3])] : [], ...(commit ? { commit } : {}), ...(fromTop ? { fromTop: true as const } : {}) });
      if (out.length >= MAX_FILES) return out;
    }
  }
  return out;
}

function range(a: string, b: string | undefined): [number, number] {
  const x = Math.max(1, Number(a));
  const y = b === undefined ? x : Math.max(1, Number(b));
  return x <= y ? [x, y] : [y, x];
}
