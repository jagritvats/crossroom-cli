import type { Step } from '../../migrations/types.js';

// R4 - a job a project's playbook dispatched through a `may_ask` grant (seat dispatch
// on the relay): the grant's principal it named (`StartSeatPayload.grant.principal`,
// `project:<id>`), so this runner's own rows say which project put each of its seats in a room.
// The principal only, never the grant token. NULL for a job an ask link or a connection opened.
//
// `ADD COLUMN` cannot run twice, so the step carries its undo.
export default {
  n: 4,
  name: 'grant-jobs',
  sql: `
  ALTER TABLE jobs ADD COLUMN grant_principal TEXT;
  `,
  undo: `
  ALTER TABLE jobs DROP COLUMN grant_principal;
  `,
} satisfies Step;
