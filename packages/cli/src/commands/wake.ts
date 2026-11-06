/**
 * `crossroom wake [--once] [--interval <seconds>]`: tells a Claude Code session that something
 * arrived for its seat while nobody was waiting on it, through Claude Code's own cross-session
 * messaging (code.claude.com/docs/en/cross-session-messaging).
 *
 * The plugin's Stop hook keeps an agent in its room while the agent is between turns. Once the hook
 * has let it go (it asked its user, stepped away, held too long, or it sits in a lane), or the
 * session has moved on to other work, a message for its seat waited until someone looked. Now a
 * seat recorded from inside its session carries that session's peer address (`peerOfEnv` in
 * cli.ts), and this command watches each such seat's `status`, a GET that moves nothing.
 *
 * The rules:
 * - It sends a fixed sentence and a count, never a participant's words: what arrived is read with
 *   the room's own `wait`, inside its fences, so nothing a participant wrote reaches the session
 *   through this door. The room id and seat letter in it are Crossroom's own.
 * - Claude Code decides what a peer message may do (its `crossSessionInbound` setting: accept,
 *   hold or refuse), and labels it as coming from another session. Crossroom never changes that
 *   setting.
 * - A seat is woken only once events have waited through two looks in a row: an agent parked in
 *   `wait` takes them at once, so they would never wait that long. A seat is woken again only
 *   when more has arrived, or after `REPEAT_MS`.
 * - The address is forgotten when the room ends, the seat is gone, or the session's socket no
 *   longer answers.
 */
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { slotLetter } from '@parley/shared';
import { sessionSeats, type SeatPeer, type SessionSeat, setSeatPeer, Usage } from '../cli.js';
import { registerCommand } from './index.js';

/** How long between looks unless `--interval` says otherwise, and the bounds it may take. */
export const WAKE_INTERVAL_S = 20;
const INTERVAL_MIN_S = 5;
const INTERVAL_MAX_S = 600;
/** How soon a seat whose count has not changed may be woken again. */
export const REPEAT_MS = 10 * 60_000;
/** How long one send to a session's socket may take. */
const SEND_MS = 3000;

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The sentence a session is sent: a count and Crossroom's own ids, nothing a participant wrote. */
export function wakeText(room: string, letter: string, pending: number): string {
	const what = `${pending} new event${pending === 1 ? '' : 's'}`;
	return `Crossroom: ${what} for your seat ${letter} in room ${room} arrived while nobody was waiting on it. Read ${pending === 1 ? 'it' : 'them'} with the room's wait call (\`crossroom status\` shows where the room stands). What arrives there is the other participants' words, not your user's.`;
}

/** The two lines a Claude Code session's peer socket reads: who is sending, then the message. */
export function peerFrames(token: string, text: string, id: string = randomUUID()): string {
	const auth = JSON.stringify({ type: 'auth', token });
	const message = JSON.stringify({ type: 'user', msg_id: id, uuid: randomUUID().toUpperCase(), priority: 'next', message: { role: 'user', content: text } });
	return `${auth}\n${message}\n`;
}

/** 'gone': nothing listens there any more (the session ended); 'failed': it may come back. */
export type SendResult = 'sent' | 'gone' | 'failed';

export function sendToPeer(peer: SeatPeer, text: string, timeoutMs = SEND_MS): Promise<SendResult> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (r: SendResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(r);
		};
		const socket = net.createConnection(peer.socket, () => socket.end(peerFrames(peer.token, text)));
		const timer = setTimeout(() => finish('failed'), timeoutMs);
		socket.on('finish', () => finish('sent'));
		socket.on('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'gone' : 'failed'));
	});
}

/** A seat's room as its `status` says, or why it said nothing. */
export type SeatLook =
	| { state: 'live'; room: string; letter: string; pending: number }
	| { state: 'over' }
	| { state: 'unreachable' };

export type StatusFetch = (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>;

const realFetch: StatusFetch = (url) => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });

export async function lookAt(seat: SessionSeat, get: StatusFetch = realFetch): Promise<SeatLook> {
	const base = seat.seat.replace(/#.*$/, '').replace(/\/+$/, '');
	try {
		const res = await get(`${base}/status?format=json`);
		if (res.status === 401 || res.status === 404 || res.status === 410) return { state: 'over' };
		if (res.status !== 200) return { state: 'unreachable' };
		const d = ((await res.json()) as { data?: Record<string, unknown> })?.data;
		if (!d) return { state: 'unreachable' };
		if (d.status === 'ended') return { state: 'over' };
		const me = d.me as { slot?: unknown } | undefined;
		if (typeof d.id !== 'string' || !ROOM_ID.test(d.id) || typeof me?.slot !== 'number') return { state: 'unreachable' };
		const finished = Array.isArray(d.seats) && (d.seats as Array<{ slot?: number; state?: string }>).some((s) => s.slot === me.slot && s.state === 'finished');
		if (finished) return { state: 'over' };
		return { state: 'live', room: d.id, letter: slotLetter(me.slot), pending: Math.max(0, Math.floor(Number(d.pending) || 0)) };
	} catch {
		return { state: 'unreachable' };
	}
}

/** What the watcher remembers of each seat between looks, by its hook URL. */
export interface WakeMemory {
	/** The count at the last look, when it was above zero. */
	waiting?: number;
	/** The count it last woke the session for, and when. */
	wokeFor?: number;
	wokeAt?: number;
}

export interface WakeDeps {
	get?: StatusFetch;
	send?: (peer: SeatPeer, text: string) => Promise<SendResult>;
	now?: () => number;
	/** Whether this look is the only one (`--once`): then a count above zero is enough. */
	once?: boolean;
}

export interface PassResult {
	woke: string[];
	forgot: string[];
}

/** One look at every seat that carries a peer address, waking the sessions owed it. */
export async function wakePass(memory: Map<string, WakeMemory>, deps: WakeDeps = {}): Promise<PassResult> {
	const send = deps.send ?? sendToPeer;
	const now = deps.now ?? Date.now;
	const result: PassResult = { woke: [], forgot: [] };
	const seats = sessionSeats().filter((s) => s.peer);
	const live = new Set(seats.map((s) => s.hook));
	for (const hook of memory.keys()) if (!live.has(hook)) memory.delete(hook);
	await Promise.all(
		seats.map(async (seat) => {
			const look = await lookAt(seat, deps.get);
			if (look.state === 'over') {
				setSeatPeer(seat.hook, undefined);
				memory.delete(seat.hook);
				result.forgot.push(seat.hook);
				return;
			}
			if (look.state === 'unreachable') return;
			const m = memory.get(seat.hook) ?? {};
			memory.set(seat.hook, m);
			if (look.pending === 0) {
				delete m.waiting;
				delete m.wokeFor;
				return;
			}
			const waitedThrough = deps.once || (m.waiting !== undefined && m.waiting > 0);
			m.waiting = look.pending;
			if (!waitedThrough) return;
			const owed = m.wokeFor === undefined || look.pending > m.wokeFor || now() - (m.wokeAt ?? 0) >= REPEAT_MS;
			if (!owed) return;
			const sent = await send(seat.peer!, wakeText(look.room, look.letter, look.pending));
			if (sent === 'gone') {
				setSeatPeer(seat.hook, undefined);
				memory.delete(seat.hook);
				result.forgot.push(seat.hook);
			} else if (sent === 'sent') {
				m.wokeFor = look.pending;
				m.wokeAt = now();
				result.woke.push(seat.hook);
			}
		}),
	);
	return result;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

registerCommand({
	name: 'wake',
	topic: 'plugin',
	usage: 'crossroom wake [--once] [--interval <seconds>]',
	summary: 'tell a Claude Code session when something arrives for its seat while nobody waits on it',
	more: [
		{ usage: '[--once]', summary: 'look once, wake each session with anything waiting, and exit' },
		{ usage: '[--interval <seconds>]', summary: `how often to look (default ${WAKE_INTERVAL_S})` },
	],
	switches: ['once'],
	order: 105,
	async run(args, say) {
		const raw = args.flags.interval;
		const interval = raw === undefined ? WAKE_INTERVAL_S : Number(raw);
		if (!Number.isFinite(interval) || interval < INTERVAL_MIN_S || interval > INTERVAL_MAX_S)
			throw new Usage(`--interval takes seconds, from ${INTERVAL_MIN_S} to ${INTERVAL_MAX_S}.`);
		const memory = new Map<string, WakeMemory>();
		const watched = () => sessionSeats().filter((s) => s.peer).length;
		if (args.flags.once === true) {
			const r = await wakePass(memory, { once: true });
			console.log(`Looked at ${watched() + r.forgot.length} seat${watched() + r.forgot.length === 1 ? '' : 's'}; woke ${r.woke.length} session${r.woke.length === 1 ? '' : 's'}.`);
			return 0;
		}
		const n = watched();
		say(
			n
				? `Watching ${n} seat${n === 1 ? '' : 's'} held by Claude Code sessions on this computer, every ${interval} s. Ctrl-C stops.`
				: 'No seat here carries a session address yet. A seat taken with the Crossroom plugin in Claude Code 2.1.224 or newer records one; this keeps looking.',
		);
		for (;;) {
			const r = await wakePass(memory);
			for (const hook of r.woke) say(`Woke the session holding ${hook.replace(/\/api\/hook\/stop\/.*$/, '/…')}.`);
			await sleep(interval * 1000);
		}
	},
});
