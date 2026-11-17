/**
 * A standing seat whose runtime is `api` (runners/api.ts): an agent loop on the Anthropic Messages
 * API, with the room's operations as its only tools. It needs no CLI and no checkout, so the runner
 * host runs it on its own branch (runner/host.ts), through the job's route on the egress proxy like
 * any other seat, so the policy gate, the seat's budgets and receipts all apply.
 *
 * Its key is this process's own: `PARLEY_HOUSE_ANTHROPIC_KEY`, else `ANTHROPIC_API_KEY`. It is never
 * in a job, never sent to the relay, and no agent CLI runs beside it to read it.
 *
 * Crossroom's own agent (a house job, `StartSeatPayload.house`) spends a workspace's credit, which
 * the relay's ledger keeps: `relaySpendGate` asks the relay to hold each model request's worst case
 * and settles the real cost after, on the runner's session (`POST /api/runner/jobs/:id/spend`).
 */
import { type RequestUsage, type SpendGate, settledMicro } from '@parley/shared/house';
import type { SpendAnswer, SpendInput } from '@parley/shared/runner';

/** The Anthropic API key an `api` seat runs on here, or undefined. */
export const apiSeatKey = (env: NodeJS.ProcessEnv): string | undefined =>
  (env.PARLEY_HOUSE_ANTHROPIC_KEY ?? '').trim() || (env.ANTHROPIC_API_KEY ?? '').trim() || undefined;

/** What the gate needs of the relay client (`RelayClient.spend`). */
export interface SpendRelay {
  spend(jobId: string, input: SpendInput): Promise<SpendAnswer>;
}

/** A refusal no later try changes: the job is gone, or the answer was not one. Anything else (the network, a 5xx, a restart) is tried again. */
const final = (e: unknown): boolean => {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 404 || status === 400 || status === 410;
};

export interface RelaySpendOptions {
  /** How long a reserve keeps trying while the relay does not answer (a deploy), before the seat says it could not check: 3 minutes. */
  reserveForMs?: number;
  /** How long a settle keeps trying: 5 minutes. A hold never settled is settled by the relay at its full amount. */
  settleForMs?: number;
  /** The first pause between tries; each pause doubles, to 15 s. */
  firstPauseMs?: number;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The `SpendGate` of one house job, over the relay's ledger. Each `reserve` is a hold the relay keeps
 * as a row; `settle` names the hold, so the relay counts it exactly once whatever restarts in
 * between, and a settle sent again is answered as the first was. A relay that does not answer (a
 * deploy) is tried again for a while before a reserve gives up, so a restart of the relay does not
 * stop the seat.
 */
export function relaySpendGate(relay: SpendRelay, jobId: string, o: RelaySpendOptions = {}): SpendGate {
  const holds: Array<{ micro: number; hold: string }> = [];
  const pause0 = o.firstPauseMs ?? 1000;
  const retrying = async <T>(what: string, forMs: number, fn: () => Promise<T>): Promise<T> => {
    const end = Date.now() + forMs;
    let pause = pause0;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        if (final(e) || Date.now() + pause > end) throw e;
        o.log?.(`spend: ${what} did not reach the relay (${(e as Error)?.message ?? e}); trying again in ${Math.round(pause / 1000)} s`);
        await sleep(pause);
        pause = Math.min(pause * 2, 15_000);
      }
    }
  };
  return {
    async reserve(micro: number): Promise<boolean> {
      const want = Math.ceil(micro);
      if (!Number.isFinite(want) || want < 0) return false;
      const r = await retrying('a reserve', o.reserveForMs ?? 180_000, () => relay.spend(jobId, { op: 'reserve', micro: want }));
      if (r.op !== 'reserve' || !r.ok) return false;
      holds.push({ micro: want, hold: r.hold });
      return true;
    },
    async settle(reservedMicro: number, actualMicro: number, usage?: RequestUsage): Promise<void> {
      const want = Math.ceil(reservedMicro);
      const i = holds.findIndex((h) => h.micro === want);
      const h = i >= 0 ? holds.splice(i, 1)[0] : holds.shift();
      if (!h) return;
      // The real cost, even past the hold: the relay records what Anthropic bills, within its bound.
      const s = settledMicro(h.micro, actualMicro);
      if (s.over) o.log?.(`spend: a request cost ${Math.ceil(actualMicro)} micro-dollars, over the ${h.micro} reserved for it`);
      const actual = s.micro;
      try {
        await retrying('a settle', o.settleForMs ?? 300_000, () => relay.spend(jobId, { op: 'settle', hold: h.hold, reservedMicro: h.micro, actualMicro: actual, ...(usage ? { usage } : {}) }));
      } catch (e) {
        o.log?.(`spend: a settle never reached the relay (${(e as Error)?.message ?? e}); the relay settles its hold at the full amount`);
      }
    },
  };
}
