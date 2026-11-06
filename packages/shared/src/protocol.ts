/**
 * Types for the open room protocol: what the specification (`spec/00`–`09`), its JSON
 * Schemas and the conformance suite (`crossroom conformance`, packages/conformance) are written from.
 *
 * Pure: no zod and no Node import, so the web app, the router in `ee/` and any SDK may import
 * values from here. The generated schemas come from the zod types
 * that already define each operation's arguments (`z.toJSONSchema`, zod v4), never from these.
 */

/** The protocol's name and version, as a relay's discovery and the spec's overview give it. */
export const ROOM_PROTOCOL = 'parley-room/1';

/**
 * The operations a seat takes part through (spec/01-operations.md): the ten every room offers, and
 * `record`, which a project room offers to seats of its own organisation, and `board`
 * and `board_set`, which a room created with a board offers every seat, and `declare_tool`, `call_tool`
 * and `tool_result`, which a room created with typed tools offers every seat, and `open_room` and
 * `subrooms`, which a room that allows sub-rooms offers its lead alone. Their names
 * are `OpName` (@parley/shared/render); the list here is the order the spec documents them in.
 */
export const ROOM_OPERATIONS = [
  'join',
  'status',
  'say',
  'wait',
  'request_context',
  'share_context',
  'decline_context',
  'claim',
  'position',
  'finish',
  'record',
  'board',
  'board_set',
  'declare_tool',
  'call_tool',
  'tool_result',
  'open_room',
  'subrooms',
  'context',
  'items',
  'file',
  'update',
  'verify',
  'pass',
  'autonomy',
] as const;
export type RoomOperation = (typeof ROOM_OPERATIONS)[number];

/** How a seat reaches a room (spec/07-bindings.md). A2A is deferred. */
export const BINDINGS = {
  /** MCP at revision 2026-07-28 beside 2025-06-18, at `/mcp/<token>` or `/mcp` with a bearer token. */
  mcp: 'mcp',
  /** The seat link's REST surface, `/j/<token>/<op>` with `?format=json`, and `/api/seat/op/:op` with `x-parley-seat`. */
  http: 'http',
  /** A runner driving its agent over the Agent Client Protocol (`crossroom join --driver acp`). */
  acp: 'acp',
} as const;

/**
 * Sent by the owner's own tools with `GET /api/sessions/:id/minutes?style=digest` when the digest is
 * not leaving: the local copy `crossroom memory` keeps under the data directory. A script's digest
 * fetch counts as a minutes export, and that read is neither a publication nor
 * a person choosing to take the minutes somewhere, so the server leaves it out of the count. It
 * changes only that count: the owner gate and the digest are the same.
 */
export const LOCAL_COPY_HEADER = 'x-parley-local-copy';

/**
 * What a seat that already called `finish` gets when it says something or finishes again (409). A
 * finish is the seat's last word: the other side was told it is done, and the minutes print its
 * summary. Before, `say` still posted and `finish` stamped a second `participant_finished` with
 * another summary: in live runs a session that no longer held a seat finished it, and the
 * session that did hold it finished it again. Here rather than in the server because the `crossroom`
 * command matches it in an answer and carries no server.
 */
/**
 * The oldest `crossroom` client this server's routes still answer as that client expects, given in
 * `GET /api/features` as `client.min`. The client compares its own version with it, at most once a
 * day per instance, and says on stderr that it is time to update; it never refuses to run. Raise it
 * when a route a released client calls changes shape.
 */
export const CLIENT_MIN_VERSION = '0.2.0';

export const SEAT_FINISHED = 'This seat has already finished, so it takes no further part in the room. Nothing was recorded.';

/**
 * The bodies a stranger is answered with, byte for byte the same whether or not the thing exists.
 * The server's guards answer with these, and so must anything that stands in front of
 * it: the shard router answers an id it has no route for with exactly these bytes, so the
 * router never tells a stranger which ids are real.
 */
export const NOT_FOUND = {
  /** A room's owner routes: `{"error": PRIVATE_ROOM}`, 404. */
  room: 'no such room, or you are not its owner. A room is private to whoever opened it: open it in the browser that created it, or use the owner link you were given when it was created.',
  /** A seat token in `x-parley-seat` that opens nothing: `{"error": …}`, 404. */
  seat: 'This is not, or is no longer, a Crossroom seat. Ask whoever sent the link for a fresh one.',
  /** A share link that opens nothing: `{"error": …}`, 404. */
  share: 'This shared room does not exist, or its owner stopped sharing it.',
  /** An unmatched path under a declared prefix (`/api`, `/mcp`, `/ask`, `/auth`, `/scim`, `/fed`, `/.well-known`): `{"error": …}`, 404. */
  endpoint: 'no such endpoint',
  /** An unmatched path under `/j`: this text, `text/plain; charset=utf-8`, 404. */
  seatLink: 'Not a Crossroom seat link. Ask whoever sent it for a fresh one.\n',
} as const;

/** What `crossroom conformance <url>` checks, each by this name in `--only` and `--json`. */
export const CONFORMANCE_CHECKS = [
  'identical-404',
  'get-wait-405',
  'cursor',
  'fences',
  'forged-headings',
  'evidence',
  'unanimity-floor',
  'concessions',
  'addressing',
  'replaced-link-410',
  'e2ee-text-refusals',
  'chain-v2',
  'signatures',
] as const;
export type ConformanceCheck = (typeof CONFORMANCE_CHECKS)[number];

/** How `crossroom conformance` makes the rooms it checks: at most 3, at no more than 6 a minute, deleted after. */
export type ConformanceCreate = 'quick' | 'owner-token' | 'cmd';
export const CONFORMANCE_ROOMS_MAX = 3;
export const CONFORMANCE_CREATES_PER_MINUTE = 6;

export interface ConformanceResult {
  check: ConformanceCheck;
  ok: boolean;
  /** The suite's own words, never text from the server under test. */
  detail: string;
}

export interface ConformanceReport {
  url: string;
  protocol: typeof ROOM_PROTOCOL;
  results: ConformanceResult[];
  ok: boolean;
  /** Rooms it made and deleted, at most `CONFORMANCE_ROOMS_MAX`. */
  roomsMade: number;
}
