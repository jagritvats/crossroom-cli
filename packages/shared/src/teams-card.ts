/**
 * A message for a Microsoft Teams Workflows webhook: one Adaptive Card 1.4, a bold first line, a
 * line per text block, and at most one Open link. `crossroom lane notify --teams` and room webhooks
 * in the `teams` format both post it. No zod: the web imports it.
 *
 * The card's text is whatever the caller passes: give it Crossroom's own words, or text set plain
 * with `teamsPlain` first. A TextBlock renders a subset of markdown, so anything a participant wrote
 * can make a link or a heading there unless it is set plain.
 */

/** What a card says. `title` is the bold first line; each of `lines` is a block under it. */
export interface TeamsCardInput {
  title: string;
  lines: readonly string[];
  /** One button that opens a page. The URL is the caller's, and must carry no credential. */
  action?: { title: string; url: string };
}

export interface TeamsTextBlock {
  type: 'TextBlock';
  text: string;
  weight?: 'Bolder';
  wrap: true;
  spacing?: 'None';
}

export interface TeamsMessage {
  type: 'message';
  attachments: [
    {
      contentType: 'application/vnd.microsoft.card.adaptive';
      content: {
        type: 'AdaptiveCard';
        $schema: string;
        version: '1.4';
        body: TeamsTextBlock[];
        actions?: { type: 'Action.OpenUrl'; title: string; url: string }[];
      };
    },
  ];
}

/** Workflows refuses a message over 28 KB. */
export const TEAMS_MESSAGE_MAX_BYTES = 28 * 1024;

/**
 * The message body for a Workflows URL. Keys are written in a fixed order, so the same input posts
 * the same bytes (`lane notify`'s test pins them).
 */
export function teamsMessage(input: TeamsCardInput): TeamsMessage {
  const content: TeamsMessage['attachments'][0]['content'] = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [{ type: 'TextBlock', text: input.title, weight: 'Bolder', wrap: true }, ...input.lines.map((l): TeamsTextBlock => ({ type: 'TextBlock', text: l, wrap: true, spacing: 'None' }))],
  };
  if (input.action) content.actions = [{ type: 'Action.OpenUrl', title: input.action.title, url: input.action.url }];
  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content }] };
}

/** A zero-width space, from its code point (a literal one is invisible in review). */
const ZWSP = String.fromCodePoint(0x200b);

/**
 * One line as a TextBlock shows it, with nothing that makes a link, a heading or a format, and no
 * `@` that reads as a mention: markdown's punctuation is blanked, and `://` and `@` are broken with
 * a zero-width space. The caller collapses the text to one line first.
 */
export function teamsPlain(line: string): string {
  return line
    .replace(/:\/\//g, `:${ZWSP}//`)
    .replace(/[\\`*_[\]()<>#|~]/g, ' ')
    .replace(/@/g, `@${ZWSP}`);
}
