/**
 * agent__read_all — read the WHOLE file and get it FOLDED: a signature tree
 * of every block (VSCode fold-all). One call maps a 3000-line file.
 *
 * agent__read_file — read a numbered slice of a file. Lines render WHOLE (no
 * silent truncation). Three modes: window (default), outline, fold. Supports
 * ranges, single-line, read-if-changed (lastHash), showWhitespace, and
 * continuation tokens (continueFrom). Binary/image files are detected by
 * magic bytes and returned inline as image parts for multimodal models.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext, ToolImage } from './shared.js';
import {
  str, num, bool,
  truncateOutput, whitespaceAnnotation, outlineEntry,
  sniffImageMime,
  resolveWithPermission,
  IMAGE_EXTENSIONS, MAX_IMAGE_READ_BYTES, SNIFF_HEADER_BYTES,
  MAX_READ_BYTES, MAX_OUTPUT_CHARS, OUTLINE_SYMBOL_CAP,
} from './shared.js';
import { foldContent, FOLD_BLOCK_CAP, type FoldBlock } from '../fold.js';
import {
  getReadEntry, hasStructuralRead, markStructuralRead, recordRead,
} from '../read-policy.js';
import { sha256 } from '../edit-diagnostics.js';
import { fuzzyHint } from '../fuzzy.js';
import { noteImageRead } from './vision-policy.js';

/**
 * Shared fold renderer for agent__read_all AND read_file { mode: "fold" } —
 * one source of truth so both spellings always produce identical output.
 */
export function foldModeResult(content: string, relative: string, maxDepthRaw: unknown): HarnessToolResult {
  const result = foldContent(content, relative);
  if (result.scanned === 'none') {
    return {
      ok: true,
      isError: false,
      text:
        `# fold ${relative} — no fold scanner for this file type. ` +
        'Fall back to read_file (window mode).',
    };
  }
  if (!result.balanced) {
    return {
      ok: true,
      isError: false,
      text:
        `# fold ${relative} — no map: braces/quotes did not balance, so the scan would be unreliable. ` +
        'Fall back to read_file (window mode) — or fix the file first if it is actually broken.',
    };
  }
  const rawDepth = typeof maxDepthRaw === 'number' && Number.isFinite(maxDepthRaw) ? maxDepthRaw : undefined;
  const maxDepth = Math.min(Math.max(Math.trunc(rawDepth ?? 2), 1), 8);
  const countBlocks = (list: FoldBlock[]): number => list.reduce((n, x) => n + 1 + countBlocks(x.children), 0);
  const totalBlocks = countBlocks(result.blocks);
  const rows: string[] = [];
  let shown = 0;
  let budgetLeft = MAX_OUTPUT_CHARS - 400;
  let capStopped = false;
  const render = (block: FoldBlock, depth: number): void => {
    if (shown >= FOLD_BLOCK_CAP) { capStopped = true; return; }
    if (budgetLeft <= 0) return;
    if (depth >= maxDepth) {
      rows.push(`${'  '.repeat(depth)}… deeper (lines ${block.from}–${block.to})`);
      shown += 1;
      budgetLeft -= 24;
      return;
    }
    const marker = block.to - block.from + 1;
    const row = `${'  '.repeat(depth)}${block.signature}   ⋯ ${marker} line(s) (${block.from}–${block.to})`;
    rows.push(row);
    shown += 1;
    budgetLeft -= row.length + 1;
    for (const child of block.children) render(child, depth + 1);
  };
  for (const block of result.blocks) render(block, 0);
  if (rows.length === 0) {
    return {
      ok: true,
      isError: false,
      text: `# fold ${relative} — no foldable blocks found (flat file: imports, constants, no {…} blocks). read_file it directly.`,
    };
  }
  const notes: string[] = [];
  if (shown < totalBlocks) {
    notes.push(
      capStopped
        ? `${totalBlocks - shown} more block(s) not shown (cap ${FOLD_BLOCK_CAP}) — narrow with maxDepth`
        : `${totalBlocks - shown} more block(s) not shown (output budget) — narrow with maxDepth`,
    );
  }
  notes.push('fold map only — NOT a read receipt; read_file the block you intend to edit');
  return {
    ok: true,
    isError: false,
    text: truncateOutput(
      `# fold ${relative} — ${shown}/${totalBlocks} block(s), depth ≤ ${maxDepth}\n${rows.join('\n')}` +
        (notes.length > 0 ? `\n[${notes.join(' · ')}]` : ''),
    ),
  };
}

export async function readAllTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const inputPath = str(args, 'path');
  if (!inputPath.trim()) {
    return { ok: false, isError: true, text: 'read_all needs a "path" relative to the workspace root.' };
  }
  const { absolute, relative } = await resolveWithPermission('read_all', inputPath, ctx);

  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return { ok: false, isError: true, text: `No such file: ${relative}${fuzzyHint(absolute)}` };
  }
  if (stats.isDirectory()) {
    return { ok: false, isError: true, text: `"${relative}" is a directory — use list on it instead.` };
  }
  if (stats.size > MAX_READ_BYTES) {
    return {
      ok: false,
      isError: true,
      text: `"${relative}" is ${(stats.size / 1_000_000).toFixed(1)} MB — too large to fold. Use agent__grep with a subpath to find the relevant region.`,
    };
  }

  let content: string;
  try {
    content = readFileSync(absolute, 'utf8');
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Could not read ${relative}: ${error instanceof Error ? error.message : 'read failed'}`,
    };
  }
  if (content.includes('\0')) {
    const ext = path.extname(absolute).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        isError: true,
        text:
          `"${relative}" is an image (binary) — fold mode cannot render it. ` +
          'Call read_file { path: "' + relative + '" } to view it inline (native image input), ' +
          'or agent__vision { path: "' + relative + '" } for a secondhand description (attribute it).',
      };
    }
    return { ok: false, isError: true, text: `"${relative}" looks binary — the text tools cannot read it.` };
  }

  markStructuralRead(ctx.sessionId, absolute);
  return foldModeResult(content, relative, args.maxDepth);
}

export async function readFileTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const inputPath = str(args, 'path');
  if (!inputPath.trim()) {
    return { ok: false, isError: true, text: 'read_file needs a "path" relative to the workspace root.' };
  }
  const { absolute, relative } = await resolveWithPermission('read_file', inputPath, ctx);

  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return { ok: false, isError: true, text: `No such file: ${relative}${fuzzyHint(absolute)}` };
  }
  if (stats.isDirectory()) {
    return { ok: false, isError: true, text: `"${relative}" is a directory — use list on it instead.` };
  }
  if (stats.size > 0 && stats.size <= MAX_IMAGE_READ_BYTES) {
    let header: Buffer;
    try {
      const fd = openSync(absolute, 'r');
      try {
        header = Buffer.alloc(Math.min(SNIFF_HEADER_BYTES, stats.size));
        const read = readSync(fd, header, 0, header.length, 0);
        if (read < header.length) header = header.subarray(0, read);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      return {
        ok: false,
        isError: true,
        text: `Could not read ${relative}: ${error instanceof Error ? error.message : 'read failed'}`,
      };
    }
    const mime = sniffImageMime(header);
    if (mime) {
      let imageBuffer: Buffer;
      try {
        imageBuffer = readFileSync(absolute);
      } catch (error) {
        return {
          ok: false,
          isError: true,
          text: `Could not read ${relative}: ${error instanceof Error ? error.message : 'read failed'}`,
        };
      }
      noteImageRead(ctx.sessionId, absolute);
      const sizeKb = (imageBuffer.length / 1024).toFixed(1);
      return {
        ok: true,
        isError: false,
        text:
          `"${relative}" is an image (${mime}, ${sizeKb} KB). ` +
          'The image itself rides this result as an image part — look at it directly; do NOT delegate to agent__vision. ' +
          'If you perceive no image (text-only model, or a transport that dropped the part), call agent__vision { path: "' +
          relative + '" } as the fallback for a secondhand description (attribute it).',
        images: [{ mime, dataUrl: `data:${mime};base64,${imageBuffer.toString('base64')}` } satisfies ToolImage],
      };
    }
  }
  if (stats.size > MAX_IMAGE_READ_BYTES && IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
    return {
      ok: false,
      isError: true,
      text:
        `"${relative}" is ${(stats.size / 1_000_000).toFixed(1)} MB — too large to view inline (cap 20 MB). ` +
        'Downscale or re-encode it first, or ask the user how to proceed.',
    };
  }
  if (stats.size > MAX_READ_BYTES) {
    return {
      ok: false,
      isError: true,
      text: `"${relative}" is ${(stats.size / 1_000_000).toFixed(1)} MB — too large to read whole. Use agent__grep with a subpath to find the relevant region.`,
    };
  }

  let content: string;
  try {
    content = readFileSync(absolute, 'utf8');
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Could not read ${relative}: ${error instanceof Error ? error.message : 'read failed'}`,
    };
  }
  if (content.includes('\0')) {
    const ext = path.extname(absolute).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        isError: true,
        text:
          `"${relative}" is an image (binary) the text tools cannot render. ` +
          'If you accept image input natively, retry read_file { path: "' + relative + '" } — a valid image returns inline. ' +
          'Otherwise call agent__vision { path: "' + relative + '" } for a secondhand description (attribute it).',
      };
    }
    if (['.pdf', '.docx', '.xlsx', '.pptx', '.zip', '.tar', '.gz', '.rar'].includes(ext)) {
      return {
        ok: false,
        isError: true,
        text: `"${relative}" is a binary document/archive — text tools cannot read it. Use the dedicated route for it or tell the user it needs a text export.`,
      };
    }
    return { ok: false, isError: true, text: `"${relative}" looks binary — the text tools cannot read it.` };
  }

  const lines = content.split('\n');
  const view = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  const eol = content.includes('\r\n') ? 'CRLF' : 'LF';
  const contentHash = sha256(content);
  const showWhitespace = bool(args, 'showWhitespace');

  const mode = str(args, 'mode').trim().toLowerCase();
  if (mode === 'touched') {
    return {
      ok: false, isError: true,
      text:
        'read_file mode "touched" is not a read mode — the session footprint (EDITED/STALE/READ per path) ' +
        'lives on agent__list { mode: "touched" }. agent__read_file returns file content.',
    };
  }

  const lastHash = str(args, 'lastHash').trim();
  if (lastHash) {
    if (lastHash.length < 8) {
      return {
        ok: false, isError: true,
        text: `lastHash must be the sha256 (or at least an 8-char prefix) from a previous read_file footer — got "${lastHash.slice(0, 40)}".`,
      };
    }
    if (contentHash.startsWith(lastHash)) {
      const refreshed = recordRead(ctx.sessionId, absolute, content, stats.mtimeMs, 1, Math.max(view.length, 1));
      return {
        ok: true,
        isError: false,
        text:
          `unchanged — ${relative} still matches sha256:${contentHash.slice(0, 12)} (receipt read#${refreshed?.rev ?? 1} refreshed); ` +
          'the window you already hold stays authoritative. Pass lastHash again to re-check, or drop it to re-render.',
      };
    }
  }

  if (mode === 'outline') {
    markStructuralRead(ctx.sessionId, absolute);
    const symbols: string[] = [];
    let capped = false;
    // F2.4 — AST outline for TS/JS files (arrow functions, object methods,
    // overloads, enums); regex fallback for everything else.
    const ext = path.extname(relative).toLowerCase();
    let usedAst = false;
    if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].includes(ext)) {
      try {
        const { getLanguageService } = await import('../lsp-service.js');
        const { requireWorkspace } = await import('./shared.js');
        const { root } = requireWorkspace(ctx);
        const service = getLanguageService(absolute, root);
        const items = service.getNavigationBarItems(absolute);
        const flatten = (navItems: readonly import('typescript').NavigationBarItem[], indent: string): void => {
          for (const item of navItems) {
            if (symbols.length >= OUTLINE_SYMBOL_CAP) { capped = true; return; }
            let lineNo = 1;
            try {
              const sp = item.spans[0];
              lineNo = content.slice(0, sp.start).split('\n').length;
            } catch { /* keep 1 */ }
            symbols.push(`${String(lineNo).padStart(5)}  ${indent}[${item.kind}] ${item.text}`);
            if (item.childItems && item.childItems.length > 0) flatten(item.childItems, `${indent}  `);
          }
        };
        if (items && items.length > 0) {
          usedAst = true;
          flatten(items, '');
        }
      } catch { /* fall back to regex */ }
    }
    if (!usedAst) {
      for (let index = 0; index < view.length; index += 1) {
        const label = outlineEntry(view[index]);
        if (!label) continue;
        if (symbols.length >= OUTLINE_SYMBOL_CAP) {
          capped = true;
          break;
        }
        symbols.push(`${String(index + 1).padStart(5)}  ${label}`);
      }
    }
    if (symbols.length === 0) {
      return {
        ok: true,
        isError: false,
        text: `# outline ${relative} — no symbols matched (outline knows common function/class/def/type declarations).`,
      };
    }
    return {
      ok: true,
      isError: false,
      text: truncateOutput(
        `# outline ${relative} — ${symbols.length} symbol(s)${usedAst ? ' (AST)' : ''}\n${symbols.join('\n')}` +
          (capped ? `\n…(capped at ${OUTLINE_SYMBOL_CAP} symbols)` : '') +
          `\n[outline only — NOT a read receipt. read_file the regions you intend to edit.]`,
      ),
    };
  }

  if (mode === 'fold') {
    markStructuralRead(ctx.sessionId, absolute);
    return foldModeResult(content, relative, args.maxDepth);
  }

  const singleLine = num(args, 'line');
  if (singleLine !== undefined) {
    const n = Math.min(Math.max(Math.trunc(singleLine), 1), Math.max(view.length, 1));
    const entry = recordRead(ctx.sessionId, absolute, content, stats.mtimeMs, n, n);
    return {
      ok: true,
      isError: false,
      text: truncateOutput(
        `${String(n).padStart(5)}| ${view[n - 1]}${showWhitespace ? whitespaceAnnotation(view[n - 1]) : ''}\n` +
          `[${relative} | line ${n} of ${view.length} | ${eol} | utf-8 | sha256:${contentHash.slice(0, 12)} | read#${entry?.rev ?? 1}]`,
      ),
    };
  }

  const rawRanges = args.ranges;
  if (rawRanges !== undefined) {
    if (!Array.isArray(rawRanges) || rawRanges.length === 0) {
      return { ok: false, isError: true, text: 'ranges must be an array of [from, to] pairs, e.g. [[1, 30], [395, 480]].' };
    }
    if (rawRanges.length > 6) {
      return { ok: false, isError: true, text: 'ranges accepts at most 6 ranges per call — split the exploration.' };
    }
    const parsed: Array<{ from: number; to: number }> = [];
    let totalSpan = 0;
    for (let index = 0; index < rawRanges.length; index += 1) {
      const pair = rawRanges[index] as unknown;
      if (!Array.isArray(pair) || pair.length !== 2) {
        return { ok: false, isError: true, text: `ranges[${index}] must be a [from, to] pair (1-based, inclusive).` };
      }
      const from = typeof pair[0] === 'number' && Number.isFinite(pair[0]) ? Math.trunc(pair[0]) : NaN;
      const to = typeof pair[1] === 'number' && Number.isFinite(pair[1]) ? Math.trunc(pair[1]) : NaN;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) {
        return { ok: false, isError: true, text: `ranges[${index}] = ${JSON.stringify(pair)} is invalid — needs 1 ≤ from ≤ to.` };
      }
      const toCapped = Math.min(to, view.length);
      if (toCapped < from) {
        return { ok: false, isError: true, text: `ranges[${index}] starts past EOF (line ${from} of a ${view.length}-line file).` };
      }
      totalSpan += toCapped - from + 1;
      parsed.push({ from, to: toCapped });
    }
    if (totalSpan > 2000) {
      return { ok: false, isError: true, text: `ranges total ${totalSpan} lines exceeds the 2000-line cap — split across calls.` };
    }
    const header = `# ${relative} — multi-range read of ${view.length}-line file`;
    const slices: string[] = [header];
    let budgetLeft = MAX_OUTPUT_CHARS - header.length - 300;
    let lastFrom = 1;
    let lastTo = 1;
    let lastRev = 1;
    for (const range of parsed) {
      const label = `── lines ${range.from}–${range.to}`;
      slices.push(label);
      budgetLeft -= label.length + 1;
      for (let n = range.from; n <= range.to; n += 1) {
        const row = `${String(n).padStart(5)}| ${view[n - 1]}${showWhitespace ? whitespaceAnnotation(view[n - 1]) : ''}`;
        if (row.length + 1 > budgetLeft) {
          slices.push('   …(stopped at the output budget — narrow the ranges or continue with offsetLine)');
          budgetLeft = -1;
          break;
        }
        slices.push(row);
        budgetLeft -= row.length + 1;
      }
      const receipt = recordRead(ctx.sessionId, absolute, content, stats.mtimeMs, range.from, range.to);
      lastFrom = range.from;
      lastTo = range.to;
      lastRev = receipt?.rev ?? 1;
      if (budgetLeft < 0) break;
    }
    slices.push(
      `[${relative} | ranges ${parsed.map((r) => `${r.from}–${r.to}`).join(', ')} of ${view.length} | ${eol} | utf-8 | ` +
        `sha256:${contentHash.slice(0, 12)} | read#${lastRev} retained for lines ${lastFrom}–${lastTo}]`,
    );
    return { ok: true, isError: false, text: truncateOutput(slices.join('\n')) };
  }

  const offsetLine = Math.min(Math.max(num(args, 'offsetLine') ?? 1, 1), Math.max(view.length, 1));
  const maxLines = Math.min(Math.max(num(args, 'maxLines') ?? 400, 1), 1000);
  const continueFrom = str(args, 'continueFrom').trim();
  let startLine = offsetLine;
  let windowMax = maxLines;
  if (continueFrom) {
    const token = /^r:(\d+):(\d+)$/.exec(continueFrom);
    if (!token) {
      return {
        ok: false, isError: true,
        text:
          `Unknown continueFrom token — pass the opaque "next" value from the previous read_file footer verbatim ` +
          `(expected shape r:<offsetLine>:<maxLines>, got "${continueFrom.slice(0, 60)}").`,
      };
    }
    startLine = Math.min(Math.max(Number(token[1]), 1), Math.max(view.length, 1));
    windowMax = Math.min(Math.max(Number(token[2]), 1), 1000);
  }
  const priorEntry = getReadEntry(ctx.sessionId, absolute);
  const editedTag = priorEntry?.lastOp === 'write' ? ' · edited' : '';

  const plannedEnd = Math.min(startLine - 1 + windowMax, view.length);
  const plannedNext = plannedEnd < view.length ? `r:${plannedEnd + 1}:${windowMax}` : null;
  const footer =
    `[${relative} | lines ${startLine}–${plannedEnd} of ${view.length} | ${eol} | utf-8 | sha256:${contentHash.slice(0, 12)}]` +
    (plannedNext ? `\n[next: "${plannedNext}"]` : '');

  const header = `# ${relative} — lines ${startLine}–${plannedEnd} of ${view.length}${editedTag}`;

  const rendered: string[] = [];
  let endLine = startLine - 1;
  let budgetLeft = MAX_OUTPUT_CHARS - header.length - footer.length - 400;
  let budgetStopped = false;
  for (let index = startLine - 1; index < plannedEnd; index += 1) {
    const numbered = `${String(index + 1).padStart(5)}| ${view[index]}${showWhitespace ? whitespaceAnnotation(view[index]) : ''}`;
    if (numbered.length + 1 > budgetLeft) {
      budgetStopped = true;
      break;
    }
    rendered.push(numbered);
    budgetLeft -= numbered.length + 1;
    endLine = index + 1;
  }

  const slices: string[] = [header, rendered.join('\n')];
  const notes: string[] = [];
  if (endLine < view.length) {
    const nextToken = plannedNext;
    if (budgetStopped) {
      notes.push(`window stopped at the output budget after line ${endLine} — continueFrom: "${nextToken}" (or offsetLine: ${endLine + 1})`);
    } else {
      notes.push(`(${view.length - endLine} more lines — continueFrom: "${nextToken}" or offsetLine: ${endLine + 1})`);
    }
  }
  recordRead(ctx.sessionId, absolute, content, stats.mtimeMs, startLine, endLine);
  if (startLine === 1 && plannedEnd < view.length && !hasStructuralRead(ctx.sessionId, absolute)) {
    notes.unshift(
      `fold-first hint: ${view.length} lines, not mapped this session — call agent__read_all ` +
        `(or read_file mode: "fold") to get the signature tree, then read_file only the block you need.`,
    );
  }
  slices.push(footer);
  if (notes.length > 0) slices.push(notes.join(' · '));

  return { ok: true, isError: false, text: truncateOutput(slices.join('\n')) };
}
