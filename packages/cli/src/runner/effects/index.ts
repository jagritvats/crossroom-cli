/**
 * Effects on a runner, wired together: what `crossroom runner start` runs beside its job loop
 * once it holds a session with its relay.
 *
 * - the effects loop (runner/effects/loop.ts): lease, open, check, post, report;
 * - the GitHub App (runner/effects/github.ts), from `effects.db`, and its pull request poll
 *   (runner/effects/poll.ts) over what `effects.yml` watches;
 * - Linear, Jira and PagerDuty notes (runner/effects/vendors.ts), from the runner's environment;
 * - Slack (runner/effects/slack.ts), dormant unless the environment sets `PARLEY_SLACK=1`;
 * - tracker reads for a project (runner/reads.ts): the App, the Jira credential, and
 *   `PARLEY_AZURE_DEVOPS_PAT` with `PARLEY_AZURE_DEVOPS_ORG`, each only where `effects.yml` allows.
 *
 * The policy is `effects.yml` under the runner's home, read again for every effect, and, for a
 * GitHub effect, the `effects` section of that repository's `.parley/policy.yml` on its default
 * branch where the caller can read one (`repoPolicy`, runner/policy-yml.ts's reader), which can only narrow it.
 */
import type { FetchLike } from './http.js';
import { GithubEffects } from './github.js';
import { EffectsRunner, type PolicyNow } from './loop.js';
import { type EffectsSection, loadEffectsFile } from './policy.js';
import { PullRequestPoll } from './poll.js';
import { effectsRelayOf, type SessionCall } from './relay.js';
import { SlackEffects, SlackSocket, slackConfigFromEnv } from './slack.js';
import { EffectsStore, effectsDbPath } from './store.js';
import { VendorEffects, vendorConfigFromEnv } from './vendors.js';
import { azureReadConfigFromEnv, TrackerReadsRunner } from '../reads.js';

/** A repository's policy sections for an effect: one, several, or none. */
type RepoSections = EffectsSection | readonly EffectsSection[] | null;

export interface StartEffectsOptions {
  home: string;
  /** A call on the runner's session (`sessionCallOf(client)`, runner/effects/relay.ts). */
  call: SessionCall;
  /** The runner's id, relay and X25519 private key, from runner.db's identity. */
  identity: () => { runnerId: string; relay: string; x25519Private: string } | null;
  fetch: FetchLike;
  log: (line: string) => void;
  /** runner.db's secrets, for scrubbing. */
  secrets?: () => readonly string[];
  /**
   * `effects.db`, when the caller has it open already: `crossroom runner start` opens it once, so its
   * job host's known-secret scan reads the App's secrets from it too (`EffectsStore.knownSecrets`).
   * Closed by whoever opened it; without one, this opens and closes its own.
   */
  store?: EffectsStore;
  env?: NodeJS.ProcessEnv;
  /**
   * The `effects` sections of a repository's policy on its default branch, where one is read
   * (`effectsSectionsForAwaited`): one per seat that answers from that repository, each of
   * which must allow the effect too. A promise, so its git processes never hold the event loop.
   */
  repoPolicy?: (repo: string) => Promise<RepoSections>;
  now?: () => number;
}

export interface RunningEffects {
  store: EffectsStore;
  runner: EffectsRunner;
  stop(): Promise<void>;
}

export function startEffects(o: StartEffectsOptions): RunningEffects {
  const env = o.env ?? process.env;
  const store = o.store ?? EffectsStore.open(effectsDbPath(o.home));
  const relay = effectsRelayOf(o.call);
  const github = new GithubEffects({ fetch: o.fetch, app: () => store.githubApp(), ...(o.now ? { now: o.now } : {}) });
  // The environment is read once: a runner is restarted to take a new credential.
  // A service address that is not https leaves that service out, with the reason, rather than stop the runner.
  const read = <T>(what: string, f: () => T, none: T): T => {
    try {
      return f();
    } catch (e) {
      o.log(`Effects: ${what} is left out: ${(e as Error).message}.`);
      return none;
    }
  };
  const vendorConfig = vendorConfigFromEnv(env, (why) => o.log(`Effects: ${why}.`));
  const slackConfig = read('Slack', () => slackConfigFromEnv(env), { enabled: false, bot: null, app: null, url: 'https://slack.com/api' });
  const vendors = new VendorEffects({ fetch: o.fetch, config: () => vendorConfig });
  const slack = new SlackEffects({ fetch: o.fetch, config: () => slackConfig });

  const policy = async (repo?: string): Promise<PolicyNow> => {
    const loaded = loadEffectsFile(o.home);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const sources: { name: string; section: EffectsSection | null }[] = [{ name: 'effects.yml', section: loaded.file ? { allow: loaded.file.allow } : null }];
    if (repo && o.repoPolicy) {
      try {
        const got = await o.repoPolicy(repo);
        const sections: readonly EffectsSection[] = got === null ? [] : 'allow' in got ? [got as EffectsSection] : (got as readonly EffectsSection[]);
        for (const section of sections) sources.push({ name: '.parley/policy.yml', section });
      } catch (e) {
        return { ok: false, error: `${repo}'s .parley/policy.yml could not be read: ${(e as Error).message}` };
      }
    }
    return { ok: true, sources, requireApproval: loaded.file?.require_approval ?? [] };
  };

  const runner = new EffectsRunner({
    relay,
    identity: o.identity,
    store,
    policy: (p) => policy('repo' in p.target ? p.target.repo : undefined),
    github,
    slack,
    vendors,
    pagerdutyService: (incident) => vendors.pagerdutyService(incident),
    log: o.log,
    ...(o.secrets ? { secrets: o.secrets } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  runner.start();

  const poll = new PullRequestPoll({
    github,
    store,
    repos: () => {
      const f = loadEffectsFile(o.home);
      return f.ok && f.file?.watch?.pull_requests && store.githubApp() ? f.file.watch.pull_requests : [];
    },
    sink: (e) => relay.event(e),
    log: o.log,
  });
  poll.start();

  // Tracker reads for a project (runner/reads.ts), with the same App and Jira credential, and Azure DevOps' own.
  const azure = read('Azure DevOps reads', () => azureReadConfigFromEnv(env), null);
  const reads = new TrackerReadsRunner({
    call: o.call,
    identity: o.identity,
    fetch: o.fetch,
    policy: () => loadEffectsFile(o.home),
    githubApp: () => store.githubApp(),
    githubToken: (repo, permission) => github.installationToken(repo, permission),
    jira: () => vendorConfig.jira ?? null,
    azure: () => azure,
    log: o.log,
    secrets: () => [...(o.secrets?.() ?? []), ...github.secrets()],
  });
  reads.start();

  const socket = new SlackSocket({ fetch: o.fetch, config: () => slackConfig, sink: (e) => relay.event(e), log: o.log });
  void socket
    .start()
    .then((why) => {
      if (why && slackConfig.enabled) o.log(why);
    })
    .catch((e) => o.log(`Slack: ${(e as Error)?.message ?? e}`));

  return {
    store,
    runner,
    async stop() {
      socket.stop();
      await reads.stop();
      await poll.stop();
      await runner.stop();
      if (!o.store) store.close();
    },
  };
}
