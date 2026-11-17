/**
 * Crossroom's own agent: one seat in a room that Crossroom runs on its own Anthropic key, paid from
 * the room's workspace credit.
 *
 * The contract the pieces share:
 * - the `api` driver (runners/api.ts in the client) runs the seat and asks a `SpendGate` before
 *   every model request;
 * - the server's credit ledger implements `SpendGate` for one seat;
 * - the server seats it as a hosted seat whose runner is `api`;
 * - the web app reads `HouseCreditView`.
 *
 * Zod-free and Node-free, so the web app imports it as it stands. Every amount is an integer
 * number of micro-dollars (1 USD = 1_000_000), never a float.
 */

/** Micro-dollars in one dollar. */
export const MICRO = 1_000_000;

/** The model the house agent runs, unless the operator sets `PARLEY_HOUSE_MODEL` (decided 2026-11-06). */
export const HOUSE_MODEL = 'claude-sonnet-5-5';
/** Its effort, unless `PARLEY_HOUSE_EFFORT` says otherwise. */
export const HOUSE_EFFORT = 'medium';

/**
 * The grant of the offer seeded from the environment when an instance has none (`PARLEY_HOUSE_GRANT_USD`
 * overrides it); every other offer's amount is the operator's.
 */
export const HOUSE_GRANT_MICRO = 5 * MICRO;
/** The most one room may spend of it: what is reserved when the agent is seated. */
export const HOUSE_ROOM_CAP_MICRO = 750_000;
/** How long a grant of the seeded offer lasts. */
export const HOUSE_CREDIT_DAYS = 30;

/** Per-request bounds the driver keeps. */
export const HOUSE_MAX_TOKENS = 4_000;
export const HOUSE_MAX_MODEL_TURNS = 40;
export const HOUSE_SEARCHES_PER_TURN = 3;
export const HOUSE_SEARCHES_PER_SEAT = 15;

/**
 * List prices, micro-dollars per million tokens (equivalently, dollars per token × 10^12 / 10^6).
 * From Anthropic's published rates as of 2026-11-06; `prices.test.ts` pins them. A model missing
 * here is refused by the driver: it never spends at a price it does not know.
 */
export interface ModelPrice {
  input: number;
  output: number;
  /** 5-minute cache write (1.25x input). */
  cacheWrite: number;
  cacheRead: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-sonnet-5-5': { input: 2 * MICRO, output: 10 * MICRO, cacheWrite: 2_500_000, cacheRead: 200_000 },
  'claude-opus-5-5': { input: 4 * MICRO, output: 20 * MICRO, cacheWrite: 5 * MICRO, cacheRead: 200_000 },
  // Prompts up to 100K tokens; the driver keeps a room's prompt well under that. Cache rates are
  // the usual 1.25x and 0.1x of input until the pricing page says otherwise.
  'claude-haiku-5-5': { input: 100_000, output: 500_000, cacheWrite: 125_000, cacheRead: 10_000 },
};

/** One web search, at $10 per 1,000. */
export const WEB_SEARCH_MICRO = 10_000;

/** The parts of a Messages API `usage` object the cost reads. Absent fields count as zero. */
export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** What one response cost at list price, in micro-dollars, rounded up. Null for a model with no price. */
export function costMicro(model: string, u: UsageLike): number | null {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  const tokens =
    n(u.input_tokens) * p.input + n(u.output_tokens) * p.output + n(u.cache_creation_input_tokens) * p.cacheWrite + n(u.cache_read_input_tokens) * p.cacheRead;
  return Math.ceil(tokens / 1_000_000) + n(u.server_tool_use?.web_search_requests) * WEB_SEARCH_MICRO;
}

/**
 * What one web search's results may add to a request's input, in tokens. The results are billed as
 * input tokens of the same request, so a request allowed to search reserves this much input for each
 * search it may make, on top of the prompt. Typical, not the worst: a larger reservation would leave
 * the end of a room's credit unreservable, and a settle records any overrun in full anyway
 * (`settledMicro`), so the caps still see it.
 */
export const WEB_SEARCH_INPUT_TOKENS = 10_000;

/**
 * The most a request can cost before it is sent: every prompt token, and every search's results
 * (`WEB_SEARCH_INPUT_TOKENS` each), at the cache-write price (the dearest input rate), `maxTokens` of
 * output, and every search it may make. The driver reserves this; the ledger settles at what
 * `costMicro` says afterwards, even where that is more.
 */
export function worstCaseMicro(model: string, promptTokens: number, maxTokens: number, searches: number): number | null {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  const input = n(promptTokens) + n(searches) * WEB_SEARCH_INPUT_TOKENS;
  return Math.ceil((input * Math.max(p.cacheWrite, p.input) + n(maxTokens) * p.output) / 1_000_000) + n(searches) * WEB_SEARCH_MICRO;
}

/**
 * How far past its reservation a settled cost is believed. A request's real cost is recorded even when
 * it is more than was reserved (the ledger keeps what Anthropic bills, and every cap reads the ledger),
 * up to this many times the reservation: a cost beyond that is a garbage number, not a bill, and is
 * recorded at the bound, loudly.
 */
export const HOUSE_OVERRUN_MAX_FACTOR = 4;
/** The most one settle records, whatever the reservation: the runner's spend route refuses more. */
export const HOUSE_SETTLE_MAX_MICRO = 100_000_000;

/** What a settle records of `actualMicro` against `reservedMicro`: the actual cost, bounded, and whether it ran over or was cut. */
export function settledMicro(reservedMicro: number, actualMicro: number): { micro: number; over: boolean; clamped: boolean } {
  const reserved = n(Math.ceil(reservedMicro));
  const actual = n(Math.ceil(actualMicro));
  const bound = Math.min(reserved * HOUSE_OVERRUN_MAX_FACTOR, HOUSE_SETTLE_MAX_MICRO);
  const micro = Math.min(actual, bound);
  return { micro, over: actual > reserved, clamped: actual > bound };
}

type MaybePromise<T> = T | Promise<T>;

/**
 * What the driver asks before and after each model request. One gate per seat. `reserve` answers
 * false when the seat may not spend `micro` more (its room cap, its workspace's credit, the
 * instance's daily total, or the promo switched off); the driver then finishes the seat.
 * `settle` is called exactly once for every reserve that answered true, with the request's real
 * cost (0 when the request failed before the API billed anything).
 */
export interface SpendGate {
  reserve(micro: number): MaybePromise<boolean>;
  /**
   * `usage`, when the API answered, is what the request used, so the ledger can show where the money
   * went (requests, tokens, searches). Absent for a request that failed before it was billed.
   */
  settle(reservedMicro: number, actualMicro: number, usage?: RequestUsage): MaybePromise<void>;
}

/** What one answered model request used, as the driver reports it to `SpendGate.settle`. Counts, never text. */
export interface RequestUsage {
  model: string;
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheWrite: number;
  cacheRead: number;
  searches: number;
}

/** A Messages API `usage` object as `RequestUsage`, every count a non-negative integer. */
export function requestUsage(model: string, u: UsageLike): RequestUsage {
  return {
    model,
    inputTokens: Math.trunc(n(u.input_tokens)),
    outputTokens: Math.trunc(n(u.output_tokens)),
    cacheWrite: Math.trunc(n(u.cache_creation_input_tokens)),
    cacheRead: Math.trunc(n(u.cache_read_input_tokens)),
    searches: Math.trunc(n(u.server_tool_use?.web_search_requests)),
  };
}

/** A gate that never refuses: a self-hosted operator running the driver on their own key. */
export const UNMETERED: SpendGate = { reserve: () => true, settle: () => undefined };

/** Why a workspace has no credit to spend, for the claim route and the card. */
export type HouseUnavailable =
  | 'off'
  | 'not_signed_in'
  | 'not_a_member'
  | 'team_too_new'
  | 'team_too_small'
  | 'spent'
  | 'expired'
  | 'revoked'
  | 'promo_full'
  | 'promo_ended'
  /** The workspace's owner or an admin turned Crossroom's agent off for it. */
  | 'workspace_off';

/** `GET /api/orgs/:o/house`: what the workspace card shows. Never another workspace's numbers. */
export interface HouseCreditView {
  /** The promo is on for this instance. */
  offered: boolean;
  claimed: boolean;
  grantedMicro: number;
  spentMicro: number;
  /** Held by seats still running. */
  reservedMicro: number;
  expiresAt: string | null;
  /** About how many more rooms the rest buys, at the typical room's cost. */
  roomsLeft: number;
  /** Set when the workspace cannot spend: claimed or not. */
  unavailable?: HouseUnavailable;
  /** The last moment a workspace may claim, when the offer has one (`PARLEY_HOUSE_UNTIL`). */
  offerEndsAt?: string | null;
  model: string;
  /** The workspace's owner or an admin turned Crossroom's agent off for it (`POST /api/orgs/:o/house/settings`). */
  workspaceOff?: boolean;
  /** The live grants allocated to this workspace, soonest to expire first. `grantedMicro` above is their sum. */
  grants?: HouseWorkspaceGrant[];
  /** The live offer's amount, for words like "$10 for Crossroom's agent" (absent with no live offer). */
  offerGrantMicro?: number;
}

/** `POST /api/orgs/:o/house/settings`: the workspace's owner or an admin turns the agent off, or back on. */
export interface HouseSettingsInput {
  off: boolean;
}

/** One day of the check against Anthropic's cost report, for the operator (`GET /api/admin/house`). */
export interface HouseReconcileRow {
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
  /** What the ledger counted the house seats spending that day. */
  ledgerMicro: number;
  /** What Anthropic's cost report says the house key's workspace cost that day; null when it could not be read. */
  anthropicMicro: number | null;
  /** Anthropic's figure less the ledger's; null when it could not be read. */
  driftMicro: number | null;
  /** `ok`, `drift` (past 10% and $1: the offer paused itself), or `error` (the report could not be read). */
  status: 'ok' | 'drift' | 'error';
  /** For `error`, a short code (`http_401`, `network`); otherwise null. */
  note: string | null;
  checkedAt: string;
}

/** Why the offer is paused: the daily check found drift, or the operator paused it. Resumed by the operator only. */
export interface HousePause {
  pausedAt: string;
  by: 'reconcile' | 'operator';
  /** The day whose drift paused it, for `reconcile`. */
  day: string | null;
}

/** `GET /api/admin/house`: the instance's totals, the pause, and the daily check. */
export interface HouseAdminView {
  claims: number;
  grantedMicro: number;
  spentMicro: number;
  reservedMicro: number;
  todayMicro: number;
  totalMicro: number;
  dailyMicro: number;
  /** The `houseAgent` flag is on. */
  flagOn: boolean;
  /** Paused, by the daily check or the operator: new seats are refused and running ones finish. */
  paused: HousePause | null;
  /** Whether `PARLEY_HOUSE_ADMIN_KEY` and `PARLEY_HOUSE_ANTHROPIC_WORKSPACE` are both set. */
  reconcileConfigured: boolean;
  /** The latest days checked, newest first (at most 14). */
  reconcile: HouseReconcileRow[];
}

/** The daily check pauses the offer when the two figures differ by more than this share of the ledger's... */
export const HOUSE_DRIFT_SHARE = 0.1;
/** ...and by more than this much. */
export const HOUSE_DRIFT_MIN_MICRO = MICRO;

/** What a typical room costs, for `roomsLeft`: Sonnet 5.5, eight model turns, cached briefing. */
export const TYPICAL_ROOM_MICRO = 200_000;

/** The seat's name and its role line, as the room shows them. */
export const HOUSE_SEAT_NAME = "Crossroom's agent";
export const HOUSE_ROLE = 'Plans, reviews and moves the work forward with the other agents. Crossroom runs it on your workspace credit.';

/** One house seat's spend in a room: `GET /api/sessions/:id/house`. Numbers only. */
export interface HouseRoomSeat {
  participantId: string;
  spentMicro: number;
  /** What the seat still holds of its workspace's credit and has not spent (0 once settled). */
  reservedMicro: number;
  requests: number;
  /** Every input token: uncached, cache writes and cache reads. */
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  searches: number;
  /** The model its last request ran on, or null before any request. */
  model: string | null;
  settledAt: string | null;
}

export interface HouseRoomView {
  seats: HouseRoomSeat[];
}

/** One room Crossroom's agent was in, for a workspace's "Where it went": `GET /api/orgs/:o/house/rooms`. */
export interface HouseWorkspaceRoom {
  sessionId: string;
  /** Present only when the caller can read the room; otherwise the web resolves what it can. */
  title?: string;
  openedAt: string;
  spentMicro: number;
  requests: number;
  tokensIn: number;
  tokensOut: number;
}

export interface HouseWorkspaceRooms {
  rooms: HouseWorkspaceRoom[];
}

// ---------------------------------------------------------------- offers and personal grants
//
// Credit belongs to a person, not a workspace. The operator runs offers; a
// signed-in account claims at most one grant per offer; a grant is allocated to a workspace the
// account is a standing member of: its personal workspace by default, or a team workspace. A move
// from personal to a team is final: a grant in a team workspace never moves again. A workspace's
// credit is the sum of the live grants allocated to it; spending draws on the grant that expires
// first, and what a grant has not spent when it expires lapses.
//
// Routes (all JSON; every amount integer micro-dollars):
// - `GET  /api/account/house`              → AccountHouseView (signed in)
// - `POST /api/account/house/claim`        HouseClaimInput → AccountHouseView
// - `POST /api/account/house/move`         HouseMoveInput  → AccountHouseView (personal → team, final)
// - `GET  /api/orgs/:o/house`              → HouseCreditView (standing member; `grants` added)
// - `POST /api/orgs/:o/house/claim`        → HouseCreditView: claims the live offer straight into this workspace
// - `GET  /api/admin/house/offers`         → {offers: HouseOffer[]}
// - `POST /api/admin/house/offers`         HouseOfferInput → {offer}
// - `POST /api/admin/house/offers/update`  {id} & HouseOfferInput → {offer}
// - `POST /api/admin/house/offers/end`     {id} → {offer}: ends claiming now (grants already made keep running)
// - `POST /api/admin/house/grant`          HouseManualGrantInput → {grant}: the operator's own grant to one account
// - `POST /api/admin/house/grants/revoke`  {grantId} → {ok}: one grant stops at once
// - `GET  /api/admin/house/grants?offer=`  → {grants: HouseAdminGrant[]} (newest 200)

/** Who may claim an offer. */
export type HouseAudience = 'everyone' | 'new_accounts';

/** An offer the operator runs. */
export interface HouseOffer {
  id: string;
  /** The operator's own name for it, never shown to users ("Launch", "Design partners"). */
  name: string;
  grantMicro: number;
  /** How long a claimed grant lasts. */
  creditDays: number;
  /** The most every grant of this offer may add up to; claims stop when the next would pass it. */
  stockMicro: number;
  /** What its grants add up to so far. */
  grantedMicro: number;
  claims: number;
  /** Claiming opens and closes (ISO); null for "now" and "no end". */
  startsAt: string | null;
  endsAt: string | null;
  audience: HouseAudience;
  /** Paused by the operator: no new claims, grants already made keep running. */
  paused: boolean;
  createdAt: string;
}

export interface HouseOfferInput {
  name: string;
  grantUsd: number;
  creditDays: number;
  stockUsd: number;
  startsAt: string | null;
  endsAt: string | null;
  audience: HouseAudience;
  paused: boolean;
}

/** Bounds the operator's inputs are held to. */
export const HOUSE_OFFER_LIMITS = { grantUsdMax: 100, creditDaysMax: 365, stockUsdMax: 100_000, nameMax: 60 } as const;

/** What a user sees of an offer they may claim. */
export interface HouseOfferPublic {
  id: string;
  grantMicro: number;
  creditDays: number;
  endsAt: string | null;
}

/** Why an account can't claim an offer. */
export type HouseClaimRefusal = 'not_signed_in' | 'claimed' | 'not_eligible' | 'promo_full' | 'promo_ended' | 'off';

/** One grant, as its owner sees it. */
export interface HouseGrantView {
  id: string;
  offerId: string;
  grantedMicro: number;
  spentMicro: number;
  /** granted - spent, 0 once expired or revoked. */
  leftMicro: number;
  claimedAt: string;
  expiresAt: string;
  /** Where it is allocated. */
  orgId: string;
  orgName: string;
  orgKind: 'personal' | 'team';
  /** In a team workspace: it never moves again. */
  final: boolean;
  state: 'live' | 'spent' | 'expired' | 'revoked';
}

/** `GET /api/account/house`: the account's grants, and the offer it may still claim. */
export interface AccountHouseView {
  offered: boolean;
  /** The live offer this account may claim, if any. */
  claimable: HouseOfferPublic | null;
  /** Why not, when an offer is live but this account can't claim it. */
  refusal?: HouseClaimRefusal;
  grants: HouseGrantView[];
  /** Team workspaces this account may move a personal grant into (standing member, the agent not turned off there). */
  teams: Array<{ id: string; name: string }>;
}

/** `POST /api/account/house/claim`: claim the live offer (or `offerId`), into `orgId` (personal unless given). */
export interface HouseClaimInput {
  offerId?: string;
  orgId?: string;
}

/** `POST /api/account/house/move`: a personal grant into a team workspace, for good. */
export interface HouseMoveInput {
  grantId: string;
  orgId: string;
}

/** One grant as a workspace shows it (`HouseCreditView.grants`). */
export interface HouseWorkspaceGrant {
  /** The caller's own grant? Names are shown only for the caller's own; others read as "a member's". */
  mine: boolean;
  grantedMicro: number;
  leftMicro: number;
  expiresAt: string;
}

/** `POST /api/admin/house/grant`: the operator gives one account credit outside any offer. */
export interface HouseManualGrantInput {
  accountId: string;
  grantUsd: number;
  creditDays: number;
  /** Where it goes: the account's personal workspace unless given (a team it is a member of). */
  orgId?: string;
  /** For the audit entry only. */
  note?: string;
}

/** One grant as the operator lists it: ids and numbers, never content. */
export interface HouseAdminGrant {
  id: string;
  offerId: string;
  accountId: string;
  orgId: string;
  grantedMicro: number;
  spentMicro: number;
  claimedAt: string;
  expiresAt: string;
  state: HouseGrantView['state'];
}
