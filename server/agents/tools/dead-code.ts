/**
 * F3.7 — agent__dead_code: exported symbols with no importer in the deps
 * graph AND no LSP references outside their own file. Entry points excluded.
 * Never auto-deletes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { exportedNames } from '../ts-ast.js';
import { getLanguageService } from '../lsp-service.js';
import { queryDeps } from '../deps.js';
import { walkFiles } from './list.js';
import { defineTool } from './registry.js';

/** Files that are legitimate entry points — their exports are "used". */
const ENTRY_RE = /(main|index|vite\.config|vitest\.config|rollup\.config|esbuild\.config|webpack\.config|register)\.(ts|tsx|js|mjs|cjs)$|[\\/]routes\.ts$/;

async function deadCodeTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);
  const subpath = str(args, 'subpath').trim() || '.';
  const resolved = await resolveWithPermission('dead_code', subpath, ctx);

  const globRe = /\.(ts|tsx|js|jsx)$/;
  const files = walkFiles(resolved.absolute).files.filter((f) => globRe.test(f)).slice(0, 1200);
  if (files.length === 0) return { ok: true, isError: false, text: `No TS/JS files under "${subpath}".` };

  const candidates: Array<{ file: string; name: string; line: number; kind: string }> = [];
  for (const file of files) {
    if (ENTRY_RE.test(file)) continue;
    let content: string;
    try { content = readFileSync(path.join(resolved.absolute, file), 'utf8'); } catch { continue; }
    for (const exp of exportedNames(content, file)) {
      candidates.push({ file, name: exp.name, line: exp.line, kind: exp.kind });
    }
  }

  // Check 1: no importer of the FILE (deps graph).
  // Check 2: no LS references outside the declaring file.
  const dead: Array<{ file: string; name: string; line: number; kind: string; refs: number }> = [];
  const nameToFile = new Map<string, string>();
  for (const c of candidates) {
    if (!nameToFile.has(c.name)) nameToFile.set(c.name, c.file);
  }

  const refCache = new Map<string, number>();
  for (const c of candidates.slice(0, 400)) {
    const abs = path.join(resolved.absolute, c.file);
    // Skip re-export barrels: files named index.* re-export for others.
    if (/\/index\.(ts|tsx|js|jsx)$/.test(c.file)) continue;

    const report = queryDeps(root, abs);
    const hasImporters = (report?.importedBy.length ?? 0) > 0;
    const key = `${c.name}@${c.file}`;
    let outsideRefs = refCache.get(key);
    if (outsideRefs === undefined) {
      outsideRefs = -1;
      try {
        const content = readFileSync(abs, 'utf8');
        const service = getLanguageService(abs, root);
        const lines = content.split('\n');
        let offset = 0;
        for (let i = 0; i < Math.min(c.line - 1, lines.length - 1); i += 1) offset += lines[i].length + 1;
        // Scan the declaration line for the identifier position.
        const declLine = lines[c.line - 1] ?? '';
        const col = declLine.indexOf(c.name);
        if (col >= 0) {
          const refs = service.findReferences(abs, offset + col);
          outsideRefs = refs
            ? refs.reduce((sum, sym) => sum + sym.references.filter((r) => path.resolve(r.fileName) !== path.resolve(abs)).length, 0)
            : 0;
        } else {
          outsideRefs = 0;
        }
      } catch {
        outsideRefs = -1; // unknown → keep (never report a false dead)
      }
      refCache.set(key, outsideRefs);
    }
    if (outsideRefs < 0) continue;
    if (outsideRefs === 0 && !hasImporters) {
      dead.push({ file: c.file, name: c.name, line: c.line, kind: c.kind, refs: outsideRefs });
    }
  }

  if (dead.length === 0) {
    return { ok: true, isError: false, text: `No obviously dead exports found among ${candidates.length} export(s) under "${subpath}".` };
  }
  const lines: string[] = [`# dead_code — ${dead.length} candidate(s) (0 external refs, no file importers):`];
  for (const d of dead.slice(0, 60)) {
    lines.push(`  ${d.file}:${d.line}  ${d.kind} ${d.name}  (0 refs)`);
  }
  if (dead.length > 60) lines.push(`  … and ${dead.length - 60} more`);
  lines.push('');
  lines.push('Review manually before deleting — dynamic imports, string-based access and addon entry points are not tracked. This tool never deletes anything.');
  return { ok: true, isError: false, text: truncateOutput(lines.join('\n')) };
}

export const deadCodeSpec = defineTool({
  def: {
    wireName: 'agent__dead_code',
    description: 'Find exported symbols with zero external references and no file importers (entry points excluded); never deletes.',
    inputSchema: {
      type: 'object',
      properties: {
        subpath: { type: 'string', description: 'Scope directory (default ".").' },
      },
    },
  },
  handler: deadCodeTool,
  readOnly: true,
  category: 'quality',
});
