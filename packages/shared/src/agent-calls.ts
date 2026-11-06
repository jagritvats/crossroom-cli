/**
 * An account's own agents, called into a side room by a seat of a room the account holds
 * (`call_agent`, a registered operation of the server, not one of the protocol's ten).
 *
 * What the operation answers, what its events carry, the limits, and the recap a side room sends
 * back. No zod, so the web app imports it as it is.
 */
import { oneLine } from './text.js';

/** Side rooms one room may have open at once. */
export const AGENT_CALLS_LIVE_MAX = 2;
/** Calls one room may make in an hour, asked, opened, declined or expired alike. */
export const AGENT_CALLS_PER_HOUR = 6;
/**
 * Calls an account makes itself in an hour (`POST /api/account/agents/call`, `crossroom call`), from
 * outside any room, across all its agents. Each seat's own limits apply as well.
 */
export const DIRECT_CALLS_PER_HOUR = 30;
/** How long a call that asks the owner first waits for an answer. */
export const AGENT_CALL_EXPIRE_MINUTES = 30;
/** The longest recap a side room sends back, as `--recall` brings an earlier room. */
export const SIDE_ROOM_RECAP_MAX = 1500;
/** The longest `why` and `brief` a call takes. */
export const AGENT_CALL_WHY_MAX = 1000;
export const AGENT_CALL_BRIEF_MAX = 4000;

/** A call's state: waiting for the owner, declined, opened, its side room ended, or never answered. */
export type AgentCallState = 'pending' | 'declined' | 'opened' | 'ended' | 'expired';

/** One of the account's agents as a room's seat sees it. */
export interface CallableAgent {
  /** The seat's label, which `agent=` names. */
  name: string;
  /** What its team says it is for, as the team wrote it. */
  description: string;
  /** `ask`: the owner approves each call first; `join`: it joins when asked. */
  mode: 'ask' | 'join';
  state: 'live' | 'paused' | 'offline';
}

/** What `call_agent` answers, by what it was asked to do. */
export type CallAgentData =
  | { kind: 'roster'; agents: CallableAgent[] }
  /** Asked; the owner decides. */
  | { kind: 'asked'; callId: string; agent: string; expiresInMinutes: number }
  /** Opened at once (the agent joins when asked); the link is one more call away. */
  | { kind: 'opened'; callId: string; agent: string }
  /** The asker's seat link to the side room, handed over this once. */
  | { kind: 'link'; callId: string; agent: string; seatUrl: string }
  /** Where a call stands, when there is no link to hand over. `given`: the link was handed over already. */
  | { kind: 'state'; callId: string; agent: string; state: AgentCallState | 'given' };

/** The owner's view of a call, as the answer route returns it. */
export interface AgentCallView {
  id: string;
  state: AgentCallState;
  seat: string;
  sideRoomId: string | null;
}

/**
 * Lines of a digest that say nothing about what a room found, left out of a recap to keep its
 * budget for what it did: the signature, the footer, the rule above it, the link to the room page.
 * The same as `--recall` leaves out (commands/memory-notes.ts).
 */
const NOT_RECAPPED = ['<!--', '---', 'Signed by ', '_Deterministic minutes', '[The room]('];

/**
 * A side room's recap from its digest: each line through `oneLine`, blank ones and the lines above
 * dropped, cut at `max` on a line's end where it can be (and never between the halves of a
 * surrogate pair). `cut` says whether anything was left out.
 */
export function recapFromDigest(digest: string, max = SIDE_ROOM_RECAP_MAX): { recap: string; cut: boolean } {
  const lines: string[] = [];
  let used = 0;
  let cut = false;
  for (const raw of digest.split('\n')) {
    const line = oneLine(raw).trim();
    if (!line || NOT_RECAPPED.some((start) => line.startsWith(start))) continue;
    const need = (lines.length ? 1 : 0) + line.length;
    if (used + need > max) {
      const room = max - used - (lines.length ? 1 : 0) - 1;
      if (room > 20) {
        let end = room;
        const last = line.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end -= 1;
        lines.push(`${line.slice(0, end)}…`);
      }
      cut = true;
      break;
    }
    lines.push(line);
    used += need;
  }
  return { recap: lines.join('\n'), cut };
}
