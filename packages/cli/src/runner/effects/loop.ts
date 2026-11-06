/**
 * What a runner does with each effect the relay leases it, from the seal to the report.
 *
 * For each effect, in this order, and nothing is posted unless every step says yes:
 * 1. **It opens** under this runner's X25519 key, in the envelope it was leased in (`openEffect`):
 *    `bad_seal`, `envelope_mismatch`.
 * 2. **It names this runner's relay** (`wrong_relay`), and was issued within `EFFECT_TTL_HOURS`
 *    and not ahead of this runner's clock (`stale`, `future`).
 * 3. **It is new here.** An effect this runner has finished is reported again as it ended (a post
 *    becomes `duplicate`), and never posted twice: the dedupe on the effect id. That check comes
 *    first of all. **And it is what was approved**: an effect carrying
 *    `approvedDigest` is refused `digest_mismatch` unless `effectDigest` over exactly what would be
 *    posted (kind, target, verdict, title, text) is that digest, and a kind `effects.yml` lists under
 *    `require_approval` is refused `unapproved` without one.
 * 4. **The runner's own policy allows it** (`effects.yml`, without which nothing is allowed, and a
 *    repository's `effects` section where one is given, which only narrows it): `policy`, or
 *    `policy_unreadable` for a file that does not check. A service is asked nothing about a target
 *    before the kind is allowed at all; a PagerDuty rule, which names services, reads the
 *    incident's service first.
 * 5. **What an earlier attempt may have posted is looked for** (`EffectPoster.find`, by its
 *    marker) when the store has the effect `posting`: the runner stopped between the call and the
 *    record. Found, it is reported `duplicate`; not found and out of time, `stale` or `future`.
 * 6. **It is marked `posting`, then posted**, and the outcome reported as a code. A failure worth
 *    retrying (the service did not answer, or said to slow down) is not reported: the lease runs
 *    out and the relay hands the effect over again, and step 5 runs then.
 *
 * Nothing the relay answers becomes a URL, a host or a credential, and every line logged goes
 * through `redactTokens` with every credential in play.
 */
import { timingSafeEqual } from 'node:crypto';
import type { EffectsStore } from './store.js';
import { EffectHttpError } from './http.js';
import { checkEffect, type EffectFacts, type EffectsSection, kindAllowedAnywhere } from './policy.js';
import { EffectSealError, openEffect } from './seal.js';
import { redactTokens } from '../keys.js';
import { sameRelay } from '../client.js';
import {
  EFFECT_CLOCK_SKEW_MS,
  EFFECT_KINDS,
  EFFECT_TTL_HOURS,
  type EffectCode,
  effectDigest,
  type EffectKindName,
  type EffectLeaseInput,
  type EffectPayload,
  type EffectReportInput,
  type EffectReportResult,
  GITHUB_KINDS,
  type LeasedEffect,
} from './wire.js';

/** Two sha256 hex digests compared with no early exit. */
const sameDigest = (a: string, b: string) => {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
};

/** The relay, as this loop reaches it with the runner's session (runner/effects/relay.ts). */
export interface EffectsRelay {
  lease(input: EffectLeaseInput, signal?: AbortSignal): Promise<{ effects: LeasedEffect[]; malformed: string[] }>;
  report(effectId: string, input: EffectReportInput): Promise<EffectReportResult>;
}

/** One service's posting of effects. */
export interface EffectPoster {
  /** This effect's post, if an earlier attempt made it (by its marker): the service's id for it, or null. Reads only. */
  find(p: EffectPayload): Promise<string | null>;
  /** Post it, carrying its marker. Answers the service's id for what was posted. */
  post(p: EffectPayload): Promise<string | null>;
  /** Every credential it holds now, for scrubbing. */
  secrets(): string[];
}

/** The policy's sources as they stand now, or why they cannot be read (every effect is then refused). */
export type PolicyNow =
  | {
      ok: true;
      sources: { name: string; section: EffectsSection | null }[];
      /** `effects.yml`'s `require_approval`: kinds posted only with a person's approval at a gate. */
      requireApproval?: readonly EffectKindName[];
    }
  | { ok: false; error: string };

export interface EffectsRunnerOptions {
  relay: EffectsRelay;
  /** This runner's id, its relay, and its X25519 private key (runner.db's identity). Null before it has one. */
  identity: () => { runnerId: string; relay: string; x25519Private: string } | null;
  store: EffectsStore;
  /**
   * Read again for every effect, so an edit to `effects.yml` holds from the next one. The effect
   * says which repository's policy applies. Awaited: a repository's policy is read with git.
   */
  policy: (effect: EffectPayload) => PolicyNow | Promise<PolicyNow>;
  github: EffectPoster;
  slack: EffectPoster;
  vendors: EffectPoster;
  /** A PagerDuty incident's service, for a `pagerduty_note` rule. */
  pagerdutyService?: (incident: string) => Promise<string | null>;
  log: (line: string) => void;
  /** Every other secret the runner holds (runner.db's), for scrubbing. */
  secrets?: () => readonly string[];
  now?: () => number;
}

/** What became of one effect here. `left` means nothing was reported: the relay hands it over again. */
export type Handled = { state: 'posted' | 'refused' | 'failed'; code: EffectCode; reported: boolean } | { left: true; code: EffectCode };

/** An effect's kind and target as the store keys it: never its body. */
export function targetKey(p: Pick<EffectPayload, 'kind' | 'target'>): string {
  const t = p.target as Record<string, unknown>;
  switch (p.kind) {
    case 'pr_comment':
      return `pr_comment ${t.repo}#${t.number}`;
    case 'check_run':
      return `check_run ${t.repo}@${t.sha}`;
    case 'issue':
      return `issue ${t.repo}`;
    case 'slack_reply':
      return `slack_reply ${t.channel}${t.thread ? `/${t.thread}` : ''}`;
    case 'linear_note':
    case 'jira_note':
      return `${p.kind} ${t.issue}`;
    case 'pagerduty_note':
      return `pagerduty_note ${t.incident}`;
  }
}

/** A pause that ends early when `signal` aborts, and at once when it already has (an abort event never fires twice). */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export class EffectsRunner {
  private readonly now: () => number;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly o: EffectsRunnerOptions) {
    this.now = o.now ?? Date.now;
  }

  private secrets(): string[] {
    const safe = (f: () => readonly string[]) => {
      try {
        return f();
      } catch {
        return [];
      }
    };
    return [
      ...safe(() => this.o.github.secrets()),
      ...safe(() => this.o.slack.secrets()),
      ...safe(() => this.o.vendors.secrets()),
      ...safe(() => this.o.store.knownSecrets()),
      ...safe(() => this.o.secrets?.() ?? []),
    ];
  }

  private log(line: string) {
    this.o.log(redactTokens(line, this.secrets()));
  }

  private async report(id: string, state: 'posted' | 'refused' | 'failed', code: EffectCode): Promise<boolean> {
    try {
      const r = await this.o.relay.report(id, { state, code });
      if (r.cancel) this.log(`Effect ${id}: the relay had withdrawn it.`);
      return true;
    } catch (e) {
      // The lease runs out and the effect comes back; the store says what it became, and that is reported then.
      this.log(`Effect ${id}: could not report ${state} to the relay (${(e as Error).message}); it will be reported when the relay hands it over again.`);
      return false;
    }
  }

  /** Finish an effect in the store and report it. */
  private async done(id: string, kind: string, target: string, state: 'posted' | 'refused' | 'failed', code: EffectCode, remoteId: string | null = null): Promise<Handled> {
    this.o.store.finish(id, kind, target, state, code, remoteId);
    if (state !== 'posted') this.log(`Effect ${id} (${kind}): ${state}, ${code}.`);
    return { state, code, reported: await this.report(id, state, code) };
  }

  /** One leased effect, through every check, posted at most once. */
  async handle(leased: LeasedEffect): Promise<Handled> {
    const id = leased.id;
    const kind: string = (EFFECT_KINDS as readonly string[]).includes(leased.kind) ? leased.kind : 'unknown';
    const me = this.o.identity();
    if (!me) return { left: true, code: 'not_configured' };

    // A finished effect is reported again as it ended, before anything else is looked at.
    const earlier = this.o.store.seen(id);
    if (earlier && earlier.state !== 'posting') {
      const state = earlier.state;
      const code = (state === 'posted' ? 'duplicate' : (earlier.code ?? 'error')) as EffectCode;
      return { state, code, reported: await this.report(id, state, code) };
    }

    // 1. The seal and its envelope.
    let p: EffectPayload;
    try {
      p = openEffect(leased.payload, me.x25519Private, { runnerId: me.runnerId, effectId: id, kind: leased.kind });
    } catch (e) {
      const code: EffectCode = e instanceof EffectSealError ? e.code : 'bad_seal';
      return await this.done(id, kind, '?', 'refused', code);
    }
    const target = targetKey(p);
    // An earlier attempt started to post it and did not record the answer: it may have landed.
    const recovering = earlier?.state === 'posting';

    // 2. The relay and the clock. An effect out of time is not posted, but one that may have
    // landed is looked for first (below), so what the runner reports is what happened.
    if (!sameRelay(p.relay, me.relay)) return await this.done(id, kind, target, 'refused', 'wrong_relay');
    const issued = Date.parse(p.issuedAt);
    const clock: EffectCode | null =
      !Number.isFinite(issued) || this.now() - issued > EFFECT_TTL_HOURS * 3600_000 ? 'stale' : issued - this.now() > EFFECT_CLOCK_SKEW_MS ? 'future' : null;
    if (clock && !recovering) return await this.done(id, kind, target, 'refused', clock);

    // 3b. An approved effect is what the person approved: its digest is recomputed over exactly what
    // would be posted, so a relay that changed a word after the approval is refused, not believed.
    if (p.approvedDigest !== undefined && !sameDigest(effectDigest(p), p.approvedDigest)) return await this.done(id, kind, target, 'refused', 'digest_mismatch');

    // 4. The runner's own policy, before any service is asked anything.
    const policy = await this.o.policy(p);
    if (!policy.ok) {
      this.log(`Effects are refused until the policy checks: ${policy.error}`);
      return await this.done(id, kind, target, 'refused', 'policy_unreadable');
    }
    // A kind the operator posts only with a person's approval, arriving without one.
    if (policy.requireApproval?.includes(p.kind) && p.approvedDigest === undefined) return await this.done(id, kind, target, 'refused', 'unapproved');
    if (!kindAllowedAnywhere(p.kind, policy.sources)) return await this.done(id, kind, target, 'refused', 'policy');
    const facts: EffectFacts = {};
    if (p.kind === 'pagerduty_note') {
      try {
        facts.pagerdutyService = (await this.o.pagerdutyService?.(p.target.incident)) ?? undefined;
      } catch (e) {
        return await this.failed(id, kind, target, e);
      }
    }
    const verdict = checkEffect(p, policy.sources, facts);
    if (!verdict.ok) return await this.done(id, kind, target, 'refused', verdict.code);

    // 5. What an earlier attempt may have posted is looked for before anything is posted again.
    const poster = this.posterOf(p.kind);
    if (recovering) {
      let found: string | null;
      try {
        found = await poster.find(p);
      } catch (e) {
        return await this.failed(id, kind, target, e);
      }
      if (found !== null) {
        this.log(`Effect ${id} (${kind}) had been posted already.`);
        return await this.done(id, kind, target, 'posted', 'duplicate', found);
      }
      if (clock) return await this.done(id, kind, target, 'refused', clock);
    }

    // 6. Marked, then posted.
    this.o.store.begin(id, kind, target);
    let remoteId: string | null;
    try {
      remoteId = await poster.post(p);
    } catch (e) {
      return await this.failed(id, kind, target, e);
    }
    this.log(`Effect ${id} (${kind}) posted.`);
    return await this.done(id, kind, target, 'posted', 'posted', remoteId);
  }

  private posterOf(kind: EffectKindName): EffectPoster {
    if (GITHUB_KINDS.includes(kind)) return this.o.github;
    if (kind === 'slack_reply') return this.o.slack;
    return this.o.vendors;
  }

  /** A post that did not go: retried later when it may, recorded and reported when it may not. */
  private async failed(id: string, kind: string, target: string, e: unknown): Promise<Handled> {
    if (e instanceof EffectHttpError) {
      if (e.transient) {
        this.log(`Effect ${id} (${kind}): ${e.message}; it is tried again when the relay hands it over again.`);
        return { left: true, code: e.code };
      }
      return await this.done(id, kind, target, e.code === 'kind_off' ? 'refused' : 'failed', e.code);
    }
    this.log(`Effect ${id} (${kind}): ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return await this.done(id, kind, target, 'failed', 'error');
  }

  /** Lease and handle effects until `stop`. One at a time: effects are few, and order is kept. */
  start(o: { waitS?: number; backoffMs?: number } = {}): void {
    if (this.running) return;
    const controller = new AbortController();
    this.controller = controller;
    const backoff = o.backoffMs ?? 5000;
    this.running = (async () => {
      while (!controller.signal.aborted) {
        try {
          const asked = Date.now();
          const { effects, malformed } = await this.o.relay.lease({ waitS: o.waitS ?? 45, max: 5 }, controller.signal);
          for (const bad of malformed) await this.report(bad, 'refused', 'bad_seal');
          for (const e of effects) {
            if (controller.signal.aborted) break;
            await this.handle(e);
          }
          // A relay parks a lease with nothing for it. One that answers nothing at once (an old
          // relay, a proxy in the way) is not asked again in a tight loop.
          if (!effects.length && !malformed.length && Date.now() - asked < 1000) await sleep(backoff, controller.signal);
        } catch (e) {
          if (controller.signal.aborted) break;
          this.log(`Effects: ${(e as Error)?.message ?? e}`);
          await sleep(backoff, controller.signal);
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.running?.catch(() => {});
    this.running = null;
    this.controller = null;
  }
}
