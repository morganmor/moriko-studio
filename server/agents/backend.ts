/**
 * BACKEND HARNESS (F5) — conditional backend layer: ephemeral SQLite,
 * deterministic seeding, OpenAPI contract enforcement.
 *
 * Design contract (docs/plans/PLAN-SPATIAL-HARNESS.md F5 "backend as-is"):
 *  - The layer is INERT unless asked. It never touches the workspace, never
 *    runs migrations on its own, and adds zero runtime dependencies.
 *  - SQLite comes from Node's built-in `node:sqlite` (no native build step,
 *    no supply-chain surface). Databases opened WITHOUT a file are
 *    EPHEMERAL: they live in this process only and die with it.
 *  - Registries are per-agent-session, LRU-capped: an agent cannot leak an
 *    unbounded number of databases across a long conversation.
 *
 * Three capabilities, each fail-loud with actionable errors:
 *   db      — open / exec / query / fork / discard named databases
 *   seed    — deterministic row generation (same seed → same rows)
 *   contract— lint an OpenAPI (JSON) spec + validate request bodies against
 *             it — the subset a frontend/backend contract needs daily
 */

import { DatabaseSync } from 'node:sqlite';


export const MAX_DBS_PER_SESSION = 8;
const FORK_MAX_ROWS_PER_TABLE = 50_000;

interface BackendDb {
  name: string;
  db: DatabaseSync;
  /** false = backed by a file on disk (survives the process) */
  ephemeral: boolean;
  createdAt: number;
  lastUsed: number;
}

const registries = new Map<string, Map<string, BackendDb>>();

function registryFor(sessionId: string | undefined): Map<string, BackendDb> {
  const session = (sessionId ?? 'default').slice(0, 80);
  let registry = registries.get(session);
  if (!registry) {
    registry = new Map();
    registries.set(session, registry);
  }
  return registry;
}

function touch(entry: BackendDb): void {
  entry.lastUsed = Date.now();
}

/** Evict the least-recently-used database when the session cap is hit. */
function evictIfNeeded(registry: Map<string, BackendDb>): void {
  while (registry.size >= MAX_DBS_PER_SESSION) {
    let oldestKey: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, entry] of registry) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    const evicted = registry.get(oldestKey);
    try {
      evicted?.db.close();
    } catch {
    }
    registry.delete(oldestKey);
  }
}

export interface DbOpenOptions {
  sessionId: string | undefined;
  name: string;
  /** absolute path — when given, the DB is FILE-BACKED (not ephemeral) */
  filePath?: string;
}

export function openDb(opts: DbOpenOptions): { name: string; ephemeral: boolean } {
  const registry = registryFor(opts.sessionId);
  const existing = registry.get(opts.name);
  if (existing) {
    touch(existing);
    return { name: opts.name, ephemeral: existing.ephemeral };
  }
  evictIfNeeded(registry);
  const db = opts.filePath
    ? new DatabaseSync(opts.filePath)
    : new DatabaseSync(':memory:');
  registry.set(opts.name, {
    name: opts.name,
    db,
    ephemeral: !opts.filePath,
    createdAt: Date.now(),
    lastUsed: Date.now(),
  });
  return { name: opts.name, ephemeral: !opts.filePath };
}

function getDb(sessionId: string | undefined, name: string): BackendDb {
  const registry = registryFor(sessionId);
  const entry = registry.get(name);
  if (!entry) {
    throw new Error(
      `Database "${name}" is not open in this session. Open it first with action "open" — ` +
      `note that in-memory databases die with the server process (that is the ephemerality).`,
    );
  }
  touch(entry);
  return entry;
}

export interface SqlOutcome {
  changes: number | bigint;
  lastInsertRowid: number | bigint | undefined;
}

/** Execute a write statement (CREATE/INSERT/UPDATE/DELETE…). */
export function execDb(
  sessionId: string | undefined,
  name: string,
  sql: string,
  params: unknown[] = [],
): SqlOutcome {
  const { db } = getDb(sessionId, name);
  const stmt = db.prepare(sql);
  // else is a caller bug, so coerce unknown → the accepted value type once.
  const info = stmt.run(...(params.map(toSqlValue) as SqlValue[]));
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

/** The value types node:sqlite binds natively. */
type SqlValue = null | number | bigint | string | Uint8Array;

function toSqlValue(value: unknown): SqlValue {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return JSON.stringify(value);
}

export interface QueryRows {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}

const MAX_QUERY_ROWS = 500;

/** Run a read query, returning at most 500 rows. */
export function queryDb(
  sessionId: string | undefined,
  name: string,
  sql: string,
  params: unknown[] = [],
): QueryRows {
  const { db } = getDb(sessionId, name);
  const stmt = db.prepare(sql);
  const columns = stmt.columns().map((c) => c.name);
  const all = stmt.all(...(params.map(toSqlValue) as SqlValue[])) as Array<Record<string, unknown>>;
  return {
    columns: columns.length > 0 ? columns : all.length > 0 ? Object.keys(all[0]) : [],
    rows: all.slice(0, MAX_QUERY_ROWS),
    truncated: all.length > MAX_QUERY_ROWS,
  };
}

/** Close and forget one database (in-memory data is gone — that is the point). */
export function discardDb(sessionId: string | undefined, name: string): boolean {
  const registry = registryFor(sessionId);
  const entry = registry.get(name);
  if (!entry) return false;
  try {
    entry.db.close();
  } catch {
  }
  registry.delete(name);
  return true;
}

export interface DbInfo {
  name: string;
  ephemeral: boolean;
  tables: string[];
  createdAt: number;
}

export function listDbs(sessionId: string | undefined): DbInfo[] {
  const registry = registryFor(sessionId);
  const out: DbInfo[] = [];
  for (const entry of registry.values()) {
    let tables: string[] = [];
    try {
      const rows = entry.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all() as Array<{ name: string }>;
      tables = rows.map((r) => r.name);
    } catch {
      tables = [];
    }
    out.push({ name: entry.name, ephemeral: entry.ephemeral, tables, createdAt: entry.createdAt });
  }
  return out;
}


/**
 * Branch `sourceName` into a new database `forkName`: same schema, same data
 * (bounded), fully independent. This is the "try a migration on a copy"
 * move — the original is untouched, the fork dies with the session unless
 * explicitly persisted later.
 */
export function forkDb(
  sessionId: string | undefined,
  sourceName: string,
  forkName: string,
): { tables: number; rows: number } {
  if (sourceName === forkName) {
    throw new Error('A fork needs a NEW name distinct from its source.');
  }
  const source = getDb(sessionId, sourceName);
  openDb({ sessionId, name: forkName });
  const fork = getDb(sessionId, forkName);

  const tables = source.db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string; sql: string }>;

  let totalRows = 0;
  for (const table of tables) {
    fork.db.exec(table.sql);
    const columns = source.db.prepare(`PRAGMA table_info(${quoteIdent(table.name)})`).all() as Array<{ name: string }>;
    const colList = columns.map((c) => quoteIdent(c.name)).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const insert = fork.db.prepare(`INSERT INTO ${quoteIdent(table.name)} (${colList}) VALUES (${placeholders})`);
    const rows = source.db.prepare(`SELECT * FROM ${quoteIdent(table.name)}`).iterate();
    let copied = 0;
    fork.db.exec('BEGIN');
    try {
      for (const row of rows) {
        if (copied >= FORK_MAX_ROWS_PER_TABLE) {
          warningsBuffer.push(
            `table "${table.name}" truncated at ${FORK_MAX_ROWS_PER_TABLE} rows during fork`,
          );
          break;
        }
        insert.run(...Object.values(row as Record<string, unknown>).map(toSqlValue) as SqlValue[]);
        copied += 1;
      }
      fork.db.exec('COMMIT');
    } catch (error) {
      fork.db.exec('ROLLBACK');
      throw error;
    }
    totalRows += copied;
  }
  return { tables: tables.length, rows: totalRows };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Side-channel for non-fatal notes (fork truncations) — drained by the tool. */
const warningsBuffer: string[] = [];

export function drainWarnings(): string[] {
  const out = [...warningsBuffer];
  warningsBuffer.length = 0;
  return out;
}


/** Deterministic 32-bit PRNG (mulberry32) — no Math.random anywhere. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedTableSpec {
  table: string;
  count: number;
  /** column → value generator spec */
  columns: Record<string, SeedColumnSpec>;
}

export type SeedColumnSpec =
  | { kind: 'index' }
  | { kind: 'pick'; values: string[] }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'float'; min: number; max: number; decimals?: number }
  | { kind: 'bool' }
  | { kind: 'name' }
  | { kind: 'email'; domain?: string }
  | { kind: 'text'; words: number }
  | { kind: 'uuid' }
  | { kind: 'date' };

const SEED_WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
];
const SEED_NAMES = [
  'Aiko', 'Bram', 'Citra', 'Dimas', 'Eka', 'Farah', 'Gilang', 'Hana',
  'Indra', 'Joko', 'Kirana', 'Lestari', 'Maya', 'Nanda', 'Oka', 'Putri',
];

export function seedTable(
  sessionId: string | undefined,
  dbName: string,
  spec: SeedTableSpec,
  seed: number,
): { inserted: number } {
  if (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > 10_000) {
    throw new Error(
      `seed count must be an integer 1..10000 (got ${spec.count}) — deterministic generation is not for bulk loads.`,
    );
  }
  if (Object.keys(spec.columns).length === 0) {
    throw new Error(`Seed spec for "${spec.table}" has no columns.`);
  }
  const { db } = getDb(sessionId, dbName);
  const rng = makeRng(seed);
  const columns = Object.keys(spec.columns);
  const colList = columns.map(quoteIdent).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const insert = db.prepare(`INSERT INTO ${quoteIdent(spec.table)} (${colList}) VALUES (${placeholders})`);

  db.exec('BEGIN');
  try {
    for (let i = 1; i <= spec.count; i++) {
      const values = columns.map((col) => generateValue(spec.columns[col], i, rng));
      insert.run(...values);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { inserted: spec.count };
}

function generateValue(spec: SeedColumnSpec, index: number, rng: () => number): SqlValue {
  switch (spec.kind) {
    case 'index':
      return index;
    case 'pick':
      return spec.values[Math.floor(rng() * spec.values.length)] ?? spec.values[0] ?? '';
    case 'int':
      return Math.floor(spec.min + rng() * (spec.max - spec.min + 1));
    case 'float': {
      const raw = spec.min + rng() * (spec.max - spec.min);
      const decimals = spec.decimals ?? 2;
      return Number(raw.toFixed(decimals));
    }
    case 'bool':
      return rng() < 0.5 ? 0 : 1;
    case 'name':
      return SEED_NAMES[Math.floor(rng() * SEED_NAMES.length)] ?? 'Aiko';
    case 'email': {
      const name = SEED_NAMES[Math.floor(rng() * SEED_NAMES.length)] ?? 'aiko';
      return `${name.toLowerCase()}.${index}@${spec.domain ?? 'example.test'}`;
    }
    case 'text': {
      const words: string[] = [];
      for (let w = 0; w < spec.words; w++) {
        words.push(SEED_WORDS[Math.floor(rng() * SEED_WORDS.length)] ?? 'alpha');
      }
      return words.join(' ');
    }
    case 'uuid':
      return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `uuid-${index}-${Math.floor(rng() * 1e12).toString(36)}`;
    case 'date': {
      const base = Date.UTC(2026, 0, 1);
      const dayOffset = Math.floor(rng() * 365);
      return new Date(base + dayOffset * 86_400_000).toISOString().slice(0, 10);
    }
  }
}


export interface ContractIssue {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ContractLint {
  ok: boolean;
  issues: ContractIssue[];
  operations: number;
  schemas: number;
}

/**
 * Lint an OpenAPI 3.x spec (as a parsed object): every operation must have
 * responses; every referenced $ref must resolve; request bodies / response
 * schemas that the FE renders must actually exist. This catches the classic
 * "the API changed and the UI silently renders nothing" class of P2.
 */
export function lintContract(spec: unknown): ContractLint {
  const issues: ContractIssue[] = [];
  const root = spec as {
    openapi?: string;
    paths?: Record<string, Record<string, unknown>>;
    components?: { schemas?: Record<string, unknown> };
  };

  if (!root || typeof root !== 'object') {
    return { ok: false, issues: [{ level: 'error', path: '$', message: 'the spec is not an object — pass the PARSED OpenAPI JSON, not a string' }], operations: 0, schemas: 0 };
  }
  if (!root.openapi) {
    issues.push({ level: 'error', path: '$.openapi', message: 'missing "openapi" version field — this does not look like an OpenAPI 3.x spec' });
  }

  const schemas = root.components?.schemas ?? {};
  const schemaNames = Object.keys(schemas);
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
  let operations = 0;

  const checkSchemaNode = (node: unknown, at: string, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    const s = node as { $ref?: string; properties?: Record<string, unknown>; items?: unknown };
    if (typeof s.$ref === 'string') {
      const name = s.$ref.replace(/^#\/components\/schemas\//, '');
      if (!schemaNames.includes(name)) {
        issues.push({ level: 'error', path: at, message: `unresolved $ref "${s.$ref}" — the schema does not exist in components.schemas` });
      }
      return;
    }
    for (const [key, child] of Object.entries(s.properties ?? {})) {
      checkSchemaNode(child, `${at}.properties.${key}`, depth + 1);
    }
    if (s.items !== undefined) checkSchemaNode(s.items, `${at}.items`, depth + 1);
  };

  for (const [route, pathItem] of Object.entries(root.paths ?? {})) {
    if (pathItem === null || typeof pathItem !== 'object') continue;
    for (const [method, op] of Object.entries(pathItem)) {
      if (!methods.has(method)) continue;
      operations += 1;
      const at = `paths.${route}.${method}`;
      const operation = op as {
        responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
        requestBody?: { content?: Record<string, { schema?: unknown }> };
      };
      if (!operation.responses || Object.keys(operation.responses).length === 0) {
        issues.push({ level: 'error', path: at, message: 'operation declares no responses — the client cannot know what to render' });
      }
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        for (const media of Object.values(response.content ?? {})) {
          checkSchemaNode(media.schema, `${at}.responses.${status}`, 0);
        }
      }
      for (const media of Object.values(operation.requestBody?.content ?? {})) {
        checkSchemaNode(media.schema, `${at}.requestBody`, 0);
      }
    }
  }

  return {
    ok: !issues.some((issue) => issue.level === 'error'),
    issues: issues.slice(0, 50),
    operations,
    schemas: schemaNames.length,
  };
}

export interface ContractValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a request body against a schema node — structural subset: types,
 * required fields, enums, and item types for arrays. Not a full JSON-Schema
 * engine; it catches the contract drift a frontend actually hits.
 */
export function validateAgainstSchema(
  body: unknown,
  schema: unknown,
  spec: unknown,
): ContractValidation {
  const errors: string[] = [];
  const schemas = ((spec as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {}) as Record<string, unknown>;

  const resolve = (node: unknown, depth = 0): unknown => {
    if (depth > 6 || node === null || typeof node !== 'object') return node;
    const ref = (node as { $ref?: string }).$ref;
    if (typeof ref === 'string') {
      const name = ref.replace(/^#\/components\/schemas\//, '');
      return schemas[name] ?? node;
    }
    return node;
  };

  const walk = (value: unknown, node: unknown, at: string, depth: number): void => {
    if (depth > 8) return;
    const s = resolve(node, depth) as {
      type?: string;
      required?: string[];
      properties?: Record<string, unknown>;
      items?: unknown;
      enum?: unknown[];
      nullable?: boolean;
    } | undefined;
    if (!s || typeof s !== 'object') return;

    if (s.enum && !s.enum.some((option) => option === value)) {
      errors.push(`${at}: value ${JSON.stringify(value)} is not one of [${s.enum.map((o) => JSON.stringify(o)).join(', ')}]`);
      return;
    }
    switch (s.type) {
      case 'object': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          if (!(s.nullable && value === null)) errors.push(`${at}: expected object, got ${value === null ? 'null' : typeof value}`);
          return;
        }
        const record = value as Record<string, unknown>;
        for (const required of s.required ?? []) {
          if (!(required in record)) errors.push(`${at}: missing required property "${required}"`);
        }
        for (const [key, child] of Object.entries(s.properties ?? {})) {
          if (key in record) walk(record[key], child, `${at}.${key}`, depth + 1);
        }
        break;
      }
      case 'array': {
        if (!Array.isArray(value)) {
          if (!(s.nullable && value === null)) errors.push(`${at}: expected array, got ${typeof value}`);
          return;
        }
        value.forEach((item, i) => walk(item, s.items, `${at}[${i}]`, depth + 1));
        break;
      }
      case 'string':
        if (typeof value !== 'string' && !(s.nullable && value === null)) errors.push(`${at}: expected string, got ${typeof value}`);
        break;
      case 'integer':
      case 'number':
        if (typeof value !== 'number' && !(s.nullable && value === null)) errors.push(`${at}: expected ${s.type}, got ${typeof value}`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean' && !(s.nullable && value === null)) errors.push(`${at}: expected boolean, got ${typeof value}`);
        break;
      default:
        break;
    }
  };

  walk(body, schema, '$', 0);
  return { valid: errors.length === 0, errors: errors.slice(0, 30) };
}
