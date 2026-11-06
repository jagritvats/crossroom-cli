/**
 * The commands `crossroom` has had from the start. Each one calls what cli.ts does for it, and their
 * orders list them in `crossroom help` as they have always been listed (a golden test holds them
 * to it). `serve` and `stop`, which run Crossroom on this computer, come with the server: the
 * client package (packages/cli) carries no server.
 */
import { seatPrompt } from '@parley/shared/deeplink';
import { firstLine } from '@parley/shared/text';
import {
  ask,
  doctor,
  endRoom,
  forgetSeat,
  knownSeats,
  leaveSeat,
  minutes,
  openBrowser,
  pickRoom,
  privateLink,
  recordSessionSeat,
  roomRows,
  roomsText,
  seatStatusText,
  seatsText,
  shareRoom,
  text,
  Usage,
  VERSION,
  verify,
} from '../cli.js';
import { askEach } from './ask-each.js';
import { askLink, isAskLink } from './ask-link.js';
import { verifyRecord } from './verify-record.js';
import { verifyRoom } from './verify-room.js';
import { registerCommand } from './index.js';
import { shellArg } from './local-agent.js';

registerCommand({
  name: 'ask',
  topic: 'start',
  synopsis: 'crossroom ask <dir> "<question>"',
  usage: 'crossroom ask <dir> "<question>"',
  summary: "an agent in <dir> answers, out of sight; you get your seat's link",
  more: [
    { usage: '[--with claude|codex] [--model <name>] [--json] [--no-start]' },
    { usage: '[--instance <url>]', summary: 'open the room there instead of the hosted Crossroom; the agent runs on this computer either way' },
    { usage: '[--unconfined-reads-ok]', summary: 'start Codex or Grok, which read outside their folder' },
    { usage: '[--session <id>]', summary: 'keep that Claude Code session in the room (the Crossroom plugin passes it)' },
    { usage: '[--recall auto|<room>]', summary: 'bring the kept recaps of earlier rooms in as one packet (crossroom memory)' },
  ],
  order: 20,
  // The same command with an ask link, or with a file of targets.
  forms: [
    { usage: 'crossroom ask <ask link> "<question>"', summary: "ask a team's standing seat; you get your seat's link", order: 21 },
    { usage: 'crossroom ask --each <file> "<question>" --claim "<text>"', summary: 'one room per target, and a table of verdicts', order: 22 },
  ],
  async run(args, say) {
    if (args.flags.each !== undefined) return askEach(args, say);
    if (isAskLink(args.positional[0]) || args.positional[0] === '-') return askLink(args, say);
    const r = await ask(args, say);
    if (args.flags.json) console.log(JSON.stringify(r, null, 2));
    else
      console.log(
        [
          ...(args.flags['no-start']
            ? [
                `The other seat is for a ${r.runner} agent in ${r.directory}. It was not started (--no-start). To start it on this computer:`,
                `  crossroom join ${r.agentSeatUrl} --dir ${shellArg(r.directory)} --with ${r.runner}`,
              ]
            : [`A ${r.runner} agent is taking the other seat on this computer, in ${r.directory}. It stops when the room ends; its log: ${r.agentLog}`]),
          '',
          'Your seat: paste this into the agent you are working with, or fetch it if you are that agent.',
          `  ${seatPrompt(r.seatUrl)}`,
          '',
          ...(r.recalled ? [`Brought in the recap${r.recalled.length === 1 ? '' : 's'} of ${r.recalled.map((id) => id.slice(0, 8)).join(', ')}, as one packet.`, ''] : []),
          `Watch it: ${r.watchUrl}`,
          `Minutes once it ends: ${r.minutes}`,
        ].join('\n'),
      );
    return 0;
  },
});

registerCommand({
  name: 'minutes',
  aliases: ['recap'],
  topic: 'follow',
  usage: 'crossroom minutes [<room>] [--digest] [--wait]',
  summary: "a room's recap (the latest one opened here by default); crossroom recap is the same",
  order: 50,
  async run(args, say) {
    console.log(await minutes(args, say));
    return 0;
  },
});

registerCommand({
  name: 'rooms',
  topic: 'follow',
  usage: 'crossroom rooms [--json]',
  summary: 'the rooms opened from this computer, and whether each is live, ended or waiting on you',
  order: 30,
  more: [
    {
      usage: '[--keep]',
      summary: 'put the rooms kept here into your account on their instance (new ones go there when signed in)',
    },
  ],
  switches: ['keep', 'no-keep'],
  async run(args) {
    if (args.flags.keep === true) {
      // Loaded here: its imports register `runner`, which must keep its place in the help.
      const { keepSaved } = await import('./keep-in-account.js');
      for (const line of await keepSaved(args)) console.log(line);
      return 0;
    }
    const rows = await roomRows();
    console.log(args.flags.json ? JSON.stringify(rows, null, 2) : roomsText(rows));
    return 0;
  },
});

registerCommand({
  name: 'open',
  topic: 'follow',
  usage: 'crossroom open [<room>] [--print]',
  summary: "open a room's page in the browser with its private link (--print: just print the link)",
  order: 40,
  run(args) {
    const room = pickRoom(args);
    const link = privateLink(room);
    if (args.flags.print) {
      console.log(link);
      return 0;
    }
    openBrowser(link);
    // The key is in the link, and this is the owner's own terminal, where `ask` already prints it.
    console.log(`Opening "${firstLine(room.title)}" in your browser. If nothing opened, this private link does it (it carries the room's key):\n  ${link}`);
    return 0;
  },
});

registerCommand({
  name: 'end',
  topic: 'follow',
  usage: 'crossroom end [<room>] [--outcome "<text>"]',
  summary: 'end a room, as its End room button does',
  order: 45,
  async run(args) {
    console.log(await endRoom(args));
    return 0;
  },
});

registerCommand({
  name: 'share',
  topic: 'follow',
  usage: 'crossroom share [<room>] [--list | --revoke <id>]',
  summary: 'a read-only link for someone else, or the ones the room has',
  order: 60,
  async run(args) {
    console.log(await shareRoom(args));
    return 0;
  },
});

registerCommand({
  name: 'verify',
  topic: 'follow',
  usage: 'crossroom verify <minutes.md> [--instance <url>]',
  summary: 'check that signed minutes have not changed (offline unless --instance)',
  order: 80,
  // A project record's signed export (commands/verify-record.ts).
  forms: [
    { usage: 'crossroom verify <record.json>', summary: "check a project record's export and every signed minutes in it", order: 81 },
    // Minutes v2 against the room's record bundle, with its receipts, co-signatures
    // (`--org`, against the domain's /.well-known/parley-keys.json) and anchors (`--trusted-root`):
    // commands/verify-room.ts, calling cosign/verify-cosign.ts and cosign/verify-anchor.ts.
    {
      usage: 'crossroom verify <minutes.md> --record <r.json> [--org <domain>] [--trusted-root <file>]',
      summary: "check minutes v2 against the room's record, its co-signatures and anchors",
      order: 82,
    },
  ],
  async run(args, say) {
    if (args.flags.record !== undefined || args.flags.org !== undefined || args.flags['trusted-root'] !== undefined) return verifyRoom(args, say);
    if (/\.json$/i.test(args.positional[0] ?? '')) return verifyRecord(args, say);
    const r = await verify(args);
    console.log(r.lines.join('\n'));
    return r.ok ? 0 : 1;
  },
});

registerCommand({
  name: 'seat',
  topic: 'plugin',
  usage: 'crossroom seat <link> [--session <id>]',
  summary: 'record a seat, held by that Claude Code session if one is named (the Crossroom plugin runs it)',
  order: 90,
  // Listed after `seats`, where it has always been.
  forms: [{ usage: 'crossroom seat <link> --forget', summary: 'forget a seat on this machine, without telling its room', order: 105 }],
  run(args) {
    // `crossroom seat <link> --session <id>`: what the plugin's join and resume skills run. With no
    // session, the seat is only recorded, so a later session can resume it.
    const link = args.positional[0];
    const session = text(args.flags.session) ?? null;
    if (!link) throw new Usage('Usage: crossroom seat <seat link> [--session <Claude Code session id>] [--forget]');
    if (args.flags.forget) {
      console.log(forgetSeat(link) ? 'Forgotten on this machine. The room was not told; its link still works wherever else it was pasted.' : 'This machine had no record of that seat.');
      return 0;
    }
    recordSessionSeat(session, link);
    console.log(
      session
        ? 'This session will be kept in the room by the Crossroom plugin while the room is live.'
        : 'Recorded. `crossroom seats` lists it, and /crossroom:resume takes it up in a Claude Code session.',
    );
    return 0;
  },
});

registerCommand({
  name: 'seats',
  topic: 'plugin',
  usage: 'crossroom seats [--json]',
  summary: 'the seats this machine took and whether their rooms are live, likeliest to resume first',
  order: 100,
  async run(args) {
    const rows = await knownSeats();
    console.log(args.flags.json ? JSON.stringify(rows, null, 2) : seatsText(rows));
    return 0;
  },
});

registerCommand({
  name: 'status',
  topic: 'plugin',
  usage: 'crossroom status [<link>] [--session <id>]',
  summary: "where a seat's room stands, as the seat sees it; moves nothing",
  order: 110,
  async run(args) {
    console.log(await seatStatusText(args));
    return 0;
  },
});

registerCommand({
  name: 'leave',
  topic: 'plugin',
  usage: 'crossroom leave [<link>] [--session <id>] [--summary "<line>"]',
  summary: 'finish a seat with a line for the other side, and forget it',
  order: 120,
  async run(args) {
    console.log(await leaveSeat(args));
    return 0;
  },
});

registerCommand({
  name: 'doctor',
  topic: 'computer',
  summary: 'what this machine can run',
  order: 130,
  async run(args) {
    const d = await doctor(args);
    console.log(`Crossroom ${VERSION}\n\n${d.lines.join('\n')}`);
    return d.ok ? 0 : 1;
  },
});

