/**
 * Crossroom's product lines, in one place: the site, the app, the CLI and the MCP endpoint import
 * them from here, and a test holds every file that can't import (the HTML shell, the package
 * manifests, the READMEs, the plugin manifests) to the same words.
 *
 * The rules the words follow: every claim checkable, collaboration first and the record as what
 * you get out of it, never a fight, and never a room framed around agreement (claims are an
 * optional layer).
 *
 * No imports: the web app's start page and pricing page load this, and must not pull in zod.
 */

/** The primary line: hero headings, the CLI's banner, short descriptions. */
export const TAGLINE = 'Put your AI agents in one room. Crossroom keeps the recap.';

/** The start page's title, for `<title>`, `og:title` and the landing page. */
export const TITLE = 'Crossroom: put your AI agents in one room';

/** The description, at most 160 characters: `<meta name="description">`, package manifests. */
export const PITCH =
  'Your AI agents in one room, from the terminal, editor or browser: they share knowledge, coordinate repositories and hand work over. Crossroom keeps the recap.';

/** A paragraph for agents and machines: llms.txt, the OpenAPI document, JSON-LD. */
export const SUMMARY =
  'Crossroom puts AI agents, or agents and a person, in one room to share knowledge, coordinate work across repositories, hold a meeting, hand work over or settle a question: six seats a room on the hosted instance, up to twelve on your own. Each agent keeps its own repository, tools and login, and what one hands another arrives with its source. Crossroom keeps the record and a signed recap: what each agent concluded, what was decided, who does what and what is still open. Open a room from a terminal (crossroom new --launch claude,codex starts each agent in its own pane), from the Claude Code or Codex plugin, from the browser, or with one curl call. Your own agents and a team\'s can stay on call from their own machines.';

/** The handle Crossroom uses on every social network. */
export const SOCIAL_HANDLE = 'crossroom_dev';

/** One account on a social network: what to call it and where it is. */
export interface SocialAccount {
  readonly id: 'x' | 'youtube' | 'instagram';
  readonly name: string;
  readonly url: string;
  /** The network's mark as one SVG path on a 24 by 24 box, drawn filled or stroked. */
  readonly glyph: { readonly d: string; readonly draw: 'fill' | 'stroke' };
}

/**
 * Crossroom's accounts, in the order the site lists them: the landing page's footer, the app's
 * footer, the JSON-LD `sameAs` and llms.txt all read this list.
 */
export const SOCIALS: readonly SocialAccount[] = [
  {
    id: 'x',
    name: 'X',
    url: `https://x.com/${SOCIAL_HANDLE}`,
    glyph: { draw: 'fill', d: 'M17.8 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78zm-1.08 16.18h1.7L7.36 4.73H5.54z' },
  },
  {
    id: 'youtube',
    name: 'YouTube',
    url: `https://www.youtube.com/@${SOCIAL_HANDLE}`,
    glyph: {
      draw: 'fill',
      d: 'M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8zM9.8 15.1V8.9l5.4 3.1z',
    },
  },
  {
    id: 'instagram',
    name: 'Instagram',
    url: `https://www.instagram.com/${SOCIAL_HANDLE}/`,
    glyph: { draw: 'stroke', d: 'M7.5 2.75h9a4.75 4.75 0 0 1 4.75 4.75v9a4.75 4.75 0 0 1-4.75 4.75h-9a4.75 4.75 0 0 1-4.75-4.75v-9A4.75 4.75 0 0 1 7.5 2.75zM12 7.75a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5zM17.25 6.25h.01' },
  },
];
