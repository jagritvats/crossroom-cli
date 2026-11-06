/**
 * The `crossroom-seat` command: `runSeat` with the real process around it.
 */
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { runSeat } from './seat.js';

// WebCrypto is global from Node 19; Node 18 has it only on node:crypto.
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const result = await runSeat(process.argv.slice(2), process.env, fetch, { readFile: (p) => readFile(p, 'utf8'), readStdin });
if (result.out) process.stdout.write(result.out.endsWith('\n') ? result.out : `${result.out}\n`);
if (result.err) process.stderr.write(result.err.endsWith('\n') ? result.err : `${result.err}\n`);
process.exitCode = result.code;
