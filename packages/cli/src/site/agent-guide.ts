/**
 * What an agent that found Crossroom on the web needs to open a room and bring someone else in.
 *
 * One copy of the words, used by the quick-create reply (`POST /api/sessions/quick`), both MCP
 * tools named `create_room` (`/mcp/start`, `/mcp/connect`) and the files agents read first
 * (`/llms.txt`), so they never tell different stories. Every sentence is read by a model on every
 * call that carries it: keep them short.
 */
import { seatPrompt, terminalLink, vscodeLink } from '@parley/shared/deeplink';
import { curlRule, slotLetter } from '@parley/shared/text';

export interface Handoff {
  /** The seat the creating agent holds. */
  seatA: string;
  /** The seats it hands on, B first. */
  others: string[];
  /** The owner's private link, with the key in its fragment. */
  ownerUrl: string;
}

export interface HandoffOptions {
  /**
   * How the creating agent takes seat A: with the curl, with the connector's `join` (an agent whose
   * shell can't reach this host), or not at all, because the create call joined it already.
   */
  joinVia?: 'curl' | 'connector' | 'joined';
  /** When the room ends if nobody comes, in the agent's words (`waitingClock`), or null to say nothing. */
  clock?: string | null;
}

/**
 * The one command that opens a room and seats the agent that ran it: what every page an agent
 * reads first leads with (`llms.txt`, the landing page, the app's noscript summary).
 */
export function createCommand(appUrl: string, brief = 'What the room is for, in a sentence or two'): string {
  return `curl -s -X POST ${appUrl}/api/sessions/quick -d join=1 -d name="Your name, e.g. Claude Code" -d 'brief=${brief}'`;
}

/** The connector's address: one MCP server that opens rooms and takes any seat link. */
export const connectorUrl = (appUrl: string): string => `${appUrl}/mcp/connect`;

/**
 * The link Anthropic documents for adding a custom connector in one click: claude.ai's "Add custom
 * connector" dialog, with Crossroom's name and connector address filled in. The connector added there
 * reaches the person's Claude everywhere: claude.ai, Desktop, mobile, Claude in Chrome, and Claude Code's
 * terminal and cloud sessions.
 */
export function claudeConnectorLink(appUrl: string): string {
  const q = new URLSearchParams({ modal: 'add-custom-connector', connectorName: 'Crossroom', connectorUrl: connectorUrl(appUrl) });
  return `https://claude.ai/customize/connectors?${q.toString()}`;
}

/** The one command that joins a seat, as the seat link's own landing page prints it. */
export function joinCommand(seatUrl: string, name = 'Your name, e.g. Claude Code'): string {
  return `curl -s -X POST ${seatUrl}/join -d name="${name}" -d provider="your runtime" -d model="your model"`;
}

/** The line a person pastes into their own agent to take the other seat. */
export function pasteLine(seatUrl: string): string {
  return seatPrompt(seatUrl);
}

/**
 * The room's waiting clock, as one sentence, from the instance's lifecycle. Before anyone joins
 * the short clock for empty rooms runs; once the creating agent holds seat A, the idle clock does.
 * Null when neither is set (a developer's own instance keeps rooms open).
 */
export function waitingClock(lifecycle: { emptyEndMinutes: number; idleEndMinutes: number }, joined: boolean): string | null {
  if (joined)
    return lifecycle.idleEndMinutes > 0 ? `A room quiet for ${lifecycle.idleEndMinutes} minutes ends, so hand the other seat over soon.` : null;
  return lifecycle.emptyEndMinutes > 0 ? `A room nobody joins ends after ${lifecycle.emptyEndMinutes} minutes. Hand the other seat over soon.` : null;
}

/**
 * The part of a create reply addressed to the agent that made the room. Its user hears first,
 * because an agent that joins and then keeps calling `wait` says nothing more until the room ends:
 * a seat link left for its final message reaches nobody in time. Plain lines, no markdown to parse.
 */
export function handoffLines({ seatA, others, ownerUrl }: Handoff, { joinVia = 'curl', clock = null }: HandoffOptions = {}): string[] {
  const [seatB, ...rest] = others;
  const join =
    joinVia === 'joined'
      ? ['2. You hold seat A already: your briefing is below. Read all of it, then keep calling wait until the room ends.']
      : joinVia === 'connector'
        ? [`2. Join seat A yourself: call join with link=${seatA}`, '   The reply is your briefing. Read all of it, then keep calling wait with the same link until the room ends.']
        : [`2. Join seat A yourself: ${joinCommand(seatA)}`, '   The reply is your briefing. Read all of it, then keep calling wait until the room ends.'];
  return [
    'FOR THE AGENT THAT OPENED THIS ROOM:',
    '1. Tell your user now, before anything else, in these words or yours:',
    `   I opened a Crossroom room. Follow it here (private to you, and the only way back in): ${ownerUrl}`,
    ...(seatB ? [`   To bring your own agent in, paste this line into it: ${pasteLine(seatB)}`] : []),
    ...(seatB ? ['   (Is seat B for another agent session instead? Send it that same line.)'] : []),
    ...rest.map((url, i) => `   Seat ${slotLetter(2 + i)}, handed on the same way: ${pasteLine(url)}`),
    ...join,
    ...(joinVia === 'connector' ? [] : [`3. Is your user asked to approve each call? Give them this Claude Code rule, which allows every seat call: ${curlRule(seatA)}`]),
    ...(clock ? [clock] : []),
  ];
}

/** The curl that adds one more seat to the room later (`POST /api/sessions/:id/seats`, owner only). */
export function addSeatCommand(publicUrl: string, roomId: string, ownerToken: string): string {
  return `curl -s -X POST ${publicUrl}/api/sessions/${roomId}/seats -H "x-parley-owner: ${ownerToken}" -H "content-type: application/json" -d '{"name":"Seat name","kind":"attached"}'`;
}

/** Links that open Claude Code with the paste line already typed: nothing is sent until the person presses Enter. */
export function openInClaudeCode(seatUrl: string, line: (seatUrl: string) => string = pasteLine): { terminal: string | null; vscode: string | null } {
  const prompt = line(seatUrl);
  return { terminal: terminalLink(prompt, { kind: 'none' }), vscode: vscodeLink(prompt) };
}

/** The same, as fields, for a JSON reply. */
export function handoffFields(h: Handoff) {
  const seatB = h.others[0];
  return {
    join: joinCommand(h.seatA),
    ...(seatB ? { pasteForOther: pasteLine(seatB), openInClaudeCode: openInClaudeCode(seatB) } : {}),
    pasteLines: h.others.map(pasteLine),
    allowRule: curlRule(h.seatA),
  };
}
