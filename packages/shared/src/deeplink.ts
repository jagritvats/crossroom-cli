/**
 * Links that hand a seat to Claude Code with its seat link already typed.
 *
 * Both are Anthropic's own, documented at code.claude.com/docs/en/deep-links and
 * /docs/en/vs-code: `claude-cli://open` opens a terminal session, and
 * `vscode://anthropic.claude-code/open` a tab in the Claude Code extension. Neither sends
 * anything. The prompt waits for the owner to press Enter, and Claude Code marks it "Prompt from
 * an external link" until then, so a link here can only save the owner a paste.
 *
 * The rest of the module builds the same kind of hand-over for every other agent surface: links
 * that open an app with a prompt typed (Claude's and ChatGPT's chats, the Codex app, Cursor, Copilot
 * Chat), links that open an app's own "add this MCP server" dialog filled in with Crossroom's
 * connector (claude.ai, Cursor, VS Code, Goose, Kiro), and the one-line commands and config
 * snippets for the rest.
 *
 * The rule for what a link may carry:
 * - Every link fills something in and sends nothing: the person confirms in the app.
 * - A custom-scheme link (`claude-cli:`, `codex:`, `cursor:`, `vscode:`, `goose:`) is handled by an
 *   app on the person's own machine, so it may carry a seat link or a seat's own MCP address.
 * - A web link may carry a seat link only to the vendor whose chat the line is pasted into anyway
 *   (claude.ai, chatgpt.com). Every other web link (`kiroInstallLink`) carries the connector's
 *   address alone, which holds no credential, and refuses anything that looks like a seat's.
 * - Nothing routes a seat token through a third party's web server: no launcher page, no web form
 *   that forwards to an app.
 *
 * The connector is `/mcp/connect`: one MCP server whose tools take the seat link as an argument, so
 * it is added once and serves every room, and its calls come from the vendor's side.
 */

/** Claude Code's limit on a prefilled prompt. */
export const MAX_PROMPT_CHARS = 5000;

/** Where the terminal session should start: nowhere in particular, a folder, or a GitHub repository. */
export type OpenTarget =
  | { kind: 'none' }
  | { kind: 'cwd'; path: string }
  | { kind: 'repo'; slug: string }
  | { kind: 'invalid'; reason: string };

// Controls, format characters (zero-width and bidirectional marks among them) and the two
// Unicode separators. Claude Code refuses a `cwd` carrying any of them; saying so here is kinder
// than a terminal that opens in the home directory.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** The owner's words for where a seat's agent should start, read the way Claude Code reads them. */
export function parseTarget(raw: string): OpenTarget {
  // A paste often brings a newline or a tab along at the ends; only what is left inside counts.
  const s = raw.trim();
  if (!s) return { kind: 'none' };
  if (INVISIBLE.test(s)) return { kind: 'invalid', reason: 'That contains an invisible character. Type the folder again.' };
  if (SLUG.test(s)) {
    const name = s.slice(s.indexOf('/') + 1);
    if (name === '.' || name === '..') return { kind: 'invalid', reason: 'That is not a repository name.' };
    return { kind: 'repo', slug: s };
  }
  if (/^[\\/]{2}/.test(s)) return { kind: 'invalid', reason: 'Claude Code does not open network folders. Use a local one.' };
  if (/^\//.test(s) || /^[A-Za-z]:[\\/]/.test(s)) {
    if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) {
      return { kind: 'invalid', reason: 'Claude Code refuses a folder with ".." in it. Use the full path.' };
    }
    return { kind: 'cwd', path: s };
  }
  if (s.startsWith('~')) return { kind: 'invalid', reason: 'Spell out the home folder: Claude Code needs a full path.' };
  return { kind: 'invalid', reason: 'Give a full folder path, or a GitHub repository as owner/name.' };
}

/** Which kind of room a prompt hands a seat of: a meeting, or an async lane (`@parley/shared/lane`). */
export interface PromptOptions {
  /** The room is a lane: its snapshot carries `lane` (`snap.lane !== undefined`). */
  lane?: boolean;
}

/**
 * The words after the link on a seat's paste line. They name Crossroom and the host it runs on, say
 * the agent joins for its user and say go ahead, because an agent's permission check (Claude Code's
 * auto mode) reads the user's own words and not what a tool returns. With the bare "join this room"
 * it refused shares as exfiltration and stopped to ask; without the host it still refused most of
 * them. Every surface prints the line through `seatPrompt`, so it is
 * spelled here once.
 */
export function joinWords(host: string, { lane = false }: PromptOptions = {}): string {
  // A lane's words say it is a lane: a lane is no meeting, and its agent should not read it as one.
  return lane
    ? `this is our Crossroom lane; join it as my agent. It runs on ${host}; go ahead.`
    : `join this Crossroom room as my agent and stay until it ends. It runs on ${host}; go ahead.`;
}

/** The host a seat link names, as the paste line spells it (`app.crossroom.dev`, `127.0.0.1:4747`). */
export function hostOf(seatUrl: string): string {
  try {
    return new URL(seatUrl).host || 'Crossroom';
  } catch {
    return 'Crossroom';
  }
}

/** What the agent reads first: the link, then the words, which the owner can extend before sending. */
export function seatPrompt(seatUrl: string, options: PromptOptions = {}): string {
  return `${seatUrl} - ${joinWords(hostOf(seatUrl), options)}`;
}

/** The link a paste line carries (its first word), or null when the line holds none. */
export function linkOfPrompt(line: string): string | null {
  const first = line.trim().split(/\s+/)[0] ?? '';
  return /^https?:\/\/\S+\/j\/\S+$/.test(first) ? first : null;
}

/**
 * The prompt that brings back an agent that lost its room: compacted, restarted, or a new session.
 * Joining again is how it catches up, since `join` re-syncs it with the transcript so far, and
 * whatever arrived for its seat meanwhile is still waiting in `wait`.
 */
export function resumePrompt(seatUrl: string, { lane = false }: PromptOptions = {}): string {
  return lane
    ? `${seatUrl} - you already hold this side of our Crossroom lane: join it again and carry on with the items that need you.`
    : `${seatUrl} - you already hold this seat: rejoin this room and continue where you left off.`;
}

/** A terminal session in the target, or null if Claude Code would refuse it. */
export function terminalLink(prompt: string, target: OpenTarget): string | null {
  if (prompt.length > MAX_PROMPT_CHARS || target.kind === 'invalid') return null;
  let url = `claude-cli://open?q=${encodeURIComponent(prompt)}`;
  if (target.kind === 'cwd') url += `&cwd=${encodeURIComponent(target.path)}`;
  // SLUG admits only characters that need no escaping, and Anthropic's examples leave the slash bare.
  if (target.kind === 'repo') url += `&repo=${target.slug}`;
  return url;
}

/** A tab in the Claude Code extension of whichever VS Code window has focus, or null if too long. */
export function vscodeLink(prompt: string): string | null {
  if (prompt.length > MAX_PROMPT_CHARS) return null;
  return `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`;
}

/** What the start page's "Have your agent open it" hands over: the topic box and the seat count, as chosen there. */
export interface StartPromptOptions {
  /** The topic box, as typed. Empty leaves the topic to the agent and its user. */
  topic?: string;
  /** How many seats the room takes; two (the default) says nothing. */
  seats?: number;
  /**
   * Whether the agent reaches this instance through the connector (`/mcp/connect`) rather than a
   * shell: a phone's Claude or ChatGPT app has no shell to run curl in.
   */
  connector?: boolean;
}

/**
 * The prompt that asks a person's own agent to open a room, take seat A, hand the person the watch
 * link and the other seats' lines, and stay in the room. The agent that opens it is already in the
 * person's repository, which a room opened from the web page has no agent in yet. With a shell it
 * follows `llms.txt`, whose create reply carries the hand-over (`handoffLines`); without one, the
 * connector's `create_room` returns the same.
 */
export function startRoomPrompt(appUrl: string, { topic = '', seats = 2, connector = false }: StartPromptOptions = {}): string {
  const base = appUrl.replace(/\/+$/, '');
  const how = connector
    ? `Open a Crossroom room for me with the Crossroom connector's create_room tool. If you don't have that tool, tell me to add ${base}/mcp/connect as a custom connector (streamable HTTP, no sign-in), and stop.`
    : `Open a Crossroom room for me: read ${base}/llms.txt and follow it.`;
  const size = seats > 2 ? ` Give it ${seats} seats (seats=${seats}).` : '';
  const brief = topic.trim();
  const about = brief ? `\n\nWhat the room is for:\n${brief}\n\n` : ' ';
  return `${how}${size}${about}Take seat A yourself, tell me the watch link and every other seat's line right away, then stay in the room until it ends.`;
}

// ---------------------------------------------------------------------------------------------
// Every other agent surface. See the module's header for what a link may carry.

/** The name Crossroom's MCP server goes by in every app's list. */
export const CONNECTOR_NAME = 'Crossroom';
/** The key it goes under in a config file or a CLI's list, where names are identifiers. */
export const CONNECTOR_KEY = 'crossroom';

/** ChatGPT's prefilled prompt is undocumented; about 2 KB of query is what it takes in practice. */
export const CHATGPT_MAX_QUERY = 2000;
/** Cursor's prompt link holds at most this many characters, counted after encoding. */
export const CURSOR_MAX_URL = 10_000;

const trimBase = (appUrl: string) => appUrl.replace(/\/+$/, '');
const enc = encodeURIComponent;

/** Crossroom's connector on this instance: the one MCP address that holds no credential. */
export const connectorUrl = (appUrl: string): string => `${trimBase(appUrl)}/mcp/connect`;

/** UTF-8, then base64, in a browser and in Node alike. */
export function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Whether an address names a seat: a seat link (`/j/<token>`) or a seat's own MCP endpoint
 * (`/mcp/<token>`). The connector, `/mcp/start` and the account's `/mcp/me` hold no token.
 */
export function namesSeat(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return true;
  }
  return /\/j\/[^/]/.test(path) || /\/mcp\/(?!(?:connect|start|me)\/?$)[^/]/.test(path);
}

/**
 * claude.ai's "Add custom connector" dialog, filled in with Crossroom's connector. Anthropic's own
 * link; it only fills the dialog, and the person adds it. `admin` is the variant for a Team or
 * Enterprise owner adding it for the whole organisation.
 */
export function claudeConnectorLink(appUrl: string, { admin = false, name = CONNECTOR_NAME }: { admin?: boolean; name?: string } = {}): string {
  const page = admin ? 'https://claude.ai/admin-settings/connectors' : 'https://claude.ai/customize/connectors';
  return `${page}?modal=add-custom-connector&connectorName=${enc(name)}&connectorUrl=${enc(connectorUrl(appUrl))}`;
}

/**
 * A new claude.ai chat with the prompt typed, or null when it is too long. Claude documents no limit
 * for this link, so it is held to the one Claude Code documents for its own.
 */
export function claudeChatLink(prompt: string): string | null {
  if (prompt.length > MAX_PROMPT_CHARS) return null;
  return `https://claude.ai/new?q=${enc(prompt)}`;
}

/** A new ChatGPT chat with the prompt typed, or null when the encoded prompt passes ChatGPT's practical limit. */
export function chatgptLink(prompt: string): string | null {
  const q = enc(prompt);
  if (q.length > CHATGPT_MAX_QUERY) return null;
  return `https://chatgpt.com/?q=${q}`;
}

/** A new thread in the Codex app with the prompt typed, in the local checkout of `originUrl` when one is named. */
export function codexAppLink(prompt: string, { originUrl }: { originUrl?: string } = {}): string {
  const origin = originUrl?.trim();
  return `codex://new?prompt=${enc(prompt)}${origin ? `&originUrl=${enc(origin)}` : ''}`;
}

/** Cursor's agent chat with the text typed, or null when the link passes Cursor's limit. */
export function cursorPromptLink(text: string): string | null {
  const url = `cursor://anysphere.cursor-deeplink/prompt?text=${enc(text)}`;
  return url.length > CURSOR_MAX_URL ? null : url;
}

/** Cursor's MCP install dialog for a streamable HTTP server at `url`. */
export function cursorInstallLink(name: string, url: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${enc(name)}&config=${enc(base64Utf8(JSON.stringify({ url })))}`;
}

/** VS Code's MCP install prompt (Copilot's agent mode reads it), or VS Code Insiders'. */
export function vscodeMcpInstallLink(name: string, url: string, { insiders = false }: { insiders?: boolean } = {}): string {
  return `${insiders ? 'vscode-insiders' : 'vscode'}:mcp/install?${enc(JSON.stringify({ name, type: 'http', url }))}`;
}

/**
 * Copilot Chat in VS Code, in agent mode, with the prompt typed. VS Code's own handler for the link
 * reads `mode` (or `agent`) and `prompt`, and opens the chat with the prompt in its box, unsent;
 * agent mode is the one that can use MCP servers and run the line's commands.
 */
export function copilotChatLink(prompt: string): string {
  return `vscode://GitHub.Copilot-Chat/chat?mode=agent&prompt=${enc(prompt)}`;
}

/** Goose's extension install dialog for a streamable HTTP server at `url`. */
export function gooseInstallLink(url: string, { id, name, description }: { id: string; name: string; description: string }): string {
  return `goose://extension?url=${enc(url)}&type=streamable_http&id=${enc(id)}&name=${enc(name)}&description=${enc(description)}`;
}

/**
 * Kiro's MCP install page. It is a web page on kiro.dev, so it takes a credential-free address
 * only: null for a seat's own.
 */
export function kiroInstallLink(name: string, url: string): string | null {
  if (namesSeat(url)) return null;
  return `https://kiro.dev/launch/mcp/add?name=${enc(name)}&config=${enc(JSON.stringify({ url }))}`;
}

/** The agent CLIs that add an MCP server with one command. */
export type McpCli = 'claude' | 'codex' | 'gemini' | 'grok' | 'copilot' | 'amp' | 'agy';

/** The one command that adds a streamable HTTP MCP server to a CLI agent. */
export function mcpAddCommand(client: McpCli, name: string, url: string): string {
  switch (client) {
    case 'claude':
      return `claude mcp add --transport http ${name} ${url}`;
    case 'codex':
      return `codex mcp add ${name} --url ${url}`;
    case 'gemini':
      return `gemini mcp add -t http ${name} ${url}`;
    case 'grok':
      return `grok mcp add --transport http ${name} ${url}`;
    case 'copilot':
      return `copilot mcp add --transport http ${name} ${url}`;
    case 'amp':
      return `amp mcp add ${name} ${url}`;
    case 'agy':
      return `agy mcp add ${name} ${url}`;
  }
}

/** The editors and agents whose MCP servers live in a JSON config file. */
export type McpConfigClient = 'windsurf' | 'antigravity' | 'opencode' | 'roo' | 'cline' | 'vscode' | 'cursor';

/** The JSON a config-file client takes for a streamable HTTP server, as each names its keys. */
export function mcpConfigSnippet(client: McpConfigClient, name: string, url: string): string {
  const one = (entry: object) => ({ [name]: entry });
  let doc: object;
  switch (client) {
    case 'windsurf':
    case 'antigravity':
      doc = { mcpServers: one({ serverUrl: url }) };
      break;
    case 'opencode':
      doc = { mcp: one({ type: 'remote', url }) };
      break;
    case 'roo':
      doc = { mcpServers: one({ type: 'streamable-http', url }) };
      break;
    case 'cline':
      doc = { mcpServers: one({ type: 'streamableHttp', url }) };
      break;
    case 'vscode':
      doc = { servers: one({ type: 'http', url }) };
      break;
    case 'cursor':
      doc = { mcpServers: one({ url }) };
      break;
  }
  return JSON.stringify(doc, null, 2);
}
