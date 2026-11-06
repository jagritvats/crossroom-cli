/**
 * `crossroom verify <minutes.md> --record <r.json> [--instance <url>] [--org <domain>] [--trusted-root <file>]`
 * minutes v2 checked against the room's record bundle (`RoomRecordBundle`,
 * @parley/shared/chain), each check a `RecordCheck`, printed line by line.
 *
 * - Offline unless asked: the bundle's chain, the inclusion of every event it shows whole, its
 *   signatures, receipts, attestations, co-signatures and signed writes (cosign/record-verify.ts
 *   `verifyRecordBundle`), and the minutes' own signature and their head in that chain.
 * - A record whose checks all hold is verified only as far as something signed it: a head past the
 *   last event any signature covers (a live room's, which Crossroom signs once the room has ended) is
 *   reported as vouched for by nobody, never as verified.
 * - `--instance <url>` asks that instance for its signing key (`GET /api/signing-key`, no
 *   credential, no redirect followed) and compares it with every key that signed as the instance:
 *   the minutes' and each of the record's own signatures.
 * - `--org <domain>` checks the bundle's co-signatures against the keys the domain publishes, through
 *   `checkCosignatures` (cosign/verify-cosign.ts), which may fetch only
 *   `https://<domain>/…` through what this command passes it.
 * - `--trusted-root <file>` checks the bundle's anchors through `checkAnchors`
 *   (cosign/verify-anchor.ts).
 * The minutes may be left out (`crossroom verify --record r.json`): a party with a partial view checks
 * its bundle alone. commands/builtin.ts dispatches here for any of `--record`, `--org` and
 * `--trusted-root`. Exit 0 when every check holds, 1 when one does not, 2 for a file it cannot read.
 * Nothing printed is text from the record or the minutes but numbers, digests and fingerprints.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RecordCheck, RoomRecordBundle } from '@parley/shared/chain';
import { type Args, text } from '../cli.js';
import { readRecordBundle, verifyRecordBundle } from '../cosign/record-verify.js';
import { checkAnchors } from '../cosign/verify-anchor.js';
import { checkCosignatures } from '../cosign/verify-cosign.js';
import { fingerprintOf, verifyMinutes } from '../signing.js';

const USAGE = 'Usage: crossroom verify <minutes.md> --record <r.json> [--instance <url>] [--org <domain>] [--trusted-root <file>]';

/** A domain as `--org` takes it: a host name, no scheme, no path, no port. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** What `--org`'s check may fetch: an https URL on that domain alone, with no redirect followed. */
export const orgKeysFetcher = (domain: string) => async (url: string): Promise<unknown> => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== domain.toLowerCase() || u.port)
    throw new Error(`--org ${domain} fetches only from https://${domain}/`);
  const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${domain} answered ${res.status}`);
  return res.json();
};

/** The key an instance publishes (`GET /api/signing-key`, no credential, no redirect followed), or null. */
async function publishedKey(base: string): Promise<string | null> {
  try {
    const res = await fetch(`${base}/api/signing-key`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const body = res.ok ? ((await res.json()) as { publicKey?: unknown }) : null;
    return typeof body?.publicKey === 'string' ? body.publicKey : null;
  } catch {
    return null;
  }
}

/**
 * `--instance`: every key that signed as the instance, the minutes' and each of the record's own
 * signatures (its ledger signature and minutes v2), against the one key the instance publishes,
 * fetched once. A record could carry a second key's signatures beside the instance's, and checking
 * only the first would vouch for the rest.
 */
async function instanceChecks(base: string, keys: ReadonlySet<string>): Promise<RecordCheck[]> {
  if (!keys.size) return [{ what: 'instance', ok: false, detail: 'nothing here is signed by an instance' }];
  const published = await publishedKey(base);
  if (published === null) return [{ what: 'instance', ok: false, detail: 'could not read the signing key the instance publishes' }];
  if (keys.size === 1)
    return [
      keys.has(published)
        ? { what: 'instance', ok: true, detail: 'the instance publishes the key that signed, so it signed this' }
        : { what: 'instance', ok: false, detail: 'the instance signs with a different key: it did not sign this' },
    ];
  return [...keys].map((k) =>
    k === published
      ? { what: 'instance', ok: true, detail: `the instance publishes key ${fingerprintOf(k)}, so it signed what that key signed` }
      : { what: 'instance', ok: false, detail: `the instance does not publish key ${fingerprintOf(k)}: it did not sign what that key signed` },
  );
}

/** The seq a statement names (`seq=` on a line of its own), or 0. */
const seqOf = (statement: string) => Number(/\nseq=([1-9][0-9]{0,15})(?:\n|$)/.exec(statement)?.[1] ?? 0);

/**
 * How far signatures vouch for the record: the last event any signature that verified covers, the
 * minutes' included. Events after it recompute to their commitments, but nobody signed a head over
 * them, so a record that says only that is consistent, not verified.
 */
function vouchedThrough(bundle: RoomRecordBundle, minutesSeq: number): number {
  return Math.max(
    minutesSeq,
    ...bundle.signatures.map((s) => seqOf(s.statement)),
    ...bundle.receipts.map((r) => r.through),
    ...bundle.cosignatures.map((c) => c.seq),
  );
}

export async function verifyRoom(args: Args, say: (line: string) => void, print: (line: string) => void = (l) => console.log(l)): Promise<number> {
  const record = text(args.flags.record);
  const file = args.positional[0];
  if (!record) {
    say(USAGE);
    return 2;
  }
  const raw = readText(record);
  if (raw === null) {
    say(`Cannot read ${record}.`);
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    say(`${path.basename(record)} is not JSON.`);
    return 2;
  }
  let doc: string | undefined;
  if (file !== undefined) {
    const t = readText(file);
    if (t === null) {
      say(`Cannot read ${file}.`);
      return 2;
    }
    doc = t;
  }
  const verdict = verifyRecordBundle(parsed, doc === undefined ? {} : { minutes: doc });
  const checks = [...verdict.checks];
  const read = readRecordBundle(parsed);
  const signedMinutes = doc === undefined ? null : verifyMinutes(doc);

  // Every check held, but a head past what anything signed is vouched for by nobody: a live room's
  // record above all, which Crossroom signs once the room has ended.
  if (read.ok && verdict.ok) {
    const through = vouchedThrough(read.bundle, signedMinutes?.ok ? (signedMinutes.seq ?? 0) : 0);
    const last = read.bundle.head.seq;
    if (through === 0)
      checks.push({ what: 'chain', ok: false, detail: "nothing in this record is signed, so nothing vouches for its head: Crossroom signs a room's record once the room has ended" });
    else if (through < last)
      checks.push({ what: 'chain', ok: false, detail: `nothing here is signed past event ${through}, so nothing vouches for the head at event ${last}` });
  }

  const instance = text(args.flags.instance);
  if (instance) {
    const keys = new Set<string>(read.ok ? read.bundle.signatures.map((s) => s.key) : []);
    if (signedMinutes?.ok) keys.add(signedMinutes.publicKey);
    checks.push(...(await instanceChecks(instance.replace(/\/+$/, ''), keys)));
  }
  const org = text(args.flags.org);
  if (args.flags.org !== undefined) {
    if (!org || !DOMAIN.test(org)) checks.push({ what: 'org', ok: false, detail: '--org takes a domain, such as example.com' });
    else if (read.ok) checks.push(...(await checkCosignatures(read.bundle, org, orgKeysFetcher(org))));
  }
  if (args.flags['trusted-root'] !== undefined) {
    const rootFile = text(args.flags['trusted-root']);
    const rootText = rootFile ? readText(rootFile) : null;
    if (rootText === null) {
      say(`Cannot read ${rootFile ?? 'the --trusted-root file'}.`);
      return 2;
    }
    let root: unknown;
    try {
      root = JSON.parse(rootText);
    } catch {
      say(`${path.basename(rootFile!)} is not JSON.`);
      return 2;
    }
    if (read.ok) checks.push(...checkAnchors(read.bundle, root));
  }

  const ok = checks.length > 0 && checks.every((c) => c.ok);
  const what = doc === undefined ? path.basename(record) : `${path.basename(file!)} against ${path.basename(record)}`;
  print(ok ? `Verified: ${what}. Every check holds.` : `Not verified: ${what}. A check below fails.`);
  for (const c of checks) print(`  ${c.ok ? 'ok' : '!!'}  ${c.what.padEnd(12)}${c.detail}`);
  if (read.ok && !instance) print('To check the key that signed is really the instance\'s, run again with --instance <its URL>.');
  if (read.ok && read.bundle.cosignatures.length && args.flags.org === undefined)
    print('Co-signatures were checked as signatures only: --org <domain> checks whose keys they are.');
  if (read.ok && read.bundle.anchors.length && args.flags['trusted-root'] === undefined)
    print('Anchors were not checked: --trusted-root <file> checks them against the log and timestamp roots you trust.');
  return ok ? 0 : 1;
}
