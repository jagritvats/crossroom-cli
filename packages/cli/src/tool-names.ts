/**
 * The ten operations every seat has, in the order the server's tools define them. A module of its own,
 * importing nothing, so the `crossroom` command's agent loop (runners/hosted.ts) names them without
 * loading the server's tools; a test holds the list to the server's `TOOLS`.
 */
export const TOOL_NAMES = [
  'join',
  'status',
  'say',
  'wait',
  'request_context',
  'decline_context',
  'share_context',
  'claim',
  'position',
  'finish',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
