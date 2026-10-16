/**
 * Shared internals for the split edit-tool family. Every edit tool
 * (edit_file / multi_edit / edit_lines / edit_between / insert_at_line) loads
 * its target through `loadEditable` and lands its result through `finishEdit`
 * (or `replaceLineRange` for line-range surgery), so the safety posture stays
 * IDENTICAL across all five: read-before-edit, optimistic concurrency
 * (expectedReadHash), read-range enforcement, EOL preservation, vault
 * snapshot, and a syntax guard that rolls back broken writes.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { MAX_EDIT_BYTES, resolveWithPermission } from './shared.js';
import { buildUnifiedDiff, diffStatFromOps } from '../diff.js';
import { snapshotFile, restoreSnapshot } from '../vault.js';
import {
  recordAfterWrite, hasCurrentRead, readRequiredMessage, staleReadMessage,
  getReadEntry, outOfRangeLinesMessage,
  shiftIntervalsForEdit, isRangeCoveredByReadEntry,
} from '../read-policy.js';
import { fuzzyHint } from '../fuzzy.js';
import { sha256 } from '../edit-diagnostics.js';

export interface EditTarget {
  absolute: string;
  relative: string;
  exists: boolean;
}

/** Resolve the `path` argument against the workspace root (write intent) and
 *  stat whether a regular file already sits there. */
export async function resolveWriteTarget(
  toolName: string,
  rawPath: string,
  ctx: AgentToolContext,
): Promise<{ ok: true; target: EditTarget } | { ok: false; result: HarnessToolResult }> {
  if (!rawPath.trim()) {
    return { ok: false, result: { ok: false, isError: true, text: `${toolName} needs a "path" relative to the workspace root.` } };
  }
  const { absolute, relative } = await resolveWithPermission(toolName, rawPath, ctx, 'write');
  let exists = false;
  try {
    exists = statSync(absolute).isFile();
  } catch {
    exists = false;
  }
  return { ok: true, target: { absolute, relative, exists } };
}

export interface LoadedFile {
  content: string;
  currentMtime: number;
  readEntry: ReturnType<typeof getReadEntry>;
}

/**
 * THE READ-BEFORE-EDIT GATE. Applies to every edit tool: size cap, a current
 * read in this session (mtime + hash + gRev), and the optimistic-concurrency
 * hash guard. Returns the loaded content on success or the refusal text.
 */
export function loadEditable(
  target: EditTarget,
  ctx: AgentToolContext,
  toolLabel: string,
  expectedReadHash: string,
): { ok: true; data: LoadedFile } | { ok: false; result: HarnessToolResult } {
  const { absolute, relative } = target;
  let content: string;
  let currentMtime: number;
  try {
    const st = statSync(absolute);
    if (st.size > MAX_EDIT_BYTES) {
      return { ok: false, result: { ok: false, isError: true, text: `"${relative}" is too large for ${toolLabel} (> 5 MB).` } };
    }
    content = readFileSync(absolute, 'utf8');
    currentMtime = st.mtimeMs;
  } catch (error) {
    return { ok: false, result: { ok: false, isError: true, text: `Could not read ${relative}: ${error instanceof Error ? error.message : 'read failed'}` } };
  }
  const readEntry = getReadEntry(ctx.sessionId, absolute);
  if (!hasCurrentRead(ctx.sessionId, absolute, content, currentMtime)) {
    return {
      ok: false,
      result: {
        ok: false, isError: true,
        text: readEntry ? staleReadMessage(relative, readEntry.rev) : readRequiredMessage(relative),
      },
    };
  }
  const hashError = hashGuardError(content, expectedReadHash, relative);
  if (hashError) return { ok: false, result: { ok: false, isError: true, text: hashError } };
  return { ok: true, data: { content, currentMtime, readEntry } };
}

/**
 * Normalizes a hash the model supplied: strips the optional `sha256:`
 * prefix (the read_file footer prints `sha256:<hex>`, and models copy
 * that string verbatim into expectedReadHash/lastHash) and lowercases.
 */
export function normalizeHashInput(raw: string): string {
  return raw.trim().replace(/^sha256:/i, '').toLowerCase();
}

/**
 * Shared optimistic-concurrency check; returns the refusal text or null.
 */
export function hashGuardError(content: string, expectedReadHash: string, relative: string): string | null {
  const cleaned = normalizeHashInput(expectedReadHash);
  if (!cleaned) return null;
  const actualHash = sha256(content).toLowerCase();
  if (actualHash === cleaned || (cleaned.length < 64 && actualHash.startsWith(cleaned))) return null;
  return (
    `expectedReadHash mismatch: the file changed since the read you anchored on. ` +
    `on-disk sha256:${actualHash.slice(0, 12)} vs your expected sha256:${cleaned.slice(0, 12)}. ` +
    `Next step: agent__read_file path="${relative}" — refresh, then retry with the new hash.`
  );
}

export interface EditBounds {
  changed: boolean;
  /** 1-based first line of the changed span. */
  startLine: number;
  oldSpanLines: number;
  newSpanLines: number;
  deltaLines: number;
  beforeTotalLines: number;
  afterTotalLines: number;
}

/**
 * Pemindaian O(N) dua arah (prefix & suffix) untuk menemukan batas baris
 * perubahan secara eksak: baris identik dari ATAS dan dari BAWAH dilompati,
 * sisa di tengah = span lama → span baru. Menggantikan peta geser satu
 * arah (first-divergence + total delta) yang kabur untuk edit di tengah/akhir file.
 */
export function computeEditBounds(before: string, after: string): EditBounds {
  const trimPhantom = (raw: string[]) =>
    raw.length > 1 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
  const beforeLines = trimPhantom(before.replace(/\r\n/g, '\n').split('\n'));
  const afterLines = trimPhantom(after.replace(/\r\n/g, '\n').split('\n'));

  if (before === after) {
    return {
      changed: false,
      startLine: 1,
      oldSpanLines: 0,
      newSpanLines: 0,
      deltaLines: 0,
      beforeTotalLines: beforeLines.length,
      afterTotalLines: afterLines.length,
    };
  }

  const minLen = Math.min(beforeLines.length, afterLines.length);
  let prefix = 0;
  while (prefix < minLen && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const startLine = prefix + 1;
  return {
    changed: true,
    startLine,
    oldSpanLines: Math.max(0, beforeLines.length - prefix - suffix),
    newSpanLines: Math.max(0, afterLines.length - prefix - suffix),
    deltaLines: afterLines.length - beforeLines.length,
    beforeTotalLines: beforeLines.length,
    afterTotalLines: afterLines.length,
  };
}

/**
 * Membangun ringkasan pergeseran baris + Context Echo: map geser baris
 * (≥ first-changed line moved by ±delta) plus ±4 baris konteks di sekitar
 * area yang baru diedit dengan nomor baris BARU — model tak perlu read_file
 * ulang hanya untuk men-anchor edit lanjutan.
 */
function buildPostEditSummary(afterContent: string, bounds: EditBounds, newHash: string): string {
  if (!bounds.changed) return '';
  const sign = bounds.deltaLines > 0 ? '+' : '';
  const shiftHeader =
    bounds.deltaLines === 0
      ? ` Line numbers stay aligned (line ${bounds.startLine} changed; ${bounds.afterTotalLines} lines, sha256:${newHash.slice(0, 12)}).`
      : ` Line-shift map: line numbers ≥ ${bounds.startLine + bounds.oldSpanLines} moved by ${sign}${bounds.deltaLines} ` +
        `(${bounds.beforeTotalLines} → ${bounds.afterTotalLines} lines, new sha256:${newHash.slice(0, 12)}).`;

  const rawLines = afterContent.replace(/\r\n/g, '\n').split('\n');
  const view = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
  const pad = 4;
  const echoFrom = Math.max(1, bounds.startLine - pad);
  const maxEditedLinesShown = Math.min(bounds.newSpanLines, 12);
  const echoTo = Math.min(view.length, bounds.startLine + Math.max(maxEditedLinesShown, 1) - 1 + pad);

  const rows: string[] = [];
  for (let ln = echoFrom; ln <= echoTo; ln += 1) {
    const inEdited = ln >= bounds.startLine && ln < bounds.startLine + bounds.newSpanLines;
    rows.push(`${inEdited ? '>' : ' '}${String(ln).padStart(5)}| ${view[ln - 1] ?? ''}`);
  }
  if (bounds.newSpanLines > maxEditedLinesShown) {
    rows.push(`  … (${bounds.newSpanLines - maxEditedLinesShown} more modified line(s) in this block)`);
  }

  return `${shiftHeader}\n── post-edit context (lines ${echoFrom}–${echoTo}) ──\n${rows.join('\n')}`;
}

/**
 * Shared write-or-preview tail: snapshots, writes (unless dryRun), records the
 * new read state, and returns the diff. `toolName` names the tool in the
 * dryRun / success messages.
 */
export async function finishEdit(
  ctx: AgentToolContext,
  absolute: string,
  relative: string,
  originalRaw: string,
  nextEffective: string,
  normalized: boolean,
  replaced: number,
  dryRun: boolean,
  verifySyntax: boolean,
  toolName: string,
  note = '',
): Promise<HarnessToolResult> {
  const nextContent = normalized
    ? nextEffective.replace(/\r/g, '').replace(/\n/g, '\r\n')
    : nextEffective;
  const bounds = computeEditBounds(originalRaw, nextContent);
  const newHash = sha256(nextContent).toLowerCase();
  const shiftNote = buildPostEditSummary(nextContent, bounds, newHash);

  if (dryRun) {
    return {
      ok: true,
      isError: false,
      text:
        `dryRun -- NO changes written. Review the diff and call ${toolName} again ` +
        `with dryRun: false to apply (optionally passing expectedReadHash from your ` +
        `read_file footer for a race-safe preview-then-apply).` +
        (normalized ? ' (matched after CRLF to LF normalization; file EOLs preserved.)' : '') +
        note +
        (shiftNote ?? ''),
      diff: buildUnifiedDiff(originalRaw, nextContent, relative),
      diffstat: diffStatFromOps(originalRaw, nextContent),
    };
  }

  const snap = snapshotFile(ctx.sessionId, absolute, toolName);
  try {
    writeFileSync(absolute, nextContent, 'utf8');
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Could not write ${relative}: ${error instanceof Error ? error.message : 'write failed'}`,
    };
  }

  if (verifySyntax) {
    const probe = await verifyWrittenSyntax(absolute, nextContent);
    if (probe.failed) {
      const snapshotId = snap.entry?.id;
      if (snapshotId) {
        try {
          restoreSnapshot(ctx.sessionId, snapshotId);
          const restored = readFileSync(absolute, 'utf8');
          recordAfterWrite(ctx.sessionId, absolute, restored, statSync(absolute).mtimeMs);
          return {
            ok: false,
            isError: true,
            text:
              `SYNTAX GUARD — edit rolled back: ${probe.failed} ` +
              `The file was restored to snapshot ${snapshotId}; nothing is broken on disk. ` +
              'Next step: re-read the file and craft an edit that keeps it parseable.',
          };
        } catch (restoreError) {
          return {
            ok: false,
            isError: true,
            text:
              `SYNTAX GUARD: ${probe.failed} — AND the rollback failed ` +
              `(${restoreError instanceof Error ? restoreError.message : 'unknown'}). ` +
              `Inspect the file with read_file; vault snapshot id ${snapshotId}.`,
          };
        }
      }
      return {
        ok: false,
        isError: true,
        text: `SYNTAX GUARD: ${probe.failed} — no vault snapshot available to roll back; inspect the file now.`,
      };
    }
  }
  let postMtime = 0;
  try {
    postMtime = statSync(absolute).mtimeMs;
  } catch {
    postMtime = Date.now();
  }
  let shiftedIntervals: import('../read-policy.js').LineInterval[] | undefined;
  if (!bounds.changed) {
    shiftedIntervals = undefined;
  } else {
    const priorRead = getReadEntry(ctx.sessionId, absolute);
    shiftedIntervals =
      priorRead && priorRead.toLine < Number.MAX_SAFE_INTEGER
        ? shiftIntervalsForEdit(
            priorRead.intervals,
            priorRead.fromLine,
            priorRead.toLine,
            bounds.startLine,
            bounds.oldSpanLines,
            bounds.newSpanLines,
          )
        : undefined;
  }
  recordAfterWrite(ctx.sessionId, absolute, nextContent, postMtime, undefined, shiftedIntervals);
  return {
    ok: true,
    isError: false,
    text:
      `Edited ${relative}: ${replaced} replacement(s); file is now ${Buffer.byteLength(nextContent, 'utf8')} bytes.` +
      (normalized ? ' (matched after CRLF to LF normalization; file EOLs preserved.)' : '') +
      note +
      (shiftNote ?? '') +
      (snap.entry ? ` Previous version snapshotted (${snap.entry.id}).` : ''),
    diff: buildUnifiedDiff(originalRaw, nextContent, relative),
    diffstat: diffStatFromOps(originalRaw, nextContent),
  };
}

/**
 * LINE-RANGE EDIT with read-receipt enforcement: replaces lines from..to
 * with newString. The range MUST lie inside the window the model actually
 * read on the current revision — no blind line surgery. Shared by edit_lines
 * (direct) and edit_between (which resolves its anchors to a range first).
 */
export async function replaceLineRange(
  target: EditTarget,
  ctx: AgentToolContext,
  opts: {
    range: { from: number; to: number };
    dryRun: boolean;
    expectedReadHash: string;
    preserveEol: boolean;
    verifySyntax: boolean;
    newString: string;
    toolName: string;
    /** Result an anchor tool already loaded — avoids a double disk read. */
    preloaded?: LoadedFile;
    note?: string;
  },
): Promise<HarnessToolResult> {
  const { absolute, relative, exists } = target;
  if (!exists) {
    return { ok: false, isError: true, text: `No such file: ${relative}${fuzzyHint(absolute)} — ${opts.toolName} edits an existing file.` };
  }
  const loaded = opts.preloaded
    ? { ok: true as const, data: opts.preloaded }
    : loadEditable(target, ctx, opts.toolName, opts.expectedReadHash);
  if (!loaded.ok) return loaded.result;
  const content = loaded.data.content;
  const readEntry = loaded.data.readEntry;

  const crlf = content.includes('\r\n');
  const base = crlf ? content.replace(/\r\n/g, '\n') : content;
  const rawLines = base.split('\n');
  const view = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;

  if (readEntry && readEntry.toLine < Number.MAX_SAFE_INTEGER) {
    if (!isRangeCoveredByReadEntry(readEntry, opts.range.from, opts.range.to)) {
      return {
        ok: false, isError: true,
        text: outOfRangeLinesMessage(relative, opts.range.from, opts.range.to, readEntry.fromLine, readEntry.toLine, readEntry),
      };
    }
  }
  if (opts.range.to > view.length) {
    return {
      ok: false, isError: true,
      text: `edit range ends at line ${opts.range.to}, but "${relative}" has ${view.length} line(s). Re-read the tail if it grew.`,
    };
  }

  // No-op guard: replacing a range with the text it already holds is a bug,
  const existingSlice = view.slice(opts.range.from - 1, opts.range.to).join('\n');
  const normalizedNew = opts.newString.replace(/\r/g, '');
  if (existingSlice === normalizedNew) {
    return {
      ok: false,
      isError: true,
      text: `${opts.toolName} is a guaranteed no-op: lines ${opts.range.from}–${opts.range.to} already equal "newString".`,
    };
  }

  const newLines = opts.newString === '' ? [] : opts.newString.replace(/\r/g, '').split('\n');
  let next = [...view.slice(0, opts.range.from - 1), ...newLines, ...view.slice(opts.range.to)].join('\n');
  if (base.endsWith('\n') && !next.endsWith('\n')) next += '\n';
  if (crlf) next = next.replace(/\n/g, '\r\n');

  return finishEdit(
    ctx, absolute, relative, content, next, false,
    opts.range.to - opts.range.from + 1, opts.dryRun, opts.verifySyntax, opts.toolName,
    opts.note ?? ` Replaced lines ${opts.range.from}–${opts.range.to} via ${opts.toolName}.`,
  );
}

/**
 * SYNTAX GUARD probe for freshly written files. JSON parses in-process;
 * the full TS/JS family (.ts/.tsx/.mts/.cts/.jsx/.js/.mjs/.cjs) is validated
 * in-process with the TypeScript Compiler API (F1.6 — no spawn) and reports
 * the offending line + code snippet; .css gets a light brace/comment balance
 * heuristic. Anything unverifiable (other extensions) is SKIPPED — the guard
 * never false-fails an edit.
 */
export async function verifyWrittenSyntax(
  absolute: string,
  nextContent: string,
): Promise<{ failed?: string }> {
  const ext = path.extname(absolute).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(nextContent);
    } catch (error) {
      return { failed: `invalid JSON (${error instanceof Error ? error.message : 'parse error'}).` };
    }
    return {};
  }
  if (['.ts', '.tsx', '.mts', '.cts', '.jsx', '.js', '.mjs', '.cjs'].includes(ext)) {
    try {
      const isJsx = ext === '.tsx' || ext === '.jsx';
      const isJs = ext === '.js' || ext === '.mjs' || ext === '.cjs' || isJsx;
      const compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        allowJs: isJs,
      };
      if (isJsx) compilerOptions.jsx = ts.JsxEmit.Preserve;

      const result = ts.transpileModule(nextContent, {
        reportDiagnostics: true,
        fileName: path.basename(absolute),
        compilerOptions,
      });
      const diags = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
      if (diags.length > 0) {
        const lines = nextContent.replace(/\r\n/g, '\n').split('\n');
        const first = diags.slice(0, 3).map((d) => {
          if (d.file && d.start !== undefined) {
            const lc = d.file.getLineAndCharacterOfPosition(d.start);
            const lineNo = lc.line + 1;
            const colNo = lc.character + 1;
            const codeSnippet = (lines[lineNo - 1] ?? '').trim().slice(0, 80);
            return `L${lineNo}:${colNo} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')} (at: \`${codeSnippet}\`)`;
          }
          return ts.flattenDiagnosticMessageText(d.messageText, ' ');
        });
        return { failed: `syntax error(s): ${first.join(' | ')}.` };
      }
      return {};
    } catch {
      return {};
    }
  }
  if (ext === '.css') {
    try {
      let depth = 0;
      let i = 0;
      let inComment = false;
      let inString: string | null = null;
      while (i < nextContent.length) {
        const ch = nextContent[i];
        if (inComment) {
          if (ch === '*' && nextContent[i + 1] === '/') { inComment = false; i += 2; continue; }
          i += 1; continue;
        }
        if (inString) {
          if (ch === '\\') { i += 2; continue; }
          if (ch === inString) inString = null;
          i += 1; continue;
        }
        if (ch === '/' && nextContent[i + 1] === '*') { inComment = true; i += 2; continue; }
        if (ch === '"' || ch === "'") { inString = ch; i += 1; continue; }
        if (ch === '{') depth += 1;
        if (ch === '}') depth -= 1;
        if (depth < 0) return { failed: 'syntax error: unbalanced "}" (extra closing brace).' };
        i += 1;
      }
      if (inComment) return { failed: 'syntax error: unterminated /* comment.' };
      if (depth !== 0) return { failed: `syntax error: ${depth} unclosed "{".` };
      return {};
    } catch {
      return {};
    }
  }
  return {};
}