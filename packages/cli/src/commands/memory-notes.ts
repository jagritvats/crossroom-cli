/**
 * Crossroom's local copy of what each room it opened on this computer came to: one markdown note
 * per ended room in `<data>/memory/<roomId>.md`, and `memory/index.json` beside them. Written by the
 * `crossroom` command (`crossroom memory sync`, and implicitly as `ask` starts), never by a server.
 *
 * The rules:
 * - Only rooms whose owner token is in `cli-rooms.json`, on a loopback Crossroom, and never an
 *   end-to-end room: this computer holds no room key for one, and a plain copy here would undo the
 *   encryption its owner chose.
 * - Only ended rooms. A room the server answers as gone (deleted) loses its note on the next sync,
 *   since deleting a room means its record goes.
 * - The digest is read with the owner token from `GET /api/sessions/:id/minutes?style=digest` and
 *   `LOCAL_COPY_HEADER`, so the copy is not counted as a minutes export: it stays on this computer.
 *   The requests go through `node:http` (`loopbackFetch`), which follows no redirect.
 * - Every file is written whole (a temporary file renamed into place), readable by this user only,
 *   and the newest `MEMORY_KEPT` notes are kept.
 *
 * Each agent keeps its own memory in its own way (render.ts `MEMORY_NOTE` asks it to); this copy is
 * the owner's, for `crossroom memory` and for bringing earlier rooms into a new one (`--recall`).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slotLetter } from '@parley/shared';
import { LOCAL_COPY_HEADER } from '@parley/shared/protocol';
import { searchItems, searchTerms } from '@parley/shared/sparse';
import { oneLine } from '@parley/shared/text';
import { dataDir, type SavedRoom, savedRooms } from '../cli.js';
import { insideLocation, sameLocation } from '../paths.js';
import { loopbackBase, loopbackFetch, type RoomFetch } from './loopback.js';

/** Notes kept, newest first by when their room ended. */
export const MEMORY_KEPT = 200;
/**
 * The most an owner packet brought from earlier rooms may be: the join briefing shows an owner
 * packet whole only up to this many characters (`BRIEF_ITEM_CHARS` in render.ts).
 */
export const RECALL_MAX = 1500;
/** Rooms `--recall auto` brings at most. */
export const RECALL_AUTO_ROOMS = 3;
export const RECALL_TITLE = 'Notes from earlier rooms';

export interface MemorySeat {
	letter: string;
	name: string;
	provider: string | null;
}

export interface MemoryEntry {
	id: string;
	title: string;
	/** When the room ended (ISO). */
	ended: string;
	/** The directories its agents worked in, as far as this computer knows them. */
	dirs: string[];
	/** The room's topic, when the caller knew one. */
	topic?: string;
	seats: MemorySeat[];
	savedAt: string;
}

/** What the caller knows about a room that the server does not say: its directories, topic and each seat's agent. */
export interface MemoryHints {
	dirs?: string[];
	topic?: string;
	/** By slot. */
	providers?: (string | null)[];
}

export type RememberResult = 'written' | 'kept' | 'live' | 'e2ee' | 'gone' | 'unreachable' | 'refused';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TITLE_MAX = 160;
const NAME_MAX = 60;
const DIR_MAX = 400;
/** How long one request to this computer's Crossroom may take. */
const REQUEST_MS = 15_000;

export const memoryDir = () => path.join(dataDir(), 'memory');
const indexFile = () => path.join(memoryDir(), 'index.json');

/** The note's path for a room id, or undefined for an id that could not be a file name here. */
export function noteFile(id: string): string | undefined {
	return ID.test(id) ? path.join(memoryDir(), `${id}.md`) : undefined;
}

/** Writes `text` whole: a temporary file beside it, readable by this user only, renamed into place. */
function writeWhole(file: string, text: string) {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	try {
		writeFileSync(temp, text, { mode: 0o600 });
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

const isEntry = (e: unknown): e is MemoryEntry => {
	const x = e as MemoryEntry;
	return !!x && typeof x.id === 'string' && ID.test(x.id) && typeof x.title === 'string' && typeof x.ended === 'string' && Array.isArray(x.dirs) && Array.isArray(x.seats);
};

export function readIndex(): MemoryEntry[] {
	try {
		const list = JSON.parse(readFileSync(indexFile(), 'utf8')) as unknown;
		return Array.isArray(list) ? list.filter(isEntry) : [];
	} catch {
		return [];
	}
}

/** The index newest first, cut to `MEMORY_KEPT`; notes it no longer lists are removed. */
function writeIndex(list: MemoryEntry[]) {
	const sorted = [...new Map(list.map((e) => [e.id, e])).values()].sort((a, b) => b.ended.localeCompare(a.ended) || b.savedAt.localeCompare(a.savedAt));
	const kept = sorted.slice(0, MEMORY_KEPT);
	writeWhole(indexFile(), `${JSON.stringify(kept, null, 2)}\n`);
	const keep = new Set(kept.map((e) => `${e.id}.md`));
	let files: string[] = [];
	try {
		files = readdirSync(memoryDir());
	} catch {
		return;
	}
	for (const name of files) if (name.endsWith('.md') && !keep.has(name)) rmSync(path.join(memoryDir(), name), { force: true });
}

/** YAML's double-quoted scalar is JSON's string, so a value never breaks out of its line. */
const yaml = (s: string) => JSON.stringify(s);

/** The note as written: front matter, the digest as the room server rendered it, and where the full record is. */
export function noteText(entry: MemoryEntry, digest: string): string {
	const lines = [
		'---',
		`id: ${entry.id}`,
		`title: ${yaml(entry.title)}`,
		`ended: ${entry.ended}`,
		...(entry.dirs.length ? ['dirs:', ...entry.dirs.map((d) => `  - ${yaml(d)}`)] : ['dirs: []']),
		...(entry.topic ? [`topic: ${yaml(entry.topic)}`] : []),
		'seats:',
		...entry.seats.flatMap((s) => [`  - letter: ${s.letter}`, `    name: ${yaml(s.name)}`, `    provider: ${s.provider ? yaml(s.provider) : 'null'}`]),
		'---',
		'',
		digest.replace(/\s+$/, ''),
		'',
		`Full record: crossroom minutes ${entry.id}`,
		'',
	];
	return lines.join('\n');
}

/** The digest part of a note: between the front matter and the closing line. */
export function noteDigest(text: string): string {
	const body = text.replace(/\r\n/g, '\n');
	const end = body.startsWith('---\n') ? body.indexOf('\n---\n', 4) : -1;
	const after = end >= 0 ? body.slice(end + 5) : body;
	return after.replace(/\n*Full record: crossroom minutes \S+\s*$/, '').trim();
}

/** Rooms the owner told `crossroom memory forget` to drop, which a sync never writes again. */
const forgottenFile = () => path.join(memoryDir(), 'forgotten.json');
const FORGOTTEN_KEPT = 1000;

export function forgottenIds(): Set<string> {
	try {
		const list = JSON.parse(readFileSync(forgottenFile(), 'utf8')) as unknown;
		return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && ID.test(id)) : []);
	} catch {
		return new Set();
	}
}

/**
 * Removes a room's note and its index entry. True when there was one. With `forever`, the owner
 * asked: the room is remembered as forgotten, so a later sync does not write its note again.
 */
export function forgetNote(id: string, { forever = false }: { forever?: boolean } = {}): boolean {
	const file = noteFile(id);
	if (!file) return false;
	if (forever) {
		const kept = [id, ...[...forgottenIds()].filter((x) => x !== id)].slice(0, FORGOTTEN_KEPT);
		writeWhole(forgottenFile(), `${JSON.stringify(kept)}\n`);
	}
	const list = readIndex();
	const had = existsSync(file) || list.some((e) => e.id === id);
	if (!had) return false;
	rmSync(file, { force: true });
	writeIndex(list.filter((e) => e.id !== id));
	return true;
}

const clip = (s: string, max: number) => oneLine(s).slice(0, max);

interface OwnerSnapshot {
	session?: { id?: string; title?: string; status?: string; e2ee?: boolean; endedAt?: string | null };
	participants?: { slot?: number; name?: string; provider?: string | null; hosted?: { cwd?: string } | null }[];
}

const owned = (room: SavedRoom, extra: Record<string, string> = {}) => ({ 'x-parley-owner': room.owner, accept: 'application/json', ...extra });

async function get(send: RoomFetch, url: string, headers: Record<string, string>, signal?: AbortSignal) {
	const response = await send(url, { method: 'GET', headers, signal: signal ?? AbortSignal.timeout(REQUEST_MS), redirect: 'error' });
	return { status: response.status, text: await response.text() };
}

/**
 * Writes the note of one room this computer holds the owner token of, when it has ended and is not
 * end to end. A room the server no longer has loses its note.
 */
export async function rememberRoom(room: SavedRoom, options: { fetch?: RoomFetch; hints?: MemoryHints; signal?: AbortSignal } = {}): Promise<RememberResult> {
	const base = loopbackBase(room.base);
	if (!base || !ID.test(room.id) || !room.owner) return 'refused';
	const send = options.fetch ?? loopbackFetch;
	const at = `${base}/api/sessions/${encodeURIComponent(room.id)}`;
	let snap: { status: number; text: string };
	try {
		snap = await get(send, at, owned(room), options.signal);
	} catch {
		return 'unreachable';
	}
	if (snap.status === 404) {
		forgetNote(room.id);
		return 'gone';
	}
	if (snap.status !== 200) return 'unreachable';
	let body: OwnerSnapshot;
	try {
		body = JSON.parse(snap.text) as OwnerSnapshot;
	} catch {
		return 'unreachable';
	}
	if (body.session?.e2ee) return 'e2ee';
	if (body.session?.status !== 'ended') return 'live';
	let digest: { status: number; text: string };
	try {
		digest = await get(send, `${at}/minutes?style=digest`, owned(room, { accept: 'text/markdown', [LOCAL_COPY_HEADER]: '1' }), options.signal);
	} catch {
		return 'unreachable';
	}
	if (digest.status === 404) {
		forgetNote(room.id);
		return 'gone';
	}
	if (digest.status !== 200) return digest.status === 409 ? 'e2ee' : 'unreachable';
	const hints = options.hints ?? {};
	const participants = [...(body.participants ?? [])].filter((p) => typeof p.slot === 'number').sort((a, b) => a.slot! - b.slot!);
	const hostedDirs = participants.flatMap((p) => (typeof p.hosted?.cwd === 'string' ? [p.hosted.cwd] : []));
	const dirs = [...new Set([...(hints.dirs ?? room.dirs ?? []), ...hostedDirs].map((d) => clip(d, DIR_MAX)).filter(Boolean))];
	const topic = hints.topic ?? room.topic;
	const entry: MemoryEntry = {
		id: room.id,
		title: clip(body.session?.title || room.title || 'A Crossroom room', TITLE_MAX) || 'A Crossroom room',
		ended: typeof body.session?.endedAt === 'string' ? body.session.endedAt : new Date().toISOString(),
		dirs,
		...(topic ? { topic: clip(topic, TITLE_MAX) } : {}),
		seats: participants.map((p) => {
			const provider = hints.providers?.[p.slot!] ?? p.provider ?? null;
			return { letter: slotLetter(p.slot!), name: clip(p.name ?? '', NAME_MAX) || `Seat ${slotLetter(p.slot!)}`, provider: provider ? clip(provider, NAME_MAX) : null };
		}),
		savedAt: new Date().toISOString(),
	};
	writeWhole(noteFile(room.id)!, noteText(entry, digest.text));
	writeIndex([entry, ...readIndex().filter((e) => e.id !== room.id)]);
	return 'written';
}

export interface SyncResult {
	written: string[];
	removed: string[];
	/** Rooms on a Crossroom that did not answer. */
	unreachable: number;
}

/**
 * Brings the notes up to date with the rooms `cli-rooms.json` holds: each server asked once per
 * fifty rooms (`POST /api/sessions/lookup`, as `crossroom rooms` asks), then a note written for each
 * ended room that has none, and removed for each room its server no longer has.
 */
export async function syncMemory(options: { fetch?: RoomFetch; rooms?: SavedRoom[]; only?: (room: SavedRoom) => boolean } = {}): Promise<SyncResult> {
	const send = options.fetch ?? loopbackFetch;
	const rooms = (options.rooms ?? savedRooms()).filter((r) => loopbackBase(r.base) && ID.test(r.id) && (options.only?.(r) ?? true));
	const result: SyncResult = { written: [], removed: [], unreachable: 0 };
	const have = new Set(readIndex().map((e) => e.id));
	const forgotten = forgottenIds();
	for (const base of new Set(rooms.map((r) => loopbackBase(r.base)!))) {
		const mine = rooms.filter((r) => loopbackBase(r.base) === base);
		const found = new Map<string, { status?: string; e2ee?: boolean }>();
		let reached = true;
		for (let i = 0; i < mine.length; i += 50) {
			try {
				const response = await send(`${base}/api/sessions/lookup`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({ rooms: mine.slice(i, i + 50).map((r) => ({ id: r.id, owner: r.owner })) }),
					signal: AbortSignal.timeout(REQUEST_MS),
					redirect: 'error',
				});
				const text = await response.text();
				if (response.status !== 200) {
					reached = false;
					break;
				}
				for (const s of JSON.parse(text) as { id: string; status?: string; e2ee?: boolean }[]) found.set(s.id, s);
			} catch {
				reached = false;
				break;
			}
		}
		if (!reached) {
			result.unreachable += mine.length;
			continue;
		}
		for (const room of mine) {
			const s = found.get(room.id);
			if (!s) {
				if (forgetNote(room.id)) result.removed.push(room.id);
				continue;
			}
			if (s.e2ee || s.status !== 'ended' || have.has(room.id) || forgotten.has(room.id)) continue;
			const done = await rememberRoom(room, { fetch: send });
			if (done === 'written') result.written.push(room.id);
			else if (done === 'gone') result.removed.push(room.id);
			else if (done === 'unreachable') result.unreachable++;
		}
	}
	return result;
}

/** A note by its room id or the start of it. */
export function findNote(word: string | undefined): MemoryEntry | undefined {
	if (!word) return undefined;
	const list = readIndex();
	const exact = list.find((e) => e.id === word);
	if (exact) return exact;
	const starts = list.filter((e) => e.id.startsWith(word));
	return starts.length === 1 ? starts[0] : undefined;
}

export function readNote(id: string): string | undefined {
	const file = noteFile(id);
	if (!file) return undefined;
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

/** One kept recap that matched a search, with the line of its digest that matched best. */
export interface NoteHit {
	entry: MemoryEntry;
	score: number;
	/** The query terms it matched, as `searchTerms` spells them. */
	matched: string[];
	/** The digest line holding the most matched terms, through `oneLine`, or '' when only the title or directories matched. */
	line: string;
}

/** How many hits `crossroom memory search` prints unless told otherwise. */
export const SEARCH_SHOWN = 10;

/**
 * The kept recaps that match `query`, best first: the same lexical ranking a sparse room's
 * `context` search uses, over each note's title, topic, directories, seats and digest. Nothing
 * leaves this computer. `only` narrows the notes searched (`--here`).
 */
export function searchNotes(query: string, only: (e: MemoryEntry) => boolean = () => true): NoteHit[] {
	// `searchItems` breaks ties toward later items, and the index is newest first.
	const entries = readIndex().filter(only).reverse();
	// The signature, footer and room link are on every note, so they say nothing about this one.
	const digests = new Map(
		entries.map((e) => [
			e.id,
			noteDigest(readNote(e.id) ?? '')
				.split('\n')
				.filter((line) => !NOT_RECALLED.some((start) => line.trim().startsWith(start)))
				.join('\n'),
		]),
	);
	const hits = searchItems(entries, query, (e) => ({
		title: e.title,
		about: e.topic ?? '',
		source: e.dirs.join(' '),
		from: e.seats.map((s) => `${s.name} ${s.provider ?? ''}`).join(' '),
		kind: '',
		body: digests.get(e.id) ?? '',
	}));
	return hits.map(({ item, score, matched }) => ({ entry: item, score, matched, line: bestLine(digests.get(item.id) ?? '', matched) }));
}

function bestLine(digest: string, matched: string[]): string {
	let best = '';
	let most = 0;
	for (const raw of digest.split('\n')) {
		const line = oneLine(raw).trim();
		// The heading repeats the title, which the hit prints anyway.
		if (!line || line.startsWith('## ') || NOT_RECALLED.some((start) => line.startsWith(start))) continue;
		const terms = searchTerms(line);
		const n = matched.filter((m) => terms.some((t) => t === m || (m.length >= 3 && t.length >= 3 && (t.startsWith(m) || m.startsWith(t))))).length;
		// Ties go to the later line: what a room came to is printed after the question it began with.
		if (n && n >= most) {
			most = n;
			best = line;
		}
	}
	return best;
}

/** A directory too broad to say two rooms worked on the same thing: the home directory or a filesystem root. */
const tooBroad = (dir: string) => {
	const resolved = path.resolve(dir);
	return sameLocation(resolved, os.homedir()) || path.parse(resolved).root === resolved;
};

/** Whether two directories are the same, or one holds the other. */
export function overlaps(a: string, b: string): boolean {
	if (tooBroad(a) || tooBroad(b)) return sameLocation(a, b) && !tooBroad(a);
	return sameLocation(a, b) || insideLocation(a, b) || insideLocation(b, a);
}

/** Entries whose directories overlap `dirs`, or that share `topic`, newest first: what `--recall auto` brings. */
export function relatedNotes(context: { dirs: string[]; topic?: string; exclude?: string }, max = RECALL_AUTO_ROOMS): MemoryEntry[] {
	return readIndex()
		.filter((e) => e.id !== context.exclude)
		.filter((e) => (context.topic && e.topic === context.topic) || e.dirs.some((d) => context.dirs.some((t) => overlaps(d, t))))
		.slice(0, max);
}

/**
 * One owner packet's body from earlier rooms' notes: for each room a line naming it, then its
 * digest's lines, each through `oneLine`, blank ones dropped. Each room gets an equal share, and
 * the whole stays within `RECALL_MAX`. The digest is what its room's participants said, and the
 * server prints a packet inside a fence, which is why it travels as one and not in the brief.
 */
export function recallText(entries: MemoryEntry[], max = RECALL_MAX): string {
	if (!entries.length) return '';
	const share = Math.floor((max - (entries.length - 1)) / entries.length);
	const parts: string[] = [];
	for (const e of entries) {
		const head = `Room ${e.id} "${clip(e.title, 80)}", ended ${e.ended.slice(0, 10)}${e.topic ? `, topic "${clip(e.topic, 40)}"` : ''}:`;
		const lines = [head.slice(0, share)];
		let used = lines[0]!.length;
		for (const raw of noteDigest(readNote(e.id) ?? '').split('\n')) {
			const line = oneLine(raw).trim();
			if (!line || NOT_RECALLED.some((start) => line.startsWith(start))) continue;
			if (used + 1 + line.length > share) {
				const room = share - used - 1;
				if (room > 20) lines.push(`${line.slice(0, room - 1)}…`);
				break;
			}
			lines.push(line);
			used += 1 + line.length;
		}
		parts.push(lines.join('\n'));
	}
	return parts.join('\n').slice(0, max);
}

/**
 * Lines of a digest that say nothing about what a room found, left out of a recall to keep its
 * budget for what it did: the signature, the footer, the rule above it, the link to the room page.
 */
const NOT_RECALLED = ['<!--', '---', 'Signed by ', '_Deterministic minutes', '[The room]('];

/** The notes `--recall <spec>` names: `auto`, or one room by its id or the start of it. */
export function recallNotes(spec: string, context: { dirs: string[]; topic?: string; exclude?: string }): MemoryEntry[] {
	if (spec === 'auto') return relatedNotes(context);
	const one = findNote(spec);
	if (!one) throw new RecallError(`No note in ${memoryDir()} has the room id ${clip(spec, 40)}. \`crossroom memory list\` shows them.`);
	return [one];
}

export class RecallError extends Error {}

/** Posts the recall packet into a room this computer owns (`POST /api/sessions/:id/context`). */
export async function postRecall(room: SavedRoom, body: string, send: RoomFetch = loopbackFetch): Promise<void> {
	const base = loopbackBase(room.base);
	if (!base) throw new RecallError('Notes from earlier rooms go only into a room on this computer.');
	const response = await send(`${base}/api/sessions/${encodeURIComponent(room.id)}/context`, {
		method: 'POST',
		headers: owned(room, { 'content-type': 'application/json' }),
		body: JSON.stringify({ title: RECALL_TITLE, body, kind: 'summary', source: 'crossroom memory' }),
		signal: AbortSignal.timeout(REQUEST_MS),
		redirect: 'error',
	});
	if (response.status !== 201) {
		const text = await response.text();
		let message = `${response.status}`;
		try {
			message = (JSON.parse(text) as { error?: string }).error ?? message;
		} catch {
			/* not JSON */
		}
		throw new RecallError(`Crossroom refused the notes from earlier rooms: ${clip(message, 200)}`);
	}
}
