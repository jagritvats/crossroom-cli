/**
 * The runner's calls to its relay for effects, on the runner's own session:
 * `POST /api/runner/effects/lease`, `POST /api/runner/effects/:id`, and `POST /api/runner/events`
 * for what the runner saw (a pull request its poll found, a Slack command).
 *
 * They ride on `RelayClient`'s session handling (runner/client.ts, `runnerCall` over `onSession`):
 * registered first if need be, sent again once after a 401 or after the 410 of the runner's own new
 * registration, and every error scrubbed of every token the client holds.
 */
import type { RelayClient } from '../client.js';
import type { EffectsRelay } from './loop.js';
import { EFFECT_ID, EFFECT_LEASE_WAIT_S, type EffectReportResult, LeasedEffect, type RunnerEvent } from './wire.js';

/** A call on the runner's session, as `RelayClient.runnerCall` makes it. */
export type SessionCall = (method: 'POST', path: string, c?: { body?: unknown; timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>;

/** The client's session call, `RelayClient.runnerCall`. */
export function sessionCallOf(client: RelayClient): SessionCall {
  return (_method, path, o) => client.runnerCall(path, o);
}

export interface RunnerEventsRelay {
  /** `POST /api/runner/events`: one event the runner saw, for the relay's `on: runner` triggers. */
  event(e: RunnerEvent): Promise<void>;
}

export function effectsRelayOf(call: SessionCall): EffectsRelay & RunnerEventsRelay {
  return {
    async lease(input, signal) {
      const waitS = input.waitS ?? EFFECT_LEASE_WAIT_S.default;
      const out = (await call('POST', '/api/runner/effects/lease', { body: input, timeoutMs: waitS * 1000 + 15_000, ...(signal ? { signal } : {}) })) as {
        effects?: unknown;
      } | null;
      const list = Array.isArray(out?.effects) ? out.effects : [];
      const effects: LeasedEffect[] = [];
      const malformed: string[] = [];
      for (const e of list) {
        const p = LeasedEffect.safeParse(e);
        if (p.success) effects.push(p.data);
        else {
          const id = (e as { id?: unknown } | null)?.id;
          if (typeof id === 'string' && EFFECT_ID.test(id)) malformed.push(id);
        }
      }
      return { effects, malformed };
    },
    async report(effectId, input) {
      if (!EFFECT_ID.test(effectId)) throw new Error('that is not an effect id');
      const out = (await call('POST', `/api/runner/effects/${effectId}`, { body: input })) as EffectReportResult | null;
      if (!out || out.ok !== true) throw new Error("the relay's answer to an effect report is not what a runner expects");
      return out;
    },
    async event(e) {
      await call('POST', '/api/runner/events', { body: e });
    },
  };
}
