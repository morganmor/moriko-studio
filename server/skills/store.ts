
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';

import { skillsDir, morikoHome } from '../paths.js';
import { getActiveWorkspace } from '../agents/workspace.js';
import { parseSkillMd } from './parse.js';

export type SkillScope = 'global' | 'workspace' | 'compat';

export interface SkillEntry {
  
  name: string;
  
  description: string;
  
  dir: string;
  scope: SkillScope;
  license?: string;
  compatibility?: string;
  
  bodyChars: number;
}

export interface LoadedSkill extends SkillEntry {
  
  body: string;
}

const MAX_BODY = 64 * 1024;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  entry: SkillEntry | null;
  problem?: string;
  body?: string;
}
const cache = new Map<string, CacheEntry>();

function readSkillFile(file: string, scope: SkillScope): { entry: SkillEntry | null; problem?: string; body?: string } {
  try {
    const stat = statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return { entry: hit.entry, problem: hit.problem, body: hit.body };
    }
    const parsed = parseSkillMd(readFileSync(file, 'utf8'));
    const fresh: CacheEntry = { mtimeMs: stat.mtimeMs, size: stat.size, entry: null };
    if (!parsed.valid || !parsed.frontmatter) {
      fresh.problem = parsed.problem ?? 'invalid SKILL.md';
    } else {
      const body = parsed.body.slice(0, MAX_BODY);
      fresh.entry = {
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        dir: path.dirname(file),
        scope,
        ...(parsed.frontmatter.license ? { license: parsed.frontmatter.license } : {}),
        ...(parsed.frontmatter.compatibility ? { compatibility: parsed.frontmatter.compatibility } : {}),
        bodyChars: parsed.body.length,
      };
      fresh.body = body;
    }
    cache.set(file, fresh);
    return { entry: fresh.entry, problem: fresh.problem, body: fresh.body };
  } catch {
    return { entry: null };
  }
}


export function skillRoots(workspaceRoot?: string): Array<{ root: string; scope: SkillScope }> {
  const roots: Array<{ root: string; scope: SkillScope }> = [];
  if (workspaceRoot) {
    roots.push({ root: path.join(workspaceRoot, '.moriko', 'skills'), scope: 'workspace' });
    roots.push({ root: path.join(workspaceRoot, '.agents', 'skills'), scope: 'compat' });
    roots.push({ root: path.join(workspaceRoot, '.claude', 'skills'), scope: 'compat' });
  }
  roots.push({ root: skillsDir, scope: 'global' });
  roots.push({ root: path.join(morikoHome, '.agents', 'skills'), scope: 'compat' });
  roots.push({ root: path.join(morikoHome, '.claude', 'skills'), scope: 'compat' });
  return roots;
}


export function listSkills(workspaceRoot?: string): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  for (const { root, scope } of skillRoots(workspaceRoot)) {
    if (!existsSync(root)) continue;
    let folders: string[];
    try {
      folders = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const folder of folders) {
      const file = path.join(root, folder, 'SKILL.md');
      if (!existsSync(file)) continue;
      const { entry } = readSkillFile(file, scope);
      if (entry && !byName.has(entry.name)) byName.set(entry.name, entry);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}


export function loadSkill(name: string, workspaceRoot?: string): LoadedSkill | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  for (const entry of listSkills(workspaceRoot)) {
    if (entry.name.toLowerCase() !== wanted) continue;
    const { body } = readSkillFile(path.join(entry.dir, 'SKILL.md'), entry.scope);
    return { ...entry, body: body ?? '' };
  }
  return null;
}


export interface SkillTreeNode {
  
  rel: string;
  type: 'dir' | 'file';
  size?: number;
}

const TREE_SKIP = new Set(['node_modules', '.git']);
const MAX_TREE_DEPTH = 6;
const MAX_TREE_ENTRIES = 400;
const MAX_FILE = 64 * 1024;

export function walkSkillTree(dir: string, maxDepth = MAX_TREE_DEPTH, maxEntries = MAX_TREE_ENTRIES): SkillTreeNode[] {
  const out: SkillTreeNode[] = [];
  const walk = (current: string, rel: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxEntries) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || TREE_SKIP.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ rel: childRel, type: 'dir' });
        walk(path.join(current, entry.name), childRel, depth + 1);
      } else if (entry.isFile()) {
        let size: number | undefined;
        try {
          size = statSync(path.join(current, entry.name)).size;
        } catch {
          size = undefined;
        }
        out.push(size === undefined ? { rel: childRel, type: 'file' } : { rel: childRel, type: 'file', size });
      }
      if (out.length >= maxEntries) return;
    }
  };
  walk(dir, '', 0);
  return out;
}


export function listSkillFiles(dir: string): string[] {
  return walkSkillTree(dir)
    .filter((node) => node.type === 'file')
    .map((node) => node.rel);
}


export function readSkillCompanion(dir: string, relative: string): string | null {
  const resolved = path.resolve(dir, relative.replace(/\\/g, '/'));
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return null;
  return readFileSync(resolved, 'utf8').slice(0, MAX_FILE);
}

export type StorageRead =
  | { ok: true; text: string; abs: string }
  | { ok: false; error: string };


export function readSkillsStorageFile(relative: string, workspaceRoot?: string): StorageRead {
  const normalized = relative.replace(/\\/g, '/').trim();
  if (!normalized) return { ok: false, error: 'Empty path.' };
  for (const { root, scope } of skillRoots(workspaceRoot)) {
    if (!existsSync(root)) continue;
    const abs = path.resolve(root, normalized);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    try {
      return { ok: true, abs, text: readFileSync(abs, 'utf8').slice(0, MAX_FILE) };
    } catch {
      return { ok: false, error: `Could not read "${normalized}" (${scope} root).` };
    }
  }
  const roots = skillRoots(workspaceRoot)
    .map((entry) => `${entry.scope}: ${entry.root}`)
    .join('\n  ');
  return {
    ok: false,
    error: `No file "${normalized}" inside any skills root. Searched:\n  ${roots}\nBrowse first with agent__skills { action: "tree" }.`,
  };
}


export function activeWorkspaceRoot(sessionId?: string): string | undefined {
  try {
    return getActiveWorkspace(sessionId)?.path;
  } catch {
    return undefined;
  }
}
