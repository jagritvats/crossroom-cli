/**
 * The GitHub App's poll: every 60 s, the open pull requests of each repository
 * `effects.yml` watches, reported to the relay as `github.pull_request` runner events for its
 * `on: runner` triggers. The runner stays outbound only: GitHub sends it nothing, and nothing
 * listens for GitHub here.
 *
 * - A pull request is reported once per head: a new commit on it is a new event, the same commit
 *   again is not (`pr_seen` in `effects.db`), and a report that did not reach the relay is tried
 *   again on the next pass.
 * - The first pass over a repository reports nothing: it notes every pull request open already,
 *   every page of them, so starting a runner does not set off every playbook on every pull
 *   request left open for months, today or the next time one of them is touched.
 * - Only what the trigger's whitelist keeps is sent, each trusted field checked by the same
 *   pattern the relay checks it with (`RunnerEvent`); a pull request whose branch or author does
 *   not fit is skipped rather than reported with a field it could not use. The title and body are
 *   a stranger's words, which the relay fences. The paths it changes go too, for a trigger's
 *   `paths` filter.
 * - The relay deduplicates a pull request's event by repository, number and head, whichever of a
 *   fleet's runners reports it, and a Slack event by the id the runner sends, so runners
 *   watching the same repository need not coordinate.
 */
import type { GithubEffects } from './github.js';
import type { EffectsStore } from './store.js';
import { type RunnerEvent, RunnerEvent as RunnerEventSchema } from './wire.js';

export const POLL_MS = 60_000;
/** The row that says a repository has had its first pass. */
const BASELINE = { number: 0, head: 'baseline' } as const;

export interface PullPollOptions {
  github: GithubEffects;
  store: EffectsStore;
  /** The repositories to watch, as `effects.yml` says now. */
  repos: () => readonly string[];
  sink: (e: RunnerEvent) => Promise<void>;
  log: (line: string) => void;
  intervalMs?: number;
}

export class PullRequestPoll {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly o: PullPollOptions) {}

  /** One pass over every watched repository. Answers how many events reached the relay. */
  async tick(): Promise<number> {
    let sent = 0;
    for (const repo of this.o.repos()) {
      if (repo.endsWith('/*')) continue;
      const first = !this.o.store.prSeen(repo, BASELINE.number, BASELINE.head);
      let pulls: Awaited<ReturnType<GithubEffects['openPulls']>>;
      try {
        // The first pass reads every open pull request, so none open all along is ever reported.
        pulls = await this.o.github.openPulls(repo, first ? { all: true } : {});
      } catch (e) {
        this.o.log(`GitHub poll of ${repo}: ${(e as Error).message}`);
        continue;
      }
      for (const pr of pulls) {
        if (this.o.store.prSeen(repo, pr.number, pr.headSha)) continue;
        if (first) {
          this.o.store.notePr(repo, pr.number, pr.headSha);
          continue;
        }
        // What it changes, for a trigger's `paths` filter. The relay keeps one event per head, so a
        // list it could not read is not sent without it: the pull request is tried on the next pass.
        let paths: string[];
        try {
          paths = await this.o.github.pullFiles(repo, pr.number);
        } catch (e) {
          this.o.log(`GitHub poll of ${repo}: pull request ${pr.number}'s files could not be listed (${(e as Error).message}); it is reported on the next pass.`);
          continue;
        }
        const event = RunnerEventSchema.safeParse({
          event: 'github.pull_request',
          id: `${repo}#${pr.number}@${pr.headSha}`,
          repo,
          number: pr.number,
          head_sha: pr.headSha,
          head_ref: pr.headRef,
          base_ref: pr.baseRef,
          author: pr.author,
          title: pr.title.slice(0, 1000),
          body: pr.body.slice(0, 20_000),
          paths,
        });
        if (!event.success) {
          // Not reportable (a branch name no trigger could use): noted, so it is not looked at every minute.
          this.o.store.notePr(repo, pr.number, pr.headSha);
          continue;
        }
        try {
          await this.o.sink(event.data);
          this.o.store.notePr(repo, pr.number, pr.headSha);
          sent++;
        } catch (e) {
          this.o.log(`GitHub poll of ${repo}: pull request ${pr.number} did not reach the relay (${(e as Error).message}); it is reported on the next pass.`);
        }
      }
      if (first) this.o.store.notePr(repo, BASELINE.number, BASELINE.head);
    }
    return sent;
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = this.tick()
        .then(() => undefined)
        .catch((e) => this.o.log(`GitHub poll: ${(e as Error).message}`))
        .finally(() => {
          this.running = null;
        });
    };
    this.timer = setInterval(tick, this.o.intervalMs ?? POLL_MS);
    this.timer.unref?.();
    tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
