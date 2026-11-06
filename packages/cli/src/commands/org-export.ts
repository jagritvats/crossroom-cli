/**
 * `crossroom org export <org> --out <file> [--data <dir>] [--json]`: an
 * organisation's own database, as a consistent copy (`VACUUM INTO`, which a WAL database allows
 * while the relay is writing it), for its owner. Run by the operator on the relay's own machine,
 * against its data directory (`--data`, else `PARLEY_DATA`, else `~/.parley`). `<org>` is the
 * organisation's id or its slug.
 *
 * What the copy holds: everything in `orgs/<org>.db`, the organisation's rooms, teams, projects,
 * facts, playbooks and audit log, sealed at rest exactly as the original is. A room opens to its
 * owner token, and a project room to the project's key, which is wrapped under the organisation's
 * key, which is wrapped under the instance key: none of those is in the copy. What it does not
 * hold: the directory's rows (members, invitations, routes, the organisation's wrapped key) and
 * the nightly backups.
 *
 * Nothing it reads is written: both databases are opened read-only, and no migration runs. The
 * copy is made at mode 0600 where the system has modes, and never over an existing file. It takes
 * no credential, so nothing secret is ever in its arguments.
 *
 * Exporting through the relay, for an owner signed in with `crossroom login`, needs an owner-only
 * route that serves the file, which is not built: `--relay` says so.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type Args, dataDir, Usage } from '../cli.js';
import { validDbFile } from '../org/db-file.js';

const USAGE = 'crossroom org export <org> --out <file> [--data <dir>]';

/** What the export printed, and `--json` prints as it is. */
export interface OrgExported {
  org: { id: string; slug: string };
  file: string;
  bytes: number;
  sha256: string;
  /** The copy's schema, as its `user_version` counts migration steps. */
  schemaVersion: number;
  rooms: number;
}

export function orgExport(args: Args, say: (line: string) => void): number {
  if (args.flags.relay !== undefined)
    throw new Usage(
      "Exporting through a relay is not built yet. Run this on the relay's own machine, against its data directory: " + USAGE,
    );
  const which = args.positional[1];
  const out = args.flags.out;
  if (!which || typeof out !== 'string' || !out.trim()) throw new Usage(`usage: ${USAGE}`);
  const data = typeof args.flags.data === 'string' ? path.resolve(args.flags.data) : dataDir();

  const dirFile = path.join(data, 'directory.db');
  if (!existsSync(dirFile)) throw new Usage(`There is no directory database in ${data}, so it holds no organisations. Point --data at the relay's data directory.`);
  const directory = new DatabaseSync(dirFile, { readOnly: true });
  let org: { id: string; slug: string; db_file: string; deleted_at: string | null } | undefined;
  try {
    org = directory.prepare('SELECT id, slug, db_file, deleted_at FROM orgs WHERE id = ? OR slug = ? ORDER BY id LIMIT 1').get(which, which) as typeof org;
  } catch {
    throw new Usage(`The directory database in ${data} has no organisations yet.`);
  } finally {
    directory.close();
  }
  if (!org) throw new Usage(`No organisation "${which}" in ${dirFile}. Give its id or its slug.`);
  if (org.deleted_at) throw new Usage(`The organisation ${org.slug} was deleted on ${org.deleted_at}, and its database with it.`);
  if (!validDbFile(org.db_file, org.id)) throw new Usage(`The organisation ${org.slug}'s row does not name its own database (orgs/${org.id}.db), so there is nothing to export.`);
  const src = path.join(data, org.db_file);
  if (!existsSync(src)) throw new Usage(`The organisation ${org.slug} has no database yet: nothing has been made in it.`);

  const target = path.resolve(out);
  mkdirSync(path.dirname(target), { recursive: true });
  // Made empty first, at 0600 and only if nothing is there (`wx`): VACUUM INTO writes into an
  // empty file, and the copy never takes the mode of whatever umask the operator's shell has.
  try {
    closeSync(openSync(target, 'wx', 0o600));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Usage(`${target} exists already. Choose a file that does not.`);
    throw e;
  }
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (e) {
    rmSync(target, { force: true });
    throw e;
  } finally {
    db.close();
  }

  const copy = new DatabaseSync(target, { readOnly: true });
  let schemaVersion = 0;
  let rooms = 0;
  try {
    schemaVersion = Number((copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    rooms = Number((copy.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n);
  } finally {
    copy.close();
  }
  const done: OrgExported = {
    org: { id: org.id, slug: org.slug },
    file: target,
    bytes: statSync(target).size,
    sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
    schemaVersion,
    rooms,
  };
  if (args.flags.json) console.log(JSON.stringify(done, null, 2));
  else {
    console.log(done.file);
    say(`Exported ${org.slug} (${org.id}): ${rooms} room(s), ${done.bytes} bytes, sha256 ${done.sha256}.`);
    say('The copy is sealed at rest like the original: each room opens only to its own keys, none of which is in it.');
  }
  return 0;
}
