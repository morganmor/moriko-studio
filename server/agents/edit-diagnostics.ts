import { createHash } from 'node:crypto';

/**
 * EDIT FAILURE DIAGNOSTICS.
 *
 * When edit_file's oldString does not match, a bare "0 occurrences" error
 * sends the model into blind retries — the #1 repeated-failure loop in the
 * harness. This module builds a PRESCRIPTIVE failure report instead:
 *
 *   1. which lines each occurrence sits on (for the >1 case),
 *   2. the nearest region in the file (near-match) with a similarity score,
 *   3. a divergence point: how far the anchor matched before differing,
 *   4. whitespace/EOL mismatches, made visible (· space, → tab, ¶ newline),
 *   5. a truncation hint when the anchor looks like text copied from a
 *      500-chars-truncated read (the historical silent-truncation bug),
 *   6. one concrete `nextStep` line the model can follow mechanically.
 */

const NEAR_MATCH_WINDOW = 12;
const MAX_OCCURRENCE_LINES = 8;
const CONTEXT_LINES = 3;

export interface EditFailure {
  /** Human-readable multi-line report fed straight into the tool error. */
  report: string;
  /** Line number (1-based) of the best near-match region, if any. */
  anchorLine?: number;
}

/** Visible-whitespace rendering: space→·, tab→→, LF stays structural. */
function visibleWhitespace(text: string): string {
  return text.replace(/\t/g, '→').replace(/ /g, '·');
}

function charCount(text: string): string {
  return `${text.length.toLocaleString('en-US')} chars`;
}

/** Longest common prefix length of two strings. */
function lcpLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Similarity between the anchor and a candidate window of the file, 0..1.
 * Ratio-of-matches over the longer length keeps it cheap and monotone.
 */
function similarity(anchor: string, candidate: string): number {
  if (anchor.length === 0 || candidate.length === 0) return 0;
  const longer = Math.max(anchor.length, candidate.length);
  let matches = 0;
  const iMax = Math.min(anchor.length, candidate.length);
  for (let i = 0; i < iMax; i += 1) if (anchor[i] === candidate[i]) matches += 1;
  return matches / longer;
}

/**
 * All 1-based line numbers where `needle` occurs in `content`.
 * Iterates indexOf so it also yields positions for large files cheaply.
 */
export function occurrenceLines(content: string, needle: string): number[] {
  const lines: number[] = [];
  if (!needle) return lines;
  let from = 0;
  for (;;) {
    const at = content.indexOf(needle, from);
    if (at === -1) break;
    lines.push(content.slice(0, at).split('\n').length);
    from = at + needle.length;
  }
  return lines;
}

/**
 * Char position of the occurrence whose LINE is nearest `targetLine`.
 * Used by the lineHint path: splicing must target the occurrence the model
 * pointed at, not blindly the first one.
 */
export function positionOfOccurrenceNearLine(
  content: string,
  needle: string,
  targetLine: number,
): number {
  let bestAt = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let from = 0;
  for (;;) {
    const at = content.indexOf(needle, from);
    if (at === -1) break;
    const line = content.slice(0, at).split('\n').length;
    const distance = Math.abs(line - targetLine);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestAt = at;
    }
    from = at + needle.length;
  }
  return bestAt;
}

export interface NearMatch {
  /** 1-based line of the region's first line. */
  line: number;
  /** 0..1 similarity of the anchor to this region. */
  score: number;
  /** The region's raw text (CONTEXT_LINES around, anchor-sized). */
  text: string;
  /** How many chars of the anchor matched before the first difference. */
  divergenceAt: number;
  /** The differing tail the model wrote vs what the file holds. */
  expectedVsActual?: { wrote: string; file: string };
}

/**
 * Finds the most similar anchor-sized window in the file. Scans with a
 * coarse first-line filter: only windows whose first line fuzzy-matches the
 * anchor's first line get a full score — keeps the scan near-linear.
 */
export function findNearMatch(content: string, anchor: string): NearMatch | null {
  if (!anchor.trim()) return null;
  const lines = content.split('\n');
  const anchorLines = anchor.split('\n');
  const firstLine = anchorLines[0].trim();
  if (!firstLine) return null;
  const anchorSpan = anchorLines.length;

  let best: NearMatch | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i];
    if (!lineText.includes(firstLine.slice(0, Math.max(8, Math.min(40, firstLine.length))))) {
      continue;
    }
    const candidate = lines.slice(i, i + anchorSpan).join('\n');
    const score = similarity(anchor, candidate);
    if (!best || score > best.score) {
      const divergenceAt = lcpLength(anchor, candidate);
      const match: NearMatch = {
        line: i + 1,
        score,
        text: candidate,
        divergenceAt,
        expectedVsActual:
          divergenceAt > 0 && divergenceAt < Math.min(anchor.length, candidate.length)
            ? {
                wrote: anchor.slice(divergenceAt, divergenceAt + 40),
                file: candidate.slice(divergenceAt, divergenceAt + 40),
              }
            : undefined,
      };
      best = match;
    }
  }
  return best;
}

export interface FailureContext {
  /** Workspace-relative file path, for messages. */
  relative: string;
  /** Full file content (current, on disk). */
  content: string;
  /** The anchor that failed to match. */
  oldString: string;
  /** True when the model passed lineHint. */
  lineHint?: number;
}

/**
 * Builds the full failure report for "oldString not found (0 occurrences)".
 */
export function diagnoseNoMatch(ctx: FailureContext): EditFailure {
  const { relative, content, oldString } = ctx;
  const parts: string[] = [];
  const anchor = oldString;
  const firstLine = anchor.split('\n')[0];

  parts.push(`oldString was not found in ${relative} (0 occurrences). Diagnosis:`);

  const fileUsesCrlf = content.includes('\r\n');
  const anchorUsesCrlf = anchor.includes('\r\n');
  if (fileUsesCrlf !== anchorUsesCrlf && anchor.includes('\n')) {
    parts.push(
      `  • EOL mismatch: the file uses ${fileUsesCrlf ? 'CRLF (\\r\\n)' : 'LF (\\n)'} line endings, ` +
        `your oldString uses ${anchorUsesCrlf ? 'CRLF' : 'LF'}.`,
    );
  }

  const near = findNearMatch(content, anchor);
  if (near && near.score >= 0.5) {
    parts.push(
      `  • closest region: line ${near.line} (similarity ${(near.score * 100).toFixed(0)}%);`,
    );
    const snippet = near.text.split('\n').slice(0, NEAR_MATCH_WINDOW);
    parts.push('    file actually contains:');
    for (const line of snippet) {
      parts.push(`      | ${visibleWhitespace(line)}`);
    }
    if (near.expectedVsActual) {
      parts.push(
        `    your oldString matches until char ${near.divergenceAt}, then diverges — ` +
          `you wrote ${JSON.stringify(near.expectedVsActual.wrote)}, ` +
          `the file has ${JSON.stringify(near.expectedVsActual.file)}.`,
      );
    }
    if (near.score >= 0.75) {
      parts.push(`  • suggestedOldString — the file's actual text starting at line ${near.line} (copy this JSON string exactly; every escape is authoritative):`);
      parts.push(`    ${JSON.stringify(near.text)}`);
    }
  } else {
    parts.push(`  • no similar region found for the first line: ${JSON.stringify(firstLine.slice(0, 120))}.`);
  }

  const anchorTail = anchor.split('\n').map((l) => l.length - l.trimEnd().length);
  if (anchorTail.some((t) => t > 0)) {
    parts.push('  • your oldString has TRAILING whitespace on some lines — the file may not have it.');
  }

  // --- truncation hint (the historical silent-500 bug) ---------------------
  if (anchor.length > 480 && near && near.divergenceAt >= Math.min(480, near.text.length) * 0.9) {
    parts.push(
      `  • truncation suspect: your oldString is ${charCount(anchor)} long and matches the file ` +
        `until char ${near.divergenceAt}, then ends abruptly. It looks like text copied from an ` +
        `older read that cut lines at 500 chars. Re-read the region and copy the FULL lines.`,
    );
  }

  parts.push(
    `Next step: agent__read_file path="${relative}"${near ? ` offsetLine=${Math.max(1, near.line - CONTEXT_LINES)} maxLines=${anchor.split('\n').length + NEAR_MATCH_WINDOW}` : ''} ` +
      `— copy the anchor from that fresh output (mind indentation), or shorten the anchor to fewer unique lines.`,
  );
  if (ctx.lineHint !== undefined) {
    parts.push(`(Your lineHint ${ctx.lineHint} did not change this outcome — the anchor itself was not found.)`);
  }
  return { report: parts.join('\n'), anchorLine: near?.line };
}

/**
 * Builds the report for "oldString matched N>1 times" — with the actual
 * line numbers so the model can disambiguate without a second read.
 */
export function diagnoseMultiMatch(
  relative: string,
  lines: number[],
  replaceAllHint: boolean,
): EditFailure {
  const shown = lines.slice(0, MAX_OCCURRENCE_LINES);
  const rest = lines.length - shown.length;
  const parts = [
    `oldString matches ${lines.length} times in ${relative}, on line(s): ${shown.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}.`,
    'Next step: EITHER extend the anchor with surrounding unique lines, ' +
      `OR pass lineHint: ${shown[0]} (the edit then accepts the occurrence nearest that line), ` +
      'OR pass replaceAll: true when every occurrence should change.',
  ];
  if (replaceAllHint) {
    parts.push('(You passed replaceAll — this error should not have surfaced; please report it.)');
  }
  return { report: parts.join('\n'), anchorLine: lines[0] };
}

/** sha256 of text — shared by read_file footer and edit_file contract. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * IDEMPOTENCY guard: is `newString` plausibly the applied form of
 * `oldString` (two versions of the same region)? Guards the "already
 * applied" fast-path against false positives where a short or unrelated
 * newString merely happens to exist somewhere in the file.
 *
 * Fires when the first non-empty lines match case-insensitively, or the
 * strings are ≥ 60% positionally similar (a rename/tweak of the anchor).
 */
export function plausiblyApplied(oldString: string, newString: string): boolean {
  const firstLine = (text: string): string =>
    (text.split('\n').find((line) => line.trim()) ?? '').trim().toLowerCase();
  const oldFirst = firstLine(oldString);
  if (oldFirst && oldFirst === firstLine(newString)) return true;

  const a = oldString.toLowerCase();
  const b = newString.toLowerCase();
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return false;
  let matches = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] === b[i]) matches += 1;
  }
  return matches / longer >= 0.6;
}
