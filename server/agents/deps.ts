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
import ts from 'typescript';

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
  /** relative path -> relative specifiers that failed to resolve (F1.1) */
  unresolved: Map<string, Set<string>>;
  filesScanned: number;
}

const graphCache = new Map<string, DepsGraph>();

function isFile(absPath: string): boolean {
  try { return statSync(absPath).isFile(); } catch { return false; }
}

function toRel(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join('/');
}

/** tsconfig `paths`/`baseUrl` support (F1.1) — cached per tsconfig file. */
interface AliasConfig {
  baseUrl: string;
  /** alias pattern (without trailing *) -> prefix replacement target. */
  paths: Array<[string, string]>;
}
const aliasCache = new Map<string, AliasConfig | null>();

function findTsconfig(root: string): string | null {
  try {
    return ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json') ?? null;
  } catch {
    return null;
  }
}

function loadAliasConfig(root: string): AliasConfig | null {
  const tsconfigPath = findTsconfig(root);
  if (!tsconfigPath) return null;
  if (aliasCache.has(tsconfigPath)) return aliasCache.get(tsconfigPath) ?? null;
  let config: AliasConfig | null = null;
  try {
    const raw = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(raw.config ?? {}, ts.sys, path.dirname(tsconfigPath));
    const pathsRaw = parsed.options.paths;
    const baseUrl = parsed.options.baseUrl;
    if (baseUrl && pathsRaw && typeof pathsRaw === 'object') {
      const paths: Array<[string, string]> = [];
      for (const [pattern, targets] of Object.entries(pathsRaw as Record<string, string[]>)) {
        const target = Array.isArray(targets) ? targets[0] : undefined;
        if (typeof target !== 'string') continue;
        paths.push([pattern.replace(/\*$/, ''), target.replace(/\*$/, '')]);
      }
      if (paths.length > 0) config = { baseUrl: path.resolve(path.dirname(tsconfigPath), baseUrl), paths };
    }
  } catch {
    config = null;
  }
  aliasCache.set(tsconfigPath, config);
  return config;
}

/** Resolves a non-relative specifier through tsconfig paths aliases (F1.1). */
function resolveTsconfigAlias(root: string, spec: string): string | null {
  if (spec.startsWith('node:')) return null;
  const cfg = loadAliasConfig(root);
  if (!cfg) return null;
  for (const [prefix, targetPrefix] of cfg.paths) {
    if (!spec.startsWith(prefix)) continue;
    const rest = spec.slice(prefix.length);
    const candidate = path.resolve(cfg.baseUrl, targetPrefix, rest);
    for (const suffix of RESOLVE_SUFFIXES) {
      if (isFile(`${candidate}${suffix}`)) return toRel(root, `${candidate}${suffix}`);
    }
    const ext = path.extname(candidate).toLowerCase();
    const swaps = EXT_SWAPS[ext];
    if (swaps) {
      const stem = candidate.slice(0, candidate.length - ext.length);
      for (const swap of swaps) {
        if (isFile(`${stem}${swap}`)) return toRel(root, `${stem}${swap}`);
      }
    }
  }
  return null;
}


/**
 * F1.1 — extract import/require/dynamic-import specifiers via the TypeScript
 * scanner (preProcessFile). Kills the manual scanner's false positives
 * (e.g. `export const X = new Set(['.png'])` misread as an import) and covers
 * dynamic import + require in one pass.
 */
function extractSpecifiers(source: string): string[] {
  try {
    const pre = ts.preProcessFile(source, true, true);
    const out: string[] = [];
    for (const ref of pre.importedFiles) {
      const s = ref.fileName.trim();
      if (s) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];

/** TS ESM convention: a `.js` specifier may point at a `.ts` sibling (F1.1). */
const EXT_SWAPS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.js'],
  '.jsx': ['.tsx', '.ts', '.jsx'],
  '.mjs': ['.mts', '.ts', '.mjs'],
  '.cjs': ['.cts', '.ts', '.cjs'],
};

/** Resolves a relative specifier ('./x', '../y/z') to a real file, or null.
 *  Handles the TS ESM `.js` → `.ts` mapping plus tsconfig `paths` aliases. */
function resolveSpecifier(root: string, fromFileRel: string, spec: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    return resolveTsconfigAlias(root, spec);
  }
  const fromDir = path.dirname(path.join(root, fromFileRel));
  const base = path.resolve(fromDir, spec);
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (isFile(candidate)) return toRel(root, candidate);
  }
  const ext = path.extname(base).toLowerCase();
  const swaps = EXT_SWAPS[ext];
  if (swaps) {
    const stem = base.slice(0, base.length - ext.length);
    for (const swap of swaps) {
      const candidate = `${stem}${swap}`;
      if (isFile(candidate)) return toRel(root, candidate);
    }
    for (const swap of swaps) {
      const candidate = `${stem}${swap}/index${swap}`;
      if (isFile(candidate)) return toRel(root, candidate);
    }
  }
  return resolveTsconfigAlias(root, spec);
}


function buildGraph(root: string): DepsGraph {
  const graph: DepsGraph = {
    root,
    builtAt: Date.now(),
    imports: new Map(),
    importedBy: new Map(),
    externals: new Map(),
    unresolved: new Map(),
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
        } else if (spec.startsWith('./') || spec.startsWith('../')) {
          if (!graph.unresolved.has(rel)) graph.unresolved.set(rel, new Set());
          graph.unresolved.get(rel)!.add(spec);
        } else {
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
  /** Relative specifiers that failed to resolve (F1.1). */
  unresolved: string[];
  /** Unique files reachable through importedBy within MAX_BFS_RADIUS (excluding the file itself). */
  reachableDependents: number;
  filesScanned: number;
}

/** One file's dependency report: what it pulls in, what pulls it in, blast radius. */
export function queryDeps(root: string, absoluteFile: string): DepsReport | null {
  const graph = getGraph(root);
  const rel = path.relative(root, absoluteFile).split(path.sep).join('/');
  if (
    !graph.imports.has(rel) && !graph.importedBy.has(rel) &&
    !graph.externals.has(rel) && !graph.unresolved.has(rel)
  ) {
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
    unresolved: [...(graph.unresolved.get(rel) ?? [])].sort(),
    reachableDependents: seen.size,
    filesScanned: graph.filesScanned,
  };
}
