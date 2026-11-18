

import { readdirSync } from 'node:fs';
import path from 'node:path';

import { getActiveWorkspace, listWorkspaces, isInsideRoot } from './workspace.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.data', '.moriko', '.pnpm-store', 'dist', 'build', 'out',
  'coverage', '.venv', 'venv', '__pycache__', '.next', '.turbo', '.zvec-grep',
  '.attachments',
]);

const MAX_WALK_DEPTH = 12;


function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length];
}


function distanceBudget(name: string): number {
  return Math.max(2, Math.floor(name.length / 5));
}


export function fuzzyHint(absolutePath: string): string {
  try {
    const ws =
      listWorkspaces().find((entry) => isInsideRoot(absolutePath, entry.path)) ?? getActiveWorkspace();
    if (!ws) return '';
    const base = path.basename(absolutePath).toLowerCase();
    if (!base || base === '.' || base === '..') return '';
    const budget = distanceBudget(base);

    const parent = path.dirname(absolutePath);
    let siblingBest: { rel: string; d: number } | null = null;
    try {
      for (const entry of readdirSync(parent)) {
        const d = levenshtein(base, entry.toLowerCase());
        if (!siblingBest || d < siblingBest.d) {
          siblingBest = { rel: path.relative(ws.path, path.join(parent, entry)).split(path.sep).join('/'), d };
        }
      }
    } catch {
    }
    if (siblingBest && siblingBest.d <= budget) {
      return ` — did you mean "${siblingBest.rel}"? (distance ${siblingBest.d})`;
    }

    const best: { value: { rel: string; d: number } | null } = { value: null };
    const visit = (dir: string, depth: number): void => {
      if (depth > MAX_WALK_DEPTH) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          visit(path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          const d = levenshtein(base, entry.name.toLowerCase());
          if (d === 0 && best.value?.d === 0) continue;
          if (!best.value || d < best.value.d) {
            best.value = { rel: path.relative(ws.path, path.join(dir, entry.name)).split(path.sep).join('/'), d };
          }
        }
      }
    };
    visit(ws.path, 0);
    if (best.value && best.value.d <= budget) {
      return ` — did you mean "${best.value.rel}"? (distance ${best.value.d})`;
    }
    return '';
  } catch {
    return '';
  }
}
