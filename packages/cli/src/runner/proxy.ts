/**
 * The loopback egress proxy: the one door between a seat's agent CLI and
 * the room it sits in.
 *
 * A seat's token is the seat. Given to the CLI in an argument, an environment variable or a
 * config file, it is readable by the agent itself (a read-only shell can print its environment),
 * by every local user who can list processes (argv is world-readable on Linux), and by whatever
 * the CLI writes its config into. So the CLI is given none of it. It gets
 * `http://127.0.0.1:<port>/mcp/<nonce>`, where the nonce is 18 random bytes that mean something
 * only to this proxy, only while the job runs; the proxy adds `Authorization: Bearer <seat token>`
 * on the way out, to the one relay the job belongs to.
 *
 * What the proxy does, in order, for every request:
 * - It answers only a request for a loopback `Host` of its own port, with no `Origin` (a browser's
 *   request, DNS rebinding included, never reaches a route), for exactly `/mcp/<nonce>`. An
 *   absolute-form target (`GET http://elsewhere/...`) is refused: this is not a forward proxy, and
 *   where a call goes is fixed by the route, never by the request.
 * - Unknown, closed and malformed nonces all get one 404 body.
 * - A POST's body is read (at most `PROXY_BODY_MAX`) and, where the route has a gate, every
 *   `tools/call` except `wait` and `status` is decided before anything leaves the machine: the
 *   nine operations that carry an agent's words (`GatedOp`, `record`'s query included) go through
 *   the seat's policy, and a tool the policy does not know is refused. A refusal or a hold is
 *   answered here, as a JSON-RPC result (`isError` for a refusal; `resultType` only in the
 *   2026-07-28 era), and is never
 *   forwarded. A batch holding any `tools/call` gets 400, since answering part of a batch here and
 *   forwarding the rest has no honest shape.
 * - Everything else is forwarded as it came: method, body and the MCP headers
 *   (`PASS_REQUEST_HEADERS`), streaming the answer back, SSE included, whichever era the client
 *   speaks. Only `PASS_RESPONSE_HEADERS` come back. The answer to a gated call the gate let
 *   through is read whole when it is JSON and at most `ANSWER_READ_MAX`, so the gate is told what
 *   the relay did with it (`settle`: the room's label for a packet, or a refusal) and the lines the
 *   agent is owed go back with it (`notes`: its team's decisions on its held packets); a refusal
 *   or a hold answered here carries them too.
 * - Closing a route (the job ended) kills its nonce and aborts its calls in flight, so a parked
 *   `wait` ends at once rather than when the relay next answers.
 *
 * The proxy never logs a body, a header or a nonce.
 */
import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ContextKind } from '@parley/shared';
import { caseInsensitivePaths, checkOutbound } from '@parley/shared/policy';
import type { PolicyVerdict, SeatPolicy } from '@parley/shared/runner';
import type { BudgetUsed, EgressPolicy, GatedOp, OutboundCall, RunnerOnly } from './egress-types.js';

/** Random bytes in a route's nonce: 18, so 24 characters of base64url. */
export const NONCE_BYTES = 18;
const NONCE = /^[A-Za-z0-9_-]{24}$/;
/** The largest request body the proxy reads. A packet is at most 60,000 characters; this is well past any honest call. */
export const PROXY_BODY_MAX = 4 * 1024 * 1024;
/** The largest answer to a gated call the proxy reads whole, to record it and add the agent's notes; a larger one is passed on as it comes. */
export const ANSWER_READ_MAX = 1024 * 1024;

/** What a JSON-RPC answer to one `tools/call` says, or null when it is not one. */
export function toolAnswerOf(m: unknown): ToolAnswer | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const { error, result } = m as { error?: { message?: unknown }; result?: { isError?: unknown; content?: unknown } };
  if (error && typeof error === 'object') return { ok: false, text: typeof error.message === 'string' ? error.message : null };
  if (!result || typeof result !== 'object') return null;
  const first = Array.isArray(result.content) ? (result.content as Array<{ type?: unknown; text?: unknown }>).find((c) => c?.type === 'text' && typeof c.text === 'string') : undefined;
  return { ok: result.isError !== true, text: first ? (first.text as string) : null };
}

/** The label the room gave a shared packet, from Crossroom's own first words of the answer (`renderShared`: "Shared as X4."). */
export const sharedLabelOf = (text: string | null): string | null => (text ? (/^Shared as (X\d{1,6})\./.exec(text)?.[1] ?? null) : null);

/** What goes upstream from the CLI's request. Nothing else: not its cookies, not an `authorization` of its own, not its `host`. */
export const PASS_REQUEST_HEADERS = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'last-event-id'] as const;
/** What comes back from the relay's answer. */
export const PASS_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control', 'x-accel-buffering', 'allow'] as const;

/**
 * The operations that carry an agent's words out, which a gate decides (egress-types.ts): the eight
 * that put them in the room, and `record`, which a project room offers its
 * organisation's own standing seats and whose query goes to the relay. Refusing it as unknown left
 * those seats, the ones its `room` scope is built around, unable to read the record at all. The
 * same goes for a project room's `work`, `submit` and `report`: `submit` carries text
 * the policy reads for secrets and denied lines like any other. So does `board_set`,
 * whose key and value are the agent's words; `board` only reads, and goes ungated. And the typed
 * tools' three: a declaration, a call's args and a result are the agent's words. And `open_room`,
 * whose title, brief, seats and reason are the lead's words. And a lane's `file`,
 * `update` and `verify`, whose repro, notes and refs are the agent's words; `items` and
 * `pass` only read, and go ungated.
 */
export const GATED_OPS: readonly GatedOp[] = ['share_context', 'say', 'claim', 'position', 'request_context', 'decline_context', 'finish', 'join', 'record', 'work', 'submit', 'report', 'board_set', 'declare_tool', 'call_tool', 'tool_result', 'open_room', 'file', 'update', 'verify', 'autonomy'];
/**
 * The operations that carry nothing of the agent's out: forwarded without asking the gate. `subrooms`
 * sends nothing at all (its answer brings seat links in, once), so it is here though it is no GET.
 * `context` reads a sparse room's packets: its words to search for stay in the room
 * the seat already shares packets with, and it writes nothing.
 */
export const UNGATED_OPS: readonly string[] = ['wait', 'status', 'board', 'subrooms', 'context', 'items', 'pass'];

/** The one body for a path that opens nothing here: unknown, closed or malformed nonce. */
export const NO_ROUTE = 'nothing is served here';

/** One request, as a route's forwarder sends it on. `headers` holds `PASS_REQUEST_HEADERS` only. */
export interface ProxiedRequest {
  method: 'GET' | 'POST' | 'DELETE';
  headers: Headers;
  body: Uint8Array<ArrayBuffer> | null;
  /** Aborted when the CLI goes away or the route closes. */
  signal: AbortSignal;
}

/** Sends a request where the route's calls go, with the seat's credential. */
export type Forwarder = (req: ProxiedRequest) => Promise<Response>;

/** One tool call, as a gate sees it. */
export interface GateCall {
  op: string;
  args: Record<string, unknown>;
}

/** A relay's answer to a forwarded `tools/call`, as a gate reads it: whether it was taken, and its first text. */
export interface ToolAnswer {
  ok: boolean;
  text: string | null;
}

/** What the relay did with a call a gate let through, as the runner records it. */
export type ForwardedCall = { ok: true; packetLabel?: string | null } | { ok: false; text?: string | null };

export type GateDecision =
  | {
      action: 'forward';
      /** Told what the relay answered, once the proxy has read it (a JSON answer only). */
      settle?(answer: ToolAnswer): void;
      /** Lines owed to the agent, added to the answer the proxy passes back. */
      notes?(): string[];
    }
  | { action: 'refuse' | 'hold'; rule: string; message: string };

/** Decides a tool call before it leaves the machine. */
export interface OutboundGate {
  decide(call: GateCall): GateDecision | Promise<GateDecision>;
}

export interface RouteOptions {
  forward: Forwarder;
  gate?: OutboundGate;
}

/** A route a job holds: its URL for the CLI, and the close that kills it. */
export interface ProxyRoute {
  /** `http://127.0.0.1:<port>/mcp/<nonce>`. */
  readonly url: string;
  readonly nonce: string;
  /** Kill the nonce and abort every call in flight on it. Closing twice does nothing more. */
  close(): void;
  /** Calls in flight now. */
  inflight(): number;
}

interface Route extends RouteOptions {
  live: Set<{ ac: AbortController; res: ServerResponse }>;
}

/** A JSON-RPC message, as far as the proxy reads one. */
interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown; _meta?: Record<string, unknown> } & Record<string, unknown>;
}

const isToolsCall = (m: unknown): m is RpcMessage => !!m && typeof m === 'object' && (m as RpcMessage).method === 'tools/call';

/**
 * Whether a message opens the 2026-07-28 era: it carries the protocol version in
 * `_meta`, on a request with no session id. Only then does a direct answer carry `resultType`.
 */
function modern(m: RpcMessage, headers: IncomingMessage['headers']): boolean {
  if (headers['mcp-session-id']) return false;
  const v = m.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  return typeof v === 'string' && v.length > 0;
}

const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
};

/** The JSON-RPC answer a gate's refusal or hold is given, in the shape the client's era reads. */
export function gateAnswer(m: RpcMessage, d: Exclude<GateDecision, { action: 'forward' }>, isModern: boolean) {
  return {
    jsonrpc: '2.0',
    id: m.id ?? null,
    result: {
      content: [{ type: 'text', text: d.message }],
      ...(d.action === 'refuse' ? { isError: true } : {}),
      ...(isModern ? { resultType: 'complete' } : {}),
    },
  };
}

function readBody(req: IncomingMessage, max: number): Promise<Uint8Array<ArrayBuffer> | 'too_big'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        resolve('too_big');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

/**
 * One proxy per runner (or per `crossroom join`), on `127.0.0.1` and a port the system picks. Every
 * job adds a route and closes it when it ends.
 */
export class EgressProxy {
  private routes = new Map<string, Route>();
  private closed = false;

  private constructor(
    private server: http.Server,
    readonly port: number,
  ) {}

  /** Listen on the loopback address only. There is no option to listen anywhere else. */
  static start(): Promise<EgressProxy> {
    return new Promise((resolve, reject) => {
      let proxy: EgressProxy | null = null;
      const server = http.createServer((req, res) => {
        if (!proxy) return json(res, 503, { error: 'starting' });
        proxy.handle(req, res).catch(() => {
          if (!res.headersSent) json(res, 500, { error: 'the proxy failed' });
          else res.destroy();
        });
      });
      // A parked `wait` sends nothing for up to its whole timeout, and an SSE stream for longer.
      server.requestTimeout = 0;
      server.headersTimeout = 30_000;
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        proxy = new EgressProxy(server, (server.address() as AddressInfo).port);
        resolve(proxy);
      });
    });
  }

  /** Where the proxy listens, as the socket reports it: always `127.0.0.1`. */
  address(): AddressInfo {
    return this.server.address() as AddressInfo;
  }

  /** Add a job's route: a fresh nonce, whose calls go through `forward` (and `gate`, where given). */
  add(o: RouteOptions): ProxyRoute {
    if (this.closed) throw new Error('the egress proxy is closed');
    let nonce = randomBytes(NONCE_BYTES).toString('base64url');
    while (this.routes.has(nonce)) nonce = randomBytes(NONCE_BYTES).toString('base64url');
    const route: Route = { ...o, live: new Set() };
    this.routes.set(nonce, route);
    const url = `http://127.0.0.1:${this.port}/mcp/${nonce}`;
    return {
      url,
      nonce,
      close: () => {
        if (this.routes.get(nonce) !== route) return;
        this.routes.delete(nonce);
        for (const l of route.live) {
          l.ac.abort();
          l.res.destroy();
        }
        route.live.clear();
      },
      inflight: () => route.live.size,
    };
  }

  /** Routes open now. */
  size(): number {
    return this.routes.size;
  }

  /** Close every route and stop listening. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const r of this.routes.values())
      for (const l of r.live) {
        l.ac.abort();
        l.res.destroy();
      }
    this.routes.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return json(res, 421, { error: 'wrong host' });
    // A browser sends Origin on every cross-origin request that could write; a CLI sends none.
    if (req.headers.origin !== undefined) return json(res, 403, { error: 'no browsers here' });
    const target = req.url ?? '';
    const m = target.startsWith('/mcp/') ? /^\/mcp\/([^/?#]+)(?:\?[^#]*)?$/.exec(target) : null;
    const route = m && NONCE.test(m[1]!) ? this.routes.get(m[1]!) : undefined;
    if (!route) return json(res, 404, { error: NO_ROUTE });
    const method = req.method;
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') return json(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST, DELETE' });

    let body: Uint8Array<ArrayBuffer> | null = null;
    /** A gated call the gate let through: what it is told of the answer. */
    let passed: Extract<GateDecision, { action: 'forward' }> | null = null;
    if (method === 'POST') {
      const got = await readBody(req, PROXY_BODY_MAX);
      if (got === 'too_big') {
        json(res, 413, { error: 'request too large' }, { connection: 'close' });
        req.destroy();
        return;
      }
      body = got;
      if (route.gate) {
        const decided = await this.gate(route.gate, body, req, res);
        if (decided === 'answered') return;
        if (decided !== 'forward') passed = decided;
      }
    }

    const headers = new Headers();
    for (const h of PASS_REQUEST_HEADERS) {
      const v = req.headers[h];
      if (typeof v === 'string') headers.set(h, v);
    }
    const ac = new AbortController();
    const live = { ac, res };
    // The route may have closed while the body was read or the gate decided.
    if (this.routes.get(m![1]!) !== route) return json(res, 404, { error: NO_ROUTE });
    route.live.add(live);
    const done = () => route.live.delete(live);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    res.on('close', () => {
      done();
      if (res.writableFinished) return;
      ac.abort();
      // An answer whose source ignores the abort (a stream in this process) is let go of here.
      reader?.cancel().catch(() => {});
    });
    let upstream: Response;
    try {
      upstream = await route.forward({ method, headers, body, signal: ac.signal });
    } catch {
      done();
      if (ac.signal.aborted) return void res.destroy();
      return json(res, 502, { error: 'the relay did not answer' });
    }
    const out: Record<string, string> = {};
    for (const h of PASS_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v !== null) out[h] = v;
    }
    // A redirect is never followed and never passed on: where the seat's calls go is the route's to say.
    const status = upstream.status >= 300 && upstream.status < 400 ? 502 : upstream.status;
    if (status === 502 && upstream.status !== 502) {
      await upstream.body?.cancel().catch(() => {});
      return json(res, 502, { error: 'the relay answered with a redirect, which this proxy does not follow' });
    }
    const r = upstream.body?.getReader() ?? null;
    reader = r;
    /** What was read of the answer before it was known to be too large to read whole. */
    let head: Uint8Array[] = [];
    // A gated call's answer is read whole when it is JSON and small, so the runner records what the
    // relay did with the call and the agent gets the lines it is owed. Anything else streams.
    if (passed && r && status === 200 && /^application\/json\b/i.test(upstream.headers.get('content-type') ?? '')) {
      let size = 0;
      let whole = false;
      try {
        for (;;) {
          const { done: end, value } = await r.read();
          if (end) {
            whole = true;
            break;
          }
          head.push(value);
          size += value.byteLength;
          if (size > ANSWER_READ_MAX) break;
        }
      } catch {
        r.releaseLock();
        done();
        return void res.destroy();
      }
      if (whole) {
        r.releaseLock();
        done();
        let bytes = Buffer.concat(head);
        try {
          const msg = JSON.parse(bytes.toString('utf8')) as { result?: { content?: unknown } };
          const answer = toolAnswerOf(msg);
          if (answer) {
            try {
              passed.settle?.(answer);
            } catch {
              /* the ledger is the team's record, not a reason to lose the relay's answer */
            }
            const content = msg.result?.content;
            const notes = Array.isArray(content) ? (passed.notes?.() ?? []) : [];
            if (notes.length) {
              (content as unknown[]).push({ type: 'text', text: notes.join('\n') });
              bytes = Buffer.from(JSON.stringify(msg), 'utf8');
            }
          }
        } catch {
          /* not JSON after all: passed on as it came */
        }
        if (res.destroyed) return;
        res.writeHead(status, { ...out, 'content-length': String(bytes.length) });
        return void res.end(bytes);
      }
    }
    res.writeHead(status, out);
    // Headers go at once: an SSE stream may say nothing for a while.
    res.flushHeaders();
    if (!r) return void res.end();
    if (res.destroyed) {
      await r.cancel().catch(() => {});
      return;
    }
    for (const chunk of head) res.write(chunk);
    head = [];
    try {
      for (;;) {
        const { done: end, value } = await r.read();
        if (end) break;
        if (res.destroyed) break;
        if (!res.write(value))
          await new Promise<void>((go) => {
            res.once('drain', () => go());
            res.once('close', () => go());
          });
      }
      if (res.destroyed) await r.cancel().catch(() => {});
      else res.end();
    } catch {
      res.destroy();
    } finally {
      r.releaseLock();
      done();
    }
  }

  /** Decide a POST's tool calls. 'answered' when the proxy answered it itself; a gated call it let through comes back as its decision. */
  private async gate(gate: OutboundGate, body: Uint8Array, req: IncomingMessage, res: ServerResponse): Promise<'answered' | 'forward' | Extract<GateDecision, { action: 'forward' }>> {
    let msg: unknown;
    try {
      msg = JSON.parse(Buffer.from(body).toString('utf8'));
    } catch {
      // What cannot be read cannot be checked, so it does not leave.
      json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return 'answered';
    }
    if (Array.isArray(msg)) {
      if (msg.some(isToolsCall)) {
        json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'A batch may not carry tools/call through this runner.' } });
        return 'answered';
      }
      return 'forward';
    }
    if (!isToolsCall(msg)) return 'forward';
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (typeof name === 'string' && UNGATED_OPS.includes(name)) return 'forward';
    let decision: GateDecision;
    if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args))
      decision = { action: 'refuse', rule: 'malformed', message: "Refused: this call could not be checked against your team's policy, so it was not sent." };
    else {
      try {
        decision = await gate.decide({ op: name, args: args as Record<string, unknown> });
      } catch {
        decision = { action: 'refuse', rule: 'malformed', message: "Refused: this call could not be checked against your team's policy, so it was not sent." };
      }
    }
    if (decision.action === 'forward') return decision.settle || decision.notes ? decision : 'forward';
    if (msg.id === undefined || msg.id === null) {
      json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'tools/call needs an id' } });
      return 'answered';
    }
    json(res, 200, gateAnswer(msg, decision, modern(msg, req.headers)));
    return 'answered';
  }
}

/** A `Headers` as a plain object, names lowercased. */
export function headerObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

/** What any `fetch` looks like, so a caller passes in the one it uses (the tests refuse the global `fetch` elsewhere). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Forward to a relay's `/mcp` with the seat's token as a bearer credential: the token goes in a
 * header, never a path, so no access log keeps it. Redirects are errors: a relay that answered
 * with one would otherwise choose where the next call goes.
 */
export function relayForwarder(o: { relay: string; seatToken: string; fetch: FetchLike }): Forwarder {
  const target = `${o.relay.replace(/\/+$/, '')}/mcp`;
  return (r) => {
    const headers = new Headers(r.headers);
    headers.set('authorization', `Bearer ${o.seatToken}`);
    return o.fetch(target, {
      method: r.method,
      headers,
      body: r.body && r.body.length ? r.body : undefined,
      signal: r.signal,
      redirect: 'manual',
    });
  };
}

// ---------------------------------------------------------------- the policy, as a gate

const MESSAGE_OPS = new Set(['say', 'claim', 'position', 'request_context', 'decline_context']);
const UNKNOWN_TOOL = (op: string) =>
  `Refused: "${op.slice(0, 60)}" is not a call this runner's policy knows, so it was not sent. Use say, share_context, claim, position, request_context, decline_context, finish, wait or status.`;

/** Every argument as text, the way the policy reads fields: a list or a number is checked as what the relay would store. */
export function textFields(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/**
 * What a job's gate knows about its checkout, beside `RunnerOnly`: every name the repository's top
 * goes by in a path, so a deny glob anchored there (`config/prod/**`) also matches
 * `/home/ci/.parley/runner/jobs/<id>/repo/config/prod/db.yml`, `D:\runner\jobs\<id>\repo\...` and
 * `payments-api/config/prod/db.yml`. A job's checkout is a directory called `repo`, which is not
 * the team's name for it, so both are given. (`RunnerOnly` in egress-types.ts has no field for
 * this yet; runner/egress-policy.ts should read it the same way.)
 */
export interface RunnerCheckout extends RunnerOnly {
  repos?: readonly string[];
}

const RANK = { refuse: 2, hold: 1 } as const;
const rank = (v: PolicyVerdict) => (v.ok ? 0 : RANK[v.action]);

/**
 * `checkOutbound` from `@parley/shared/policy` as an `EgressPolicy`, with the two things only the
 * runner knows about its checkout: the names the repository's top goes by (`repos` here and in
 * the runner context, `RunnerCheckout`), so `payments-api/config/...` and `<job>/repo/config/...`
 * are read as `config/...`, and whether its file system ignores case. The check runs once per
 * name, since the shared check takes one, and the most severe verdict stands: more names can only
 * deny more. The runner host and `crossroom join` use `egressPolicy` (runner/egress-policy.ts)
 * instead, which reads the names the same way and bounds the whole check in time, as this does
 * not; this one is left for the proxy's own tests.
 */
export function outboundPolicy(o: { repo?: string; repos?: readonly string[]; platform?: string } = {}): EgressPolicy {
  const nocase = caseInsensitivePaths(o.platform ?? process.platform);
  return {
    check(call, policy, used, runner) {
      const fields = textFields(call.args);
      const out = { op: call.op, fields, source: call.packet?.source ?? fields.source ?? null, kind: call.packet?.kind ?? fields.kind };
      const names = [...new Set([o.repo, ...(o.repos ?? []), ...((runner as RunnerCheckout | undefined)?.repos ?? [])].filter((n): n is string => !!n))];
      let worst: PolicyVerdict | null = null;
      for (const repo of names.length ? names : [undefined]) {
        const v = checkOutbound(out, policy, used, { deniedLines: runner?.deniedLines, knownSecrets: runner?.knownSecrets, repo, nocase });
        if (!worst || rank(v) > rank(worst)) worst = v;
        if (rank(worst) === RANK.refuse) break;
      }
      return worst!;
    },
  };
}

export interface PolicyGateOptions {
  jobId: string;
  /** The seat label the job runs under. */
  label: string;
  policy: SeatPolicy;
  egress: EgressPolicy;
  /**
   * What only the runner knows. A function is asked again for every call, so the known-secret list
   * is the one the runner holds now: a seat or ask token it took after this job started counts too.
   * One that throws refuses the call.
   */
  runner?: RunnerCheckout | (() => RunnerCheckout);
  /** When the job started, for the minutes budget; now when left out. */
  startedAt?: number;
  now?: () => number;
  /**
   * Told every decision, content and all, for the outbound ledger and the review queue.
   * Never forwarded. Answers the ledger row it recorded, which `onForwarded` is told of.
   */
  onDecision?(call: OutboundCall, verdict: PolicyVerdict): number | undefined | void;
  /** What the relay did with a call this gate let through: the label the room gave a packet, or its refusal. */
  onForwarded?(outboundId: number, result: ForwardedCall): void;
  /**
   * Told every call this gate let through once the relay answered it, with the call as sent and the
   * relay's answer: notes between calls (runner/notes.ts) keep a `finish` the relay accepted.
   */
  onSent?(call: OutboundCall, answer: ToolAnswer): void;
  /** Lines the agent is owed (its team's decisions on its held packets), added to what its next call is answered. */
  notes?(): string[];
}

/** A gate over a seat's policy, counting what the seat has sent for the budget. */
export function policyGate(o: PolicyGateOptions): OutboundGate & { used(): BudgetUsed } {
  const now = o.now ?? Date.now;
  const started = o.startedAt ?? now();
  let messages = 0;
  let packets = 0;
  const used = (): BudgetUsed => ({ messages, packets, minutes: Math.floor(Math.max(0, now() - started) / 60_000) });
  return {
    used,
    decide(c) {
      if (!(GATED_OPS as readonly string[]).includes(c.op)) return { action: 'refuse', rule: 'malformed', message: UNKNOWN_TOOL(c.op) };
      const op = c.op as GatedOp;
      const a = c.args;
      const call: OutboundCall = {
        op,
        jobId: o.jobId,
        label: o.label,
        args: a,
        ...(op === 'share_context'
          ? {
              packet: {
                kind: (typeof a.kind === 'string' ? a.kind : 'text') as ContextKind,
                title: typeof a.title === 'string' ? a.title : '',
                body: typeof a.body === 'string' ? a.body : '',
                source: typeof a.source === 'string' ? a.source : null,
              },
            }
          : {}),
      };
      let verdict: PolicyVerdict;
      try {
        verdict = o.egress.check(call, o.policy, used(), typeof o.runner === 'function' ? o.runner() : o.runner);
      } catch {
        verdict = { ok: false, action: 'refuse', rule: 'malformed', message: "Refused: this call could not be checked against your team's policy, so it was not sent." };
      }
      let row: number | undefined;
      try {
        const r = o.onDecision?.(call, verdict);
        if (typeof r === 'number') row = r;
      } catch {
        /* the ledger is the team's record, not a reason to let a call through or stop the seat */
      }
      const notes = () => {
        try {
          return o.notes?.() ?? [];
        } catch {
          return [];
        }
      };
      if (verdict.ok) {
        if (op === 'share_context') packets++;
        else if (MESSAGE_OPS.has(op)) messages++;
        const settle = (a: ToolAnswer) => {
          try {
            o.onSent?.(call, a);
          } catch {
            /* notes are the seat's own record, never a reason to lose the relay's answer */
          }
          if (row === undefined) return;
          o.onForwarded?.(row, a.ok ? { ok: true, packetLabel: op === 'share_context' ? sharedLabelOf(a.text) : null } : { ok: false, text: a.text });
        };
        return { action: 'forward', ...(o.onForwarded || o.onSent ? { settle } : {}), ...(o.notes ? { notes } : {}) };
      }
      // Only a packet can wait for review; anything else a policy would hold is refused.
      const action = verdict.action === 'hold' && op === 'share_context' ? 'hold' : 'refuse';
      const owed = notes();
      return { action, rule: verdict.rule, message: owed.length ? `${verdict.message}\n\n${owed.join('\n')}` : verdict.message };
    },
  };
}
