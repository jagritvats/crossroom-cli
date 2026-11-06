/**
 * The Node floor, as a module so it runs first.
 *
 * Below 22.13 `node:sqlite` exists but is behind `--experimental-sqlite`, and the failure is
 * "No such built-in module: node:sqlite" thrown from somewhere in the import graph — which
 * tells a newcomer nothing about what to change.
 *
 * This has to be its own module and the first import in its entry point. Imports are hoisted and
 * evaluated before any code in the importing module's body, so the same check written inline
 * in the entry point would run only after `./db.js` had already tried to load `node:sqlite` and
 * thrown. Keep this file free of imports.
 */
const MIN = { major: 22, minor: 13 };

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < MIN.major || (major === MIN.major && minor < MIN.minor)) {
  console.error(
    `Crossroom needs Node ${MIN.major}.${MIN.minor} or newer; this is ${process.versions.node}.\n` +
      'Below that, the SQLite module built into Node is behind a flag. Install a newer Node\n' +
      '(`nvm install 24` or `fnm use 24`) and run this again.',
  );
  process.exit(1);
}
