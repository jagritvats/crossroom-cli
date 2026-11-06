/**
 * What the ten operations look like to an agent: each one's title, MCP annotations, description and
 * argument schema, without what runs it. The server spreads these into the definitions it executes, so
 * the server serves them unchanged; the runner's end-to-end egress (runner/e2ee-egress.ts) lists them
 * to a local agent from here, so the `crossroom` command carries the words and none of the server.
 * Imports zod and nothing of the server.
 */
import { ContextKind, Stance } from '@parley/shared';
import { CLOSE_OUT_MAX } from '@parley/shared/text';
import { z } from 'zod';
import { WAIT_CEILING_S, WAIT_DEFAULT_S, WAIT_MAX_S } from './wait-max.js';

/**
 * What a tool does to the room, as MCP's tool annotations say it, listed beside its title on every
 * MCP surface (a connector directory reads them before it lists a server). Honest, not hopeful:
 * `wait` writes, since it moves the delivery cursor. Nothing here deletes what a room holds, and
 * nothing reaches past Crossroom, so `destructiveHint` and `openWorldHint` are false throughout.
 * They sit outside the tool-list budgets, which measure name, description and schema.
 */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  /** Only where a second identical call changes nothing. */
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

/** Reads the room and changes nothing in it. A keep-alive (the last-seen time `join` sets) is not a change. */
export const READS: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Adds to the room (a message, a packet, a position, a moved cursor) and removes nothing. */
export const WRITES: ToolHints = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/** Who the MCP server says it is, on every MCP surface (the server's and the runner's egress). */
export const SERVER_INFO = { name: 'crossroom', title: 'Crossroom', version: '0.1.0', websiteUrl: 'https://crossroom.dev' } as const;

export const TOOL_SURFACE = {
  join: {
  title: 'Join the Crossroom session',
  annotations: WRITES,
  description:
    'Join (or re-sync with) the session and receive your full briefing: shared brief, your private brief, rules, transcript so far, claims. Call this first.',
  schema: {
    name: z
      .string()
      .max(60)
      .optional()
      .describe('What to call you in the room, e.g. "Claude Code". Replaces the placeholder seat name.'),
    provider: z.string().max(60).optional().describe('Which agent runtime you are, e.g. "claude-code", "codex", "gemini-cli", "custom".'),
    model: z.string().max(80).optional().describe('Model name if you know it.'),
    offers: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'Tools you will run for the other seats on request: `name: what it does` items separated by ";", e.g. "git_history: git log and git show on this repository". Leave this out unless your user or private brief names offers (join again once it does); never invent them. "none" withdraws them. You run them yourself and answer with share_context.',
      ),
  },
  },
  status: {
  title: 'Session status',
  annotations: READS,
  description:
    'Current session status, participants, message count, claims and open context requests. Rarely needed: to receive activity use wait, not status.',
  schema: {},
  },
  say: {
  title: 'Say something',
  annotations: WRITES,
  description:
    'Post a message to the conversation. Everyone in the session (and the human owner) sees it. After saying something, call wait for the reply.',
  schema: {
    text: z.string().min(1).max(8000).describe('Your message. Natural language; keep it focused.'),
    reply_to: z.number().int().optional().describe('Message number you are replying to, if useful.'),
    to: z.string().optional().describe('With 3+ seats: who it is for ("C", "B,C"), or start text with @C. Everyone sees it.'),
    away: z.boolean().optional().describe('You are stepping away: say why and what brings you back. Any later call returns you.'),
  },
  },
  wait: {
  title: 'Wait for activity',
  annotations: WRITES,
  description: `Block until another participant or the owner does something, then return the new activity. Returns at once if something is already waiting. Default timeout ${WAIT_DEFAULT_S}s (max ${WAIT_MAX_S}s); if it returns nothing, call it again.`,
  schema: { timeout_seconds: z.number().int().min(1).max(WAIT_CEILING_S).optional() },
  },
  request_context: {
  title: 'Request specific context from another participant',
  annotations: WRITES,
  description:
    'Ask a seat for something concrete you need (a file excerpt, a log, a schema, a config value, a number). Be precise about what and why. It answers with share_context. To use a tool a seat offered, name it with tool= and say what to run it on with args=.',
  schema: {
    what: z
      .string()
      .min(3)
      .max(2000)
      .describe('Exactly what you need, e.g. "the JSON body of the failing POST /checkout request and the response status".'),
    why: z.string().max(1000).optional().describe('Why you need it (helps them pick the right thing).'),
    to: z
      .string()
      .optional()
      .describe(
        'Seat letter ("B") or name; optional with one other seat. "human" asks the session owner, only for what no agent in the room can have.',
      ),
    tool: z.string().max(40).optional().describe('A tool a seat offered (see Offers in your briefing). It runs it and answers with the output.'),
    args: z.string().max(500).optional().describe('What to run the tool on, as free text, e.g. "-5 -- src/checkout.ts". Only with tool.'),
  },
  },
  decline_context: {
  title: 'Decline a context request',
  annotations: WRITES,
  description:
    'Refuse a request you cannot or will not answer, with the reason (you lack it, it is out of scope, or it would expose what you should not share). Better than silence: the refusal and its reason go on the record, and the asker stops waiting.',
  schema: {
    request_id: z.string().describe('The request_id you are declining.'),
    reason: z.string().min(3).max(1000).describe('Why, in one sentence. The asker reads this.'),
  },
  },
  share_context: {
  title: 'Share a specific piece of context',
  annotations: WRITES,
  description:
    'Send a targeted context packet: a file excerpt, log lines, schema, command output, or a summary. Always cite the real source (path:lines, command, URL). Prefer small, exact packets over dumps. Shared packets get a label (X1, X2...) that can be cited as evidence.',
  schema: {
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(60_000).describe('The content itself (verbatim excerpt preferred).'),
    kind: ContextKind.optional().describe('Defaults to "text". Use "tool_output" when answering a tool request, with source= exactly what you ran.'),
    source: z.string().max(400).optional().describe('Provenance, e.g. "src/api/checkout.ts:40-72" or "git log -3" or a URL.'),
    in_reply_to: z.string().optional().describe('request_id this answers, if any.'),
    to: z
      .string()
      .optional()
      .describe(
        '"all" (default): everyone, the owner included. A seat letter ("B"), a name, or "other": only that seat and the owner.',
      ),
  },
  },
  claim: {
  title: 'Register a disputed claim',
  annotations: WRITES,
  description:
    'Put a specific, checkable proposition on the record with your stance. Only for a genuine disagreement that matters; many rooms need none. Returns a label (C1, C2...) every seat can reference.',
  schema: {
    text: z
      .string()
      .min(5)
      .max(1000)
      .describe('The proposition, phrased so it could be true or false, e.g. "customerId can be null in POST /checkout in production v1.4".'),
    stance: Stance.describe('Your current stance.'),
    reason: z.string().max(2000).optional(),
    evidence: z.array(z.string()).optional().describe('Context labels (X1, X2...) supporting your stance.'),
  },
  },
  position: {
  title: 'State or change your position on a claim',
  annotations: WRITES,
  description:
    'Record your stance on an existing claim (C1, C2...). Use it when you first take a side and again whenever evidence changes your mind; cite the context labels that changed it.',
  schema: {
    claim: z.string().describe('Claim label, e.g. "C1".'),
    stance: Stance,
    reason: z.string().max(2000).optional().describe('Why. If you changed your mind, say what evidence did it.'),
    evidence: z.array(z.string()).optional().describe('Context labels (X1, X2...) you rely on.'),
  },
  },
  finish: {
  title: 'Finish',
  annotations: WRITES,
  description:
    'Declare that you are done: a 2-5 sentence summary of what this room did, plus any decisions, actions (who does what) and open questions, items separated by ";". The room ends when every seat has finished or the owner ends it.',
  schema: {
    summary: z.string().min(10).max(4000),
    decisions: z.string().max(CLOSE_OUT_MAX).optional(),
    actions: z.string().max(CLOSE_OUT_MAX).optional().describe('e.g. "B: ship the fix; A: update the docs"'),
    open: z.string().max(CLOSE_OUT_MAX).optional(),
  },
  },
} as const;
