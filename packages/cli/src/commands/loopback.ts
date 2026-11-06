/**
 * Requests to the Crossroom on this computer, for commands that read a room server on the
 * loopback (`crossroom memory`). Through `node:http`, so no `Sec-Fetch-Mode` is sent (a digest read
 * here is never counted as a browser viewing the page), no redirect is followed, and answers are
 * bounded.
 */
import http from 'node:http';

/** What a request needs and what its answer gives: a subset of `fetch` that `app.request` also fits. */
export interface RoomRequest {
	method: 'GET' | 'POST';
	headers: Record<string, string>;
	body?: string;
	signal: AbortSignal;
	redirect: 'error';
}
export type RoomFetch = (url: string, init: RoomRequest) => Promise<{ status: number; text(): Promise<string> }>;

/** The most a room server's answer may be: a `wait` can carry several large packets. */
const ANSWER_MAX = 8 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The base as it will be used, or `undefined` when it is not a plain loopback origin: `http:`, one
 * of the three loopback names, a port, no credentials, no path beyond `/`, no query or fragment.
 */
export function loopbackBase(raw: unknown): string | undefined {
	if (typeof raw !== 'string' || raw.length > 64) return undefined;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) return undefined;
	if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || raw.includes('#') || raw.includes('?')) return undefined;
	return url.origin;
}

/** Requests to the loopback through `node:http`: no `Sec-Fetch-Mode`, no redirects followed, bounded answers. */
export const loopbackFetch: RoomFetch = (url, init) =>
	new Promise((resolve, reject) => {
		const target = new URL(url);
		const body = init.body;
		const request = http.request(
			{
				hostname: target.hostname.replace(/^\[|\]$/g, ''),
				port: target.port,
				path: target.pathname + target.search,
				method: init.method,
				headers: { ...init.headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) },
				signal: init.signal,
			},
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				response.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > ANSWER_MAX) request.destroy(new Error('answer too large'));
					else chunks.push(chunk);
				});
				response.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					resolve({ status: response.statusCode ?? 0, text: () => Promise.resolve(text) });
				});
				response.on('error', reject);
			},
		);
		request.on('error', reject);
		request.end(body);
	});
