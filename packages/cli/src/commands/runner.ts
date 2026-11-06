/**
 * `crossroom runner`: standing seats on this machine that answer ask links.
 *
 * The forms, all under this one command:
 * - `crossroom runner init [--relay <url>] [--name <name>] [--team-token -]`: with `--team-token -`, a
 *   runner token a team minted on its page is read from stdin, never argv or the
 *   environment, and becomes this runner's identity (`adoptRunnerToken`, runner/connect.ts)
 * - `crossroom runner add <label>=<dir> [--with claude|codex|grok] [--model] [--description] [--brief-file] [--deny <glob>]… [--review <glob>]…`
 *   (a value may also list globs with commas; a brace list's commas are the glob's own)
 * - `crossroom runner [start]`: in the foreground; Ctrl-C drains the running jobs, then stops.
 * - `crossroom runner --relay <url> <label>=<dir> --with claude`: init, add and start in one line.
 * - `crossroom runner seats | rotate <label> | pause <label> | resume <label> | remove <label>`
 * - `crossroom runner ledger [--seat] [--since] [--json] | held | approve <hold> | refuse <hold> --reason "…"`
 * - `crossroom runner page [--port]`, `crossroom runner doctor`
 * - `crossroom runner service install [--dry-run] [--visible] | status | uninstall`: the runner as a
 *   background service of this user's (runner-service.ts), which starts it as `crossroom runner start
 *   --service --service-env <home>/service.json`
 * Codex and Grok need `--unconfined-reads-ok` (or `unconfined_reads: acknowledged` in the config).
 *
 * The configuration is `runner.yml` (runner/config.ts); a running runner re-reads it for every
 * job, so `pause` and `remove` take effect on the next ask. The job loop is `RunnerHost`
 * (runner/host.ts). The relay client, the dispatch check, the store and the policy's first line
 * come in through `connectRunner` (runner/connect.ts), with review before sharing and the outbound
 * ledger (runner/review-service.ts): a running runner keeps every held packet in runner.db,
 * serves its local page on the loopback (the link is printed once, key in its fragment) for a person
 * to approve or refuse them, and syncs the ledger content-free to its team. `ledger` and `held` read
 * runner.db from any process; `approve`, `refuse` and `page` point at the running runner's page,
 * which checks a packet again against what its job knew.
 */
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNNER_TOKEN } from '@parley/shared/runner';
import { oneLine } from '@parley/shared/text';
import { ADAPTERS, resolveBin } from '../runners/adapters.js';
import { runnerAvailability } from '../runners/hosted.js';
import { ConfigError, configPath, flagValues, globList, loadConfig, type RunnerConfig, runnerHome, saveConfig, seatDir, seatFromFlags } from '../runner/config.js';
import { adoptRunnerToken, ConnectError, connectRunner } from '../runner/connect.js';
import type { RunningEffects } from '../runner/effects/index.js';
import { FleetControl, withFleetControl } from '../runner/fleet-control.js';
import { RunnerHost } from '../runner/host.js';
import { OutboundLedger } from '../runner/ledger.js';
import { type RunnerPage, startRunnerPage } from '../runner/page.js';
import { runnerPaths, RunnerStore } from '../runner/store.js';
import { isGitRepo } from '../runner/worktree.js';
import { type Args, driverFlag, text, Usage, VERSION } from '../cli.js';
import { registerCommand } from './index.js';
import { runnerGithub } from './runner-github.js';
import { applyServiceEnv, forgetPageLink, LOG_FILE, readPageLink, runnerService, serviceLog, writePageLink } from './runner-service.js';
import { noticesOn, systemNotices, watchCounts } from '../os-notice.js';
import type { ReviewQueue } from '../runner/review.js';

/**
 * The runner's system notice (os-notice.ts): packets held for a person's review. A count and fixed
 * words; the page itself is opened with `crossroom runner page`, since its link carries its key and a
 * notice's command line is readable by every account on the machine.
 */
export function runnerNotices(queue: Pick<ReviewQueue, 'pending'>, log: (line: string) => void, send = systemNotices({ log })) {
  return watchCounts(
    {
      held: {
        ids: () => queue.pending().map((h) => h.id),
        notice: (n) => ({
          title: 'Crossroom runner',
          body: `${n === 1 ? 'A packet waits for your review before it leaves this computer.' : `${n} packets wait for your review before they leave this computer.`} Run crossroom runner page to open it.`,
        }),
      },
    },
    { send, log },
  );
}

/** The most of stdin `--team-token -` reads: a runner token is one line. */
const TEAM_TOKEN_STDIN_CAP = 4096;

async function readTokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    chunks.push(b);
    size += b.length;
    if (size >= TEAM_TOKEN_STDIN_CAP) break;
  }
  return Buffer.concat(chunks).subarray(0, TEAM_TOKEN_STDIN_CAP).toString('utf8').trim();
}

/**
 * `crossroom runner init --team-token -`: the token a team's page showed once, from stdin. A token
 * given in the command line itself is refused unread, since argv is in every process listing and
 * shell history; nothing here ever prints what was given.
 */
export async function initWithTeamToken(
  home: string,
  cfg: RunnerConfig,
  given: string | true,
  say: (l: string) => void,
  readStdin: () => Promise<string> = readTokenFromStdin,
): Promise<number> {
  if (given !== '-')
    throw new Usage("Pass the team's runner token on stdin, never in the command line: crossroom runner init --relay <url> --team-token - (then paste it and press Enter, or pipe it in).");
  const token = await readStdin();
  if (!RUNNER_TOKEN.test(token)) throw new Usage("What arrived on stdin is not a runner token (rt_…). Copy it again from the team's page.");
  try {
    await adoptRunnerToken({ home, config: cfg, fetch, log: say, version: VERSION }, token);
  } catch (e) {
    if (e instanceof ConnectError) throw new Usage(e.message);
    throw e;
  }
  return 0;
}

/** The relay a runner talks to when `init` names none (commands/instance.ts). */
export { DEFAULT_RELAY } from './instance.js';
import { DEFAULT_RELAY } from './instance.js';

const defaultName = () =>
  (os.hostname() || 'runner')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 60) || 'runner';

function mustConfig(home: string): RunnerConfig {
  let cfg: RunnerConfig | null;
  try {
    cfg = loadConfig(home);
  } catch (e) {
    if (e instanceof ConfigError) throw new Usage(e.message);
    throw e;
  }
  if (!cfg) throw new Usage(`No runner is set up here yet (${configPath(home)}). Run \`crossroom runner init --relay <url>\` first.`);
  return cfg;
}

/** The configuration, or an empty one: for a refusal that reads nothing from it. */
function mustConfigOr(home: string): RunnerConfig {
  try {
    return loadConfig(home) ?? { relay: DEFAULT_RELAY, name: defaultName(), seats: [] };
  } catch {
    return { relay: DEFAULT_RELAY, name: defaultName(), seats: [] };
  }
}

function save(home: string, cfg: RunnerConfig) {
  try {
    saveConfig(home, cfg);
  } catch (e) {
    if (e instanceof ConfigError) throw new Usage(e.message);
    throw e;
  }
}

export function init(home: string, flags: Args['flags'], say: (l: string) => void): RunnerConfig {
  const existing = (() => {
    try {
      return loadConfig(home);
    } catch (e) {
      if (e instanceof ConfigError) throw new Usage(e.message);
      throw e;
    }
  })();
  const relay = text(flags.relay) ?? existing?.relay ?? DEFAULT_RELAY;
  const name = text(flags.name) ?? existing?.name ?? defaultName();
  const cfg: RunnerConfig = { relay: relay.replace(/\/+$/, ''), name, seats: existing?.seats ?? [] };
  save(home, cfg);
  say(`${existing ? 'Updated' : 'Set up'} the runner "${cfg.name}" for ${cfg.relay} in ${configPath(home)}.`);
  return cfg;
}

export function add(home: string, spec: string, args: Pick<Args, 'flags'>, say: (l: string) => void): RunnerConfig {
  const { flags } = args;
  const cfg = mustConfig(home);
  const eq = spec.indexOf('=');
  if (eq <= 0) throw new Usage('Name the seat and its directory: crossroom runner add <label>=<dir>');
  const label = spec.slice(0, eq).trim();
  const dir = spec.slice(eq + 1).trim();
  if (cfg.seats.some((s) => s.label === label)) throw new Usage(`There is already a seat labelled ${label}. Remove it first, or pick another label.`);
  let seat;
  try {
    seat = seatFromFlags({
      label,
      dir,
      runtime: text(flags.with),
      model: text(flags.model),
      description: text(flags.description),
      briefFile: text(flags['brief-file']),
      deny: globList(flagValues(args, 'deny')),
      review: globList(flagValues(args, 'review')),
      unconfinedOk: flags['unconfined-reads-ok'] === true,
    });
  } catch (e) {
    if (e instanceof ConfigError) throw new Usage(e.message);
    throw e;
  }
  const abs = seatDir(seat, home);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Usage(`${abs} is not a directory.`);
  cfg.seats.push({ ...seat, dir: abs });
  save(home, cfg);
  say(
    `Added the seat ${label}: ${ADAPTERS[seat.runtime].label} answering from ${abs}${seat.runtime === 'claude' ? '' : ' (its reads are not confined to the checkout, and askers are told so)'}. Start the runner (\`crossroom runner\`) to register it; it prints the seat's ask link.`,
  );
  return cfg;
}

function setPaused(home: string, label: string | undefined, paused: boolean, say: (l: string) => void) {
  const cfg = mustConfig(home);
  const seat = cfg.seats.find((s) => s.label === label);
  if (!seat) throw new Usage(`No seat is labelled ${label ?? '(none given)'}. \`crossroom runner seats\` lists them.`);
  seat.paused = paused;
  save(home, cfg);
  say(paused ? `Paused ${label}: new asks are refused; rooms already open go on.` : `Resumed ${label}.`);
}

function remove(home: string, label: string | undefined, say: (l: string) => void) {
  const cfg = mustConfig(home);
  if (!cfg.seats.some((s) => s.label === label)) throw new Usage(`No seat is labelled ${label ?? '(none given)'}. \`crossroom runner seats\` lists them.`);
  cfg.seats = cfg.seats.filter((s) => s.label !== label);
  save(home, cfg);
  say(`Removed ${label}. Its ask link dies once the runner declares its seats again.`);
}

export function seatsText(cfg: RunnerConfig, home: string): string {
  if (!cfg.seats.length) return `The runner "${cfg.name}" (${cfg.relay}) has no seats. Add one: crossroom runner add <label>=<dir>`;
  const rows = cfg.seats.map((s) =>
    [
      s.label,
      ADAPTERS[s.runtime].label + (s.runtime === 'claude' ? '' : ' (unconfined reads)'),
      s.paused ? 'paused' : 'active',
      `${s.checkout ?? 'worktree'}${s.ref ? ` @ ${s.ref}` : ''}`,
      seatDir(s, home),
    ].join('  '),
  );
  return [`The runner "${cfg.name}" (${cfg.relay}):`, ...rows.map((r) => `  ${r}`)].join('\n');
}

export async function doctorLines(home: string): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = [];
  let ok = true;
  let cfg: RunnerConfig | null = null;
  try {
    cfg = loadConfig(home);
    lines.push(cfg ? `config: ${configPath(home)}` : `config: none yet (${configPath(home)}); run \`crossroom runner init\``);
    if (!cfg) ok = false;
  } catch (e) {
    ok = false;
    lines.push(`config: ${(e as Error).message}`);
  }
  const clis = runnerAvailability();
  for (const c of clis.filter((c) => c.id !== 'agy')) lines.push(`${c.label}: ${c.available ? 'installed' : c.note}`);
  lines.push(`git: ${resolveBin('git') ? 'on PATH' : 'not found (a worktree checkout needs it)'}`);
  for (const s of cfg?.seats ?? []) {
    const d = seatDir(s, home);
    const cli = clis.find((c) => c.id === s.runtime);
    const problems = [
      !existsSync(d) ? 'its directory is missing' : null,
      existsSync(d) && (s.checkout ?? 'worktree') === 'worktree' && !(await isGitRepo(d)) ? 'its directory is not a git repository (set checkout: live)' : null,
      !cli?.available ? `${ADAPTERS[s.runtime].label} is not available` : null,
    ].filter(Boolean);
    if (problems.length) ok = false;
    lines.push(`seat ${s.label}: ${problems.length ? problems.join('; ') : 'ready'}`);
  }
  if (cfg) {
    try {
      const res = await fetch(`${cfg.relay}/api/health`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      const body = (await res.json().catch(() => null)) as { version?: string } | null;
      lines.push(`relay: ${res.ok ? `answers (${body?.version ?? 'unknown version'})` : `answered ${res.status}`}`);
      if (!res.ok) ok = false;
    } catch (e) {
      ok = false;
      lines.push(`relay: not reachable (${(e as Error).message})`);
    }
  }
  return { lines, ok };
}

/**
 * `service`: run by the background service (`crossroom runner service install`, runner-service.ts).
 * What the runner says goes to `<home>/runner.log`, not a terminal nobody reads, and the page's link,
 * which carries its key, to `<home>/page-link` alone.
 */
async function start(home: string, terminalSay: (l: string) => void, driver?: 'exec' | 'acp', o: { service?: boolean } = {}): Promise<number> {
  const say = o.service ? serviceLog(home) : terminalSay;
  if (o.service) terminalSay(`Running as a background service; the runner's log is ${path.join(home, LOG_FILE)}.`);
  const cfg = mustConfig(home);
  if (!cfg.seats.length) throw new Usage('The runner has no seats. Add one: crossroom runner add <label>=<dir>');
  const conn = await connectRunner({ home, config: cfg, fetch, log: say, version: VERSION });
  try {
    await conn.declare(cfg);
  } catch (e) {
    conn.close();
    if (e instanceof ConnectError) throw new Usage(e.message);
    throw e;
  }
  // The team's controls, read from every lease and heartbeat answer (runner/fleet-control.ts): a
  // stop-all stops every agent running here, and a rotation its team asked for mints the new link.
  const fleet = new FleetControl({
    stop: () => host.stopEveryJob(),
    rotate: (seatId) => (conn.rotateById ? conn.rotateById(seatId) : Promise.reject(new Error('this runner cannot rotate a seat for its team'))),
    log: say,
  });
  const host: RunnerHost = new RunnerHost({
    // The policy stream's first line (the policy from the default branch, its deny-by-content index,
    // the bounded check), and review before sharing and the ledger's record of every decision.
    ...conn.host,
    home,
    relay: cfg.relay,
    // The organisation this runner co-signs each room's head as, once the room ends.
    cosignAs: cfg.cosign_as ?? null,
    seats: () => {
      try {
        return loadConfig(home)?.seats ?? [];
      } catch {
        // A config broken while running keeps what it had: a half-edited file never widens anything.
        return cfg.seats;
      }
    },
    client: withFleetControl(conn.client, fleet),
    dispatch: conn.dispatch,
    store: conn.store,
    fetch,
    log: say,
    ...(driver ? { driver } : {}),
  });
  await host.start();
  // A playbook's effects, on the same session: a runner whose effects cannot start still answers its seats.
  let effects: RunningEffects | undefined;
  try {
    effects = conn.effects?.(say);
  } catch (e) {
    say(`Effects did not start: ${(e as Error)?.message ?? e}`);
  }
  conn.review?.start();
  conn.ledger?.start();
  let page: RunnerPage | null = null;
  if (conn.review) {
    page = await startRunnerPage({ source: conn.review.pageSource({ name: cfg.name }), actions: conn.review.pageActions() });
    if (o.service) {
      // Never into the log: a log is read, copied and pasted into bug reports, and the link is a key.
      writePageLink(home, page.url);
      say("Held packets wait for a person on this runner's page (this machine only): `crossroom runner page` prints its link.");
    } else say(`Held packets wait for a person on this runner's page (this machine only; the link carries its key, so keep it to yourself): ${page.url}`);
  }
  // A runner a background service starts tells its person, with the system's own notice, when a
  // packet waits for their review: one nobody sees expires, and the asker gets nothing (os-notice.ts).
  const notices = noticesOn() && conn.review ? runnerNotices(conn.review.queue, say) : undefined;
  say(`The runner "${cfg.name}" is answering for ${cfg.seats.map((s) => s.label).join(', ')}. Ctrl-C finishes the running jobs, then stops.`);
  /**
   * The page, the review's timer and a last sync of the ledger, then the connection. The last sync
   * sends every row however young (no call will settle now): a row left unsent is never sent by the
   * next start, which cannot know the policy it was written under.
   */
  const close = async () => {
    notices?.stop();
    if (o.service && page) forgetPageLink(home, page.url);
    await page?.close().catch(() => {});
    await effects?.stop().catch(() => {});
    await conn.review?.stop();
    await conn.ledger?.stop();
    await conn.ledger?.flush().catch(() => null);
    conn.close();
  };
  return new Promise<number>((resolve) => {
    let draining = false;
    const onSignal = () => {
      if (draining) {
        say('Stopping now. Running jobs resume when the runner starts again.');
        void host.stop().then(async () => {
          await close();
          resolve(130);
        });
        return;
      }
      draining = true;
      const n = host.running().length;
      say(n ? `Draining ${n} running job${n === 1 ? '' : 's'}; Ctrl-C again to stop now (they resume at the next start).` : 'Stopping.');
      void host.drain().then(async () => {
        await close();
        resolve(0);
      });
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

/**
 * Approving checks a held packet again against what its job knew (its deny-by-content index, its
 * checkout's names), which only the process running the job holds: so decisions are the running
 * runner's page's, and these point there.
 */
const ON_THE_PAGE: Record<string, string> = {
  approve: "Approve held packets on the runner's page: `crossroom runner` prints its link when it starts.",
  refuse: "Refuse held packets on the runner's page, with the reason its agent is told: `crossroom runner` prints its link when it starts.",
  page: "The runner's page is served by the running runner: `crossroom runner` prints its link when it starts, and a background service's runner leaves it for `crossroom runner page` while it runs.",
};

/** `crossroom runner ledger [--seat <label>] [--since <iso>] [--json]` and `crossroom runner held`: runner.db, read. */
function readLedger(home: string, what: 'ledger' | 'held', flags: Args['flags']): number {
  const store = RunnerStore.open(runnerPaths(home).db);
  try {
    if (what === 'ledger') {
      const rows = new OutboundLedger(store.db).list({ label: text(flags.seat), since: text(flags.since), limit: 200 });
      if (flags.json) console.log(JSON.stringify(rows, null, 2));
      else if (!rows.length) console.log('Nothing has left this machine yet.');
      // A source is the agent's words: on one line, with no control a terminal would act on.
      else for (const r of rows) console.log([r.at, r.label, r.op, r.decision, r.rule ?? '', r.packetLabel ?? '', oneLine(r.source ?? '')].join('  ').trimEnd());
      return 0;
    }
    const held = store.db
      .prepare('SELECT h.id, h.expires_at, o.label, o.rule FROM held h JOIN outbound o ON o.id = h.outbound_id WHERE h.decided_at IS NULL ORDER BY h.created_at')
      .all() as { id: string; expires_at: string; label: string; rule: string | null }[];
    if (flags.json) console.log(JSON.stringify(held, null, 2));
    else if (!held.length) console.log('Nothing is held for review.');
    else for (const h of held) console.log(`${h.id}  ${h.label}  ${h.rule ?? ''}  until ${h.expires_at}`);
    return 0;
  } finally {
    store.close();
  }
}

registerCommand({
  name: 'runner',
  topic: 'computer',
  usage: 'crossroom runner [start] [--relay <url>]',
  summary: "keep standing seats here that answer your team's ask links",
  more: [
    { usage: '[--driver exec|acp]' },
    { usage: 'init | add <label>=<dir> [--with claude|codex|grok] | seats | rotate | pause | resume | remove <label>' },
    { usage: 'ledger | held | approve <hold> | refuse <hold> --reason "<why>" | page | doctor' },
  ],
  order: 150,
  forms: [
    // The GitHub App a runner posts its effects with (commands/runner-github.ts).
    { usage: 'crossroom runner github setup [--org <owner>]', summary: "a GitHub App for this runner's effects, from a manifest", order: 151 },
    // `crossroom runner service install|status|uninstall` still runs, and is
    // `crossroom background … --only runner`, which writes the same unit: the help names background only.
  ],
  // `--issues` and `--replace` are `crossroom runner github setup`'s yes/no flags; `--service`
  // is what a background service starts the runner with, `--dry-run` and `--visible` `service install`'s.
  switches: ['unconfined-reads-ok', 'issues', 'replace', 'service', 'dry-run', 'visible'],
  async run(args, say) {
    // A background service's runner: the PATH and data directories `service install` kept, put
    // back before the runner's home is read (runner-service.ts).
    const envFile = text(args.flags['service-env']);
    if (envFile) applyServiceEnv(envFile);
    const home = runnerHome();
    const [sub, arg] = args.positional;
    // The one-liner: `crossroom runner --relay <url> <label>=<dir> --with claude`.
    if (sub?.includes('=')) {
      const existing = (() => {
        try {
          return loadConfig(home);
        } catch {
          return null;
        }
      })();
      if (!existing || text(args.flags.relay)) init(home, args.flags, say);
      const label = sub.slice(0, sub.indexOf('='));
      if (!mustConfig(home).seats.some((s) => s.label === label)) add(home, sub, args, say);
      return start(home, say, driverFlag(text(args.flags.driver)));
    }
    switch (sub ?? 'start') {
      case 'start':
        if (text(args.flags.relay)) init(home, args.flags, say);
        return start(home, say, driverFlag(text(args.flags.driver)), { service: args.flags.service === true });
      case 'service':
        return runnerService(
          args,
          home,
          () => mustConfig(home),
          () => {
            try {
              return loadConfig(home);
            } catch {
              return null;
            }
          },
        );
      case 'page': {
        // A background service's runner writes its page's link here; a runner in a terminal prints it there.
        const link = readPageLink(home);
        if (!link) {
          say(ON_THE_PAGE.page!);
          return 2;
        }
        say("The running runner's page (this machine only; the link carries its key, so keep it to yourself):");
        console.log(link);
        return 0;
      }
      case 'init': {
        const teamToken = args.flags['team-token'];
        // Refused before anything is written, so a token typed into the command line changes nothing.
        if (teamToken !== undefined && teamToken !== '-') return initWithTeamToken(home, mustConfigOr(home), teamToken, say);
        const cfg = init(home, args.flags, say);
        return teamToken === '-' ? initWithTeamToken(home, cfg, teamToken, say) : 0;
      }
      case 'add':
        if (!arg) throw new Usage('Name the seat and its directory: crossroom runner add <label>=<dir>');
        add(home, arg, args, say);
        return 0;
      case 'seats': {
        const cfg = mustConfig(home);
        console.log(args.flags.json ? JSON.stringify(cfg.seats, null, 2) : seatsText(cfg, home));
        return 0;
      }
      case 'pause':
      case 'resume':
        setPaused(home, arg, sub === 'pause', say);
        return 0;
      case 'remove':
        remove(home, arg, say);
        return 0;
      case 'rotate': {
        const cfg = mustConfig(home);
        if (!cfg.seats.some((s) => s.label === arg)) throw new Usage(`No seat is labelled ${arg ?? '(none given)'}.`);
        const conn = await connectRunner({ home, config: cfg, fetch, log: say, version: VERSION });
        try {
          await conn.rotate(arg!);
          return 0;
        } catch (e) {
          if (e instanceof ConnectError) throw new Usage(e.message);
          throw e;
        } finally {
          conn.close();
        }
      }
      case 'github':
        return runnerGithub(args, say);
      case 'doctor': {
        const d = await doctorLines(home);
        console.log(d.lines.join('\n'));
        return d.ok ? 0 : 1;
      }
      case 'ledger':
      case 'held':
        return readLedger(home, sub === 'held' ? 'held' : 'ledger', args.flags);
      default:
        if (sub && ON_THE_PAGE[sub]) {
          say(ON_THE_PAGE[sub]!);
          return 2;
        }
        throw new Usage(`\`crossroom runner ${sub}\` is not a runner command. \`crossroom help\` lists them.`);
    }
  },
});
