/**
 * The words for an attested packet: what a `packet_attested` event says, printed
 * where only Crossroom writes, after a delivery's fence for agents (`attestationNote`, render.ts) and
 * as a bracket before the packet's title in the minutes (`attestationBracket`, minutes.ts).
 *
 * An attestation is the sharing side's own runner's signed claim: its team's process read the file
 * at a rev its checkout chose and counted the packet's lines there. Crossroom checked only that the
 * claim is signed with the key that seat signs with. So the words name whose claim it is, the key
 * and the rev, and never use the words of a check Crossroom ran itself (`checkNote`, sources.ts).
 *
 * Everything printed is Crossroom's or checked by the relay to be a fixed form (a status from a list,
 * whole numbers, a hex rev, a key fingerprint), but the repository's label, which the runner chose:
 * that is made one line and stripped of every character that could close a bracket, a code span,
 * a quotation, a tag or start emphasis (`labelText`), so no label can end the note or the bracket
 * and go on in Crossroom's voice.
 */
import { oneLine } from './text.js';

/** A `packet_attested` event's payload, as the relay writes it. */
export interface PacketAttested {
  itemId: string;
  label: string;
  status: 'checked' | 'differs' | 'not_found' | 'unchecked';
  found: number;
  of: number;
  /** The runner's own name for the repository. */
  repo?: string;
  /** The commit it read, hex. */
  rev?: string;
  /** The signing key's fingerprint (signing.ts `fingerprintOf`). */
  key?: string;
}

const REV = /^[0-9a-f]{7,64}$/;
const FINGERPRINT = /^[0-9a-f ]{4,40}$/;
const UNSAFE = /[`[\]"'<>*_~|\\#!()]/g;

/** A label the runner chose, safe inside Crossroom's own sentence: one line, at most 60 characters, no markup. */
export function labelText(label: unknown): string {
  if (typeof label !== 'string') return 'its repository';
  const s = oneLine(label).replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const cut = [...s].slice(0, 60).join('');
  return cut || 'its repository';
}

const count = (n: unknown) => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0);
const rev = (r: unknown) => (typeof r === 'string' && REV.test(r) ? r.slice(0, 12) : 'an unnamed rev');
const key = (k: unknown) => (typeof k === 'string' && FINGERPRINT.test(k) ? k : 'an unnamed key');

/** What the counts say, in the sharing side's voice ("found 2 of 3 lines"). */
function found(p: PacketAttested): string {
  switch (p.status) {
    case 'checked':
      return `found all ${count(p.of)} of the packet's counted lines there`;
    case 'differs':
      return `found ${count(p.found)} of ${count(p.of)} of the packet's counted lines there`;
    case 'not_found':
      return 'found no such file there';
    default:
      return 'could not check the packet there';
  }
}

/**
 * The line after a packet's fence for an agent: whose claim it is, at which rev, with which key,
 * and that Crossroom ran no check of its own.
 */
export function attestationNote(p: PacketAttested): string {
  return `Crossroom: the sharing side's own runner signed a claim about ${p.label}: reading ${labelText(p.repo)} at ${rev(p.rev)}, it ${found(p)}. Signed with key ${key(p.key)}. This is that side's claim, not a check Crossroom ran.`;
}

/** The bracket before a packet's title in the minutes. Crossroom's words and checked forms only. */
export function attestationBracket(p: PacketAttested): string {
  const what =
    p.status === 'checked'
      ? `all ${count(p.of)} lines`
      : p.status === 'differs'
        ? `${count(p.found)} of ${count(p.of)} lines`
        : p.status === 'not_found'
          ? 'no such file'
          : 'not checkable';
  return `[sender's runner attests: ${what} at ${rev(p.rev)}, key ${key(p.key)}; its claim, not Crossroom's check]`;
}
