/**
 * Referrals: a person shares their link (`/r/<code>`), a friend signs up through it, and each of
 * three moments in the friend's first steps can reward either side:
 *
 * - `signup`: the friend's new account claims the referral;
 * - `first_room`: the friend's first room ends with at least two agents having joined it, among the
 *   rooms the friend's account keeps;
 * - `first_plan`: a workspace the friend made is first on a paid plan, when it starts or, where the
 *   programme says so, once it renews (the first real charge after a free first period).
 *
 * A reward is credit for Crossroom's agent (a grant, as the operator's offers make), a plan for some
 * days (a plan grant on the person's personal workspace), or a promotional price at their next
 * checkout (the payment provider's own discount, which the instance's operator configures there).
 * The instance's operator sets which reward each moment gives each side (`ReferralProgramme`).
 *
 * Zod-free and Node-free, so the web app imports it as it stands.
 */

export const REFERRAL_MILESTONES = ['signup', 'first_room', 'first_plan'] as const;
export type ReferralMilestone = (typeof REFERRAL_MILESTONES)[number];

export const REFERRAL_SIDES = ['referrer', 'referee'] as const;
/** `referrer` shared the link; `referee` signed up through it. */
export type ReferralSide = (typeof REFERRAL_SIDES)[number];

export const REFERRAL_PLANS = ['starter', 'team'] as const;
export type ReferralPlan = (typeof REFERRAL_PLANS)[number];

export type ReferralReward =
  | { kind: 'credit'; usd: number; days: number }
  | { kind: 'plan'; plan: ReferralPlan; days: number }
  | { kind: 'discount' };
export type ReferralRewardKind = ReferralReward['kind'];

export interface ReferralProgramme {
  /** Whether new referrals are taken and new rewards given. Off, rewards already given keep running. */
  on: boolean;
  /** For each moment, what each side receives (at most one reward of each kind). */
  rewards: Record<ReferralMilestone, Record<ReferralSide, ReferralReward[]>>;
  /** How many friends' referrals may reward one person, over all time. */
  maxPerReferrer: number;
  /** A new account claims a referral within this many days of being made. */
  joinWindowDays: number;
  /**
   * What every credit reward may add up to, over all time, in dollars: past it a credit reward is
   * not given (`capped`). The instance's whole exposure to referral credit. 0 gives no credit.
   */
  creditBudgetUsd: number;
  /**
   * When a friend's paid plan counts: `start`, once the subscription is live; `renewal`, once it has
   * renewed and is still active. A first period the promotional price made free charges nothing, so
   * `renewal` rewards only plans someone has paid for.
   */
  paidPlanWhen: ReferralPaidPlanWhen;
}

export const REFERRAL_PAID_PLAN_WHEN = ['start', 'renewal'] as const;
export type ReferralPaidPlanWhen = (typeof REFERRAL_PAID_PLAN_WHEN)[number];

export const REFERRAL_LIMITS = {
  creditUsdMax: 50,
  daysMax: 365,
  maxPerReferrerMax: 1000,
  joinWindowDaysMax: 30,
  rewardsPerSideMax: 3,
  creditBudgetUsdMax: 100_000,
} as const;

/**
 * What an instance offers until its operator says otherwise: the friend gets the promotional price on
 * their first plan, and the person who invited gets credit only once that plan is paid for. Nothing is
 * given for a signup or a room alone.
 */
export const REFERRAL_DEFAULTS: ReferralProgramme = {
  on: true,
  rewards: {
    signup: { referrer: [], referee: [{ kind: 'discount' }] },
    first_room: { referrer: [], referee: [] },
    first_plan: { referrer: [{ kind: 'credit', usd: 5, days: 30 }], referee: [] },
  },
  maxPerReferrer: 20,
  joinWindowDays: 7,
  creditBudgetUsd: 100,
  paidPlanWhen: 'start',
};

/** A referral code: eight letters and digits, with none that read alike (no 0, O, 1, I, L). */
export const REFERRAL_CODE = /^[A-HJKMNP-Z2-9]{8}$/;
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A code as typed or pasted, upper-cased and trimmed; null when it is not a code's shape. */
export function readReferralCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = v.trim().toUpperCase();
  return REFERRAL_CODE.test(c) ? c : null;
}

/** The link a person shares. */
export const referralLink = (origin: string, code: string): string => `${origin.replace(/\/+$/, '')}/r/${code}`;

const money = (usd: number): string => (Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`);
const PLAN_WORD: Readonly<Record<ReferralPlan, string>> = { starter: 'Starter', team: 'Team' };

/** One reward in words, for the account page and the operator's page. */
export function rewardWords(r: ReferralReward): string {
  if (r.kind === 'credit') return `${money(r.usd)} of credit for Crossroom's agent, for ${r.days} days`;
  if (r.kind === 'plan') return `the ${PLAN_WORD[r.plan]} plan free for ${r.days} days`;
  return 'a promotional price on their first paid plan';
}

export const MILESTONE_WORDS: Readonly<Record<ReferralMilestone, string>> = {
  signup: 'signs up',
  first_room: 'finishes their first room',
  first_plan: 'starts their first paid plan',
};

/** The words for a moment, with the paid plan said as the programme counts it. */
export const milestoneWords = (m: ReferralMilestone, when: ReferralPaidPlanWhen = 'start'): string =>
  m === 'first_plan' && when === 'renewal' ? 'pays for a second month of their first plan' : MILESTONE_WORDS[m];

// ---------------------------------------------------------------- the programme, checked

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const wholeIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const cents = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.round(v * 100) / 100 === v;

function parseReward(v: unknown, where: string): ReferralReward | string {
  if (!isObject(v)) return `${where}: a reward`;
  const L = REFERRAL_LIMITS;
  if (v.kind === 'credit') {
    if (Object.keys(v).some((k) => !['kind', 'usd', 'days'].includes(k))) return `${where}: a credit takes usd and days`;
    if (!cents(v.usd) || v.usd <= 0 || v.usd > L.creditUsdMax) return `${where}.usd: more than 0 and at most ${L.creditUsdMax}`;
    if (!wholeIn(v.days, 1, L.daysMax)) return `${where}.days: a whole number from 1 to ${L.daysMax}`;
    return { kind: 'credit', usd: v.usd, days: v.days };
  }
  if (v.kind === 'plan') {
    if (Object.keys(v).some((k) => !['kind', 'plan', 'days'].includes(k))) return `${where}: a plan takes plan and days`;
    if (v.plan !== 'starter' && v.plan !== 'team') return `${where}.plan: starter or team`;
    if (!wholeIn(v.days, 1, L.daysMax)) return `${where}.days: a whole number from 1 to ${L.daysMax}`;
    return { kind: 'plan', plan: v.plan, days: v.days };
  }
  if (v.kind === 'discount') {
    if (Object.keys(v).some((k) => k !== 'kind')) return `${where}: a discount takes nothing else`;
    return { kind: 'discount' };
  }
  return `${where}.kind: credit, plan or discount`;
}

/** The operator's programme, checked whole; a sentence saying what is wrong otherwise. */
export function parseReferralProgramme(body: unknown): ReferralProgramme | string {
  if (!isObject(body)) return 'expected a programme';
  const extra = Object.keys(body).filter((k) => !['on', 'rewards', 'maxPerReferrer', 'joinWindowDays', 'creditBudgetUsd', 'paidPlanWhen'].includes(k));
  if (extra.length) return `unexpected ${extra.join(', ')}`;
  if (typeof body.on !== 'boolean') return 'on: true or false';
  const L = REFERRAL_LIMITS;
  if (!wholeIn(body.maxPerReferrer, 0, L.maxPerReferrerMax)) return `maxPerReferrer: a whole number from 0 to ${L.maxPerReferrerMax}`;
  if (!wholeIn(body.joinWindowDays, 1, L.joinWindowDaysMax)) return `joinWindowDays: a whole number from 1 to ${L.joinWindowDaysMax}`;
  if (!cents(body.creditBudgetUsd) || body.creditBudgetUsd < 0 || body.creditBudgetUsd > L.creditBudgetUsdMax)
    return `creditBudgetUsd: from 0 to ${L.creditBudgetUsdMax}`;
  // A programme saved before `paidPlanWhen` existed reads as `start`, which is how it behaved.
  const paidPlanWhen = body.paidPlanWhen ?? 'start';
  if (paidPlanWhen !== 'start' && paidPlanWhen !== 'renewal') return 'paidPlanWhen: start or renewal';
  if (!isObject(body.rewards)) return 'rewards: one entry per moment';
  const unknownMoment = Object.keys(body.rewards).find((k) => !(REFERRAL_MILESTONES as readonly string[]).includes(k));
  if (unknownMoment) return `rewards: unexpected ${unknownMoment}`;
  const rewards = {} as ReferralProgramme['rewards'];
  for (const m of REFERRAL_MILESTONES) {
    const sides = body.rewards[m] ?? { referrer: [], referee: [] };
    if (!isObject(sides)) return `rewards.${m}: referrer and referee`;
    const unknownSide = Object.keys(sides).find((k) => !(REFERRAL_SIDES as readonly string[]).includes(k));
    if (unknownSide) return `rewards.${m}: unexpected ${unknownSide}`;
    rewards[m] = { referrer: [], referee: [] };
    for (const s of REFERRAL_SIDES) {
      const list = sides[s] ?? [];
      if (!Array.isArray(list) || list.length > L.rewardsPerSideMax) return `rewards.${m}.${s}: a list of at most ${L.rewardsPerSideMax}`;
      const seen = new Set<string>();
      for (const [i, item] of list.entries()) {
        const r = parseReward(item, `rewards.${m}.${s}[${i}]`);
        if (typeof r === 'string') return r;
        if (seen.has(r.kind)) return `rewards.${m}.${s}: at most one ${r.kind}`;
        seen.add(r.kind);
        rewards[m][s].push(r);
      }
    }
  }
  return {
    on: body.on,
    rewards,
    maxPerReferrer: body.maxPerReferrer,
    joinWindowDays: body.joinWindowDays,
    creditBudgetUsd: body.creditBudgetUsd,
    paidPlanWhen,
  };
}

// ---------------------------------------------------------------- views

/**
 * A reward's state:
 * - `given`: credit or a plan is on the workspace, or a promotional price is waiting for a checkout;
 * - `used`: a promotional price was taken at a checkout that made a paid plan;
 * - `waiting`: due, but there is no personal workspace yet to put it in;
 * - `capped`: not given, because a limit was reached: this person's rewarded friends, or the
 *   instance's budget for referral credit.
 */
export type ReferralRewardState = 'given' | 'used' | 'waiting' | 'capped';

export interface ReferralRewardView {
  milestone: ReferralMilestone;
  side: ReferralSide;
  reward: ReferralReward;
  state: ReferralRewardState;
  at: string;
}

/** What the programme offers, as anyone signed in may read it; a discount shows only where the provider has one. */
export interface ReferralOffer {
  rewards: ReferralProgramme['rewards'];
  joinWindowDays: number;
  paidPlanWhen: ReferralPaidPlanWhen;
}

/** `GET /api/account/referral`. */
export interface AccountReferralView {
  /** Referrals are on here: new ones are taken and rewards given. */
  offered: boolean;
  offer: ReferralOffer | null;
  /** The account's code, once it asked for one (`POST /api/account/referral/code`). */
  code: string | null;
  /** How many friends reached each moment through this account's link. Counts only, never who. */
  friends: Record<ReferralMilestone, number>;
  /** Rewards this account received, newest first. */
  rewards: ReferralRewardView[];
  /** When this account claimed a referral, or null. Never who referred it. */
  referredAt: string | null;
  /** The account may still claim a referral: none yet, and made within the window. */
  canClaim: boolean;
  /** This account's referrals have rewarded it as many times as the instance allows. */
  capReached: boolean;
}

export type ReferralClaimRefusal = 'off' | 'unknown_code' | 'own_code' | 'claimed' | 'too_old';

export const REFERRAL_CLAIM_REFUSED: Readonly<Record<ReferralClaimRefusal, string>> = {
  off: "Referrals aren't running on this Crossroom right now.",
  unknown_code: "That invite link isn't one Crossroom knows. Check it with the person who sent it.",
  own_code: "That's your own invite link. Send it to a friend instead.",
  claimed: 'This account has used an invite link already.',
  too_old: 'Invite links are for new accounts, used within a few days of signing up.',
};

/** One reward as the operator lists it: ids, kinds and numbers. */
export interface AdminReferralReward {
  id: string;
  milestone: ReferralMilestone;
  side: ReferralSide;
  beneficiaryId: string;
  reward: ReferralReward;
  state: ReferralRewardState;
  createdAt: string;
}

/** The operator's view: the programme, what gates it, totals, and the latest rewards. */
export interface AdminReferralView {
  programme: ReferralProgramme;
  /** The `referrals` flag: off, nothing is taken or given whatever the programme says. */
  flagOn: boolean;
  /** Crossroom's agent is offered (its flag on, not paused): without it, credit rewards are given but can't be spent. */
  houseOn: boolean;
  /** Whether a promotional price is configured with the payment provider, so a discount reward means anything. */
  discountConfigured: boolean;
  /** The instance's payment provider, or null where billing isn't set up: Polar's checkout may not ask for a card at a zero total. */
  provider: 'stripe' | 'polar' | null;
  totals: { codes: number; referrals: number } & Record<ReferralMilestone, number>;
  /** `creditUsd` is what given and waiting credit rewards add up to: what counts against the budget. */
  rewards: { given: number; used: number; waiting: number; capped: number; creditUsd: number };
  recent: AdminReferralReward[];
}

/** How many rewards the operator's list shows. */
export const ADMIN_REFERRAL_RECENT = 50;
