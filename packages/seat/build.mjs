// One file with no dependencies, so `npx -y crossroom-seat@<version>` installs nothing else.
// `@parley/shared` (and the zod it uses) is bundled in: the helper runs the same rendering
// and encryption code as the server and the browser, pinned by this package's version.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
});
