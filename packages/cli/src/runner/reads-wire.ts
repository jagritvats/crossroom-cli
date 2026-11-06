/**
 * Reading a tracker through a team's runner: the wire between the relay, which queues a read a
 * member asked for (or a saved sync's schedule), and the runner, which reads with the credentials its
 * operator gave it and reports what it read.
 *
 * The relay never reads a private tracker and never holds a credential that could. It seals each read
 * to one runner's X25519 key (`sealText`, runner/effects/seal.ts, `j1.`) and hands it over on
 * `POST /api/runner/reads/lease`; the runner opens it, checks it against its own `effects.yml`
 * (`tracker_read` rules, runner/effects/policy.ts), reads with the shared readers
 * (`@parley/shared/tracker-read`), reports items in batches on `POST /api/runner/reads/:id/items`,
 * and finishes on `POST /api/runner/reads/:id` with a code. Nothing in a payload is a credential or
 * a host the runner would send one to: an item's address and a place's address name the tracker,
 * and the runner sends its credential only to the tracker its own environment names.
 *
 * A read is at most once in effect, at least once on the wire: a lease that runs out hands it over
 * again, and every report is an upsert deduped on the item, so a read reported twice changes nothing more.
 *
 * Pure: zod and the shared contract, so both sides import it.
 */
import { TRACKER_READ_CODES, TRACKER_READ_ITEMS_MAX, TRACKER_REPORT_BATCH_MAX } from '@parley/shared/trackers';
import { ReportedImportInput } from '@parley/shared/work';
import { z } from 'zod';

/** A read's id: `trd_` and 22 characters of base64url. */
export const TRACKER_READ_ID = /^trd_[A-Za-z0-9_-]{22}$/;

/** What a sealed read is bound to: its runner, its id and its kind. */
export const readAad = (runnerId: string, readId: string, kind: string) => `parley/tracker-read/v1|${runnerId}|${readId}|${kind}`;

/** How long a leased read is its runner's before the relay hands it over again. */
export const READ_LEASE_S = 600;
/** A read nobody leased in this long expires (`expired`). */
export const READ_EXPIRY_MS = 30 * 60_000;
/** Leases one read may take before the relay gives up on it (`failed`, `tracker_error`). */
export const READ_MAX_ATTEMPTS = 4;
/** What a lease parks for, and its bounds, in seconds. */
export const READ_LEASE_WAIT_S = { default: 45, min: 5, max: 50 } as const;
/** Reads one runner may have waiting at once. */
export const READS_QUEUED_PER_RUNNER = 50;
/** Read leases one runner may have parked at once. */
export const READ_LEASES_PARKED_PER_RUNNER = 1;

const Url = z.url().max(2000);

/** A filter as the payload carries it: the shared `TrackerFilter`, whose values the runner bounds again (`normalFilter`). */
const FilterName = z.object({ name: z.string().min(1).max(200) }).strict();
export const WireFilter = z
  .object({
    assignee: z.union([z.enum(['me', 'anyone', 'unassigned']), FilterName]),
    states: z.array(z.string().max(200)).max(20),
    types: z.array(z.string().max(200)).max(20),
    sprint: z.union([z.enum(['any', 'current']), FilterName]),
    area: z.string().max(200).nullable(),
    labels: z.array(z.string().max(200)).max(20),
    text: z.string().max(200).nullable(),
    raw: z.string().max(2000).nullable(),
  })
  .strict();

/** A read as the runner opens it. */
export const ReadPayload = z
  .object({
    v: z.literal(1),
    readId: z.string().regex(TRACKER_READ_ID),
    runnerId: z.string().min(1).max(64),
    provider: z.enum(['github', 'azure', 'jira']),
    kind: z.enum(['item', 'sync']),
    /** An item read: the item's address. */
    url: Url.optional(),
    /** A sync: the place, its condition or filter, the sprint and team, and the most items to read. */
    where: Url.optional(),
    query: z.string().max(2000).optional(),
    filter: WireFilter.nullable().optional(),
    sprint: z.enum(['current']).nullable().optional(),
    team: z.string().max(120).nullable().optional(),
    limit: z.number().int().min(1).max(TRACKER_READ_ITEMS_MAX).optional(),
    /** The relay's public URL: the runner refuses a read naming any relay but the one it registered with. */
    relay: z.url().max(512),
    issuedAt: z.iso.datetime(),
  })
  .strict()
  .refine((p) => (p.kind === 'item' ? !!p.url && !p.where : !!p.where && !p.url && p.limit !== undefined), 'an item read names its url; a sync names its place and limit');
export type ReadPayload = z.infer<typeof ReadPayload>;

/** `POST /api/runner/reads/lease`. */
export const ReadLeaseInput = z
  .object({
    waitS: z.number().int().min(READ_LEASE_WAIT_S.min).max(READ_LEASE_WAIT_S.max).optional(),
    max: z.number().int().min(1).max(5).optional(),
  })
  .strict();
export type ReadLeaseInput = z.infer<typeof ReadLeaseInput>;

export const LeasedRead = z
  .object({
    id: z.string().regex(TRACKER_READ_ID),
    kind: z.enum(['item', 'sync']),
    payload: z.string().min(1).max(256 * 1024),
    createdAt: z.string(),
    leaseUntil: z.string(),
  })
  .strict();
export type LeasedRead = z.infer<typeof LeasedRead>;
export interface ReadLeaseResult {
  reads: LeasedRead[];
}

/** `POST /api/runner/reads/:id/items`: up to `TRACKER_REPORT_BATCH_MAX` items the runner read for this read. */
export const ReadItemsInput = z.object({ items: z.array(ReportedImportInput).min(1).max(TRACKER_REPORT_BATCH_MAX) }).strict();
export type ReadItemsInput = z.infer<typeof ReadItemsInput>;
export interface ReadItemsResult {
  results: Array<{ ok: true; workId: string; updated: boolean } | { ok: false; url: string; error: string }>;
  /** The relay withdrew the read meanwhile (it expired, its project is gone): stop. */
  cancel?: boolean;
}

/** The codes a runner finishes a read with: not `expired` or `cancelled`, which are the relay's. */
export const RUNNER_READ_CODES = TRACKER_READ_CODES.filter((c) => c !== 'expired' && c !== 'cancelled') as ['not_configured', 'not_allowed', 'not_found', 'tracker_error'];

/** `POST /api/runner/reads/:id`: the read is done, or why not. */
export const ReadFinishInput = z.discriminatedUnion('state', [
  z.object({ state: z.literal('done') }).strict(),
  z.object({ state: z.literal('refused'), code: z.enum(['not_configured', 'not_allowed']) }).strict(),
  z.object({ state: z.literal('failed'), code: z.enum(['not_found', 'tracker_error']) }).strict(),
]);
export type ReadFinishInput = z.infer<typeof ReadFinishInput>;
export interface ReadFinishResult {
  ok: true;
  read: { id: string; state: string };
}

/** The one 404 for a read this runner cannot see, in the words of a job's and an effect's. */
export const READ_GONE = 'no such job for this runner';
