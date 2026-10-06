/**
 * agent__backend — the F5 conditional backend layer (docs/plans/PLAN-SPATIAL-HARNESS.md).
 *
 * Inert by design: the harness gains a database + contract surface ONLY when
 * the agent opens one. In-memory SQLite (node:sqlite builtin — zero native
 * build) dies with the session by default; forks of real data are capped;
 * contract lint/validate consume a parsed OpenAPI JSON the agent provides.
 *
 * Modes:
 *   open            — open a named database (in-memory unless filePath given)
 *   exec / query    — run SQL against an open database (writes / reads)
 *   fork            — branch a database: same schema+data, independent copy
 *   discard         — close and forget one database
 *   list            — open databases + their tables
 *   seed            — deterministic rows from a table spec (same seed → same rows)
 *   contract_lint   — lint a parsed OpenAPI spec (refs, responses, shapes)
 *   contract_check  — validate a request body against one schema in the spec
 *
 * Everything fails loud with an actionable message; nothing runs on its own.
 */
import fs from 'node:fs';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, truncateOutput, resolveWithPermission } from './shared.js';
import {
  openDb,
  execDb,
  queryDb,
  discardDb,
  listDbs,
  forkDb,
  drainWarnings,
  seedTable,
  lintContract,
  validateAgainstSchema,
  type SeedTableSpec,
  type SeedColumnSpec,
  type DbInfo,
  type QueryRows,
} from '../backend.js';

const MODES = [
  'open', 'exec', 'query', 'fork', 'discard', 'list',
  'seed', 'contract_lint', 'contract_check',
] as const;

/** Parse + validate the seed spec from the args (fail loud, prescriptive). */
function parseSeedSpec(raw: unknown): SeedTableSpec | string {
  if (!raw || typeof raw !== 'object') return 'seed mode needs "spec" as an OBJECT: { table, count, columns } — not a string.';
  const spec = raw as {
    table?: unknown;
    count?: unknown;
    columns?: Record<string, unknown>;
  };
  if (typeof spec.table !== 'string' || spec.table.trim() === '') {
    return 'seed spec needs a "table" name (string).';
  }
  const count = typeof spec.count === 'number' ? Math.floor(spec.count) : NaN;
  if (!Number.isInteger(count) || count < 1 || count > 10_000) {
    return 'seed spec needs "count" as an integer 1..10000 (deterministic generation is not for bulk loads).';
  }
  if (!spec.columns || typeof spec.columns !== 'object') {
    return 'seed spec needs a "columns" object: { columnName: { kind: "int"|"pick"|"name"|"email"|"text"|"uuid"|"date"|"bool"|"float"|"index", ... } }.';
  }
  const columns: Record<string, SeedColumnSpec> = {};
  for (const [name, rawSpec] of Object.entries(spec.columns)) {
    if (!rawSpec || typeof rawSpec !== 'object') {
      return `column "${name}" needs an object spec like { kind: "int", min: 1, max: 100 }.`;
    }
    const s = rawSpec as { kind?: unknown; values?: unknown; min?: unknown; max?: unknown };
    if (typeof s.kind !== 'string') {
      return `column "${name}" needs a "kind" (int | pick | int | float | bool | name | email | text | uuid | date | index).`;
    }
    columns[name] = rawSpec as SeedColumnSpec;
    if (s.kind === 'pick' && (!Array.isArray(s.values) || s.values.length === 0)) {
      return `column "${name}" (kind "pick") needs a non-empty "values" array.`;
    }
  }
  return { table: spec.table.trim(), count, columns };
}

function renderRows(result: QueryRows): string {
  const head = `  ${result.columns.join(' | ')}`;
  const separator = `  ${'-'.repeat(Math.min(head.length, 100))}`;
  const body = result.rows.map((row) => {
    const line = result.columns.map((c) => {
      const value = row[c];
      if (value === null || value === undefined) return 'NULL';
      if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 57)}…` : value;
      return String(value);
    }).join(' | ');
    return `  ${line.length > 110 ? `${line.slice(0, 107)}…` : line}`;
  });
  const tail = result.truncated ? `\n  … truncated at 500 rows (refine the query)` : '';
  return [head, separator, ...body, tail].filter((line) => line.trim().length > 0).join('\n');
}

function renderDbInfos(infos: DbInfo[]): string {
  if (infos.length === 0) return 'No databases open in this session.';
  return infos
    .map((info) => {
      const kind = info.ephemeral ? 'in-memory (dies with the session)' : 'file-backed';
      const tables = info.tables.length > 0 ? info.tables.join(', ') : '(no tables yet)';
      return `  ${info.name} — ${kind} · tables: ${tables}`;
    })
    .join('\n');
}

export async function backendTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const mode = str(args, 'mode').trim().toLowerCase();
  if (!MODES.includes(mode as (typeof MODES)[number])) {
    return {
      ok: false,
      isError: true,
      text: `Unknown mode "${mode}". Use one of: ${MODES.join(', ')}.`,
    };
  }
  const sessionId = ctx.sessionId;

  const done = (text: string): HarnessToolResult => ({ ok: true, isError: false, text: truncateOutput(text) });
  const fail = (text: string): HarnessToolResult => ({ ok: false, isError: true, text: truncateOutput(text) });

  try {
    switch (mode) {
      case 'list':
        return done(renderDbInfos(listDbs(sessionId)));

      case 'open': {
        const name = str(args, 'name').trim();
        if (!name) return fail('open needs a "name" for the database (session-local handle).');
        const filePath = str(args, 'filePath').trim();
        let resolvedPath: string | undefined;
        if (filePath) {
          const resolved = await resolveWithPermission('backend', filePath, ctx, 'read');
          resolvedPath = resolved.absolute;
        }
        const opened = openDb({ sessionId, name, filePath: resolvedPath });
        const warnings = drainWarnings();
        return done(
          [
            `Opened "${opened.name}" — ${opened.ephemeral ? 'IN-MEMORY (ephemeral: data dies with the session; pass filePath to persist)' : `file-backed (${resolvedPath})`}.`,
            ...(warnings.length > 0 ? ['', ...warnings.map((w) => `~ ${w}`)] : []),
          ].join('\n'),
        );
      }

      case 'exec': {
        const name = str(args, 'name').trim();
        const sql = str(args, 'sql').trim();
        if (!name || !sql) return fail('exec needs "name" (an open database) and "sql".');
        const params = Array.isArray(args.params) ? (args.params as unknown[]) : [];
        const outcome = execDb(sessionId, name, sql, params);
        return done(`OK — ${outcome.changes} row(s) affected${outcome.lastInsertRowid !== undefined ? `, last rowid ${outcome.lastInsertRowid}` : ''}.`);
      }

      case 'query': {
        const name = str(args, 'name').trim();
        const sql = str(args, 'sql').trim();
        if (!name || !sql) return fail('query needs "name" (an open database) and "sql".');
        const params = Array.isArray(args.params) ? (args.params as unknown[]) : [];
        const result = queryDb(sessionId, name, sql, params);
        if (result.rows.length === 0) return done('OK — 0 rows.');
        return done(`OK — ${result.rows.length} row(s)${result.truncated ? ' (truncated at 500)' : ''}:\n${renderRows(result)}`);
      }

      case 'fork': {
        const source = str(args, 'name').trim();
        const forkName = str(args, 'forkName').trim();
        if (!source || !forkName) return fail('fork needs "name" (source) and "forkName" (the new branch).');
        const result = forkDb(sessionId, source, forkName);
        const warnings = drainWarnings();
        return done(
          [
            `Forked "${source}" → "${forkName}": ${result.tables} table(s), ${result.rows} row(s) copied. ` +
            `The fork is independent — the source is untouched.`,
            ...(warnings.length > 0 ? ['', ...warnings.map((w) => `~ ${w}`)] : []),
          ].join('\n'),
        );
      }

      case 'discard': {
        const name = str(args, 'name').trim();
        if (!name) return fail('discard needs a "name".');
        return done(discardDb(sessionId, name) ? `Discarded "${name}" (in-memory data is gone).` : `"${name}" was not open.`);
      }

      case 'seed': {
        const name = str(args, 'name').trim();
        if (!name) return fail('seed needs "name" (an open database).');
        const specOrError = parseSeedSpec(args.spec);
        if (typeof specOrError === 'string') return fail(specOrError);
        const seed = typeof args.seed === 'number' ? Math.floor(args.seed) : 42;
        const result = seedTable(sessionId, name, specOrError, seed);
        return done(`Seeded ${result.inserted} row(s) into "${specOrError.table}" (seed ${seed} — deterministic: same seed, same rows).`);
      }

      case 'contract_lint': {
        const specPath = str(args, 'specPath').trim();
        let spec: unknown;
        if (specPath) {
          const resolved = await resolveWithPermission('backend', specPath, ctx, 'read');
          let content: string;
          try {
            content = fs.readFileSync(resolved.absolute, 'utf-8');
          } catch (error) {
            return fail(`Cannot read the spec: ${error instanceof Error ? error.message : 'read failed'}.`);
          }
          try {
            spec = JSON.parse(content);
          } catch {
            spec = { note: 'yaml' };
            return fail(
              'The spec file is not valid JSON. For OpenAPI YAML, convert it first ' +
              '(the enforcer consumes the PARSED OpenAPI 3.x object).',
            );
          }
        } else {
          const inline = args.spec;
          if (typeof inline === 'string') {
            try {
              spec = JSON.parse(inline);
            } catch {
              return fail('"spec" is a string but not valid JSON — pass the parsed object or specPath.');
            }
          } else if (inline && typeof inline === 'object') {
            spec = inline;
          } else {
            return fail('contract_lint needs "specPath" (file in the workspace) or "spec" (parsed object).');
          }
        }
        const lint = lintContract(spec);
        const lines = [
          `CONTRACT LINT — ${lint.ok ? 'OK' : 'FAILED'} · ${lint.operations} operation(s), ${lint.schemas} schema(s), ${lint.issues.length} issue(s)`,
          ...lint.issues.map((issue) => `  ${issue.level === 'error' ? '!' : '~'} [${issue.level}] ${issue.path}: ${issue.message}`),
        ];
        return { ok: lint.ok, isError: !lint.ok, text: truncateOutput(lines.join('\n')) };
      }

      case 'contract_check': {
        const schemaName = str(args, 'schema').trim();
        if (!schemaName) return fail('contract_check needs a "schema" (a components.schemas name).');
        let spec: unknown;
        if (args.spec && typeof args.spec === 'object') {
          spec = args.spec;
        } else {
          const specPath = str(args, 'specPath').trim();
          if (!specPath) return fail('contract_check needs "spec" (parsed object) or "specPath".');
          const resolved = await resolveWithPermission('backend', specPath, ctx, 'read');
          try {
            spec = JSON.parse(fs.readFileSync(resolved.absolute, 'utf-8'));
          } catch (error) {
            return fail(`Cannot read/parse the spec: ${error instanceof Error ? error.message : 'failed'}.`);
          }
        }
        const body = args.body;
        if (body === undefined) return fail('contract_check needs a "body" to validate.');
        const validation = validateAgainstSchema(body, { $ref: `#/components/schemas/${schemaName}` }, spec);
        if (validation.valid) {
          return done(`CONTRACT CHECK — "${schemaName}" validates. ${validation.errors.length} error(s).`);
        }
        return {
          ok: false,
          isError: true,
          text: truncateOutput(
            [
              `CONTRACT CHECK — FAILED against "${schemaName}":`,
              ...validation.errors.map((e) => `  ! ${e}`),
              'Fix the payload OR the schema — whichever represents the real contract.',
            ].join('\n'),
          ),
        };
      }

      default:
        return fail(`Mode "${mode}" is registered but not handled — this is a harness bug.`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'backend operation failed.');
  }
}
