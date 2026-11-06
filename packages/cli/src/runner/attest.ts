/**
 * An attested packet: after its seat shares a packet that cites a file, the
 * sharing side's runner reads that file at the commit its checkout holds (HEAD, or the commit the
 * source names), runs Crossroom's source check on it (sourcecheck.ts), and signs `parley/attest/v1`
 * over the packet's own commitment.
 *
 * That makes it the sharing side's signed claim, not Crossroom's check: the runner is the sharing
 * team's own process and its checkout chooses the rev. What it pins down is that this key said,
 * for this exact packet, that this file at this rev had these lines, which the other side can test
 * by reading the same rev if it ever gets it. Everything shown of it says so (the relay
 * writes `packet_attested` to the packet's own readers; the words are `attestationNote` in
 * @parley/shared/attestation).
 *
 * The statement names the file only by the SHA-256 of its path, the blob id git gives the file at
 * that rev, the lines the source cites, and the SHA-256 of the packet's body. The repository's
 * label is the runner's own name for it, made one line (`repoLabel`). git runs with fixed
 * arguments, no shell, hooks off, and the environment worktree.ts gives it (no `PARLEY_*`, no
 * `GIT_DIR`).
 */
import type { ContextKind } from '@parley/shared';
import { type AttestStatus, attestStatement, sha256Hex } from '@parley/shared/chain';
import { parseSource } from '@parley/shared/sources';
import { oneLine } from '@parley/shared/text';
import { checkSource } from '../sourcecheck.js';
import type { StatementSigner } from './signer.js';
import { git } from './worktree.js';

/** Where a seat's packets are read from to attest them. */
export interface AttestSource {
  /** The checkout the seat's agent reads (a job's `repo` directory, or the directory `crossroom join` runs in). */
  dir: string;
  /** The runner's own name for the repository, as its team knows it. */
  label: string;
}

/** A shared packet, as the seat's own record bundle carries it. */
export interface SharedPacket {
  seq: number;
  /** c_seq, from the bundle's commitments. */
  commit: string;
  payload: { kind?: unknown; source?: unknown; body?: unknown };
}

export interface AttestationBodyOut {
  seq: number;
  statement: string;
  status: AttestStatus;
  alg: StatementSigner['alg'];
  key: string;
  sig: string;
}

const ZERO = '0'.repeat(40);
const REV = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEL = String.fromCharCode(0x7f);

/** The runner's label as a statement value: one line, no DEL, at most 200 UTF-16 units, never half a pair. */
export function repoLabel(label: string): string {
  let s = oneLine(label).split(DEL).join(' ').trim();
  if (s.length > 200) {
    const c = s.charCodeAt(199);
    s = s.slice(0, c >= 0xd800 && c <= 0xdbff ? 199 : 200);
  }
  return s || 'repository';
}

const statusOf = (s: 'checked' | 'partial' | 'differs' | 'not_found' | undefined): AttestStatus =>
  s === 'checked' ? 'checked' : s === 'not_found' ? 'not_found' : s ? 'differs' : 'unchecked';

async function revParse(dir: string, what: string): Promise<string | null> {
  try {
    const out = (await git(dir, ['rev-parse', '--verify', '--quiet', what])).trim();
    return REV.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * The attestation of one packet, signed, or null for a packet that cites no file (a command, a
 * URL, no source at all) or a checkout git cannot read.
 */
export async function attestPacket(
  src: AttestSource,
  packet: SharedPacket,
  at: { relay: string; room: string },
  signer: StatementSigner,
): Promise<AttestationBodyOut | null> {
  const source = typeof packet.payload.source === 'string' ? packet.payload.source : null;
  const body = typeof packet.payload.body === 'string' ? packet.payload.body : '';
  const kind = (typeof packet.payload.kind === 'string' ? packet.payload.kind : 'text') as ContextKind;
  const cited = parseSource(source)[0];
  if (!cited) return null;
  const head = await revParse(src.dir, 'HEAD');
  if (!head) return null;
  const check = checkSource(src.dir, source, body, kind);
  const rev = check?.commit && REV.test(check.commit) ? check.commit : head;
  // `<rev>:<path>` starts with the rev, so no path can be read as an option.
  const blob = (await revParse(src.dir, `${rev}:${cited.path.split('\\').join('/')}`)) ?? ZERO;
  const [first] = cited.ranges;
  const status = statusOf(check?.status);
  const statement = attestStatement({
    relay: at.relay,
    room: at.room,
    seq: packet.seq,
    commit: packet.commit,
    repo: repoLabel(src.label),
    rev,
    path: sha256Hex(cited.path),
    blob,
    lines: first ? `${Math.min(first[0], first[1])}-${Math.max(first[0], first[1])}` : '0-0',
    excerpt: sha256Hex(body),
    found: check?.found ?? 0,
    of: check?.of ?? 0,
    status,
  });
  return { seq: packet.seq, statement, status, alg: signer.alg, key: signer.key, sig: signer.sign(statement) };
}
