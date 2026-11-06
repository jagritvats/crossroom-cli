/**
 * Webhooks a room's owner sets: up to three https
 * addresses Crossroom tells, in a signed notice that carries no content, that something happened in
 * the room. The receiver reads content, if it wants it, through the owner's API with the owner's
 * own token.
 *
 * The one copy of the rules the server, the web app and the CLI share, so this module imports
 * nothing (no zod): the web imports it. The notice's JSON Schema is spec/schemas/webhook.envelope.json,
 * generated from the server's zod copy, which a test holds
 * to this one.
 */

/** The most webhooks one room has. */
export const WEBHOOKS_MAX = 3;
/** The longest address, in characters. */
export const WEBHOOK_URL_MAX = 2048;
/**
 * The shape a webhook's notice is sent in: `crossroom`, the signed notice below, or `teams`, the same
 * content-free fields as an Adaptive Card for a Microsoft Teams Workflows URL.
 */
export const WEBHOOK_FORMATS = ['crossroom', 'teams'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];
/** How the owner's dialog names each format. */
export const WEBHOOK_FORMAT_WORDS: Record<WebhookFormat, string> = { crossroom: 'Crossroom (signed JSON)', teams: 'Microsoft Teams (Workflows)' };

/** The notice's own version: `v` in every body. */
export const WEBHOOK_VERSION = 1;

/** The signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, as the SIEM push signs. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-crossroom-signature';
/** The notice's id, the same on every retry of it, so a receiver can drop a repeat. */
export const WEBHOOK_DELIVERY_HEADER = 'x-crossroom-delivery';
/** The notice's type: an event type, or `ping` for a test. */
export const WEBHOOK_EVENT_HEADER = 'x-crossroom-event';
/** How a test notice is typed. */
export const WEBHOOK_PING = 'ping';

/** How often a failed notice is tried again, in seconds after each failure: about an hour in all. */
export const WEBHOOK_RETRY_S: readonly number[] = [10, 30, 60, 120, 300, 600, 900, 1800];
/** After this many failures in a row, the webhook turns itself off and the owner is told. */
export const WEBHOOK_FAILURES_MAX = 20;
/** How many finished notices of each webhook are kept, for the owner's list. */
export const WEBHOOK_KEPT = 50;
/** How many notices may wait for one webhook; past that a notice is recorded as dropped. */
export const WEBHOOK_BACKLOG_MAX = 500;

/** The ids a notice may carry, each one Crossroom assigned and the event names. */
export const WEBHOOK_ID_KEYS = ['messageId', 'requestId', 'itemId', 'claimId', 'childId', 'inReplyTo', 'callId', 'label'] as const;
export type WebhookIdKey = (typeof WEBHOOK_ID_KEYS)[number];

/** Who acted, as a notice says it: the owner, Crossroom itself, or a seat (with its letter). */
export type WebhookActor = 'owner' | 'system' | 'seat';

/** The body of every notice (spec/schemas/webhook.envelope.json). Content-free by construction. */
export interface WebhookEnvelope {
  v: typeof WEBHOOK_VERSION;
  /** The notice's id, also `x-crossroom-delivery`. */
  id: string;
  roomId: string;
  /** The event's sequence number in the room's log; 0 for a test. */
  seq: number;
  /** The event's type, or `ping`. */
  type: string;
  actor: WebhookActor;
  /** The acting seat's letter, when a seat acted. */
  actorSlot?: string;
  /** Ids the event names. */
  ids?: Partial<Record<WebhookIdKey, string>>;
  createdAt: string;
}

/** A notice's outcome, as the owner's list shows it. */
export type WebhookDeliveryState = 'pending' | 'delivered' | 'failed' | 'dropped';

export interface WebhookDeliveryView {
  id: string;
  seq: number;
  type: string;
  state: WebhookDeliveryState;
  /** `ok`, `http_<status>`, or a code for what stopped it (`blocked`, `timeout`, `dns`, `network`...). */
  status: string | null;
  attempts: number;
  at: string;
}

/** One webhook, as its owner sees it: never the whole address back, never the secret. */
export interface WebhookView {
  id: string;
  /** The address's host (and port, when not 443). */
  host: string;
  /** The start of the address's path, cut short. */
  path: string;
  /** The event types it is told of, or `all`. */
  events: string[] | 'all';
  /** The shape its notices are sent in. */
  format: WebhookFormat;
  failures: number;
  disabledAt: string | null;
  createdAt: string;
  lastDeliveryAt: string | null;
  lastStatus: string | null;
  recent: WebhookDeliveryView[];
}

/** The owner's list (`GET /api/sessions/:id/webhooks`). */
export interface WebhookList {
  webhooks: WebhookView[];
  max: number;
  /** The event types a webhook may ask for. */
  types: string[];
  /** The formats this instance sends: `teams` only while its flag is on. */
  formats: WebhookFormat[];
}

/** The answer to adding one: the webhook, and its secret, shown this once. */
export interface WebhookCreated {
  webhook: WebhookView;
  secret: string;
}

/** The answer to a test. */
export interface WebhookTested {
  ok: boolean;
  status: string;
  webhook: WebhookView;
}

/** How a status code reads to the owner, in a few words. */
export function webhookStatusWords(status: string | null): string {
  if (!status) return 'not sent yet';
  if (status === 'ok') return 'delivered';
  const http = /^http_(\d{3})$/.exec(status);
  if (http) return `answered ${http[1]}`;
  const words: Record<string, string> = {
    blocked: 'address refused (inside a private network)',
    dns: 'name did not resolve',
    timeout: 'no answer within 5 s',
    network: 'could not connect',
    redirect: 'answered with a redirect',
    too_large: 'answer too large',
    scheme: 'not https',
    bad_url: 'not a valid address',
    credentials: 'address carries a password',
    key: 'its secret could not be opened',
    backlog: 'too many waiting',
    disabled: 'webhook turned off',
    removed: 'webhook removed',
    bad_notice: 'its notice could not be read',
  };
  return words[status] ?? status;
}
