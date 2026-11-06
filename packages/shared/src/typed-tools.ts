/**
 * Typed tools: a seat declares a tool with a JSON Schema for its input,
 * and another seat calls it with JSON arguments, which Crossroom checks against that schema before
 * the call is stored. The seat that declared the tool runs it on its own machine and answers with a
 * JSON result (checked against its output schema, when it declared one) or an error.
 *
 * Crossroom runs nothing. It validates and routes: a call is a context request (`context_requests`,
 * marked `typed`), and a result is a `tool_output` packet answering it, so the recap, `checkReply`,
 * the stats and the "fulfilled" bookkeeping are the ones every request already has.
 *
 * Offered only in a room created with `typedTools: true` (`sessions.typed_tools`),
 * which an end-to-end room never is. No zod here: the web imports it.
 */
export { SCHEMA_MAX_BYTES, VALUE_MAX_BYTES } from './jsonschema.js';

/** The most tools one seat declares. Declaring a name it already declared replaces that tool. */
export const TOOLS_PER_SEAT = 8;
/** A tool's name: short, one token, as an offer's is (`OFFER_NAME`). */
export const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
export const TOOL_NAME_MAX = 40;
export const TOOL_DESC_MIN = 3;
export const TOOL_DESC_MAX = 160;
/** The longest error text a `tool_result` carries. */
export const TOOL_ERROR_MAX = 2000;
/** The most a seat writes through `declare_tool` in one room: each declaration is an event in the record. */
export const TOOL_DECLARES_PER_SEAT = 100;

/** A declared tool as a reader sees it. Schemas are canonical JSON text. */
export interface SeatToolView {
  /** The declaring seat's participant id. */
  participantId: string;
  /** Its letter and the name it chose. */
  slot: number;
  seatName: string;
  name: string;
  description: string;
  inputSchema: string;
  outputSchema: string | null;
  updatedAt: string;
}

/** What `declare_tool` answers. */
export interface DeclareToolData {
  name: string;
  /** True when the seat had declared this name before, and the declaration replaced it. */
  replaced: boolean;
  /** Nothing changed: the same description and schemas were declared again. */
  unchanged?: boolean;
  /** How many tools the seat has declared, this one included. */
  count: number;
}

/** What `call_tool` answers: the call's id, which the result answers (`in_reply_to`). */
export interface CallToolData {
  callId: string;
  tool: string;
  /** The addressee's letter. */
  to: string;
  pending: number;
}

/** What `tool_result` answers. */
export interface ToolResultData {
  label: string;
  ok: boolean;
  pending: number;
}

/** The fields a `context_requested` payload gains for a typed call, beside `tool` and `args` (canonical JSON text). */
export interface TypedCallPayload {
  typed: true;
  /** The arguments, parsed: what an SDK's handler is given. */
  input: unknown;
}

/** The fields a `context_shared` payload gains for a typed result. */
export interface TypedResultPayload {
  typed: true;
  /** The tool the result answers. */
  tool: string;
  /** The result, parsed, when the tool succeeded. */
  data?: unknown;
  /** Set when the seat answered with an error; the packet's body is its text. */
  failed?: true;
}
