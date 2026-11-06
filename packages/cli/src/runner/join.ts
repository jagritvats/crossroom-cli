/**
 * `crossroom join <seat link> --dir <dir>`: one seat of one room, taken by an agent this
 * command starts in `<dir>`, with everything a standing seat's runner does for its agent and no
 * registration. How CI answers (CROSS-TEAM F), and how a pull request's side of the consumer check
 * takes its seat.
 *
 * - The seat link's token stays in this process: the agent's CLI is given the egress proxy's
 *   loopback URL with a nonce, in a 0600 `mcp.json` for Claude Code, and nothing in its
 *   arguments, its environment or its files carries the token.
 * - Every call that carries the agent's words goes through a policy first: the usual homes of
 *   secrets are denied (`DEFAULT_DENY`, plus `--deny`), secrets are scanned for, and the seat
 *   link's own token and this process's secret-looking variables are refused in any encoding.
 * - Claude Code is the default. Codex and Grok read outside their directory, so they need
 *   `--unconfined-reads-ok`, and their environment has every secret-looking variable blanked.
 * - `--ref <commit>` answers from a worktree of that commit (tracked files only); without it the
 *   agent runs in `<dir>` as it is, which in CI is already a clean checkout.
 *
 * It returns when the room ends (after the agent's 20 s to see it), when the seat has finished and
 * its agent is idle, when the seat is gone (its link replaced, its room deleted), when the agent
 * could not start or stopped on an error, or when `signal` aborts (Ctrl-C).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { slotLetter } from '@parley/shared';
import { caseInsensitivePaths } from '@parley/shared/policy';
import { LINE_BREAK, oneLine } from '@parley/shared/text';
import { ADAPTERS, type Adapter, resolveBin, writeMcpConfigFile } from '../runners/adapters.js';
import { ACP_COMMANDS, AcpHosted, acpDriver, acpDriverOn } from '../runners/acp.js';
import { Hosted, type RunnerOptions, redact } from '../runners/hosted.js';
import { DEFAULT_DENY, runnerHome, SeatConfig, seatPolicy } from './config.js';
import { envSecrets, standingAdapter } from './host.js';
import { egressPolicy } from './egress-policy.js';
import { EgressProxy, type FetchLike, policyGate, relayForwarder } from './proxy.js';
import { signingRoute } from './receipts.js';
import { ephemeralSigner } from './signer.js';
import { HttpSeatPort } from './remote-port.js';
import { prepareCheckout, removeJobDir } from './worktree.js';

/** A mistake the person running the command can fix, said in one sentence. */
export class JoinUsage extends Error {}

/** A seat link's relay and token. The key of an end-to-end room (`#e=`) is refused: that room is the seat helper's. */
export function parseSeatLink(link: string): { relay: string; token: string } {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    throw new JoinUsage('That is not a seat link: a seat link looks like https://<host>/j/<token>.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new JoinUsage('A seat link is an http(s) URL.');
  if (/[#&]e=/.test(u.hash)) throw new JoinUsage('That seat is in an end-to-end encrypted room, which only the seat helper can take part in.');
  const m = /^(.*)\/j\/([A-Za-z0-9_-]{8,})\/?$/.exec(u.pathname);
  if (!m) throw new JoinUsage('That is not a seat link: a seat link looks like https://<host>/j/<token>.');
  return { relay: `${u.origin}${m[1]}`, token: m[2]! };
}

/**
 * The seat link in what `crossroom join -` read from stdin: its first line that is not blank, trimmed,
 * whatever ends the lines. Null when there is none.
 */
export function seatLinkFrom(input: string): string | null {
  return (
    input
      .split(LINE_BREAK)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? null
  );
}

export interface JoinOptions {
  link: string;
  dir: string;
  runtime?: string;
  model?: string;
  ref?: string;
  unconfinedOk?: boolean;
  deny?: string[];
  /** Where job directories go (`<home>/join/<id>`); the runner's home by default. */
  home?: string;
  fetch: FetchLike;
  runners?: RunnerOptions;
  say(line: string): void;
  signal?: AbortSignal;
  /** How long after the room ends the command waits for the agent to see it. */
  endGraceMs?: number;
  /** How often the seat's row is read, to notice it has finished. */
  pollMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * How the agent is driven: `exec` (the default: one CLI process per turn, resumed) or `acp` (one
   * process over the Agent Client Protocol), which runs only while the relay's `acpDriver`
   * flag is on and the runtime has an ACP command here.
   */
  driver?: 'exec' | 'acp';
}

/**
 * What `crossroom join` ended on. `failed`: the agent could not start, or stopped on an error (its
 * runner state is `error`), so the seat will never answer.
 */
export type JoinOutcome = 'ended' | 'finished' | 'gone' | 'stopped' | 'failed';

/** Budgets for one room, for a seat nobody configured: generous, since this is the person's own agent in the person's own checkout. */
const JOIN_BUDGET = { messages: 100, packets: 50, minutes: 240, concurrent: 1, per_hour: 60 };

export async function joinSeat(o: JoinOptions): Promise<JoinOutcome> {
  const { relay, token } = parseSeatLink(o.link);
  const dir = path.resolve(o.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new JoinUsage(`${dir} is not a directory.`);
  const runtime = o.runtime ?? 'claude';
  // Checked as a standing seat's config would be: Codex and Grok need the acknowledgement.
  const cfg = SeatConfig.safeParse({
    label: 'join',
    dir,
    runtime,
    deny: [...DEFAULT_DENY, ...(o.deny ?? [])],
    budget: JOIN_BUDGET,
    unconfined_reads: o.unconfinedOk ? 'acknowledged' : false,
    ...(o.model ? { model: o.model } : {}),
  });
  if (!cfg.success) {
    const i = cfg.error.issues[0]!;
    throw new JoinUsage(i.path[0] === 'runtime' ? `--with takes claude, codex or grok; got "${runtime}".` : i.message);
  }
  const seat = cfg.data;
  const base: Adapter = o.runners?.adapters?.[seat.runtime] ?? ADAPTERS[seat.runtime];
  if (base.hostedBlocked) throw new JoinUsage(base.hostedBlocked);
  const bin = (o.runners?.resolveBin ?? resolveBin)(base.bin);
  if (!bin) throw new JoinUsage(`${base.bin} is not on PATH, so ${base.label} cannot take the seat.`);

  const home = o.home ?? runnerHome();
  const jobDir = path.join(home, 'join', `join_${randomBytes(9).toString('base64url')}`);
  mkdirSync(jobDir, { recursive: true });
  const checkout = await prepareCheckout({ dir, jobDir, mode: o.ref ? 'worktree' : 'live', ref: o.ref }).catch(async (e) => {
    await removeJobDir(jobDir);
    throw new JoinUsage((e as Error).message);
  });
  const secrets = envSecrets(o.env ?? process.env);
  const gate = policyGate({
    jobId: path.basename(jobDir),
    label: 'join',
    policy: seatPolicy(seat),
    // Bounded in time, which picomatch's globs are not (runner/egress-policy.ts's check).
    egress: egressPolicy({ nocase: caseInsensitivePaths(process.platform) }),
    // With `--ref` the agent runs in `<home>/join/<id>/repo`, so a path it cites may go through
    // `repo/` rather than through the directory's own name.
    runner: { knownSecrets: [token, ...secrets.values], repos: [...new Set([path.basename(checkout.cwd), path.basename(dir)])] },
  });
  const proxy = await EgressProxy.start();
  // Signing and receipting in front of the relay, with a key made for this join: the relay
  // pins it at its first signature.
  const signing = signingRoute(relayForwarder({ relay, seatToken: token, fetch: o.fetch }), {
    relay,
    seatToken: token,
    fetch: o.fetch,
    signer: ephemeralSigner(),
    attest: { dir: checkout.cwd, label: path.basename(checkout.cwd) },
    log: (line) => o.say(line),
  });
  const route = proxy.add({ forward: signing.forward, gate });
  const port = new HttpSeatPort({
    relay,
    seatToken: token,
    fetch: o.fetch,
    mcpUrl: route.url,
    workDir: path.join(jobDir, 'work'),
    logPath: path.join(jobDir, 'log'),
    gate,
  });
  let hosted: Hosted | AcpHosted | null = null;
  const cleanup = async () => {
    await hosted?.stop('crossroom join ended').catch(() => {});
    // The last deliveries are receipted (and an ended room co-signed) before the route closes.
    await signing.settle().catch(() => {});
    route.close();
    await port.close();
    await proxy.close();
    await removeJobDir(jobDir, checkout).catch(() => {});
  };
  try {
    const info = await port.open().catch((e) => {
      throw new JoinUsage(`That seat link does not open a seat: ${(e as Error).message}`);
    });
    const room = await port.room();
    if (!room || room.status === 'ended') {
      o.say('That room has already ended.');
      await cleanup();
      return 'ended';
    }
    const mcpFile = writeMcpConfigFile(path.join(jobDir, 'mcp.json'), 'crossroom', route.url);
    const adapter = standingAdapter(base, { mcpConfigFile: mcpFile, blank: secrets.names, brief: null });
    const seatInfo = { ...info, hosted: { runner: seat.runtime, cwd: checkout.cwd, model: seat.model } };
    // The relay's switch decides, asked as the agent starts: turning `acpDriver` off there is the rollback.
    const overAcp = o.driver === 'acp' && !!ACP_COMMANDS[seat.runtime] && (await acpDriverOn(relay, o.fetch));
    if (o.driver === 'acp' && !overAcp)
      o.say('The ACP driver is off on the relay, or this runtime has none here, so the agent runs with the default driver.');
    hosted = overAcp
      ? new AcpHosted(
          port,
          seatInfo,
          acpDriver(seat.runtime, { resolveBin: o.runners?.resolveBin, env: Object.fromEntries(secrets.names.map((n) => [n, ''])) }),
          { silenceMs: o.runners?.silenceMs, killGraceMs: o.runners?.killGraceMs, brief: null },
        )
      : new Hosted(port, seatInfo, adapter, bin, o.runners ?? {});
    o.say(`${adapter.label} is taking seat ${slotLetter(info.slot)} ("${oneLine(info.name).slice(0, 60)}") from ${checkout.cwd}. Ctrl-C stops it.`);

    const outcome = await new Promise<JoinOutcome>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      let poll: NodeJS.Timeout | null = null;
      let settled = false;
      const finish = (why: JoinOutcome) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (poll) clearInterval(poll);
        off();
        o.signal?.removeEventListener('abort', onAbort);
        resolve(why);
      };
      const onAbort = () => finish('stopped');
      if (o.signal?.aborted) return finish('stopped');
      o.signal?.addEventListener('abort', onAbort, { once: true });
      const ending = () => {
        if (!timer) timer = setTimeout(() => finish('ended'), o.endGraceMs ?? 21_000);
      };
      const off = port.subscribe((ev) => {
        if (ev.type === 'session_ended') ending();
      });
      // An agent that cannot start will never answer: say so and stop, so whoever runs this (the
      // consumer check) can end the room at once rather than wait out its clock. `start` resolves
      // on a failed turn too (a CLI that is signed out, rate-limited or exits at once): the state
      // says so, and a seat in `error` is never woken again, whichever turn put it there.
      const failed = (why: string) => {
        if (settled) return;
        o.say(`The agent could not start or go on: ${redact(oneLine(why)).slice(0, 300)}`);
        finish('failed');
      };
      const failedIf = () => {
        if (hosted?.state === 'error') failed(hosted.note ?? 'its runner state is error; see its log');
      };
      poll = setInterval(async () => {
        try {
          const now = await port.look();
          if (!now?.seat) return finish('gone');
          const me = now.seat;
          // An end that came before the subscription is never delivered on it.
          if (now.room.status === 'ended') return ending();
          if (me.finishedAt && hosted && hosted.state !== 'thinking' && hosted.state !== 'waiting' && hosted.state !== 'starting') return finish('finished');
          failedIf();
        } catch {
          /* the relay did not answer; ask again */
        }
      }, o.pollMs ?? 5000);
      hosted!.start().then(failedIf, (e) => failed(String((e as Error)?.message ?? e)));
    });
    o.say(
      outcome === 'ended'
        ? 'The room has ended.'
        : outcome === 'finished'
          ? 'The seat has finished.'
          : outcome === 'gone'
            ? 'The seat is gone: its link was replaced or its room deleted.'
            : outcome === 'failed'
              ? 'The agent will not answer, so the seat is left to the room.'
              : 'Stopped.',
    );
    await cleanup();
    return outcome;
  } catch (e) {
    await cleanup();
    throw e;
  }
}
