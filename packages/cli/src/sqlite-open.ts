/**
 * Open a SQLite file and bring it up to a track of migration steps. The room and directory
 * databases open through the server, which names their tracks; the runner's own database
 * (runner/store.ts) opens here directly, so the `crossroom` command carries no server schema.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, type Step } from './migrations/types.js';

export function openSqlite(file: string, steps: readonly Step[]): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // busy_timeout first: a dev-server restart briefly overlaps the previous process, which still holds the file.
  // secure_delete overwrites freed pages with zeros, so a deleted room's rows do not live on in
  // the file's free list until something happens to reuse the page.
  // synchronous = NORMAL is what WAL is designed for: it cannot corrupt the file, and the only
  // exposure is that the last commits before a power cut or OS crash roll back. The default,
  // FULL, syncs the disk on every commit, and every agent `say`, `share_context` and `position`
  // is a commit: sixty shares took 131 ms on an SSD instead of 10, and on the Windows CI runner's
  // disk long enough to time a test out.
  db.exec(
    'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;',
  );
  migrate(db, steps);
  return db;
}
