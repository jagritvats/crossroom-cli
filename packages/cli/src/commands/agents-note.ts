/**
 * The names of this machine's account's own agents, kept for the plugin's SessionStart hook
 * (`<data>/agents.json`). `crossroom agents`, `agents add` and `agents grant` write
 * it; `crossroom logout` forgets it for the relay it names. A module of its own, with no command in
 * it, so `logout` can import it without moving where `agents` registers.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SEAT_LABEL } from '@parley/shared/runner';
import { dataDir } from '../cli.js';

/** Where the names are kept. */
export const agentsFile = () => path.join(dataDir(), 'agents.json');

/** What the SessionStart hook reads: the relay, when, and each agent's name and state. Nothing else. */
export interface AgentsNote {
  relay: string;
  at: string;
  agents: Array<{ name: string; state: 'live' | 'paused' | 'offline' }>;
}

/**
 * Keep the names of the agents the account may call. Only labels in a seat label's shape are kept
 * (they are printed into a session's context), and the file is written whole and renamed into
 * place, so a hook never reads half of it.
 */
export function noteAgents(relay: string, agents: ReadonlyArray<{ label: string; state: AgentsNote['agents'][number]['state'] }>, at = new Date()): AgentsNote {
  const note: AgentsNote = {
    relay,
    at: at.toISOString(),
    agents: agents.filter((a) => SEAT_LABEL.test(a.label)).map((a) => ({ name: a.label, state: a.state })),
  };
  const file = agentsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(note, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return note;
}

/** The note as kept, or null. */
export function readAgentsNote(): AgentsNote | null {
  try {
    const n = JSON.parse(readFileSync(agentsFile(), 'utf8')) as AgentsNote;
    return n && Array.isArray(n.agents) ? n : null;
  } catch {
    return null;
  }
}

/** Forget the note when it is this relay's: a machine signed out of an account names none of its agents. */
export function forgetAgentsNote(relay: string): boolean {
  const n = readAgentsNote();
  if (!n || n.relay !== relay) return false;
  rmSync(agentsFile(), { force: true });
  return true;
}
