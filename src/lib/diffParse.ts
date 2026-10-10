/**
 * Unified-diff parser + side-by-side row model for the Diff Panel.
 *
 * Input is the string the server's diff engine already rendered
 * (server/agents/diff.ts buildUnifiedDiff): `--- a/path` headers, `@@` hunks
 * with real line numbers, and two annotation line kinds it interleaves —
 * `⇄ moved from before:N` and `│ changed: …`. Annotations parse as NOTE rows,
 * never as code rows, so the split view can render them as full-width notes.
 *
 * Multi-file diffs (apply_patch concatenates one block per file) parse into
 * one ParsedDiffFile per `--- a/` header. Pure function — no DOM, no store.
 */

export type DiffRowKind = 'ctx' | 'del' | 'add' | 'note';

export interface DiffRow {
  kind: DiffRowKind;
  /** Original line number in the before file (ctx/del rows). */
  beforeNo?: number;
  /** Original line number in the after file (ctx/add rows). */
  afterNo?: number;
  text: string;
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@` header, kept verbatim. */
  header: string;
  rows: DiffRow[];
  /**
   * The server caps a render at MAX_DIFF_LINES — when it hits the cap the
   * string stops mid-hunk, so row counts no longer match the header counts.
   * Detected at hunk close and surfaced honestly in the UI.
   */
  truncated: boolean;
}

export interface ParsedDiffFile {
  path: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  truncated: boolean;
}

const FILE_RE = /^--- a\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** Annotations are pushed with a fixed 6-space indent (see buildUnifiedDiff). */
const NOTE_RE = /^ {6}[⇄│]/;

export function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  if (!diff || !diff.includes('--- a/')) return files;

  let current: ParsedDiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let beforeNo = 0;
  let afterNo = 0;
  let expectedBefore = 0;
  let expectedAfter = 0;
  let seenBefore = 0;
  let seenAfter = 0;
  const closeHunk = () => {
    if (hunk && (seenBefore < expectedBefore || seenAfter < expectedAfter)) {
      hunk.truncated = true;
      if (current) current.truncated = true;
    }
    hunk = null;
  };

  for (const raw of diff.replace(/\r\n/g, '\n').split('\n')) {
    const fileMatch = FILE_RE.exec(raw);
    if (fileMatch) {
      closeHunk();
      current = { path: fileMatch[1], hunks: [], added: 0, removed: 0, truncated: false };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+++ ')) continue;
    const hunkMatch = HUNK_RE.exec(raw);
    if (hunkMatch) {
      closeHunk();
      beforeNo = Number(hunkMatch[1]);
      afterNo = Number(hunkMatch[3]);
      expectedBefore = Number(hunkMatch[2] ?? 1);
      expectedAfter = Number(hunkMatch[4] ?? 1);
      seenBefore = 0;
      seenAfter = 0;
      hunk = { header: raw, rows: [], truncated: false };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (NOTE_RE.test(raw)) {
      hunk.rows.push({ kind: 'note', text: raw.trim() });
      continue;
    }
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === '-') {
      hunk.rows.push({ kind: 'del', beforeNo, text });
      beforeNo += 1;
      seenBefore += 1;
      current.removed += 1;
    } else if (marker === '+') {
      hunk.rows.push({ kind: 'add', afterNo, text });
      afterNo += 1;
      seenAfter += 1;
      current.added += 1;
    } else if (marker === ' ') {
      hunk.rows.push({ kind: 'ctx', beforeNo, afterNo, text });
      beforeNo += 1;
      afterNo += 1;
      seenBefore += 1;
      seenAfter += 1;
    } else {
      hunk.rows.push({ kind: 'note', text: raw.trim() });
    }
  }
  closeHunk();
  return files;
}

/** One rendered line of the side-by-side view. */
export interface SplitRow {
  kind: 'ctx' | 'chg' | 'del' | 'add' | 'note';
  before?: { no?: number; text: string };
  after?: { no?: number; text: string };
  /** note rows only */
  text?: string;
}

/**
 * SIDE-BY-SIDE PAIRING POLICY (VS Code / GitHub): within a run of
 * consecutive del/add rows, pair dels[i] with adds[i] position-wise; the
 * leftover rows of the longer side render as one-sided lines. Context and
 * note rows pass through unchanged — notes keep their position in the run
 * order so `│ changed` / `⇄ moved` stay next to the line they annotate.
 */
export function toSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: DiffRow[] = [];
  let adds: DiffRow[] = [];
  const flush = () => {
    const count = Math.max(dels.length, adds.length);
    for (let index = 0; index < count; index += 1) {
      const del = dels[index];
      const add = adds[index];
      out.push({
        kind: del && add ? 'chg' : del ? 'del' : 'add',
        before: del ? { no: del.beforeNo, text: del.text } : undefined,
        after: add ? { no: add.afterNo, text: add.text } : undefined,
      });
    }
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === 'del') {
      dels.push(row);
      continue;
    }
    if (row.kind === 'add') {
      adds.push(row);
      continue;
    }
    flush();
    if (row.kind === 'ctx') {
      out.push({
        kind: 'ctx',
        before: { no: row.beforeNo, text: row.text },
        after: { no: row.afterNo, text: row.text },
      });
    } else {
      out.push({ kind: 'note', text: row.text });
    }
  }
  flush();
  return out;
}
