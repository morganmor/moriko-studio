/**
 * F2.1 — agent__read_symbol: read EXACTLY one symbol's line range (AST-driven
 * for TS/JS, fold-based fallback for other languages), with an exact per-span
 * read receipt and sha256 footer so the range can be edited directly.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolContext, HarnessToolResult } from './shared.js';
import { str, num, bool, truncateOutput, requireWorkspace, resolveWithPermission, whitespaceAnnotation } from './shared.js';
import { findSymbolSpans } from '../ts-ast.js';
import { foldContent } from '../fold.js';
import { fuzzyHint } from '../fuzzy.js';
import { recordRead, markStructuralRead } from '../read-policy.js';
import { sha256 } from '../edit-diagnostics.js';
import { defineTool } from './registry.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatNumbered(
  relative: string,
  lines: string[],
  startLine: number,
  fromLine: number,
  toLine: number,
  totalLines: number,
  eol: 'LF' | 'CRLF',
  showWhitespace: boolean,
): string {
  const head = `# ${relative} — lines ${fromLine}–${toLine} of ${totalLines} | ${eol} | utf-8`;
  const body = lines
    .map((text, i) => `${String(startLine + i).padStart(5)}| ${text}${showWhitespace ? whitespaceAnnotation(text) : ''}`)
    .join('\n');
  return `${head}\n${body}`;
}

async function readSymbolTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  requireWorkspace(ctx);
  const filePath = str(args, 'path').trim();
  const symbol = str(args, 'symbol').trim();
  if (!filePath || !symbol) {
    return { ok: false, isError: true, text: 'read_symbol needs "path" and "symbol" (e.g. "getService" or "Class.method").' };
  }
  const resolved = await resolveWithPermission('read_symbol', filePath, ctx);

  let content: string;
  let mtimeMs = 0;
  try {
    const st = statSync(resolved.absolute);
    mtimeMs = st.mtimeMs;
    content = readFileSync(resolved.absolute, 'utf8');
  } catch {
    return { ok: false, isError: true, text: `Cannot read file: ${resolved.relative}.${fuzzyHint(resolved.absolute)}` };
  }

  const eol: 'LF' | 'CRLF' = content.includes('\r\n') ? 'CRLF' : 'LF';
  const contentHash = sha256(content);
  const rawLines = content.replace(/\r\n/g, '\n').split('\n');
  const contentLines = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
  const maxLines = Math.min(Math.max(num(args, 'maxLines') ?? 400, 20), 1000);
  const showWhitespace = bool(args, 'showWhitespace');

  const ext = path.extname(resolved.absolute).toLowerCase();
  let spans: Array<{ startLine: number; endLine: number; breadcrumb: string; kind: string }> = [];

  if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(ext)) {
    const found = findSymbolSpans(content, path.basename(resolved.absolute), symbol);
    if (found && found.length > 0) spans = found;
  }
  if (spans.length === 0) {
    const folded = foldContent(content, path.basename(resolved.absolute));
    const leaf = (symbol.split('.').pop() ?? symbol).trim();
    const wordRegex = new RegExp(`\\b${escapeRegExp(leaf)}\\b`);
    const flat: Array<{ signature: string; from: number; to: number }> = [];
    const flatten = (blocks: import('../fold.js').FoldBlock[]): void => {
      for (const block of blocks) {
        flat.push(block);
        flatten(block.children);
      }
    };
    flatten(folded.blocks);
    for (const block of flat) {
      if (wordRegex.test(block.signature)) {
        spans.push({ startLine: block.from, endLine: block.to, breadcrumb: block.signature.trim(), kind: 'block' });
      }
    }
  }

  if (spans.length === 0) {
    return {
      ok: false,
      isError: true,
      text: `Symbol "${symbol}" not found in ${resolved.relative}.${fuzzyHint(resolved.absolute)} Try agent__read_file with mode: "outline" or mode: "fold" to list the file's symbols.`,
    };
  }

  const includeSignatureOnly = bool(args, 'signatureOnly');
  const includeComments = args.includeComments === undefined ? true : bool(args, 'includeComments');
  const sections: string[] = [];
  const recordedSpans: Array<{ from: number; to: number }> = [];
  let lastRev = 1;

  for (const span of spans.slice(0, 3)) {
    let from = span.startLine;
    if (includeComments && !includeSignatureOnly) {
      while (from > 1) {
        const prev = (contentLines[from - 2] ?? '').trim();
        if (prev.startsWith('/**') || prev.startsWith('*') || prev.startsWith('//') || prev.startsWith('@')) {
          from -= 1;
        } else {
          break;
        }
      }
    }
    let to = includeSignatureOnly ? Math.min(span.startLine + 2, span.endLine) : span.endLine;
    if (to - from + 1 > maxLines) to = from + maxLines - 1;
    to = Math.min(to, contentLines.length);

    const lines = contentLines.slice(from - 1, to);
    sections.push(
      `── ${span.breadcrumb} (${span.kind}) lines ${from}–${span.endLine}${to < span.endLine ? ` (showing ${from}–${to})` : ''}`,
    );
    sections.push(formatNumbered(resolved.relative, lines, from, from, to, contentLines.length, eol, showWhitespace));

    if (!includeSignatureOnly) {
      try {
        const entry = recordRead(ctx.sessionId, resolved.absolute, content, mtimeMs, from, to);
        lastRev = entry?.rev ?? lastRev;
        recordedSpans.push({ from, to });
      } catch {
      }
    }
  }

  if (includeSignatureOnly) {
    markStructuralRead(ctx.sessionId, resolved.absolute);
  }

  const header = `# read_symbol — ${resolved.relative} · "${symbol}" · ${spans.length} match(es)`;
  const receiptSummary = includeSignatureOnly
    ? ` [${resolved.relative} | signatureOnly — NOT a read receipt; re-run without signatureOnly before editing | sha256:${contentHash.slice(0, 12)}]`
    : ` [${resolved.relative} | read receipt recorded for lines ${recordedSpans.map((s) => `${s.from}–${s.to}`).join(', ')} of ${contentLines.length} | ${eol} | utf-8 | sha256:${contentHash.slice(0, 12)} | read#${lastRev}]`;
  const overflowNote = spans.length > 3 ? `\n[+${spans.length - 3} more overload/match(es) — narrow the symbol name]` : '';

  return {
    ok: true,
    isError: false,
    text: truncateOutput(`${header}\n\n${sections.join('\n\n')}\n${receiptSummary}${overflowNote}`),
  };
}

export const readSymbolSpec = defineTool({
  def: {
    wireName: 'agent__read_symbol',
    description: 'Read exactly one symbol\'s line range (AST for TS/JS, fold fallback); returns a read receipt and sha256 hash.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to read.' },
        symbol: { type: 'string', description: 'Symbol name, e.g. "getService" or "Class.method".' },
        signatureOnly: { type: 'boolean', description: 'Only the first lines (signature). Does not grant an edit receipt.' },
        includeComments: { type: 'boolean', description: 'Include leading JSDoc/decorators above the symbol (default true).' },
        showWhitespace: { type: 'boolean', description: 'Annotate trailing spaces and tabs.' },
        maxLines: { type: 'number', description: 'Cap per match (default 400, max 1000).' },
      },
      required: ['path', 'symbol'],
    },
  },
  handler: readSymbolTool,
  readOnly: true,
  category: 'read',
});
