/**
 * TOOL EXECUTION PIPELINE.
 *
 * callAgentTool routes by name, but the cross-cutting concerns around an
 * execution (schema validity, timing, retries, accounting) should not live
 * inside that switch — they were scattered before and had to be re-read in
 * five places to change one rule.
 *
 * This is a small ordered pipeline: each hook runs before the handler, can
 * deny the call outright, and gets to see the result afterwards. It is the
 * single place a new cross-cutting rule is added. Nothing here knows about
 * specific tools; nothing in a tool knows it is being piped.
 */
import type { HarnessToolResult, AgentToolContext } from './tools/shared.js';
import { requireWorkspace } from './tools/shared.js';
import { auditToolCall } from './audit.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { buildSpatialMap, evaluateSpatialGate, invalidateSpatialMapCache } from './spatial.js';
import { snakeToCamel, camelizeSchemaNode } from './tools/casing.js';
import { getLanguageService } from './lsp-service.js';
import { markTouched } from './tools/diagnostics.js';
import { getActiveWorkspace } from './workspace.js';

/**
 * Error shape used by a hook that wants to deny a call. Hooks may also just
 * return a result directly (e.g. schema validation failures read better as
 * data than as an exception in a tool loop).
 */
export class ToolPipelineError extends Error {
  /** Stable failure code surfaced on the denied result (audit + loop
   * containment). Hooks may override; schemaValidator uses 'schema_error'. */
  errorCode: string;
  constructor(message: string, errorCode = 'schema_error') {
    super(message);
    this.errorCode = errorCode;
  }
}

/** The call as every hook sees it. */
export interface PipelineCall {
  wireName: string;
  /** The bare tool name (wireName without the `agent__` prefix). */
  name: string;
  args: Record<string, unknown>;
  ctx: AgentToolContext;
  /** Timing of the handler run, filled in postExecute for the audit hook. */
  durationMs?: number;
  /**
   * F3 spatial gate — the BEFORE content of the UI files this call will
   * touch, captured in preExecute so the transform can diff against it after
   * the handler wrote. Undefined for non-gated tools.
   */
  gateBefore?: Map<string, string | null>;
}

/** A hook that runs BEFORE the handler and may veto the call. */
export interface ToolHook {
  name: string;
  /** Returns an error result to deny, or null/undefined to allow. */
  preExecute(call: PipelineCall): Promise<ToolPipelineError | null>;
  /** Runs after the handler; may REPLACE the result. The F3 spatial gate
   *  uses this to flip a UI edit to isError when it created new collisions. */
  transform?(call: PipelineCall, result: HarnessToolResult): HarnessToolResult;
  /** Runs after the handler with its timing and outcome. */
  postExecute(call: PipelineCall, result: HarnessToolResult): void;
}

/**
 * SCHEMA VALIDATOR + COERCION — the gap the pipeline closes first.
 *
 * Two passes run per call, in order:
 *   1. COERCION (coerceStructuredArgs) — a provider sometimes serializes a
 *      structured arg (array/object) as a JSON-encoded string (the edits[]
 *      double-encoding failure). A string that parses into the declared type
 *      is recovered ONCE, here, so the tool parser never sees the broken
 *      form. This is the single normalization point — coercion is NOT
 *      duplicated in every parser.
 *   2. VALIDATION (checkSchema) — `required`, top-level type, and a
 *      depth-bounded nested check (items.type, maxItems, nested required).
 *      Keywords beyond those are still ignored; this is a fast guard, not a
 *      full validator, and the tools remain defensive on their own
 *      (tier-2 backstop).
 *
 * The catalogue is imported LAZILY (dynamic import): a top-level import would
 * be circular (pipeline ← tools/index ← dispatcher ← pipeline), and in Node
 * ESM the binding is not yet initialized during module load — the validator
 * silently saw no tool defs and validated nothing.
 */
/** Minimal JSON example for a schema node — used in prescriptive error
 * messages so the model can fix a wrong-typed arg in one retry. */
function schemaExample(node: Record<string, unknown>, depth = 0): string {
  if (depth > 2) return '…';
  const type = node.type as string | undefined;
  if (type === 'array') {
    const items = node.items as Record<string, unknown> | undefined;
    if (items && items.type === 'object') {
      const props = items.properties as Record<string, unknown> | undefined;
      const req = Array.isArray(items.required) ? (items.required as string[]) : Object.keys(props ?? {});
      const sample = req.slice(0, 3).map((k) => `"${k}": "…"`).join(', ');
      return `[{ ${sample} }]`;
    }
    if (items && items.type === 'string') return '["…", "…"]';
    return '[]';
  }
  if (type === 'object') {
    const props = node.properties as Record<string, unknown> | undefined;
    const keys = props ? Object.keys(props).slice(0, 3) : [];
    const sample = keys.map((k) => `"${k}": "…"`).join(', ');
    return `{ ${sample} }`;
  }
  if (type === 'string') return '"…"';
  if (type === 'number' || type === 'integer') return '1';
  if (type === 'boolean') return 'true';
  return '…';
}

/** Recursively check a value against a schema node (depth-bounded). Covers
 * type, maxItems, items.type, and nested required. Returns a prescriptive
 * error string or null. Keywords beyond those are still ignored. */
function checkShape(value: unknown, node: Record<string, unknown>, path: string, depth = 0): string | null {
  if (depth > 3) return null;
  const type = node.type as string | undefined;
  if (!type) return null;
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (type === 'integer') {
    if (!Number.isInteger(value)) {
      return `Argument "${path}" must be an integer (got ${actual}).`;
    }
  } else if (type !== actual) {
    return `Argument "${path}" must be of type ${type} (got ${actual}). ` +
      `Pass a NATIVE ${type}, e.g. ${path}: ${schemaExample(node)} — not a JSON-encoded string.`;
  }
  if (type === 'array') {
    const arr = value as unknown[];
    if (typeof node.maxItems === 'number' && arr.length > node.maxItems) {
      return `Argument "${path}" has ${arr.length} entries (max ${node.maxItems}). Split into smaller calls.`;
    }
    const items = node.items as Record<string, unknown> | undefined;
    if (items && typeof items === 'object') {
      for (let i = 0; i < arr.length; i += 1) {
        const err = checkShape(arr[i], items, `${path}[${i}]`, depth + 1);
        if (err) return err;
      }
    }
  }
  if (type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const req = Array.isArray(node.required) ? (node.required as string[]) : [];
    for (const r of req) {
      if (typeof r !== 'string') continue;
      const v = (value as Record<string, unknown>)[r];
      if (v === undefined || v === null) {
        return `Argument "${path}.${r}" is required (missing). Expected shape: ${schemaExample(node)}.`;
      }
    }
    const props = node.properties as Record<string, unknown> | undefined;
    if (props && typeof props === 'object') {
      for (const [k, child] of Object.entries(props)) {
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined || v === null) continue;
        const err = checkShape(v, child as Record<string, unknown>, `${path}.${k}`, depth + 1);
        if (err) return err;
      }
    }
  }
  return null;
}

/** Resolve the catalogue def's inputSchema for a call (lazy import avoids the
 * circular binding problem documented above). */
async function schemaFor(call: PipelineCall): Promise<Record<string, unknown> | null> {
  const { listAgentToolDefs } = await import('./tools/index.js');
  const bare = call.wireName.replace(/^agent__/, '');
  const def = listAgentToolDefs().find(
    (d) => d.wireName === call.wireName || d.wireName === 'agent__' + bare,
  );
  const schema = def?.inputSchema;
  return schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : null;
}

/**
 * CASE TRANSLATOR — the wire/JSON-Schema layer speaks snake_case (Anthropic/
 * OpenAI convention), the engine internals speak camelCase (TS idiom). This
 * one pass rewrites every argument key to its camelCase canonical form FIRST,
 * so tool implementations and the validator below only ever read camelCase.
 *
 * Tolerant by design: canonical is derived from the schema's own property
 * names (camelized), so a model sending EITHER casing is accepted — only keys
 * that resolve to a declared property are rewritten. Nested object/array
 * shapes recurse only through schema-declared `properties`, never into opaque
 * user-data blobs (which keeps e.g. a backend request body untouched).
 */
function normalizeObjectKeys(obj: Record<string, unknown>, props: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const canonical = snakeToCamel(key);
    if (canonical !== key && canonical in props) {
      obj[canonical] = obj[key];
      delete obj[key];
    }
  }
  for (const [key, node] of Object.entries(props)) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    const declared = node as Record<string, unknown>;
    const type = declared.type;
    if (type === 'object' && typeof value === 'object' && !Array.isArray(value)) {
      const sub = declared.properties as Record<string, unknown> | undefined;
      if (sub) normalizeObjectKeys(value as Record<string, unknown>, sub);
    } else if (type === 'array' && Array.isArray(value)) {
      const items = declared.items as Record<string, unknown> | undefined;
      if (items && items.type === 'object') {
        const sub = items.properties as Record<string, unknown> | undefined;
        if (sub) {
          for (const item of value) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              normalizeObjectKeys(item as Record<string, unknown>, sub);
            }
          }
        }
      }
    }
  }
}

/** Rewrite call.args keys from snake_case to camelCase (first pipeline step). */
function normalizeArgCase(call: PipelineCall, schema: Record<string, unknown>): void {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props || typeof props !== 'object') return;
  normalizeObjectKeys(call.args, props);
}

/** COERCION — recover structured args a provider serialized as a JSON string.
 * Only touches properties declared object/array in the schema; a plain string
 * that does not parse is left for the validator to reject prescriptively. */
function coerceStructuredArgs(call: PipelineCall, schema: Record<string, unknown>): void {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties || typeof properties !== 'object') return;
  for (const [key, declared] of Object.entries(properties)) {
    const type = (declared as { type?: string })?.type;
    if (type !== 'object' && type !== 'array') continue;
    const value = call.args[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith(type === 'array' ? '[' : '{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const parsedType = Array.isArray(parsed) ? 'array' : typeof parsed;
      if (parsedType === type) {
        call.args[key] = parsed;
        try { console.debug(`[harness] arg_coerced tool=${call.wireName} key=${key}`); } catch {  }
      }
    } catch {
    }
  }
}

/** Validate call.args against a resolved schema: required + depth-bounded
 * nested shape checks. Returns a prescriptive error string or null. */
function checkSchema(call: PipelineCall, schema: Record<string, unknown>): string | null {
  const required = Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [];
  for (const prop of required) {
    if (!(prop in call.args) || call.args[prop] === undefined || call.args[prop] === null) {
      return `Missing required argument "${prop}" for ${call.wireName}.`;
    }
  }
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties || typeof properties !== 'object') return null;
  for (const [key, declared] of Object.entries(properties)) {
    const value = call.args[key];
    if (value === undefined || value === null) continue;
    const err = checkShape(value, declared as Record<string, unknown>, key, 0);
    if (err) return err;
  }
  return null;
}

/** The single shared hook chain. Order matters: schema before anything else. */


const UI_FILE_RE = /\.(css|tsx|jsx)$/i;

/** The workspace-relative files one gated call will touch (null = not gated). */
function collectGateFiles(call: PipelineCall): string[] | null {
  if (
    call.name === 'edit_file' || call.name === 'write' || call.name === 'multi_edit' ||
    call.name === 'edit_lines' || call.name === 'edit_between' || call.name === 'insert_at_line'
  ) {
    const p = typeof call.args.path === 'string' ? call.args.path.trim().replace(/\\/g, '/') : '';
    return p ? [p] : null;
  }
  if (call.name === 'apply_patch') {
    const patch = typeof call.args.patch === 'string' ? call.args.patch : '';
    const files = new Set<string>();
    for (const m of patch.matchAll(/^[-+]{3} [ab]\/(.+)$/gm)) {
      const f = m[1].trim().replace(/\\/g, '/');
      if (f && f !== '/dev/null') files.add(f);
    }
    return [...files];
  }
  return null;
}

function gateUiFiles(call: PipelineCall): string[] | null {
  const files = collectGateFiles(call);
  if (!files) return null;
  const ui = files.filter((f) => UI_FILE_RE.test(f));
  return ui.length > 0 ? ui : null;
}

const spatialGateHook: ToolHook = {
  name: 'spatialGate',
  async preExecute(call) {
    const uiFiles = gateUiFiles(call);
    if (!uiFiles) return null;
    try {
      const root = requireWorkspace(call.ctx).root;
      const before = new Map<string, string | null>();
      for (const f of uiFiles) {
        try {
          before.set(f, readFileSync(path.resolve(root, f), 'utf-8'));
        } catch {
          before.set(f, null);
        }
      }
      call.gateBefore = before;
    } catch {
      call.gateBefore = undefined;
    }
    return null;
  },
  transform(call, result) {
    if (result.isError || call.args.dryRun === true) return result;
    const uiFiles = gateUiFiles(call);
    if (!uiFiles || !call.gateBefore) return result;
    try {
      const root = requireWorkspace(call.ctx).root;
      const beforeSources: Array<{ path: string; content: string }> = [];
      const afterSources: Array<{ path: string; content: string }> = [];
      for (const f of uiFiles) {
        if (!call.gateBefore.has(f)) return result;
        const before = call.gateBefore.get(f) ?? null;
        let after: string | null = null;
        try {
          after = readFileSync(path.resolve(root, f), 'utf-8');
        } catch {
          after = null;
        }
        if (before !== null) beforeSources.push({ path: f, content: before });
        if (after !== null) afterSources.push({ path: f, content: after });
      }
      const gate = evaluateSpatialGate(buildSpatialMap(beforeSources), buildSpatialMap(afterSources));
      invalidateSpatialMapCache(root);
      if (!gate) return result;
      const text = `${result.text}\n\n${gate.report}`;
      if (gate.blocked) {
        return { ...result, ok: false, isError: true, text, errorCode: 'spatial_gate' };
      }
      return { ...result, text };
    } catch {
      return result;
    }
  },
  postExecute() {
  },
};

const hooks: ToolHook[] = [
  {
    name: 'schemaValidator',
    async preExecute(call) {
      const schema = await schemaFor(call);
      if (schema) {
        const camelSchema = camelizeSchemaNode(schema);
        normalizeArgCase(call, camelSchema);
        coerceStructuredArgs(call, camelSchema);
        const problem = checkSchema(call, camelSchema);
        if (problem) {
          return new ToolPipelineError(
            `${call.wireName}: ${problem} Next step: fix the arguments and resend the tool call.`,
          );
        }
      }
      return null;
    },
    postExecute() {
    },
  },
  {
    name: 'spatialGate',
    async preExecute(call) {
      return spatialGateHook.preExecute(call);
    },
    transform(call, result) {
      return spatialGateHook.transform!(call, result);
    },
    postExecute() {
    },
  },
  {
    name: 'auditHook',
    async preExecute() {
      return null;
    },
    postExecute(call, result) {
      const serialized = JSON.stringify(call.args);
      auditToolCall({
        session: call.ctx.sessionId ?? 'default',
        tool: call.wireName,
        ok: result.ok,
        durationMs: call.durationMs ?? 0,
        args: serialized.slice(0, 300),
        argsLen: serialized.length,
        argsTruncated: serialized.length > 300,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      });
    },
  },
  {
    // F3.2 — post-edit diagnostics: after a successful edit on .ts/.tsx files,
    // append NEW syntactic diagnostics (vs before the edit, max 5, 1.5s cap).
    name: 'diagnosticsHook',
    async preExecute() {
      return null;
    },
    transform(call, result) {
      if (!result.ok || result.isError) return result;
      const gateFiles = collectGateFiles(call);
      if (!gateFiles) return result;
      const tsFiles = gateFiles.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
      if (tsFiles.length === 0) return result;
      try {
        const ws = getActiveWorkspace(call.ctx.sessionId);
        if (!ws) return result;
        const notes: string[] = [];
        const deadline = Date.now() + 1_500;
        for (const rel of tsFiles) {
          if (Date.now() > deadline) break;
          const abs = path.join(ws.path, rel);
          markTouched(abs);
          const service = getLanguageService(abs, ws.path);
          const diags = (service.getSyntacticDiagnostics(abs) ?? []).slice(0, 5);
          if (diags.length > 0) {
            notes.push(`⚠ ${diags.length} new diagnostic(s) in ${rel}:`);
            for (const d of diags) {
              if (d.file && d.start !== undefined) {
                const lc = d.file.getLineAndCharacterOfPosition(d.start);
                notes.push(`  ${lc.line + 1}:${lc.character + 1}  TS${d.code}: ${d.messageText}`);
              } else {
                notes.push(`  TS${d.code}: ${d.messageText}`);
              }
            }
          }
        }
        if (notes.length === 0) return result;
        return { ...result, text: `${result.text}\n\n${notes.join('\n')}` };
      } catch {
        return result; // never false-fail an edit
      }
    },
    postExecute() {
    },
  },
];

/**
 * Runs one tool call through the hook chain. Every denial and every thrown
 * error is converted into a `HarnessToolResult` so the tool loop only ever
 * sees data — the loop has no try/catch for pipeline errors and should not
 * need one.
 */
export async function runPipeline(
  execute: (call: PipelineCall) => Promise<HarnessToolResult>,
  call: PipelineCall,
): Promise<HarnessToolResult> {
  for (const hook of hooks) {
    const denial = await hook.preExecute(call);
    if (denial) {
      return { ok: false, isError: true, text: denial.message, errorCode: denial.errorCode };
    }
  }
  {
    const { emitAddonEvent } = await import('../addons/registry.js');
    const { createAddonApi } = await import('../addons/api.js');
    const outcome = await emitAddonEvent('tool.call', { tool: call.wireName, args: call.args }, createAddonApi('__harness__', process.cwd()));
    if (outcome.deny) {
      return { ok: false, isError: true, text: outcome.deny, errorCode: 'addon_denied' };
    }
    if (outcome.result) {
      const r = outcome.result as Partial<HarnessToolResult>;
      if (typeof r.ok === 'boolean' && typeof r.text === 'string' && typeof r.isError === 'boolean') {
        call.durationMs = 0;
        return { ok: r.ok, text: r.text, isError: r.isError };
      }
    }
  }
  const started = Date.now();
  let result: HarnessToolResult;
  try {
    result = await execute(call);
  } catch (error) {
    result = {
      ok: false,
      isError: true,
      text: error instanceof Error ? error.message : 'Tool execution failed.',
      errorCode: 'tool_exception',
    };
  }
  call.durationMs = Date.now() - started;
  {
    const { emitAddonEvent } = await import('../addons/registry.js');
    const { createAddonApi } = await import('../addons/api.js');
    try {
      await emitAddonEvent('tool.result', { tool: call.wireName, result }, createAddonApi('__harness__', process.cwd()));
    } catch {  }
  }
  for (const hook of hooks) {
    try {
      if (hook.transform) result = hook.transform(call, result);
    } catch {
    }
    try {
      hook.postExecute(call, result);
    } catch {
    }
  }
  return result;
}
