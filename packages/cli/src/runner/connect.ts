/**
 * What `crossroom runner start` and `crossroom runner rotate` connect to: the
 * runner's own store (`runner/store.ts`, `runner.db`), its relay client
 * (`runner/client.ts`) and the dispatch check (`runner/dispatch.ts`), in the shapes the runner host
 * asks of them (`HostRelay`, `HostDispatch`, `HostStore` in runner/host.ts), with the runner's
 * first line: each job's policy from `runner.yml` and the repository's
 * `.parley/policy.yml` on its default branch (runner/policy-yml.ts), its deny-by-content
 * index, and the time-bounded egress check; and review before sharing and the outbound ledger
 * (runner/review-service.ts, runner/ledger-sync.ts).
 *
 * - `declare` registers with the relay (minting a runner token and making the runner's keys on first
 *   use), makes the store's seats the configuration's, and declares them. It prints a seat's ask
 *   link the first time the relay hears of it and whenever its token is new; the link is the
 *   capability, so it is printed nowhere else, and `crossroom runner rotate` makes a new one. Then it
 *   syncs each seat's `may_ask` grants (runner/grants.ts), which only a team's runner holds.
 * - `rotate` retires a seat's ask token for a new one and declares it, which kills the old epoch's
 *   seat tokens in every room. From a second process it registers again, which ends the running
 *   runner's session: that runner's next call is refused, and it registers again itself. A
 *   declaration the relay refuses (a seat-change limit) changed nothing there, so the rotation is
 *   taken back here too, and the old link still works on both sides.
 * - `effects` starts the effects loop on the same session and the same `effects.db`, whose
 *   GitHub App secrets every job's known-secret scan also reads.
 * - `rotateById` is the same rotation, asked for by the runner's team from its page
 *   (`control.rotate`, runner/fleet-control.ts), in the running process: declared on the session it
 *   holds, without registering again, and the new link uploaded for the team's maintainers
 *   (`POST /api/runner/links`), sealed there under the organisation key. It is printed nowhere here.
 *
 * `wireRunner` puts a stand-in in place of all of it, for tests.
 */
import path from 'node:path';
import { caseInsensitivePaths } from '@parley/shared/policy';
import type { JobUpdateInput, RegisterInput, RunnerCapabilities, RunnerReason, SeatPolicy } from '@parley/shared/runner';
import { policyYmlOn } from './flags.js';
import { openJob } from '../jobseal.js';
import { ADAPTERS, resolveBin } from '../runners/adapters.js';
import { RelayClient, RelayError, type SeatDeclarationSource, sameRelay } from './client.js';
import { loadConfig, type RunnerConfig, type SeatConfig, seatDir } from './config.js';
import { buildDeniedLines } from './denied-lines.js';
import { checkDispatch, type DispatchSeat } from './dispatch.js';
import { egressPolicy, loadSeatPolicy, policyFieldsOf } from './egress-policy.js';
import { type RunningEffects, startEffects } from './effects/index.js';
import { sessionCallOf } from './effects/relay.js';
import { EffectsStore, effectsDbPath } from './effects/store.js';
import { GrantBook, syncGrants } from './grants.js';
import type { Dispatched, HostDispatch, HostRelay, HostStore, RunnerHostOptions, StoredJob } from './host.js';
import { askHash, newRunnerKeys, publicKeysOf } from './keys.js';
import { LedgerSync } from './ledger-sync.js';
import { dispatchPolicyAwaited, effectsSectionsForAwaited, grantPrincipals, jobPolicyFor, readRepoPolicy } from './policy-yml.js';
import { recheckStoreOf } from './recheck.js';
import { jobCheckout, ReviewService } from './review-service.js';
import type { FetchLike } from './proxy.js';
import { runnerSigner } from './signer.js';
import { type RunnerIdentity, runnerPaths, RunnerStore, type SeatRow } from './store.js';

export interface RunnerConnection {
  client: HostRelay;
  dispatch: HostDispatch;
  store: HostStore;
  /**
   * What the host checks each job's calls with, beyond the seat's own config: the runner's
   * first line, with each job's policy from its repository's default branch (runner/policy-yml.ts),
   * and every decision fed to the outbound ledger and review before sharing (`review`).
   */
  host?: Pick<RunnerHostOptions, 'egress' | 'policyFor' | 'deniedLinesFor' | 'onDecision' | 'refFor' | 'onForwarded' | 'notesFor' | 'signer' | 'e2ee' | 'recheck' | 'seatNotes'>;
  /** Review before sharing: held packets kept in runner.db, and what the runner's page acts through. */
  review?: ReviewService;
  /** The outbound ledger, synced content-free to the team at each seat's report level. */
  ledger?: LedgerSync;
  /** Register with the relay (minting a runner token on first use) and declare the configured seats; prints each seat's ask link once. */
  declare(config: RunnerConfig): Promise<void>;
  /** Mint a seat's new ask token and retire the old one. */
  rotate(label: string): Promise<void>;
  /** The same for the seat whose relay id this is, as its team asked (`control.rotate`), in this process; the new link goes to the team's page. */
  rotateById?(seatId: string): Promise<void>;
  /**
   * Start posting a playbook's effects beside the job loop (runner/effects/): lease, check
   * against `effects.yml` and each seat's repository policy, post with this runner's own
   * credentials, report. Once the runner holds a session with its relay.
   */
  effects?(log: (line: string) => void): RunningEffects;
  close(): void;
}

export interface ConnectOptions {
  home: string;
  config: RunnerConfig;
  fetch: FetchLike;
  log(line: string): void;
  /** This build's version, as the relay is told it at `register`. */
  version?: string;
}

/** A mistake in the runner's own setup, said in one sentence for its operator. */
export class ConnectError extends Error {}

type Connect = (o: ConnectOptions) => Promise<RunnerConnection>;

let wired: Connect | null = null;

/** Put a stand-in in place of the real connection (tests); `null` puts the real one back. */
export function wireRunner(connect: Connect | null): void {
  wired = connect;
}

export function connectRunner(o: ConnectOptions): Promise<RunnerConnection> {
  // In a promise, so a store that cannot be opened is a rejection like any other failure to connect.
  return wired ? wired(o) : Promise.resolve().then(() => openRunner(o));
}

// ---------------------------------------------------------------- what the relay is told

/** The runtimes a standing seat may use, and whether each is here (the relay shows it, and nothing is trusted from it). */
function capabilities(): RunnerCapabilities {
  return {
    os: process.platform.slice(0, 40),
    clis: (['claude', 'codex', 'grok'] as const).map((id) => {
      const a = ADAPTERS[id];
      return { id, version: null, available: !a.hostedBlocked && !!resolveBin(a.bin), health: 'unknown' as const };
    }),
    // It takes a job a project's playbook dispatched through a `may_ask` grant (the dispatch check's
    // `GrantBook.check`): the relay sends one to no runner that does not say so.
    grantDispatch: true,
    // It checks an approved effect's digest (`approvedDigest`): the relay leaves it out for a runner that does not say so.
    approvedEffects: true,
    // It takes a call from a room its seats' account holds (`StartSeatPayload.call`), through the
    // `account:` grants its grants' sync was told of: the relay opens no call room for one that does not say so.
    accountCalls: true,
    // It reads a direct call's mark (`DispatchCall.direct`) and keeps notes between such calls
    // (runner/notes.ts): the relay marks no job for one that does not say so.
    callNotes: true,
    // It leases tracker reads (runner/reads.ts), checked against effects.yml's `tracker_read` rules:
    // the relay queues none for one that does not say so.
    trackerReads: true,
  };
}

/**
 * A seat's policy from `runner.yml` alone, merged over the defaults as the job's own is
 * (`loadSeatPolicy`, `.git` always denied), for what the relay holds for its second line. A seat
 * whose config does not check refuses the whole declaration, rather than declare a policy nobody wrote.
 */
function configPolicy(seat: SeatConfig): SeatPolicy {
  const loaded = loadSeatPolicy([{ name: `runner.yml (seat ${seat.label})`, value: policyFieldsOf(seat) }]);
  if (!loaded.ok) throw new ConnectError(`The seat ${seat.label}'s policy does not check: ${loaded.error}`);
  return loaded.policy;
}

function declarationOf(seat: SeatConfig): SeatDeclarationSource {
  const policy = configPolicy(seat);
  const { messages, packets, minutes, concurrent, perHour } = policy.budget;
  return {
    label: seat.label,
    runtime: seat.runtime,
    description: seat.description,
    policy: { deny: policy.deny, secretScan: policy.secretScan, budget: { messages, packets, minutes, concurrent, perHour } },
    paused: seat.paused,
  };
}

/**
 * The dispatch check's view of a seat: its local limits, `runner.yml`'s tightened by the policy
 * file's `budget.concurrent`, `per_hour` and `per_day` on the default branch, whether the file
 * takes asks through the seat's link (`may_ask.ask_links`; both `dispatchPolicy`, as read), and
 * whether it is paused in the configuration as it stands now.
 */
function dispatchSeat(seat: SeatConfig, read: { budget: DispatchSeat['budget']; askLinks: boolean }): DispatchSeat {
  return {
    label: seat.label,
    budget: read.budget,
    paused: seat.paused,
    ...(read.askLinks ? {} : { askLinks: false }),
    // The grants this seat answers through across a connection, from runner.yml alone.
    connections: (seat.connections ?? []).map((c) => ({
      connection: c.connection,
      grant: c.grant,
      ...(c.min_epoch !== undefined ? { minEpoch: c.min_epoch } : {}),
      limits: {
        ...(c.rooms_per_day !== undefined ? { roomsPerDay: c.rooms_per_day } : {}),
        ...(c.asks_per_day !== undefined ? { asksPerDay: c.asks_per_day } : {}),
        ...(c.live_rooms !== undefined ? { liveRooms: c.live_rooms } : {}),
      },
    })),
  };
}

// ---------------------------------------------------------------- a token a team minted

/**
 * `crossroom runner init --team-token -`: a runner token a team's maintainer minted on the team's page
 * (`POST /api/teams/:t/runner-tokens`) made this runner's identity. New keys are made here and
 * registered with the relay once, which answers the runner's id; then the store keeps the token,
 * the id and the keys, as a token this runner minted itself would be kept. The token arrives on
 * stdin (the command's), never in argv or the environment, and no message here quotes it. Refused
 * when this runner has an identity already: replacing it would orphan every seat declared under it.
 */
export async function adoptRunnerToken(o: ConnectOptions, runnerToken: string): Promise<{ runnerId: string }> {
  const store = RunnerStore.open(runnerPaths(o.home).db);
  try {
    if (store.identity())
      throw new ConnectError('This runner has an identity already, so it does not take a team token. Give the new runner a home of its own (PARLEY_RUNNER_HOME).');
    const client = new RelayClient({ relay: o.config.relay, fetch: (url, init) => o.fetch(url, init), secrets: () => [runnerToken] });
    const keys = newRunnerKeys();
    const reg = await client.register(runnerToken, {
      name: o.config.name,
      version: (o.version ?? 'dev').slice(0, 40),
      publicKeys: publicKeysOf(keys),
      capabilities: capabilities(),
    });
    store.createIdentity({ relay: client.relay, runnerId: reg.runnerId, runnerToken }, keys);
    o.log(`Registered this runner with ${client.relay} under its team's token. Add a seat (\`crossroom runner add <label>=<dir>\`), then start it.`);
    return { runnerId: reg.runnerId };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------- the connection

function openRunner(o: ConnectOptions): RunnerConnection {
  const store = RunnerStore.open(runnerPaths(o.home).db);
  // effects.db: the GitHub App's key and secrets, opened once for both the effects loop and
  // every job's known-secret scan, since an agent whose reads are not confined can read the file.
  let effectsStore: EffectsStore;
  try {
    effectsStore = EffectsStore.open(effectsDbPath(o.home));
  } catch (e) {
    store.close();
    throw e;
  }
  const knownSecrets = () => [...store.knownSecrets(), ...effectsStore.knownSecrets()];
  let client: RelayClient;
  try {
    client = new RelayClient({ relay: o.config.relay, fetch: (url, init) => o.fetch(url, init), secrets: knownSecrets });
  } catch (e) {
    effectsStore.close();
    store.close();
    throw e;
  }
  /** The seats as configured now: the host reads the file again for every job, and so does the check. */
  const seatsNow = (): SeatConfig[] => {
    try {
      return loadConfig(o.home)?.seats ?? o.config.seats;
    } catch {
      // A file broken while the runner runs keeps what it had: a half-edited file never widens anything.
      return o.config.seats;
    }
  };
  const registration = (id: RunnerIdentity, config: RunnerConfig): RegisterInput => ({
    name: config.name,
    version: (o.version ?? 'dev').slice(0, 40),
    publicKeys: publicKeysOf(id),
    capabilities: capabilities(),
  });
  const identity = (): RunnerIdentity => {
    const id = store.requireIdentity();
    if (!sameRelay(id.relay, client.relay))
      throw new ConnectError(
        `This runner was registered with ${id.relay}, and runner.yml names ${client.relay}. Its jobs would all be refused as sent by another relay: put the relay back, or give the runner a home of its own (PARLEY_RUNNER_HOME) for the new one.`,
      );
    return id;
  };
  /**
   * Declare the configured seats, and again if the relay retired one's token (its answer rotates it).
   * `rotated` is a rotation this declaration carries: when the relay answers the first declaration
   * with a refusal (a seat-change limit, a declaration it will not take), it has changed nothing,
   * since it takes a declaration whole or not at all, so the rotation is taken back here too
   * (`restoreAsk`) and the old link opens rooms still, rather than every job it brings being refused
   * as `ask_retired` while the relay goes on handing them out. A declaration that got no answer
   * (the network, a 5xx) may have been taken, so its rotation stands and the next declaration says it.
   */
  const sync = async (config: RunnerConfig, rotated?: { label: string; before: SeatRow }) => {
    const declared = config.seats.map(declarationOf);
    let result: Awaited<ReturnType<typeof client.syncSeats>>;
    try {
      result = await client.syncSeats(store, declared);
    } catch (e) {
      if (rotated && e instanceof RelayError && e.status >= 400 && e.status < 500) store.restoreAsk(rotated.label, rotated.before);
      throw e;
    }
    const labels = new Set(config.seats.map((s) => s.label));
    if (result.seats.some((s) => s.state === 'revoked' && labels.has(s.label))) result = await client.syncSeats(store, declared);
    return result;
  };
  /**
   * Each seat's `may_ask` grants (runner/grants.ts): one per project or team id its policy
   * file names on the default branch (`grantPrincipals`), minted here, uploaded once, and kept here
   * as hashes (`<home>/grants.json`). A file that does not read grants nothing. Only a team's
   * runner holds grants: an anonymous runner's upload is refused (409), and said once per start for
   * a seat whose policy asks for some. A failed sync never stops the runner declaring its seats.
   */
  const grants = GrantBook.open(GrantBook.fileIn(o.home));
  const principalsOf = (s: SeatConfig): string[] => {
    if (!policyYmlOn()) return [];
    try {
      return grantPrincipals(readRepoPolicy(s, o.home));
    } catch (e) {
      o.log(`${s.label}'s policy file does not read, so the seat holds no grants until it does: ${(e as Error).message}`);
      return [];
    }
  };
  /**
   * One seat's grants synced again for a call naming an account the book does not hold (the
   * dispatch check's `refreshGrants`): its answer carries the accounts that may call the seat now.
   */
  const refreshGrants = async (label: string): Promise<void> => {
    const s = seatsNow().find((x) => x.label === label);
    if (s) await syncGrants(grants, s.label, principalsOf(s), (i) => client.uploadGrants(i));
  };
  const syncSeatGrants = async (config: RunnerConfig) => {
    for (const s of config.seats) {
      const principals = principalsOf(s);
      // Nothing asked for and nothing held: nothing to tell the relay. An account's grant is learnt
      // at the first call that names it (`refreshGrants`), then kept fresh here at every start.
      if (!principals.length && !grants.entries(s.label).length && !grants.accounts(s.label).length) continue;
      try {
        await syncGrants(grants, s.label, principals, (i) => client.uploadGrants(i));
      } catch (e) {
        if (e instanceof RelayError && e.status === 409) {
          if (!principals.length) grants.forget(s.label);
          else o.log(`${s.label}'s policy names projects or teams that may ask it, and only a team's runner holds grants: a maintainer claims this runner for a team first.`);
        } else o.log(`${s.label}'s grants were not synced with the relay (${e instanceof RelayError ? e.message : 'an error'}); the runner tries again when it next starts.`);
      }
    }
  };
  /** A seat's current ask link, on the base the relay answered for it. */
  const askLink = (base: string | undefined, label: string) => `${base ?? `${client.relay}/ask/`}${store.seat(label)?.askToken ?? ''}`;

  /** A stored job's ask token, while it is still the seat's current one: the store keeps a retired token's hash only. */
  const askTokenOf = (j: { label: string; askHash: string }): string | null => {
    const seat = store.seat(j.label);
    return seat && askHash(seat.askToken) === j.askHash ? seat.askToken : null;
  };

  const hostStore: HostStore = {
    runningJobs: (): StoredJob[] =>
      store
        .jobs({ states: ['accepted', 'running'] })
        .filter((j) => !!j.seatToken)
        .map((j) => ({
          id: j.id,
          label: j.label,
          sessionId: j.sessionId,
          participantId: j.participantId,
          seatToken: j.seatToken!,
          askToken: askTokenOf(j),
          resumeId: j.resumeId,
          workdir: j.workdir,
          commitSha: j.commitSha,
          direct: j.directCall,
        })),
    started: (id, s) => store.markRunning(id, { workdir: s.workdir, ...(s.commitSha ? { commitSha: s.commitSha } : {}) }),
    setResumeId: (id, resumeId) => store.setResumeId(id, resumeId),
    ended: (id, state) => {
      store.markEnded(id, state);
      // The room is over for this runner: nothing will use the seat's token again.
      store.forgetSeatToken(id);
    },
    knownSecrets,
    askRetired: (jobId) => {
      const j = store.job(jobId);
      return !!(j && store.askToken(j.askHash)?.retiredAt);
    },
  };

  const hostRelay: HostRelay = {
    async lease(input, signal) {
      const r = await client.lease(input, signal);
      // A job the runner cannot read is refused by its id, as the dispatch check would.
      for (const id of r.malformed) void client.updateJob(id, { state: 'refused', reason: 'bad_seal' }).catch(() => null);
      return { jobs: r.jobs, control: r.control };
    },
    updateJob: (jobId: string, input: JobUpdateInput, seatToken?: string) => client.updateJob(jobId, input, seatToken ? { seatToken } : {}),
    heartbeat: (input) => client.heartbeat(input),
  };

  const hostDispatch: HostDispatch = {
    async check(job): Promise<Dispatched> {
      // The job's own seat's policy file, read once for the job, before the check and outside every
      // transaction of runner.db, and awaited: its git processes never hold the event loop, which
      // every running job's egress proxy and the heartbeat share, nor runner.db's write lock, which
      // `crossroom runner pause` and `approve` in another process wait on. The check then asks again
      // only for the configuration, a file, when it accepts the job (a seat paused or removed since).
      const label = store.seatById(job.standingSeatId)?.label ?? null;
      const conf = label === null ? undefined : seatsNow().find((s) => s.label === label);
      const read = conf ? await dispatchPolicyAwaited(conf, o.home) : null;
      const seats = (): DispatchSeat[] => {
        const now = read ? seatsNow().find((s) => s.label === label) : undefined;
        return now && read ? [dispatchSeat(now, read)] : [];
      };
      // A runner with an identity holds the X25519 key its job's route opens end-to-end rooms with.
      const v = await checkDispatch(job, { store, seats, readSeat: (t) => client.seatPage(t), e2ee: true, grants, refreshGrants });
      if (v.ok) {
        // The host needs the whole payload; it opened under this runner's key a moment ago.
        const id = store.requireIdentity();
        return { ok: true, label: v.job.label, payload: openJob(job.payload, id.x25519Private, { runnerId: id.runnerId, jobId: job.id, kind: job.kind }) };
      }
      if ('retry' in v) return { ok: false, retry: true };
      // A job this runner holds already (accepted or running) is its own: never refused.
      if (v.reason === 'replayed_job' && v.known && v.known.state !== 'refused') return { ok: false, held: true };
      // One it refused before is refused again for its first reason, since the relay did not hear it.
      const reason = (v.reason === 'replayed_job' && v.known?.refusedReason ? v.known.refusedReason : v.reason) as RunnerReason;
      return { ok: false, reason };
    },
  };

  const nocase = caseInsensitivePaths(process.platform);
  const deniedLinesFor: NonNullable<RunnerHostOptions['deniedLinesFor']> = ({ seat, checkout, policy }) =>
    buildDeniedLines({
      root: checkout.cwd,
      deny: policy.deny,
      repo: path.basename(seatDir(seat, o.home)),
      nocase,
      // An agent whose reads are not confined can reach the seat's live directory from its worktree.
      ...(seat.runtime !== 'claude' ? { live: seatDir(seat, o.home) } : {}),
    });
  // Review before sharing and the outbound ledger: every decision recorded, a held packet
  // kept here until a person decides on the runner's page, and the ledger synced content-free.
  const review = new ReviewService({
    db: store.db,
    home: o.home,
    seats: seatsNow,
    jobs: (id) => {
      const j = store.job(id);
      return j ? { id: j.id, sessionId: j.sessionId, label: j.label, seatToken: j.seatToken, startedAt: j.startedAt } : null;
    },
    knownSecrets,
    relay: { held: (jobId, input, seatToken) => client.held(jobId, input, seatToken), seatOp: (seatToken, op, args) => client.seatOp(seatToken, op, args) },
    egress: egressPolicy({ nocase }),
    // A held packet of a job this process never saw a call of (a restart): its checkout's index
    // again, from `repo/` in the job's directory, or a live seat's own directory.
    rebuildFacts: async (job) => {
      const j = store.job(job.id);
      const seat = seatsNow().find((s) => s.label === job.label);
      if (!j?.workdir || !seat) return null;
      const checkout = jobCheckout(seat, o.home, job.id);
      const live = checkout.cwd === seatDir(seat, o.home);
      const policy = jobPolicyFor(seat, o.home, checkout).policy;
      const deniedLines = await deniedLinesFor({ seat, checkout: { ...checkout, mode: live ? 'live' : 'worktree', commit: j.commitSha, remove: () => Promise.resolve() }, policy, repos: [] });
      if (deniedLines.partial) return null;
      return { deniedLines, repos: [...new Set([path.basename(checkout.cwd), path.basename(seatDir(seat, o.home))])], nocase };
    },
    log: o.log,
  });
  const ledger = new LedgerSync({
    db: store.db,
    client,
    levelOf: (jobId, label) => review.levelOf(jobId, label),
    // Rows an earlier process wrote and did not sync: under a policy this one cannot know.
    startRow: review.startRow,
    knownSecrets,
    log: o.log,
  });
  // Receipts, attestations and co-signatures are signed with the key this runner registered,
  // read for each job: it exists once `declare` has run, before the host leases anything.
  const signer = () => {
    const id = store.identity();
    return id ? runnerSigner(id) : null;
  };
  // An end-to-end project's key reaches this runner sealed to its registered X25519 key.
  const e2ee = () => {
    const id = store.identity();
    return id
      ? {
          runnerId: id.runnerId,
          runnerKey: id.x25519Private,
          // Once the relay calls a room end to end, its later word that the room is ordinary is refused.
          rooms: { known: (sessionId: string) => store.isE2eeRoom(sessionId), note: (sessionId: string) => store.noteE2eeRoom(sessionId) },
        }
      : null;
  };
  // A fact's sources checked again for the relay (runner/recheck.ts): only what a seat let out, by its outbound ledger here.
  const recheck = recheckStoreOf(store);
  // Notes between the calls a seat's account makes itself (runner/notes.ts), kept in runner.db.
  const seatNotes = { list: (label: string) => store.seatNotes(label), add: (label: string, jobId: string, text: string) => store.addSeatNote(label, jobId, text) };
  const host: NonNullable<RunnerConnection['host']> = { ...review.hostOptions(), deniedLinesFor, signer, e2ee, recheck, seatNotes };

  return {
    client: hostRelay,
    dispatch: hostDispatch,
    store: hostStore,
    host,
    review,
    ledger,
    async declare(config) {
      // Reservations a killed runner left mid-check: only the process that runs the seats does this.
      store.releaseUnchecked();
      if (!store.identity()) {
        const m = await client.mint();
        store.createIdentity({ relay: client.relay, runnerId: m.runnerId, runnerToken: m.runnerToken });
        o.log(`Made this runner's keys and registered it with ${client.relay}.`);
      }
      const id = identity();
      // runner.yml is what the runner has: a seat taken out of it has its ask tokens retired here,
      // and the relay revokes it once it is left out of the declaration.
      const labels = new Set(config.seats.map((s) => s.label));
      for (const s of store.seats())
        if (!labels.has(s.label)) {
          store.removeSeat(s.label);
          grants.forget(s.label);
        }
      const before = new Map(store.seats().map((s) => [s.label, { token: s.askToken, declared: !!s.registeredAt }]));
      for (const s of config.seats) if (!store.seat(s.label)) store.addSeat(s.label);
      await client.register(id.runnerToken, registration(id, config));
      const result = await sync(config);
      for (const s of config.seats) {
        const row = store.seat(s.label);
        const was = before.get(s.label);
        if (!row || (was && was.declared && was.token === row.askToken)) continue;
        o.log(`${s.label}'s ask link (shown once; \`crossroom runner rotate ${s.label}\` makes a new one): ${askLink(result.seats.find((x) => x.label === s.label)?.askUrlBase, s.label)}`);
      }
      await syncSeatGrants(config);
    },
    async rotate(label) {
      const config = loadConfig(o.home) ?? o.config;
      if (!config.seats.some((s) => s.label === label)) throw new ConnectError(`No seat is labelled ${label}.`);
      const id = identity();
      const before = store.seat(label);
      if (!before) throw new ConnectError(`${label} has not been declared yet: start the runner once first.`);
      // Registered first: a registration that fails leaves the seat's link as it was.
      await client.register(id.runnerToken, registration(id, config));
      store.rotateAsk(label);
      const result = await sync(config, { label, before });
      o.log(`${label}'s new ask link: ${askLink(result.seats.find((x) => x.label === label)?.askUrlBase, label)}. The old one opens nothing now.`);
    },
    async rotateById(seatId) {
      const row = store.seatById(seatId);
      const config = loadConfig(o.home) ?? o.config;
      // A seat this runner does not hold, or no longer configures, is not rotated: the relay lists it again until it is gone.
      if (!row || !config.seats.some((s) => s.label === row.label)) throw new ConnectError('The team asked to rotate a seat this runner does not configure.');
      store.rotateAsk(row.label);
      await sync(config, { label: row.label, before: row });
      const askToken = store.seat(row.label)?.askToken;
      if (!askToken) throw new ConnectError(`${row.label} has no ask token after its rotation.`);
      await client.uploadLink({ seat: row.label, askToken });
      o.log(`${row.label}'s ask link was rotated, as its team asked: the old one opens nothing now, and the new one is on the team's page.`);
    },
    effects: (log) =>
      startEffects({
        home: o.home,
        call: sessionCallOf(client),
        identity: () => {
          const id = store.identity();
          return id ? { runnerId: id.runnerId, relay: id.relay, x25519Private: id.x25519Private } : null;
        },
        fetch: o.fetch,
        log,
        store: effectsStore,
        secrets: () => store.knownSecrets(),
        // A GitHub effect is also held to the policy of each seat answering from its repository,
        // read from that seat's default branch as a job's is: it can only narrow effects.yml.
        // Awaited, since it asks every seat's directory which repository it is, a git process each.
        repoPolicy: (repo) => (policyYmlOn() ? effectsSectionsForAwaited(seatsNow(), o.home, repo) : Promise.resolve(null)),
      }),
    close: () => {
      effectsStore.close();
      store.close();
    },
  };
}
