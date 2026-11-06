/**
 * `crossroom lane notify`: tells a Slack channel or a Microsoft Teams chat when a lane's items move,
 * from the person's machine or their CI, through the lane's seat link. The hosted Crossroom never
 * holds the webhook address.
 *
 * - The address is given by `--slack <url>` or `--teams <url>`, or `CROSSROOM_SLACK_WEBHOOK` /
 *   `CROSSROOM_TEAMS_WEBHOOK`. It is a credential (anyone holding it posts to the channel), so it is
 *   never stored and never printed.
 * - A run reads every item, compares it with the last run (`<data>/lane-notify/<key>.json`), and
 *   posts what was filed and what moved. The first run only remembers where things stand.
 * - Content-free by default: labels, kinds, states and which side an item needs. Titles, which are a
 *   side's words, go out only with `--titles`, collapsed to one line, with everything that would
 *   page a channel, make a link (`<...>`, a bare `https://`) or format text set as plain text.
 * - A Teams Workflows URL answers 202 as soon as it has the message, before the flow posts it, so a
 *   post that later fails is not seen here: Teams reports it in the flow's run history.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LANE_KIND_WORDS, LANE_STATE_WORDS, type LaneItem, laneLabel, needsSide } from '@parley/shared/lane';
import { teamsMessage, teamsPlain } from '@parley/shared/teams-card';
import { oneLine } from '@parley/shared/text';
import { Usage } from '../../cli.js';
import type { LanePort } from './engine.js';
import { clip, laneKey } from './types.js';

export interface NotifyTarget {
  kind: 'slack' | 'teams';
  url: string;
}

/** Where to post, from the flags or the environment; an address that is not https is refused. */
export function notifyTarget(flags: Record<string, string | true | undefined>, env: NodeJS.ProcessEnv = process.env): NotifyTarget {
  const slack = typeof flags.slack === 'string' ? flags.slack : env.CROSSROOM_SLACK_WEBHOOK;
  const teams = typeof flags.teams === 'string' ? flags.teams : env.CROSSROOM_TEAMS_WEBHOOK;
  if (slack && teams) throw new Usage('Give one of --slack or --teams.');
  const url = slack ?? teams;
  if (!url) throw new Usage('Give --slack <incoming webhook URL> or --teams <Workflows URL>, or set CROSSROOM_SLACK_WEBHOOK or CROSSROOM_TEAMS_WEBHOOK.');
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Usage('That webhook address is not a URL.');
  }
  // Never echoed: the address is the credential.
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'))) throw new Usage('A webhook address is https only.');
  if (slack && u.protocol === 'https:' && u.hostname !== 'hooks.slack.com') throw new Usage('A Slack incoming webhook is on hooks.slack.com.');
  return { kind: slack ? 'slack' : 'teams', url };
}

interface Seen {
  v: 1;
  items: Record<string, { state: string; version: number }>;
}

const seenFile = (dataDir: string, key: string, target: NotifyTarget) => path.join(dataDir, 'lane-notify', `${key}-${target.kind}.json`);

function loadSeen(file: string): Seen | null {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Seen;
    return s && s.v === 1 && s.items ? s : null;
  } catch {
    return null;
  }
}

function saveSeen(file: string, s: Seen) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** A zero-width space, from its code point (a literal one is invisible in review). */
const ZWSP = String.fromCodePoint(0x200b);

/**
 * A title as a chat shows it: one line, clipped, with nothing that pages a channel or makes a link or
 * a format. `://` is broken by a zero-width space, so no address is linked on its own; in Slack a
 * zero-width space before each of `*`, `_`, `~` and a backtick keeps it from opening a format. Teams
 * takes the shared rule (`teamsPlain`).
 */
export function plainTitle(t: string, kind: NotifyTarget['kind']): string {
  const line = clip(oneLine(t), 120);
  return kind === 'slack'
    ? line
        .replace(/:\/\//g, `:${ZWSP}//`)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/@(channel|here|everyone)\b/gi, `@${ZWSP}$1`)
        .replace(/[*_~`]/g, (c) => `${ZWSP}${c}`)
    : teamsPlain(line);
}

/** The lines a change makes, in Crossroom's words: content-free unless `titles`. */
export function changeLines(items: LaneItem[], prev: Seen['items'], me: string, other: string, opts: { titles: boolean; kind: NotifyTarget['kind'] }): string[] {
  const lines: string[] = [];
  for (const i of [...items].sort((a, b) => a.n - b.n)) {
    const was = prev[String(i.n)];
    if (was && was.state === i.state) continue;
    const id = laneLabel(i.n);
    const title = opts.titles ? `: "${plainTitle(i.title, opts.kind)}"` : '';
    const needs = i.state === 'closed' ? '' : `; needs side ${needsSide(i, me) ? me : other}`;
    if (!was) lines.push(`${id} (${LANE_KIND_WORDS[i.kind]}) filed by side ${i.filedBy}${title}${needs}.`);
    else lines.push(`${id} is now ${LANE_STATE_WORDS[i.state]}${title}${needs}.`);
  }
  return lines;
}

const SHOWN = 20;

/** The message body for the webhook: Slack's text, or the shared Teams card. */
export function payloadFor(target: NotifyTarget, head: string, lines: string[]): unknown {
  const shown = lines.slice(0, SHOWN);
  const more = lines.length > SHOWN ? [`…and ${lines.length - SHOWN} more.`] : [];
  if (target.kind === 'slack') return { text: [head, ...shown.map((l) => `• ${l}`), ...more].join('\n') };
  return teamsMessage({ title: head, lines: [...shown, ...more] });
}

export interface NotifyRun {
  lane: LanePort;
  target: NotifyTarget;
  dataDir: string;
  titles?: boolean;
  fetcher?: typeof fetch;
}

/** One look at the lane: `posted` lines, or `primed` on the first run, which posts nothing. */
export async function notifyOnce(r: NotifyRun): Promise<{ posted: number; primed: boolean }> {
  const who = await r.lane.whoami();
  const d = await r.lane.items();
  const items = [...d.needs, ...d.waiting, ...d.closed];
  const file = seenFile(r.dataDir, laneKey(who.roomId), r.target);
  const prev = loadSeen(file);
  const now: Seen = { v: 1, items: Object.fromEntries(items.map((i) => [String(i.n), { state: i.state, version: i.version }])) };
  if (!prev) {
    saveSeen(file, now);
    return { posted: 0, primed: true };
  }
  const other = who.me === 'A' ? 'B' : 'A';
  const lines = changeLines(items, prev.items, who.me, other, { titles: !!r.titles, kind: r.target.kind });
  if (lines.length) {
    const head = `Crossroom lane: ${lines.length} change${lines.length === 1 ? '' : 's'} (${d.counts.open} open, ${d.needs.length} need${d.needs.length === 1 ? 's' : ''} side ${who.me})`;
    const res = await (r.fetcher ?? fetch)(r.target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payloadFor(r.target, head, lines)),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    }).catch((e: Error) => {
      throw new Usage(`The ${r.target.kind === 'slack' ? 'Slack' : 'Teams'} webhook did not answer (${(e as { cause?: Error }).cause?.message ?? e.message}).`);
    });
    // Remembered only once the post went through, so a failed one is tried again next run.
    if (!res.ok) throw new Usage(`The ${r.target.kind === 'slack' ? 'Slack' : 'Teams'} webhook answered ${res.status}.`);
  }
  saveSeen(file, now);
  return { posted: lines.length, primed: false };
}
