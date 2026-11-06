/**
 * Checking a fact's sources again in a directory: what Crossroom runs in a hosted
 * seat's directory, and what a standing seat's runner runs in its checkout for a `recheck` job
 * (runner/recheck.ts). Apart from the rest of the record, so the runner imports only this and the
 * source check, never the record's jobs, keys or inbox.
 */
import { parseSource } from '@parley/shared/sources';
import { RecheckRequest, type RecheckReport, type RecheckStatus } from '@parley/shared/runner';
import { checkSource } from '../sourcecheck.js';

/**
 * A source as the files are now: the files and lines it cites, at no commit. A file cited from the
 * repository's top (`git show <sha>:<path>`) is read at `head` when the caller knows it, and not
 * read at all when it does not, since from the seat's directory the path could name another file.
 */
export function atHead(source: string, head?: string): string | null {
  const parts: string[] = [];
  for (const c of parseSource(source)) {
    const ranges = c.ranges.length ? `:${c.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',')}` : '';
    if (c.fromTop) {
      if (!head) return null;
      parts.push(`git show ${head}:${c.path}${ranges}`);
    } else parts.push(head ? `${c.path}${ranges} @ ${head}` : `${c.path}${ranges}`);
  }
  return parts.length ? parts.join('; ') : null;
}

/**
 * Check a request's sources again in `root` (a checkout, or a hosted seat's directory), at `head`
 * when given, or as the files are there now. What the runner runs for a `recheck` job; it reads
 * inside `root` only, as the source check always does (sourcecheck.ts).
 */
export function runRecheck(root: string, request: RecheckRequest, head?: string): RecheckReport {
  const req = RecheckRequest.parse(request);
  const results = req.sources.map((s) => {
    const source = atHead(s.source, head);
    const r = source ? checkSource(root, source, s.body, s.kind) : null;
    return { idx: s.idx, status: (r?.status ?? 'unchecked') as RecheckStatus, found: r?.found, of: r?.of, commit: r?.commit ?? null };
  });
  return { factId: req.factId, results };
}
