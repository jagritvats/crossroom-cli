import type { Step } from '../../../migrations/types.js';

// E0 — the runner's effects store, `effects.db` beside `runner.db` (runner/effects/store.ts):
// - `effects_seen`: every effect this runner was handed, by id, and what it did with it. The
//   dedupe on the effect id: a row in `posting` is one whose post may have landed (the runner
//   stopped between the call and the record), so the next attempt looks for its marker first.
//   `target` is the effect's kind and target as a key (`pr_comment acme/payments-api#12`), never
//   its body.
// - `github_app`: the one GitHub App `crossroom runner github setup` registered from a manifest: its
//   id, slug and owner, its PEM and secrets, and the API it lives on. Never sent anywhere.
// - `pr_seen`: pull requests the App's poll has reported, by repository, number and head, so a
//   restart does not report them again.
//
// All IF NOT EXISTS: the step runs twice harmlessly and needs no undo.
export default {
  n: 0,
  name: 'effects',
  sql: `
  CREATE TABLE IF NOT EXISTS effects_seen (
    effect_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    state TEXT NOT NULL,
    code TEXT,
    remote_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL,
    done_at TEXT
  );
  CREATE TABLE IF NOT EXISTS github_app (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    app_id INTEGER NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    owner TEXT NOT NULL,
    html_url TEXT NOT NULL,
    api TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    webhook_secret TEXT,
    pem TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pr_seen (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (repo, number, head_sha)
  );
  `,
} satisfies Step;
