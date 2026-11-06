/**
 * Azure DevOps work items, by their address: what the server's import, the `crossroom` command and the
 * web app all read the same way. Zod-free, so the web imports it.
 *
 * An item's address comes in a few shapes, all of them parsed here and nothing else:
 * - `https://dev.azure.com/<org>/<project>/_workitems/edit/<id>` (the item's own page; a trailing path
 *   segment such as a title slug, a query or a fragment is fine);
 * - `https://<org>.visualstudio.com/<project>/_workitems/edit/<id>` (the older host, which names the
 *   organization itself);
 * - a board, backlog or query page with `?workitem=<id>` (what the address bar shows while an item is
 *   open over a board).
 *
 * Only https, only those two hosts, no credentials, no port. The project name may hold spaces and other
 * characters a URL escapes; it is read decoded, and refused if it holds a control character or a slash.
 * An item is named by `<org>/<project>#<id>` (`azureExternalId`), with the organization lower-cased
 * (Azure DevOps reads organization names without case) and the project as written, so one item is
 * one id whichever address it came by.
 */
import { oneLine } from './text.js';

/** The provider a work item's `source` names for Azure DevOps. */
export const AZURE_PROVIDER = 'azure' as const;

/** How the web app and the command name the provider to a person. */
export const AZURE_WORD = 'Azure DevOps';

export interface AzureWorkItemRef {
  /** The organization, lower-cased. */
  org: string;
  /** The project, as written (decoded). */
  project: string;
  id: number;
  /** The item's own page, on dev.azure.com, whichever host the address came by. */
  url: string;
  /** `<org>/<project>#<id>`: what an imported item is deduped on. */
  externalId: string;
}

const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/;
const ID_MAX = 2_147_483_647;

/** `<org>/<project>#<id>`, the id an imported Azure DevOps item is deduped on. */
export const azureExternalId = (org: string, project: string, id: number) => `${org.toLowerCase()}/${project}#${id}`;

/** The item's own page on dev.azure.com. */
export const azureItemUrl = (org: string, project: string, id: number) =>
  `https://dev.azure.com/${encodeURIComponent(org.toLowerCase())}/${encodeURIComponent(project)}/_workitems/edit/${id}`;

const decode = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

const projectOk = (p: string) => p.length >= 1 && p.length <= 64 && !/[\\/]/.test(p) && ![...p].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) && p.trim() === p;

const idOf = (raw: string | null | undefined): number | null => {
  if (!raw || !/^[0-9]{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= ID_MAX ? n : null;
};

/** The work item an Azure DevOps address names, or null for anything else. */
export function parseAzureWorkItemUrl(raw: string): AzureWorkItemRef | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter((s) => s !== '');
  let org: string;
  let rest: string[];
  if (host === 'dev.azure.com') {
    const [o, ...r] = segs;
    if (!o) return null;
    org = o;
    rest = r;
  } else {
    const m = /^([a-z0-9][a-z0-9-]{0,49})\.visualstudio\.com$/.exec(host);
    if (!m) return null;
    org = m[1]!;
    rest = segs;
  }
  if (!ORG.test(org)) return null;
  const [projRaw, area, ...after] = rest;
  if (!projRaw || !area) return null;
  const project = decode(projRaw);
  if (project === null || !projectOk(project)) return null;
  let id: number | null = null;
  if (area === '_workitems' && after[0] === 'edit') id = idOf(after[1]);
  // An item open over a board, a backlog or a query: `?workitem=<id>`.
  if (id === null && area.startsWith('_')) id = idOf(u.searchParams.get('workitem'));
  if (id === null) return null;
  return { org: org.toLowerCase(), project, id, url: azureItemUrl(org, project, id), externalId: azureExternalId(org, project, id) };
}

/** Whether an address is an Azure DevOps host at all (so a refusal can name the right provider). */
export function isAzureHost(raw: string): boolean {
  try {
    const h = new URL(raw.trim()).hostname.toLowerCase();
    return h === 'dev.azure.com' || /\.visualstudio\.com$/.test(h);
  } catch {
    return false;
  }
}

/** The environment variables a person's own Azure DevOps token is read from, in order (as the lanes' mirror reads them). */
export const AZURE_TOKEN_ENV = ['AZURE_DEVOPS_PAT', 'AZURE_DEVOPS_EXT_PAT', 'SYSTEM_ACCESSTOKEN'] as const;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const BREAKS = /^<(?:br\b|\/(?:p|div|li|h[1-6]|tr|blockquote|pre)\b)/i;

/**
 * An HTML field as plain text: `<br>` and a block's end as a line break, other tags dropped, the
 * common entities decoded. HTML comments are kept as they stand, so the engine's `stripHidden`
 * sees and removes them like any other hidden text.
 */
export function fromHtml(s: string): string {
  return s
    .replace(/<!--[\s\S]*?(?:-->|$)|<[^>]*>/g, (m) => (m.startsWith('<!--') ? m : BREAKS.test(m) ? '\n' : ''))
    .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : m;
    })
    .replace(/\n+$/, '');
}

/** What a work item says, reduced to what Crossroom keeps: plain, one-line words, bounded as `ReportedImportInput` takes them. */
export interface AzureItemText {
  title: string;
  body: string;
  state: string;
  type: string;
  assignedTo: string | null;
}

const fieldStr = (v: unknown) => (typeof v === 'string' ? v : '');
const shortWord = (v: string, max: number) => oneLine(v).trim().slice(0, max).trim();
/** An HTML field as text, without the comments `fromHtml` keeps for the lane mirror. */
const htmlText = (html: string) =>
  fromHtml(html)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .trim();

/**
 * A work item's fields, as the REST API answers them (`System.Title`, ...), as text. A bug keeps its
 * story in Repro Steps, every other type in Description. The body is not clipped here.
 */
export function azureItemText(fields: Record<string, unknown>, ref: Pick<AzureWorkItemRef, 'org' | 'project' | 'id'>): AzureItemText {
  const a = fields['System.AssignedTo'];
  const assigned = a && typeof a === 'object' ? fieldStr((a as Record<string, unknown>).displayName) : fieldStr(a);
  return {
    title: shortWord(fieldStr(fields['System.Title']), 200) || `${ref.org}/${ref.project}#${ref.id}`,
    body: htmlText(fieldStr(fields['System.Description'])) || htmlText(fieldStr(fields['Microsoft.VSTS.TCM.ReproSteps'])),
    state: shortWord(fieldStr(fields['System.State']), 60),
    type: shortWord(fieldStr(fields['System.WorkItemType']), 60),
    assignedTo: shortWord(assigned, 120) || null,
  };
}
