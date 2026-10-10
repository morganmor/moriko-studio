/**
 * F3.1 — agent__diagnostics: TypeScript diagnostics PER FILE in milliseconds
 * (in-process LanguageService, no full tsc). scope "touched" re-checks the
 * files edited this session.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, bool, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { getLanguageService } from '../lsp-service.js';
import * as ts from 'typescript';
import { defineTool } from './registry.js';

/** Files edited this session (populated by the pipeline post-edit hook, F3.2). */
const touched = new Map<string, number>(); // absolutePath -> mtimeMs

export function markTouched(absolute: string): void {
  try {
    touched.set(absolute, statSync(absolute).mtimeMs);
  } catch {
    touched.set(absolute, Date.now());
  }
}

export function touchedFiles(): string[] {
  return [...touched.keys()];
}

async function diagnosticsTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);
  const scope = str(args, 'scope').trim().toLowerCase() || 'paths';
  const semantic = bool(args, 'semantic');

  let files: string[] = [];
  if (scope === 'touched') {
    files = touchedFiles();
    if (files.length === 0) {
      return { ok: true, isError: false, text: 'No files touched this session yet. Pass scope "paths" with explicit paths.' };
    }
  } else {
    const rawPaths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === 'string') : [];
    if (rawPaths.length === 0) {
      return { ok: false, isError: true, text: 'diagnostics needs "paths" (array) or scope "touched".' };
    }
    for (const p of rawPaths) {
      const resolved = await resolveWithPermission('diagnostics', p, ctx);
      files.push(resolved.absolute);
    }
  }

  const sections: string[] = [];
  let total = 0;
  for (const file of files.slice(0, 40)) {
    try { readFileSync(file, 'utf8'); } catch { continue; }
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const service = getLanguageService(file, root);
    const diags = [
      ...(service.getSyntacticDiagnostics(file) ?? []),
      ...(semantic ? (service.getSemanticDiagnostics(file) ?? []) : []),
    ];
    if (diags.length === 0) continue;
    total += diags.length;
    const lines: string[] = [`── ${rel} (${diags.length})`];
    for (const d of diags.slice(0, 20)) {
      if (d.file && d.start !== undefined) {
        const lc = d.file.getLineAndCharacterOfPosition(d.start);
        const srcLine = d.file.text.split('\n')[lc.line]?.trim().slice(0, 100) ?? '';
        lines.push(`  ${lc.line + 1}:${lc.character + 1}  TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}  | ${srcLine}`);
      } else {
        lines.push(`  TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
      }
    }
    if (diags.length > 20) lines.push(`  … and ${diags.length - 20} more`);
    sections.push(lines.join('\n'));
  }

  if (total === 0) {
    return { ok: true, isError: false, text: `No diagnostics in ${files.length} file(s).` };
  }
  return {
    ok: false,
    isError: true,
    text: truncateOutput(`# diagnostics — ${total} issue(s) across ${sections.length} file(s)\n\n${sections.join('\n\n')}\n\nNext: fix top issues, or run agent__verify quick at the end.`),
  };
}

export const diagnosticsSpec = defineTool({
  def: {
    wireName: 'agent__diagnostics',
    description: 'TypeScript diagnostics per file (fast, in-process); scope "touched" = files edited this session.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Files to check (scope "paths").' },
        scope: { type: 'string', enum: ['paths', 'touched'], description: 'Scope (default "paths").' },
        semantic: { type: 'boolean', description: 'Include semantic diagnostics (default false).' },
      },
    },
  },
  handler: diagnosticsTool,
  readOnly: true,
  category: 'quality',
});
