/**
 * Minimal unified-diff generator for harness tool results (no dependency).
 *
 * Line-based LCS with a size guard: files beyond DIFF_MAX_LINES fall back
 * to a summary instead of an O(n·m) matrix blow-up. Output follows the
 * `--- a/path` / `+++ b/path` / @@ hunks convention with N context lines.
 */

const DIFF_MAX_LINES = 4000;
const CONTEXT_LINES = 3;
const MAX_DIFF_LINES = 800;

type Op = { type: 'same' | 'add' | 'del'; text: string };

/** LCS backtrace producing an aligned op list (bounded input). */
function lineOps(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i += 1) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i];
    const next = table[i + 1];
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = before[i] === after[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: 'same', text: before[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'del', text: before[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', text: after[j] });
      j += 1;
    }
  }
  while (i < n) ops.push({ type: 'del', text: before[i++] });
  while (j < m) ops.push({ type: 'add', text: after[j++] });
  return ops;
}

/**
 * Word-level diff annotation for a pair of changed lines. Returns null when the
 * lines are too dissimilar (not worth annotating) or too short (the change is
 * already visible). Output: a compact `changed: old → new` string listing only
 * the token pairs that differ.
 *
 * The gap this closes: a 200-char line that changed one word
 * shows as a full -old/+new pair — the model must scan both to find the single
 * changed token. Word-diff highlights exactly what moved.
 */
function wordDiff(beforeLine: string, afterLine: string): string | null {
  if (beforeLine.length < 40 || afterLine.length < 40) return null;
  const beforeWords = beforeLine.trim().split(/\s+/);
  const afterWords = afterLine.trim().split(/\s+/);
  const shared = beforeWords.filter((w) => afterWords.includes(w)).length;
  const minLen = Math.min(beforeWords.length, afterWords.length);
  if (minLen < 5 || shared / minLen < 0.5) return null;
  const ops = lineOps(beforeWords, afterWords);
  const changes: string[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i].type === 'del') {
      const dels: string[] = [];
      let j = i;
      while (j < ops.length && ops[j].type === 'del') { dels.push(ops[j].text); j += 1; }
      const adds: string[] = [];
      while (j < ops.length && ops[j].type === 'add') { adds.push(ops[j].text); j += 1; }
      if (adds.length > 0) {
        changes.push(`${dels.join(' ')} → ${adds.join(' ')}`);
      } else {
        changes.push(`-${dels.join(' ')}`);
      }
      i = j - 1;
    } else if (ops[i].type === 'add') {
      changes.push(`+${ops[i].text}`);
    }
  }
  if (changes.length === 0 || changes.length > 8) return null;
  return `      \u2502 changed: ${changes.join('; ')}`;
}

export interface DiffOptions {
  label?: string;
  /** Enable word-level diff annotations for changed lines (default true). */
  wordLevel?: boolean;
}

/** Diffstat of one file: insertions/deletions counted from the raw ops —
 *  never re-parsed from the rendered diff string (annotations + the 800-line
 *  cap would undercount). */
export interface DiffStat {
  added: number;
  removed: number;
}

/**
 * Count +/− lines straight from the op list (the same source buildUnifiedDiff
 * renders from), so the number survives annotations and truncation.
 */
export function diffStatFromOps(before: string, after: string): DiffStat | undefined {
  if (before === after) return undefined;
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  if (beforeLines.length > DIFF_MAX_LINES || afterLines.length > DIFF_MAX_LINES) {
    const added = Math.max(0, afterLines.length - beforeLines.length);
    return { added, removed: 0 };
  }
  const ops = lineOps(beforeLines, afterLines);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added += 1;
    else if (op.type === 'del') removed += 1;
  }
  if (added === 0 && removed === 0) return undefined;
  return { added, removed };
}

/**
 * Unified diff (before → after). Change ops closer than 2×CONTEXT merge into
 * one hunk; each hunk carries its real start line and counts. Huge inputs
 * return a capped summary.
 */
export function buildUnifiedDiff(before: string, after: string, label?: string | DiffOptions): string {
  const options = typeof label === 'string' ? { label } : label ?? {};
  const name = options.label ?? 'file';
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  if (before === after) return '(no textual change)';
  if (beforeLines.length > DIFF_MAX_LINES || afterLines.length > DIFF_MAX_LINES) {
    return `diff too large to render (${beforeLines.length} → ${afterLines.length} lines; limit ${DIFF_MAX_LINES}).`;
  }

  const ops = lineOps(beforeLines, afterLines);
  const changeIndexes: number[] = [];
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].type !== 'same') changeIndexes.push(index);
  }

  const lines: string[] = [`--- a/${name}`, `+++ b/${name}`];
  let emitted = 0;
  let truncated = false;

  const beforeBefore = (index: number): number => {
    let count = 0;
    for (let i = 0; i < index; i += 1) if (ops[i].type !== 'add') count += 1;
    return count;
  };
  const afterBefore = (index: number): number => {
    let count = 0;
    for (let i = 0; i < index; i += 1) if (ops[i].type !== 'del') count += 1;
    return count;
  };

  const moveAnnotations = new Map<number, string>();
  {
    const delRuns: Array<{ start: number; texts: string[] }> = [];
    const addRuns: Array<{ start: number; texts: string[] }> = [];
    for (let i = 0; i < ops.length; ) {
      if (ops[i].type === 'del') {
        const start = i;
        const texts: string[] = [];
        while (i < ops.length && ops[i].type === 'del') { texts.push(ops[i].text); i += 1; }
        delRuns.push({ start, texts });
      } else if (ops[i].type === 'add') {
        const start = i;
        const texts: string[] = [];
        while (i < ops.length && ops[i].type === 'add') { texts.push(ops[i].text); i += 1; }
        addRuns.push({ start, texts });
      } else i += 1;
    }
    const usedAdds = new Set<number>();
    for (const delRun of delRuns) {
      if (delRun.texts.length < 3) continue;
      const key = delRun.texts.join('\n');
      for (let a = 0; a < addRuns.length; a += 1) {
        if (usedAdds.has(a)) continue;
        if (addRuns[a].texts.length === delRun.texts.length && addRuns[a].texts.join('\n') === key) {
          usedAdds.add(a);
          const fromLine = beforeBefore(delRun.start) + 1;
          moveAnnotations.set(
            addRuns[a].start,
            `      \u21c4 moved from before:${fromLine} — identical ${delRun.texts.length}-line block (not a rewrite)`,
          );
          break;
        }
      }
    }
  }

  let clusterStart = 0;
  while (clusterStart < changeIndexes.length && !truncated) {
    let clusterEnd = clusterStart;
    while (
      clusterEnd + 1 < changeIndexes.length &&
      changeIndexes[clusterEnd + 1] - changeIndexes[clusterEnd] <= CONTEXT_LINES * 2
    ) {
      clusterEnd += 1;
    }
    const from = Math.max(0, changeIndexes[clusterStart] - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, changeIndexes[clusterEnd] + CONTEXT_LINES);
    const hunk = ops.slice(from, to + 1);
    const delCount = hunk.filter((op) => op.type !== 'add').length;
    const addCount = hunk.filter((op) => op.type !== 'del').length;
    lines.push(
      `@@ -${beforeBefore(from) + 1},${delCount} +${afterBefore(from) + 1},${addCount} @@`,
    );
    const useWordDiff = options.wordLevel !== false;
    for (let idx = 0; idx < hunk.length; idx += 1) {
      if (emitted >= MAX_DIFF_LINES) {
        truncated = true;
        break;
      }
      const op = hunk[idx];
      lines.push(`${op.type === 'same' ? ' ' : op.type === 'add' ? '+' : '-'}${op.text}`);
      emitted += 1;
      const moveNote = moveAnnotations.get(from + idx);
      if (moveNote) {
        lines.push(moveNote);
        emitted += 1;
      }
      if (useWordDiff && op.type === 'add' && idx > 0 && hunk[idx - 1].type === 'del') {
        const annotation = wordDiff(hunk[idx - 1].text, op.text);
        if (annotation) {
          lines.push(annotation);
          emitted += 1;
        }
      }
    }
    clusterStart = clusterEnd + 1;
  }
  if (truncated) lines.push(`…(diff truncated at ${MAX_DIFF_LINES} lines)`);
  return lines.join('\n');
}
