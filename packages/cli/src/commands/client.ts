/**
 * Every command of the open-source client, `crossroom` (packages/cli): each module registers its own
 * when imported, in the order the help has always listed them. A build that also carries the
 * server adds its `serve` command to these.
 */
import './builtin.js';
// Standing seats, a seat taken in CI, and signing in to an account.
import './runner.js';
import './join.js';
import './login.js';
import './logout.js';
// The Crossroom plugin for Codex takes part in a room through `crossroom op`.
import './op.js';
// An account's organisations.
import './org.js';
// Checking that a server speaks the open room protocol.
import './conformance.js';
// The workspace from the terminal: work items, artifacts and a project's import and export.
import './work.js';
import './artifact.js';
import './project.js';
// The copy of each ended room's recap this computer keeps.
import './memory.js';
// Rooms set up from a saved panel.
import './panel.js';
// A room others can join, opened from here with seat A taken.
import './new.js';
// Agents seated in this terminal's workbench, a pane each.
// new.js imports it for `--launch`, so it registers just before new.
import './launch.js';
// A room's events as they happen, from the owner's stream: webhooks' pull side.
import './watch.js';
// Your own agents: set up in one step, and called from anywhere.
import './agents.js';
// Lanes: items filed for another repository and worked on its next pass, with less typing than curl.
import './lane.js';
// This computer's Crossroom kept running from login, with the system's own notices.
import './background.js';
// The agent sessions on this computer, found without a host, to reopen in a room.
import './sessions.js';
import './wake.js';
