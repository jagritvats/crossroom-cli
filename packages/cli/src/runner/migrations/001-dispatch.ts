import type { Step } from '../../migrations/types.js';

// R1 — what the dispatch check (runner/dispatch.ts) reads on every lease:
// - `jobs_by_label`: a seat's live jobs and the ones it took in the last hour and day, for the
//   local rate limits (`concurrent`, `per_hour`, `per_day`);
// - `seats_by_seat_id`: one label per relay seat id, so a job naming a seat id maps to exactly one
//   configured seat, whatever a relay answers to `POST /api/runner/seats`;
// - `ask_tokens_by_label`: a label's epochs, which only ever rise, even across a remove and re-add.
//
// Indexes only, all IF NOT EXISTS: the step runs twice harmlessly and needs no undo.
export default {
  n: 1,
  name: 'dispatch',
  sql: `
  CREATE INDEX IF NOT EXISTS jobs_by_label ON jobs (label, state, received_at);
  CREATE UNIQUE INDEX IF NOT EXISTS seats_by_seat_id ON seats (seat_id) WHERE seat_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ask_tokens_by_label ON ask_tokens (label, epoch);
  `,
} satisfies Step;
