/**
 * `crossroom artifact` (workspace I6): put a file into a project as an artifact revision, or list
 * the project's artifacts, signed in with `crossroom login`'s API token.
 *
 * - `crossroom artifact submit <project> <file|-> [--artifact <id>] [--title <t>] [--kind markdown|text]
 *   [--audience project|reviewers|private] [--workspace <w>] [--json]`: without `--artifact`, a new
 *   artifact whose first revision is the file; with it, the next revision of that artifact (the
 *   server refuses a revision identical to the last one). The file is read as UTF-8 text, bounded
 *   before anything is sent: a binary file, or one past the artifact body limit, is refused here.
 * - `crossroom artifact list <project> [--workspace <w>] [--json]`: the artifacts the account may
 *   see, with each one's latest revision and where it stands.
 *
 * A revision is immutable and starts unreviewed: submitting is never accepting.
 */
import path from 'node:path';
import {
  type ArtifactListResult,
  type ArtifactResult,
  ArtifactAudience,
  CreateArtifactInput,
  CreateRevisionInput,
  MAX_ARTIFACT_BODY_CHARS,
  REVISION_STATUS_LABEL,
} from '@parley/shared/work';
import { type Args, Usage } from '../cli.js';
import { registerCommand } from './index.js';
import { type Client, flag, get, line, pickProject, readText, realStdin, type StdinReader } from './project-pick.js';
import { call, type FetchLike, realFetch, signedIn } from './relay-call.js';

const USAGE = [
  'Usage: crossroom artifact submit <project> <file|-> [--artifact <id>] [--title <t>] [--kind markdown|text] [--audience project|reviewers|private] [--workspace <w>] [--json]',
  '       crossroom artifact list <project> [--workspace <w>] [--json]',
].join('\n');

/** The kinds a file can be: a link is not a file. */
const FILE_KINDS = ['markdown', 'text'] as const;

export interface ArtifactDeps {
  fetch: FetchLike;
  stdin: StdinReader;
}
const realDeps: ArtifactDeps = { fetch: realFetch, stdin: realStdin };

const kindOfFile = (file: string): (typeof FILE_KINDS)[number] => (/\.(md|markdown|mdx)$/i.test(file) ? 'markdown' : 'text');

/** A title from a file's name: its base name without the extension, kept within the title limit. */
const titleOfFile = (file: string): string => line(path.basename(file, path.extname(file))).slice(0, 200).trim();

export async function artifactCommand(args: Args, out: (line: string) => void, deps: ArtifactDeps = realDeps): Promise<number> {
  const form = args.positional[0];
  const json = args.flags.json === true;
  if (form !== 'submit' && form !== 'list') throw new Usage(USAGE);
  const workspace = flag(args, 'workspace');

  if (form === 'list') {
    const named = args.positional[1];
    if (!named || args.positional.length > 2) throw new Usage(USAGE);
    const { relay, token } = signedIn(args);
    const c: Client = { relay, token, fetchImpl: deps.fetch };
    const p = await pickProject(c, named, workspace, USAGE);
    const { artifacts } = await get<ArtifactListResult>(c, `/api/projects/${encodeURIComponent(p.id)}/artifacts`);
    if (json) out(JSON.stringify({ project: p, artifacts }, null, 2));
    else if (!artifacts.length) out(`${line(p.name)} has no artifacts yet. \`crossroom artifact submit ${p.id} <file>\` adds one.`);
    else {
      out(`${line(p.name)} (${p.id})`);
      for (const a of artifacts) out(`  ${a.id}  r${a.latestRevision}  ${REVISION_STATUS_LABEL[a.latestStatus]}  ${line(a.title)}`);
    }
    return 0;
  }

  const [named, file] = args.positional.slice(1);
  if (!named || !file || args.positional.length > 3) throw new Usage(USAGE);
  const artifact = flag(args, 'artifact');
  const title = flag(args, 'title');
  const kind = flag(args, 'kind');
  const audience = flag(args, 'audience');
  if (artifact && (title !== undefined || kind !== undefined || audience !== undefined))
    throw new Usage('--title, --kind and --audience describe a new artifact. With --artifact the revision joins one that is there already.');
  if (kind !== undefined && !(FILE_KINDS as readonly string[]).includes(kind)) throw new Usage(`--kind is one of ${FILE_KINDS.join(', ')} for a file; got "${line(kind)}".`);
  if (audience !== undefined && !ArtifactAudience.safeParse(audience).success) throw new Usage(`--audience is one of ${ArtifactAudience.options.join(', ')}; got "${line(audience)}".`);
  if (file === '-' && !artifact && !title) throw new Usage('A new artifact read from stdin needs a --title.');

  // The file is read and checked before the relay is asked anything: a refusal sends nothing.
  const body = await readText(file, 'an artifact', deps.stdin);
  if (!body.trim()) throw new Usage(`${file === '-' ? 'stdin' : line(file)} is empty. Nothing was sent.`);
  if (body.length > MAX_ARTIFACT_BODY_CHARS)
    throw new Usage(`${file === '-' ? 'stdin' : line(file)} is ${body.length} characters; an artifact holds at most ${MAX_ARTIFACT_BODY_CHARS}. Nothing was sent.`);

  const { relay, token } = signedIn(args);
  const c: Client = { relay, token, fetchImpl: deps.fetch };
  const p = await pickProject(c, named, workspace, USAGE);
  const base = `/api/projects/${encodeURIComponent(p.id)}/artifacts`;
  let made: ArtifactResult;
  if (artifact) {
    const input = CreateRevisionInput.parse({ body });
    made = await call<ArtifactResult>(relay, token, deps.fetch, 'POST', `${base}/${encodeURIComponent(artifact)}/revisions`, input);
  } else {
    const input = CreateArtifactInput.safeParse({
      title: title ?? titleOfFile(file),
      kind: kind ?? kindOfFile(file),
      ...(audience ? { audience } : {}),
      body,
    });
    if (!input.success) throw new Usage(`title: ${input.error.issues[0]?.message ?? 'that is not valid'}. Nothing was sent.`);
    made = await call<ArtifactResult>(relay, token, deps.fetch, 'POST', base, input.data);
  }
  const rev = made.revisions[made.revisions.length - 1] ?? made.revisions[0];
  if (json) out(JSON.stringify({ project: p, ...made }, null, 2));
  else {
    out(`Submitted revision ${rev ? rev.n : made.artifact.latestRevision} of "${line(made.artifact.title)}" (${made.artifact.id}) to ${line(p.name)}.`);
    out(`It is ${REVISION_STATUS_LABEL[rev?.status ?? made.artifact.latestStatus].toLowerCase()}${rev ? `, digest ${rev.digest.slice(0, 12)}` : ''}. Someone with access reviews it in the project.`);
  }
  return 0;
}

registerCommand({
  name: 'artifact',
  topic: 'workspace',
  usage: 'crossroom artifact submit <project> <file>',
  summary: 'put a file into a project as an artifact revision',
  more: [{ usage: '[--artifact <id>] [--title <t>] [--kind markdown|text] [--audience project|reviewers|private] | list <project>' }],
  order: 182,
  run(args) {
    return artifactCommand(args, (l) => console.log(l));
  },
});
