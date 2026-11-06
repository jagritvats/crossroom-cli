/**
 * What `POST /api/projects/:p/import/reported` takes, from one item as a reader made it: the person's
 * `crossroom work import|sync` sends it, and a team's runner reports a read's items in this shape
 * (runner/reads.ts, `POST /api/runner/reads/:id/items`).
 */
import type { TrackerProvider } from '@parley/shared/trackers';
import { MAX_BRIEF_CHARS } from '@parley/shared/work';
import type { TrackerRead } from './io.js';

/** A report must fit the relay's body limit (512 KiB) with room to spare: comments go first, then links. */
const REPORT_BYTES = 400 * 1024;

/** What `POST /api/projects/:p/import/reported` takes, from one item as a reader made it. */
export function reportOf(provider: TrackerProvider, url: string, r: TrackerRead) {
  const s = r.snapshot;
  const report = {
    provider,
    url,
    title: r.title,
    body: r.body.slice(0, MAX_BRIEF_CHARS),
    state: s.state,
    type: s.type,
    assignedTo: s.assignee,
    key: s.key,
    criteria: r.criteria,
    iteration: s.iteration,
    labels: s.labels,
    priority: s.priority,
    points: s.points,
    links: s.links,
    comments: s.comments,
    commentCount: s.commentCount,
    updatedAt: s.updatedAt,
  };
  const size = () => Buffer.byteLength(JSON.stringify(report));
  while (size() > REPORT_BYTES && report.comments.length) report.comments = report.comments.slice(1);
  while (size() > REPORT_BYTES && report.links.length) report.links = report.links.slice(0, -1);
  return report;
}
