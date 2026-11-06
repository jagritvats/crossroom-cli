/**
 * `crossroom project` (workspace I6): bring a GitHub issue into a project, or take a project out,
 * signed in with `crossroom login`'s API token.
 *
 * - `crossroom project import <url> --project <p> [--workspace <w>] [--json]`: the public GitHub
 *   issue or pull request `<url>` names becomes a work item that mirrors it (`POST .../import`).
 *   The relay fetches it, not this machine; importing the same URL again refreshes the item.
 * - `crossroom project export <project> [--format json|md|package] [--out <file>] [--workspace <w>]`:
 *   the project's brief, work, artifacts and accepted knowledge (`GET .../export`), for a project
 *   admin. Without `--out` the document goes to stdout; with it, to a new file made `0600`, never
 *   over one that exists. The document holds the project's content in the clear, so it is as
 *   private as the file or pipe it lands in.
 *
 * On a terminal, an exported document is printed with control characters blanked, since what is in
 * it was written by other people; piped or written to a file it is exactly what the relay sent.
 */
import { closeSync, openSync, statSync, writeSync } from 'node:fs';
import { EXPORT_FORMATS, type ExportFormat, type ImportResult } from '@parley/shared/work';
import { isAzureHost } from '@parley/shared/azure-devops';
import { type Args, Usage } from '../cli.js';
import { registerCommand } from './index.js';
import { block, type Client, flag, line, pickProject } from './project-pick.js';
import { call, callText, type FetchLike, realFetch, RelayRefused, signedIn } from './relay-call.js';

const USAGE = [
  'Usage: crossroom project import <url> --project <p> [--workspace <w>] [--json]',
  '       crossroom project export <project> [--format json|md|package] [--out <file>] [--workspace <w>]',
].join('\n');

const ACCEPT: Record<ExportFormat, string> = { json: 'application/json', md: 'text/markdown', package: 'application/json' };

export interface ProjectDeps {
  fetch: FetchLike;
  /** Whether stdout is a terminal, where a document is printed with its control characters blanked. */
  tty: boolean;
}
const realDeps: ProjectDeps = { fetch: realFetch, tty: process.stdout.isTTY === true };

/** Write a document to a file that does not exist yet, readable by this user only. */
function writeNew(file: string, doc: string): number {
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Usage(`${line(file)} exists already. Choose a file that does not.`);
    throw new Usage(`Could not write ${line(file)}: ${code ?? 'the file could not be made'}.`);
  }
  try {
    writeSync(fd, doc);
  } finally {
    closeSync(fd);
  }
  return statSync(file).size;
}

export async function projectCommand(args: Args, out: (line: string) => void, say: (line: string) => void, deps: ProjectDeps = realDeps): Promise<number> {
  const form = args.positional[0];
  const json = args.flags.json === true;
  if (form !== 'import' && form !== 'export') throw new Usage(USAGE);
  const workspace = flag(args, 'workspace');

  if (form === 'import') {
    const url = args.positional[1];
    if (!url || args.positional.length > 2) throw new Usage(USAGE);
    const named = flag(args, 'project');
    if (!named) throw new Usage(`Say which project the issue goes into, with --project <id or name>.\n${USAGE}`);
    if (isAzureHost(url)) throw new Usage('For an Azure DevOps work item, run `crossroom work import <url> --project <p>`: it reads a private item with your own token, which never reaches Crossroom. Nothing was sent.');
    if (!/^https:\/\/(www\.)?github\.com\//i.test(url)) throw new Usage(`${line(url)} is not a GitHub address. Give the issue's or pull request's https://github.com/... page. Nothing was sent.`);
    const { relay, token } = signedIn(args);
    const c: Client = { relay, token, fetchImpl: deps.fetch };
    const p = await pickProject(c, named, workspace, USAGE);
    const r = await call<ImportResult>(relay, token, deps.fetch, 'POST', `/api/projects/${encodeURIComponent(p.id)}/import`, { url });
    if (json) out(JSON.stringify({ project: p, ...r }, null, 2));
    else out(`${r.updated ? 'Refreshed' : 'Imported'} ${r.item.id} in ${line(p.name)}: ${line(r.item.title)}`);
    return 0;
  }

  const named = args.positional[1];
  if (!named || args.positional.length > 2) throw new Usage(USAGE);
  const format = flag(args, 'format') ?? 'json';
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw new Usage(`--format is one of ${EXPORT_FORMATS.join(', ')}; got "${line(format)}".`);
  const file = flag(args, 'out');
  const { relay, token } = signedIn(args);
  const c: Client = { relay, token, fetchImpl: deps.fetch };
  const p = await pickProject(c, named, workspace, USAGE);
  let doc: string;
  try {
    doc = await callText(relay, token, deps.fetch, 'GET', `/api/projects/${encodeURIComponent(p.id)}/export?format=${format}`, ACCEPT[format as ExportFormat]);
  } catch (e) {
    if (e instanceof RelayRefused && e.status === 404) throw new Usage(`${e.message} (Exporting a project is for its admins.)`);
    throw e;
  }
  if (file !== undefined) {
    const bytes = writeNew(file, doc);
    out(`Wrote ${line(file)} (${bytes} bytes): ${line(p.name)}, ${format}.`);
    say('It holds the project in the clear. Keep it as private as the project.');
    return 0;
  }
  if (deps.tty) {
    say('(Control characters are blanked for display. Use --out for the exact document.)');
    out(block(doc).replace(/\n+$/, ''));
  } else out(doc.replace(/\n$/, ''));
  return 0;
}

registerCommand({
  name: 'project',
  topic: 'workspace',
  usage: 'crossroom project import <url> --project <p>',
  summary: 'import a GitHub issue as work, or export a project',
  more: [{ usage: 'export <project> [--format json|md|package] [--out <file>]' }],
  order: 183,
  run(args, say) {
    return projectCommand(args, (l) => console.log(l), say);
  },
});
