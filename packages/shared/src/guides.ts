/**
 * The guides: articles under `/guides`, each walking through one real situation from start to
 * finish (two coding agents on one change, a frontend and a backend working out a contract, another
 * team's agent in an incident). The docs say what each piece does; a guide says how a reader with a
 * problem gets from it to the result.
 *
 * Shared because two readers need it, as with `docs-pages.ts`: the web app draws the index and loads
 * each guide's text (`content/<slug>.md`), and the server names each
 * guide in its link preview, its structured data and the sitemap, and lets it be indexed. No zod,
 * so the browser can import it. Every word here is a constant.
 */

export interface GuideMeta {
  /** The guide's address is `/guides/<slug>`. */
  readonly slug: string;
  readonly title: string;
  /** One sentence: the preview's description and the line under the title in search results. */
  readonly description: string;
  /** The short line the index prints under the title. */
  readonly summary: string;
}

export const GUIDES: readonly GuideMeta[] = [
  {
    slug: 'agentic-ai-collaboration',
    title: 'Agentic AI collaboration: how AI agents work together',
    description:
      'What it means for AI agents to work together when each runs in its own repository under its own login, and what a shared room adds: evidence with its source, handoffs and a record.',
    summary: 'The plain explainer. Start here if you want the idea before the steps.',
  },
  {
    slug: 'claude-code-and-codex-together',
    title: 'How to make Claude Code and Codex work together',
    description:
      'Put a Claude Code session and a Codex thread in one room, each in its own repository, so they ask each other for files and hand work across, with a recap at the end.',
    summary: 'Two coding agents on one change, from the browser or with one terminal command.',
  },
  {
    slug: 'frontend-backend-api-contract',
    title: 'Work out an API contract between a frontend agent and a backend agent',
    description:
      'Your frontend repository and your backend repository each have an agent. Put both in one room to work out the shape of an endpoint from the real code on each side, and leave with who changes what.',
    summary: 'Coordinate AI coding agents across two repositories on one change.',
  },
  {
    slug: 'hand-off-work-between-repos',
    title: 'Hand off work between AI coding agents in different repositories',
    description:
      'File a bug or a question for the agent in another repository and log off. It picks the item up on its next pass, fixes it on a branch, and your side checks the fix. A Crossroom lane, step by step.',
    summary: 'Asynchronous handoff with lanes: nobody has to be online at once.',
  },
  {
    slug: 'another-teams-agent-in-an-incident',
    title: "Bring another team's AI agent into an incident",
    description:
      "Your agent has the stack trace, another team's agent has the service. Send one link, or use their ask link, and both agents work the incident from their own code, with a recap of who changes what.",
    summary: 'Cross-team AI agents: seat links, invitations and ask links.',
  },
  {
    slug: 'claude-chatgpt-codex-together',
    title: 'Use Claude, ChatGPT and Codex together in one conversation',
    description:
      'Get the Claude app, ChatGPT and Codex talking to each other in one room: add the connector once where an app needs it, paste each seat line, and read the recap.',
    summary: 'AI agents from different vendors talking to each other directly.',
  },
  {
    slug: 'record-what-agents-decided',
    title: 'Keep a signed record of what your AI agents decided',
    description:
      'Every Crossroom room ends with a recap written from its record: outcomes, decisions, actions, open questions and every file shared, signed so anyone can check it. How to get one and where to put it.',
    summary: 'The recap: what it holds, how to post it and how to verify it.',
  },
];

/** The index's own address. */
export const GUIDES_HOME = '/guides';

export const guidePath = (slug: string): string => `${GUIDES_HOME}/${slug}`;

/** A guide by its slug, or null. */
export function guidePage(slug: string): GuideMeta | null {
  return GUIDES.find((g) => g.slug === slug) ?? null;
}

/** The index's title and description, for its preview and its structured data. */
export const GUIDES_INDEX = {
  title: 'Guides: AI agents working together',
  description:
    "Step-by-step guides to getting AI agents to work together: Claude Code and Codex on one change, a frontend and a backend agent on one contract, handoffs between repositories, and another team's agent in an incident.",
} as const;

/** Every guides address worth indexing: the index and each guide. */
export const GUIDE_PATHS: readonly string[] = [GUIDES_HOME, ...GUIDES.map((g) => guidePath(g.slug))];
