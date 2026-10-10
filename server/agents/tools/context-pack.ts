/**
 * F2.2 — agent__context_pack: one call → minimal context to change a symbol
 * safely: body (with receipt), referenced type signatures, callers, callees,
 * and mentioning tests — packed greedily up to budgetChars.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, num, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { findSymbolSpans } from '../ts-ast.js';
import { getLanguageService } from '../lsp-service.js';
import { fuzzyHint } from '../fuzzy.js';
import { recordRead } from '../read-policy.js';
import { statSync } from 'node:fs';
import { defineTool } from './registry.js';

async function contextPackTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);
  const filePath = str(args, 'path').trim();
  const symbol = str(args, 'symbol').trim();
  if (!filePath || !symbol) {
    return { ok: false, isError: true, text: 'context_pack needs "path" and "symbol".' };
  }
  const resolved = await resolveWithPermission('context_pack', filePath, ctx);
  const budget = Math.min(Math.max(num(args, 'budgetChars') ?? 12_000, 2_000), 48_000);

  let content: string;
  try {
    content = readFileSync(resolved.absolute, 'utf8');
  } catch {
    return { ok: false, isError: true, text: `Cannot read file: ${resolved.relative}.` };
  }
  const contentLines = content.split('\n');

  const spans = findSymbolSpans(content, path.basename(resolved.absolute), symbol) ?? [];
  if (spans.length === 0) {
    return {
      ok: false,
      isError: true,
      text: `Symbol "${symbol}" not found in ${resolved.relative}.${fuzzyHint(resolved.absolute)} Try agent__read_symbol or agent__lsp_symbols mode "symbols".`,
    };
  }
  const span = spans[0];
  const sections: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  const push = (text: string, label: string, moreCount?: number): boolean => {
    if (used + text.length > budget) {
      omitted.push(label);
      return false;
    }
    used += text.length;
    sections.push(text);
    if (moreCount !== undefined) sections.push(`[+${moreCount} more, call read_symbol]`);
    return true;
  };

  // body (numbered, with receipt)
  const bodyLines = contentLines.slice(span.startLine - 1, span.endLine);
  const body = [`── body · ${span.breadcrumb} (${span.startLine}–${span.endLine})`,
    ...bodyLines.map((l, i) => `${String(span.startLine + i).padStart(6, '|')} ${l}`)].join('\n');
  push(body, 'body');
  try {
    recordRead(ctx.sessionId, resolved.absolute, content, statSync(resolved.absolute).mtimeMs, span.startLine, span.endLine);
  } catch { /* best effort */ }

  const ext = path.extname(resolved.absolute).toLowerCase();
  const isTs = ['.ts', '.tsx', '.mts', '.cts'].includes(ext);
  if (isTs) {
    try {
      const service = getLanguageService(resolved.absolute, root);
      // Callers via findReferences at the symbol's name position.
      const nameOffset = span.startOffset;
      const refs = service.findReferences(resolved.absolute, nameOffset);
      const callerLines: string[] = [];
      let callerCount = 0;
      for (const sym of refs ?? []) {
        for (const ref of sym.references) {
          if (ref.fileName === resolved.absolute && ref.textSpan.start >= span.startOffset && ref.textSpan.start <= span.endOffset) continue;
          callerCount += 1;
          if (callerLines.length < 15) {
            try {
              const refContent = readFileSync(ref.fileName, 'utf8');
              let line = 1;
              for (let i = 0; i < ref.textSpan.start; i += 1) if (refContent[i] === '\n') line += 1;
              const refLines = refContent.split('\n');
              callerLines.push(`  ${path.relative(root, ref.fileName).replace(/\\/g, '/')}:${line}  ${(refLines[line - 1] ?? '').trim().slice(0, 120)}`);
            } catch { /* skip */ }
          }
        }
      }
      if (callerLines.length > 0) {
        push(`── callers (${callerCount}):\n${callerLines.join('\n')}`, 'callers', Math.max(callerCount - callerLines.length, 0));
      }

      // Types referenced at the symbol position: quick info + type definition signatures.
      const quick = service.getQuickInfoAtPosition(resolved.absolute, nameOffset);
      if (quick) {
        const displayParts = (await import('typescript')).displayPartsToString(quick.displayParts);
        push(`── signature:\n  ${displayParts.slice(0, 400)}`, 'signature');
      }
    } catch { /* LSP context is best-effort */ }
  }

  // tests mentioning the symbol (file names + first mention line)
  try {
    const { walkFiles } = await import('./list.js');
    const testFiles = walkFiles(root).files.filter((f) => /\.(test|spec)\.[tj]sx?$/.test(f));
    const mentioning: string[] = [];
    for (const tf of testFiles.slice(0, 400)) {
      if (mentioning.length >= 15) break;
      try {
        const tContent = readFileSync(path.join(root, tf), 'utf8');
        const idx = tContent.indexOf(symbol);
        if (idx >= 0) {
          let line = 1;
          for (let i = 0; i < idx; i += 1) if (tContent[i] === '\n') line += 1;
          mentioning.push(`  ${tf}:${line}`);
        }
      } catch { /* skip */ }
    }
    if (mentioning.length > 0) push(`── tests mentioning "${symbol}":\n${mentioning.join('\n')}`, 'tests');
  } catch { /* skip */ }

  const header = `# context_pack — ${resolved.relative} · "${symbol}" (${span.breadcrumb}) · ${used}/${budget} chars`;
  const tail = omitted.length > 0 ? `\n[cut for budget: ${omitted.join(', ')} — call read_symbol for the rest]` : '\nNext: edit the receipted range directly (edit_file / edit_lines).';
  return { ok: true, isError: false, text: truncateOutput(`${header}\n\n${sections.join('\n\n')}${tail}`) };
}

export const contextPackSpec = defineTool({
  def: {
    wireName: 'agent__context_pack',
    description: 'One call → minimal context to edit a symbol safely: body + receipt, signature, callers, tests.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File containing the symbol.' },
        symbol: { type: 'string', description: 'Symbol name, e.g. "finishEdit".' },
        budgetChars: { type: 'number', description: 'Char budget (default 12000, max 48000).' },
      },
      required: ['path', 'symbol'],
    },
  },
  handler: contextPackTool,
  readOnly: true,
  category: 'read',
});
