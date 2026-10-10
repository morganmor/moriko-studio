/**
 * F2.1 — agent__read_symbol: read EXACTLY one symbol's line range (AST-driven
 * for TS/JS, fold-based fallback for other languages), with a read receipt so
 * the range can be edited directly.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, num, bool, truncateOutput, requireWorkspace, resolveWithPermission } from './shared.js';
import { findSymbolSpans } from '../ts-ast.js';
import { foldContent } from '../fold.js';
import { fuzzyHint } from '../fuzzy.js';
import { getReadEntry, recordRead } from '../read-policy.js';
import { defineTool } from './registry.js';

function formatNumbered(relative: string, lines: string[], startLine: number, fromLine: number, toLine: number, totalLines: number): string {
  const head = `# ${relative} — lines ${fromLine}–${toLine} of ${totalLines} | LF | utf-8`;
  const body = lines.map((text, i) => `${String(startLine + i).padStart(6, '|')} ${text}`).join('\n');
  return `${head}\n${body}`;
}

async function readSymbolTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { root } = requireWorkspace(ctx);
  void root;
  const filePath = str(args, 'path').trim();
  const symbol = str(args, 'symbol').trim();
  if (!filePath || !symbol) {
    return { ok: false, isError: true, text: 'read_symbol needs "path" and "symbol" (e.g. "getService" or "Class.method").' };
  }
  const resolved = await resolveWithPermission('read_symbol', filePath, ctx);

  let content: string;
  try {
    content = readFileSync(resolved.absolute, 'utf8');
  } catch {
    return { ok: false, isError: true, text: `Cannot read file: ${resolved.relative}.` };
  }
  const contentLines = content.split('\n');
  const maxLines = Math.min(Math.max(num(args, 'maxLines') ?? 400, 20), 1000);

  const ext = path.extname(resolved.absolute).toLowerCase();
  let spans: Array<{ startLine: number; endLine: number; breadcrumb: string; kind: string }> = [];

  if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(ext)) {
    const found = findSymbolSpans(content, path.basename(resolved.absolute), symbol);
    if (found && found.length > 0) spans = found;
  }
  if (spans.length === 0) {
    // Fold fallback: block whose signature mentions the symbol name.
    const folded = foldContent(content, path.basename(resolved.absolute));
    const leaf = symbol.split('.').pop() ?? symbol;
    const flat: Array<{ signature: string; from: number; to: number; depth: number }> = [];
    const flatten = (blocks: import('../fold.js').FoldBlock[]): void => {
      for (const block of blocks) {
        flat.push(block);
        flatten(block.children);
      }
    };
    flatten(folded.blocks);
    for (const block of flat) {
      if (block.signature.includes(leaf)) {
        spans.push({ startLine: block.from, endLine: block.to, breadcrumb: block.signature.trim(), kind: 'block' });
      }
    }
  }

  if (spans.length === 0) {
    return {
      ok: false,
      isError: true,
      text: `Symbol "${symbol}" not found in ${resolved.relative}.${fuzzyHint(resolved.absolute)} Try agent__lsp_symbols mode "symbols" to list the file's symbols.`,
    };
  }

  const includeSignatureOnly = bool(args, 'signatureOnly');
  const sections: string[] = [];
  let receiptFrom = spans[0].startLine;
  let receiptTo = spans[0].endLine;

  for (const span of spans.slice(0, 3)) {
    let from = span.startLine;
    let to = includeSignatureOnly ? Math.min(span.startLine + 2, span.endLine) : span.endLine;
    if (to - from + 1 > maxLines) to = from + maxLines - 1;
    const lines = contentLines.slice(from - 1, to);
    sections.push(
      `── ${span.breadcrumb} (${span.kind}) lines ${span.startLine}–${span.endLine}${to < span.endLine ? ` (showing ${from}–${to})` : ''}`,
    );
    sections.push(formatNumbered(resolved.relative, lines, from, from, to, contentLines.length));
    receiptFrom = Math.min(receiptFrom, from);
    receiptTo = Math.max(receiptTo, to);
  }

  // Read receipt for the covered range — makes the range editable right away.
  try {
    const { statSync } = await import('node:fs');
    recordRead(ctx.sessionId, resolved.absolute, content, statSync(resolved.absolute).mtimeMs, receiptFrom, receiptTo);
  } catch {
    // receipt is best-effort; the read still succeeded
  }
  void getReadEntry;

  const header = `# read_symbol — ${resolved.relative} · "${symbol}" · ${spans.length} match(es)`;
  const footer = spans.length > 3 ? `\n[+${spans.length - 3} more overload/match(es) — narrow the symbol name]` : '\nRange carries a read receipt: edit_file/edit_lines can target it directly.';
  return { ok: true, isError: false, text: truncateOutput(`${header}\n\n${sections.join('\n\n')}${footer}`) };
}

export const readSymbolSpec = defineTool({
  def: {
    wireName: 'agent__read_symbol',
    description: 'Read exactly one symbol\'s line range (AST for TS/JS, fold fallback); returns a read receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to read.' },
        symbol: { type: 'string', description: 'Symbol name, e.g. "getService" or "Class.method".' },
        signatureOnly: { type: 'boolean', description: 'Only the first lines (signature).' },
        maxLines: { type: 'number', description: 'Cap per match (default 400, max 1000).' },
      },
      required: ['path', 'symbol'],
    },
  },
  handler: readSymbolTool,
  readOnly: true,
  category: 'read',
});
