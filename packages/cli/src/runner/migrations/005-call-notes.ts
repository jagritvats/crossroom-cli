import type { Step } from '../../migrations/types.js';

// R5 - notes between the calls an account makes to its own agents itself.
//
// - `jobs.direct_call`: 1 for a job whose payload said the account itself made the call
//   (`DispatchCall.direct`), so a job resumed after a restart still knows; 0 for every other job.
// - `seat_notes`: what a seat's agent wrote when it finished such a call (its `finish` summary, and
//   its decisions, actions and open questions), cut short and cleaned, the last few per seat. Kept
//   on this machine only and never sent anywhere; read into the next such call's system note.
//   One row per job at most. Ordered by `id`, a plain rowid (no AUTOINCREMENT, so no
//   `sqlite_sequence`): only the oldest rows or all of a seat's are ever deleted, so the newest keeps
//   the highest id.
//
// `ADD COLUMN` cannot run twice, so the step carries its undo, the index and table first.
export default {
  n: 5,
  name: 'call-notes',
  sql: `
  ALTER TABLE jobs ADD COLUMN direct_call INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS seat_notes (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE,
    at TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS seat_notes_by_label ON seat_notes (label, id);
  `,
  undo: `
  DROP INDEX IF EXISTS seat_notes_by_label;
  DROP TABLE IF EXISTS seat_notes;
  ALTER TABLE jobs DROP COLUMN direct_call;
  `,
} satisfies Step;
