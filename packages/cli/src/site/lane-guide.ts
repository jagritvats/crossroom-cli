/**
 * What a lane (`@parley/shared/lane`) says to an agent before its briefing: the landing page of its
 * seat link (`GET /j/<token>`), and the hand-over in a create reply. A lane is no meeting, so neither
 * tells the agent to wait: both lead with the one command that matters next.
 *
 * Pure functions over strings; a test holds each to a budget.
 */
import { seatPrompt } from '@parley/shared/deeplink';
import { curlRule, slotLetter } from '@parley/shared/text';
import { joinCommand, type Handoff, type HandoffOptions } from './agent-guide.js';

/** The line a person pastes into the other repository's agent, once. */
export function lanePasteLine(seatUrl: string): string {
  return seatPrompt(seatUrl, { lane: true });
}

/** Where a lane seat stands when its link is fetched: read from metadata alone, no key. */
export interface LaneSeatState {
  /** The seat has joined before: joining again only re-reads the briefing. */
  joined: boolean;
  /** Items that wait on this side now. */
  needs: number;
}

const needsLine = (n: number) => (n ? `${n} item${n === 1 ? ' needs' : 's need'} this side now.` : 'Nothing needs this side now.');

/**
 * A lane seat's landing page, in as few lines as will do. Before the seat joined, it leads with the
 * join. After, it leads with the read, a GET that moves nothing: an agent asked "anything back from
 * the other side?" read "Join now" as a commitment and stopped before looking.
 */
export function laneLanding(seatUrl: string, slot: number, title: string, { joined, needs }: LaneSeatState = { joined: false, needs: 0 }): string {
  const head = [`# Crossroom: you hold side ${slotLetter(slot)} of the lane "${title}"`, ''];
  const tail = ['', `Is your user asked to approve each call? This Claude Code rule allows them all: \`${curlRule(seatUrl)}\``, '', `Your seat link, written out in every call: ${seatUrl}`];
  if (joined)
    return [
      ...head,
      `This side joined already. ${needsLine(needs)} What needs you (a GET: it moves nothing and commits you to nothing):`,
      '',
      '```sh',
      `curl -s "${seatUrl}/items?needs=me"`,
      '```',
      '',
      `To work them, \`curl -s ${seatUrl}/pass\` has the steps. Nobody waits in a lane: never loop on \`wait\`. Need the briefing again? Join again (it commits you to nothing): \`${joinCommand(seatUrl, 'Your name, e.g. api or web')}\``,
      `Shell can't reach this host? Open this link in a browser: every call is a form there.`,
      ...tail,
    ].join('\n');
  return [
    ...head,
    'A lane is async: either side files an item (a bug, task, question or heads-up) with its evidence, and the other side’s agent works it later, on its next pass. Nobody waits for anyone.',
    '',
    `${needsLine(needs)} Join now (it commits you to nothing; the reply says what needs you):`,
    '',
    '```sh',
    joinCommand(seatUrl, 'Your name, e.g. api or web'),
    '```',
    '',
    `Run it as written, with \`curl\`, in any Bash shell. Shell can't reach this host? Open this link in a browser: every call is a form there.`,
    '',
    'The reply is your briefing: what needs you, how to file, and the pass that works the lane. Never loop on `wait` in a lane.',
    ...tail,
  ].join('\n');
}

/** The same landing on the HTML page (`?format=html`), where the forms below take the place of curl. */
export function laneLandingForBrowser(slot: number, title: string, { joined, needs }: LaneSeatState): string {
  return [
    `You hold side ${slotLetter(slot)} of the lane "${title}".`,
    '',
    'A lane is async: either side files an item (a bug, task, question or heads-up) with its evidence, and the other side’s agent works it later, on its next pass. Nobody waits for anyone, and nothing here asks you to wait.',
    '',
    `${needsLine(needs)} ${
      joined
        ? `This side joined already: the items form (needs=me) ${needs ? 'reads them' : 'lists the lane'}, and pass has the steps to work them.`
        : 'Join with the join form below (it commits you to nothing): its reply is your briefing.'
    }`,
  ].join('\n');
}

/** The part of a lane's create reply addressed to the agent that opened it. Its user hears first. */
export function laneHandoffLines({ seatA, others, ownerUrl }: Handoff, { joinVia = 'curl' }: HandoffOptions = {}): string[] {
  const seatB = others[0];
  return [
    'FOR THE AGENT THAT OPENED THIS LANE:',
    '1. Tell your user now, in these words or yours:',
    `   I opened a Crossroom lane. Follow it here (private to you, and the only way back in): ${ownerUrl}`,
    ...(seatB ? [`   Paste this line into the other repository's agent, once: ${lanePasteLine(seatB)}`] : []),
    joinVia === 'joined'
      ? '2. You hold side A already: your briefing is below. Read it, file what you found, and stop. A lane never waits.'
      : joinVia === 'connector'
        ? `2. Join side A yourself: call join with link=${seatA}\n   The reply is your briefing; every lane call after it is the lane tool. Read it, file what you found, and stop. A lane never waits.`
        : `2. Join side A yourself: ${joinCommand(seatA)}\n   The reply is your briefing. Read it, file what you found, and stop. A lane never waits.`,
    // A connector's calls are made from the vendor's side: no shell, so no rule to give.
    ...(joinVia === 'connector' ? [] : [`3. Is your user asked to approve each call? Give them this Claude Code rule, which allows every lane call: ${curlRule(seatA)}`]),
  ];
}
