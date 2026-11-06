import type { Step } from '../../migrations/types.js';

// R2 - a job that came across a connection between organisations: the grant's alias it
// names (`StartSeatPayload.connection.grant`), so the dispatch check counts the rooms this runner
// took through that grant today and those still running, from its own rows and never the relay's
// (connections/runner-check.ts). NULL for a job an ask link opened.
//
// `ADD COLUMN` cannot run twice, so the step carries its undo, which drops the index first.
export default {
  n: 2,
  name: 'connection-jobs',
  sql: `
  ALTER TABLE jobs ADD COLUMN grant_alias TEXT;
  CREATE INDEX IF NOT EXISTS jobs_by_grant ON jobs (grant_alias, state, received_at);
  `,
  undo: `
  DROP INDEX IF EXISTS jobs_by_grant;
  ALTER TABLE jobs DROP COLUMN grant_alias;
  `,
} satisfies Step;
