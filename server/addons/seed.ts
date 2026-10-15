/**
 * Builtin addon seeding (Addon v2, A9) — closes A-21.
 *
 * `addons-src/<id>/` in the repo is the source of truth for BUILT-IN addons;
 * at boot each one is seeded into `~/.moriko-studio/addons/<id>/` when the
 * target does not exist yet. Existing installs are NEVER overwritten — an
 * addon the user edited stays theirs (version bumps ship by deleting the
 * folder or via the Hub's Remove + restart). Seeded addons are marked
 * `trust: "builtin"` (pre-granted permissions, still visible in the Hub).
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { morikoHome } from '../paths.js';
import { markBuiltin } from './permissions.js';

/** The repo's builtin addon sources (dev layout; absent in packaged builds). */
function builtinSourceRoot(): string {
  return path.resolve(process.cwd(), 'addons-src');
}

/** The on-disk install directory for one addon. */
function installDir(id: string): string {
  return path.join(morikoHome, 'addons', id);
}

function readVersion(manifestPath: string): string {
  try {
    return (JSON.parse(readFileSync(manifestPath, 'utf-8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Minimal semver compare: true when `a` is strictly newer than `b`. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** Read a v2 manifest's declared permissions (empty for legacy addons). */
function readPermissions(manifestPath: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { permissions?: unknown };
    return Array.isArray(raw.permissions) ? raw.permissions.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export interface SeedReport {
  seeded: string[];
  kept: string[];
}

/** The ids of the builtin addon sources in addons-src/ (empty in packaged builds). */
export function builtinAddonIds(): string[] {
  const srcRoot = builtinSourceRoot();
  if (!existsSync(srcRoot) || !statSync(srcRoot).isDirectory()) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(srcRoot)) {
    const srcDir = path.join(srcRoot, entry);
    if (!statSync(srcDir).isDirectory() || !existsSync(path.join(srcDir, 'addon.json'))) continue;
    const manifestId = readJson(path.join(srcDir, 'addon.json')).id;
    ids.push(typeof manifestId === 'string' ? manifestId : entry);
  }
  return ids;
}

/** The source folder for one builtin addon (null when it is not a builtin). */
function builtinSourceDir(id: string): string | null {
  const srcDir = path.join(builtinSourceRoot(), id);
  return existsSync(path.join(srcDir, 'addon.json')) ? srcDir : null;
}

/** The source folder for one builtin addon (null when it is not a builtin). */
function readDisabledFlag(installPath: string): boolean {
  try {
    return (JSON.parse(readFileSync(installPath, 'utf-8')) as { enabled?: boolean }).enabled === false;
  } catch {
    return false;
  }
}

/** A reseed must not silently re-enable an addon the user disabled. */
function keepDisabled(installPath: string): void {
  writeFileSync(installPath, JSON.stringify({ ...readJson(installPath), enabled: false }, null, 2), 'utf-8');
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Force-reseed one builtin addon: DELETE `~/.moriko-studio/addons/<id>/` and
 * replace it with the current `addons-src/<id>/` — plain replacement, no
 * backup copies. Called by the Addon Hub's disable/reload so the newest
 * shipped source is loaded without the user having to delete the install.
 *
 * Returns null when `<id>` is not a builtin addon (no `addons-src/<id>/`).
 */
export function reseedBuiltin(id: string): string | null {
  if (id.startsWith('.') || id.includes('.bak')) return null;
  const srcDir = builtinSourceDir(id);
  if (!srcDir) return null;

  const targetDir = installDir(id);
  const wasDisabled = readDisabledFlag(path.join(targetDir, 'addon.json'));
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  cpSync(srcDir, targetDir, { recursive: true });
  if (wasDisabled) keepDisabled(path.join(targetDir, 'addon.json'));
  markBuiltin(id, readPermissions(path.join(srcDir, 'addon.json')));
  return targetDir;
}

/** Force-reseed EVERY builtin addon. Returns the reseeded ids. */
export function reseedAllBuiltins(): string[] {
  const srcRoot = builtinSourceRoot();
  if (!existsSync(srcRoot) || !statSync(srcRoot).isDirectory()) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(srcRoot)) {
    const srcDir = path.join(srcRoot, entry);
    if (!statSync(srcDir).isDirectory() || !existsSync(path.join(srcDir, 'addon.json'))) continue;
    let id = entry;
    const manifestId = readJson(path.join(srcDir, 'addon.json')).id;
    if (typeof manifestId === 'string') id = manifestId;
    if (reseedBuiltin(id)) ids.push(id);
  }
  return ids;
}

/** Seed builtin addons + pre-grant their permissions. Idempotent. */
export function seedBuiltinAddons(): SeedReport {
  const report: SeedReport = { seeded: [], kept: [] };
  const srcRoot = builtinSourceRoot();
  if (!existsSync(srcRoot) || !statSync(srcRoot).isDirectory()) return report;

  for (const entry of readdirSync(srcRoot)) {
    const srcDir = path.join(srcRoot, entry);
    const manifestPath = path.join(srcDir, 'addon.json');
    if (!statSync(srcDir).isDirectory() || !existsSync(manifestPath)) continue;

    let id = entry;
    try {
      id = (JSON.parse(readFileSync(manifestPath, 'utf-8')) as { id?: string }).id ?? entry;
    } catch { /* folder name is the fallback id */ }

    const targetDir = installDir(id);
    const targetManifest = path.join(targetDir, 'addon.json');
    if (existsSync(targetManifest)) {
      if (isNewer(readVersion(manifestPath), readVersion(targetManifest))) {
        // Upgrade: the shipped version is newer — delete the install and
        // copy the source in (plain replacement, per the user's rule).
        rmSync(targetDir, { recursive: true, force: true });
        mkdirSync(targetDir, { recursive: true });
        cpSync(srcDir, targetDir, { recursive: true });
        report.seeded.push(id);
      } else {
        // Existing install at the same/older version: never clobber it.
        report.kept.push(id);
      }
    } else {
      mkdirSync(targetDir, { recursive: true });
      if (statSync(srcDir).isDirectory()) {
        cpSync(srcDir, targetDir, { recursive: true });
      } else {
        copyFileSync(srcDir, manifestPath);
      }
      report.seeded.push(id);
    }
    // Builtin trust: permissions pre-granted (still listed in the Hub).
    markBuiltin(id, readPermissions(manifestPath));
  }
  return report;
}
