/**
 * `crossroom memory sync|list [--here]|search <words>|show <id>|forget <id>`: the copy this computer keeps of each
 * ended room's recap (memory-notes.ts), for reading a room again without opening it and for
 * bringing earlier rooms into a new one (`--recall` on `ask`).
 *
 * Each agent keeps its own memory itself, asked at the end of every room it sat in; this is the
 * owner's copy, and nothing here writes an agent's files.
 */
import { firstLine } from '@parley/shared/text';
import { Usage } from '../cli.js';
import { registerCommand } from './index.js';
import { findNote, forgetNote, memoryDir, type NoteHit, overlaps, readIndex, readNote, SEARCH_SHOWN, searchNotes, syncMemory, type MemoryEntry } from './memory-notes.js';

const USAGE = 'Usage: crossroom memory sync | list [--here] [--json] | search "<words>" [--here] [--json] | show <room> | forget <room>';

function listText(entries: MemoryEntry[], here: boolean): string {
	if (!entries.length)
		return here
			? 'No ended room this computer keeps a recap of worked in this directory. `crossroom memory list` shows them all.'
			: 'No recaps kept yet. A room `crossroom ask` opened is kept here once it ends; `crossroom memory sync` catches up.';
	const lines = entries.map((e) => {
		const where = [e.topic ? `topic ${firstLine(e.topic, 40)}` : '', ...e.dirs.slice(0, 2)].filter(Boolean).join(', ');
		return `  ${e.id.slice(0, 8)}  ${firstLine(e.title, 60)}\n            ended ${e.ended.slice(0, 16).replace('T', ' ')}${where ? `, ${where}` : ''}`;
	});
	return `${lines.join('\n')}\n\ncrossroom memory show <id> reads one.`;
}

function searchText(query: string, hits: NoteHit[], here: boolean): string {
	if (!hits.length) {
		const scope = here ? ' worked in this directory' : '';
		return readIndex().length
			? `No kept recap${scope} mentions "${firstLine(query, 60)}". \`crossroom memory sync\` brings in rooms that ended since.`
			: 'No recaps kept yet. A room opened from this computer is kept here once it ends; `crossroom memory sync` catches up.';
	}
	const shown = hits.slice(0, SEARCH_SHOWN).map(({ entry: e, line }) => {
		const head = `  ${e.id.slice(0, 8)}  ${firstLine(e.title, 60)}  (ended ${e.ended.slice(0, 10)})`;
		return line ? `${head}\n            ${firstLine(line, 110)}` : head;
	});
	const more = hits.length > SEARCH_SHOWN ? `\n  …and ${hits.length - SEARCH_SHOWN} more (--json lists every one).` : '';
	return `${shown.join('\n')}${more}\n\ncrossroom memory show <id> reads one; --recall <id> on ask brings it into a new room.`;
}

function entryOf(word: string | undefined): MemoryEntry {
	if (!word) throw new Usage(USAGE);
	const entry = findNote(word);
	if (entry) return entry;
	const starts = readIndex().filter((e) => e.id.startsWith(word));
	if (starts.length > 1) throw new Usage(`More than one kept recap starts with ${firstLine(word, 40)}: ${starts.slice(0, 5).map((e) => e.id.slice(0, 12)).join(', ')}. Give more of the id.`);
	throw new Usage(`No kept recap has the room id ${firstLine(word, 40)}. \`crossroom memory list\` shows them.`);
}

registerCommand({
	name: 'memory',
	topic: 'follow',
	usage: 'crossroom memory sync|list [--here]|search "<words>"|show <room>|forget <room>',
	summary: "this computer's copy of each ended room's recap, to read and search again",
	order: 70,
	async run(args) {
		const action = args.positional[0] ?? 'list';
		switch (action) {
			case 'sync': {
				const r = await syncMemory();
				const parts = [`Kept ${r.written.length} new recap${r.written.length === 1 ? '' : 's'}`];
				if (r.removed.length) parts.push(`removed ${r.removed.length} of rooms their Crossroom no longer has`);
				if (r.unreachable) parts.push(`${r.unreachable} room${r.unreachable === 1 ? ' is' : 's are'} on a Crossroom that did not answer`);
				console.log(`${parts.join('; ')}. They are in ${memoryDir()}.`);
				return 0;
			}
			case 'list': {
				const here = args.flags.here === true;
				const cwd = process.cwd();
				const entries = readIndex().filter((e) => !here || e.dirs.some((d) => overlaps(d, cwd)));
				console.log(args.flags.json ? JSON.stringify(entries, null, 2) : listText(entries, here));
				return 0;
			}
			case 'search': {
				const query = args.positional.slice(1).join(' ').trim();
				if (!query) throw new Usage(USAGE);
				const here = args.flags.here === true;
				const cwd = process.cwd();
				const hits = searchNotes(query, (e) => !here || e.dirs.some((d) => overlaps(d, cwd)));
				if (args.flags.json) console.log(JSON.stringify(hits.map((h) => ({ ...h.entry, score: h.score, matched: h.matched, line: h.line })), null, 2));
				else console.log(searchText(query, hits, here));
				return 0;
			}
			case 'show': {
				const entry = entryOf(args.positional[1]);
				const note = readNote(entry.id);
				if (note === undefined) throw new Usage(`The recap of room ${entry.id} is listed but its file is gone. \`crossroom memory sync\` writes it again.`);
				console.log(note.replace(/\s+$/, ''));
				return 0;
			}
			case 'forget': {
				const entry = entryOf(args.positional[1]);
				forgetNote(entry.id, { forever: true });
				console.log(`Forgot the recap of "${firstLine(entry.title, 60)}". A later sync leaves it out; the room itself is untouched.`);
				return 0;
			}
			default:
				throw new Usage(USAGE);
		}
	},
});
