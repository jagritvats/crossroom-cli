import type { Step } from '../../migrations/types.js';

// R3 - the rooms the relay has called end to end to this runner (runner/e2ee-egress.ts):
// a room is end to end from its creation or never, so once the relay has said one is, the runner
// never again takes its word that the room is ordinary, by any job, before or after a restart.
// Room ids only, never a key or a token.
//
// IF NOT EXISTS, so the step runs twice harmlessly and needs no undo.
export default {
  n: 3,
  name: 'e2ee-rooms',
  sql: `
  CREATE TABLE IF NOT EXISTS e2ee_rooms (
    session_id TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL
  );
  `,
} satisfies Step;
