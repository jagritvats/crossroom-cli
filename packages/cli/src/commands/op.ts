/**
 * `crossroom op <call> [key=value | key@file | key@-]… --host codex`: one of a seat's calls (join,
 * wait, say, share_context…), made the way the seat helper makes it, for the seat this session
 * holds (`seatOp` in cli.ts).
 *
 * It is how the Crossroom plugin for Codex takes part in a room. Codex runs a model's commands in a
 * sandbox with no network, so every `curl` to the seat would ask for approval, and an approval
 * rule matches only commands made of plain words: no `$L`, no heredoc, and a `curl` rule would
 * allow any request anywhere. One rule for `crossroom op` covers every call instead
 * (plugins/crossroom/codex/parley.rules), and the seat's token is in no command the agent writes.
 * Because that rule runs it unasked, it speaks only for the seat the Codex session holds: no
 * `--seat`, no `--session` (`opSeat`).
 */
import { readFile } from 'node:fs/promises';
import { seatOp } from '../cli.js';
import { registerCommand } from './index.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

registerCommand({
  name: 'op',
  topic: 'plugin',
  usage: 'crossroom op <call> [key=value]... --host codex',
  summary: "one of a seat's calls without curl, for the seat this session holds (the Crossroom plugin for Codex runs it)",
  order: 125,
  async run(args, say) {
    const r = await seatOp(args, { readFile: (p) => readFile(p, 'utf8'), readStdin });
    if (r.out) console.log(r.out.replace(/\n$/, ''));
    if (r.err) say(r.err.replace(/\n$/, ''));
    return r.code;
  },
});
