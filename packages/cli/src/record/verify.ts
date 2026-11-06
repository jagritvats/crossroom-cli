/**
 * Checking a project record's signed export, with nothing but the file: what
 * `crossroom verify record.json` runs (commands/verify-record.ts), and what the export route's tests
 * hold it to. Pure: node:crypto, the minutes' own verifier and the shared text rules, nothing of the server.
 *
 * The export is canonical JSON (`canonicalJson`: keys sorted, no whitespace), served as those bytes
 * with one trailing newline, and signed with the instance's Ed25519 key over
 * `parley/record/v1\n` + the canonical JSON of the whole export with `signature.value` left out, so
 * the key, fingerprint and instance it names are signed too. The check is:
 * - the file is exactly that canonical form (a trailing newline or CRLF aside), so a key given twice
 *   or a byte of whitespace added is refused as surely as a changed word: a reader of the raw file
 *   and the verifier never read two different documents;
 * - the signature;
 * - every attached minutes: its sha256 is its key, its own signature holds (`verifyMinutes`), and
 *   it was signed with the export's key;
 * - every fact: a label of its kind's prefix, unique; a promoted fact names an attachment, and sits
 *   in the section of those minutes its kind says (`factInMinutes`): an F under "Established" or
 *   "Ruled out", a Q under "Still disputed", "Left open" or "Still open", a D as the outcome or
 *   under "Settled by the owner". Minutes from before the recap led with what happened (2026-10-22)
 *   put unanswered requests under "Left open" and the outcome in a section of its own; both verify.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { FACT_PREFIX, type FactKind, isFactLabel, RECORD_EXPORT_FORMAT } from '@parley/shared/record';
import { oneLine } from '@parley/shared/text';
import { fingerprintOf, verifyMinutes } from '../signing.js';

/** What a record's signature covers starts with this line. */
export const RECORD_SIGNED_PREFIX = 'parley/record/v1\n';

/**
 * Between a ruled claim's words and the owner's ruling, in a D filed from a ruling. Crossroom writes
 * it; a claim or a ruling may contain it too, so `factInMinutes` tries every place it occurs.
 */
export const RULING_SEPARATOR = '\n\nRuling: ';

/** JSON with every object's keys sorted and no whitespace: one text for one value. */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('a number that is not finite has no JSON');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new TypeError(`a ${typeof v} has no JSON`);
}

/** The bytes a record's signature is made over: the export with its signature's value left out. */
export function signedMessage(doc: Record<string, unknown> & { signature: Record<string, unknown> }): string {
  const { value: _value, ...signer } = doc.signature;
  return RECORD_SIGNED_PREFIX + canonicalJson({ ...doc, signature: signer });
}

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------- a fact in its minutes

const inline = oneLine;
/** As the minutes clip a claim onto a line (packages/shared/src/minutes.ts). */
const clip = (text: string, max: number) => {
  const one = inline(text);
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The lines of one `## ` section: from the first line that is exactly `heading` to the next `## `. */
function section(lines: readonly string[], heading: string): string[] {
  const at = lines.findIndex((l) => l.trimEnd() === heading);
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith('## ')) break;
    out.push(l);
  }
  return out;
}

/** The lines of one bold block of "In short" (`**Established.**`), up to the next block. */
function block(inShort: readonly string[], marker: string): string[] {
  const at = inShort.findIndex((l) => l.trim() === marker);
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of inShort.slice(at + 1)) {
    if (/^\*\*[^*].*\.\*\*$/.test(l.trim()) || l.startsWith('_Thin record')) break;
    out.push(l);
  }
  return out;
}

/** A top-level bullet of a block: `- ` at column 0, never a seat's sub-bullet. */
const bullets = (lines: readonly string[]) => lines.filter((l) => l.startsWith('- '));

/**
 * Whether a fact sits where its kind says in the minutes it was promoted with. Only Crossroom's own
 * words around the fact's text are matched, the parts no participant writes.
 */
export function factInMinutes(fact: { kind: FactKind; text: string }, minutes: string): boolean {
  const lines = minutes.replace(/\r\n?/g, '\n').split('\n');
  const inShort = section(lines, '## In short');
  const text = fact.text;
  switch (fact.kind) {
    case 'established':
      return bullets(block(inShort, '**Established.**')).some((l) => l.endsWith(`: ${inline(text)} — every position supports it.`));
    case 'ruled_out':
      return bullets(block(inShort, '**Ruled out.**')).some((l) => l.endsWith(`: ${inline(text)} — **not true**; every position opposes it.`));
    case 'open':
      return (
        bullets(block(inShort, '**Still disputed.**')).some((l) => l.endsWith(`: ${inline(text)}`)) ||
        bullets(block(inShort, '**Left open.**')).some(
          (l) => l === `- ${inline(text)}` || l.endsWith(` has no position from at least one side: ${clip(text, 300)}`),
        ) ||
        bullets(block(inShort, '**Still open.**')).some((l) => l === `- ${inline(text)}`)
      );
    case 'settled': {
      const settled = bullets(block(inShort, '**Settled by the owner.**'));
      for (let at = text.indexOf(RULING_SEPARATOR); at >= 0; at = text.indexOf(RULING_SEPARATOR, at + 1)) {
        const claim = text.slice(0, at);
        const ruling = text.slice(at + RULING_SEPARATOR.length);
        if (settled.some((l) => l.includes(`: ${inline(claim)} — `) && l.endsWith(`. Ruling: ${inline(ruling)}`))) return true;
      }
      return false;
    }
    case 'decision': {
      // The owner's outcome: quoted in the first screen's Outcome block now, a section of its own before.
      const said = squash(text);
      // Only the quote: a seat's summary on the lines after it is that seat's, never the owner's outcome.
      const quoted = block(inShort, '**Outcome.**')
        .filter((l) => l.startsWith('>'))
        .map((l) => l.replace(/^>\s?/, ''));
      return said.length > 0 && [section(lines, '## Outcome'), quoted].some((ls) => squash(ls.join('\n')).includes(said));
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------- the whole export

export interface RecordVerdict {
  ok: boolean;
  /** What is wrong, one sentence each; empty when `ok`. */
  problems: string[];
  facts: number;
  attachments: number;
  promoted: number;
  publicKey: string | null;
  fingerprint: string | null;
  instance: string | null;
  project: { id: string; name: string; org: string } | null;
}

const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;
const RAW_SIG = /^[A-Za-z0-9_-]{86}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The file's text as a string: UTF-8 with or without a byte-order mark, or UTF-16 with one (Windows PowerShell's `>`). */
export function decodeFile(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

/** Check a record export's text. Never throws. */
export function verifyRecordText(text: string): RecordVerdict {
  const verdict: RecordVerdict = {
    ok: false,
    problems: [],
    facts: 0,
    attachments: 0,
    promoted: 0,
    publicKey: null,
    fingerprint: null,
    instance: null,
    project: null,
  };
  const fail = (problem: string) => {
    verdict.problems.push(problem);
    return verdict;
  };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return fail('it is not JSON');
  }
  if (!isObject(doc)) return fail('it is not a Crossroom record export');
  if (doc.format !== RECORD_EXPORT_FORMAT) return fail(`it is not a Crossroom record export (its format is not ${RECORD_EXPORT_FORMAT})`);
  let canonical: string;
  try {
    canonical = canonicalJson(doc);
  } catch {
    return fail('it holds a value JSON cannot say twice the same way');
  }
  const body = text.replace(/\r?\n$/, '');
  if (body !== canonical)
    return fail(
      'it is not in the form Crossroom exported it: it was reformatted, or gives a key twice. Crossroom exports a record as canonical JSON and checks only those bytes; download it again with `curl -o`',
    );
  const sig = doc.signature;
  if (!isObject(sig) || sig.algorithm !== 'Ed25519' || typeof sig.publicKey !== 'string' || !RAW_KEY.test(sig.publicKey))
    return fail('it carries no Ed25519 signature');
  if (typeof sig.value !== 'string' || !RAW_SIG.test(sig.value)) return fail('its signature is not an Ed25519 signature');
  if (typeof sig.instance !== 'string' || typeof sig.fingerprint !== 'string') return fail('its signature does not say whose it is');
  verdict.publicKey = sig.publicKey;
  verdict.fingerprint = fingerprintOf(sig.publicKey);
  verdict.instance = sig.instance;
  if (sig.fingerprint !== verdict.fingerprint) return fail('the fingerprint it names is not the fingerprint of the key that signed it');
  let good = false;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: sig.publicKey }, format: 'jwk' });
    const raw = Buffer.from(sig.value, 'base64url');
    // 64 bytes fill 85.33 characters, so the last one carries four spare bits that Buffer ignores: four
    // spellings of one signature. Only the canonical spelling is the one Crossroom exported.
    good =
      raw.toString('base64url') === sig.value &&
      verify(null, Buffer.from(signedMessage(doc as Record<string, unknown> & { signature: Record<string, unknown> })), key, raw);
  } catch {
    good = false;
  }
  if (!good) return fail('the signature does not match: something in it changed after it was exported');

  // Past the signature, everything in it is what the instance said. What remains is whether the
  // instance said something consistent: the minutes it attached, and where each fact sits in them.
  const p = doc.project;
  if (isObject(p) && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.org === 'string')
    verdict.project = { id: p.id, name: p.name, org: p.org };
  else verdict.problems.push('it does not say which project it is');

  const attachments = doc.attachments;
  const minutesBy = new Map<string, string>();
  if (!isObject(attachments)) verdict.problems.push('its attachments are not a map of minutes');
  else
    for (const [hash, minutes] of Object.entries(attachments)) {
      verdict.attachments++;
      if (!SHA256.test(hash) || typeof minutes !== 'string') {
        verdict.problems.push('an attachment is not minutes under their sha256');
        continue;
      }
      if (sha256Hex(minutes) !== hash) verdict.problems.push(`the minutes attached as ${hash.slice(0, 12)} are not the ones that hash names`);
      const v = verifyMinutes(minutes);
      if (!v.ok) verdict.problems.push(`the minutes attached as ${hash.slice(0, 12)} do not verify: ${v.reason}`);
      else if (v.publicKey !== sig.publicKey) verdict.problems.push(`the minutes attached as ${hash.slice(0, 12)} were signed with another key (${v.fingerprint})`);
      minutesBy.set(hash, minutes);
    }

  const facts = doc.facts;
  if (!Array.isArray(facts)) return fail('its facts are not a list');
  const labels = new Set<string>();
  const cited = new Set<string>();
  for (const f of facts) {
    verdict.facts++;
    if (!isObject(f) || typeof f.label !== 'string' || typeof f.kind !== 'string' || typeof f.text !== 'string') {
      verdict.problems.push('a fact is not a fact');
      continue;
    }
    const label = f.label;
    const kind = f.kind as FactKind;
    const shown = isFactLabel(label) ? label : 'a fact';
    if (!isFactLabel(label) || !Object.hasOwn(FACT_PREFIX, kind) || FACT_PREFIX[kind] !== label[0])
      verdict.problems.push(`${shown} has a label that is not its kind's`);
    if (labels.has(label)) verdict.problems.push(`${shown} is in it twice`);
    labels.add(label);
    if (f.minutes === null || f.minutes === undefined) continue;
    verdict.promoted++;
    if (typeof f.minutes !== 'string' || !minutesBy.has(f.minutes)) {
      verdict.problems.push(`${shown} names minutes that are not attached`);
      continue;
    }
    cited.add(f.minutes);
    if (!factInMinutes({ kind, text: f.text }, minutesBy.get(f.minutes)!))
      verdict.problems.push(`${shown} is not where its minutes put a ${kind.replace('_', ' ')} fact`);
  }
  for (const hash of minutesBy.keys()) if (!cited.has(hash)) verdict.problems.push(`the minutes attached as ${hash.slice(0, 12)} belong to no fact`);
  verdict.ok = verdict.problems.length === 0;
  return verdict;
}
