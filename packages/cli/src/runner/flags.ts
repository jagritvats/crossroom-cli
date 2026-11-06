/**
 * The flags a runner reads on its own machine. A runner has no instance settings to override them,
 * so each is its environment variable or its default, as the server's flag registry decides it with no override
 * bound. Here so the `crossroom` command reads them without loading the server's flag registry;
 * a test holds each to its definition there.
 */
import { parseSwitch } from '../switch.js';

/** `.parley/policy.yml` in a job's checkout: `PARLEY_POLICY_YML`, on by default. */
export const POLICY_YML_ENV = 'PARLEY_POLICY_YML';

export function policyYmlOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseSwitch(env[POLICY_YML_ENV]) ?? true;
}
