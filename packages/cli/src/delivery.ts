/**
 * Which events a seat's agent is delivered: the one definition every reader of it shares.
 *
 * The server's `visibleTo` (an agent's `wait`, its Stop hook), the liveness SQL that counts what `wait`
 * would hand over, and `HttpSeatPort` (runner/remote-port.ts), which drives a standing seat on
 * another machine from the seat's live stream, all ask this. They were three copies: when the server
 * added two event types that no agent is handed, the remote port's copy still delivered them, and
 * a standing seat was woken for every playbook note and effect.
 *
 * Pure, with no Node import, so the remote port can use it without loading the server.
 */
import type { EventType, ParleyEvent } from '@parley/shared';

/**
 * Event types stored for their room and never delivered to an agent (the server's audience
 * classes `system` and `seat-page`): Crossroom's own record of the room's state, and what a seat's
 * page and the owner are shown about that seat. `packet_held` and `packet_released` record that a
 * person of the answering team was asked to review a held packet, and what they decided, which the
 * team's inbox reads from the holds themselves: every agent is told of the hold already, by the
 * `context_held` written beside each (render.ts), and delivered, these reached the asker's agent as
 * a second, uncaptioned copy of it.
 */
export const UNDELIVERED_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'participant_state',
  'session_created',
  'effect_posted',
  'playbook_note',
  'record_consulted',
  'packet_held',
  'packet_released',
  // A seat's own brief in the record, a packet's attestation, a disputed receipt.
  'brief_set',
  'packet_attested',
  'receipt_disputed',
  // E1.3: a party accepted the ended room's minutes. Nobody is waiting on it.
  'minutes_accepted',
  // A seat waiting on its own user: the others read it in an empty wait, never as a delivery.
  'participant_attention',
  // A seat's own call for one of the owner's agents: it read the reply already (agent-calls/).
  'agent_call_requested',
  // A key on the room's board changed: the keys ride on the next delivery instead (`boardChanged`).
  'board_updated',
]);

/**
 * Whether a seat's agent is delivered an event: addressed to everyone or to that seat, not the
 * seat's own doing (the room's end excepted, which reaches everyone), and not a type no agent is
 * handed. Moves nothing.
 */
export function deliverable(participantId: string, e: Pick<ParleyEvent, 'audience' | 'actor' | 'type'>): boolean {
  if (e.audience !== 'all' && e.audience !== participantId) return false;
  if (e.actor === participantId && e.type !== 'session_ended') return false;
  return !UNDELIVERED_TYPES.has(e.type);
}
