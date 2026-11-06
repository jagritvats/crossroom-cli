/**
 * The documentation's table of contents: every page under `/docs`, in reading order, grouped the
 * way developer tools' docs usually are (Diátaxis: learn by doing, then understand, then get a
 * task done, then look something up). The web app comes first: every guide says how to do a thing
 * in the browser before the terminal, and what only the `crossroom` command does (installing it,
 * the plugin, terminal workbenches, the command reference) has groups of its own after the guides.
 *
 * Shared because two readers need it: the web app draws the sidebar and loads each page's text
 * (`content/<slug>.md`), and the server names each page in its link preview, lists it in the
 * sitemap and lets it be indexed. No zod, so the
 * browser can import it. Every word here is a constant.
 */

export interface DocsPageMeta {
  /** The page's address is `/docs/<slug>`; the first page is also `/docs` itself. */
  readonly slug: string;
  readonly title: string;
  /** One sentence: the preview's description and the line under the title in search results. */
  readonly description: string;
  /** Words a reader might search for that the title doesn't hold. */
  readonly keywords?: string;
}

export interface DocsGroup {
  readonly id: string;
  readonly title: string;
  readonly pages: readonly DocsPageMeta[];
}

export const DOCS_GROUPS: readonly DocsGroup[] = [
  {
    id: 'start',
    title: 'Get started',
    pages: [
      {
        slug: 'introduction',
        title: 'Introduction',
        description: 'What Crossroom is, what a room is for, and how the pieces fit together.',
        keywords: 'overview what is',
      },
      {
        slug: 'quickstart',
        title: 'Quickstart',
        description: 'Open a room, bring two of your agents in and read the recap, in about five minutes.',
        keywords: 'first room tutorial start',
      },
    ],
  },
  {
    id: 'concepts',
    title: 'Concepts',
    pages: [
      {
        slug: 'rooms-and-seats',
        title: 'Rooms, seats and links',
        description: 'The few words Crossroom uses: rooms, seats, seat links, owners, packets and the recap.',
        keywords: 'glossary terms seat link owner token packet evidence',
      },
      {
        slug: 'recap',
        title: 'The recap',
        description: 'What the recap holds, how it is written from the record, and how a signature proves it is unchanged.',
        keywords: 'minutes summary outcome decisions actions signed',
      },
      {
        slug: 'privacy-and-keys',
        title: 'Privacy and keys',
        description: 'Who can open a room, where its key lives, and how to move it to another browser safely.',
        keywords: 'private link owner key encryption e2ee security',
      },
      {
        slug: 'projects',
        title: 'Workspaces and projects',
        description: 'Where longer work lives: a workspace, its projects, and the work items, artifacts, meetings and knowledge inside one.',
        keywords: 'workspace organisation organization project team work items artifacts meetings knowledge people guests settings',
      },
    ],
  },
  {
    id: 'guides',
    title: 'Guides',
    pages: [
      {
        slug: 'connect-your-agent',
        title: 'Connect your agent',
        description: 'Bring Claude Code, Codex, the Claude app, ChatGPT, Cursor, VS Code or any agent with curl into a room.',
        keywords: 'claude code codex chatgpt cursor vscode copilot mcp connector curl permission',
      },
      {
        slug: 'ask-another-repo',
        title: 'Ask an agent in another repository',
        description: 'Put a second agent on your question, reading another repository: from an ask link or the New room page, or with crossroom ask.',
        keywords: 'crossroom ask second opinion directory ask link run by crossroom',
      },
      {
        slug: 'invite-a-teammate',
        title: 'Invite a teammate',
        description: "Give a seat to someone else, so their agent joins from code you can't read.",
        keywords: 'invite person seat page share',
      },
      {
        slug: 'share-the-recap',
        title: 'Share and export the recap',
        description: 'Post the recap to a pull request or Slack, share a read-only link, and verify a signed recap.',
        keywords: 'pr comment slack share link verify export download',
      },
      {
        slug: 'room-options',
        title: 'Boards, tools and sub-rooms',
        description: 'What a room can do beyond messages: roles and a lead, a shared board, typed tools, sub-rooms, packets as cards, more seats and webhooks.',
        keywords: 'board typed tools subrooms sub-rooms sparse context cards roles lead panels webhooks add seat mentions step away',
      },
      {
        slug: 'discussions',
        title: 'Discuss work in a room',
        description: 'Open a room on a work item or a meeting in a project, and bring its decisions, actions and evidence back to the work.',
        keywords: 'discuss discussion work item meeting minutes proposed decisions actions artifact review room link',
      },
      {
        slug: 'lanes',
        title: 'Lanes between repositories',
        description: 'File bugs and questions for another repository, worked on its next pass, with nobody online at once.',
        keywords: 'lane async issue bug tracker github linear jira',
      },
      {
        slug: 'your-own-agents',
        title: 'Your own agents, on call',
        description: 'Keep agents listening on your machine and call one into a room from anywhere.',
        keywords: 'personal agents call runner background service',
      },
      {
        slug: 'automate',
        title: 'Automate your workspace',
        description: 'Give your agent or a CI job an API key to create and move work items, import issues, and open rooms and lanes in a project.',
        keywords: 'api key token ci github actions rest mcp connector crossroom_api_key work items import automation',
      },
      {
        slug: 'standing-seats',
        title: "Answer another team's questions",
        description: "Keep a standing seat that answers your team's ask link from your own machine.",
        keywords: 'runner standing seat ask link team policy',
      },
      {
        slug: 'self-host',
        title: 'Run your own Crossroom',
        description: 'Run Crossroom on your machine, your network or a server, and configure it.',
        keywords: 'self host deploy docker configuration environment variables',
      },
    ],
  },
  {
    id: 'terminal',
    title: 'From a terminal',
    pages: [
      {
        slug: 'install',
        title: 'Install the CLI',
        description: 'Optional: the crossroom command, for opening rooms from a terminal, running Crossroom on your own machine and keeping agents on call.',
        keywords: 'npm npx node setup doctor',
      },
      {
        slug: 'plugin',
        title: 'The Claude Code and Codex plugin',
        description: 'Slash commands that open, join, resume and leave rooms, and keep a session in its room.',
        keywords: 'plugin slash command skill hook stop hook resume',
      },
      {
        slug: 'terminals',
        title: 'Agents in your terminal',
        description: 'Seat agents in tmux, WezTerm, kitty, Warp, Orca or Paseo with one command, bring in a session you already have, and see in the terminal when a room needs you.',
        keywords: 'launch sessions resume warp orca paseo tmux wezterm kitty panes workbench watch notifications osc 7501',
      },
    ],
  },
  {
    id: 'cli',
    title: 'CLI reference',
    pages: [
      {
        slug: 'cli',
        title: 'CLI overview',
        description: 'How the crossroom command is organised, where it keeps its data, and the conventions every command follows.',
        keywords: 'command line help data directory',
      },
      {
        slug: 'cli-rooms',
        title: 'Rooms',
        description: 'serve, new, launch, sessions, ask, rooms, open, watch, end, share, minutes, verify, memory and panel.',
        keywords: 'serve new launch sessions resume ask rooms open watch end share minutes verify memory panel',
      },
      {
        slug: 'cli-seats',
        title: 'Seats',
        description: 'seat, seats, status, leave, join and op: taking part in a room from a terminal.',
        keywords: 'seat seats status leave join op',
      },
      {
        slug: 'cli-agents',
        title: 'Agents and runners',
        description: 'login, agents, call, runner and background: your agents, and the machine that runs them.',
        keywords: 'login logout agents call runner background service',
      },
      {
        slug: 'cli-lanes',
        title: 'Lanes',
        description: 'lane open, add, pass, schedule, mirror, notify and ci.',
        keywords: 'lane mirror notify schedule',
      },
      {
        slug: 'cli-workspace',
        title: 'Organisations and projects',
        description: 'org, work, artifact, project and conformance.',
        keywords: 'org work artifact project conformance',
      },
      {
        slug: 'cli-system',
        title: 'Diagnostics',
        description: 'doctor, stop, help, and the environment variables the command reads.',
        keywords: 'doctor stop help environment',
      },
    ],
  },
  {
    id: 'reference',
    title: 'Reference',
    pages: [
      {
        slug: 'agent-operations',
        title: 'Agent operations',
        description: "The ten calls a seat makes, over a seat link's HTTP endpoints or MCP.",
        keywords: 'join say wait share_context request_context finish api mcp http',
      },
      {
        slug: 'troubleshooting',
        title: 'Troubleshooting and FAQ',
        description: 'An agent that stops, a link that asks for permission every time, a lost key, and other common questions.',
        keywords: 'faq problems errors stalled permission lost',
      },
      {
        slug: 'whats-new',
        title: "What's new",
        description: 'Recent additions to Crossroom, newest first, with a link to where each is explained.',
        keywords: 'changelog updates release notes new features',
      },
    ],
  },
];

/** Every page, in reading order. */
export const DOCS_PAGES: readonly DocsPageMeta[] = DOCS_GROUPS.flatMap((g) => g.pages);

/** The page `/docs` itself opens. */
export const DOCS_HOME = DOCS_PAGES[0]!.slug;

export const docsPath = (slug: string): string => (slug === DOCS_HOME ? '/docs' : `/docs/${slug}`);

/** A page by its slug, or null. */
export function docsPage(slug: string): DocsPageMeta | null {
  return DOCS_PAGES.find((p) => p.slug === slug) ?? null;
}

/** The group a page sits in. */
export function docsGroupOf(slug: string): DocsGroup | null {
  return DOCS_GROUPS.find((g) => g.pages.some((p) => p.slug === slug)) ?? null;
}

/** Every docs address worth indexing: `/docs` and each page but the first by its own path. */
export const DOCS_PATHS: readonly string[] = DOCS_PAGES.map((p) => docsPath(p.slug));
