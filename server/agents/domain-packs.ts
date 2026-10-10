/**
 * F6.4 — domain packs: conditionally injected prompt guidance detected from
 * the workspace itself (3D/game dependencies, project files, repo size).
 * Cached per workspace root + package.json mtime.
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

const GAME_DEPS = [
  'three', '@react-three/fiber', 'babylonjs', '@babylonjs/core', 'pixi.js',
  'phaser', 'matter-js', 'cannon-es', 'rapide', '@dimforge/rapier3d',
];

const GAME_PACK = [
  'Domain · 3D/Game:',
  '- Fixed timestep for update (dt = 1/60, clamp the frame delta); keep render separate from update.',
  '- Zero per-frame allocations: no `new` inside update/animate/tick/render loops.',
  '- Dispose GPU resources (geometry/material/texture) when done; renderer.dispose() on teardown.',
  '- Cap devicePixelRatio at 2: setPixelRatio(Math.min(devicePixelRatio, 2)).',
  '- Handle resize (viewport + camera aspect); pause the loop when the tab is hidden.',
  '- Budget assets up front: agent__asset_inspect (triangles, texture size, bytes) before shipping models.',
  '- Shaders: validate with agent__shader_check (prelude "three" for ShaderMaterial built-ins).',
  '- Final verification: agent__game_probe on the localhost dev server (fps, console errors, blank-canvas detection).',
  '- Expose a dev-only `window.__MORIKO_PROBE__ = { renderer, scene }` hook so game_probe can read draw stats.',
];

const ARCH_PACK = [
  'Domain · Architecture:',
  '- Before creating >3 new files or a new module: agent__arch_map first; respect .moriko/architecture.json when it exists.',
  '- Offer an ADR (agent__adr new) for structural decisions (state pattern, module split, engine choice).',
  '- Scaffold from templates when one fits: agent__scaffold { "list": true }.',
];

interface CacheEntry {
  root: string;
  pkgMtime: number;
  packs: string[];
}
let cache: CacheEntry | null = null;

function detectGame(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (GAME_DEPS.some((d) => deps[d])) return true;
  } catch { /* no package.json */ }
  if (existsSync(path.join(root, 'project.godot'))) return true;
  const hasUproject = existsSync(root) && (readdirSync(root).some((f) => f.endsWith('.uproject')));
  if (hasUproject) return true;
  if (existsSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'))) return true;
  try {
    const cargo = readFileSync(path.join(root, 'Cargo.toml'), 'utf8');
    if (cargo.includes('bevy')) return true;
  } catch { /* no Cargo.toml */ }
  return false;
}

function countSourceFiles(root: string): number {
  let count = 0;
  const skip = new Set(['node_modules', '.git', '.data', '.moriko', 'dist', 'build', 'out', 'coverage', '.attachments']);
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || count > 2000) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count > 2000) return;
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (/\.(ts|tsx|js|jsx|py|go|rs|java)$/.test(e.name)) {
        count += 1;
      }
    }
  };
  walk(root, 0);
  return count;
}

/** Packs to inject into the system prompt; cached per root + package.json mtime. */
export function domainPackInjections(root: string): string[] {
  let pkgMtime = 0;
  try { pkgMtime = statSync(path.join(root, 'package.json')).mtimeMs; } catch { /* none */ }
  if (cache && cache.root === root && cache.pkgMtime === pkgMtime) return cache.packs;

  const packs: string[] = [];
  if (detectGame(root)) packs.push(...GAME_PACK);
  const archConfigured = existsSync(path.join(root, '.moriko', 'architecture.json'));
  if (archConfigured || countSourceFiles(root) > 150) packs.push(...ARCH_PACK);

  cache = { root, pkgMtime, packs };
  return packs;
}
