/**
 * IMPORT GRAPH — "what breaks if I change this file?"
 *
 * A rename/type change in `types.ts` used to be answered with
 * grep + eyeball. deps.ts parses the import/require/dynamic-import specifiers
 * of the JS/TS family (ts/tsx/js/jsx/mjs/cjs), resolves relative specifiers to
 * real files on disk, and maintains a two-way graph (imports + importedBy).
 * The agent asks about ONE file and gets: what it pulls in, what pulls IT in
 * (with a bounded BFS reachability radius), and which edges are bare packages.
 *
 * Bounded like every other walker: SKIP_DIRS, depth cap, file caps, TTL cache
 * (5 s) per workspace so repeated queries inside one tool loop stay instant.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const DEPS_SKIP_DIRS = new Set([
  'node_modules', '.git', '.data', '.moriko', '.pnpm-store', 'dist', 'build', 'out',
  'coverage', '.venv', 'venv', '__pycache__', '.next', '.turbo', '.zvec-grep',
  '.attachments',
]);

const DEPS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const MAX_GRAPH_FILES = 2500;
const MAX_GRAPH_DEPTH = 12;
const MAX_BFS_RADIUS = 3;
const CACHE_TTL_MS = 5_000;

interface DepsGraph {
  root: string;
  builtAt: number;
  /** relative path -> set of relative paths it imports */
  imports: Map<string, Set<string>>;
  /** relative path -> set of relative paths that import it */
  importedBy: Map<string, Set<string>>;
  /** relative path -> external package names (bare specifiers) */
  externals: Map<string, Set<string>>;
  filesScanned: number;
}

const graphCache = new Map<string, DepsGraph>();


/**
 * Extracts import/require/dynamic-import specifiers from ONE source file.
 * String-literal aware: an "import" inside a template string or comment is
 * skipped. Handles:
 *   import X from './y';            import type { Z } from '../z';
 *   export * from './w';            export { A } from './v';
 *   require('./u');                 await import('./t');
 *   import('./s')                   (dynamic)
 */
function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  let i = 0;
  const n = source.length;
  const push = (raw: string): void => {
    const s = raw.trim();
    if (s) specifiers.push(s);
  };

  while (i < n) {
    const ch = source[i];

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    if (
      (ch === 'i' || ch === 'e') &&
      (source.startsWith('import', i) || source.startsWith('export', i))
    ) {
      const keyword = source.startsWith('import', i) ? 'import' : 'export';
      let j = i + keyword.length;
      while (j < n && source[j] !== ';' && source[j] !== '\n' && source[j] !== "'" && source[j] !== '"') j += 1;
      if (j < n && (source[j] === "'" || source[j] === '"')) {
        const spec = readQuoted(source, j);
        if (spec) push(spec);
        i = j;
        continue;
      }
      i = j;
      continue;
    }

    if (ch === 'r' && source.startsWith('require', i)) {
      let j = i + 'require'.length;
      while (j < n && (source[j] === ' ' || source[j] === '\t')) j += 1;
      if (source[j] === '(') {
        j += 1;
        while (j < n && (source[j] === ' ' || source[j] === '\t')) j += 1;
        if (source[j] === "'" || source[j] === '"') {
          const spec = readQuoted(source, j);
          if (spec) push(spec);
        }
      }
      i += 1;
      continue;
    }
    if (ch === 'i' && source.startsWith('import(', i)) {
      let j = i + 'import('.length;
      while (j < n && (source[j] === ' ' || source[j] === '\t')) j += 1;
      if (source[j] === "'" || source[j] === '"') {
        const spec = readQuoted(source, j);
        if (spec) push(spec);
      }
      i += 1;
      continue;
    }

    i += 1;
  }
  return specifiers;
}

/** Reads a quoted literal starting at `quoteIndex`; returns its inner text. */
function readQuoted(source: string, quoteIndex: number): string | null {
  const quote = source[quoteIndex];
  let j = quoteIndex + 1;
  let out = '';
  while (j < source.length) {
    const c = source[j];
    if (c === '\\') { out += source[j + 1] ?? ''; j += 2; continue; }
    if (c === quote) return out;
    out += c;
    j += 1;
  }
  return null;
}


const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];

/** Resolves a relative specifier ('./x', '../y/z') to a real file, or null. */
function resolveSpecifier(root: string, fromFileRel: string, spec: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const fromDir = path.dirname(path.join(root, fromFileRel));
  const base = path.resolve(fromDir, spec);
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    try {
      if (statSync(candidate).isFile()) {
        return path.relative(root, candidate).split(path.sep).join('/');
      }
    } catch {
    }
  }
  return null;
}


function buildGraph(root: string): DepsGraph {
  const graph: DepsGraph = {
    root,
    builtAt: Date.now(),
    imports: new Map(),
    importedBy: new Map(),
    externals: new Map(),
    filesScanned: 0,
  };

  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_GRAPH_DEPTH || graph.filesScanned >= MAX_GRAPH_FILES) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (graph.filesScanned >= MAX_GRAPH_FILES) return;
      if (entry.isDirectory()) {
        if (DEPS_SKIP_DIRS.has(entry.name)) continue;
        visit(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!DEPS_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
      let content: string;
      try { content = readFileSync(path.join(dir, entry.name), 'utf8'); } catch { continue; }
      graph.filesScanned += 1;

      for (const spec of extractSpecifiers(content)) {
        const resolved = resolveSpecifier(root, rel, spec);
        if (resolved) {
          if (!graph.imports.has(rel)) graph.imports.set(rel, new Set());
          graph.imports.get(rel)!.add(resolved);
          if (!graph.importedBy.has(resolved)) graph.importedBy.set(resolved, new Set());
          graph.importedBy.get(resolved)!.add(rel);
        } else if (!spec.startsWith('./') && !spec.startsWith('../')) {
          const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          if (!graph.externals.has(rel)) graph.externals.set(rel, new Set());
          graph.externals.get(rel)!.add(pkg);
        }
      }
    }
  };

  visit(root, 0);
  return graph;
}

function getGraph(root: string): DepsGraph {
  const cached = graphCache.get(root);
  if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached;
  const fresh = buildGraph(root);
  graphCache.set(root, fresh);
  return fresh;
}

/** Forces a rebuild on the next query (called from the write-hook family). */
export function invalidateDepsGraph(root: string): void {
  graphCache.delete(root);
}

export interface DepsReport {
  file: string;
  imports: string[];
  importedBy: string[];
  externals: string[];
  /** Unique files reachable through importedBy within MAX_BFS_RADIUS (excluding the file itself). */
  reachableDependents: number;
  filesScanned: number;
}

/** One file's dependency report: what it pulls in, what pulls it in, blast radius. */
export function queryDeps(root: string, absoluteFile: string): DepsReport | null {
  const graph = getGraph(root);
  const rel = path.relative(root, absoluteFile).split(path.sep).join('/');
  if (!graph.imports.has(rel) && !graph.importedBy.has(rel) && !graph.externals.has(rel)) {
    return null;
  }

  const seen = new Set<string>([rel]);
  let frontier = new Set<string>(graph.importedBy.get(rel) ?? []);
  let radius = 0;
  while (frontier.size > 0 && radius < MAX_BFS_RADIUS) {
    const next = new Set<string>();
    for (const node of frontier) {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const upstream of graph.importedBy.get(node) ?? []) {
        if (!seen.has(upstream)) next.add(upstream);
      }
    }
    frontier = next;
    radius += 1;
  }
  seen.delete(rel);

  return {
    file: rel,
    imports: [...(graph.imports.get(rel) ?? [])].sort(),
    importedBy: [...(graph.importedBy.get(rel) ?? [])].sort(),
    externals: [...(graph.externals.get(rel) ?? [])].sort(),
    reachableDependents: seen.size,
    filesScanned: graph.filesScanned,
  };
}
