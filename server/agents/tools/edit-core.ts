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
import { runProcess } from '../exec.js';
import {
  recordAfterWrite, hasCurrentRead, readRequiredMessage, staleReadMessage,
  getReadEntry, outOfRangeLinesMessage,
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
 * Shared optimistic-concurrency check; returns the refusal text or null.
 */
export function hashGuardError(content: string, expectedReadHash: string, relative: string): string | null {
  if (!expectedReadHash) return null;
  const actualHash = sha256(content);
  const expected = expectedReadHash.length >= 64 ? expectedReadHash : expectedReadHash.padEnd(64, '0');
  if (actualHash === expected || actualHash.startsWith(expectedReadHash)) return null;
  return (
    `expectedReadHash mismatch: the file changed since the read you anchored on. ` +
    `on-disk sha256:${actualHash.slice(0, 12)}... vs your expected ${expectedReadHash.slice(0, 12)}.... ` +
    `Next step: agent__read_file path="${relative}" -- refresh, then retry with the new hash.`
  );
}

/**
 * LINE-SHIFT MAP for the edit receipt. After an edit that adds/removes
 * lines, every line number the model holds from before the edit is stale
 * past the first changed line. A cheap O(n) scan (no LCS): first divergence
 * + total line delta is enough to say which numbers moved.
 */
function lineShiftMap(before: string, after: string): string | null {
  if (before === after) return null;
  const trimPhantom = (raw: string[]) => (raw.length > 1 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw);
  const beforeLines = trimPhantom(before.split('\n'));
  const afterLines = trimPhantom(after.split('\n'));
  const limit = Math.min(beforeLines.length, afterLines.length);
  let first = 0;
  while (first < limit && beforeLines[first] === afterLines[first]) first += 1;
  if (first === limit && beforeLines.length === afterLines.length) return null;
  const delta = afterLines.length - beforeLines.length;
  const at = first + 1;
  if (delta === 0) {
    return ` Line numbers stay aligned (line count unchanged) but line ${at} changed — verify anchors past line ${at} before reusing them.`;
  }
  const sign = delta > 0 ? '+' : '';
  return (
    ` Line-shift map: line numbers ≥ ${at} moved by ${sign}${delta} ` +
    `(file went ${beforeLines.length} → ${afterLines.length} lines) — re-anchor with read_file before trusting old line numbers.`
  );
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
  const shiftNote = lineShiftMap(originalRaw, nextContent);

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
  recordAfterWrite(ctx.sessionId, absolute, nextContent, postMtime);
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
    note?: string;
  },
): Promise<HarnessToolResult> {
  const { absolute, relative, exists } = target;
  if (!exists) {
    return { ok: false, isError: true, text: `No such file: ${relative}${fuzzyHint(absolute)} — ${opts.toolName} edits an existing file.` };
  }
  const loaded = loadEditable(target, ctx, opts.toolName, opts.expectedReadHash);
  if (!loaded.ok) return loaded.result;
  const content = loaded.data.content;
  const readEntry = loaded.data.readEntry;

  const crlf = content.includes('\r\n');
  const base = crlf ? content.replace(/\r\n/g, '\n') : content;
  const rawLines = base.split('\n');
  const view = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;

  if (readEntry && readEntry.toLine < Number.MAX_SAFE_INTEGER) {
    if (opts.range.from < readEntry.fromLine || opts.range.to > readEntry.toLine) {
      return {
        ok: false, isError: true,
        text: outOfRangeLinesMessage(relative, opts.range.from, opts.range.to, readEntry.fromLine, readEntry.toLine),
      };
    }
  }
  if (opts.range.to > view.length) {
    return {
      ok: false, isError: true,
      text: `edit range ends at line ${opts.range.to}, but "${relative}" has ${view.length} line(s). Re-read the tail if it grew.`,
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
 * .js/.mjs/.cjs go through `node --check`; .ts/.tsx/.mts/.cts/.jsx are
 * validated with the TypeScript Compiler API in-process (F1.6); .css gets a
 * light brace/comment balance heuristic. Anything unverifiable (other
 * extensions, or an environment that cannot spawn) is SKIPPED — the guard
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
  // F1.6 — TS/JSX family: ts.transpileModule diagnostics, no spawn.
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts' || ext === '.jsx') {
    try {
      const kind = ext === '.tsx' || ext === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const result = ts.transpileModule(nextContent, {
        reportDiagnostics: true,
        fileName: path.basename(absolute),
        compilerOptions: {
          jsx: kind === ts.ScriptKind.TSX ? ts.JsxEmit.Preserve : ts.JsxEmit.None,
          target: ts.ScriptTarget.ES2022,
        },
      });
      const diags = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
      if (diags.length > 0) {
        const first = diags.slice(0, 3).map((d) => {
          const pos = d.file && d.start !== undefined
            ? `${d.file.getLineAndCharacterOfPosition(d.start).line + 1}:${d.file.getLineAndCharacterOfPosition(d.start).character + 1}`
            : '?';
          return `${pos} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
        });
        return { failed: `syntax error(s): ${first.join(' | ')}.` };
      }
      return {};
    } catch {
      return {}; // internal error → never false-fail
    }
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    try {
      const outcome = await runProcess(process.execPath, ['--check', absolute], {
        cwd: path.dirname(absolute),
        timeoutMs: 15_000,
      });
      if (outcome.exitCode === 0) return {};
      if (outcome.exitCode === null) return {};
      return { failed: `node --check rejected the file (${outcome.output.slice(0, 300).trim()}).` };
    } catch {
      return {};
    }
  }
  // F1.6 — light CSS balance heuristic (strings and comments excluded).
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