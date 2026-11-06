/**
 * Slack, through Socket Mode, and **dormant**: nothing here connects or posts
 * unless the runner's environment sets `PARLEY_SLACK=1`, and the relay queues no Slack effect
 * unless its own `slackEffects` flag is on (off by default). Slack's terms for an App
 * that relays messages to a service are to be settled before it is turned on.
 *
 * When it is on:
 * 1. `apps.connections.open` with the App-level token (`PARLEY_SLACK_APP_TOKEN`, `xapp-…`)
 *    answers a WebSocket URL; the runner connects with Node's global `WebSocket`, outbound only.
 * 2. Every envelope is acknowledged at once, before anything else is done with it, well inside
 *    Slack's three seconds.
 * 3. A slash command and an `app_mention` become a runner event (`RunnerEvent`) carrying only what
 *    the person typed, the channel, and the thread to answer in: never their user id, their
 *    team's, or the command's `response_url`, which can post to the channel by itself.
 * 4. A `slack_reply` effect is posted with `chat.postMessage` and the bot token
 *    (`PARLEY_SLACK_BOT_TOKEN`, `xoxb-…`), in the thread, carrying its effect id as message
 *    metadata, which is what a retry looks for before it posts again. Its text is escaped
 *    (`slackText`), so nothing in it pages anyone or hides a link behind a label.
 */
import { callJson, EffectHttpError, type FetchLike, seg, serviceBase } from './http.js';
import { type EffectCode, type EffectPayload, effectTag, type RunnerEvent, SLACK_CHANNEL, SLACK_TS } from './wire.js';

export const SLACK_API = 'https://slack.com/api';
/** Slack's own limit on a message's text is 40,000 characters. */
const SLACK_TEXT_MAX = 39_000;
const METADATA_TYPE = 'parley_effect';

export interface SlackConfig {
  /** `PARLEY_SLACK=1`: without it nothing connects and nothing is posted. */
  enabled: boolean;
  bot: string | null;
  app: string | null;
  url: string;
}

export function slackConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SlackConfig {
  return {
    enabled: env.PARLEY_SLACK?.trim() === '1',
    bot: env.PARLEY_SLACK_BOT_TOKEN?.trim() || null,
    app: env.PARLEY_SLACK_APP_TOKEN?.trim() || null,
    url: serviceBase(env.PARLEY_SLACK_URL?.trim() || SLACK_API, 'PARLEY_SLACK_URL'),
  };
}

export const slackSecrets = (c: SlackConfig): string[] => [c.bot, c.app].filter((s): s is string => !!s);

/** Slack answers 200 with `{ok: false, error}`; this is that error as a code. */
function slackCode(error: unknown): { code: EffectCode; transient: boolean } {
  const e = String(error ?? '');
  if (['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'].includes(e)) return { code: 'auth', transient: false };
  if (['not_in_channel', 'channel_not_found', 'thread_not_found', 'is_archived'].includes(e)) return { code: 'not_found', transient: false };
  if (e === 'missing_scope' || e === 'restricted_action') return { code: 'forbidden', transient: false };
  if (e === 'ratelimited') return { code: 'rate_limited', transient: true };
  if (e === 'internal_error' || e === 'service_unavailable' || e === 'fatal_error') return { code: 'network', transient: true };
  return { code: 'rejected', transient: false };
}

async function slackCall(o: { fetch: FetchLike; url: string; token: string; method: 'GET' | 'POST'; body?: unknown; what: string; secrets: string[] }) {
  const res = await callJson({
    fetch: o.fetch,
    method: o.method,
    url: o.url,
    headers: { authorization: `Bearer ${o.token}`, ...(o.body !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}) },
    body: o.body,
    what: o.what,
    secrets: o.secrets,
  });
  const j = res.json as { ok?: boolean; error?: string } | null;
  if (!j?.ok) {
    const { code, transient } = slackCode(j?.error);
    throw new EffectHttpError(code, res.status, `${o.what}: Slack answered ${code}`, transient);
  }
  return j as Record<string, any>;
}

// ---------------------------------------------------------------- replies

/**
 * A reply's text as `chat.postMessage` must be given it: `&`, `<` and `>` escaped, as Slack asks of
 * any text it should print rather than act on. Its control syntax all opens with `<`: `<!channel>`,
 * `<!here>` and `<!everyone>` page a channel, `<!subteam^…>` a user group, `<@U…>` a person, and
 * `<https://…|label>` is a link that shows only its label. The digest's `quietMentions` was written
 * for a paste into Slack's composer, which reads a typed `@channel`; the API reads this syntax
 * instead, and nobody reads an automated reply before it is sent. Crossroom's own words hold none of
 * it, so the whole text is escaped. Cut to Slack's limit after escaping, never inside an entity.
 */
export function slackText(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (escaped.length <= SLACK_TEXT_MAX) return escaped;
  return `${escaped.slice(0, SLACK_TEXT_MAX - 1).replace(/&[a-z]{0,3}$/, '')}…`;
}

export class SlackEffects {
  constructor(private readonly o: { fetch: FetchLike; config: () => SlackConfig }) {}

  secrets(): string[] {
    return slackSecrets(this.o.config());
  }

  /** The bot token, while Slack is on here and the effect is a Slack reply; otherwise the refusal. */
  private bot(p: EffectPayload): { c: SlackConfig; bot: string; p: Extract<EffectPayload, { kind: 'slack_reply' }> } {
    if (p.kind !== 'slack_reply') throw new EffectHttpError('kind_off', 0, `${p.kind} is not a Slack effect`, false);
    const c = this.o.config();
    if (!c.enabled) throw new EffectHttpError('kind_off', 0, 'Slack is dormant on this runner (PARLEY_SLACK is not 1)', false);
    if (!c.bot) throw new EffectHttpError('not_configured', 0, 'this runner has no Slack bot token: set PARLEY_SLACK_BOT_TOKEN', false);
    return { c, bot: c.bot, p };
  }

  /**
   * This reply, if an earlier attempt posted it: its `ts`, or null. In its thread, or for a reply
   * with no thread (a slash command's) among the channel's messages since the effect was issued.
   * Reads only.
   */
  async find(effect: EffectPayload): Promise<string | null> {
    const { c, bot, p } = this.bot(effect);
    const oldest = Math.max(0, Math.floor(Date.parse(p.issuedAt) / 1000) - 60);
    const q = p.target.thread
      ? `conversations.replies?channel=${seg(p.target.channel)}&ts=${seg(p.target.thread)}&include_all_metadata=true&limit=200`
      : `conversations.history?channel=${seg(p.target.channel)}&oldest=${oldest}&include_all_metadata=true&limit=200`;
    const j = await slackCall({ fetch: this.o.fetch, url: `${c.url}/${q}`, token: bot, method: 'GET', what: 'looking for the reply posted before', secrets: slackSecrets(c) });
    const hit = (Array.isArray(j.messages) ? j.messages : []).find(
      (m: any) => m?.metadata?.event_type === METADATA_TYPE && m?.metadata?.event_payload?.effect_id === p.effectId,
    );
    return hit ? String(hit.ts) : null;
  }

  /** Post the reply, in its thread when it has one, with its effect id as message metadata. Answers its `ts`. */
  async post(effect: EffectPayload): Promise<string | null> {
    const { c, bot, p } = this.bot(effect);
    const j = await slackCall({
      fetch: this.o.fetch,
      url: `${c.url}/chat.postMessage`,
      token: bot,
      method: 'POST',
      body: {
        channel: p.target.channel,
        ...(p.target.thread ? { thread_ts: p.target.thread } : {}),
        text: slackText(p.text),
        parse: 'none',
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
        metadata: { event_type: METADATA_TYPE, event_payload: { effect_id: p.effectId, tag: effectTag(p.effectId) } },
      },
      what: 'posting a Slack reply',
      secrets: slackSecrets(c),
    });
    return typeof j.ts === 'string' ? j.ts : null;
  }
}

// ---------------------------------------------------------------- Socket Mode

/** What `WebSocket` must offer: Node's global one, or a test's. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: any) => void): void;
}
export type SocketFactory = (url: string) => SocketLike;

/** A Socket Mode URL: `wss://`, or `ws://` on loopback for a test's fake Slack. */
function socketUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'wss:') return u.toString();
    if (u.protocol === 'ws:' && /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(u.hostname)) return u.toString();
  } catch {
    // Not a URL.
  }
  return null;
}

/** A mention's text without the mention itself (`<@U0123> does PR 12 break orders?`). */
const withoutMentions = (text: string) => text.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '').trim();

/**
 * One Slack envelope as the event the runner reports, or null for one it does not report. Only
 * what the person typed, the channel, and the thread to answer in.
 */
export function eventOfEnvelope(env: any): RunnerEvent | null {
  if (!env || typeof env !== 'object') return null;
  if (env.type === 'slash_commands') {
    const p = env.payload ?? {};
    if (typeof p.channel_id !== 'string' || !SLACK_CHANNEL.test(p.channel_id)) return null;
    if (typeof p.command !== 'string' || !/^\/[a-z0-9-]{1,32}$/.test(p.command)) return null;
    if (typeof env.envelope_id !== 'string') return null;
    return {
      event: 'slack.command',
      id: env.envelope_id.slice(0, 200),
      command: p.command,
      text: String(p.text ?? '').slice(0, 4000),
      slack: { channel: p.channel_id },
    };
  }
  if (env.type === 'events_api') {
    const ev = env.payload?.event ?? {};
    if (ev.type !== 'app_mention' || typeof ev.channel !== 'string' || !SLACK_CHANNEL.test(ev.channel)) return null;
    const thread = typeof ev.thread_ts === 'string' ? ev.thread_ts : ev.ts;
    if (typeof thread !== 'string' || !SLACK_TS.test(thread)) return null;
    const id = typeof env.payload?.event_id === 'string' ? env.payload.event_id : env.envelope_id;
    if (typeof id !== 'string') return null;
    return { event: 'slack.mention', id: id.slice(0, 200), text: withoutMentions(String(ev.text ?? '')).slice(0, 4000), slack: { channel: ev.channel, thread } };
  }
  return null;
}

export interface SlackSocketOptions {
  fetch: FetchLike;
  config: () => SlackConfig;
  /** Where each event goes: the relay (`POST /api/runner/events`), through the runner's session. */
  sink: (event: RunnerEvent) => Promise<void> | void;
  socket?: SocketFactory;
  log?: (line: string) => void;
  /** The wait before connecting again after a close, in ms; it doubles, up to a minute. */
  backoffMs?: number;
}

export class SlackSocket {
  private ws: SocketLike | null = null;
  private stopped = false;
  private delay: number;
  private timer: NodeJS.Timeout | null = null;
  /** Deliveries seen, so one Slack retries is reported once. */
  private readonly seen = new Set<string>();
  connected = false;

  constructor(private readonly o: SlackSocketOptions) {
    this.delay = o.backoffMs ?? 1000;
  }

  /** Connect, unless Slack is dormant here or has no App-level token: answers why not, or null. */
  async start(): Promise<string | null> {
    const c = this.o.config();
    if (!c.enabled) return 'Slack is dormant on this runner: set PARLEY_SLACK=1 to turn it on.';
    if (!c.app) return 'Slack Socket Mode needs PARLEY_SLACK_APP_TOKEN (an xapp- token).';
    this.stopped = false;
    await this.connect();
    return null;
  }

  /** Connect, and on any failure try again later: a connection attempt never throws out of here. */
  private reconnect() {
    void this.connect().catch((e) => {
      this.o.log?.(`Slack: ${(e as Error)?.message ?? e}`);
      this.again();
    });
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.ws?.close();
    } catch {
      // Closed already.
    }
    this.ws = null;
    this.connected = false;
  }

  private again() {
    if (this.stopped || this.timer) return;
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, 60_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reconnect();
    }, wait);
    this.timer.unref?.();
  }

  private async connect() {
    const c = this.o.config();
    if (this.stopped || !c.enabled || !c.app) return;
    let url: string | null;
    try {
      const j = await slackCall({ fetch: this.o.fetch, url: `${c.url}/apps.connections.open`, token: c.app, method: 'POST', what: 'opening a Socket Mode connection', secrets: slackSecrets(c) });
      url = socketUrl(j.url);
    } catch (e) {
      this.o.log?.(`Slack: ${(e as Error).message}`);
      this.again();
      return;
    }
    // Stopped while Slack answered: open nothing.
    if (this.stopped) return;
    if (!url) {
      this.o.log?.('Slack: its answer named no WebSocket URL this runner connects to');
      this.again();
      return;
    }
    const make: SocketFactory = this.o.socket ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    let ws: SocketLike;
    try {
      ws = make(url);
    } catch (e) {
      this.o.log?.(`Slack: could not open its WebSocket (${(e as Error)?.message ?? e})`);
      this.again();
      return;
    }
    this.ws = ws;
    ws.addEventListener('message', (ev) => this.onMessage(ws, typeof ev?.data === 'string' ? ev.data : String(ev?.data ?? '')));
    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.connected = false;
        this.again();
      }
    });
    ws.addEventListener('error', () => {
      // A close follows.
    });
  }

  private onMessage(ws: SocketLike, data: string) {
    let env: any;
    try {
      env = JSON.parse(data);
    } catch {
      return;
    }
    // Acknowledged first, whatever it is, inside Slack's three seconds.
    if (typeof env?.envelope_id === 'string') {
      try {
        ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      } catch {
        // The socket closed; Slack delivers it again on the next one.
      }
    }
    if (env?.type === 'hello') {
      this.connected = true;
      this.delay = this.o.backoffMs ?? 1000;
      return;
    }
    if (env?.type === 'disconnect') {
      // Slack is moving this connection: open a new one, and let this one go.
      if (this.ws === ws) this.ws = null;
      this.connected = false;
      try {
        ws.close();
      } catch {
        // Closed already.
      }
      this.reconnect();
      return;
    }
    const event = eventOfEnvelope(env);
    if (!event || this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);
    void Promise.resolve()
      .then(() => this.o.sink(event))
      .catch((e) => this.o.log?.(`Slack: an event did not reach the relay (${(e as Error).message})`));
  }
}
