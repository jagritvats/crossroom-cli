/**
 * The runner's effects store track (`effects.db`, runner/effects/store.ts), on the same registry as
 * the relay's and runner.db's (migrations/types.ts): ordered, once-each steps counted in
 * `PRAGMA user_version`, one file each here. Never edit a step that shipped.
 */
import { assertContiguous, type Step } from '../../../migrations/types.js';
import e000 from './000-effects.js';

export const EFFECT_STEPS: readonly Step[] = [e000];
assertContiguous(EFFECT_STEPS);
