/**
 * Notes a runner posts on a Linear issue, a Jira issue or a PagerDuty incident: one HTTPS
 * post each, with the runner's own credentials, after the runner's policy allowed it.
 *
 * **Credentials come from the runner's environment, and only there:** `PARLEY_LINEAR_API_KEY`;
 * `PARLEY_JIRA_SITE`, `PARLEY_JIRA_EMAIL` and `PARLEY_JIRA_API_TOKEN`; `PARLEY_PAGERDUTY_TOKEN`
 * and `PARLEY_PAGERDUTY_FROM` (the email PagerDuty records the note as from); for Slack,
 * `PARLEY_SLACK_BOT_TOKEN` and `PARLEY_SLACK_APP_TOKEN` (runner/effects/slack.ts). Every one is a
 * `PARLEY_*` variable, which `childEnv` (runners/hosted.ts) drops from every agent CLI's
 * environment, so no agent the runner starts can read them. The egress check's known-secret
 * scan reads secret-looking variables too, so an agent could not share one if it found it.
 *
 * Where each posts is fixed (Linear's and PagerDuty's APIs) or the operator's (a Jira site), never
 * anything an effect names. `PARLEY_LINEAR_URL` and `PARLEY_PAGERDUTY_URL` exist for tests and
 * proxies, and take https only (or http on loopback).
 *
 * Each note ends with `parley-effect:<id>` as plain text: these services print an HTML comment as
 * it stands. A note that may have been posted before is looked for by that tag (`find`) before
 * the effects loop posts it again.
 */
import { callJson, EffectHttpError, type FetchLike, seg, serviceBase } from './http.js';
import { type EffectPayload, effectTag } from './wire.js';

export const LINEAR_URL = 'https://api.linear.app/graphql';
export const PAGERDUTY_URL = 'https://api.pagerduty.com';
/** PagerDuty's longest note. Linear and Jira take more than an effect carries. */
const PAGERDUTY_NOTE_MAX = 25_000;

export interface VendorConfig {
  linear?: { key: string; url: string };
  jira?: { site: string; email: string; token: string };
  pagerduty?: { token: string; from: string; url: string };
}

const val = (env: NodeJS.ProcessEnv, k: string) => env[k]?.trim() || undefined;

/**
 * What the runner's environment configures, each service on its own. A service half configured
 * (a Jira site with no token) is left out, so its effects fail `not_configured` rather than post
 * with half a credential. A base address that is not https leaves that service out too: with
 * `warn`, which is told why; without it, the read throws, for a caller that wants to stop.
 */
export function vendorConfigFromEnv(env: NodeJS.ProcessEnv = process.env, warn?: (why: string) => void): VendorConfig {
  const out: VendorConfig = {};
  const each = (what: string, f: () => void) => {
    try {
      f();
    } catch (e) {
      if (!warn) throw e;
      warn(`${what} is left out: ${(e as Error).message}`);
    }
  };
  each('Linear', () => {
    const key = val(env, 'PARLEY_LINEAR_API_KEY');
    if (key) out.linear = { key, url: serviceBase(val(env, 'PARLEY_LINEAR_URL') ?? LINEAR_URL, 'PARLEY_LINEAR_URL') };
  });
  each('Jira', () => {
    const site = val(env, 'PARLEY_JIRA_SITE');
    const email = val(env, 'PARLEY_JIRA_EMAIL');
    const token = val(env, 'PARLEY_JIRA_API_TOKEN');
    if (site && email && token) out.jira = { site: serviceBase(site.includes('://') ? site : `https://${site}`, 'PARLEY_JIRA_SITE'), email, token };
  });
  each('PagerDuty', () => {
    const token = val(env, 'PARLEY_PAGERDUTY_TOKEN');
    const from = val(env, 'PARLEY_PAGERDUTY_FROM');
    if (token && from) out.pagerduty = { token, from, url: serviceBase(val(env, 'PARLEY_PAGERDUTY_URL') ?? PAGERDUTY_URL, 'PARLEY_PAGERDUTY_URL') };
  });
  return out;
}

/** Every credential a vendor config holds, for scrubbing. */
export const vendorSecrets = (c: VendorConfig): string[] => [c.linear?.key, c.jira?.token, c.pagerduty?.token].filter((s): s is string => !!s);

const notConfigured = (what: string, how: string) => new EffectHttpError('not_configured', 0, `this runner posts no ${what}: set ${how}`, false);

const withTag = (text: string, id: string, max = Number.POSITIVE_INFINITY) => {
  const tag = effectTag(id);
  const room = max - tag.length - 2;
  return `${text.length > room ? `${text.slice(0, room - 1)}…` : text}\n\n${tag}`;
};

const notMine = (p: EffectPayload): never => {
  throw new EffectHttpError('kind_off', 0, `${p.kind} is not a note this module posts`, false);
};

export class VendorEffects {
  constructor(private readonly o: { fetch: FetchLike; config: () => VendorConfig }) {}

  secrets(): string[] {
    return vendorSecrets(this.o.config());
  }

  // -------------------------------------------------------------- Linear

  private async linear(query: string, variables: Record<string, unknown>, what: string) {
    const c = this.o.config().linear;
    if (!c) throw notConfigured('Linear notes', 'PARLEY_LINEAR_API_KEY');
    const res = await callJson({
      fetch: this.o.fetch,
      method: 'POST',
      url: c.url,
      headers: { authorization: c.key },
      body: { query, variables },
      what,
      secrets: [c.key],
    });
    const j = res.json as { data?: any; errors?: { extensions?: { code?: string } }[] } | null;
    if (j?.errors?.length) {
      const code = j.errors[0]?.extensions?.code;
      throw new EffectHttpError(code === 'AUTHENTICATION_ERROR' ? 'auth' : code === 'FORBIDDEN' ? 'forbidden' : 'rejected', res.status, `${what}: Linear refused it`, false);
    }
    return j?.data;
  }

  // -------------------------------------------------------------- Jira

  private jira() {
    const c = this.o.config().jira;
    if (!c) throw notConfigured('Jira notes', 'PARLEY_JIRA_SITE, PARLEY_JIRA_EMAIL and PARLEY_JIRA_API_TOKEN');
    const authorization = `Basic ${Buffer.from(`${c.email}:${c.token}`).toString('base64')}`;
    return { c, headers: { authorization }, secrets: [c.token, authorization] };
  }

  // -------------------------------------------------------------- PagerDuty

  private pagerduty() {
    const c = this.o.config().pagerduty;
    if (!c) throw notConfigured('PagerDuty notes', 'PARLEY_PAGERDUTY_TOKEN and PARLEY_PAGERDUTY_FROM');
    return {
      c,
      headers: { authorization: `Token token=${c.token}`, from: c.from, accept: 'application/vnd.pagerduty+json;version=2' },
    };
  }

  /** The service an incident belongs to: what a `pagerduty_note` rule is written against. A read, before anything is posted. */
  async pagerdutyService(incident: string): Promise<string | null> {
    const { c, headers } = this.pagerduty();
    const res = await callJson({ fetch: this.o.fetch, method: 'GET', url: `${c.url}/incidents/${seg(incident)}`, headers, what: "reading the incident's service", secrets: [c.token] });
    const id = (res.json as any)?.incident?.service?.id;
    return typeof id === 'string' ? id : null;
  }

  // -------------------------------------------------------------- finding and posting

  /** This effect's note, if an earlier attempt posted it: its id, or null. Reads only. */
  async find(p: EffectPayload): Promise<string | null> {
    const tag = effectTag(p.effectId);
    if (p.kind === 'linear_note') {
      const data = await this.linear('query($id: String!) { issue(id: $id) { comments(first: 100) { nodes { id body } } } }', { id: p.target.issue }, 'looking for the note posted before');
      const hit = (data?.issue?.comments?.nodes ?? []).find((n: any) => typeof n?.body === 'string' && n.body.includes(tag));
      return hit ? String(hit.id) : null;
    }
    if (p.kind === 'jira_note') {
      const { c, headers, secrets } = this.jira();
      const url = `${c.site}/rest/api/3/issue/${seg(p.target.issue)}/comment?maxResults=100&orderBy=-created`;
      const res = await callJson({ fetch: this.o.fetch, method: 'GET', url, headers, what: 'looking for the note posted before', secrets });
      const hit = ((res.json as any)?.comments ?? []).find((n: any) => JSON.stringify(n?.body ?? '').includes(tag));
      return hit ? String(hit.id) : null;
    }
    if (p.kind === 'pagerduty_note') {
      const { c, headers } = this.pagerduty();
      const url = `${c.url}/incidents/${seg(p.target.incident)}/notes`;
      const res = await callJson({ fetch: this.o.fetch, method: 'GET', url, headers, what: 'looking for the note posted before', secrets: [c.token] });
      const hit = ((res.json as any)?.notes ?? []).find((n: any) => typeof n?.content === 'string' && n.content.includes(tag));
      return hit ? String(hit.id) : null;
    }
    return notMine(p);
  }

  /** Post the note, tagged with its effect id. Answers the service's id for it. */
  async post(p: EffectPayload): Promise<string | null> {
    if (p.kind === 'linear_note') {
      const data = await this.linear(
        'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }',
        { input: { issueId: p.target.issue, body: withTag(p.text, p.effectId) } },
        'posting a Linear note',
      );
      if (!data?.commentCreate?.success) throw new EffectHttpError('rejected', 200, 'posting a Linear note: Linear did not take it', false);
      const id = data.commentCreate.comment?.id;
      return typeof id === 'string' ? id : null;
    }
    if (p.kind === 'jira_note') {
      const { c, headers, secrets } = this.jira();
      // Atlassian Document Format: one paragraph per line of the text, then the tag.
      const lines = withTag(p.text, p.effectId)
        .split(/\r?\n/)
        .filter((l) => l.trim());
      const body = { type: 'doc', version: 1, content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) };
      const res = await callJson({ fetch: this.o.fetch, method: 'POST', url: `${c.site}/rest/api/3/issue/${seg(p.target.issue)}/comment`, headers, body: { body }, what: 'posting a Jira note', secrets });
      const id = (res.json as { id?: unknown } | null)?.id;
      return typeof id === 'string' ? id : null;
    }
    if (p.kind === 'pagerduty_note') {
      const { c, headers } = this.pagerduty();
      const res = await callJson({
        fetch: this.o.fetch,
        method: 'POST',
        url: `${c.url}/incidents/${seg(p.target.incident)}/notes`,
        headers,
        body: { note: { content: withTag(p.text, p.effectId, PAGERDUTY_NOTE_MAX) } },
        what: 'posting a PagerDuty note',
        secrets: [c.token],
      });
      const id = (res.json as any)?.note?.id;
      return typeof id === 'string' ? id : null;
    }
    return notMine(p);
  }
}
