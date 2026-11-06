/**
 * A standing seat's policy, as pure functions: the runner's egress proxy runs them
 * first, and the relay's `beforeShare` hook runs `deniedPaths` and `scanSecrets` again as the
 * second line. No Node APIs, so the web and both sides can import it; globs go through picomatch
 * (a dependency of this package, pinned by S9).
 *
 * Everything here fails closed. A source is read for every name it could mean, `parseSource`'s
 * paths included, bare names and wildcards too; a path is tried in every form it could take inside
 * the repository; a glob that names a directory also denies what is in it, and a wildcard that
 * could reach a denied directory is denied; a line is looked up in every form a viewer, a diff or
 * a quote gives it; and `checkOutbound` refuses every call when the policy, the call or the counts
 * it is given cannot be read, or when any check throws.
 *
 * Every regular expression written here (the secret patterns, the source and line parsing) runs
 * in time linear in its input, because the runner's proxy runs them on a call before any size
 * limit applies, and the relay runs them on its event loop. A test times each pattern on
 * inputs built to make a backtracking one slow. The globs are not: picomatch compiles a deny or
 * review glob, and a wildcard source segment in `reachesBase`, to regular expressions that
 * backtrack polynomially (`**` crosses `/`), and braces and extglobs exponentially. A team's glob
 * and an agent's long path can take seconds, so every caller bounds the whole check in time
 * (`withinTime` in the runner's `runner/egress-policy.ts`, and the relay's `checkBounded`).
 *
 * What it cannot see, the docs say (SECURITY.md, "Policy on the runner"): a paraphrase of a denied file, a
 * secret no pattern knows, a path an agent never names. Deny by content (the runner's line index,
 * `runner/denied-lines.ts`) and the known-secret scan narrow the first two.
 */
import picomatch from 'picomatch';
import { type PolicyVerdict, SeatPolicy } from './runner.js';
import { parseSource } from './sources.js';
import { LINE_BREAK } from './text.js';

/** A secret pattern's name, as `policy_events.rule` records it (`secret:<name>`). */
export type SecretName =
  | 'private_key'
  | 'aws_access_key'
  | 'aws_secret'
  | 'github_token'
  | 'gitlab_token'
  | 'slack_token'
  | 'slack_webhook'
  | 'stripe_key'
  | 'anthropic_key'
  | 'openai_key'
  | 'google_api_key'
  | 'gcp_service_account'
  | 'azure_storage'
  | 'npm_token'
  | 'pypi_token'
  | 'sendgrid_key'
  | 'jwt'
  | 'conn_string_password'
  | 'generic_assignment';

export interface SecretPattern {
  name: SecretName | string;
  /** Never global: `scanSecrets` makes its own global copy where it needs every match. */
  regex: RegExp;
  /** What finding it does to the packet: `hold` for the patterns that are often false (a JWT, a generic assignment). */
  action: 'refuse' | 'hold';
  /** A second look at each match, for a pattern a regular expression cannot settle alone (entropy, placeholders). */
  accept?: (match: RegExpExecArray) => boolean;
}

export interface SecretFinding {
  name: string;
  action: 'refuse' | 'hold';
}

/** An outbound call as the checks see it: every field an agent could have put text in. */
export interface Outbound {
  op: string;
  fields: Readonly<Record<string, string>>;
  source?: string | null;
  kind?: string;
}

/** What the seat has used in this room, for the budget. */
export interface Used {
  messages: number;
  packets: number;
  minutes: number;
  spendUsd?: number;
}

/** What only the runner knows, and how its checkout names paths (`checkOutbound`'s fourth argument). */
export interface RunnerContext {
  /**
   * Whether a line is in a denied file and in no allowed one. It is handed every key
   * `deniedLineKeys` gives a line of the call, so the index must be built the same way: each line
   * of a denied file under every key `deniedLineKeys` gives it, less the keys a line of an allowed
   * file gives. Keys are at least `DENIED_LINE_MIN` characters.
   */
  deniedLines?: { has(line: string): boolean };
  /** Every token and secret value this runner must never let out, raw; the encodings are tried here. */
  knownSecrets?: readonly string[];
  /** The repository's directory name, so `payments-api/config/x.yml` is read as `config/x.yml` too. */
  repo?: string;
  /** Match paths without regard to case: set it where the file system does (`caseInsensitivePaths`). */
  nocase?: boolean;
}

// ---------------------------------------------------------------- paths

/**
 * Whether a platform's usual file system ignores case (`process.platform`, or a runner's declared
 * `os`): Windows, and macOS, whose default APFS volume does. There, `CONFIG/prod/db.yml` is the
 * file a deny glob `config/prod/**` names.
 */
export const caseInsensitivePaths = (platform: string) => platform === 'win32' || platform === 'darwin';

/**
 * What ends a name inside a longer token: anything but a letter, a mark, a digit and
 * `_ . - ~ @ + $ % / \`. So `config/prod/db.yml(12)`, `[db](config/prod/db.yml)`,
 * `config/prod/db.yml[1-5]` and `x|head` each give up the name in them, and `café.yml` stays whole.
 */
const NOT_NAME = /[^\p{L}\p{M}\p{N}_.\-~@+$%/\\]+/u;

/** A glob's wildcards, extglobs included: a token holding one names whatever it could expand to. */
const WILDCARD = /[*?[\]{}]|[!@+]\(/;

/**
 * A name as a source may give one: `config/prod/db.yml`, `.env`, and a bare `id_rsa` or
 * `credentials` too, which a deny list may name as well as a path. Not an option, dots alone, or a
 * line number or range. A bare word that is no file costs nothing: it matches only a glob that
 * names it.
 */
function nameLike(t: string): boolean {
  if (!t || t.length > 1024 || t.startsWith('-') || /^\.+$/.test(t)) return false;
  if (/^L?\d+(?:-L?\d+)?$/i.test(t)) return false;
  return /[\p{L}\p{N}]/u.test(t);
}

/** The forms of one token worth trying: as written, and with what an agent adds around a path taken off. */
function tokenForms(token: string): string[] {
  // As written, so a wildcard at either end stays (`config/*`, `*` + `/prod/db.yml`); out of the
  // punctuation around it, as in "(see `a.ts`)." or "<b.ts>" or markdown's `**a.ts**`; and out of
  // all but the `*`, so "(config/*)" keeps its wildcard too.
  const forms = new Set<string>([token]);
  for (const t of [trimChars(token, '([{<"\'`*', ')]}>"\'`*.!?'), trimChars(token, '([{<"\'`', ')]}>"\'`.!?')]) {
    forms.add(t);
    // `a.ts#L10-L20`, `README.md#usage`.
    forms.add(t.replace(/#.*$/, ''));
    // `a.ts@abc1234`: a commit after the path. A scoped package keeps its `@` (`node_modules/@types/x.d.ts`).
    forms.add(t.replace(/@[0-9a-fA-F]{7,40}$/, ''));
    forms.add(t.replace(/#.*$/, '').replace(/@[0-9a-fA-F]{7,40}$/, ''));
  }
  return [...forms];
}

/**
 * `s` without the run of `open` characters it starts with and the run of `close` characters it ends
 * with. A loop, not `/[...]+$/`, which backtracks from every character of a long run.
 */
function trimChars(s: string, open: string, close: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && open.includes(s[a]!)) a++;
  while (b > a && close.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/**
 * Every name a source could mean. First `parseSource`'s paths (`@parley/shared/sources`), the
 * files the source check reads, so a packet is never checked against a file the deny list let
 * out. Then every token after splitting on space, `:`, `,`, `;`, `=` and `|`, as written
 * (wildcards kept: `config/prod/*.yml`) and cut at every character no name holds (`NOT_NAME`), each
 * with its `#L10-L20` or `@<commit>` taken off and out of the punctuation a sentence puts around it.
 * So `git show HEAD:config/prod/db.yml|head -20` names `config/prod/db.yml`, `git show abc1234 --
 * a.ts, b.ts` names both files though the source check reads neither, and `git show HEAD:id_rsa`
 * names `id_rsa`. A Windows path loses its drive letter to the `:` split, which `deniedPaths` does
 * not need.
 */
export function pathsNamedIn(source: string): string[] {
  if (typeof source !== 'string' || !source) return [];
  const out = new Set<string>(parseSource(source).map((f) => f.path));
  const add = (piece: string) => {
    for (const form of tokenForms(piece)) if (nameLike(form)) out.add(form);
  };
  // Split at commas and without them, which a brace list keeps (`config/{prod,dev}/db.yml`).
  for (const token of new Set([...source.split(/[\s:,;=|]+/), ...source.split(/[\s:;=|]+/)])) {
    if (!token) continue;
    add(token);
    for (const piece of token.split(NOT_NAME)) if (piece !== token) add(piece);
  }
  return [...out];
}

/** A path's segments with `\` read as `/`, no drive letter, no `.` or empty segment, and `..` applied where it can be. */
function segmentsOf(p: string): string[] {
  const s = p.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/|$)/, '');
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return out;
}

/** Where a code host puts a ref between a repository and a path: `blob/main/`, GitLab's `-/blob/main/`. */
const REF_VIEWS: ReadonlySet<string> = new Set(['blob', 'tree', 'raw', 'blame', 'edit', 'src', 'commits']);

/** The most forms one path is tried in (`candidatesOf`). A real one takes a handful. */
const MAX_FORMS = 64;

/** A URL, or what is left of one after `pathsNamedIn`'s `:` split (`//github.com/...`), or a bare `host.tld/...`. */
const URLISH = /^(?:[A-Za-z][\w+.-]*:)?\/\/|^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?\//;

/**
 * Every form a path could take relative to the repository's top: as normalised; without the `..`
 * it starts with (an agent in a subdirectory); and after each segment that is the repository's own
 * name (`payments-api/config/x.yml`, `/home/ci/payments-api/config/x.yml`), also with the ref a
 * code host's URL puts after it taken off (`github.com/acme/payments-api/blob/main/config/x.yml`,
 * `raw.githubusercontent.com/acme/payments-api/main/config/x.yml`). A ref may hold a `/`
 * (`blob/release/2.4/`, `refs/heads/main/`), so after a code host's view, and anywhere after the
 * repository's name in a URL, every way of cutting the ref off is tried. More forms can only deny
 * more. At most `MAX_FORMS`, the earliest cuts first, so a token that repeats the repository's
 * name costs no more than one that names it once.
 */
function candidatesOf(p: string, repo: string | undefined, nocase: boolean): string[] {
  const segs = segmentsOf(p);
  const out = new Set<string>([segs.join('/')]);
  let up = 0;
  while (segs[up] === '..') up++;
  if (up) out.add(segs.slice(up).join('/'));
  if (repo) {
    const name = nocase ? repo.toLowerCase() : repo;
    const url = URLISH.test(p.replace(/\\/g, '/'));
    for (let i = 0; i < segs.length && out.size < MAX_FORMS; i++) {
      if ((nocase ? segs[i]!.toLowerCase() : segs[i]) !== name) continue;
      const rest = segs.slice(i + 1);
      out.add(rest.join('/'));
      out.add(rest.slice(1).join('/'));
      const view = rest[0] === '-' ? 1 : 0;
      // The first segment that may be the path's own: past the view and one ref segment, or in a
      // URL with no view, past one segment of ref.
      const from = REF_VIEWS.has(rest[view] ?? '') ? view + 2 : url ? 1 : -1;
      if (from >= 0) for (let k = from; k < rest.length && out.size < MAX_FORMS; k++) out.add(rest.slice(k).join('/'));
    }
  }
  out.delete('');
  return [...out];
}

/** A glob's segments up to its first wildcard: `config/prod` for `config/prod/**` or `config/prod/*.yml`. */
function staticBase(glob: string): string[] {
  const out: string[] = [];
  for (const seg of glob.split('/')) {
    if (!seg || WILDCARD.test(seg)) break;
    out.push(seg);
  }
  return out;
}

/**
 * Whether a path with a wildcard in it could name `base` or something under it, or a directory
 * above it: segment by segment, each of its segments matches `base`'s (`config/*` reaches
 * `config/prod`, `*` + `/prod/db.yml` reaches it too, `src/*.ts` does not reach `src/secrets`),
 * and a `**` reaches whatever is below the segments before it. A wildcard picomatch cannot read
 * reaches everything.
 */
function reachesBase(form: string, base: readonly string[], nocase: boolean): boolean {
  const segs = form.split('/');
  const n = Math.min(segs.length, base.length);
  if (!n) return false;
  for (let i = 0; i < n; i++) {
    const seg = segs[i]!;
    const b = base[i]!;
    if (seg.includes('**')) return true;
    if (!WILDCARD.test(seg)) {
      if (nocase ? seg.toLowerCase() !== b.toLowerCase() : seg !== b) return false;
      continue;
    }
    try {
      if (!picomatch.isMatch(b, seg, { dot: true, nocase, windows: false })) return false;
    } catch {
      return true;
    }
  }
  return true;
}

/** A glob as `globMatcher` reads it: from the repository's top, no leading `./` or `/`, no trailing `/`. */
const normalGlob = (g: string) => g.trim().replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * One matcher for a list of globs, read the way a `.gitignore` reads them, which is what a team
 * writing a deny list expects:
 * - a glob is read from the repository's top (a leading `./` or `/` is dropped);
 * - one with no `/` in it (`*.pem`, `.env*`, `secrets`) matches a name at any depth, and
 *   everything under a directory of that name;
 * - one naming a directory also matches what is in it (`config/prod` denies `config/prod/db.yml`);
 * - dotfiles match (`**` crosses `.github/`).
 *
 * picomatch's `basename` option is given only the globs without a `/`: on a glob with one it
 * matches nothing at all (`config/prod/**` then misses `config/prod/db.yml`), which would be a deny
 * list that silently denies nothing. `strictBrackets` makes an unclosed `[`, `{` or `(` throw
 * rather than match itself literally, for the same reason. Backslashes are never separators here:
 * every path is normalised to `/` first, and in a glob `\` is picomatch's escape.
 */
function globMatcher(globs: readonly string[], nocase: boolean): (path: string) => boolean {
  const options = { dot: true, nocase, windows: false, strictBrackets: true };
  const full: string[] = [];
  const names: string[] = [];
  for (const g of globs) {
    const glob = normalGlob(g);
    if (!glob) continue;
    if (glob.includes('/')) {
      full.push(glob);
      if (!glob.endsWith('**')) full.push(`${glob}/**`);
    } else {
      names.push(glob);
      full.push(`**/${glob}/**`);
    }
  }
  const matchers: ((path: string) => boolean)[] = [];
  if (full.length) matchers.push(picomatch(full, options));
  if (names.length) matchers.push(picomatch(names, { ...options, basename: true }));
  return (path) => matchers.some((m) => m(path));
}

/**
 * The paths that match a deny glob, normalised (`\` to `/`, no `./` or leading `<repo>/`), case-insensitive
 * where `opts.nocase` says (`caseInsensitivePaths`). A path matches when any form it could take in
 * the repository does (`candidatesOf`). A path with a wildcard in it (`grep -r x config/*`
 * names `config/*`) matches as written (`config/prod/**` covers `config/prod/*.yml`), and also
 * where it could reach the directory a glob with a `/` starts from (`reachesBase`): `config/*`
 * and `config/*` + `/db.yml` could both read `config/prod/db.yml`. Against a glob with no `/`
 * (`*.pem`), which names a file at any depth, it matches only as written. Throws for a glob
 * picomatch cannot compile, which `checkOutbound` turns into a refusal.
 */
export function deniedPaths(paths: readonly string[], deny: readonly string[], repoBasename?: string, opts: { nocase?: boolean } = {}): string[] {
  const nocase = !!opts.nocase;
  const matches = globMatcher(deny, nocase);
  const bases = deny.map(normalGlob).filter((g) => g.includes('/')).map(staticBase).filter((b) => b.length);
  const reaches = (form: string) => WILDCARD.test(form) && bases.some((b) => reachesBase(form, b, nocase));
  const out = new Set<string>();
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    const forms = candidatesOf(p, repoBasename, nocase);
    if (forms.some((f) => matches(f) || reaches(f))) out.add(forms[0] ?? p);
  }
  return [...out];
}

// ---------------------------------------------------------------- secrets

/** Bits per character, by the characters' own frequencies. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  const n = [...s].length;
  for (const c of counts.values()) bits -= (c / n) * Math.log2(c / n);
  return bits;
}

const classes = (s: string) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;

/**
 * A value assigned to a password-like name that is a secret rather than a pointer to one: not a
 * variable (`$DB_PASSWORD`, `DB_PASSWORD`, `process.env.DB_PASSWORD`), not a placeholder
 * (`<your key>`, `changeme`, `********`), and random enough (at least 10 characters, two kinds of
 * character, 3.3 bits a character). A low-entropy password gets through, and the docs say so.
 *
 * A constant's name has an underscore in it or no digit (`DB_PASSWORD`, `SECRET`). Capitals and
 * digits with no underscore are how a base32 secret is written (`GEZDGNBVGY3TQOJQ`, a TOTP seed),
 * so that is read as a value.
 */
function assignedSecret(value: string): boolean {
  if (value.length < 10) return false;
  if (/^[$%<{*]/.test(value)) return false;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+_?$/.test(value) || /^[A-Z]+$/.test(value)) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false;
  if (/your|example|placeholder|changeme|change_me|redacted|dummy|sample|x{4,}|\*{3,}|\.{3,}|todo|fixme|replace/i.test(value)) return false;
  return classes(value) >= 2 && entropy(value) >= 3.3;
}

/**
 * A connection string's password that is a secret rather than a stand-in for one: not a variable
 * (`${DB_PASS}`, `$(cat f)`, `$DB_PASS`, `$db_pass`), a template (`{password}`, `{{ .Pass }}`,
 * `<password>`, `%s`, `%(pw)s`) or a mask (`****`, `xxxx`). Anything else is taken as written:
 * `$uperS3cret` (mixed case and a digit are no variable's name), and a percent-encoded one
 * (`%23Xk3b...`), which is how a URL must write `#`, `@`, `/` and `%`.
 */
function urlPassword(p: string): boolean {
  if (!p) return false;
  if (/^\$\{[^}]*\}$|^\$\([^)]*\)$|^\$(?:[A-Z_][A-Z0-9_]*|[a-z_][a-z0-9_]*)$/.test(p)) return false;
  if (/^\{\{?[^}]*\}?\}$|^<[^>]*>$|^%(?:\([A-Za-z_]\w*\))?s$/.test(p)) return false;
  return !/^(?:\*+|x+|X+)$/.test(p);
}

/** A word of a secret's name in each case a name is written in: `password`, `Password`, `PASSWORD`. */
const cased = (w: string) => `(?:${w}|${w[0]!.toUpperCase()}${w.slice(1)}|${w.toUpperCase()})`;

/** Words joined as names join them: `api_key`, `api-key`, `api.key`, `apikey`, `apiKey`, `API_KEY`. */
const phrase = (...words: string[]) => words.map(cased).join('[_.-]?');

/**
 * The last word or words of a name a secret is assigned to. What comes before is any name at all
 * (`DB_PASSWORD`, `client_secret`, `jwtSecret`, `GITHUB_TOKEN`), since the pattern starts at a
 * word's own start rather than the name's.
 */
const SECRET_NAME = [
  phrase('password'),
  phrase('passwd'),
  phrase('pwd'),
  phrase('pass'),
  phrase('secret'),
  phrase('token'),
  phrase('api', 'key'),
  phrase('access', 'key'),
  phrase('secret', 'key'),
  phrase('private', 'key'),
].join('|');

/**
 * Where a word starts inside a name: after anything but a letter or digit (`DB_PASSWORD`,
 * `app.secret`), at a camel-case hump (`dbPassword`, `v2Token`), or where an acronym ends
 * (`DBPassword`). Case-sensitive, which is why the words are spelled in each case (`cased`):
 * under the `i` flag no pattern can tell a hump from any other pair of letters.
 */
const WORD_START = '(?:(?<![A-Za-z0-9])|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z]))';

/** `=`, `:`, Go's `:=` and the `=>` of PHP and Ruby. */
const ASSIGN = '(?::=|=>|[:=])';

/**
 * The known-secret patterns, in order. Each has a true positive and a near miss in the server's
 * tests. The two that are often false, a JWT and a generic assignment,
 * hold the packet for review rather than refuse it (`SeatPolicy.review.whenSecret`).
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'private_key', action: 'refuse', regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-\d+:/ },
  { name: 'aws_access_key', action: 'refuse', regex: /(?<![A-Z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Z0-9])/ },
  {
    // With an `aws` or `amazon` in the name, or named as AWS names it in its own output and SDKs
    // (`"SecretAccessKey": ...` from `aws iam create-access-key`, `secretAccessKey`).
    name: 'aws_secret',
    action: 'refuse',
    regex:
      /(?:(?:aws|amazon)[\w.-]{0,20}?(?:secret|private)[\w.-]{0,20}?|secret[_.-]?access[_.-]?key)["']?\s*(?::=|=>|[:=])\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/i,
  },
  { name: 'github_token', action: 'refuse', regex: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{60,255})(?![A-Za-z0-9_])/ },
  { name: 'gitlab_token', action: 'refuse', regex: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/ },
  { name: 'slack_token', action: 'refuse', regex: /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,250}/ },
  { name: 'slack_webhook', action: 'refuse', regex: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{20,}/ },
  {
    name: 'stripe_key',
    action: 'refuse',
    regex: /(?<![A-Za-z0-9_])(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,247}|whsec_[A-Za-z0-9]{24,})(?![A-Za-z0-9])/,
  },
  { name: 'anthropic_key', action: 'refuse', regex: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{32,}/ },
  {
    name: 'openai_key',
    action: 'refuse',
    regex: /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}|[A-Za-z0-9]{48})(?![A-Za-z0-9_-])/,
  },
  { name: 'google_api_key', action: 'refuse', regex: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  {
    // A service account's key file: its type, and a private key or key id in the same text.
    name: 'gcp_service_account',
    action: 'refuse',
    regex:
      /"type"\s*:\s*"service_account"[\s\S]{0,5000}?"private_key(?:_id)?"\s*:\s*"[^"]{16,}|"private_key(?:_id)?"\s*:\s*"[^"]{16,}"[\s\S]{0,5000}?"type"\s*:\s*"service_account"/,
  },
  { name: 'azure_storage', action: 'refuse', regex: /(?<![A-Za-z0-9])(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{40,}={0,2}/ },
  { name: 'npm_token', action: 'refuse', regex: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/ },
  { name: 'pypi_token', action: 'refuse', regex: /(?<![A-Za-z0-9_-])pypi-AgE[A-Za-z0-9_-]{50,}/ },
  { name: 'sendgrid_key', action: 'refuse', regex: /(?<![A-Za-z0-9_-])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/ },
  { name: 'jwt', action: 'hold', regex: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    // A password in the URL, never one that is a variable, a template or a mask (`urlPassword`).
    // It consumes nothing past the `@`, so the next URL in the same text is looked at too.
    name: 'conn_string_password',
    action: 'refuse',
    regex:
      /(?<![A-Za-z0-9])(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver)(?:\+[a-z0-9]+)?:\/\/[^\s:@/"'`]*:([^\s@/"'`]+)@(?=[^\s"'`@/])/i,
    accept: (m) => urlPassword(m[1] ?? ''),
  },
  {
    // A name ending in one of `SECRET_NAME`'s words, starting where a word does (`WORD_START`), so
    // no repeated group ahead of the word can backtrack. The value is taken whole (a lookahead and a
    // backreference, so it cannot be cut short to dodge the `(` of a call), and then
    // `assignedSecret` decides.
    name: 'generic_assignment',
    action: 'hold',
    regex: new RegExp(
      `${WORD_START}(?:${SECRET_NAME})(?![A-Za-z0-9])["']?\\s*${ASSIGN}\\s*["']?(?=([^\\s"'\`,;(){}[\\]<>]{8,200}))\\1(?!\\()`,
    ),
    accept: (m) => assignedSecret(m[1] ?? ''),
  },
];

const globalCopy = (re: RegExp) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);

function findings(text: string, patterns: readonly SecretPattern[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const p of patterns) {
    let hit = false;
    if (p.accept) {
      for (const m of text.matchAll(globalCopy(p.regex))) {
        if (p.accept(m)) {
          hit = true;
          break;
        }
      }
    } else hit = (p.regex.global || p.regex.sticky ? new RegExp(p.regex.source, p.regex.flags.replace(/[gy]/g, '')) : p.regex).test(text);
    if (hit && !out.some((f) => f.name === p.name)) out.push({ name: p.name, action: p.action });
  }
  return out;
}

/** A team's own patterns (`SeatPolicy.extraSecrets`), which refuse. Throws for one that does not compile. */
function extraPatterns(extra: readonly { name: string; regex: string }[] | undefined): SecretPattern[] {
  return (extra ?? []).map((e) => ({ name: e.name, regex: new RegExp(e.regex), action: 'refuse' as const }));
}

/**
 * The secret patterns a text matches, each named once, in `SECRET_PATTERNS` order and then the
 * team's own (`extra`, which refuse). Throws for an `extra` that is not a regular expression.
 */
export function scanSecrets(text: string, extra?: readonly { name: string; regex: string }[]): SecretFinding[] {
  if (typeof text !== 'string' || !text) return [];
  return findings(text, [...SECRET_PATTERNS, ...extraPatterns(extra)]);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: Uint8Array, url: boolean): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.ceil(((Math.min(3, bytes.length - i)) * 8) / 6);
    for (let k = 0; k < chars; k++) out += B64[(n >> (18 - 6 * k)) & 63];
  }
  return url ? out.replace(/\+/g, '-').replace(/\//g, '_') : out;
}

/** Shorter than this, a known secret is not looked for: it would match ordinary text. */
export const KNOWN_SECRET_MIN = 8;

/**
 * The forms a known secret could leave in: raw, URL-encoded, hex, and base64 and base64url at each
 * of the three byte offsets it could start at inside a longer encoded string (`Basic <base64 of
 * user:secret>`), each cut to the characters that depend on the secret alone. `ci` forms are
 * compared without regard to case (hex and percent-escapes are written either way).
 */
export function knownSecretForms(secret: string): { exact: string[]; ci: string[] } {
  if (typeof secret !== 'string' || secret.length < KNOWN_SECRET_MIN) return { exact: [], ci: [] };
  const bytes = new TextEncoder().encode(secret);
  const exact = new Set<string>([secret]);
  for (const url of [false, true]) {
    for (let k = 0; k < 3; k++) {
      const shifted = new Uint8Array(k + bytes.length);
      shifted.set(bytes, k);
      const enc = base64(shifted, url);
      const from = Math.ceil((8 * k) / 6);
      const to = Math.floor((8 * (k + bytes.length)) / 6);
      const inner = enc.slice(from, to);
      if (inner.length >= KNOWN_SECRET_MIN) exact.add(inner);
    }
  }
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { exact: [...exact], ci: [hex, encodeURIComponent(secret).toLowerCase()] };
}

/** Whether a text carries any of the known secrets in any of `knownSecretForms`. */
export function hasKnownSecret(text: string, known: readonly string[]): boolean {
  if (typeof text !== 'string' || !text || !known.length) return false;
  const lower = text.toLowerCase();
  return known.some((s) => {
    const f = knownSecretForms(s);
    return f.exact.some((x) => text.includes(x)) || f.ci.some((x) => lower.includes(x));
  });
}

// ---------------------------------------------------------------- the whole decision

/** A line shorter than this is never looked up in the deny-by-content index: `}` is in every file. */
export const DENIED_LINE_MIN = 16;

/** A line with whitespace runs collapsed to one space and trimmed: the first step of `deniedLineKeys`. */
export const normaliseLine = (line: string) => line.replace(/\s+/g, ' ').trim();

/**
 * What a viewer, a search, a diff, a quote or a list puts in front of a line an agent copies, one
 * layer each (they stack: `12: + x`). After `normaliseLine`, so a tab is a space.
 * - `git blame`: `^abc1234 (Ann 2026-09-01 12) `;
 * - `grep -n` over files: `config/prod/db.yml:12:` (or `-12-` for a context line);
 * - a line number: `12: `, `12 | `, `12 ` (from `cat -n`'s `  12\t`), `L12 `;
 * - a diff's `+` or `-`, a quote's `>`, a list's `*` or `•`.
 */
const LINE_PREFIXES: readonly RegExp[] = [
  /^\^?[0-9a-f]{7,40} \([^)]{0,200}\) ?/,
  /^[^\s:]{1,1024}?[:-]\d+[:-] ?/,
  /^L?\d+(?: ?[:|] ?| )/i,
  /^[-+>*•] ?/,
];

/** Around it, as a quote or a list puts them: backticks, quotation marks, a trailing `,` or `;`. */
const LINE_WRAPS: readonly RegExp[] = [/^(`{1,3})(.+?)\1[,;]?$/, /^(["'])(.+)\1[,;]?$/, /^()(.+?)[,;]$/];

/** A comment after the line: ` # from prod`, ` // x`, ` -- x`, ` /* x`. Cut at the first and at the last. */
const TRAILING_COMMENT = / (?:#|\/\/|--|\/\*)(?: |$)/g;

/**
 * The keys a line is looked up under in the deny-by-content index, and the keys the index keeps a
 * denied file's line under: the line after `normaliseLine`, and every form the layers an agent's
 * copy adds (`LINE_PREFIXES`, `LINE_WRAPS`, a trailing comment) leave when taken off, in any
 * order. Taking them off both sides means a copy matches whatever it was copied through, and a
 * denied line that itself starts `- ` or ends in a comment is found by what it says. Only keys of
 * `DENIED_LINE_MIN` characters or more, at most 32 a line; linear in the line's length.
 */
export function deniedLineKeys(line: string): string[] {
  if (typeof line !== 'string') return [];
  const start = normaliseLine(line);
  const seen = new Set<string>([start]);
  const queue = [start];
  const push = (s: string) => {
    const t = s.trim();
    if (t && !seen.has(t) && seen.size < 32) {
      seen.add(t);
      queue.push(t);
    }
  };
  while (queue.length) {
    const s = queue.shift()!;
    for (const re of LINE_PREFIXES) {
      const m = re.exec(s);
      if (m && m[0].length < s.length) push(s.slice(m[0].length));
    }
    for (const re of LINE_WRAPS) {
      const m = re.exec(s);
      if (m?.[2]) push(m[2]);
    }
    const cuts = [...s.matchAll(TRAILING_COMMENT)].map((m) => m.index ?? 0).filter((i) => i > 0);
    if (cuts.length) {
      push(s.slice(0, cuts[0]));
      push(s.slice(0, cuts[cuts.length - 1]));
    }
  }
  return [...seen].filter((k) => k.length >= DENIED_LINE_MIN);
}

/** The operations that put an agent's words in the room, other than a packet: the `messages` budget. */
const MESSAGE_OPS: ReadonlySet<string> = new Set(['say', 'claim', 'position', 'request_context', 'decline_context']);

const refuse = (rule: string, message: string): PolicyVerdict => ({ ok: false, action: 'refuse', rule, message });
const hold = (rule: string, message: string): PolicyVerdict => ({ ok: false, action: 'hold', rule, message });

/** The sentences an agent is told. Fixed: none names a glob, a path or what matched. */
export const POLICY_MESSAGES = {
  policy: "Refused: this seat's policy could not be read, so nothing leaves it until its team fixes the policy.",
  malformed: "Refused: this call could not be checked against your team's policy, so it was not sent.",
  deny: "Refused by your team's policy: this names a path the team keeps private. Do not share from it or cite it.",
  denyContent: "Refused by your team's policy: this contains lines from a file the team keeps private.",
  secret: (name: string) =>
    `Refused by your team's policy: this looks like it contains a secret (${name}). Take it out, or describe it without its value.`,
  held: 'Held for review by your team; carry on, it arrives if they approve.',
  budget: (what: string) => `Refused: this seat has used its team's budget of ${what} for this room. Finish with what you have.`,
} as const;

const finiteCount = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * A source longer than this is refused unread (`malformed`). Ten times what the relay accepts
 * (400 characters), so no source that could arrive is refused for it, and every call's paths are
 * read in bounded time: the runner's proxy checks a call before the relay's limits apply.
 */
export const SOURCE_MAX = 4000;

function readable(o: Outbound, used: Used): boolean {
  if (!o || typeof o !== 'object' || typeof o.op !== 'string' || !o.op) return false;
  if (!o.fields || typeof o.fields !== 'object') return false;
  if (Object.values(o.fields).some((v) => typeof v !== 'string')) return false;
  if (o.source != null && typeof o.source !== 'string') return false;
  if ((o.source?.length ?? 0) > SOURCE_MAX || (o.fields.source?.length ?? 0) > SOURCE_MAX) return false;
  if (o.kind != null && typeof o.kind !== 'string') return false;
  if (!used || !finiteCount(used.messages) || !finiteCount(used.packets) || !finiteCount(used.minutes)) return false;
  return used.spendUsd === undefined || finiteCount(used.spendUsd);
}

/**
 * The whole decision for one call, first match wins: deny, content, secrets, review, budget.
 *
 * - **Deny:** a path the call's source names (`pathsNamedIn`) that matches `deny` refuses (`deny`).
 * - **Content:** a line of any field one of whose keys (`deniedLineKeys`) the runner's index
 *   holds refuses (`deny:content`).
 * - **Secrets:** a known secret in any form refuses (`secret:known`), always. With `secretScan`,
 *   a `SECRET_PATTERNS` match refuses, or for the two that hold, holds a packet for review
 *   (`review.whenSecret: 'refuse'` refuses those too). The team's `extraSecrets` refuse, and apply
 *   even with `secretScan` off, since the team named them. Only a packet can be held, so a hold in
 *   any other call refuses. The rule is `secret:<name>`.
 * - **Review:** a packet whose source names a `review.paths` path, or whose kind is in
 *   `review.kinds`, is held (`review:path`, `review:kind`).
 * - **Budget:** a packet past `packets`, a message (say, claim, position, request or decline) past
 *   `messages`, anything past `minutes`, or past `spendUsd` where the runner can count it
 *   (`budget:<which>`). `finish` is never refused for budget, so a seat can always close. A spend
 *   the runner cannot count (`used.spendUsd` absent) counts as nothing.
 *
 * A policy that does not parse refuses everything (`policy`), and so does a call or a count this
 * cannot read, or whose source is over `SOURCE_MAX` (`malformed`), or any check that throws.
 */
export function checkOutbound(o: Outbound, p: SeatPolicy, used: Used, runner?: RunnerContext): PolicyVerdict {
  const parsed = SeatPolicy.safeParse(p);
  if (!parsed.success) return refuse('policy', POLICY_MESSAGES.policy);
  const policy = parsed.data;
  if (!readable(o, used)) return refuse('malformed', POLICY_MESSAGES.malformed);
  try {
    const nocase = !!runner?.nocase;
    const texts = [...Object.values(o.fields), ...(o.source ? [o.source] : [])];
    const sources = [o.source, o.fields.source].filter((s): s is string => typeof s === 'string' && !!s);
    const named = [...new Set(sources.flatMap(pathsNamedIn))];
    const isPacket = o.op === 'share_context';

    if (deniedPaths(named, policy.deny, runner?.repo, { nocase }).length) return refuse('deny', POLICY_MESSAGES.deny);

    const index = runner?.deniedLines;
    if (index)
      for (const t of texts)
        for (const line of t.split(LINE_BREAK))
          if (deniedLineKeys(line).some((k) => index.has(k))) return refuse('deny:content', POLICY_MESSAGES.denyContent);

    const known = (runner?.knownSecrets ?? []).filter((s) => typeof s === 'string');
    if (known.length && texts.some((t) => hasKnownSecret(t, known))) return refuse('secret:known', POLICY_MESSAGES.secret('a token this runner holds'));
    const patterns = [...(policy.secretScan ? SECRET_PATTERNS : []), ...extraPatterns(policy.extraSecrets)];
    const found = texts.flatMap((t) => findings(t, patterns));
    const hard = found.find((f) => f.action === 'refuse');
    if (hard) return refuse(`secret:${hard.name}`, POLICY_MESSAGES.secret(hard.name));
    const soft = found[0];
    if (soft) {
      if (!isPacket || policy.review.whenSecret === 'refuse') return refuse(`secret:${soft.name}`, POLICY_MESSAGES.secret(soft.name));
      return hold(`secret:${soft.name}`, POLICY_MESSAGES.held);
    }

    if (isPacket) {
      if (deniedPaths(named, policy.review.paths, runner?.repo, { nocase }).length) return hold('review:path', POLICY_MESSAGES.held);
      if (o.kind && (policy.review.kinds as readonly string[]).includes(o.kind)) return hold('review:kind', POLICY_MESSAGES.held);
    }

    if (o.op !== 'finish') {
      const b = policy.budget;
      if (isPacket && used.packets >= b.packets) return refuse('budget:packets', POLICY_MESSAGES.budget('packets'));
      if (MESSAGE_OPS.has(o.op) && used.messages >= b.messages) return refuse('budget:messages', POLICY_MESSAGES.budget('messages'));
      if (used.minutes >= b.minutes) return refuse('budget:minutes', POLICY_MESSAGES.budget('minutes'));
      if (b.spendUsd !== undefined && (used.spendUsd ?? 0) >= b.spendUsd) return refuse('budget:spend', POLICY_MESSAGES.budget('spend'));
    }
    return { ok: true };
  } catch {
    return refuse('policy', POLICY_MESSAGES.policy);
  }
}
