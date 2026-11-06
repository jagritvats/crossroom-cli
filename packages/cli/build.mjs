/**
 * Build the `crossroom` command into dist/: one entry with no dependencies to install, the licence
 * and the notices of what it bundles.
 *
 * This is the open-source client: the commands that talk to a Crossroom instance and run your own
 * agents. It carries no server and no web app; `@parley/server-bundle` builds the command that does.
 * Everything it imports (zod, yaml, the MCP SDK, `@parley/shared`) is bundled, so `npx` downloads
 * one package and starts at once; `node:sqlite` is Node's own.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
const out = path.join(here, 'dist');

rmSync(out, { recursive: true, force: true });
const result = await build({
  metafile: true,
  entryPoints: { crossroom: path.join(here, 'src/cli-main.ts') },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  // cli-main.ts imports the rest dynamically, after its Node check, so the rest is a chunk of its
  // own: in one file, `node:sqlite` would be linked before the check could run.
  splitting: true,
  chunkNames: '[name]-[hash]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  define: { __PARLEY_VERSION__: JSON.stringify(pkg.version) },
  // `ee/` is FSL-1.1-ALv2, and this package is Apache-2.0: none of it is bundled. The client never
  // imports it; naming it here keeps it out should that ever change.
  external: ['@parley/ee', '@parley/ee/*'],
  // Some bundled dependencies are CommonJS and call require(); an ES module has none of its own.
  banner: { js: "import { createRequire as __parleyRequire } from 'node:module'; const require = __parleyRequire(import.meta.url);" },
  legalComments: 'eof',
  logLevel: 'warning',
});

// The client is the server's open half: nothing of the server, the web app or `ee/` may reach it.
const leaks = Object.keys(result.metafile.inputs).filter(serverSide);
if (leaks.length > 0) {
  rmSync(out, { recursive: true, force: true });
  console.error(`The crossroom client bundled ${leaks.length} file(s) of the server, the web app or ee/:`);
  for (const f of leaks.slice(0, 20)) console.error(`  ${f}`);
  if (leaks.length > 20) console.error(`  … and ${leaks.length - 20} more`);
  console.error('Move what the client needs into packages/cli/src or packages/shared, or leave the import to the server.');
  process.exit(1);
}

copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
writeFileSync(path.join(out, 'THIRD-PARTY-NOTICES.md'), notices(result.metafile));
console.log(`built ${path.relative(root, out)} (crossroom ${pkg.version})`);

/** An input esbuild names (relative to the cwd) that belongs to the server's side. */
function serverSide(input) {
  const rel = path.relative(root, path.resolve(input)).split(path.sep).join('/');
  if (/^(apps\/server|apps\/web|ee)\//.test(rel)) return true;
  const parts = rel.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return false;
  const name = parts[at + 1] ?? '';
  return name === 'hono' || name === '@hono';
}

/**
 * The licences of the npm packages esbuild bundled into the command. Apache-2.0 covers Crossroom's
 * own code; MIT, ISC and BSD ask that their notices travel with copies, and most of them have no
 * legal comment for esbuild to keep.
 */
function notices(metafile) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const parts = path.resolve(input).split(path.sep);
    const at = parts.lastIndexOf('node_modules');
    if (at < 0) continue;
    const width = parts[at + 1]?.startsWith('@') ? 3 : 2;
    const dir = parts.slice(0, at + width).join(path.sep);
    if (existsSync(path.join(dir, 'package.json'))) dirs.add(realpathSync(dir));
  }
  const entries = [...dirs]
    .map((dir) => {
      const meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
      return { name: meta.name, version: meta.version, license: meta.license ?? 'see the package', text: file ? readFileSync(path.join(dir, file), 'utf8').trim() : '' };
    })
    .filter((e) => e.name && !e.name.startsWith('@parley/'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set();
  const lines = [
    '# Third-party notices',
    '',
    'The `crossroom` package bundles the following packages. Each is under its own licence, given below.',
    '',
  ];
  for (const e of entries) {
    const key = `${e.name}@${e.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`## ${key}`, '', `License: ${e.license}`, '');
    if (e.text) lines.push('```', e.text.replace(/\r\n?/g, '\n'), '```', '');
  }
  return lines.join('\n');
}
