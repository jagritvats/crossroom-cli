/**
 * The longest a `wait` call may park a request, and the ceiling the tool schema
 * advertises. 120 s is what the agents allow: Claude Code auto-backgrounds a
 * tool at 120 s and Codex defaults to 60 s unless `tool_timeout_sec` is raised.
 *
 * A reverse proxy in front of this server may be stricter, and PARLEY_WAIT_MAX_S
 * exists for exactly that. Cloudflare gives an origin 100 s to send the first
 * byte and then answers 524, so the hosted instance sets 90 — otherwise an agent
 * that asks for the full 120 gets an error page instead of the reply it was
 * waiting for, which reads like Crossroom dropped the message.
 *
 * Over-long requests are shortened rather than refused: the schema keeps the
 * protocol ceiling so a valid call never fails validation, and the effective cap
 * is applied when the wait actually starts.
 *
 * A module of its own, importing nothing, so the `crossroom` command's agent loop
 * (runners/hosted.ts) reads it without loading the server's tools.
 */
export const WAIT_CEILING_S = 120;
/** What a `wait` parks for when it names no timeout, and the least it parks for. */
export const WAIT_DEFAULT_S = 45;
export const WAIT_MIN_S = 5;
export const WAIT_MAX_S = Math.min(Math.max(Number(process.env.PARLEY_WAIT_MAX_S) || WAIT_CEILING_S, 5), WAIT_CEILING_S);
