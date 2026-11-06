/**
 * The runner's own migration track (`runner.db`), on the same registry as the relay's
 * (migrations/types.ts): ordered, once-each steps counted in `PRAGMA user_version`, one file each
 * here, steps after R0 added in order; the rules are the room track's: never
 * edit a step that shipped, give every step that cannot run twice its undo.
 */
import { assertContiguous, type Step } from '../../migrations/types.js';
import r000 from './000-runner.js';
import r001 from './001-dispatch.js';
import r002 from './002-connection-jobs.js';
import r003 from './003-e2ee-rooms.js';
import r004 from './004-grant-jobs.js';
import r005 from './005-call-notes.js';

export const RUNNER_STEPS: readonly Step[] = [r000, r001, r002, r003, r004, r005];
assertContiguous(RUNNER_STEPS);
