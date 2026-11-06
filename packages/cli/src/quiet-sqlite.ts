/**
 * Drop Node's one warning that SQLite is experimental. It is Node's, printed at every start, and
 * nobody running Crossroom can do anything about it; every other warning still prints.
 *
 * It has to be in place before anything imports `node:sqlite`, and a static import of a builtin
 * is linked before any code runs. So the entry points (`cli-main.ts`, and the server's) call this and
 * then load the rest with a dynamic import.
 */
export function dropSqliteWarning() {
  const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/.test(text)) return;
    emit(warning, ...rest);
  }) as typeof process.emitWarning;
}
