/**
 * A small JSON Schema subset, checked by hand: what typed tools declare
 * their input and output with, and what Crossroom holds every call's arguments and every result to.
 *
 * Why not a library: the web imports this (no zod, no dependency), and the keywords a library would
 * accept are exactly the ones that cost the most. `pattern` compiles an agent's regex, which is the
 * picomatch lesson again (a backtracking regex runs for minutes on a short input); `$ref` makes a
 * schema a graph, with cycles; `format` means a different thing in every validator. None of them are
 * here, and a schema that uses one is refused when it is declared, with the keyword named, rather
 * than quietly ignored.
 *
 * The subset:
 * - `type`: one of null, boolean, integer, number, string, array, object, or a list of them;
 * - `properties`, `required` and `additionalProperties` (true, false or a schema; true when absent);
 * - `items` (one schema for every element), `minItems`, `maxItems`;
 * - `enum`, `const` (compared as canonical JSON);
 * - `minimum`, `maximum`;
 * - `minLength`, `maxLength`, in UTF-16 code units, as JavaScript's `String.length` counts;
 * - `title`, `description` and `$schema`, as annotations.
 *
 * Bounds: a schema is at most `SCHEMA_MAX_BYTES` of JSON and `SCHEMA_MAX_DEPTH` schemas deep; a
 * value is at most `VALUE_MAX_BYTES` of JSON and `VALUE_MAX_DEPTH` levels deep, with every number
 * finite. Errors name the JSON pointer of what failed (`/items/2: expected integer`).
 *
 * Participants choose every key here, so nothing is indexed by one on a plain object: properties are
 * a `Map`, and a value's own keys are read with `Object.hasOwn`, so `__proto__`, `constructor` and
 * `toString` are names like any other.
 */

/** The largest schema, in UTF-8 bytes of its JSON text. */
export const SCHEMA_MAX_BYTES = 4096;
/** How deep schemas may nest: the root is depth 1, and each `properties`, `items` or `additionalProperties` adds one. */
export const SCHEMA_MAX_DEPTH = 8;
/** The largest value (a call's arguments, a result), in UTF-8 bytes of its JSON text. */
export const VALUE_MAX_BYTES = 16 * 1024;
/** How deep a value may nest: arrays and objects inside one another. */
export const VALUE_MAX_DEPTH = 32;
/** The most problems one check reports; the first is what an error message names. */
const MAX_PROBLEMS = 5;

export const JSON_TYPES = ['null', 'boolean', 'integer', 'number', 'string', 'array', 'object'] as const;
export type JsonType = (typeof JSON_TYPES)[number];

/** The keywords a schema may use. Anything else is refused, named. */
export const SCHEMA_KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'title',
  'description',
  '$schema',
] as const;
const KEYWORDS: ReadonlySet<string> = new Set(SCHEMA_KEYWORDS);

/** A schema, checked and ready to validate with. Built only by `compileSchema`. */
export interface CompiledSchema {
  readonly types: ReadonlySet<JsonType> | null;
  readonly properties: ReadonlyMap<string, CompiledSchema>;
  readonly required: readonly string[];
  /** true: any other key; false: none; a schema: each other key's value. */
  readonly additional: boolean | CompiledSchema;
  readonly items: CompiledSchema | null;
  /** Canonical JSON of each allowed value. */
  readonly enumOf: ReadonlySet<string> | null;
  readonly constOf: string | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly minItems: number | null;
  readonly maxItems: number | null;
}

const utf8 = new TextEncoder();
/** The UTF-8 size of a text, as the bounds count it. */
export const jsonBytes = (text: string) => utf8.encode(text).length;

/** One step of a JSON pointer (RFC 6901): `~` and `/` escaped, and nothing that could break a line. */
function seg(key: string | number): string {
  if (typeof key === 'number') return String(key);
  const clean = [...key]
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 ? ' ' : ch;
    })
    .join('')
    .replace(/~/g, '~0')
    .replace(/\//g, '~1');
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
}
const at = (path: string, key: string | number) => `${path}/${seg(key)}`;
/** A pointer as an error names it: the root is `/`. */
const where = (path: string) => path || '/';

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** What JSON type a parsed value is, `integer` for a whole number. */
export function jsonTypeOf(v: unknown): JsonType | null {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isFinite(v) ? (Number.isInteger(v) ? 'integer' : 'number') : null;
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  if (isPlainObject(v)) return 'object';
  return null;
}

// ---------------------------------------------------------------- canonical JSON

/** The characters JSON.stringify leaves raw that some reader takes as a line break or a control: C1, LS and PS. */
const RAW_UNSAFE = new RegExp(`[${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');
const BACKSLASH = String.fromCharCode(92);

/**
 * A value as canonical JSON text: object keys sorted by UTF-16 code unit (as RFC 8785 sorts them),
 * no whitespace, numbers as JavaScript prints them, and every C1 control and both Unicode line
 * separators escaped, so the text is one line whatever the strings in it hold. Two values that
 * are equal as JSON give the same text. The value must already be checked (`checkValue`): finite
 * numbers, and plain arrays and objects only.
 */
export function canonicalJson(v: unknown): string {
  return walkCanonical(v).replace(RAW_UNSAFE, (c) => `${BACKSLASH}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function walkCanonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(walkCanonical).join(',')}]`;
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${walkCanonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** A value laid out for a person to read: indented, keys in the canonical order. */
export function prettyJson(v: unknown): string {
  return JSON.stringify(JSON.parse(canonicalJson(v)), null, 2);
}

// ---------------------------------------------------------------- values

/**
 * Why a parsed value is outside the bounds, or null: too deep, or holding a number JSON cannot
 * carry (`1e999` parses as Infinity). Walked without recursion, so a deep value cannot exhaust the
 * stack before it is refused.
 */
export function valueProblem(v: unknown, maxDepth = VALUE_MAX_DEPTH, root = ''): string | null {
  const stack: Array<[unknown, number, string]> = [[v, 1, root]];
  while (stack.length) {
    const [x, depth, path] = stack.pop()!;
    if (typeof x === 'number' && !Number.isFinite(x)) return `${where(path)}: numbers must be finite`;
    if (Array.isArray(x) || isPlainObject(x)) {
      if (depth > maxDepth) return `${where(path)}: nested deeper than ${maxDepth} levels`;
      if (Array.isArray(x)) x.forEach((y, i) => stack.push([y, depth + 1, at(path, i)]));
      else for (const k of Object.keys(x)) stack.push([x[k], depth + 1, at(path, k)]);
    }
  }
  return null;
}

/**
 * JSON text as a value, within the bounds: `{ value }`, or `{ error }` in words an agent can act on.
 * `what` names the field in the error ("args", "result").
 */
export function parseJsonValue(text: string, what = 'value', maxBytes = VALUE_MAX_BYTES): { value: unknown } | { error: string } {
  if (typeof text !== 'string' || !text.trim()) return { error: `${what} is required: JSON text, such as {"path":"src/a.ts"}.` };
  const bytes = jsonBytes(text);
  if (bytes > maxBytes) return { error: `${what} is ${bytes} bytes; at most ${maxBytes} bytes of JSON.` };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: `${what} must be JSON text: an object ({"path":"src/a.ts"}), a list, a quoted string, a number, true, false or null.` };
  }
  const problem = valueProblem(value, VALUE_MAX_DEPTH, `/${what}`);
  if (problem) return { error: problem };
  const compact = canonicalJson(value);
  if (jsonBytes(compact) > maxBytes) return { error: `${what} is over ${maxBytes} bytes as compact JSON.` };
  return { value };
}

// ---------------------------------------------------------------- schemas

/**
 * A schema from its JSON text, checked: `{ schema, canonical }`, where `canonical` is the schema as
 * canonical JSON (what is stored and shown), or `{ error }` naming where in the schema it went wrong
 * (`/properties/path: unknown keyword "pattern"`).
 */
export function compileSchemaText(text: string, what = 'schema'): { schema: CompiledSchema; canonical: string; value: unknown } | { error: string } {
  if (typeof text !== 'string' || !text.trim()) return { error: `${what} is required: a JSON Schema object, such as {"type":"object","properties":{"path":{"type":"string"}}}.` };
  const bytes = jsonBytes(text);
  if (bytes > SCHEMA_MAX_BYTES) return { error: `${what} is ${bytes} bytes; a schema is at most ${SCHEMA_MAX_BYTES} bytes of JSON.` };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: `${what} must be JSON text: a JSON Schema object.` };
  }
  const out = compileSchema(value, what);
  if ('error' in out) return out;
  return { ...out, value };
}

/** A parsed schema, checked: as `compileSchemaText`, for a value already parsed. */
export function compileSchema(value: unknown, what = 'schema'): { schema: CompiledSchema; canonical: string } | { error: string } {
  const problem = valueProblem(value, SCHEMA_MAX_DEPTH * 3, `/${what}`);
  if (problem) return { error: problem };
  const canonical = canonicalJson(value);
  if (jsonBytes(canonical) > SCHEMA_MAX_BYTES) return { error: `${what} is over ${SCHEMA_MAX_BYTES} bytes as compact JSON.` };
  try {
    return { schema: compileNode(value, `/${what}`, 1), canonical };
  } catch (e) {
    if (e instanceof SchemaError) return { error: e.message };
    throw e;
  }
}

class SchemaError extends Error {}
const bad = (path: string, why: string): never => {
  throw new SchemaError(`${where(path)}: ${why}`);
};

function count(node: Record<string, unknown>, key: string, path: string): number | null {
  if (!Object.hasOwn(node, key)) return null;
  const v = node[key];
  if (!isCount(v)) bad(at(path, key), 'must be a whole number, 0 or more');
  return v as number;
}

function finite(node: Record<string, unknown>, key: string, path: string): number | null {
  if (!Object.hasOwn(node, key)) return null;
  const v = node[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(at(path, key), 'must be a number');
  return v as number;
}

function compileNode(node: unknown, path: string, depth: number): CompiledSchema {
  if (depth > SCHEMA_MAX_DEPTH) bad(path, `schemas nest at most ${SCHEMA_MAX_DEPTH} deep`);
  if (!isPlainObject(node)) bad(path, 'a schema is a JSON object');
  const n = node as Record<string, unknown>;
  for (const k of Object.keys(n)) {
    if (!KEYWORDS.has(k))
      bad(at(path, k), `unknown keyword "${seg(k)}": a typed tool's schema may use ${SCHEMA_KEYWORDS.filter((x) => x !== '$schema').join(', ')} (no pattern, format or $ref)`);
  }
  for (const k of ['title', 'description', '$schema'])
    if (Object.hasOwn(n, k) && typeof n[k] !== 'string') bad(at(path, k), 'must be a string');

  let types: Set<JsonType> | null = null;
  if (Object.hasOwn(n, 'type')) {
    const t = n.type;
    const list = Array.isArray(t) ? t : [t];
    if (!list.length) bad(at(path, 'type'), 'names at least one type');
    types = new Set();
    for (const x of list) {
      if (typeof x !== 'string' || !(JSON_TYPES as readonly string[]).includes(x)) bad(at(path, 'type'), `each type is one of ${JSON_TYPES.join(', ')}`);
      if (types.has(x as JsonType)) bad(at(path, 'type'), `names ${x} twice`);
      types.add(x as JsonType);
    }
  }

  const properties = new Map<string, CompiledSchema>();
  if (Object.hasOwn(n, 'properties')) {
    const p = n.properties;
    if (!isPlainObject(p)) bad(at(path, 'properties'), 'must be an object of schemas');
    const pp = p as Record<string, unknown>;
    const base = at(path, 'properties');
    for (const k of Object.keys(pp)) properties.set(k, compileNode(pp[k], at(base, k), depth + 1));
  }

  const required: string[] = [];
  if (Object.hasOwn(n, 'required')) {
    const r = n.required;
    if (!Array.isArray(r)) bad(at(path, 'required'), 'must be a list of property names');
    for (const x of r as unknown[]) {
      if (typeof x !== 'string') bad(at(path, 'required'), 'must be a list of property names');
      if (required.includes(x as string)) bad(at(path, 'required'), `names "${seg(x as string)}" twice`);
      required.push(x as string);
    }
  }

  let additional: boolean | CompiledSchema = true;
  if (Object.hasOwn(n, 'additionalProperties')) {
    const a = n.additionalProperties;
    additional = typeof a === 'boolean' ? a : compileNode(a, at(path, 'additionalProperties'), depth + 1);
  }

  const items = Object.hasOwn(n, 'items') ? compileNode(n.items, at(path, 'items'), depth + 1) : null;

  let enumOf: Set<string> | null = null;
  if (Object.hasOwn(n, 'enum')) {
    const e = n.enum;
    if (!Array.isArray(e) || !e.length) bad(at(path, 'enum'), 'must be a list of at least one value');
    enumOf = new Set((e as unknown[]).map(canonicalJson));
  }
  const constOf = Object.hasOwn(n, 'const') ? canonicalJson(n.const) : null;

  const minimum = finite(n, 'minimum', path);
  const maximum = finite(n, 'maximum', path);
  const minLength = count(n, 'minLength', path);
  const maxLength = count(n, 'maxLength', path);
  const minItems = count(n, 'minItems', path);
  const maxItems = count(n, 'maxItems', path);
  if (minimum !== null && maximum !== null && minimum > maximum) bad(path, 'minimum is above maximum');
  if (minLength !== null && maxLength !== null && minLength > maxLength) bad(path, 'minLength is above maxLength');
  if (minItems !== null && maxItems !== null && minItems > maxItems) bad(path, 'minItems is above maxItems');

  return { types, properties, required, additional, items, enumOf, constOf, minimum, maximum, minLength, maxLength, minItems, maxItems };
}

/** A schema that admits anything: what a tool with no output schema answers with. */
export const ANY_SCHEMA: CompiledSchema = (compileSchema({}) as { schema: CompiledSchema }).schema;

/**
 * Every way a value fails a schema, at most a few, each naming its JSON pointer under `root`
 * (`/items/2: expected integer, got string`). Empty when it fits.
 */
export function validateValue(schema: CompiledSchema, value: unknown, root = ''): string[] {
  const out: string[] = [];
  check(schema, value, root, out);
  return out;
}

/** The first problem `validateValue` finds, or null. */
export const firstProblem = (schema: CompiledSchema, value: unknown, root = ''): string | null => validateValue(schema, value, root)[0] ?? null;

function typeFits(types: ReadonlySet<JsonType>, actual: JsonType): boolean {
  return types.has(actual) || (actual === 'integer' && types.has('number'));
}

function check(s: CompiledSchema, v: unknown, path: string, out: string[]): void {
  if (out.length >= MAX_PROBLEMS) return;
  const actual = jsonTypeOf(v);
  if (actual === null) {
    out.push(`${where(path)}: not a JSON value`);
    return;
  }
  if (s.types && !typeFits(s.types, actual)) {
    out.push(`${where(path)}: expected ${[...s.types].join(' or ')}, got ${actual}`);
    return;
  }
  if (s.constOf !== null && canonicalJson(v) !== s.constOf) out.push(`${where(path)}: must equal ${clipText(s.constOf)}`);
  if (s.enumOf && !s.enumOf.has(canonicalJson(v))) out.push(`${where(path)}: must be one of ${clipText([...s.enumOf].join(', '))}`);
  if (typeof v === 'number') {
    if (s.minimum !== null && v < s.minimum) out.push(`${where(path)}: must be at least ${s.minimum}`);
    if (s.maximum !== null && v > s.maximum) out.push(`${where(path)}: must be at most ${s.maximum}`);
  }
  if (typeof v === 'string') {
    if (s.minLength !== null && v.length < s.minLength) out.push(`${where(path)}: must be at least ${s.minLength} characters`);
    if (s.maxLength !== null && v.length > s.maxLength) out.push(`${where(path)}: must be at most ${s.maxLength} characters`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== null && v.length < s.minItems) out.push(`${where(path)}: must hold at least ${s.minItems} items`);
    if (s.maxItems !== null && v.length > s.maxItems) out.push(`${where(path)}: must hold at most ${s.maxItems} items`);
    if (s.items) for (let i = 0; i < v.length && out.length < MAX_PROBLEMS; i++) check(s.items, v[i], at(path, i), out);
  }
  if (isPlainObject(v)) {
    for (const k of s.required) if (!Object.hasOwn(v, k)) out.push(`${at(path, k)}: is required`);
    for (const k of Object.keys(v)) {
      if (out.length >= MAX_PROBLEMS) return;
      const sub = s.properties.get(k);
      if (sub) check(sub, v[k], at(path, k), out);
      else if (s.additional === false) out.push(`${at(path, k)}: is not a property this schema allows`);
      else if (s.additional !== true) check(s.additional, v[k], at(path, k), out);
    }
  }
}

const clipText = (t: string) => (t.length > 120 ? `${t.slice(0, 119)}…` : t);
