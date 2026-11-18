

export type DiffRowKind = 'ctx' | 'del' | 'add' | 'note';

export interface DiffRow {
  kind: DiffRowKind;
  
  beforeNo?: number;
  
  afterNo?: number;
  text: string;
}

export interface DiffHunk {
  
  header: string;
  rows: DiffRow[];
  
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


export interface SplitRow {
  kind: 'ctx' | 'chg' | 'del' | 'add' | 'note';
  before?: { no?: number; text: string };
  after?: { no?: number; text: string };
  
  text?: string;
}


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
