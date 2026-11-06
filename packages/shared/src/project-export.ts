/**
 * A project's export, handoff and package (workspace D1): the shapes and the markdown they print as.
 *
 * Pure (no Node, no zod). Everything a participant, an owner or an import wrote reaches the markdown
 * through `inline` (one line) or `quote` (a blockquote), the way the minutes do (minutes.ts): a title,
 * a brief or an artifact body cannot start a section of its own or break out of its quote. The only
 * text at column 0 is Crossroom's own: headings, labels, ids, times and counts.
 */
import { LINE_BREAK, oneLine } from './text.js';
import {
  type Artifact,
  type ArtifactRevision,
  type Handoff,
  type KnowledgeEntry,
  type SourceRef,
  UNKNOWN_REPO,
  WORK_STATE_LABEL,
  type WorkEvent,
  type WorkItem,
} from './work.js';

export interface ExportRevision extends ArtifactRevision {
  /** The text of a markdown or text revision. Absent for a link, and for an old revision a big export left out. */
  body?: string;
}

/** `GET /api/projects/:p/export` (the JSON form). */
export interface ProjectExport {
  format: 'parley-project-export';
  version: 1;
  exportedAt: string;
  project: { id: string; name: string };
  /** The project's objective, '' when none was written. */
  objective: string;
  work: Array<{ item: WorkItem; history: WorkEvent[] }>;
  artifacts: Array<{ artifact: Artifact; revisions: ExportRevision[] }>;
  /** The accepted knowledge view: written entries, promoted facts, accepted decisions and accepted artifact revisions. */
  knowledge: KnowledgeEntry[];
  /** True when older revisions' bodies were left out to keep the export a size one request can carry. */
  truncated: boolean;
}

/** `GET /api/projects/:p/export?format=package`: a project's shape, saved as a starter. */
export interface ProjectPackage {
  format: 'parley-project-package';
  version: 1;
  name: string;
  description: string;
  objective: string;
  /** A playbook in the library's own shape, with fixed text only. */
  playbook: { name: string; yaml: string };
  /** The project's work as a template: titles, briefs and criteria, with no owner, delegate, state or history. */
  workTemplate: Array<{ title: string; brief: string; criteria: string[] }>;
}

// ---------------------------------------------------------------- printing

const inline = oneLine;
const quote = (text: string): string[] => text.split(LINE_BREAK).map((l) => (l.trim() ? `> ${l}` : '>'));
/** One short line as inline code, which a backtick in it cannot close. */
const code = (text: string, max = 200): string => {
  const one = inline(text).replace(/`/g, "'");
  return `\`${one.length > max ? `${one.slice(0, max - 1)}…` : one}\``;
};
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function sourceLine(s: SourceRef): string {
  const repo = s.repo ?? UNKNOWN_REPO;
  const rev = s.revision ? ` at ${inline(s.revision)}` : '';
  return `${code(s.path)} in ${inline(repo)}${rev}`;
}

function workLines(item: WorkItem): string[] {
  const out = [`### ${inline(item.title) || '(untitled)'}`, '', `- Id: ${item.id}`, `- State: ${WORK_STATE_LABEL[item.state]}`];
  if (item.source.authority === 'external') out.push(`- Source: mirrored from ${inline(item.source.provider ?? 'a provider')}, which holds the truth`);
  if (item.delegate) out.push(`- Delegate: ${inline(item.delegate.kind)} ${code(item.delegate.ref)}`);
  if (item.reviewPoint) out.push(`- Review point: ${item.reviewPoint}`);
  if (item.brief.trim()) out.push('', ...quote(item.brief));
  if (item.criteria.length) out.push('', 'Criteria:', ...item.criteria.map((c) => `- ${inline(c)}`));
  out.push('');
  return out;
}

/** The export as a document anyone can read in a text editor. */
export function renderExportMarkdown(doc: ProjectExport): string {
  const out: string[] = [`# ${inline(doc.project.name) || 'Project'}`, '', `Exported ${doc.exportedAt} from project ${doc.project.id}. Participant text is quoted.`, ''];
  out.push('## Objective', '');
  out.push(...(doc.objective.trim() ? quote(doc.objective) : ['Nobody has written an objective.']), '');
  out.push(`## Work (${count(doc.work.length, 'item')})`, '');
  if (!doc.work.length) out.push('No work items.', '');
  for (const w of doc.work) out.push(...workLines(w.item));
  out.push(`## Artifacts (${count(doc.artifacts.length, 'artifact')})`, '');
  if (!doc.artifacts.length) out.push('No artifacts.', '');
  for (const a of doc.artifacts) {
    out.push(`### ${inline(a.artifact.title) || '(untitled)'}`, '', `- Id: ${a.artifact.id}`, `- Kind: ${a.artifact.kind}`, `- Audience: ${a.artifact.audience}`);
    for (const r of a.revisions) {
      const flags = [r.status, r.mutable ? 'mutable link' : ''].filter(Boolean).join(', ');
      out.push('', `#### Revision ${r.n} (${flags})`, '', `Digest ${r.digest}, ${r.createdAt}.`);
      if (r.url) out.push('', `Link: ${code(r.url, 500)}`);
      if (r.body !== undefined) out.push('', ...quote(r.body));
      else if (!r.url) out.push('', 'The text of this revision is not in this export.');
    }
    out.push('');
  }
  out.push(`## Knowledge (${count(doc.knowledge.length, 'entry')})`, '');
  if (!doc.knowledge.length) out.push('No accepted knowledge.', '');
  for (const k of doc.knowledge) {
    out.push(`### ${k.kind.replace('_', ' ')} (${k.basis.replace('_', ' ')})`, '', ...quote(k.text));
    for (const s of k.sources) out.push('', `Source: ${sourceLine(s)}`);
    out.push('');
  }
  if (doc.truncated) out.push('Older revisions of some artifacts are listed without their text: the export was too large to carry them all.', '');
  return `${out.join('\n').trimEnd()}\n`;
}

/** The handoff as a document the next person reads first. */
export function renderHandoffMarkdown(h: Handoff, projectName: string): string {
  const out: string[] = [`# Handoff: ${inline(projectName) || 'project'}`, '', 'Participant text is quoted. Nothing here is a credential.', ''];
  out.push('## Objective', '', ...(h.objective.trim() ? quote(h.objective) : ['Nobody has written an objective.']), '');
  out.push(`## Accepted outcomes (${h.accepted.length})`, '');
  if (!h.accepted.length) out.push('None yet.', '');
  for (const i of h.accepted) out.push(...workLines(i));
  out.push(`## Unfinished (${h.unfinished.length})`, '');
  if (!h.unfinished.length) out.push('Nothing is unfinished.', '');
  for (const i of h.unfinished) out.push(...workLines(i));
  out.push('## Current revisions', '');
  if (!h.revisions.length) out.push('No artifacts.', '');
  for (const r of h.revisions) out.push(`- ${inline(r.title) || '(untitled)'}: revision ${r.n}, ${r.status}, digest ${r.digest}`);
  if (h.revisions.length) out.push('');
  out.push('## Decisions', '');
  if (!h.decisions.length) out.push('None accepted.', '');
  for (const d of h.decisions) out.push(...quote(d), '');
  out.push('## Open questions', '');
  if (!h.openQuestions.length) out.push('None recorded.', '');
  for (const q of h.openQuestions) out.push(...quote(q), '');
  out.push('## Sources the project may read', '');
  if (!h.sources.length) out.push('None named.', '');
  for (const s of h.sources) out.push(`- ${sourceLine(s)}`);
  return `${out.join('\n').trimEnd()}\n`;
}
