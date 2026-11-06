#!/usr/bin/env node
/**
 * The `crossroom` command's entry point.
 *
 * Everything that loads `node:sqlite` sits behind the dynamic import below, so two things
 * happen before it can load. In the bundle a static import would be linked before any code
 * here ran, and on Node 22.12 that is an unexplained "no such built-in module".
 * - The Node check runs, and can say what to install instead of failing obscurely.
 * - Node's one warning that SQLite is experimental is dropped. It is Node's, printed on every
 *   command, and there is nothing a user of this command could do about it.
 */
import './node-check.js';
import { dropSqliteWarning } from './quiet-sqlite.js';

dropSqliteWarning();
const { run } = await import('./cli.js');
// `serve` never resolves, so this exits only for the commands that finish.
process.exitCode = await run(process.argv.slice(2));
