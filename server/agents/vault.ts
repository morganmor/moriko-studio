import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { buildUnifiedDiff, diffStatFromOps } from './diff.js';
import { vaultDir } from '../paths.js';

/**
 * FILE VAULT — the safety net under destructive harness operations.
 *
 * Every overwrite (edit_file) and every delete snapshots the affected FILE
 * into `~/.moriko/vault/<sessionId>/` before the destructive step runs, with
 * a metadata index per session. Restores copy the snapshot back to the
 * original path (or anywhere else, through the normal permission gate).
 *
 * Retention keeps vault growth bounded: at most MAX_PER_FILE snapshots per
 * original file and nothing older than MAX_AGE_DAYS; the sweep runs at boot
 * and after each snapshot.
 */

const VAULT_ROOT = vaultDir;
const MAX_PER_FILE = 20;
const MAX_AGE_DAYS = 7;
const MAX_SNAPSHOT_BYTES = 100_000_000;

export interface VaultEntryMeta {
  id: string;
  /** Original absolute path the snapshot was taken from. */
  originalPath: string;
  /** Snapshot file on disk (inside the vault). */
  storedPath: string;
  /** Human operation label: "edit_file", "delete", "pre-restore", … */
  operation: string;
  size: number;
  createdAt: number;
}


function sessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
  return path.join(VAULT_ROOT, safe);
}

function indexPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'index.json');
}

function readIndex(sessionId: string): VaultEntryMeta[] {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(sessionId), 'utf8'));
    return Array.isArray(parsed) ? (parsed as VaultEntryMeta[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(sessionId: string, entries: VaultEntryMeta[]): void {
  mkdirSync(sessionDir(sessionId), { recursive: true });
  writeFileSync(indexPath(sessionId), JSON.stringify(entries, null, 2), 'utf8');
}


export interface SnapshotOutcome {
  entry: VaultEntryMeta | null;
  /** Why no snapshot was taken (only when entry is null). */
  skipped?: string;
}

/** Looks up ONE snapshot by id (no side effects) — powers vault_restore dryRun. */
export function findSnapshot(sessionId: string | undefined, snapshotId: string): VaultEntryMeta | undefined {
  return readIndex((sessionId ?? 'default').slice(0, 80)).find((candidate) => candidate.id === snapshotId);
}

/**
 * Snapshots ONE file before a destructive operation. Directories are not
 * vaulted recursively here (delete handles them entry by entry); missing
 * files snapshot as null (nothing to protect).
 */
export function snapshotFile(
  sessionId: string | undefined,
  absolutePath: string,
  operation: string,
): SnapshotOutcome {
  const session = (sessionId ?? 'default').slice(0, 80);
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
  const dir = sessionDir(session);
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
  const entries = readIndex(session);
  entries.push(entry);
  writeIndex(session, entries);
  sweepVault(session);
  return { entry };
}

/** Snapshots every file of a directory tree (bounded) before recursive delete. */
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
  const session = (sessionId ?? 'default').slice(0, 80);
  const entries = readIndex(session);
  const filter = query?.trim().toLowerCase();
  const filtered = filter
    ? entries.filter((entry) => entry.originalPath.toLowerCase().includes(filter))
    : entries;
  return [...filtered].sort((a, b) => b.createdAt - a.createdAt);
}

export interface RestoreOutcome {
  target: string;
  entry: VaultEntryMeta;
  /** Unified diff of current-file-content → restored content (text files only). */
  diff?: string;
  /** Line counts from the same ops the diff renders. */
  diffstat?: { added: number; removed: number };
  /** Content of the file that was overwritten by the restore (already snapshotted). */
  previousEntryId?: string;
}

/**
 * Restores a snapshot to its original path (or an explicit target). When a
 * file already exists at the target it is snapshotted FIRST ("pre-restore"),
 * so a restore can itself be undone.
 */
export function restoreSnapshot(
  sessionId: string | undefined,
  snapshotId: string,
  toPath?: string,
): RestoreOutcome {
  const session = (sessionId ?? 'default').slice(0, 80);
  const entries = readIndex(session);
  const entry = entries.find((candidate) => candidate.id === snapshotId);
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
    const pre = snapshotFile(session, target, 'pre-restore');
    previousEntryId = pre.entry?.id;
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

/** Permanently removes one snapshot (its file + index entry). */
export function purgeSnapshot(sessionId: string | undefined, snapshotId: string): boolean {
  const session = (sessionId ?? 'default').slice(0, 80);
  const entries = readIndex(session);
  const entry = entries.find((candidate) => candidate.id === snapshotId);
  if (!entry) return false;
  try {
    rmSync(entry.storedPath, { force: true });
  } catch {
  }
  writeIndex(session, entries.filter((candidate) => candidate.id !== snapshotId));
  return true;
}

/** Retention: drop snapshots older than MAX_AGE_DAYS and beyond MAX_PER_FILE. */
export function sweepVault(sessionId: string): void {
  const session = sessionId.slice(0, 80);
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const entries = readIndex(session);
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
  if (removed.length === 0) return;
  for (const entry of removed) {
    try {
      rmSync(entry.storedPath, { force: true });
    } catch {
    }
  }
  writeIndex(session, keep);
}
