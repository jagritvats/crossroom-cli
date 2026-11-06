/**
 * `crossroom join <seat link> --dir <dir> [--with claude]`: one seat, taken by
 * an agent this command starts in `<dir>`, with a runner's protections (the egress proxy, the
 * policy, no token in any argument) and no registration. How CI answers and how a
 * PR's side of the consumer check takes its seat. The work is `joinSeat` (runner/join.ts).
 *
 * `crossroom join - --dir <dir>` reads the seat link from stdin instead (its first line that is not
 * blank), so the link is in no process's arguments: the consumer check and the answer workflow
 * hand it over that way. The command never prints the link or its token.
 *
 * Also takes `--ref <commit>` (answer from a checkout of that commit), `--deny <glob>`, which may
 * repeat or list globs with commas (more paths the policy refuses), and `--unconfined-reads-ok`,
 * which Codex and Grok need.
 *
 * Exits 0 when the room ends, the seat finishes or the seat is gone; 1 when the agent could not
 * start or stopped on an error; 130 when stopped (Ctrl-C, or the SIGTERM a CI job sends when it is
 * cancelled).
 */
import { flagValues, globList } from '../runner/config.js';
import { joinSeat, JoinUsage, seatLinkFrom } from '../runner/join.js';
import { driverFlag, text, Usage } from '../cli.js';
import { registerCommand } from './index.js';

/** The most of stdin `crossroom join -` reads: a seat link is a line, and nothing else is read from there. */
const STDIN_CAP = 64 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    chunks.push(b);
    size += b.length;
    if (size >= STDIN_CAP) break;
  }
  return Buffer.concat(chunks).subarray(0, STDIN_CAP).toString('utf8');
}

registerCommand({
  name: 'join',
  topic: 'computer',
  usage: 'crossroom join <seat link | -> --dir <dir>',
  summary: "take a seat with an agent started in <dir>, with a runner's protections",
  more: [{ usage: '[--with claude|codex|grok] [--model <name>] [--driver exec|acp]' }, { usage: '[--ref <commit>] [--deny <glob>] [--unconfined-reads-ok]' }],
  order: 160,
  switches: ['unconfined-reads-ok'],
  async run(args, say) {
    const given = args.positional[0];
    const dir = text(args.flags.dir);
    if (!given || !dir)
      throw new Usage('Usage: crossroom join <seat link | -> --dir <dir> [--with claude|codex|grok] [--model <name>] [--driver exec|acp] [--ref <commit>]');
    const driver = driverFlag(text(args.flags.driver));
    const link = given === '-' ? seatLinkFrom(await readStdin()) : given;
    if (!link) throw new Usage('crossroom join - reads the seat link from stdin, and stdin held none.');
    const ac = new AbortController();
    const onSignal = () => {
      if (ac.signal.aborted) process.exit(130);
      say('Stopping the agent (Ctrl-C again to quit at once).');
      ac.abort();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
      const outcome = await joinSeat({
        link,
        dir,
        runtime: text(args.flags.with),
        model: text(args.flags.model),
        ref: text(args.flags.ref),
        deny: globList(flagValues(args, 'deny')),
        unconfinedOk: args.flags['unconfined-reads-ok'] === true,
        ...(driver ? { driver } : {}),
        fetch,
        say,
        signal: ac.signal,
      });
      return outcome === 'stopped' ? 130 : outcome === 'failed' ? 1 : 0;
    } catch (e) {
      if (e instanceof JoinUsage) throw new Usage(e.message);
      throw e;
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  },
});
