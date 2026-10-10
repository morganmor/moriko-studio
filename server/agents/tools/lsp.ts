/**
 * agent__lsp_symbols — AST-level symbol navigation via the TypeScript
 * Language Service (in-process, no separate server).
 *
 * Modes:
 *  - definition:  given file + line + column, return where the symbol is defined.
 *  - references:  given file + line + column, return all reference locations.
 *  - symbols:     given file, list all top-level symbols (functions, classes,
 *                  interfaces, types, etc.) with their line numbers.
 *  - rename:       given file + line + column + newName, return all locations
 *                  that need renaming.
 *
 * One LanguageService is cached per workspace root. The host reads files from
 * disk on demand; heavy dirs (node_modules, .git, ...) are skipped from the
 * initial file list but still resolvable on demand.
 */
import * as ts from 'typescript';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { getLanguageService } from '../lsp-service.js';

/** Convert 1-based line+column to 0-based character offset. */
function positionFromLineCol(content: string, line: number, column: number): number {
  const lines = content.split('\n');
  let offset = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length - 1); i++) {
    offset += lines[i].length + 1;
  }
  return Math.min(offset + Math.max(column - 1, 0), content.length);
}

/** Convert 0-based offset to 1-based line+column. */
function lineColFromPosition(content: string, position: number): { line: number; column: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < position && i < content.length; i++) {
    if (content[i] === '\n') { line++; col = 1; }
    else if (content[i] !== '\r') { col++; }
  }
  return { line, column: col };
}

function formatSpan(root: string, fileName: string, content: string, start: number): string {
  const rel = path.relative(root, fileName).replace(/\\/g, '/');
  const startLC = lineColFromPosition(content, start);
  const fileLines = content.split('\n');
  const lineText = startLC.line <= fileLines.length ? fileLines[startLC.line - 1].trim() : '';
  return `${rel}:${startLC.line}:${startLC.column}  ${lineText}`;
}

export async function lspSymbolsTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);
  const filePath = str(args, 'path').trim();
  if (!filePath) return { ok: false, isError: true, text: 'lsp_symbols needs a "path".' };

  const resolved = await resolveWithPermission('lsp_symbols', filePath, ctx);
  const absolute = resolved.absolute;

  let content: string;
  try {
    content = readFileSync(absolute, 'utf8');
  } catch {
    return { ok: false, isError: true, text: `Cannot read file: ${resolved.relative}.` };
  }

  const mode = str(args, 'mode').trim().toLowerCase();
  const service = getLanguageService(absolute, root);
  const lines: string[] = [];

  try {
    if (mode === 'definition' || mode === 'references' || mode === 'rename'
      || mode === 'hover' || mode === 'diagnostics' || mode === 'implementations' || mode === 'type_definition' || mode === 'call_hierarchy') {
      const lineNum = num(args, 'line') ?? 1;
      const colNum = num(args, 'column') ?? 1;
      const position = positionFromLineCol(content, lineNum, colNum);

      if (mode === 'definition') {
        const defs = service.getDefinitionAtPosition(absolute, position);
        if (!defs || defs.length === 0) {
          return { ok: true, isError: false, text: 'No definition found at this position.' };
        }
        lines.push(`${defs.length} definition(s):`);
        for (const def of defs) {
          try {
            const defContent = readFileSync(def.fileName, 'utf8');
            lines.push(formatSpan(root, def.fileName, defContent, def.textSpan.start));
          } catch {
            lines.push(`${path.relative(root, def.fileName).replace(/\\/g, '/')} (offset ${def.textSpan.start})`);
          }
        }
      } else if (mode === 'references') {
        const refs = service.findReferences(absolute, position);
        if (!refs || refs.length === 0) {
          return { ok: true, isError: false, text: 'No references found at this position.' };
        }
        let total = 0;
        for (const symbol of refs) {
          lines.push(`-- [${symbol.definition.kind}] ${symbol.definition.name} --`);
          for (const ref of symbol.references) {
            try {
              const refContent = readFileSync(ref.fileName, 'utf8');
              lines.push(formatSpan(root, ref.fileName, refContent, ref.textSpan.start));
            } catch {
              lines.push(`${path.relative(root, ref.fileName).replace(/\\/g, '/')} (offset ${ref.textSpan.start})`);
            }
            total++;
          }
        }
        lines.unshift(`${total} reference(s) in ${refs.length} symbol(s):`);
      } else if (mode === 'hover') {
        const quick = service.getQuickInfoAtPosition(absolute, position);
        if (!quick) return { ok: true, isError: false, text: 'No quick info at this position.' };
        const display = ts.displayPartsToString(quick.displayParts);
        const doc = quick.documentation ? ts.displayPartsToString(quick.documentation) : '';
        const lc = lineColFromPosition(content, quick.textSpan.start);
        lines.push(`${display}`);
        if (doc) { lines.push(''); lines.push(doc); }
        lines.push('');
        lines.push(`at ${resolved.relative}:${lc.line}:${lc.column}`);
      } else if (mode === 'diagnostics') {
        const diags = [
          ...(service.getSyntacticDiagnostics(absolute) ?? []),
          ...(service.getSemanticDiagnostics(absolute) ?? []),
        ];
        if (diags.length === 0) return { ok: true, isError: false, text: `No diagnostics in ${resolved.relative}.` };
        lines.push(`${diags.length} diagnostic(s):`);
        for (const d of diags) {
          if (d.file && d.start !== undefined) {
            const lc = lineColFromPosition(d.file.text ?? '', d.start);
            lines.push(`${resolved.relative}:${lc.line}:${lc.column}  ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}${d.code ? ` (TS${d.code})` : ''}`);
          } else {
            lines.push(ts.flattenDiagnosticMessageText(d.messageText, ' '));
          }
        }
      } else if (mode === 'implementations') {
        const impls = service.getImplementationAtPosition(absolute, position);
        if (!impls || impls.length === 0) {
          return { ok: true, isError: false, text: 'No implementations found at this position.' };
        }
        lines.push(`${impls.length} implementation(s):`);
        for (const impl of impls) {
          try {
            const implContent = readFileSync(impl.fileName, 'utf8');
            lines.push(formatSpan(root, impl.fileName, implContent, impl.textSpan.start));
          } catch {
            lines.push(`${path.relative(root, impl.fileName).replace(/\\/g, '/')} (offset ${impl.textSpan.start})`);
          }
        }
      } else if (mode === 'type_definition') {
        const defs = service.getTypeDefinitionAtPosition(absolute, position);
        if (!defs || defs.length === 0) {
          return { ok: true, isError: false, text: 'No type definition found at this position.' };
        }
        lines.push(`${defs.length} type definition(s):`);
        for (const def of defs) {
          try {
            const defContent = readFileSync(def.fileName, 'utf8');
            lines.push(formatSpan(root, def.fileName, defContent, def.textSpan.start));
          } catch {
            lines.push(`${path.relative(root, def.fileName).replace(/\\/g, '/')} (offset ${def.textSpan.start})`);
          }
        }
      } else if (mode === 'call_hierarchy') {
        const dir = str(args, 'direction').trim().toLowerCase() || 'incoming';
        const depth = Math.max(1, Math.min(num(args, 'depth') ?? 1, 3));
        const rootItem = service.getNavigateToItems(absolute, position)[0];
        const walk = (file: string, pos: number, level: number): void => {
          if (level > depth) return;
          const items = dir === 'outgoing'
            ? service.provideCallHierarchyOutgoingCalls(file, pos)
            : service.provideCallHierarchyIncomingCalls(file, pos);
          for (const call of items ?? []) {
            const item = ('item' in call ? call.item : call) as ts.CallHierarchyItem;
            try {
              const itemContent = readFileSync(item.file, 'utf8');
              lines.push(`${'  '.repeat(level - 1)}${dir === 'outgoing' ? '→' : '←'} ${formatSpan(root, item.file, itemContent, item.span.start)}`);
            } catch {
              lines.push(`${'  '.repeat(level - 1)}${dir === 'outgoing' ? '→' : '←'} ${path.relative(root, item.file).replace(/\\/g, '/')}`);
            }
            const nextPos = item.selectionSpan.start;
            walk(item.file, nextPos, level + 1);
          }
        };
        if (rootItem) {
          lines.push(`call hierarchy (${dir}, depth ≤ ${depth}) from ${rootItem.name}:`);
          walk(absolute, position, 1);
        } else {
          return { ok: true, isError: false, text: 'No call hierarchy item at this position.' };
        }
      } else if (mode === 'rename') {
        const newName = str(args, 'newName').trim();
        if (!newName) return { ok: false, isError: true, text: 'rename mode needs a "newName".' };
        const locations = service.findRenameLocations(absolute, position, false, false, false);
        if (!locations || locations.length === 0) {
          return { ok: true, isError: false, text: 'No rename locations found at this position.' };
        }
        lines.push(`${locations.length} location(s) to rename to "${newName}":`);
        for (const loc of locations) {
          try {
            const locContent = readFileSync(loc.fileName, 'utf8');
            lines.push(formatSpan(root, loc.fileName, locContent, loc.textSpan.start));
          } catch {
            lines.push(`${path.relative(root, loc.fileName).replace(/\\/g, '/')} (offset ${loc.textSpan.start})`);
          }
        }
      }
    } else if (mode === 'symbols' || mode === '') {
      const items = service.getNavigationBarItems(absolute);
      if (!items || items.length === 0) {
        return { ok: true, isError: false, text: 'No symbols found in this file.' };
      }

      const formatItems = (items: readonly ts.NavigationBarItem[], indent: string): void => {
        for (const item of items) {
          const span = item.spans[0];
          if (span) {
            const startLC = lineColFromPosition(content, span.start);
            lines.push(`${indent}[${item.kind}] ${item.text}  (line ${startLC.line})`);
          } else {
            lines.push(`${indent}[${item.kind}] ${item.text}`);
          }
          if (item.childItems && item.childItems.length > 0) {
            formatItems(item.childItems, `${indent}  `);
          }
        }
      };
      formatItems(items, '');
    } else {
      return { ok: false, isError: true, text: `Unknown mode "${mode}". Available: definition, references, symbols, rename, hover, diagnostics, implementations, type_definition, call_hierarchy.` };
    }
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `LSP operation failed: ${error instanceof Error ? error.message : 'unknown error'}. The file may not be part of the project or the position is invalid.`,
    };
  }

  return { ok: true, isError: false, text: truncateOutput(lines.join('\n')) };
}