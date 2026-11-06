/**
 * Per-CLI adapters for hosted participants. Every adapter follows the same
 * shape: build the argv for a first turn or a resumed turn, and parse the
 * CLI's stdout lines into a small set of runner events.
 *
 * All four CLIs below were probed on this machine on 2026-09-11.
 */
import { accessSync, chmodSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HostedRunner } from '@parley/shared';

export interface TurnSpec {
  prompt: string;
  cwd: string;
  mcpName: string;
  mcpUrl: string;
  /**
   * A file holding the MCP configuration (`writeMcpConfigFile`), for a CLI that can read one. The
   * Claude adapter then passes `--mcp-config <file>` instead of the configuration inline, so the
   * endpoint (a loopback URL with the job's nonce, runner/proxy.ts) is in a 0600 file rather than
   * in an argument any local user can list.
   */
  mcpConfigFile?: string;
  model?: string;
  systemNote: string;
  resumeId: string | null;
  extraArgs?: string[];
}

/** Claude Code's MCP configuration for one server: what `--mcp-config` takes, inline or as a file. */
export const claudeMcpConfig = (mcpName: string, mcpUrl: string) => ({ mcpServers: { [mcpName]: { type: 'http', url: mcpUrl, timeout: 600000 } } });

/**
 * Write the MCP configuration a seat's CLI reads to `file`, readable by its owner only. POSIX
 * honours the mode; Windows ignores it, and there the job directory's own ACL (the user's
 * profile) is what keeps other users out.
 */
export function writeMcpConfigFile(file: string, mcpName: string, mcpUrl: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(claudeMcpConfig(mcpName, mcpUrl), null, 2)}\n`, { mode: 0o600 });
  // A file that already existed keeps its mode through writeFileSync.
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  return file;
}

/**
 * The same adapter, with every turn reading its MCP configuration from `file`. Only an adapter
 * that reads `mcpConfigFile` (Claude Code's) changes; the others take the URL as they always did.
 */
export const withMcpConfigFile = (adapter: Adapter, file: string): Adapter => ({ ...adapter, args: (s) => adapter.args({ ...s, mcpConfigFile: file }) });

export interface ParsedLine {
  kind: 'session' | 'text' | 'tool' | 'result' | 'error' | 'other';
  sessionId?: string;
  text?: string;
  toolName?: string;
  isError?: boolean;
  /** On a `result`: what the turn cost, as far as the CLI says (Claude Code: dollars and tokens; Codex: tokens). */
  usage?: TurnUsage;
}

/** One turn's cost as its CLI reported it. A field the CLI does not report is absent, never 0. */
export interface TurnUsage {
  usd?: number;
  tokensIn?: number;
  tokensOut?: number;
}

/** A count a CLI printed, if it is one: finite, not negative, and (for tokens) a safe whole number. */
const dollars = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const tokens = (...vs: unknown[]): number | undefined => {
  let n: number | undefined;
  for (const v of vs) if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) n = (n ?? 0) + v;
  return n !== undefined && Number.isSafeInteger(n) ? n : undefined;
};
const usageOf = (u: TurnUsage): TurnUsage | undefined => {
  const out: TurnUsage = {};
  if (u.usd !== undefined) out.usd = u.usd;
  if (u.tokensIn !== undefined) out.tokensIn = u.tokensIn;
  if (u.tokensOut !== undefined) out.tokensOut = u.tokensOut;
  return Object.keys(out).length ? out : undefined;
};

/** The most a job's cost can be reported as (`JobUpdateInput.cost.usd`): a larger sum is sent as this, never refused with the job's state. */
export const JOB_USD_MAX = 10_000;

/**
 * A job's cost, summed over its turns' `result` lines. `report()` is what `JobUpdateInput.cost`
 * takes, or undefined when no turn reported anything, so a job whose CLI says nothing stays
 * uncosted rather than costing 0.
 */
export class UsageTotals {
  private usd: number | undefined;
  private tokensIn: number | undefined;
  private tokensOut: number | undefined;
  add(u: TurnUsage | undefined): void {
    if (!u) return;
    if (u.usd !== undefined) this.usd = (this.usd ?? 0) + u.usd;
    if (u.tokensIn !== undefined) this.tokensIn = (this.tokensIn ?? 0) + u.tokensIn;
    if (u.tokensOut !== undefined) this.tokensOut = (this.tokensOut ?? 0) + u.tokensOut;
  }
  report(): TurnUsage | undefined {
    const capInt = (n: number | undefined) => (n === undefined ? undefined : Math.min(n, Number.MAX_SAFE_INTEGER));
    return usageOf({
      usd: this.usd === undefined ? undefined : Math.min(Math.round(this.usd * 1e6) / 1e6, JOB_USD_MAX),
      tokensIn: capInt(this.tokensIn),
      tokensOut: capInt(this.tokensOut),
    });
  }
}

/** The adapter, with every `result` line's usage handed to `onUsage` as it is parsed. Nothing else changes. */
export const withUsage = (adapter: Adapter, onUsage: (u: TurnUsage) => void): Adapter => ({
  ...adapter,
  parse: (line) => {
    const p = adapter.parse(line);
    if (p.kind === 'result' && p.usage) onUsage(p.usage);
    return p;
  },
});

export interface Adapter {
  id: HostedRunner;
  bin: string; // executable name
  label: string;
  provider: string;
  /** Commands to run before the first turn (e.g. register the MCP server in a project-scoped config). */
  prepare?(spec: TurnSpec): Array<{ bin: string; args: string[]; cwd?: string }>;
  cleanup?(spec: TurnSpec): Array<{ bin: string; args: string[]; cwd?: string }>;
  args(spec: TurnSpec): string[];
  env?(spec: TurnSpec): Record<string, string>;
  parse(line: string): ParsedLine;
  /**
   * Why a turn that did nothing failed, in a sentence the owner can act on, or null when the
   * CLI's output does not say. Given the turn's stderr (last 4 KB) plus any error its result
   * reported. See `diagnose` in hosted.ts for what applies to every CLI.
   */
  diagnose?(output: string, code: number | null): string | null;
  /**
   * Set when this CLI cannot be run as a hosted seat at all, whatever is installed: the reason,
   * in a sentence the owner reads on the create page. An attached seat of the same CLI is
   * unaffected, since Crossroom does not start that one.
   */
  hostedBlocked?: string;
}

/** A sign-in failure, said once per CLI with the command that fixes it. */
const signedOut = (re: RegExp, what: string) => (output: string) => (re.test(output) ? what : null);

const j = (o: unknown) => JSON.stringify(o);

/** Claude Code: `claude -p` with stream-json output. Session id from the init event; resume with --resume. */
export const claude: Adapter = {
  id: 'claude',
  bin: 'claude',
  label: 'Claude Code',
  provider: 'claude-code',
  args: (s) => [
    '-p',
    s.prompt,
    '--verbose',
    '--output-format',
    'stream-json',
    '--mcp-config',
    s.mcpConfigFile ?? j(claudeMcpConfig(s.mcpName, s.mcpUrl)),
    '--strict-mcp-config',
    // Restricted mode (Claude Code 2.1.27x) confines the file tools to the working directory,
    // ignores user, project and local settings, and drops every code-running tool not named in
    // `--tools`. Without it a probe on 2026-09-23 read a file beside the seat's directory, which
    // on one machine is the other seat's repository, and the seat could see Artifact, Workflow,
    // SendMessage and the rest of the owner's own tool set (allowedTools only decides what runs
    // without asking; it does not remove anything).
    '--restricted',
    '--tools',
    'Read,Grep,Glob,Bash',
    '--allowedTools',
    // The colon form is required: `Bash(git log*)` matches nothing, so those three git commands
    // were prompting (and, with prompts off, being denied) rather than being allowed.
    `Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(git diff:*),mcp__${s.mcpName}__*`,
    '--disallowedTools',
    // Colon form for prefixes. `Bash(rm*)` matched nothing; the allowlist above is what keeps
    // other commands out. `*--output*` is the one write the allowlist let through: git opens its
    // own `--output=<file>`, so `git log -1 --output=src/app.ts` overwrote a file in the seat's
    // repository while Claude Code refused every shell redirect (probe, 2026-09-23). A leading
    // wildcard matches the flag anywhere in the command; checked on 2.1.273, where it blocks that
    // write and still lets `git log -1 --oneline` run.
    'Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,Bash(rm:*),Bash(git push:*),Bash(*--output*)',
    '--permission-mode',
    'default',
    '--permission-prompts',
    'none',
    '--append-system-prompt',
    s.systemNote,
    ...(s.model ? ['--model', s.model] : []),
    ...(s.resumeId ? ['--resume', s.resumeId] : []),
    ...(s.extraArgs ?? []),
  ],
  env: () => ({ MCP_TOOL_TIMEOUT: '600000', CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0', MCP_TIMEOUT: '30000' }),
  parse: parseClaudeLike,
  diagnose: signedOut(
    /invalid api key|please run \/login|not logged in|authentication_error/i,
    'Claude Code is not logged in on this machine. Run `claude` and log in, then restart the seat.',
  ),
};

/** Grok CLI (xAI): same stream format family as Claude Code. Project-scoped MCP config is ignored in
 * untrusted folders ("re-run with --trust", but the CLI has no such flag), so we register a uniquely
 * named user-scoped server and remove it on stop. */
export const grok: Adapter = {
  id: 'grok',
  bin: 'grok',
  label: 'Grok CLI',
  provider: 'grok-cli',
  prepare: (s) => [{ bin: 'grok', args: ['mcp', 'add', '--scope', 'user', '--transport', 'http', s.mcpName, s.mcpUrl] }],
  cleanup: (s) => [{ bin: 'grok', args: ['mcp', 'remove', '--scope', 'user', s.mcpName] }],
  args: (s) => [
    '-p',
    s.prompt,
    '--output-format',
    'streaming-messages-json',
    // Keep this list to independent tools: disallowing part of a tool family (e.g. scheduler_*) makes
    // Grok fail session init with "Requirements unsatisfied" (observed 2026-09-11).
    '--disallowed-tools',
    'run_terminal_command,search_replace,write,image_gen,image_edit,image_to_video,reference_to_video',
    '--no-subagents',
    '--max-turns',
    '60',
    '--append-system-prompt',
    s.systemNote,
    ...(s.model ? ['--model', s.model] : []),
    ...(s.resumeId ? ['-r', s.resumeId] : []),
    ...(s.extraArgs ?? []),
  ],
  parse: parseClaudeLike,
  // Grok's sign-in lasts about six hours, and a refresh can fail for good (seen 2026-09-23), so
  // this is the failure a hosted Grok seat is most likely to meet. It used to surface only as
  // "agent produced nothing for several turns", three turns later.
  diagnose: signedOut(
    /not signed in|not logged in|grok login|authentication (failed|required)|refresh token/i,
    'Grok CLI is not signed in (its sign-in lasts about 6 hours). Run `grok login` on this machine, then restart the seat.',
  ),
};

/** Antigravity CLI (Google, Gemini 3.x): --print with json output; conversation_id for resume via --conversation. */
export const agy: Adapter = {
  id: 'agy',
  bin: 'agy',
  label: 'Antigravity (Gemini)',
  provider: 'antigravity-cli',
  prepare: (s) => [{ bin: 'agy', args: ['mcp', 'add', s.mcpName, s.mcpUrl] }],
  cleanup: (s) => [{ bin: 'agy', args: ['mcp', 'remove', s.mcpName] }],
  args: (s) => [
    '--print',
    `${s.systemNote}\n\n${s.prompt}`,
    '--output-format',
    'stream-json',
    // Plan mode plus the terminal sandbox instead of a blanket permission skip. Antigravity has
    // no allow/deny tool lists, so this is the only mechanism it offers; without it the one
    // thing stopping a hosted Gemini editing the repo it is reading is a sentence in a prompt.
    '--mode',
    'plan',
    '--sandbox',
    '--dangerously-skip-permissions',
    '--print-timeout',
    '30m',
    ...(s.model ? ['--model', s.model] : []),
    ...(s.resumeId ? ['--conversation', s.resumeId] : []),
    ...(s.extraArgs ?? []),
  ],
  // Antigravity replaced its own binary in the middle of a run on 2026-09-23 (1.2.7 to 1.2.8).
  // A seat's behaviour is only as known as the version it runs, so a hosted seat does not
  // update it underneath a room; the owner updates the CLI deliberately.
  env: () => ({ AGY_CLI_DISABLE_AUTO_UPDATE: '1' }),
  // Probed 2026-09-23 on agy 1.2.8 with the flags above: the seat wrote a file in its working
  // directory and one beside it, read outside it, fetched a web page, and hung on its first
  // terminal command. Headless `--mode plan` is only a prompt prefix and `--sandbox` restricts
  // the terminal, not the file tools. Antigravity's own controls (custom agents, hooks) live in
  // a `.agents/` folder inside the workspace, which for a hosted seat is the owner's repository,
  // and Crossroom never writes there. So it is not offered as a hosted seat until one of those
  // changes; the flags stay so a probe can re-check a new version.
  hostedBlocked:
    "Antigravity can't run as a hosted seat: on 2026-09-23 (agy 1.2.8) a hosted seat wrote files inside and outside its directory and fetched the web despite plan mode and its sandbox, and its terminal hung. Connect it as an attached seat instead: paste the seat link into agy.",
  diagnose: signedOut(
    /not signed in|not authenticated|sign in to|login required/i,
    'Antigravity is not signed in on this machine. Run `agy` and sign in, then restart the seat.',
  ),
  parse: (line) => {
    const o = tryJson(line);
    if (!o) return { kind: 'other' };
    // Probed stream-json shape: {"event":"init",...}, {"event":"step_update","step_update":{step_type,text_delta,...}}, {"event":"result","result":{conversation_id,status,response,error}}
    if (o.event === 'init') return { kind: 'session', sessionId: o.conversation_id };
    if (o.event === 'step_update' && o.step_update) {
      const su = o.step_update;
      if (su.step_type === 'agent_response') return su.state === 'DONE' ? { kind: 'other' } : { kind: 'text', text: su.text_delta ?? '' };
      if (su.step_type === 'user_input') return { kind: 'other' };
      if (su.state === 'ACTIVE') return { kind: 'tool', toolName: su.tool_name ?? su.name ?? su.step_type };
      return { kind: 'other' };
    }
    if (o.event === 'result' && o.result) {
      const r = o.result;
      return { kind: 'result', sessionId: r.conversation_id, text: String(r.response ?? ''), isError: r.status && r.status !== 'SUCCESS' };
    }
    return { kind: 'other' };
  },
};

/** Codex features a hosted seat runs without. Names as `codex features list` printed them for 0.154.0. */
export const CODEX_FEATURES_OFF = [
  'apps',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'in_app_local_automation',
  'memories',
  'multi_agent',
  'plugins',
  'remote_plugin',
  'skill_mcp_dependency_install',
] as const;

/** OpenAI Codex: `codex exec --json`; thread id from thread.started; resume with `codex exec resume <id>`. */
export const codex: Adapter = {
  id: 'codex',
  bin: 'codex',
  label: 'Codex CLI',
  provider: 'codex',
  args: (s) => {
    // Sandbox settings go in `cfg`, not in the first-turn flags, because every turn after the
    // first is a `resume` and `codex exec resume` takes no `-s`. Left on the flags, read-only
    // would apply to exactly one turn of the session and silently lapse thereafter.
    const cfg = [
      '-c',
      `mcp_servers.${s.mcpName}.url=${j(s.mcpUrl)}`,
      '-c',
      `mcp_servers.${s.mcpName}.tool_timeout_sec=300`,
      '-c',
      `mcp_servers.${s.mcpName}.startup_timeout_sec=30`,
      // Crossroom's own tools, and only those, run without asking. With the owner's config ignored,
      // Codex 0.154 asks before any MCP call, and `approval_policy="never"` turns every ask into a
      // refusal: the first probe's seat could not even `join` ("MCP tool call requires approval,
      // but approval policy is never").
      '-c',
      `mcp_servers.${s.mcpName}.default_tools_approval_mode="approve"`,
      '-c',
      'notify=[]',
      '-c',
      'sandbox_mode="read-only"',
      '-c',
      'approval_policy="never"',
      '-c',
      'web_search="disabled"',
      // Stable features that are on by default in 0.154 and act outside a read-only shell: a
      // browser, computer use, apps and plugins, image generation, subagents, memories that
      // outlive the room, hooks. Disabled one by one because `--ignore-user-config` only drops
      // the owner's settings, not Codex's defaults. Codex ignores a feature name it does not
      // know, so a later release that drops one of these does not break the seat.
      ...CODEX_FEATURES_OFF.flatMap((f) => ['-c', `features.${f}=false`]),
      // Windows: the unelevated read-only sandbox refused every command, reading a file
      // included ("blocked by policy"), which left a Codex seat unable to look at its own repo.
      // The owner's config had chosen the elevated one; with that config now ignored, say so here.
      ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : []),
    ];
    // `--ignore-user-config` on every turn, resumed ones included: without it a hosted seat loaded
    // the owner's ~/.codex/config.toml, with its plugins (browser, computer use), an MCP server
    // that runs outside the command sandbox, its model and its sandbox settings. Auth still
    // comes from CODEX_HOME.
    if (s.resumeId) return ['exec', 'resume', s.resumeId, '--json', '--ignore-user-config', ...cfg, `${s.prompt}`];
    return [
      'exec',
      '--json',
      '--ignore-user-config',
      '-C',
      s.cwd,
      '-s',
      'read-only',
      '--skip-git-repo-check',
      ...cfg,
      ...(s.model ? ['-m', s.model] : []),
      ...(s.extraArgs ?? []),
      `${s.systemNote}\n\n${s.prompt}`,
    ];
  },
  parse: (line) => {
    const o = tryJson(line);
    if (!o) return { kind: 'other' };
    if (o.type === 'thread.started') return { kind: 'session', sessionId: o.thread_id };
    // Reported as it starts, not only once it completes, so a command that never returns is
    // still the last thing the watchdog saw. Only the kind of item is named: the command line
    // is the seat's own business and the default log keeps shapes, not content.
    if (o.type === 'item.started' && o.item) {
      const it = o.item;
      if (it.type === 'command_execution') return { kind: 'tool', toolName: 'shell' };
      if (it.type === 'file_change') return { kind: 'tool', toolName: 'apply_patch' };
      if (it.type === 'mcp_tool_call') return { kind: 'tool', toolName: `${it.server}__${it.tool}` };
      if (it.type === 'web_search') return { kind: 'tool', toolName: 'web_search' };
      return { kind: 'other' };
    }
    if (o.type === 'item.completed' && o.item) {
      const it = o.item;
      if (it.type === 'agent_message') return { kind: 'text', text: it.text ?? '' };
      // A call Codex refused or that failed is an error, not activity: counted as a tool, a seat
      // whose every call failed looked busy to the runner.
      if (it.type === 'mcp_tool_call' && it.error)
        return { kind: 'error', text: `${it.server}__${it.tool} failed: ${it.error.message ?? 'error'}`, isError: true };
      // A call that completed was already reported when it started. Reporting it again doubled
      // every line of the runner log the owner reads, and every runner-state event in the room.
      if (it.type === 'error') return { kind: 'error', text: it.message };
    }
    // Codex reports tokens only; its `input_tokens` already counts the cached ones.
    if (o.type === 'turn.completed') {
      const usage = usageOf({ tokensIn: tokens(o.usage?.input_tokens), tokensOut: tokens(o.usage?.output_tokens) });
      return { kind: 'result', text: '', ...(usage ? { usage } : {}) };
    }
    if (o.type === 'turn.failed' || o.type === 'error') return { kind: 'error', text: o.error?.message ?? o.message ?? line, isError: true };
    return { kind: 'other' };
  },
  diagnose: signedOut(
    /not logged in|codex login|401 unauthorized|please log in/i,
    'Codex is not logged in on this machine. Run `codex login`, then restart the seat.',
  ),
};

export const ADAPTERS: Record<HostedRunner, Adapter> = { claude, codex, agy, grok };

function tryJson(line: string): any | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Claude Code / Grok stream-json: system.init, assistant (text/tool_use blocks), result. */
function parseClaudeLike(line: string): ParsedLine {
  const o = tryJson(line);
  if (!o) return { kind: 'other' };
  if (o.type === 'system' && o.subtype === 'init') return { kind: 'session', sessionId: o.session_id };
  if (o.type === 'assistant' && o.message?.content) {
    const blocks = o.message.content as any[];
    const tool = blocks.find((b) => b.type === 'tool_use');
    if (tool) return { kind: 'tool', toolName: tool.name };
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text) return { kind: 'text', text };
    return { kind: 'other' };
  }
  if (o.type === 'result') {
    // Claude Code: `total_cost_usd` for this invocation (one turn), and `usage`, whose input is
    // split into fresh, cache-written and cache-read tokens. Grok reports what it reports.
    const u = o.usage ?? {};
    const usage = usageOf({
      usd: dollars(o.total_cost_usd),
      tokensIn: tokens(u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens),
      tokensOut: tokens(u.output_tokens),
    });
    return { kind: 'result', sessionId: o.session_id, text: o.result ?? '', isError: !!o.is_error, ...(usage ? { usage } : {}) };
  }
  if (o.type === 'error') return { kind: 'error', text: o.message ?? line, isError: true };
  return { kind: 'other' };
}

/** Find an executable on PATH (Windows-aware). */
export function resolveBin(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}
