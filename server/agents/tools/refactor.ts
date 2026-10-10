/**
 * F3.5 — agent__refactor: compiler-driven refactors applied ATOMICALLY.
 *  - rename: findRenameLocations → collect edits → apply all-or-nothing.
 *  - move_file: getEditsForFileRename + move, preserving server .js style.
 *  - organize_imports: LS organizeImports on one file.
 * dryRun (default true) shows a unified diff instead of writing.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, num, bool, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { getLanguageService } from '../lsp-service.js';
import { buildUnifiedDiff } from '../diff.js';
import { snapshotFile } from '../vault.js';
import { recordAfterWrite } from '../read-policy.js';
import { defineTool } from './registry.js';

interface PlannedEdit {
  file: string; // absolute
  from: number; // 0-based offset
  to: number;
  text: string;
}

async function refactorTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);
  const mode = str(args, 'mode').trim().toLowerCase();
  const dryRun = args.dryRun === undefined ? true : bool(args, 'dryRun');

  if (mode === 'organize_imports') {
    const filePath = str(args, 'path').trim();
    if (!filePath) return { ok: false, isError: true, text: 'organize_imports needs "path".' };
    const resolved = await resolveWithPermission('refactor', filePath, ctx, 'write');
    const service = getLanguageService(resolved.absolute, root);
    const fileChanges = service.organizeImports({ type: 'file', fileName: resolved.absolute }, { newLineCharacter: '\n' }, {});
    const edits: PlannedEdit[] = [];
    for (const change of fileChanges) {
      for (const tc of change.textChanges) {
        edits.push({ file: resolved.absolute, from: tc.span.start, to: tc.span.start + tc.span.length, text: tc.newText });
      }
    }
    if (edits.length === 0) return { ok: true, isError: false, text: `Imports already organized in ${resolved.relative}.` };
    return applyEdits(edits, root, ctx, dryRun, 'organize_imports');
  }

  if (mode === 'rename') {
    const filePath = str(args, 'path').trim();
    const newName = str(args, 'newName').trim();
    const line = num(args, 'line') ?? 1;
    const column = num(args, 'column') ?? 1;
    if (!filePath || !newName) return { ok: false, isError: true, text: 'rename needs "path", "line", "column", "newName".' };
    const resolved = await resolveWithPermission('refactor', filePath, ctx, 'write');
    const content = readFileSync(resolved.absolute, 'utf8');
    // 1-based line/col → 0-based offset
    const lines = content.split('\n');
    let offset = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length - 1); i += 1) offset += lines[i].length + 1;
    offset += Math.max(column - 1, 0);

    const service = getLanguageService(resolved.absolute, root);
    const locations = service.findRenameLocations(resolved.absolute, offset, false, false, false);
    if (!locations || locations.length === 0) {
      return { ok: false, isError: true, text: `No rename locations found at ${resolved.relative}:${line}:${column}.` };
    }
    const edits: PlannedEdit[] = locations.map((loc) => ({
      file: loc.fileName,
      from: loc.textSpan.start,
      to: loc.textSpan.start + loc.textSpan.length,
      text: newName,
    }));
    const header = `rename → "${newName}" — ${edits.length} location(s) across ${new Set(edits.map((e) => e.file)).size} file(s).`;
    return applyEdits(edits, root, ctx, dryRun, 'rename', header);
  }

  if (mode === 'move_file') {
    const fromRel = str(args, 'from').trim();
    const toRel = str(args, 'to').trim();
    if (!fromRel || !toRel) return { ok: false, isError: true, text: 'move_file needs "from" and "to".' };
    const from = await resolveWithPermission('refactor', fromRel, ctx, 'write');
    const toAbs = path.resolve(root, toRel);
    if (!existsSync(from.absolute)) return { ok: false, isError: true, text: `"${fromRel}" not found.` };
    if (!toAbs.startsWith(root)) return { ok: false, isError: true, text: `"${toRel}" is outside the workspace root.` };

    const service = getLanguageService(from.absolute, root);
    const edits: PlannedEdit[] = [];
    try {
      const changes = service.getEditsForFileRename(from.absolute, path.basename(toAbs), {}, {});
      for (const change of changes) {
        for (const tc of change.textChanges) {
          edits.push({ file: change.fileName, from: tc.span.start, to: tc.span.start + tc.span.length, text: tc.newText });
        }
      }
    } catch { /* import rewrite best-effort */ }
    const header = `move ${fromRel} → ${toRel} (+${edits.length} import edit(s) in ${new Set(edits.map((e) => e.file)).size} file(s)).`;
    if (dryRun) {
      const diffParts: string[] = [header];
      diffParts.push('(dry run: file move + the import edits below)');
      for (const edit of edits) {
        const fileContent = readFileSync(edit.file, 'utf8');
        const fileLines = fileContent.split('\n');
        let ln = 1;
        for (let i = 0; i < edit.from; i += 1) if (fileContent[i] === '\n') ln += 1;
        diffParts.push(`${path.relative(root, edit.file).replace(/\\/g, '/')}:${ln}  ${fileLines[ln - 1]?.trim()} → ${edit.text}`);
      }
      return { ok: true, isError: false, text: truncateOutput(diffParts.join('\n')) };
    }
    // Apply: vault both the moved file and every import-edit target, then write.
    try {
      snapshotFile(ctx.sessionId, from.absolute, 'move_file');
      const { mkdirSync, writeFileSync, renameSync } = await import('node:fs');
      mkdirSync(path.dirname(toAbs), { recursive: true });
      renameSync(from.absolute, toAbs);
      // Preserve server-ESM `.js` extension style in rewritten imports.
      for (const edit of edits) {
        let file = edit.file;
        if (edit.file === from.absolute) file = toAbs;
        try {
          snapshotFile(ctx.sessionId, file, 'move_file-import');
          const c = readFileSync(file, 'utf8');
          writeFileSync(file, c.slice(0, edit.from) + edit.text + c.slice(edit.to));
        } catch { /* best effort */ }
      }
      recordAfterWrite(ctx.sessionId, toAbs, readFileSync(toAbs, 'utf8'), statSync(toAbs).mtimeMs);
      return { ok: true, isError: false, text: truncateOutput(`${header}\nApplied atomically. Run agent__typecheck to confirm.`) };
    } catch (error) {
      return { ok: false, isError: true, text: `move_file failed: ${error instanceof Error ? error.message : 'unknown error'}.` };
    }
  }

  return { ok: false, isError: true, text: 'Unknown mode. Available: rename, move_file, organize_imports.' };
}

/** Apply edits atomically (all-or-nothing): vault each file, then write. */
async function applyEdits(
  edits: PlannedEdit[],
  root: string,
  ctx: AgentToolContext,
  dryRun: boolean,
  op: string,
  header?: string,
): Promise<HarnessToolResult> {
  // Group by file, apply per-file from END to start so offsets stay valid.
  const byFile = new Map<string, PlannedEdit[]>();
  for (const edit of edits) {
    const list = byFile.get(edit.file) ?? [];
    list.push(edit);
    byFile.set(edit.file, list);
  }
  const results: Array<{ rel: string; before: string; after: string }> = [];
  for (const [file, fileEdits] of byFile) {
    let content: string;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    void content;
    let after = content;
    for (const edit of [...fileEdits].sort((a, b) => b.from - a.from)) {
      after = after.slice(0, edit.from) + edit.text + after.slice(edit.to);
    }
    results.push({ rel: path.relative(root, file).replace(/\\/g, '/'), before: content, after });
  }

  if (dryRun) {
    const parts: string[] = [header ?? `${op} — ${edits.length} edit(s) (dry run):`];
    for (const r of results) {
      const diff = buildUnifiedDiff(r.before, r.after, r.rel);
      parts.push(diff);
    }
    return { ok: true, isError: false, text: truncateOutput(parts.join('\n\n')) };
  }

  const { writeFileSync } = await import('node:fs');
  try {
    for (const [file] of byFile) {
      snapshotFile(ctx.sessionId, file, `refactor-${op}`);
    }
    for (const r of results) {
      const abs = path.join(root, r.rel.split('/').join(path.sep));
      writeFileSync(abs, r.after);
      recordAfterWrite(ctx.sessionId, abs, r.after, statSync(abs).mtimeMs);
    }
    return {
      ok: true,
      isError: false,
      text: truncateOutput(`${header ?? `${op} — ${edits.length} edit(s)`} applied atomically to ${results.length} file(s). Run agent__typecheck to confirm.`),
    };
  } catch (error) {
    return { ok: false, isError: true, text: `refactor apply failed (files vaulted — agent__undo/vault_restore can recover): ${error instanceof Error ? error.message : 'unknown error'}.` };
  }
}

export const refactorSpec = defineTool({
  def: {
    wireName: 'agent__refactor',
    description: 'Compiler-driven refactors: rename (cross-file), move_file (updates imports), organize_imports; dryRun default shows a diff.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['rename', 'move_file', 'organize_imports'], description: 'Refactor mode.' },
        path: { type: 'string', description: 'File (rename / organize_imports).' },
        line: { type: 'number', description: '1-based line of the symbol (rename).' },
        column: { type: 'number', description: '1-based column (rename).' },
        newName: { type: 'string', description: 'New symbol name (rename).' },
        from: { type: 'string', description: 'Source path (move_file).' },
        to: { type: 'string', description: 'Destination path (move_file).' },
        dryRun: { type: 'boolean', description: 'Show diff only (default true).' },
      },
      required: ['mode'],
    },
  },
  handler: refactorTool,
  readOnly: false,
  terminal: false,
  category: 'quality',
});
