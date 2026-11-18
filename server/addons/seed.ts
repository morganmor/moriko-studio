

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { morikoHome } from '../paths.js';
import { markBuiltin } from './permissions.js';


function builtinSourceRoot(): string {
  return path.resolve(process.cwd(), 'addons-src');
}


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


function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}


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


function builtinSourceDir(id: string): string | null {
  const srcDir = path.join(builtinSourceRoot(), id);
  return existsSync(path.join(srcDir, 'addon.json')) ? srcDir : null;
}


function readDisabledFlag(installPath: string): boolean {
  try {
    return (JSON.parse(readFileSync(installPath, 'utf-8')) as { enabled?: boolean }).enabled === false;
  } catch {
    return false;
  }
}


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
    } catch {  }

    const targetDir = installDir(id);
    const targetManifest = path.join(targetDir, 'addon.json');
    if (existsSync(targetManifest)) {
      if (isNewer(readVersion(manifestPath), readVersion(targetManifest))) {
        rmSync(targetDir, { recursive: true, force: true });
        mkdirSync(targetDir, { recursive: true });
        cpSync(srcDir, targetDir, { recursive: true });
        report.seeded.push(id);
      } else {
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
    markBuiltin(id, readPermissions(manifestPath));
  }
  return report;
}
