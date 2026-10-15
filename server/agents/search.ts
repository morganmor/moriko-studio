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

import { addonsSrcRoot, getActiveWorkspace } from './workspace.js';

const BLOCK_LINES = 50;
const MAX_INDEX_FILES = 4000;
const MAX_FILE_BYTES = 500_000;
const MAX_INDEX_BYTES = 40_000_000;

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

/**
 * SEARCH ROOTS — the union the index covers: the ACTIVE workspace root plus
 * the builtin addon sources (addons-src/, the Addon Manager workspace). The
 * addon roots ride along in every session — the agent never has to switch
 * workspaces to search addon code. The second entry is null in packaged
 * builds, and is dropped when it IS the workspace (the self-hosted case).
 */
function searchRoots(sessionId?: string): Array<{ root: string; prefix: string }> {
  const roots: Array<{ root: string; prefix: string }> = [];
  const ws = getActiveWorkspace(sessionId);
  if (ws) roots.push({ root: ws.path, prefix: '' });
  const src = addonsSrcRoot();
  if (src && !roots.some((entry) => isSameRoot(entry.root, src))) {
    roots.push({ root: src, prefix: 'addons-src/' });
  }
  return roots;
}

function isSameRoot(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

interface Doc {
  file: string;
  lineStart: number;
  lineCount: number;
  tokens: string[];
  /** path tokens + declared-symbol tokens, for boosting (F1.3). */
  boostTokens: Set<string>;
  /** raw block text kept for snippet selection (F1.3). */
  text: string;
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

/** F1.3 — camelCase/PascalCase/snake/kebab/dot aware tokenizer + light stem.
 *  `truncateOutput` → [truncateoutput, truncate, output]; keeps the whole
 *  token too so exact matches still score. */
export function tokenize(text: string): string[] {
  const raw = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  const out: string[] = [];
  for (const token of raw) {
    out.push(token);
    const stem = stemToken(token);
    if (stem && stem !== token) out.push(stem);
  }
  return out;
}

/** Light suffix stemmer (len > 4): s / ing / ed. */
function stemToken(token: string): string | null {
  if (token.length <= 4) return null;
  for (const suffix of ['ing', 'ed']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  if (token.endsWith('s') && token.length - 1 >= 3) return token.slice(0, -1);
  return null;
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

/** Build (or rebuild) the BM25 index over the SEARCH ROOTS (workspace +
 *  addons-src). Docs from the addon roots carry an `addons-src/` path prefix
 *  so the file references are directly follow-up-able with read_file. */
function buildIndex(roots: Array<{ root: string; prefix: string }>): Index {
  const docs: Doc[] = [];
  const inverted = new Map<string, Set<number>>();
  let totalBytes = 0;

  for (const { root, prefix } of roots) {
    for (const file of walkTextFiles(root)) {
      if (totalBytes >= MAX_INDEX_BYTES) break;
      let content: string;
      try { content = readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
      if (content.includes('\0')) continue;
      totalBytes += content.length;
      const displayPath = `${prefix}${file}`;
      const pathTokens = new Set(tokenize(displayPath));
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += BLOCK_LINES) {
        const block = lines.slice(i, i + BLOCK_LINES).join('\n');
        const tokens = tokenize(block);
        if (tokens.length === 0) continue;
        const docIdx = docs.length;
        docs.push({ file: displayPath, lineStart: i + 1, lineCount: Math.min(BLOCK_LINES, lines.length - i), tokens, boostTokens: pathTokens, text: block });
        for (const token of new Set(tokens)) {
          let bucket = inverted.get(token);
          if (!bucket) { bucket = new Set(); inverted.set(token, bucket); }
          bucket.add(docIdx);
        }
      }
    }
  }

  const totalLen = docs.reduce((sum, doc) => sum + doc.tokens.length, 0);
  return {
    docs,
    inverted,
    avgDocLen: docs.length > 0 ? totalLen / docs.length : 0,
    docCount: docs.length,
    root: roots[0]?.root ?? '',
  };
}

/** Cache key for the search-root union (stable even without a workspace). */
function indexKey(sessionId?: string): string | null {
  const roots = searchRoots(sessionId);
  if (roots.length === 0) return null;
  return roots.map((entry) => entry.root).join('|');
}

/** Get or create the index covering the workspace + addon sources. */
function getIndex(sessionId?: string): Index | null {
  const key = indexKey(sessionId);
  if (!key) return null;
  let idx = indices.get(key);
  if (!idx) {
    idx = buildIndex(searchRoots(sessionId));
    indices.set(key, idx);
  }
  return idx;
}

/**
 * F1.3 — incremental invalidation. `absolutePath` is the written file; the
 * index that covers its owning root (workspace OR addons-src) re-indexes it.
 * With no relPath the whole index is dropped (mass change / full rebuild).
 */
export function invalidateSearchIndex(root: string, relPath?: string): void {
  if (relPath === undefined) {
    for (const key of indices.keys()) {
      if (key.split('|').includes(root)) indices.delete(key);
    }
    return;
  }
  for (const [key, idx] of indices) {
    if (!key.split('|').includes(root)) continue;
    invalidateInIndex(root, idx, relPath);
    indices.set(key, idx);
  }
}

/** Re-index one file inside one already-built index (old F1.3 behavior). */
function invalidateInIndex(root: string, idx: Index, relPath: string): void {
  const displayPath = root === idx.root ? relPath : `addons-src/${relPath}`;
  const keep = idx.docs.filter((doc) => doc.file !== displayPath);
  const rebuilt: Index = { docs: keep, inverted: new Map(), avgDocLen: idx.avgDocLen, docCount: keep.length, root: idx.root };
  for (let i = 0; i < keep.length; i += 1) {
    for (const token of new Set(keep[i].tokens)) {
      let bucket = rebuilt.inverted.get(token);
      if (!bucket) { bucket = new Set(); rebuilt.inverted.set(token, bucket); }
      bucket.add(i);
    }
  }
  try {
    const content = readFileSync(path.join(root, relPath), 'utf8');
    if (!content.includes('\0')) {
      const pathTokens = new Set(tokenize(displayPath));
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += BLOCK_LINES) {
        const block = lines.slice(i, i + BLOCK_LINES).join('\n');
        const tokens = tokenize(block);
        if (tokens.length === 0) continue;
        const docIdx = rebuilt.docs.length;
        rebuilt.docs.push({ file: displayPath, lineStart: i + 1, lineCount: Math.min(BLOCK_LINES, lines.length - i), tokens, boostTokens: pathTokens, text: block });
        for (const token of new Set(tokens)) {
          let bucket = rebuilt.inverted.get(token);
          if (!bucket) { bucket = new Set(); rebuilt.inverted.set(token, bucket); }
          bucket.add(docIdx);
        }
      }
    }
  } catch {
    // file deleted — dropping its docs above is enough
  }
  const totalLen = rebuilt.docs.reduce((sum, doc) => sum + doc.tokens.length, 0);
  rebuilt.avgDocLen = rebuilt.docs.length > 0 ? totalLen / rebuilt.docs.length : 0;
  rebuilt.docCount = rebuilt.docs.length;
  Object.assign(idx, rebuilt);
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

/** Run a BM25 query across the workspace + addon sources. Top-K results. */
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
    const doc = index.docs[i];
    let s = bm25Score(i, queryTerms, index);
    if (s > 0) {
      // F1.3 boost: path tokens ×2, declared-symbol tokens ×3.
      for (const term of queryTerms) {
        if (doc.boostTokens.has(term)) s += s * 0.5;
      }
      scored.push({ docIdx: i, score: s });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, limit);
  const results: SearchResult[] = top.map(({ docIdx, score }) => {
    const doc = index.docs[docIdx];
    // F1.3 snippet: window with the highest query-term density in the block.
    let snippet = '';
    let line = doc.lineStart;
    const blockLines = doc.text.split('\n');
    let bestDensity = -1;
    let bestStart = 0;
    for (let i = 0; i < blockLines.length; i += 1) {
      const windowText = blockLines.slice(i, i + 2).join('\n').toLowerCase();
      let density = 0;
      for (const term of queryTerms) {
        if (windowText.includes(term)) density += 1;
      }
      if (density > bestDensity) { bestDensity = density; bestStart = i; }
    }
    snippet = blockLines.slice(bestStart, bestStart + 2).join('\n').trim().slice(0, 200);
    line = doc.lineStart + bestStart;
    return { file: doc.file, line, score: parseFloat(score.toFixed(3)), snippet };
  });

  return { results, totalDocs: index.docs.length, root: index.root };
}
