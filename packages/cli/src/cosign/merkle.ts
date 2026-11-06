/**
 * Merkle trees as RFC 6962 builds them (and RFC 9162 section 2.1 verifies them), over SHA-256:
 * what anchoring batches a relay's heads with, and what a transparency log proves inclusion and
 * consistency with.
 *
 * - A leaf is SHA-256(0x00 || data) and an interior node SHA-256(0x01 || left || right), so no leaf
 *   can pass for a node. An anchoring batch's leaves are `anchorLeaf` (@parley/shared/chain), which
 *   already carries the 0x00; a log's are `leafHashOf` its entry's bytes.
 * - The tree over n leaves splits at k, the largest power of two below n: MTH(D[0:k]) and
 *   MTH(D[k:n]). An empty tree's root is SHA-256 of nothing.
 * - Every hash is 64 lowercase hex digits. Verifiers answer false for anything malformed, and never
 *   throw: what they check came from a file or a server somebody else wrote.
 *
 * Pure (node:crypto only), so `crossroom verify` runs it offline.
 */
import { createHash } from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/;
const isHash = (h: unknown): h is string => typeof h === 'string' && HEX64.test(h);

const sha = (...parts: Uint8Array[]): string => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};
const bytes = (hex: string) => Buffer.from(hex, 'hex');
const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

/** The root of a tree with no leaves: SHA-256 of nothing. */
export const EMPTY_ROOT = sha();

/** A leaf's hash, from its data: SHA-256(0x00 || data). */
export const leafHashOf = (data: Uint8Array): string => sha(LEAF, data);

/** An interior node: SHA-256(0x01 || left || right). */
export const nodeHash = (left: string, right: string): string => sha(NODE, bytes(left), bytes(right));

/** The largest power of two strictly below n (n >= 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** MTH(D[lo:hi]) over leaf hashes. */
function rootOf(leaves: readonly string[], lo: number, hi: number): string {
  const n = hi - lo;
  if (n === 0) return EMPTY_ROOT;
  if (n === 1) return leaves[lo]!;
  const k = split(n);
  return nodeHash(rootOf(leaves, lo, lo + k), rootOf(leaves, lo + k, hi));
}

/** The root over these leaf hashes (each already SHA-256(0x00 || data)). */
export function merkleRoot(leaves: readonly string[]): string {
  return rootOf(leaves, 0, leaves.length);
}

/** PATH(m, D[lo:hi]), RFC 6962 2.1.1. */
function pathOf(m: number, leaves: readonly string[], lo: number, hi: number): string[] {
  const n = hi - lo;
  if (n <= 1) return [];
  const k = split(n);
  return m < k
    ? [...pathOf(m, leaves, lo, lo + k), rootOf(leaves, lo + k, hi)]
    : [...pathOf(m - k, leaves, lo + k, hi), rootOf(leaves, lo, lo + k)];
}

/** The audit path from leaf `index` to the root, leaf side first. */
export function inclusionProof(leaves: readonly string[], index: number): string[] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= leaves.length) throw new RangeError('no such leaf');
  return pathOf(index, leaves, 0, leaves.length);
}

/** SUBPROOF(m, D[lo:hi], b), RFC 6962 2.1.2. */
function subproof(m: number, leaves: readonly string[], lo: number, hi: number, whole: boolean): string[] {
  const n = hi - lo;
  if (m === n) return whole ? [] : [rootOf(leaves, lo, hi)];
  const k = split(n);
  return m <= k
    ? [...subproof(m, leaves, lo, lo + k, whole), rootOf(leaves, lo + k, hi)]
    : [...subproof(m - k, leaves, lo + k, hi, false), rootOf(leaves, lo, lo + k)];
}

/** The proof that the tree over the first `m` leaves is a prefix of the tree over all of them. */
export function consistencyProof(leaves: readonly string[], m: number): string[] {
  if (!Number.isSafeInteger(m) || m < 0 || m > leaves.length) throw new RangeError('no such tree size');
  if (m === 0 || m === leaves.length) return [];
  return subproof(m, leaves, 0, leaves.length, true);
}

const size = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** The root an audit path leads to (RFC 9162 2.1.3.2), or null when the path cannot be one. */
export function rootFromInclusion(index: number, treeSize: number, leaf: string, proof: readonly string[]): string | null {
  if (!size(index) || !size(treeSize) || index >= treeSize || !isHash(leaf) || !Array.isArray(proof) || !proof.every(isHash)) return null;
  let fn = index;
  let sn = treeSize - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return null;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else r = nodeHash(r, p);
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 ? r : null;
}

/** Whether `proof` shows leaf `index` of a tree of `treeSize` leaves under `root` (RFC 9162 2.1.3.2). */
export function verifyInclusion(index: number, treeSize: number, leaf: string, proof: readonly string[], root: string): boolean {
  return isHash(root) && rootFromInclusion(index, treeSize, leaf, proof) === root;
}

/** Whether `proof` shows the tree of `first` leaves under `firstRoot` is a prefix of the tree of `second` under `secondRoot` (RFC 9162 2.1.4.2). */
export function verifyConsistency(first: number, second: number, firstRoot: string, secondRoot: string, proof: readonly string[]): boolean {
  if (!size(first) || !size(second) || first > second || !isHash(firstRoot) || !isHash(secondRoot)) return false;
  if (!Array.isArray(proof) || !proof.every(isHash)) return false;
  if (first === second) return proof.length === 0 && firstRoot === secondRoot;
  if (first === 0) return proof.length === 0 && firstRoot === EMPTY_ROOT;
  const path = (first & (first - 1)) === 0 ? [firstRoot, ...proof] : [...proof];
  if (path.length === 0) return false;
  let fn = first - 1;
  let sn = second - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else sr = nodeHash(sr, c);
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return fr === firstRoot && sr === secondRoot && sn === 0;
}
