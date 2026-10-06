/**
 * REALTIME PROJECT STRUCTURE (Fase B) — the in-memory tree index.
 *
 * ONE `WorkspaceTree` per workspace id, held in a module-level Map. The FIRST
 * consumer triggers a single directory walk (with ignore rules + caps); after
 * that every consumer — the user's floating panel, `agent__tree_outline`, the
 * SSE channel — reads MEMORY ONLY. This is the I/O-bottleneck prevention the
 * feature exists for: a 20k-file workspace answers outline requests without
 * touching the disk, and filesystem changes arrive as WATCHER DELTAS instead
 * of re-walks.
 *
 * Persistence (B.3): the index snapshot + the workspace's custom ignore rules
 * live in `~/.moriko/tree-index/<workspaceId>.json` (atomicWriteJson), loaded
 * LAZILY on first use after a restart — a cold boot does not re-walk every
 * registered workspace, and the panel still renders instantly from the
 * snapshot while a fresh walk validates it in the background.
 *
 * Watcher (B.2): `fs.watch(root, { recursive: true })` — native on Windows
 * (ReadDirectoryChangesW) and macOS; on Linux recursive is not supported, so
 * the watcher transparently falls back to per-top-level-dir watchers.
 * Events are debounced 300 ms, classified, and applied to the in-memory tree
 * as a delta; every applied change bumps `version` and fires the change
 * listeners (the SSE channel fans them out).
 */
import { watch, type FSWatcher } from 'node:fs';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../atomicWrite.js';
import { treeIndexDir } from '../paths.js';
import { listWorkspaces } from './workspace.js';


/** One node of the in-memory tree. */
export interface TreeNode {
  name: string;
  /** Path relative to the workspace root, POSIX separators ('src/lib/api.ts'). */
  relPath: string;
  kind: 'dir' | 'file';
  /** Direct children (sorted: dirs first, then case-insensitive by name). */
  children: TreeNode[];
  /** File size in bytes (0 for dirs). */
  size: number;
  /** mtime (ms) — the watcher's no-op delta filter. */
  mtimeMs: number;
  /** Set when depth/node caps or read errors cut this subtree short. */
  truncated?: boolean;
}

/** Custom ignore rules persisted PER WORKSPACE (the panel edits these). */
export interface IgnoreRules {
  /** Extra directory names to skip (in addition to the built-ins). */
  dirs: string[];
  /** Extra suffix/wildcard patterns, e.g. '*.log', '*.tmp', 'secrets*'. */
  patterns: string[];
}

export interface TreeStats {
  files: number;
  dirs: number;
  totalBytes: number;
  truncated: boolean;
}

export interface TreeView {
  root: TreeNode;
  version: number;
  stats: TreeStats;
  builtAt: number;
  /** True while a background rebuild is walking (view is still served). */
  refreshing: boolean;
}

export interface TreeChangeEvent {
  workspaceId: string;
  version: number;
  op: 'add' | 'change' | 'remove' | 'rebuild';
  relPath: string;
  kind: 'dir' | 'file';
  /**
   * Post-apply node body for add/change (dirs arrive WITH their children) —
   * clients upsert the real subtree without a round-trip. Absent on remove.
   */
  node?: TreeNode;
}

interface TreeSnapshot {
  version: 1;
  workspaceId: string;
  workspacePath: string;
  builtAt: number;
  rules: IgnoreRules;
  stats: TreeStats;
  root: TreeNode;
}

interface WorkspaceTree {
  workspaceId: string;
  workspacePath: string;
  root: TreeNode;
  builtAt: number;
  rules: IgnoreRules;
  stats: TreeStats;
  version: number;
  walking: Promise<void> | null;
  watcher: FSWatcher | null;
  /** Per-top-level-dir fallback (Linux, where recursive watch is unsupported). */
  fallbackWatchers: FSWatcher[];
  debounceTimer: NodeJS.Timeout | null;
  pendingPaths: Set<string>;
  listeners: Set<(event: TreeChangeEvent) => void>;
  lastPersistAt: number;
}

const DEBOUNCE_MS = 300;
export const TREE_DEPTH_CAP = 8;
export const TREE_NODE_CAP = 20_000;
const PERSIST_MIN_INTERVAL_MS = 2000;
const SNAPSHOT_MAX_AGE_MS = 30_000;

/** Built-in ignores — ALWAYS on. Heavy/generated dirs + OS noise. */
const BUILTIN_IGNORED_DIRS = new Set([
  'node_modules', '.git', '.data', '.moriko', '.pnpm-store', 'dist', 'build', 'out',
  'coverage', '.venv', 'venv', '__pycache__', '.next', '.turbo', '.zvec-grep',
  '.attachments', '.idea', '.cache', 'target', 'vendor',
]);
const BUILTIN_IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** ONE tree per workspace id — the whole module's purpose. */
const trees = new Map<string, WorkspaceTree>();


function defaultRules(): IgnoreRules {
  return { dirs: [], patterns: [] };
}

function sanitizeRules(input: unknown): IgnoreRules {
  const raw = (input ?? {}) as { dirs?: unknown; patterns?: unknown };
  const pick = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0 && entry.length <= 64)
          .slice(0, 64)
      : [];
  return { dirs: pick(raw.dirs), patterns: pick(raw.patterns) };
}

/** Tiny glob: '*' wildcards within a name; otherwise a suffix/prefix match. */
function compilePattern(pattern: string): RegExp | null {
  const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*');
  if (!escaped) return null;
  try {
    return new RegExp(`(^|[/\\\\])${escaped}$`, 'i');
  } catch {
    return null;
  }
}

function isIgnoredDir(name: string, rules: IgnoreRules): boolean {
  return BUILTIN_IGNORED_DIRS.has(name) || rules.dirs.some((entry) => entry.toLowerCase() === name.toLowerCase());
}

function isIgnoredFile(relPath: string, name: string, rules: IgnoreRules): boolean {
  if (BUILTIN_IGNORED_NAMES.has(name)) return true;
  if (rules.patterns.length === 0) return false;
  for (const pattern of rules.patterns) {
    if (!pattern.includes('*')) {
      if (name.toLowerCase() === pattern.toLowerCase()) return true;
      if (name.toLowerCase().endsWith(pattern.toLowerCase())) return true;
      continue;
    }
    const regexp = compilePattern(pattern);
    if (regexp?.test(relPath)) return true;
  }
  return false;
}


function safeStat(absPath: string): { size: number; mtimeMs: number } | null {
  try {
    const stats = statSync(absPath);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

function walkDir(absDir: string, relDir: string, depth: number, rules: IgnoreRules, budget: { nodes: number }): TreeNode {
  const node: TreeNode = {
    name: path.basename(absDir) || absDir,
    relPath: relDir,
    kind: 'dir',
    children: [],
    size: 0,
    mtimeMs: safeStat(absDir)?.mtimeMs ?? 0,
  };
  if (depth >= TREE_DEPTH_CAP) {
    node.truncated = true;
    return node;
  }

  let dirents: Array<{ name: string; isDirectory: boolean; isFile: boolean }> = [];
  try {
    dirents = readdirSync(absDir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
  } catch {
    node.truncated = true;
    return node;
  }

  const childDirs: Array<{ name: string; abs: string }> = [];
  const childFiles: Array<{ name: string; abs: string }> = [];
  for (const dirent of dirents) {
    const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory) {
      if (isIgnoredDir(dirent.name, rules)) continue;
      childDirs.push({ name: dirent.name, abs: path.join(absDir, dirent.name) });
    } else if (dirent.isFile) {
      if (isIgnoredFile(relPath, dirent.name, rules)) continue;
      childFiles.push({ name: dirent.name, abs: path.join(absDir, dirent.name) });
    }
  }

  childDirs.sort((a, b) => a.name.localeCompare(b.name));
  childFiles.sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of childDirs) {
    if (budget.nodes >= TREE_NODE_CAP) {
      node.truncated = true;
      break;
    }
    budget.nodes += 1;
    node.children.push(walkDir(dir.abs, `${relDir ? `${relDir}/` : ''}${dir.name}`, depth + 1, rules, budget));
  }
  for (const file of childFiles) {
    if (budget.nodes >= TREE_NODE_CAP) {
      node.truncated = true;
      break;
    }
    budget.nodes += 1;
    const stats = safeStat(file.abs);
    node.children.push({
      name: file.name,
      relPath: `${relDir ? `${relDir}/` : ''}${file.name}`,
      kind: 'file',
      children: [],
      size: stats?.size ?? 0,
      mtimeMs: stats?.mtimeMs ?? 0,
    });
  }

  return node;
}

function computeStats(root: TreeNode): TreeStats {
  let files = 0;
  let dirs = 0;
  let totalBytes = 0;
  let truncated = false;
  const visit = (node: TreeNode): void => {
    if (node.truncated) truncated = true;
    if (node.kind !== 'dir') {
      files += 1;
      totalBytes += node.size;
      return;
    }
    dirs += 1;
    for (const child of node.children) visit(child);
  };
  visit(root);
  return { files, dirs, totalBytes, truncated };
}


function snapshotFile(workspaceId: string): string {
  return path.join(treeIndexDir, `${workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function persistTree(tree: WorkspaceTree): void {
  try {
    const snapshot: TreeSnapshot = {
      version: 1,
      workspaceId: tree.workspaceId,
      workspacePath: tree.workspacePath,
      builtAt: tree.builtAt,
      rules: tree.rules,
      stats: tree.stats,
      root: tree.root,
    };
    atomicWriteJson(snapshotFile(tree.workspaceId), snapshot);
    tree.lastPersistAt = Date.now();
  } catch (error) {
    console.error('[treeIndex] snapshot persist failed:', error);
  }
}

function loadSnapshot(workspaceId: string): TreeSnapshot | null {
  try {
    const file = snapshotFile(workspaceId);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as TreeSnapshot;
    if (parsed?.version !== 1 || !parsed?.root || parsed.workspaceId !== workspaceId) return null;
    parsed.rules = sanitizeRules(parsed.rules);
    return parsed;
  } catch {
    return null;
  }
}


function toRelPath(root: string, absPath: string): string | null {
  const rel = path.relative(root, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function findNode(root: TreeNode, relPath: string): TreeNode | null {
  if (!relPath) return root;
  let current: TreeNode = root;
  for (const part of relPath.split('/')) {
    if (current.kind !== 'dir') return null;
    const next = current.children.find((child) => child.name === part);
    if (!next) return null;
    current = next;
  }
  return current;
}

function removeNode(root: TreeNode, relPath: string): boolean {
  const parts = relPath.split('/');
  const parent = parts.length > 1 ? findNode(root, parts.slice(0, -1).join('/')) : root;
  if (!parent || parent.kind !== 'dir') return false;
  const name = parts[parts.length - 1];
  const index = parent.children.findIndex((child) => child.name === name);
  if (index === -1) return false;
  parent.children.splice(index, 1);
  return true;
}

/** Walks/creates the parent chain, keeping dirs-first order intact. */
function ensureDirChain(root: TreeNode, relDir: string, rootAbs: string): TreeNode | null {
  if (!relDir) return root;
  let current = root;
  const parts = relDir.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    let next = current.children.find((child) => child.name === parts[i] && child.kind === 'dir');
    if (!next) {
      const absDir = path.join(rootAbs, ...parts.slice(0, i + 1));
      next = {
        name: parts[i],
        relPath: parts.slice(0, i + 1).join('/'),
        kind: 'dir',
        children: [],
        size: 0,
        mtimeMs: safeStat(absDir)?.mtimeMs ?? 0,
      };
      current.children.push(next);
    }
    current = next;
  }
  return current;
}

function insertFileNode(root: TreeNode, relPath: string, rootAbs: string): void {
  const parent = ensureDirChain(root, path.dirname(relPath) === '.' ? '' : path.dirname(relPath), rootAbs);
  if (!parent) return;
  removeNode(parent, path.basename(relPath));
  const absFile = path.join(rootAbs, relPath);
  const stats = safeStat(absFile);
  const node: TreeNode = {
    name: path.basename(relPath),
    relPath,
    kind: 'file',
    children: [],
    size: stats?.size ?? 0,
    mtimeMs: stats?.mtimeMs ?? 0,
  };
  const index = parent.children.findIndex((child) => child.kind === 'file' && child.name.localeCompare(node.name) > 0);
  if (index === -1) parent.children.push(node);
  else parent.children.splice(index, 0, node);
}

function insertDirNode(root: TreeNode, relPath: string, rootAbs: string): void {
  const parent = ensureDirChain(root, path.dirname(relPath) === '.' ? '' : path.dirname(relPath), rootAbs);
  if (!parent) return;
  const name = path.basename(relPath);
  removeNode(parent, name);
  const node: TreeNode = {
    name,
    relPath,
    kind: 'dir',
    children: [],
    size: 0,
    mtimeMs: safeStat(path.join(rootAbs, relPath))?.mtimeMs ?? 0,
  };
  const index = parent.children.findIndex((child) => child.kind === 'file' || child.name.localeCompare(name) > 0);
  if (index === -1) parent.children.push(node);
  else parent.children.splice(index, 0, node);
}

/** Classify one debounced watcher event against the CURRENT index. */
function classifyPath(tree: WorkspaceTree, absPath: string): TreeChangeEvent | null {
  const relPath = toRelPath(tree.workspacePath, absPath);
  if (!relPath) return null;
  const name = path.basename(relPath);
  const topLevel = !relPath.includes('/');

  let stats: ReturnType<typeof safeStat> = null;
  let isDir = false;
  try {
    const st = statSync(absPath);
    isDir = st.isDirectory();
    stats = { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    const existing = findNode(tree.root, relPath);
    if (!existing) return null;
    if (existing.kind === 'dir' && existing.children.length > 0 && !topLevel) {
      return { workspaceId: tree.workspaceId, version: tree.version, op: 'rebuild', relPath, kind: 'dir' };
    }
    return { workspaceId: tree.workspaceId, version: tree.version, op: 'remove', relPath, kind: existing.kind };
  }

  if (isDir) {
    if (isIgnoredDir(name, tree.rules) && topLevel) return null;
    const existing = findNode(tree.root, relPath);
    if (existing?.kind === 'dir') return null;
    return { workspaceId: tree.workspaceId, version: tree.version, op: 'add', relPath, kind: 'dir' };
  }

  if (BUILTIN_IGNORED_NAMES.has(name) || isIgnoredFile(relPath, name, tree.rules)) return null;
  const existing = findNode(tree.root, relPath);
  if (existing?.kind === 'file') {
    if (existing.mtimeMs === stats.mtimeMs && existing.size === stats.size) return null;
    return { workspaceId: tree.workspaceId, version: tree.version, op: 'change', relPath, kind: 'file' };
  }
  if (existing?.kind === 'dir') return null;
  return { workspaceId: tree.workspaceId, version: tree.version, op: 'add', relPath, kind: 'file' };
}

function applyDebounced(tree: WorkspaceTree): void {
  const batch = [...tree.pendingPaths];
  tree.pendingPaths.clear();
  if (batch.length === 0) return;

  const events: TreeChangeEvent[] = [];
  for (const absPath of batch) {
    const event = classifyPath(tree, absPath);
    if (event) events.push(event);
  }
  if (events.length === 0) return;

  tree.version += 1;
  for (const event of events) event.version = tree.version;

  let needsRebuild = false;
  for (const event of events) {
    const absPath = path.join(tree.workspacePath, event.relPath);
    if (event.op === 'rebuild') {
      needsRebuild = true;
      continue;
    }
    if (event.op === 'remove') {
      removeNode(tree.root, event.relPath);
    } else if (event.kind === 'dir') {
      insertDirNode(tree.root, event.relPath, tree.workspacePath);
      try {
        const budget = { nodes: 0 };
        const fresh = findNode(tree.root, event.relPath);
        if (fresh?.children.length === 0) {
          fresh.children = walkDir(absPath, event.relPath, relDepth(event.relPath), tree.rules, budget).children;
        }
      } catch {
      }
    } else {
      insertFileNode(tree.root, event.relPath, tree.workspacePath);
    }
  }

  tree.stats = computeStats(tree.root);
  tree.builtAt = Date.now();

  for (const event of events) {
    if (event.op === 'add' || event.op === 'change') {
      event.node = findNode(tree.root, event.relPath) ?? undefined;
    }
  }

  for (const listener of tree.listeners) {
    for (const event of events) {
      try {
        listener(event);
      } catch (error) {
        console.error('[treeIndex] listener failed:', error);
      }
    }
  }

  if (needsRebuild) {
    void refreshTree(tree.workspaceId);
    return;
  }

  if (Date.now() - tree.lastPersistAt > PERSIST_MIN_INTERVAL_MS) persistTree(tree);
}

function relDepth(relPath: string): number {
  return relPath.split('/').length;
}

function startWatcher(tree: WorkspaceTree): void {
  if (tree.watcher) return;
  try {
    tree.watcher = watch(tree.workspacePath, { recursive: true, persistent: false }, (_eventType, filename) => {
      const absPath = filename ? path.join(tree.workspacePath, filename.toString()) : tree.workspacePath;
      tree.pendingPaths.add(absPath);
      scheduleApply(tree);
    });
    tree.watcher.on('error', () => stopWatcher(tree));
    return;
  } catch {
  }
  try {
    for (const entry of readdirSync(tree.workspacePath, { withFileTypes: true })) {
      if (!entry.isDirectory() || isIgnoredDir(entry.name, tree.rules)) continue;
      const dirPath = path.join(tree.workspacePath, entry.name);
      try {
        const child = watch(dirPath, { persistent: false }, (_event, filename) => {
          tree.pendingPaths.add(path.join(dirPath, filename?.toString() ?? ''));
          scheduleApply(tree);
        });
        tree.fallbackWatchers.push(child);
      } catch {
      }
    }
  } catch {
  }
}

function scheduleApply(tree: WorkspaceTree): void {
  if (tree.debounceTimer) return;
  tree.debounceTimer = setTimeout(() => {
    tree.debounceTimer = null;
    try {
      applyDebounced(tree);
    } catch (error) {
      console.error('[treeIndex] apply failed:', error);
    }
  }, DEBOUNCE_MS);
}

function stopWatcher(tree: WorkspaceTree): void {
  try {
    tree.watcher?.close();
  } catch {
  }
  tree.watcher = null;
  for (const child of tree.fallbackWatchers) {
    try {
      child.close();
    } catch {
    }
  }
  tree.fallbackWatchers = [];
  if (tree.debounceTimer) {
    clearTimeout(tree.debounceTimer);
    tree.debounceTimer = null;
  }
}


function emptyRoot(workspacePath: string): TreeNode {
  return { name: path.basename(workspacePath) || 'workspace', relPath: '', kind: 'dir', children: [], size: 0, mtimeMs: 0 };
}

/**
 * The ONE entry point every consumer shares (panel SSE bootstrap, REST GET,
 * agent tool). Serves MEMORY (or the persisted snapshot on first touch after
 * a restart); a stale/absent snapshot triggers exactly one background walk.
 */
export function getTree(workspaceId: string): TreeView | null {
  const workspace = listWorkspaces().find((entry) => entry.id === workspaceId);
  if (!workspace || !existsSync(workspace.path)) return null;

  let tree = trees.get(workspaceId);
  if (!tree) {
    const snapshot = loadSnapshot(workspaceId);
    tree = {
      workspaceId,
      workspacePath: workspace.path,
      root: snapshot?.root ?? emptyRoot(workspace.path),
      builtAt: snapshot?.builtAt ?? 0,
      rules: snapshot?.rules ?? defaultRules(),
      stats: snapshot?.stats ?? { files: 0, dirs: 0, totalBytes: 0, truncated: false },
      version: 1,
      walking: null,
      watcher: null,
      fallbackWatchers: [],
      debounceTimer: null,
      pendingPaths: new Set(),
      listeners: new Set(),
      lastPersistAt: 0,
    };
    trees.set(workspaceId, tree);
    startWatcher(tree);
    if (!snapshot || Date.now() - snapshot.builtAt > SNAPSHOT_MAX_AGE_MS) void refreshTree(workspaceId);
  } else if (tree.workspacePath !== workspace.path) {
    tree.workspacePath = workspace.path;
    tree.pendingPaths.clear();
    stopWatcher(tree);
    startWatcher(tree);
    void refreshTree(workspaceId);
  }

  return { root: tree.root, version: tree.version, stats: tree.stats, builtAt: tree.builtAt, refreshing: tree.walking !== null };
}

/** Full rebuild — ONE walk on a setImmediate; concurrent calls share it. */
export function refreshTree(workspaceId: string): Promise<void> {
  const existing = trees.get(workspaceId);
  if (existing?.walking) return existing.walking;
  const workspace = listWorkspaces().find((entry) => entry.id === workspaceId);
  if (!workspace || !existsSync(workspace.path)) return Promise.resolve();

  const tree = existing ?? {
    workspaceId,
    workspacePath: workspace.path,
    root: emptyRoot(workspace.path),
    builtAt: 0,
    rules: loadSnapshot(workspaceId)?.rules ?? defaultRules(),
    stats: { files: 0, dirs: 0, totalBytes: 0, truncated: false },
    version: 1,
    walking: null,
    watcher: null,
    fallbackWatchers: [],
    debounceTimer: null,
    pendingPaths: new Set(),
    listeners: new Set(),
    lastPersistAt: 0,
  };
  if (!existing) {
    trees.set(workspaceId, tree);
    startWatcher(tree);
  }

  const walking = new Promise<void>((resolve) => {
    setImmediate(() => {
      try {
        const budget = { nodes: 1 };
        tree.root = walkDir(workspace.path, '', 0, tree.rules, budget);
        tree.stats = computeStats(tree.root);
        tree.builtAt = Date.now();
        tree.version += 1;
        persistTree(tree);
        const event: TreeChangeEvent = { workspaceId, version: tree.version, op: 'rebuild', relPath: '', kind: 'dir' };
        for (const listener of tree.listeners) {
          try {
            listener(event);
          } catch {
          }
        }
      } catch (error) {
        console.error('[treeIndex] rebuild failed:', error);
      } finally {
        tree.walking = null;
        resolve();
      }
    });
  });
  tree.walking = walking;
  return walking;
}

/** The panel's ignore-rule editor — rules live in the snapshot file. */
export function getRules(workspaceId: string): IgnoreRules {
  return trees.get(workspaceId)?.rules ?? loadSnapshot(workspaceId)?.rules ?? defaultRules();
}

export function setRules(workspaceId: string, rules: IgnoreRules): IgnoreRules {
  const tree = trees.get(workspaceId);
  const clean = sanitizeRules(rules);
  if (!tree) {
    const snapshot = loadSnapshot(workspaceId);
    if (snapshot) {
      snapshot.rules = clean;
      try {
        atomicWriteJson(snapshotFile(workspaceId), snapshot);
      } catch {
      }
    }
    return clean;
  }
  tree.rules = clean;
  void refreshTree(workspaceId);
  return clean;
}

/** Subscribe to deltas (the SSE channel). Returns an unsubscribe function. */
export function subscribeTree(workspaceId: string, listener: (event: TreeChangeEvent) => void): () => void {
  const tree = trees.get(workspaceId);
  if (!tree) return () => undefined;
  tree.listeners.add(listener);
  return () => {
    tree.listeners.delete(listener);
  };
}

/** Workspace removed from the registry — drop its tree + snapshot entirely. */
export function dropTree(workspaceId: string): void {
  const tree = trees.get(workspaceId);
  if (tree) {
    stopWatcher(tree);
    tree.listeners.clear();
    trees.delete(workspaceId);
  }
  try {
    unlinkSync(snapshotFile(workspaceId));
  } catch {
  }
}

/**
 * ASCII outline for `agent__tree_outline` — rendered from MEMORY (no disk).
 * `filter` keeps dirs that CONTAIN a match (so structure stays readable).
 */
export function outlineFromMemory(
  workspaceId: string,
  opts: { depth?: number; filter?: string; maxEntries?: number } = {},
): string | null {
  const peek = peekTree(workspaceId);
  if (!peek) return null;
  const maxDepth = Math.max(1, Math.min(opts.depth ?? 3, TREE_DEPTH_CAP));
  const filter = (opts.filter ?? '').trim().toLowerCase();
  const maxEntries = Math.max(10, Math.min(opts.maxEntries ?? 300, 1000));

  const lines: string[] = [
    `${peek.root.name}/  (${peek.stats.files} file(s), ${Math.max(0, peek.stats.dirs - 1)} dir(s)${peek.stats.truncated ? ', truncated' : ''}, v${peek.version})`,
  ];
  let count = 0;
  let cut = false;

  const subtreeMatches = (node: TreeNode): boolean => {
    if (!filter) return true;
    if (node.name.toLowerCase().includes(filter)) return true;
    return node.children.some((child) => (child.kind === 'dir' ? subtreeMatches(child) : child.name.toLowerCase().includes(filter)));
  };

  const visit = (node: TreeNode, depth: number, prefix: string): void => {
    for (const child of node.children) {
      if (count >= maxEntries) {
        cut = true;
        return;
      }
      if (filter && child.kind === 'file' && !child.name.toLowerCase().includes(filter)) continue;
      if (filter && child.kind === 'dir' && !subtreeMatches(child)) continue;
      const index = node.children.indexOf(child);
      const last = index === node.children.length - 1;
      const branch = last ? '└─ ' : '├─ ';
      const label = child.kind === 'dir' ? `${child.name}/` : `${child.name}  (${formatBytes(child.size)})`;
      lines.push(`${prefix}${branch}${label}${child.truncated ? ' ⋯' : ''}`);
      count += 1;
      if (child.kind === 'dir' && depth + 1 < maxDepth) {
        visit(child, depth + 1, `${prefix}${last ? '   ' : '│  '}`);
      }
    }
  };

  visit(peek.root, 0, '');
  if (cut) lines.push(`… capped at ${maxEntries} entries — narrow with { filter } or lower { depth }.`);
  return lines.join('\n');
}

/** Memory-only lookup — the agent tool's fast path. */
export function peekTree(workspaceId: string): TreeView | null {
  const tree = trees.get(workspaceId);
  if (!tree) return null;
  return { root: tree.root, version: tree.version, stats: tree.stats, builtAt: tree.builtAt, refreshing: tree.walking !== null };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}