/**
 * Diffstat counting for tool-call headers (git-style "+N -M" badges).
 *
 * Counts added/removed lines in a unified diff WITHOUT rendering it:
 * a line counts as added when it starts with "+" but not "+++" (the
 * b-path header), removed when it starts with "-" but not "---". "@@"
 * hunk headers are neither. Files whose every hunk line is context
 * yield 0/0 — callers typically hide the badge then.
 */

export interface DiffStat {
  added: number;
  removed: number;
}

/** Pure line counts from a unified diff; null when the text is not one. */
export function diffStat(diff: string): DiffStat | null {
  if (!diff) return null;
  const lines = diff.split('\n');
  const looksLikeDiff = lines.some((line) => line.startsWith('--- a/') || line.startsWith('+++ b/') || line.startsWith('@@'));
  if (!looksLikeDiff) return null;
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

/**
 * " +N -M" with zeros omitted (" +2" · " -3" · " +2 -1"); '' when nothing
 * changed (pure in-place edits) or the input is not a diff.
 */
export function diffStatLabel(diff: string | undefined): string {
  const stat = diff ? diffStat(diff) : null;
  if (!stat || (stat.added === 0 && stat.removed === 0)) return '';
  const parts: string[] = [];
  if (stat.added > 0) parts.push(`+${stat.added}`);
  if (stat.removed > 0) parts.push(`-${stat.removed}`);
  return parts.join(' ');
}