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
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { walkFiles } from './list.js';

let cachedService: ts.LanguageService | null = null;
let cachedRoot: string | null = null;

function getService(root: string): ts.LanguageService {
  if (cachedService && cachedRoot === root) return cachedService;

  const allFiles = walkFiles(root).files;
  const scriptFiles = allFiles.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
  const fileSet = new Set(scriptFiles.map((f) => path.resolve(root, f.split('/').join(path.sep))));

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...fileSet],
    getScriptVersion: (_fileName: string) => '1',
    getScriptSnapshot: (fileName: string) => {
      try {
        return ts.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8'));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({
      allowJs: true,
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
    }),
    getDefaultLibFileName: (options: ts.CompilerOptions) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName: string) => {
      try { return existsSync(fileName); } catch { return false; }
    },
    readFile: (fileName: string) => {
      try { return readFileSync(fileName, 'utf8'); } catch { return undefined; }
    },
  };

  cachedService = ts.createLanguageService(host, ts.createDocumentRegistry());
  cachedRoot = root;
  return cachedService;
}

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
  const service = getService(root);
  const lines: string[] = [];

  try {
    if (mode === 'definition' || mode === 'references' || mode === 'rename') {
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
      return { ok: false, isError: true, text: `Unknown mode "${mode}". Available: definition, references, symbols, rename.` };
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