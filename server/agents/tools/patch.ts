/**
 * agent__apply_patch — apply a unified diff (multi-file, multi-hunk) as ONE
 * atomic operation. If ANY hunk fails to match its context, NO files are
 * written — partial patches never land. Each file touched is snapshotted to
 * the vault first.
 *
 * Hardening over the original:
 *  - fuzzy context matching: whitespace-only differences (tab/space/CRLF) are
 *    ACCEPTED, because re-formatting tools and hand-written patches disagree
 *    on whitespace constantly. Real differences get a side-by-side diagnosis.
 *  - read-window enforcement: every hunk must lie inside a window the model
 *    actually READ this session (same posture as edit_file) — the #1 cause
 *    of patch failure was patching from memory of stale content.
 *  - per-hunk status: on failure, every hunk is reported (ok / mismatch /
 *    outside window / error) so the model knows exactly which one to fix.
 *  - `diff --git a/x b/x` is the authoritative path source (---/+++ fallback).
 *  - `\ No newline at end of file` handling.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, truncateOutput } from './shared.js';
import { snapshotFile } from '../vault.js';
import { buildUnifiedDiff, diffStatFromOps } from '../diff.js';
import { recordAfterWrite, getReadEntry, hasCurrentRead, readRequiredMessage, staleReadMessage } from '../read-policy.js';
import { getActiveWorkspace, isInsideRoot } from '../workspace.js';

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  /** True when the hunk body contained a `\ No newline at end of file` marker. */
  noNewline?: boolean;
  /** Filled by validation, read by the renderer. */
  status?: 'ok' | 'outside' | 'stale' | 'unread' | 'error';
  error?: string;
}

interface PatchFile {
  oldPath: string;
  newPath: string;
  hunks: PatchHunk[];
}

/** Normalize all whitespace runs so reformatting does not fail a context match. */
function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Two strings that differ ONLY in whitespace (tabs vs spaces, CRLF vs LF,
 * indentation width) count as the same line for context matching.
 */
function whitespaceEquivalent(expected: string, actual: string): boolean {
  return squashWhitespace(expected) === squashWhitespace(actual) && squashWhitespace(expected) !== '';
}

/** Parse a unified diff (git-style) into structured patch files. */
export function parsePatch(patchText: string): PatchFile[] {
  const files: PatchFile[] = [];
  const lines = patchText.split('\n');
  let i = 0;

  /** `diff --git a/x b/x` is the authoritative path; fall back to ---/+++. */
  const stripPrefix = (value: string): string => {
    const m = value.match(/^[ab]\//);
    return m ? value.slice(2) : value;
  };

  while (i < lines.length) {
    let gitOld: string | null = null;
    let gitNew: string | null = null;
    if (lines[i].startsWith('diff --git ')) {
      const parts = lines[i].slice('diff --git '.length).trim().split(/\s+/);
      if (parts.length >= 2) {
        gitOld = stripPrefix(parts[0]);
        gitNew = stripPrefix(parts[1]);
      }
      i += 1;
      while (i < lines.length && !lines[i].startsWith('--- ') && !lines[i].startsWith('diff --git')) i += 1;
      if (i >= lines.length || !lines[i].startsWith('--- ')) continue;
    } else if (!lines[i].startsWith('--- ')) {
      i += 1;
      continue;
    }

    const oldPath = lines[i].slice(4).trim();
    i += 1;
    if (i >= lines.length || !lines[i].startsWith('+++ ')) break;
    const newPath = lines[i].slice(4).trim();
    i += 1;

    const hunks: PatchHunk[] = [];
    while (i < lines.length && lines[i].startsWith('@@')) {
      const match = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) {
        i += 1;
        continue;
      }
      const hunk: PatchHunk = {
        oldStart: parseInt(match[1], 10),
        oldLines: match[2] ? parseInt(match[2], 10) : 1,
        newStart: match[3] ? parseInt(match[3], 10) : 1,
        newLines: match[4] ? parseInt(match[4], 10) : 1,
        lines: [],
      };
      i += 1;
      while (
        i < lines.length &&
        !lines[i].startsWith('@@') &&
        !lines[i].startsWith('--- ') &&
        !lines[i].startsWith('diff ')
      ) {
        const body = lines[i];
        if (body === '\\ No newline at end of file') {
          hunk.noNewline = true;
        } else if (body[0] === ' ' || body[0] === '-' || body[0] === '+') {
          hunk.lines.push(body);
        }
        i += 1;
      }
      hunks.push(hunk);
    }
    files.push({
      oldPath: gitOld ?? stripPrefix(oldPath),
      newPath: gitNew ?? stripPrefix(newPath),
      hunks,
    });
  }
  return files;
}

export class PatchMismatch extends Error {
  constructor(
    public readonly hunkIndex: number,
    message: string,
  ) {
    super(message);
  }
}

/** Apply one hunk to a line array, throwing PatchMismatch on hard failure. */
export function applyHunk(lines: string[], hunk: PatchHunk, hunkIndex: number): string[] {
  const result: string[] = [];
  let currentLine = 0;
  const startIdx = Math.max(0, hunk.oldStart - 1);
  for (let i = 0; i < startIdx && i < lines.length; i += 1) {
    result.push(lines[i]);
  }
  currentLine = startIdx;
  for (const hunkLine of hunk.lines) {
    const prefix = hunkLine[0] ?? ' ';
    const content = hunkLine.slice(1);
    if (prefix === ' ' || prefix === '-') {
      const kind = prefix === ' ' ? 'Context' : 'Remove';
      if (currentLine >= lines.length) {
        throw new PatchMismatch(
          hunkIndex,
          `${kind} line "${content}" past EOF (expected line ${currentLine + 1}).`,
        );
      }
      const actual = lines[currentLine];
      if (actual !== content) {
        if (whitespaceEquivalent(content, actual)) {
          result.push(actual);
          currentLine += 1;
          continue;
        }
        throw new PatchMismatch(
          hunkIndex,
          `${kind} mismatch at line ${currentLine + 1}:\n` +
            `          expected: ${content}\n` +
            `          found:    ${actual}`,
        );
      }
      if (prefix === ' ') result.push(actual);
      currentLine += 1;
    } else if (prefix === '+') {
      result.push(content);
    }
  }
  for (let i = currentLine; i < lines.length; i += 1) {
    result.push(lines[i]);
  }
  return result;
}

/**
 * READ-WINDOW ENFORCEMENT for patches (edit_file has had this all along;
 * apply_patch never did). A hunk may only touch lines the model actually saw
 * on the current revision, so patching from stale memory is refused instead
 * of silently misapplied.
 */
function verifyReadBeforePatch(
  relative: string,
  hunk: PatchHunk,
  readEntry: ReturnType<typeof getReadEntry>,
  hasRead: boolean,
): 'ok' | 'outside' | 'unread' | 'stale' {
  if (!hasRead) {
    hunk.status = 'unread';
    hunk.error = readRequiredMessage(relative);
    return 'unread';
  }
  if (!readEntry) {
    hunk.status = 'stale';
    hunk.error = staleReadMessage(relative, 0);
    return 'stale';
  }
  const hunkEnd = hunk.oldStart + Math.max(hunk.oldLines - 1, 0);
  if (readEntry.toLine < Number.MAX_SAFE_INTEGER) {
    if (hunk.oldStart < readEntry.fromLine || hunkEnd > readEntry.toLine) {
      hunk.status = 'outside';
      hunk.error =
        `hunk @@ -${hunk.oldStart},${hunk.oldLines} targets lines ` +
        `${hunk.oldStart}–${hunkEnd}, but "${relative}" was read as lines ` +
        `${readEntry.fromLine}–${readEntry.toLine} (read#${readEntry.rev}). ` +
        `Re-read that region first, then re-send the patch.`;
      return 'outside';
    }
  }
  hunk.status = 'ok';
  return 'ok';
}

export async function applyPatchTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const patchText = str(args, 'patch');
  if (!patchText.trim()) {
    return { ok: false, isError: true, text: 'apply_patch needs a "patch" (unified diff text).' };
  }

  const files = parsePatch(patchText);
  if (files.length === 0) {
    return { ok: false, isError: true, text: 'No valid diff headers (--- / +++ or diff --git) found in the patch.' };
  }

  const ws = getActiveWorkspace(ctx.sessionId);
  if (!ws) return { ok: false, isError: true, text: 'No active workspace.' };

  const targets: Array<{ relPath: string; absolute: string; file: PatchFile }> = [];
  for (const file of files) {
    const relPath = file.newPath || file.oldPath;
    const absolute = path.resolve(ws.path, relPath);
    if (!isInsideRoot(absolute, ws.path)) {
      return { ok: false, isError: true, text: `Patch target "${relPath}" is outside the workspace root.` };
    }
    snapshotFile(ctx.sessionId, absolute, 'apply_patch');
    targets.push({ relPath, absolute, file });
  }

  const applied: Array<{ relPath: string; absolute: string; newContent: string }> = [];
  const failures: string[] = [];

  for (const { relPath, absolute, file } of targets) {
    let content: string;
    let mtime: number;
    try {
      const st = statSync(absolute);
      content = readFileSync(absolute, 'utf8');
      mtime = st.mtimeMs;
    } catch {
      const msg = `${relPath}: file not found`;
      failures.push(msg);
      for (const h of file.hunks) {
        h.status = 'error';
        h.error = msg;
      }
      continue;
    }

    const readEntry = getReadEntry(ctx.sessionId, absolute);
    const hasRead = hasCurrentRead(ctx.sessionId, absolute, content, mtime);

    let lines = content.split('\n');
    const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
    if (hadTrailingNewline) lines = lines.slice(0, -1);

    let fileOk = true;
    const hunkStatuses: string[] = [];

    for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
      const hunk = file.hunks[hunkIndex];
      const windowState = verifyReadBeforePatch(relPath, hunk, readEntry, hasRead);
      if (windowState !== 'ok') {
        fileOk = false;
        hunkStatuses.push(`  hunk #${hunkIndex + 1} @@ -${hunk.oldStart},${hunk.oldLines}: ${windowState.toUpperCase()}\n    ${hunk.error ?? ''}`);
        continue;
      }
      try {
        lines = applyHunk(lines, hunk, hunkIndex);
        hunk.status = 'ok';
        hunkStatuses.push(`  hunk #${hunkIndex + 1} @@ -${hunk.oldStart},${hunk.oldLines}: OK`);
      } catch (error) {
        fileOk = false;
        hunk.status = 'error';
        hunk.error = error instanceof Error ? error.message : 'hunk failed';
        hunkStatuses.push(`  hunk #${hunkIndex + 1} @@ -${hunk.oldStart},${hunk.oldLines}: MISMATCH\n    ${hunk.error}`);
      }
    }

    if (!fileOk) {
      failures.push(`${relPath}:\n${hunkStatuses.join('\n')}`);
      continue;
    }

    let newContent = lines.join('\n');
    const lastHunk = file.hunks[file.hunks.length - 1];
    if (lastHunk?.noNewline) {
    } else if (hadTrailingNewline && !newContent.endsWith('\n')) {
      newContent += '\n';
    }
    applied.push({ relPath, absolute, newContent });
  }

  if (failures.length > 0) {
    return {
      ok: false,
      isError: true,
      text: truncateOutput(
        `Patch FAILED — no files were written (atomic). Fix the flagged hunk(s) and re-send the whole patch.\n\n` +
          failures.join('\n\n'),
      ),
    };
  }

  const written: string[] = [];
  // DIFF PANEL DATA: per-file before→after diffs + summed counts ride the
  // tool result, so the badge and the panel see apply_patch changes too.
  const diffParts: string[] = [];
  let diffAdded = 0;
  let diffRemoved = 0;
  for (const { relPath, absolute, newContent } of applied) {
    try {
      let beforeContent = '';
      try {
        beforeContent = readFileSync(absolute, 'utf8');
      } catch {
        beforeContent = '';
      }
      writeFileSync(absolute, newContent);
      let postMtime = 0;
      try {
        postMtime = statSync(absolute).mtimeMs;
      } catch {
        postMtime = Date.now();
      }
      recordAfterWrite(ctx.sessionId, absolute, newContent, postMtime);
      written.push(relPath);
      const stat = diffStatFromOps(beforeContent, newContent);
      if (stat) {
        diffAdded += stat.added;
        diffRemoved += stat.removed;
      }
      const piece = buildUnifiedDiff(beforeContent, newContent, relPath);
      if (piece && piece !== '(no textual change)') diffParts.push(piece);
    } catch (error) {
      failures.push(`${relPath}: write failed — ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      isError: true,
      text: `Patch partially applied — ${written.length} file(s) written, ${failures.length} write error(s):\n${failures.join('\n')}`,
    };
  }

  return {
    ok: true,
    isError: false,
    text: `Patch applied atomically — ${written.length} file(s): ${written.join(', ')}`,
    diff: diffParts.length > 0 ? diffParts.join('\n') : undefined,
    diffstat: diffAdded > 0 || diffRemoved > 0 ? { added: diffAdded, removed: diffRemoved } : undefined,
  };
}
