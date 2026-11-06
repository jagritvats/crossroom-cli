/**
 * The consumer check: before a pull request merges, ask each team that consumes
 * this repository, through that team's ask link, whether the change breaks them, and read the
 * answer from the room's ledger rather than from anything an agent wrote.
 *
 * A script does the talking (the ask, `crossroom join` for the pull request's seat, the owner's
 * `wait`, the minutes), and a CI workflow runs it. This file
 * is the part of it that decides, and it is pure: no network, no files, no clock.
 *
 * - **The verdict** comes from the claim the owner registered with the ask (`AskInput.claims`,
 *   "PR #N breaks <consumer>"), by index among the owner's claims, never by its text: a claim's
 *   text is sealed where the dashboard reads, and in an end-to-end room it is ciphertext. Its
 *   `status` is the agents' finding, which unanimity makes honest: `agreed` needs at least two
 *   positions, so one agent alone can never fail a check. `agreed` fails
 *   the check (`breaks`), `rejected` passes it (`safe`), and anything else is `neutral`, with the
 *   minutes beside it for a person to read.
 * - **The consumer's own seat has to agree.** In an ask room the standing seat is the consumer's
 *   agent, answering from the consumer's code. A `breaks` or `safe` whose standing seat does not
 *   hold that same stance is reported neutral: the verdict means that the consumer's side said so.
 * - **Nothing a participant wrote reaches the summary.** It prints the consumer's name (checked
 *   against `ConsumersFile`), Crossroom's claim label and status words, the standing seat's label
 *   (checked against `SEAT_LABEL` when the relay made the room), and fixed sentences. A seat's own
 *   name, which an agent picks on `join`, is never printed.
 * - **No credential leaves the check.** The ask link, the owner token and the pull request's seat
 *   link stay in the script's memory; `childEnv` strips them and GitHub's own tokens from what
 *   `crossroom join` inherits, and `redact` takes them out of everything written to disk.
 * - **No stranger reads a consumer's answers.** Under GitHub Actions the minutes and the join's log
 *   are kept only in a private repository (`minutesMayBeKept`), since the output directory becomes
 *   an artifact that anyone signed in could download from a public one.
 */
import type { Claim, ClaimStatus, Participant, Position, SessionStatus, Stance, StandingSeatInfo } from '@parley/shared';
import { AskInput, ConsumersFile, type ConsumerVerdict, SEAT_LABEL, StandingRuntime } from '@parley/shared/runner';
import { oneLine, RUNNER_LABELS, slotLetter } from '@parley/shared/text';
import { parse as parseYaml } from 'yaml';

/** A mistake in the check's own inputs: the consumers file, a flag, a secret. Its message names no secret. */
export class ConsumerCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumerCheckError';
  }
}

// ---------------------------------------------------------------- the verdict

/** What a verdict is read from: any snapshot of the room that keeps its claims and positions (the owner's does). */
export interface Ledger {
  session: { status: SessionStatus };
  participants: ReadonlyArray<Pick<Participant, 'id' | 'slot' | 'kind'>>;
  claims: ReadonlyArray<Pick<Claim, 'id' | 'label' | 'createdBy' | 'status'>>;
  positions: ReadonlyArray<Pick<Position, 'claimId' | 'participantId' | 'stance' | 'createdAt'>>;
}

export interface Verdict {
  verdict: ConsumerVerdict;
  /** The claim the verdict was read from (`C1`), or null when the room holds no owner claim at that index. */
  claim: string | null;
  status: ClaimStatus | null;
  /** Why, in Crossroom's own words. Never anything a participant wrote. */
  why: string;
  /** Each seat's latest stance on that claim, by slot letter and in slot order; null where it took none. */
  stances: Array<{ seat: string; kind: Participant['kind']; stance: Stance | null }>;
  /** The room had ended when it was read. A live room's verdict can still change. */
  ended: boolean;
}

/** The fixed sentences a verdict gives as its reason. */
export const WHY = {
  noClaim: 'The room holds no claim registered by its owner, so there is nothing to read a verdict from.',
  agreed: 'Established: every seat supports the claim, so the change breaks this consumer.',
  rejected: 'Ruled out: every seat opposes the claim, so the change does not break this consumer.',
  disputed: 'Disputed: the seats hold opposite stances on the claim.',
  inconsistent: "Left open: the consumer's own seat does not hold the stance the claim's status reports.",
  standingSilent: "Left open: the consumer's own seat took no position on the claim.",
  askerSilent: 'Left open: the asking seat took no position on the claim.',
  seatSilent: 'Left open: fewer than two seats took a position on the claim.',
  undecided: 'Left open: a seat is uncertain, or found the evidence insufficient.',
} as const;

const labelNumber = (label: string) => {
  const n = Number(label.replace(/^C/, ''));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

/** The claims the room's owner registered, in the order they were registered (C1 before C2). */
export function ownerClaims<C extends Ledger['claims'][number]>(claims: ReadonlyArray<C>): C[] {
  return claims.filter((c) => c.createdBy === 'human').sort((a, b) => labelNumber(a.label) - labelNumber(b.label));
}

/** Each participant's latest stance on one claim. Positions are read in time order; a tie keeps the later one in the list. */
function latestStances(positions: Ledger['positions'], claimId: string): Map<string, Stance> {
  const mine = positions
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.claimId === claimId)
    .sort((a, b) => (a.p.createdAt === b.p.createdAt ? a.i - b.i : a.p.createdAt < b.p.createdAt ? -1 : 1));
  const out = new Map<string, Stance>();
  for (const { p } of mine) out.set(p.participantId, p.stance);
  return out;
}

/**
 * The consumer check's verdict on a room, from its ledger: the owner's claim at `index` (the first,
 * by default, which is the one an ask registers), its status, and the consumer's own seat's stance.
 */
export function verdictOf(ledger: Ledger, index = 0): Verdict {
  const ended = ledger.session.status === 'ended';
  const claim = ownerClaims(ledger.claims)[index];
  if (!claim) return { verdict: 'neutral', claim: null, status: null, why: WHY.noClaim, stances: [], ended };

  const latest = latestStances(ledger.positions, claim.id);
  const seats = [...ledger.participants].sort((a, b) => a.slot - b.slot);
  const stances = seats.map((p) => ({ seat: slotLetter(p.slot), kind: p.kind, stance: latest.get(p.id) ?? null }));
  const standing = seats.filter((p) => p.kind === 'standing');
  const read = { claim: claim.label, status: claim.status, stances, ended };

  if (claim.status === 'agreed' || claim.status === 'rejected') {
    const held: Stance = claim.status === 'agreed' ? 'support' : 'oppose';
    if (standing.some((p) => latest.get(p.id) !== held)) return { ...read, verdict: 'neutral', why: WHY.inconsistent };
    return { ...read, verdict: claim.status === 'agreed' ? 'breaks' : 'safe', why: WHY[claim.status] };
  }
  if (claim.status === 'disputed') return { ...read, verdict: 'neutral', why: WHY.disputed };
  let why: string = WHY.undecided;
  if (standing.length && standing.some((p) => !latest.has(p.id))) why = WHY.standingSilent;
  else if (standing.length && seats.some((p) => p.kind !== 'standing' && !latest.has(p.id))) why = WHY.askerSilent;
  else if (latest.size < 2) why = WHY.seatSilent;
  return { ...read, verdict: 'neutral', why };
}

/** The check fails when any consumer's verdict is `breaks`, and only then. */
export const exitCodeOf = (results: ReadonlyArray<{ verdict: ConsumerVerdict }>) => (results.some((r) => r.verdict === 'breaks') ? 1 : 0);

// ---------------------------------------------------------------- the consumers file

/** The largest `.parley/consumers.yml` the check reads. */
export const CONSUMERS_MAX_BYTES = 64 * 1024;

/** A validation message that could carry what it failed on is replaced when that looks like an ask link. */
const scrub = (message: string) => (/\/ask\//.test(message) ? 'holds something shaped like an ask link' : oneLine(message).slice(0, 200));

/**
 * `.parley/consumers.yml`, read and checked against `ConsumersFile`: an ask link is named by the
 * secret that holds it, never written out. Errors say where the file is wrong and never repeat
 * what the file holds there, so a link pasted in by mistake does not reach a public build log.
 */
export function parseConsumers(text: string): ConsumersFile {
  if (text.length > CONSUMERS_MAX_BYTES) throw new ConsumerCheckError(`consumers.yml is larger than ${CONSUMERS_MAX_BYTES / 1024} KiB`);
  let doc: unknown;
  try {
    // Few aliases: a file that expands itself into gigabytes is not a list of consumers.
    doc = parseYaml(text, { maxAliasCount: 10, prettyErrors: false, uniqueKeys: true });
  } catch (e) {
    const line = (e as { linePos?: Array<{ line: number }> }).linePos?.[0]?.line;
    throw new ConsumerCheckError(`consumers.yml is not valid YAML${line ? ` (line ${line})` : ''}`);
  }
  const parsed = ConsumersFile.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const said = scrub(issue.message);
    if (issue.path.length) throw new ConsumerCheckError(`consumers.yml: ${issue.path.join('.')}: ${said}`);
    throw new ConsumerCheckError(said.startsWith('consumers.yml') ? said : `consumers.yml: ${said}`);
  }
  const seen = new Set<string>();
  for (const c of parsed.data.consumers) {
    if (seen.has(c.name)) throw new ConsumerCheckError(`consumers.yml names the consumer "${c.name}" twice`);
    seen.add(c.name);
  }
  return parsed.data;
}

// ---------------------------------------------------------------- links

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TOKEN = '[A-Za-z0-9_-]{16,128}';

/** An address the check may send a credential to: HTTPS, or plain HTTP to this machine only. */
function credentialUrl(text: string): URL | null {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname))) return null;
  return u;
}

/**
 * An ask link (`<relay>/ask/<token>`) taken apart: the relay's base address and the token, which
 * travels only in `x-parley-ask` and only to that relay. Null for anything else, including an
 * `http:` link to another machine, which would send the token in the clear.
 */
export function askLinkParts(link: string): { base: string; token: string } | null {
  const u = credentialUrl(link);
  const m = u && new RegExp(`^(.*)/ask/(${TOKEN})/?$`).exec(u.pathname);
  return u && m ? { base: `${u.origin}${m[1]}`, token: m[2]! } : null;
}

/**
 * The asker's seat link from the ask's answer, accepted only on the relay the ask went to: `parley
 * join` sends its token wherever the link points. Its token, or null.
 */
export function seatLinkToken(seatUrl: unknown, base: string): string | null {
  if (typeof seatUrl !== 'string') return null;
  const u = credentialUrl(seatUrl);
  const m = u && new RegExp(`^(.*)/j/(${TOKEN})$`).exec(u.pathname);
  return u && m && `${u.origin}${m[1]}` === base ? m[2]! : null;
}

// ---------------------------------------------------------------- the ask

/** A pull request number, as the check takes it. */
export const PR_NUMBER = /^[1-9][0-9]{0,9}$/;
/** A commit, as `git rev-parse` prints it. The only thing from the pull request besides its number that reaches the room. */
export const COMMIT = /^[0-9a-f]{7,64}$/;
const QUESTION_MAX = AskInput.shape.question.maxLength ?? 2000;

/** The claim an ask registers for one consumer: the verdict's source. */
export const claimFor = (consumer: string, pr: number) => `PR #${pr} breaks ${consumer}`;

/**
 * What the check adds to the team's question, in fixed words. Nothing from the pull request but its
 * number and head commit: a branch name or a title is text anyone opening a pull request chose, and
 * this is read by the consumer's agent as its brief.
 */
export function checkNote(consumer: string, pr: number, head: string | null): string {
  const at = head ? ` (commit ${head})` : '';
  return [
    `This room is an automated consumer check. Seat A holds pull request #${pr}'s head${at} and can show what changed.`,
    `The owner registered the claim "${claimFor(consumer, pr)}" as the check's verdict: once the evidence is in, support it if the change breaks ${consumer}, oppose it if it does not, and finish.`,
  ].join(' ');
}

/** The body of `POST /api/ask` for one consumer, checked against `AskInput`. */
export function askBody(file: ConsumersFile, consumer: string, pr: number, head: string | null = null): AskInput {
  if (!PR_NUMBER.test(String(pr))) throw new ConsumerCheckError('the pull request number is not a number');
  if (head !== null && !COMMIT.test(head)) throw new ConsumerCheckError('the head commit is not a commit id');
  const filled = file.question.replaceAll('${pr}', String(pr)).replaceAll('${consumer}', consumer);
  const question = `${filled.trim()}\n\n${checkNote(consumer, pr, head)}`;
  if (question.length > QUESTION_MAX)
    throw new ConsumerCheckError(
      `the question in consumers.yml is too long once filled in: keep it under ${QUESTION_MAX - checkNote(consumer, pr, head).length - 2} characters`,
    );
  return AskInput.parse({
    question,
    title: `Consumer check: PR #${pr} and ${consumer}`,
    name: `PR #${pr}`,
    claims: [claimFor(consumer, pr)],
  });
}

// ---------------------------------------------------------------- what the check hands on

/**
 * Tokens GitHub gives a job, which an agent reading its checkout has no use for. `crossroom join`
 * never gets them, nor any variable a consumer's ask link is in.
 */
export const GITHUB_TOKENS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
];

/**
 * The environment `crossroom join` starts with: the check's own, less GitHub's tokens, every variable
 * the consumers file names, and any variable whose value holds one of `secrets` (an ask link, an
 * ask token, the owner token, a seat link). Names compare case-insensitively, as Windows does.
 */
export function childEnv(env: NodeJS.ProcessEnv, named: readonly string[], secrets: readonly string[]): Record<string, string> {
  const drop = new Set([...GITHUB_TOKENS, ...named].map((n) => n.toUpperCase()));
  const held = secrets.filter((s) => s.length >= 8);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || drop.has(k.toUpperCase())) continue;
    if (held.some((s) => v.includes(s) || v.includes(encodeURIComponent(s)))) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Whether a check under GitHub Actions may keep the minutes and the join's log, from the
 * workflow's event (`GITHUB_EVENT_PATH`): only when it says the repository is private. The output
 * directory becomes the job's artifact, which in a public repository anyone signed in to GitHub
 * can download, and the minutes hold what each consumer's agent said about its code. A consumer's
 * room is private to its owner, and a public artifact would hand it to everyone. An event that
 * cannot be read, or does not say, keeps nothing.
 */
export const minutesMayBeKept = (event: unknown): boolean =>
  typeof event === 'object' && event !== null && (event as { repository?: { private?: unknown } }).repository?.private === true;

/** `text` with every secret in it, raw or URL-encoded, replaced. Longest first, so a link goes before its token. */
export function redact(text: string, secrets: readonly string[]): string {
  const forms = [...new Set(secrets.filter((s) => s.length >= 8).flatMap((s) => [s, encodeURIComponent(s)]))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const f of forms) out = out.split(f).join('[redacted]');
  return out;
}

/**
 * Why a relay refused an ask, by its status, in fixed words: the relay's own answer is never
 * printed, since a build log reads `::` at the start of a line as a command to the runner.
 */
export function askRefusal(status: number, secret: string): string {
  switch (status) {
    case 404:
      return `The ask link in ${secret} opens nothing any more: ask the consumer's team for a fresh one.`;
    case 409:
      return "The consumer's seat is paused: its team is not taking questions right now.";
    case 429:
      return "The consumer's seat has had as many questions as it takes for now.";
    case 503:
      return 'The relay is holding its limit of live rooms.';
    case 0:
      return 'The relay could not be reached.';
    default:
      return `The relay refused the ask (HTTP ${status}).`;
  }
}

/** Sentences for what went wrong around the room rather than in it. */
export const TROUBLE = {
  noSecret: (secret: string) => `The secret ${secret} is not set in this job: pass it to the step's environment.`,
  notALink: (secret: string) => `${secret} does not hold an ask link (https://<relay>/ask/<token>).`,
  notARoom: 'The relay answered the ask with something that is not an ask room.',
  unreadable: 'The check could not read the room once it had ended.',
  deleted: 'The room was deleted before the check could read it.',
  joinStopped: "Left open: the pull request's agent stopped before the room ended.",
  failed: 'The check failed while it held this room.',
} as const;

/** Who answered, from a room's participants, as the relay recorded it: only a well-formed `Participant.standing`. */
export function standingOf(participants: ReadonlyArray<{ kind?: unknown; standing?: unknown }>): StandingSeatInfo | null {
  const s = participants.find((p) => p.kind === 'standing')?.standing as Partial<StandingSeatInfo> | undefined;
  const runtime = StandingRuntime.safeParse(s?.runtime);
  if (!s || typeof s.label !== 'string' || !SEAT_LABEL.test(s.label) || !runtime.success) return null;
  return { label: s.label, runtime: runtime.data, confined: s.confined === true };
}

/** One consumer's result, as the check prints, writes and summarises it. */
export interface CheckResult {
  consumer: string;
  verdict: ConsumerVerdict;
  claim: string | null;
  status: ClaimStatus | null;
  why: string;
  /** The room's id, or null where no room was opened. Not a credential: every read of it takes the owner token. */
  room: string | null;
  /** Who answered, as the relay recorded it when the room was made. */
  standing: StandingSeatInfo | null;
  /** The check ended the room itself: the time ran out, or the pull request's agent stopped. */
  endedByCheck: boolean;
}

/** A result for a consumer the check could not ask at all. */
export const unasked = (consumer: string, why: string): CheckResult => ({
  consumer,
  verdict: 'neutral',
  claim: null,
  status: null,
  why,
  room: null,
  standing: null,
  endedByCheck: false,
});

const STATUS_WORDS: Record<ClaimStatus, string> = { agreed: 'established', rejected: 'ruled out', disputed: 'disputed', open: 'open' };

/** One table cell: on one line, with everything markdown reads as structure escaped. */
const cell = (text: string) => oneLine(text).replace(/[\\`*_[\]<>|#!~]/g, '\\$&');

const answeredBy = (s: StandingSeatInfo | null) =>
  s ? `${s.label} (${RUNNER_LABELS[s.runtime] ?? s.runtime}${s.confined ? '' : ', reads not confined'})` : '';

/**
 * The markdown the check appends to the job summary: one row per consumer and where the minutes
 * are, or that they were not kept (`minutesMayBeKept`). Built from fixed words and checked fields
 * only (see the file header).
 */
export function renderSummary(
  results: readonly CheckResult[],
  opts: { pr: number; runUrl?: string | null; minutesKept?: boolean },
): string {
  const rows = results.map((r) =>
    [
      cell(r.consumer),
      r.verdict === 'neutral' ? 'neutral' : `**${r.verdict}**`,
      r.claim && r.status ? cell(`${r.claim} ${STATUS_WORDS[r.status]}`) : '',
      cell(answeredBy(r.standing)),
      cell(`${r.why}${r.endedByCheck ? ' The check ended the room before the seats finished.' : ''}`),
    ].join(' | '),
  );
  const run = opts.runUrl && credentialUrl(opts.runUrl) ? opts.runUrl : null;
  return [
    `## Crossroom consumer check: PR #${opts.pr}`,
    '',
    '| Consumer | Verdict | Claim | Answered by | Why |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r} |`),
    '',
    opts.minutesKept === false
      ? "The minutes were not kept: this job could not tell that its repository is private, and in a public one anyone signed in to GitHub can download a run's artifacts. They would hold what each consumer's agent said about its code."
      : run
        ? `The minutes of every room, and the pull request agent's log for each, are in this run's \`parley-consumer-check\` artifact: <${run}>`
        : "The minutes of every room, and the pull request agent's log for each, are in the check's output directory.",
    '',
  ].join('\n');
}

/** One line per consumer for the build log: its name, the verdict and fixed words. */
export const lineFor = (r: CheckResult) => `${r.consumer}: ${r.verdict}. ${r.why}${r.endedByCheck ? ' The check ended the room before the seats finished.' : ''}`;

/**
 * A GitHub workflow command (`::error::…`) with its message escaped, so nothing in it can end the
 * command early or start another one.
 */
export function annotation(kind: 'error' | 'warning' | 'notice', message: string): string {
  const esc = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `::${kind}::${esc}`;
}
