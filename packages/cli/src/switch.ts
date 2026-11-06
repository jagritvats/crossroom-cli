/**
 * How a flag's value reads, from the environment or a stored override: on, off, or not said. One
 * parser for the server's flags and the runner's (runner/flags.ts). Imports nothing.
 */
export function parseSwitch(raw: string | undefined | null): boolean | null {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return null;
}
