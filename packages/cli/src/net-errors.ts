/**
 * The words for a request to an instance that never got an answer (reach.ts sends the requests).
 * No imports, so `cli.ts` can load it without a cycle.
 *
 * Node's `fetch` says only "fetch failed" and keeps the reason in `cause` (a DNS failure, a refused
 * connection, a certificate it did not trust, a redirect a token-carrying request refused), so the
 * reason is read from there.
 *
 * Proxies: Node's `fetch` connects directly unless Node was started with `NODE_USE_ENV_PROXY=1`
 * (Node 22.21 or later), and only then reads `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`. A
 * connection that failed while one of those is set says so, since that is the likeliest reason on
 * a network that allows nothing out but its proxy.
 */

/** How long a request may go unanswered before it counts as no answer. */
export const REQUEST_TIMEOUT_MS = 15_000;

export type Reason = 'dns' | 'refused' | 'timeout' | 'connect-timeout' | 'tls' | 'redirect' | 'reset' | 'unreachable' | 'other';

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

interface Cause {
  code?: unknown;
  message?: unknown;
  errors?: unknown;
}

/** The code and message behind a failed fetch: its `cause`, or the first of an AggregateError's (one try per address). */
function causeOf(e: unknown): { code: string; message: string } {
  let c = (e as { cause?: Cause } | null)?.cause ?? (e as Cause | null);
  if (Array.isArray(c?.errors) && c.errors.length) c = c.errors[0] as Cause;
  return { code: typeof c?.code === 'string' ? c.code : '', message: typeof c?.message === 'string' ? c.message : '' };
}

export function reasonOf(e: unknown): { reason: Reason; code: string; message: string } {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError') return { reason: 'timeout', code: '', message: '' };
  const { code, message } = causeOf(e);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return { reason: 'dns', code, message };
  if (code === 'ECONNREFUSED') return { reason: 'refused', code, message };
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return { reason: 'connect-timeout', code, message };
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') return { reason: 'reset', code, message };
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN') return { reason: 'unreachable', code, message };
  if (TLS_CODES.has(code) || /certificate/i.test(message)) return { reason: 'tls', code, message };
  if (/redirect/i.test(message)) return { reason: 'redirect', code, message };
  return { reason: 'other', code, message: message || String((e as { message?: unknown } | null)?.message ?? e) };
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

/** Whether `NO_PROXY` keeps a host off the proxy: `*`, the host, or a domain it ends in. */
function noProxy(host: string, env: NodeJS.ProcessEnv): boolean {
  const list = (env.NO_PROXY ?? env.no_proxy ?? '').split(/[,\s]+/).filter(Boolean);
  const bare = host.replace(/:\d+$/, '').toLowerCase();
  return list.some((entry) => {
    const e = entry.replace(/:\d+$/, '').replace(/^\*?\./, '').toLowerCase();
    return entry === '*' || bare === e || bare.endsWith(`.${e}`);
  });
}

const isLoopback = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname);

/** What a set proxy variable has to do with a connection that failed, or '' when nothing. */
function proxyNote(url: URL, env: NodeJS.ProcessEnv): string {
  const set = PROXY_VARS.find((v) => env[v]?.trim());
  if (!set || isLoopback(url.hostname) || noProxy(url.host, env)) return '';
  if (env.NODE_USE_ENV_PROXY === '1') return ` The request went through the proxy in ${set}: check that the proxy is up and allows ${url.host}.`;
  return ` ${set} is set, but Node connects directly unless it is started with NODE_USE_ENV_PROXY=1 (Node 22.21 or later): set that and run this again.`;
}

/**
 * The one line for a request that got no answer: `Couldn't reach <host> (<why>): <what to do>.`
 * Only the host is named, never the path, which may hold a seat token.
 */
export function unreachableLine(url: string, e: unknown, opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): { line: string; reason: Reason } {
  const u = new URL(url);
  const host = u.host;
  const env = opts.env ?? process.env;
  const { reason, code, message } = reasonOf(e);
  const s = Math.max(1, Math.round((opts.timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000));
  const seconds = s === 1 ? '1 second' : `${s} seconds`;
  const withProxy = (s: string) => s + proxyNote(u, env);
  switch (reason) {
    case 'dns':
      return { reason, line: withProxy(`Couldn't reach ${host} (DNS lookup failed): check your connection and the address, or name another instance with --relay <url>.`) };
    case 'refused':
      return {
        reason,
        line: withProxy(
          isLoopback(u.hostname)
            ? `Couldn't reach ${host} (connection refused): nothing is listening there. Start that Crossroom, or name another instance with --relay <url>.`
            : `Couldn't reach ${host} (connection refused): check the address, or name another instance with --relay <url>.`,
        ),
      };
    case 'timeout':
      return { reason, line: withProxy(`Couldn't reach ${host} (no answer in ${seconds}): it may be down or the network slow. Try again in a minute.`) };
    case 'connect-timeout':
      return { reason, line: withProxy(`Couldn't reach ${host} (the connection timed out): check your connection, or whether a firewall lets it through.`) };
    case 'reset':
      return { reason, line: withProxy(`Couldn't reach ${host} (the connection was cut off): try again; if it keeps happening, a firewall or proxy may be in the way.`) };
    case 'unreachable':
      return { reason, line: withProxy(`Couldn't reach ${host} (network unreachable): check your connection.`) };
    case 'tls':
      return {
        reason,
        line: withProxy(
          `Couldn't reach ${host} (its certificate was not trusted${code ? `: ${code}` : ''}): if your network inspects HTTPS through a proxy or antivirus, point NODE_EXTRA_CA_CERTS at its certificate.`,
        ),
      };
    case 'redirect':
      return {
        reason,
        line: `Couldn't reach ${host} (it answered with a redirect, which Crossroom does not follow, since the request may carry a token): use the address it moved to, with --relay <url>.`,
      };
    default:
      return { reason, line: withProxy(`Couldn't reach ${host} (${(message || 'the request failed').replace(/\s+/g, ' ').slice(0, 200)}): check the address, or name another instance with --relay <url>.`) };
  }
}

/** Whether an error is a fetch that never got an answer ("fetch failed", or a time limit running out). */
export function isFetchFailure(e: unknown): boolean {
  const err = e as { name?: unknown; message?: unknown } | null;
  return (err?.name === 'TypeError' && err.message === 'fetch failed') || err?.name === 'TimeoutError';
}

/** The line for a fetch that failed where the address is no longer known: the reason, without the host. */
export function fetchFailedLine(e: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const { reason, code, message } = reasonOf(e);
  const why =
    reason === 'dns' ? 'DNS lookup failed'
    : reason === 'refused' ? 'connection refused'
    : reason === 'timeout' || reason === 'connect-timeout' ? 'no answer in time'
    : reason === 'tls' ? `its certificate was not trusted${code ? `: ${code}` : ''}`
    : reason === 'redirect' ? 'it answered with a redirect, which Crossroom does not follow'
    : (message || 'the request failed').replace(/\s+/g, ' ').slice(0, 200);
  const set = PROXY_VARS.find((v) => env[v]?.trim());
  const proxy = set && env.NODE_USE_ENV_PROXY !== '1' ? ` ${set} is set, but Node connects directly unless it is started with NODE_USE_ENV_PROXY=1 (Node 22.21 or later).` : '';
  return `Couldn't reach Crossroom (${why}): check your connection, or name the instance with --relay <url>.${proxy}`;
}

