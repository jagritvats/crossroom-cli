/**
 * `crossroom conformance <url>`: checks that a server speaks the open room protocol,
 * with the same library the server's own tests run in process (packages/conformance).
 *
 * - How it gets the rooms it checks, one of three (`ConformanceCreate`, @parley/shared/protocol):
 *   `--create quick` (the default) makes them, at most `CONFORMANCE_ROOMS_MAX` (3), at no more than
 *   `CONFORMANCE_CREATES_PER_MINUTE` (6), each deleted when it is done; `--owner-token-file <file>`
 *   checks one room someone made, the file holding that room's private link (`/s/<id>#k=<token>`,
 *   and any of its seat links to use), or `-` for stdin, never a token in argv where any process on
 *   the machine can read it; `--cmd "<command>"` runs a command that prints a room's links, once per
 *   room it needs, with `PARLEY_CONFORMANCE_ROOM` set to `plain` or `e2ee`. A room someone handed it
 *   is theirs: the suite writes in it as the seats it was given links to, replaces no other seat's
 *   link, and neither ends nor deletes it.
 * - `--only <check>[,<check>]`: some of `CONFORMANCE_CHECKS`; `--json`: the report, as JSON.
 * - It checks the identical 404s, that a GET `wait` answers 405, cursor semantics, fences, forged
 *   headings, evidence, the unanimity floor, concessions, addressing, the 410 after a link is
 *   replaced, the end-to-end text refusals, chain v2 recomputed from a bundle, and signatures.
 * - It says what the server under test answered in its own words, never by printing the server's
 *   text, and sends a token only to the URL it was given, never following a redirect.
 *
 * Exit 0 when every check it ran passed (a check that cannot run here is skipped, and says why), 1
 * otherwise, 2 for a mistake in how it was called. A golden test pins the help lines.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CONFORMANCE_CHECKS, type ConformanceCheck } from '@parley/shared/protocol';
import { type ConformanceRun, type RoomKind, type RoomSource, runConformance, serverBase } from '../../../conformance/src/index.js';
import { text, Usage } from '../cli.js';
import { killTree } from '../runners/tree.js';
import { registerCommand } from './index.js';

const USAGE =
  'Usage: crossroom conformance <url> [--create quick | --owner-token-file <file> | --cmd "<command>"] [--only <check>[,<check>]] [--json]';

/** The most a room file, stdin, or a command's output is read for: a few links, never more. */
const READ_CAP = 64 * 1024;
/** How long a `--cmd` command may take to make a room. */
const CMD_TIMEOUT_MS = 60_000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    chunks.push(b);
    size += b.length;
    if (size >= READ_CAP) break;
  }
  return Buffer.concat(chunks).subarray(0, READ_CAP).toString('utf8');
}

function readRoomFile(file: string): string {
  try {
    return readFileSync(file).subarray(0, READ_CAP).toString('utf8');
  } catch {
    // Not the file's text, nor the error's: a path someone typed may be a token pasted by mistake.
    throw new Usage('--owner-token-file names a file that could not be read.');
  }
}

/** Runs `--cmd` for one room: its stdout, the room's links in it. Its stderr passes through. */
export function runRoomCommand(command: string, kind: RoomKind): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      env: { ...process.env, PARLEY_CONFORMANCE_ROOM: kind },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
      // Its own process group on POSIX, so a command that hangs is stopped with everything it started.
      detached: process.platform !== 'win32',
    });
    let out = '';
    const timer = setTimeout(() => killTree(child), CMD_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < READ_CAP) out += d.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('the --cmd command could not be started'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`the --cmd command exited with ${code ?? 'a signal'}`));
    });
  });
}

function checksFrom(v: string | undefined): ConformanceCheck[] | undefined {
  if (v === undefined) return undefined;
  const names = v.split(',').map((s) => s.trim()).filter(Boolean);
  const known = new Set<string>(CONFORMANCE_CHECKS);
  const unknown = names.filter((n) => !known.has(n));
  if (!names.length || unknown.length) throw new Usage(`--only takes some of: ${CONFORMANCE_CHECKS.join(', ')}.`);
  return names as ConformanceCheck[];
}

/** The report a person reads: a line per check, then what was made and cleaned up. */
export function printReport(run: ConformanceRun, print: (line: string) => void): void {
  const width = Math.max(...run.results.map((r) => r.check.length), 5);
  print(`crossroom conformance: ${run.url} (${run.protocol})`);
  for (const r of run.results) print(`  ${r.skipped ? 'skip' : r.ok ? 'ok  ' : 'FAIL'}  ${r.check.padEnd(width)}  ${r.detail}`);
  const passed = run.results.filter((r) => r.ok && !r.skipped).length;
  const failed = run.results.filter((r) => !r.ok).length;
  print('');
  print(
    `${passed} passed, ${failed} failed, ${run.skipped} skipped. ` +
      (run.roomsMade
        ? `Made ${run.roomsMade} room${run.roomsMade === 1 ? '' : 's'}${run.roomsLeft.length ? `, and the server would not delete ${run.roomsLeft.length} of them` : ', and deleted each'}.`
        : 'Made no room.'),
  );
}

registerCommand({
  name: 'conformance',
  topic: 'computer',
  usage: 'crossroom conformance <url>',
  summary: 'check that a server speaks the open room protocol',
  more: [{ usage: '[--create quick | --owner-token-file <file> | --cmd "<command>"] [--only <check>] [--json]' }],
  order: 190,
  async run(args, say) {
    const url = args.positional[0];
    if (!url || args.positional.length > 1) throw new Usage(USAGE);
    try {
      serverBase(url);
    } catch (e) {
      throw new Usage((e as Error).message);
    }
    // A token is read from a file or stdin, never from the command line, where any process can read it.
    for (const flag of ['owner-token', 'token', 'owner'])
      if (flag in args.flags) throw new Usage(`--${flag} is not taken: put the room's private link in a file and pass --owner-token-file <file> (or - for stdin).`);
    const create = text(args.flags.create);
    const file = text(args.flags['owner-token-file']);
    const cmd = text(args.flags.cmd);
    const modes = [args.flags.create !== undefined, file !== undefined, cmd !== undefined].filter(Boolean).length;
    if (modes > 1) throw new Usage('Give one of --create quick, --owner-token-file and --cmd.');
    if (args.flags.create !== undefined && create !== 'quick') throw new Usage('--create takes quick: the suite makes its own rooms.');
    if (args.flags['owner-token-file'] === true || args.flags.cmd === true) throw new Usage(USAGE);
    const only = checksFrom(args.flags.only === true ? '' : text(args.flags.only));
    let source: RoomSource = { kind: 'quick' };
    if (file !== undefined) {
      const room = file === '-' ? await readStdin() : readRoomFile(file);
      source = { kind: 'owner-token', text: room };
    } else if (cmd !== undefined) source = { kind: 'cmd', run: (kind) => runRoomCommand(cmd, kind) };

    // The global fetch, which only commands/ may call: this runs on the caller's machine.
    const run = await runConformance({ url, fetch: (u, init) => fetch(u, init), source, only, log: say });
    if (args.flags.json === true) {
      const { requests: _requests, ...report } = run;
      console.log(JSON.stringify(report, null, 2));
    } else printReport(run, (l) => console.log(l));
    return run.ok ? 0 : 1;
  },
});
