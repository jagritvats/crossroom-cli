/**
 * The plans and billing: Stripe or Polar over its
 * REST API, a seat count kept equal to a team workspace's members, and the webhook that sets a
 * workspace's plan.
 *
 * Free: at most two registered standing seats. Starter: $9 a month flat for a personal workspace
 * (one person, who invites others into rooms and work), five standing seats, ended rooms kept 30
 * days. Team: $20 a month for each member of a team workspace, standing seats without limit, ended
 * rooms kept until deleted. Standing seats are a limit, never what is billed. Askers never pay.
 * Test mode until TERMS.md is rewritten for a paid service and the provider's live switch is set;
 * until a provider's keys exist, the billing routes answer 404.
 *
 * Pure: zod and nothing from Node. The web app may import from here with `import type` only,
 * so its bundle carries no zod.
 */
import { z } from 'zod';
import type { OrgPlan } from './org.js';

/** The environment billing needs (`billing` flag `configured`). */
export const STRIPE_ENV = {
  secret: 'PARLEY_STRIPE_SECRET',
  webhookSecret: 'PARLEY_STRIPE_WEBHOOK_SECRET',
  /** Team's price (`price_…`): licensed, per unit, $20 a month; the quantity is the workspace's members. */
  seatPrice: 'PARLEY_STRIPE_SEAT_PRICE',
  /** The Starter plan's flat monthly price (`price_…`, licensed, $9). Optional: Starter is offered only with it. */
  starterPrice: 'PARLEY_STRIPE_STARTER_PRICE',
  /** `1` allows a live key. Until then only `sk_test_` keys are accepted. */
  live: 'PARLEY_STRIPE_LIVE',
} as const;

/** Whether a Stripe secret key is one this instance may use: a test key, or a live one with `PARLEY_STRIPE_LIVE=1`. */
export function stripeKeyAllowed(key: string | undefined, live: boolean): boolean {
  if (!key) return false;
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return true;
  return live && (key.startsWith('sk_live_') || key.startsWith('rk_live_'));
}

/**
 * Polar (polar.sh), the other provider: the merchant of record, so it collects and remits sales tax
 * and VAT itself, and pays out to a bank wherever its Stripe Connect payouts reach (India among
 * them). The token is an organisation access token (`polar_oat_…`); the product is Team's, with a
 * seat-based price ($20 a seat a month), by its id. Polar's sandbox (`sandbox-api.polar.sh`) is used until
 * `PARLEY_POLAR_LIVE=1`, as Stripe's test mode is until `PARLEY_STRIPE_LIVE=1`.
 */
export const POLAR_ENV = {
  token: 'PARLEY_POLAR_TOKEN',
  webhookSecret: 'PARLEY_POLAR_WEBHOOK_SECRET',
  product: 'PARLEY_POLAR_PRODUCT',
  /** The Starter plan's product (a $9 monthly price), by its id. Optional: Starter is offered only with it. */
  starterProduct: 'PARLEY_POLAR_STARTER_PRODUCT',
  /** `1` uses Polar's production API. Until then every call goes to Polar's sandbox. */
  live: 'PARLEY_POLAR_LIVE',
} as const;
/** `stripe` or `polar`, when an instance holds the keys of both. Otherwise the one whose keys are complete. */
export const BILLING_PROVIDER_ENV = 'PARLEY_BILLING_PROVIDER';

export type BillingProvider = 'stripe' | 'polar';
/** How the owner's page names each provider. */
export const BILLING_PROVIDER_NAMES: Record<BillingProvider, string> = { stripe: 'Stripe', polar: 'Polar' };

/** Polar's ids: UUIDs. */
export const POLAR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a Polar token is one of its access tokens (organisation or personal), not a webhook secret or a client id. */
export const polarTokenAllowed = (token: string | undefined): boolean => !!token && /^polar_(?:oat|pat)_[A-Za-z0-9_-]{8,200}$/.test(token);

/**
 * Which provider bills on this instance, from its environment (`get` reads one variable, trimmed or
 * undefined), or null when neither has every key it needs. An explicit `PARLEY_BILLING_PROVIDER`
 * picks one and never falls back to the other: an operator who named Polar and left a key out gets
 * no billing, not Stripe's.
 */
export function billingProviderOf(get: (name: string) => string | undefined): BillingProvider | null {
  const stripe = stripeKeyAllowed(get(STRIPE_ENV.secret), get(STRIPE_ENV.live) === '1') && !!get(STRIPE_ENV.webhookSecret) && !!get(STRIPE_ENV.seatPrice);
  const polar = polarTokenAllowed(get(POLAR_ENV.token)) && !!get(POLAR_ENV.webhookSecret) && POLAR_UUID.test(get(POLAR_ENV.product) ?? '');
  const named = get(BILLING_PROVIDER_ENV);
  if (named === 'stripe') return stripe ? 'stripe' : null;
  if (named === 'polar') return polar ? 'polar' : null;
  if (named) return null;
  return polar ? 'polar' : stripe ? 'stripe' : null;
}

export const FREE_SEATS = 2;
/**
 * Starter: a flat price a month for a personal workspace, with the record and a cap on standing
 * seats. A team workspace takes Team. The pricing page says the same numbers.
 */
export const STARTER_PRICE_USD = 9;
/** The standing seats a workspace on Starter may register. */
export const STARTER_SEATS = 5;
/** How long a workspace on Starter keeps its projects' ended rooms, at least. Team keeps them until deleted. */
export const STARTER_RETENTION_DAYS = 30;
/** The plans a checkout can start. */
export const PaidTier = z.enum(['starter', 'team']);
export type PaidTier = z.infer<typeof PaidTier>;
/** Team: a month's price of one member of a team workspace. */
export const MEMBER_PRICE_USD = 20;
/** The most seats one subscription holds (Polar's limit per subscription). */
export const MAX_BILLED_SEATS = 1000;
/** How far a `Stripe-Signature` timestamp may be from now. */
export const STRIPE_TOLERANCE_S = 300;
/** The events the webhook acts on. Every other type is recorded and ignored. */
export const STRIPE_EVENTS = ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed'] as const;
export type StripeEventType = (typeof STRIPE_EVENTS)[number];
/**
 * The Polar events the webhook acts on: every change to a subscription. Each one is read back from
 * Polar (`GET /v1/subscriptions/:id`) except `subscription.revoked`, which is final as it stands.
 */
export const POLAR_EVENTS = [
  'subscription.created',
  'subscription.updated',
  'subscription.active',
  'subscription.canceled',
  'subscription.uncanceled',
  'subscription.revoked',
  'subscription.past_due',
  'subscription.cycled',
  'subscription.paused',
  'subscription.resumed',
] as const;
export type PolarEventType = (typeof POLAR_EVENTS)[number];
/** The one 404 body of every billing route while the instance has no Stripe keys. */
export const BILLING_OFF = 'billing is not set up on this instance';

/** `POST /api/orgs/:o/billing/checkout` (the organisation's owner): a checkout for the Team or the Starter plan. */
export const CheckoutInput = z
  .object({
    returnPath: z.string().regex(/^\/[A-Za-z0-9._~/-]{0,200}$/).optional(),
    /** The plan to start; Team when left out, as before Starter existed. */
    plan: PaidTier.optional(),
  })
  .strict();
export type CheckoutInput = z.infer<typeof CheckoutInput>;
export interface CheckoutResult {
  /** Stripe's own page. */
  url: string;
}
/** An organisation's billing as its owner sees it. */
export interface BillingView {
  /** The billed plan: what the payment provider says. */
  plan: OrgPlan;
  /**
   * A plan the instance's operator granted the workspace without payment, while it holds: the
   * workspace is on the higher of it and `plan`, and no checkout is offered. Absent for none.
   */
  grant?: { plan: OrgPlan; expiresAt: string | null };
  status: string | null;
  periodEnd: string | null;
  /** The workspace's members, not suspended: what Team bills for. */
  members: number;
  /** The standing seats registered: a limit on Free and Starter, never billed. */
  registeredSeats: number;
  testMode: boolean;
  /** Who takes the payment. Absent from an older server, which billed through Stripe only. */
  provider?: BillingProvider;
  /** Whether this instance sells Starter (its price is configured). */
  starterOffered?: boolean;
  /** A personal workspace: Starter is its only paid plan, and a team workspace's is Team. */
  personal?: boolean;
  /**
   * The owner cancelled: the plan holds until `periodEnd`, nothing more is charged, and then the
   * workspace is on Free. Absent from an older server, and false while the plan renews.
   */
  cancelAtPeriodEnd?: boolean;
}

/** The reasons a cancellation may give, as Polar's `customer_cancellation_reason` and Stripe's `cancellation_details.feedback` name them. */
export const CANCEL_REASONS = ['too_expensive', 'missing_features', 'unused', 'switched_service', 'too_complex', 'low_quality', 'customer_service', 'other'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];
/** The longest comment a cancellation carries to the provider. */
export const CANCEL_COMMENT_MAX = 500;

/**
 * `POST /api/orgs/:o/billing/portal` (the organisation's owner): the provider's own page for this
 * workspace's billing, where the card is changed and invoices are read. Its address is short-lived.
 */
export interface PortalResult {
  url: string;
}

/**
 * `POST /api/orgs/:o/billing/cancel` (the organisation's owner): end the paid plan when the period paid
 * for ends (`{}`), or keep it after all (`{undo: true}`). Never ends a plan at once, and refunds nothing.
 */
export const CancelInput = z
  .object({
    undo: z.boolean().optional(),
    /** Why, if the owner says: one of the provider's own reasons (Polar's and Stripe's lists are the same). */
    reason: z.enum(CANCEL_REASONS).optional(),
    /** Anything else the owner wants to say, passed to the provider and kept nowhere here. */
    comment: z.string().trim().max(CANCEL_COMMENT_MAX).optional(),
  })
  .strict()
  .refine((b) => !(b.undo && (b.reason || b.comment)), 'a reason goes with a cancellation, not with keeping the plan');
export type CancelInput = z.infer<typeof CancelInput>;
export interface CancelResult {
  plan: OrgPlan;
  cancelAtPeriodEnd: boolean;
  periodEnd: string | null;
}
