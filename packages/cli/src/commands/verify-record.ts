/**
 * `crossroom verify <record.json> [--instance <url>]`: check a project record's
 * signed export (`RecordExport`, `format: 'parley-record/v1'`), offline unless `--instance`:
 * - that the file is the export's own bytes, its canonical JSON (record/verify.ts);
 * - the Ed25519 signature over the canonical JSON of everything but the signature's value;
 * - each attached minutes' own signature (`verifyMinutes`, signing.ts), made with the same key, and
 *   its sha256 as its key;
 * - that each promoted fact appears in the right section of its minutes (an F under "Established"
 *   or "Ruled out", a Q under "Still disputed" or "Left open", a D as the outcome or a ruling).
 * A one-byte edit anywhere fails it. Exit 0 when everything holds, 1 when anything does not, 2 for
 * a file it cannot read.
 *
 * `crossroom verify` dispatches here for a `.json` file (commands/builtin.ts). `--instance` asks that
 * instance for its signing key (`GET /api/signing-key`), which answers whose key it was; the call
 * carries no credential.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type Args, text, Usage } from '../cli.js';
import { decodeFile, verifyRecordText } from '../record/verify.js';

export async function verifyRecord(args: Args, _say: (line: string) => void): Promise<number> {
  const file = args.positional[0];
  if (!file) throw new Usage('Usage: crossroom verify <record.json> [--instance <url>]');
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    throw new Usage(`Cannot read ${file}.`);
  }
  const v = verifyRecordText(decodeFile(raw));
  const name = path.basename(file);
  if (!v.ok) {
    console.log([`Not verified: ${name} is not the record Crossroom exported.`, ...v.problems.map((p) => `- ${p}.`)].join('\n'));
    return 1;
  }
  const lines = [
    `Verified: nothing in ${name} has changed since it was exported.`,
    `${v.facts} fact${v.facts === 1 ? '' : 's'} of ${v.project?.name ?? 'the project'}; ${v.promoted} promoted, each where its signed minutes put it, and ${v.attachments} signed minutes attached, each verified.`,
    `Signed with key ${v.fingerprint}${v.instance ? `, which the record says is ${v.instance}'s` : ''}.`,
  ];
  const instance = text(args.flags.instance);
  if (!instance) {
    lines.push('To check the key is really that instance\'s, run again with --instance <its URL>, or compare the fingerprint with <its URL>/api/signing-key.');
    console.log(lines.join('\n'));
    return 0;
  }
  const base = instance.replace(/\/+$/, '');
  let published: { publicKey?: string } | null = null;
  try {
    const res = await fetch(`${base}/api/signing-key`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    published = res.ok ? ((await res.json()) as { publicKey?: string }) : null;
  } catch {
    published = null;
  }
  if (!published?.publicKey) {
    console.log([...lines, `Could not read the signing key of ${base}.`].join('\n'));
    return 1;
  }
  if (published.publicKey !== v.publicKey) {
    console.log([...lines, `${base} signs with a different key: this record was not exported by it.`].join('\n'));
    return 1;
  }
  console.log([...lines, `${base} publishes this key, so it exported this record.`].join('\n'));
  return 0;
}
