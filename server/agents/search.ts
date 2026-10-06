/**
 * SEMANTIC SEARCH — BM25 in-process, no daemon, no RocksDB.
 *
 * The earlier harness plan mentioned the `.zvec-grep` daemon (a plan, never built) as
 * "half-existing." This is the real thing: a lightweight BM25 index that
 * walks the workspace on first call, tokenizes text-like files into
 * fixed-size document blocks (~50 lines), and scores queries against an
 * inverted index with IDF weighting. No external processes, no native deps.
 *
 * Index is cached per workspace root; a single re-index of the touched file
 * fires when `recordAfterWrite` reports a write (see invalidateSearchIndex).
 * The agent gets `file:line` pointers — it follows with read_file.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { getActiveWorkspace } from './workspace.js';

const BLOCK_LINES = 50;
const MAX_INDEX_FILES = 1500;
const MAX_FILE_BYTES = 500_000;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-server', 'dist-tests',
  '.pnpm-store', '.turbo', '.next', '.cache', '.zvec-grep',
  '.attachments', '__pycache__', 'venv', '.pytest_cache',
]);

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp4', '.mp3', '.wav', '.avi', '.mov', '.webm',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.wasm',
  '.pdf', '.docx', '.xlsx', '.pptx',
  '.lock', '.snapshot.json',
]);

interface Doc {
  file: string;
  lineStart: number;
  lineCount: number;
  tokens: string[];
}

interface Index {
  docs: Doc[];
  /** term -> Set of doc indices that contain it */
  inverted: Map<string, Set<number>>;
  /** average doc length (in tokens) */
  avgDocLen: number;
  /** total docs */
  docCount: number;
  /** workspace root path this index was built for */
  root: string;
}

const indices = new Map<string, Index>();

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
  'could', 'may', 'might', 'must', 'can', 'shall', 'to', 'of', 'in', 'on',
  'at', 'by', 'for', 'with', 'from', 'as', 'into', 'about', 'than', 'then',
  'and', 'or', 'not', 'no', 'but', 'if', 'else', 'when', 'where', 'while',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she',
  'we', 'they', 'them', 'their', 'our', 'your', 'my', 'me', 'us',
  'function', 'const', 'let', 'var', 'return', 'import', 'export', 'class',
  'void', 'null', 'true', 'false', 'new', 'await', 'async', 'type',
]);

/** Tokenize a string into lowercase word tokens (alphanumeric, min 2 chars). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

/** Walk the workspace collecting relative paths of text-like files. */
function walkTextFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 12 || files.length >= MAX_INDEX_FILES) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_INDEX_FILES) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;
        let st;
        try { st = statSync(path.join(dir, entry.name)); } catch { continue; }
        if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
        const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
        files.push(rel);
      }
    }
  };
  visit(root, 0);
  return files;
}

/** Build (or rebuild) the BM25 index for a workspace root. */
function buildIndex(root: string): Index {
  const files = walkTextFiles(root);
  const docs: Doc[] = [];
  const inverted = new Map<string, Set<number>>();

  for (const file of files) {
    let content: string;
    try { content = readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    if (content.includes('\0')) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += BLOCK_LINES) {
      const block = lines.slice(i, i + BLOCK_LINES).join('\n');
      const tokens = tokenize(block);
      if (tokens.length === 0) continue;
      const docIdx = docs.length;
      docs.push({ file, lineStart: i + 1, lineCount: Math.min(BLOCK_LINES, lines.length - i), tokens });
      for (const token of new Set(tokens)) {
        let bucket = inverted.get(token);
        if (!bucket) { bucket = new Set(); inverted.set(token, bucket); }
        bucket.add(docIdx);
      }
    }
  }

  const totalLen = docs.reduce((sum, doc) => sum + doc.tokens.length, 0);
  return { docs, inverted, avgDocLen: docs.length > 0 ? totalLen / docs.length : 0, docCount: docs.length, root };
}

/** Get or create the index for the active workspace. */
function getIndex(sessionId?: string): Index | null {
  const ws = getActiveWorkspace(sessionId);
  if (!ws) return null;
  let idx = indices.get(ws.path);
  if (!idx) {
    idx = buildIndex(ws.path);
    indices.set(ws.path, idx);
  }
  return idx;
}

/** Invalidate (force rebuild on next query) the index for a workspace. */
export function invalidateSearchIndex(root: string): void {
  indices.delete(root);
}

/** BM25 score for a single document given query terms. */
function bm25Score(docIdx: number, queryTerms: string[], index: Index, k1 = 1.5, b = 0.75): number {
  const doc = index.docs[docIdx];
  const docLen = doc.tokens.length;
  let score = 0;
  for (const term of queryTerms) {
    const postings = index.inverted.get(term);
    if (!postings) continue;
    const df = postings.size;
    const tf = doc.tokens.filter((t) => t === term).length;
    if (tf === 0) continue;
    const idf = Math.log(1 + (index.docCount - df + 0.5) / (df + 0.5));
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / index.avgDocLen))));
  }
  return score;
}

export interface SearchResult {
  file: string;
  line: number;
  score: number;
  snippet: string;
}

/** Run a BM25 query against the workspace index. Returns top-K results. */
export function searchWorkspace(
  query: string,
  limit = 10,
  sessionId?: string,
): { results: SearchResult[]; totalDocs: number; root: string } | null {
  const index = getIndex(sessionId);
  if (!index || index.docs.length === 0) return null;
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return null;

  const scored: Array<{ docIdx: number; score: number }> = [];
  for (let i = 0; i < index.docs.length; i += 1) {
    const s = bm25Score(i, queryTerms, index);
    if (s > 0) scored.push({ docIdx: i, score: s });
  }
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, limit);
  const ws = getActiveWorkspace(sessionId)!;
  const results: SearchResult[] = top.map(({ docIdx, score }) => {
    const doc = index.docs[docIdx];
    let snippet = '';
    try {
      const content = readFileSync(path.join(ws.path, doc.file), 'utf8');
      const lines = content.split('\n');
      const start = Math.max(0, doc.lineStart - 1);
      snippet = lines.slice(start, start + 2).join('\n').trim().slice(0, 200);
    } catch {  }
    return { file: doc.file, line: doc.lineStart, score: parseFloat(score.toFixed(3)), snippet };
  });

  return { results, totalDocs: index.docs.length, root: ws.path };
}
