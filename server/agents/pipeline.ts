
import type { HarnessToolResult, AgentToolContext } from './tools/shared.js';
import { requireWorkspace } from './tools/shared.js';
import { auditToolCall } from './audit.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { buildSpatialMap, evaluateSpatialGate, invalidateSpatialMapCache } from './spatial.js';
import { snakeToCamel, camelizeSchemaNode } from './tools/casing.js';
import { markTouched } from './tools/diagnostics.js';
import * as ts from 'typescript';
import { getActiveWorkspace } from './workspace.js';
import { planGateDenial } from './plan-mode.js';
import {
  diagnosticSignature, ledgerFiles, recordFileDiagnostics, type UnresolvedDiagnostic,
} from './diagnostics-ledger.js';


export class ToolPipelineError extends Error {
  
  errorCode: string;
  constructor(message: string, errorCode = 'schema_error') {
    super(message);
    this.errorCode = errorCode;
  }
}


export interface PipelineCall {
  wireName: string;
  
  name: string;
  args: Record<string, unknown>;
  ctx: AgentToolContext;
  
  durationMs?: number;
  
  gateBefore?: Map<string, string | null>;
  
  diagBefore?: Map<string, Set<string>>;
}


export interface ToolHook {
  name: string;
  
  preExecute(call: PipelineCall): Promise<ToolPipelineError | null>;
  
  transform?(call: PipelineCall, result: HarnessToolResult): HarnessToolResult;
  
  postExecute(call: PipelineCall, result: HarnessToolResult): void;
}



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


async function schemaFor(call: PipelineCall): Promise<Record<string, unknown> | null> {
  const { listAgentToolDefs } = await import('./tools/index.js');
  const bare = call.wireName.replace(/^agent__/, '');
  const def = listAgentToolDefs().find(
    (d) => d.wireName === call.wireName || d.wireName === 'agent__' + bare,
  );
  const schema = def?.inputSchema;
  return schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : null;
}


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


function normalizeArgCase(call: PipelineCall, schema: Record<string, unknown>): void {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props || typeof props !== 'object') return;
  normalizeObjectKeys(call.args, props);
}


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


const REGEX_CAPABLE_KEYS = new Set(['pattern', 'patterns', 'regex', 'regexes', 'query']);
const REGEXP_FLAGS_RE = /^[dgimsuvy]*$/;


function extractCrossRealmRegex(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as { source?: unknown; flags?: unknown; constructor?: { name?: unknown } };
  if (typeof candidate.source !== 'string' || typeof candidate.flags !== 'string') return null;
  if (!REGEXP_FLAGS_RE.test(candidate.flags)) return null;
  const tag = Object.prototype.toString.call(value);
  if (tag !== '[object RegExp]' && candidate.constructor?.name !== 'RegExp') return null;
  return candidate.flags ? `/${candidate.source}/${candidate.flags}` : candidate.source;
}


function healRuntimeAndScalarArgs(call: PipelineCall, schema: Record<string, unknown>): void {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties || typeof properties !== 'object') return;
  for (const [key, declaredNode] of Object.entries(properties)) {
    const declared = declaredNode as { type?: string; items?: { type?: string } };
    const value = call.args[key];
    if (value === undefined || value === null) continue;

    if (declared.type === 'string' && REGEX_CAPABLE_KEYS.has(key)) {
      const healed = extractCrossRealmRegex(value);
      if (healed !== null) {
        call.args[key] = healed;
        continue;
      }
    }

    if (
      declared.type === 'array' && Array.isArray(value) &&
      declared.items?.type === 'string' && REGEX_CAPABLE_KEYS.has(key)
    ) {
      call.args[key] = value.map((item) => extractCrossRealmRegex(item) ?? item);
      continue;
    }

    if (declared.type === 'number' && typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '' && Number.isFinite(Number(trimmed))) call.args[key] = Number(trimmed);
    } else if (declared.type === 'integer' && typeof value === 'string') {
      const trimmed = value.trim();
      if (/^-?\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isSafeInteger(parsed)) call.args[key] = parsed;
      }
    } else if (declared.type === 'boolean' && typeof value === 'string') {
      const lower = value.trim().toLowerCase();
      if (lower === 'true') call.args[key] = true;
      else if (lower === 'false') call.args[key] = false;
    }
  }
}


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




const UI_FILE_RE = /\.(css|tsx|jsx)$/i;


function collectGateFiles(call: PipelineCall): string[] | null {
  if (
    call.name === 'edit_file' || call.name === 'write' || call.name === 'overwrite' ||
    call.name === 'multi_edit' ||
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

const TS_FILE_RE = /\.(ts|tsx|mts|cts)$/;


function readSyntactic(abs: string): UnresolvedDiagnostic[] {
  const out: UnresolvedDiagnostic[] = [];
  let content: string;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    return out; // gone or unreadable — nothing to block a todo on
  }
  const ext = path.extname(abs).toLowerCase();
  const kind = ext === '.tsx'
    ? ts.ScriptKind.TSX
    : ext === '.jsx'
      ? ts.ScriptKind.JSX
      : ext === '.ts' || ext === '.mts' || ext === '.cts'
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(abs, content, ts.ScriptTarget.ES2022, true, kind);
  } catch {
    return out;
  }
  const diagnostics =
    (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const d of diagnostics) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    let line = 1;
    let column = 1;
    if (d.start !== undefined) {
      const lc = sourceFile.getLineAndCharacterOfPosition(d.start);
      line = lc.line + 1;
      column = lc.character + 1;
    }
    out.push({ line, column, code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') });
  }
  return out;
}

const hooks: ToolHook[] = [
  {
    name: 'schemaValidator',
    async preExecute(call) {
      const schema = await schemaFor(call);
      if (schema) {
        const camelSchema = camelizeSchemaNode(schema);
        normalizeArgCase(call, camelSchema);
        coerceStructuredArgs(call, camelSchema);
        healRuntimeAndScalarArgs(call, camelSchema);
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
    name: 'planGate',
    async preExecute(call) {
      const denial = planGateDenial(call.name, call.args, call.ctx.sessionId);
      if (denial) return new ToolPipelineError(denial, 'plan_mode_blocked');
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
    name: 'diagnosticsHook',
    async preExecute(call) {
      const gateFiles = collectGateFiles(call);
      if (!gateFiles) return null;
      const tsFiles = gateFiles.filter((f) => TS_FILE_RE.test(f));
      if (tsFiles.length === 0) return null;
      try {
        const ws = getActiveWorkspace(call.ctx.sessionId);
        if (!ws) return null;
        const before = new Map<string, Set<string>>();
        for (const rel of tsFiles) {
          const found = readSyntactic(path.join(ws.path, rel));
          before.set(rel, new Set(found.map(diagnosticSignature)));
        }
        call.diagBefore = before;
      } catch {
      }
      return null;
    },
    transform(call, result) {
      if (!result.ok || result.isError) return result;
      const gateFiles = collectGateFiles(call);
      if (!gateFiles) return result;
      const tsFiles = gateFiles.filter((f) => TS_FILE_RE.test(f));
      if (tsFiles.length === 0) return result;
      try {
        const ws = getActiveWorkspace(call.ctx.sessionId);
        if (!ws) return result;
        const notes: string[] = [];
        const deadline = Date.now() + 1_500;
        const candidates = [...new Set([...tsFiles, ...ledgerFiles(call.ctx.sessionId)])];
        for (const rel of candidates) {
          if (Date.now() > deadline) break;
          const abs = path.join(ws.path, rel);
          markTouched(abs);
          const found = readSyntactic(abs);
          const baseline = call.diagBefore?.get(rel) ?? new Set<string>();
          const introduced = found.filter((d) => !baseline.has(diagnosticSignature(d)));
          recordFileDiagnostics(call.ctx.sessionId, rel, introduced);
          if (tsFiles.includes(rel) && introduced.length > 0) {
            notes.push(`⚠ ${introduced.length} new diagnostic(s) in ${rel}:`);
            for (const d of introduced.slice(0, 5)) {
              notes.push(`  ${d.line}:${d.column}  TS${d.code}: ${d.message}`);
            }
          }
        }
        if (notes.length === 0) return result;
        return { ...result, text: `${result.text}\n\n${notes.join('\n')}` };
      } catch {
        return result;
      }
    },
    postExecute() {
    },
  },
];


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
    const { emitAddonEvent, addonHookCount } = await import('../addons/registry.js');
    if (addonHookCount() > 0) {
      const { createAddonApi } = await import('../addons/api.js');
      const outcome = await emitAddonEvent('tool.call', {
        tool: call.wireName,
        args: call.args,
        sessionId: call.ctx?.sessionId,
      }, createAddonApi('__harness__'));
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
    const { emitAddonEvent, addonHookCount } = await import('../addons/registry.js');
    if (addonHookCount() > 0) {
      const { createAddonApi } = await import('../addons/api.js');
      try {
        await emitAddonEvent('tool.result', {
          tool: call.wireName,
          args: call.args,
          result,
          sessionId: call.ctx?.sessionId,
        }, createAddonApi('__harness__'));
      } catch {  }
    }
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
