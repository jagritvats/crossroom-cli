/**
 * A migration step, and the one function that applies a track of them.
 *
 * A track is an ordered list of steps whose progress one database records in
 * `PRAGMA user_version`: the number of steps applied, so after step N it is N + 1. The room
 * database's track is `ROOM_STEPS` (migrations/index.ts); other databases get tracks of their own.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Step {
  /** Its place in the track, from 0 and without gaps (`assertContiguous`). */
  n: number;
  /** Kebab case, as in the step's file name (`NNN-<name>.ts`). */
  name: string;
  /**
   * Runs once, in a transaction of its own. Never edit a step that has shipped: a database that
   * already ran it will not run it again. Add a new step instead.
   */
  sql: string;
  /**
   * SQL that takes back whatever `sql` did that cannot run twice (an `ADD COLUMN`, a backfill
   * into a UNIQUE column), so that a test can rewind `user_version` past the step and have it
   * replayed (`undoAfter`). A step made only of `IF NOT EXISTS` statements needs none. Only
   * tests run it.
   */
  undo?: string;
}

export function migrate(db: DatabaseSync, steps: readonly Step[]): void {
  const at = Number((db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
  for (let v = at; v < steps.length; v++) {
    // One transaction per step: a step that throws half way leaves the version behind it, so
    // the next boot retries the whole step rather than resuming inside a half-applied one.
    db.exec('BEGIN');
    try {
      db.exec(steps[v]!.sql);
      // PRAGMA does not take a binding, and v is a loop integer, so interpolation is safe.
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration step ${v} failed: ${(e as Error).message}`);
    }
  }
}

/** Step n must sit at index n, or `user_version` would name the wrong step. */
export function assertContiguous(steps: readonly Step[]): void {
  steps.forEach((s, i) => {
    if (s.n !== i) throw new Error(`migration steps are not contiguous: index ${i} holds step ${s.n} (${s.name})`);
  });
}
