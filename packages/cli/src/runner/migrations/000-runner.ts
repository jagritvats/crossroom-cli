import type { Step } from '../../migrations/types.js';

// R0 — the runner's own database (`runner.db`, under `~/.parley/runner/` or `PARLEY_RUNNER_HOME`,
// file mode 0600). It lives on the answering team's machine and holds that team's
// secrets, which is exactly why it never leaves it:
// - `identity`: the one row of this runner's relay, its runner token, and its X25519 and Ed25519
//   keys (private keys as PKCS8, public as raw base64url);
// - `seats`: each configured seat's relay id, its current ask token and epoch;
// - `ask_tokens`: every ask token this runner minted, by hash, and when it was retired, so the
//   dispatch check can tell a job for a link it issued from a forged one;
// - `jobs`: the jobs it accepted, with each one's seat token (never in an argument, an environment
//   or a file a CLI can read: only the egress proxy uses it), its worktree and its resume id;
// - `outbound`: the ledger of every packet and message the proxy let out, held or refused;
// - `held`: calls held for review, until a person approves or refuses them.
//
// Enum-like columns (`jobs.state`, `outbound.decision`, `held.decision`) have no CHECK, as on the
// relay. All IF NOT EXISTS, so the step runs twice harmlessly and needs no undo.
export default {
  n: 0,
  name: 'runner',
  sql: `
  CREATE TABLE IF NOT EXISTS identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    relay TEXT NOT NULL,
    runner_id TEXT NOT NULL,
    runner_token TEXT NOT NULL,
    x25519_private TEXT NOT NULL,
    x25519_public TEXT NOT NULL,
    ed25519_private TEXT NOT NULL,
    ed25519_public TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seats (
    label TEXT PRIMARY KEY,
    seat_id TEXT,
    ask_token TEXT,
    ask_epoch INTEGER NOT NULL DEFAULT 0,
    paused_at TEXT,
    registered_at TEXT,
    rotated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS ask_tokens (
    hash TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    retired_at TEXT
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    session_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    seat_token TEXT NOT NULL,
    ask_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    refused_reason TEXT,
    resume_id TEXT,
    commit_sha TEXT,
    workdir TEXT,
    received_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    cost_usd REAL,
    UNIQUE (session_id, participant_id)
  );
  CREATE TABLE IF NOT EXISTS outbound (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    job_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    label TEXT NOT NULL,
    op TEXT NOT NULL,
    to_seat TEXT,
    packet_label TEXT,
    kind TEXT,
    title TEXT,
    source TEXT,
    bytes INTEGER,
    sha256 TEXT,
    decision TEXT NOT NULL,
    rule TEXT,
    detail TEXT,
    body TEXT
  );
  CREATE INDEX IF NOT EXISTS outbound_by_job ON outbound (job_id, at);
  CREATE TABLE IF NOT EXISTS held (
    id TEXT PRIMARY KEY,
    outbound_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    args_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    decision TEXT,
    reason TEXT
  );
  `,
} satisfies Step;
