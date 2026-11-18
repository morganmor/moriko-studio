import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { buildUnifiedDiff, diffStatFromOps } from './diff.js';
import { morikoHome } from '../paths.js';
import { getActiveWorkspace, listWorkspaces } from './workspace.js';




const LEGACY_ROOT = path.join(morikoHome, 'vault');
const MAX_PER_FILE = 20;
const MAX_AGE_DAYS = 7;
const MAX_SNAPSHOT_BYTES = 100_000_000;

export interface VaultEntryMeta {
  id: string;
  
  originalPath: string;
  
  storedPath: string;
  
  operation: string;
  size: number;
  createdAt: number;
}

function normalizedRoot(candidate: string): string | null {
  try {
    return path.resolve(candidate);
  } catch {
    return null;
  }
}


function owningWorkspaceRoot(absolutePath: string): string | null {
  const target = normalizedRoot(absolutePath);
  if (!target) return null;
  const targetKey = target.toLowerCase();
  let best: string | null = null;
  for (const workspace of listWorkspaces()) {
    const root = normalizedRoot(workspace.path);
    if (!root) continue;
    const rootKey = root.toLowerCase();
    if (targetKey === rootKey || targetKey.startsWith(rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}


function vaultRootFor(absolutePath: string): string {
  const owner = owningWorkspaceRoot(absolutePath);
  return owner ? path.join(owner, '.moriko', 'vault') : LEGACY_ROOT;
}

function safeSession(sessionId: string | undefined): string {
  return (sessionId ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
}

function sessionDir(vaultRoot: string, sessionId: string | undefined): string {
  return path.join(vaultRoot, safeSession(sessionId));
}

function indexPath(vaultRoot: string, sessionId: string | undefined): string {
  return path.join(sessionDir(vaultRoot, sessionId), 'index.json');
}

function isVaultEntryMeta(value: unknown): value is VaultEntryMeta {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.originalPath === 'string' &&
    typeof candidate.storedPath === 'string' &&
    typeof candidate.operation === 'string' &&
    typeof candidate.size === 'number' &&
    typeof candidate.createdAt === 'number'
  );
}

function readIndex(vaultRoot: string, sessionId: string | undefined): VaultEntryMeta[] {
  const file = indexPath(vaultRoot, sessionId);
  if (!existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed.filter(isVaultEntryMeta) : [];
}

function writeIndex(vaultRoot: string, sessionId: string | undefined, entries: VaultEntryMeta[]): void {
  mkdirSync(sessionDir(vaultRoot, sessionId), { recursive: true });
  writeFileSync(indexPath(vaultRoot, sessionId), JSON.stringify(entries, null, 2), 'utf8');
}


function vaultRoots(sessionId: string | undefined): string[] {
  const roots: string[] = [];
  const pushVaultDir = (candidate: string | null | undefined): void => {
    if (!candidate) return;
    const resolved = normalizedRoot(candidate);
    if (resolved && !roots.includes(resolved)) roots.push(resolved);
  };
  const pushWorkspace = (workspacePath: string | null | undefined): void => {
    if (!workspacePath) return;
    const resolved = normalizedRoot(workspacePath);
    if (resolved) pushVaultDir(path.join(resolved, '.moriko', 'vault'));
  };
  pushWorkspace(getActiveWorkspace(sessionId)?.path);
  for (const workspace of listWorkspaces()) pushWorkspace(workspace.path);
  pushVaultDir(LEGACY_ROOT);
  return roots;
}


function insideAVault(absolutePath: string): boolean {
  const key = (normalizedRoot(absolutePath) ?? '').toLowerCase();
  return key.includes(`${path.sep}.moriko${path.sep}vault${path.sep}`);
}

export interface SnapshotOutcome {
  entry: VaultEntryMeta | null;
  
  skipped?: string;
}


export function findSnapshot(sessionId: string | undefined, snapshotId: string): VaultEntryMeta | undefined {
  for (const root of vaultRoots(sessionId)) {
    const hit = readIndex(root, sessionId).find((candidate) => candidate.id === snapshotId);
    if (hit) return hit;
  }
  return undefined;
}


export function snapshotFile(
  sessionId: string | undefined,
  absolutePath: string,
  operation: string,
): SnapshotOutcome {
  if (insideAVault(absolutePath)) return { entry: null, skipped: 'path is inside a vault (not nested)' };
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    return { entry: null, skipped: 'file does not exist (nothing to snapshot)' };
  }
  if (!stats.isFile()) return { entry: null, skipped: 'not a regular file' };
  if (stats.size > MAX_SNAPSHOT_BYTES) {
    return { entry: null, skipped: `file too large to vault (${Math.round(stats.size / 1_000_000)} MB)` };
  }

  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const base = path.basename(absolutePath).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const dir = sessionDir(vaultRootFor(absolutePath), sessionId);
  mkdirSync(dir, { recursive: true });
  const storedPath = path.join(dir, `${id}__${base}`);
  try {
    const content = readFileSync(absolutePath);
    writeFileSync(storedPath, content);
  } catch (error) {
    return { entry: null, skipped: error instanceof Error ? error.message : 'snapshot write failed' };
  }

  const entry: VaultEntryMeta = {
    id,
    originalPath: absolutePath,
    storedPath,
    operation,
    size: stats.size,
    createdAt: Date.now(),
  };
  const root = path.dirname(dir);
  const entries = readIndex(root, sessionId);
  entries.push(entry);
  writeIndex(root, sessionId, entries);
  sweepVault(sessionId);
  return { entry };
}


export function snapshotTree(
  sessionId: string | undefined,
  absolutePath: string,
  operation: string,
): { files: number; bytes: number; skipped: string[] } {
  const collected: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || collected.length >= 2000) return;
    let items;
    try {
      items = readdirSafe(dir);
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(full, depth + 1);
      else if (stats.isFile()) collected.push(full);
    }
  };
  const stats = (() => {
    try {
      return statSync(absolutePath);
    } catch {
      return null;
    }
  })();
  if (!stats) return { files: 0, bytes: 0, skipped: [] };
  if (stats.isFile()) {
    const outcome = snapshotFile(sessionId, absolutePath, operation);
    return { files: outcome.entry ? 1 : 0, bytes: outcome.entry?.size ?? 0, skipped: outcome.entry ? [] : [outcome.skipped ?? ''] };
  }
  walk(absolutePath, 0);
  let bytes = 0;
  let files = 0;
  const skipped: string[] = [];
  for (const file of collected) {
    const outcome = snapshotFile(sessionId, file, operation);
    if (outcome.entry) {
      files += 1;
      bytes += outcome.entry.size;
    } else if (outcome.skipped && outcome.skipped !== 'file does not exist (nothing to snapshot)') {
      skipped.push(`${file}: ${outcome.skipped}`);
    }
  }
  return { files, bytes, skipped };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function listSnapshots(sessionId: string | undefined, query?: string): VaultEntryMeta[] {
  const merged: VaultEntryMeta[] = [];
  for (const root of vaultRoots(sessionId)) {
    for (const entry of readIndex(root, sessionId)) merged.push(entry);
  }
  const filter = query?.trim().toLowerCase();
  const filtered = filter
    ? merged.filter((entry) => entry.originalPath.toLowerCase().includes(filter))
    : merged;
  return [...filtered].sort((a, b) => b.createdAt - a.createdAt);
}


export interface RestoreRange {
  from: number;
  to: number;
}

export interface RestoreOutcome {
  target: string;
  entry: VaultEntryMeta;
  
  diff?: string;
  
  diffstat?: { added: number; removed: number };
  
  previousEntryId?: string;
  
  range?: RestoreRange;
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}


export function restoreSnapshot(
  sessionId: string | undefined,
  snapshotId: string,
  toPath?: string,
  range?: RestoreRange,
): RestoreOutcome {
  const entry = findSnapshot(sessionId, snapshotId);
  if (!entry) {
    throw new Error(`No vault snapshot with id "${snapshotId}" in this session (try vault_list).`);
  }
  if (!existsSync(entry.storedPath)) {
    throw new Error(`Snapshot file is missing on disk (purged?): ${entry.storedPath}`);
  }
  const target = toPath?.trim() ? path.resolve(toPath.trim()) : entry.originalPath;

  let diff: string | undefined;
  let diffstat: ReturnType<typeof diffStatFromOps>;
  let previousEntryId: string | undefined;
  if (existsSync(target)) {
    const pre = snapshotFile(sessionId, target, 'pre-restore');
    previousEntryId = pre.entry?.id;
  } else if (range) {
    throw new Error('Range restore needs an existing target file (a full restore would create it).');
  }

  if (range) {
    const before = readFileSync(target, 'utf8');
    const snapshotText = readFileSync(entry.storedPath, 'utf8');
    const cur = splitLines(before);
    const snap = splitLines(snapshotText);
    const from = Math.max(1, Math.floor(range.from));
    const to = Math.min(cur.length, Math.floor(range.to));
    if (from > to) throw new Error(`Invalid range ${from}..${to} (target has ${cur.length} lines).`);
    if (to > snap.length) {
      throw new Error(`Range ${from}..${to} exceeds the snapshot (${snap.length} lines) — pick a range inside it.`);
    }
    const merged = [...cur.slice(0, from - 1), ...snap.slice(from - 1, to), ...cur.slice(to)];
    const after = merged.join('\n');
    writeFileSync(target, after, 'utf8');
    try {
      diff = buildUnifiedDiff(before, after, target);
      diffstat = diffStatFromOps(before, after);
    } catch {
      diff = undefined;
    }
    return { target, entry, diff, diffstat, previousEntryId, range: { from, to } };
  }

  if (existsSync(target)) {
    try {
      const before = readFileSync(target, 'utf8');
      const after = readFileSync(entry.storedPath, 'utf8');
      if (!/\u0000/.test(before.slice(0, 2000)) && !/\u0000/.test(after.slice(0, 2000))) {
        diff = buildUnifiedDiff(before, after, target);
        diffstat = diffStatFromOps(before, after);
      }
    } catch {
      diff = undefined;
    }
  }

  mkdirSync(path.dirname(target), { recursive: true });
  const content = readFileSync(entry.storedPath);
  writeFileSync(target, content);
  return { target, entry, diff, diffstat, previousEntryId };
}


export function purgeSnapshot(sessionId: string | undefined, snapshotId: string): boolean {
  for (const root of vaultRoots(sessionId)) {
    const entries = readIndex(root, sessionId);
    const entry = entries.find((candidate) => candidate.id === snapshotId);
    if (!entry) continue;
    try {
      rmSync(entry.storedPath, { force: true });
    } catch {
    }
    writeIndex(root, sessionId, entries.filter((candidate) => candidate.id !== snapshotId));
    return true;
  }
  return false;
}


export function sweepVault(sessionId: string | undefined): void {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const root of vaultRoots(sessionId)) {
    const entries = readIndex(root, sessionId);
    if (entries.length === 0) continue;
    const perFile = new Map<string, VaultEntryMeta[]>();
    for (const entry of entries) {
      const list = perFile.get(entry.originalPath) ?? [];
      list.push(entry);
      perFile.set(entry.originalPath, list);
    }
    const keep: VaultEntryMeta[] = [];
    const removed: VaultEntryMeta[] = [];
    for (const list of perFile.values()) {
      list.sort((a, b) => b.createdAt - a.createdAt);
      list.forEach((entry, index) => {
        if (entry.createdAt < cutoff || index >= MAX_PER_FILE) removed.push(entry);
        else keep.push(entry);
      });
    }
    if (removed.length === 0) continue;
    for (const entry of removed) {
      try {
        rmSync(entry.storedPath, { force: true });
      } catch {
      }
    }
    writeIndex(root, sessionId, keep);
  }
}
