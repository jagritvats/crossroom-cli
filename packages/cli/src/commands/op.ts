/**
 * `crossroom op <call> [key=value | key@file | key@-]… [--host codex]`: one of a seat's calls (join,
 * wait, say, share_context…), made the way the seat helper makes it, for the seat this session
 * holds (`seatOp` in cli.ts).
 *
 * It is how an agent in Codex or in Claude Code takes part in a room without curl. Codex runs a
 * model's commands in a sandbox with no network, so every `curl` to the seat would ask for
 * approval, and an approval rule matches only commands made of plain words: no `$L`, no heredoc, and
 * a `curl` rule would allow any request anywhere. One rule for `crossroom op` covers every call
 * instead (plugins/crossroom/codex/crossroom.rules), and the seat's token is in no command the agent
 * writes.
 *
 * Claude Code since the owner's decision of 2026-11-17: a seat held over curl needed an approval or
 * a curl allow rule on every call, Git Bash's curl turned non-ASCII text into `?` through the ANSI
 * code page, Windows PowerShell 5.1 answered `curl` with its own alias, and each empty `wait` cost a
 * turn every 45 s. So a Claude Code session's seat takes `crossroom op` too, under the one rule
 * `Bash(crossroom op:*)`, and its `wait` holds for up to `--for` seconds, retrying blips.
 *
 * Because one rule runs it unasked, it speaks only for the seat the session holds, found by the
 * session id the host itself sets in the command's environment (CODEX_SESSION_ID,
 * CLAUDE_CODE_SESSION_ID): one seat per session, no `--seat`, no `--session` naming another
 * (`opSeat`). Text read from stdin or a file is decoded here (`decodeLocalText`), as UTF-8 whatever
 * the console's code page.
 */
import { readFile } from 'node:fs/promises';
import { seatOp } from '../cli.js';
import { decodeLocalText } from '../shell-text.js';
import { registerCommand } from './index.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return decodeLocalText(Buffer.concat(chunks));
}

registerCommand({
  name: 'op',
  topic: 'plugin',
  usage: 'crossroom op <call> [key=value]... [--host codex]',
  summary: "one of a seat's calls without curl, for the seat this Claude Code or Codex session holds",
  more: [{ usage: '[--for <seconds>]', summary: "how long `wait` holds, retrying blips (Claude Code's default 100, at most 110)" }],
  order: 125,
  async run(args, say) {
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const r = await seatOp(args, { readFile: async (p) => decodeLocalText(await readFile(p)), readStdin }, fetch, { signal: ctl.signal });
      if (r.out) console.log(r.out.replace(/\n$/, ''));
      if (r.err) say(r.err.replace(/\n$/, ''));
      return r.code;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  },
});
