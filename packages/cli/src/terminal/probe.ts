/**
 * Ask the terminal whether it reads OSC 7501 (the Program Status Protocol), as the protocol says:
 * the probe, then DA1, which every terminal answers, so a terminal that knows nothing of 7501 still
 * answers something and the wait is short. Orca answers the probe; tmux does not pass it on, so
 * inside tmux the answer is no.
 *
 * Only when both stdin and stdout are a terminal: the answer arrives on stdin, in raw mode, which is
 * left again before anything else reads it. At most `ms` milliseconds.
 */
import { probeSaysYes, STATUS_PROBE } from './sequences.js';

export async function probeStatusProtocol(ms = 400, io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } = { stdin: process.stdin, stdout: process.stdout }): Promise<boolean> {
  const { stdin, stdout } = io;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') return false;
  const wasRaw = stdin.isRaw;
  let answer = '';
  return await new Promise<boolean>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      stdin.off('data', onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {}
      stdin.pause();
      resolve(probeSaysYes(answer));
    };
    const onData = (chunk: Buffer | string) => {
      answer += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
      // Raw mode swallows Ctrl-C: give it back as the signal it would have been.
      if (answer.includes('\x03')) {
        finish();
        process.kill(process.pid, 'SIGINT');
        return;
      }
      // DA1's answer ends the exchange.
      if (/\x1b\[\?[0-9;]*c/.test(answer) || answer.length > 4096) finish();
    };
    const timer = setTimeout(finish, ms);
    try {
      stdin.setRawMode(true);
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    stdin.on('data', onData);
    stdin.resume();
    stdout.write(STATUS_PROBE);
  });
}
