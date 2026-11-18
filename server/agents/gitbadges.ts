

import path from 'node:path';

import { runProcess } from './exec.js';

export type GitLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '??';

export interface GitStatusOutcome {
  
  map: Map<string, GitLetter> | null;
  reason?: string;
  ranAt: number;
}

interface CacheEntry {
  outcome: GitStatusOutcome;
}

const CACHE_TTL_MS = 2_000;
const cache = new Map<string, CacheEntry>();


function classify(x: string, y: string): GitLetter {
  if (x === '?' && y === '?') return '??';
  const pick = (c: string): GitLetter | null => {
    switch (c) {
      case 'M': case 'T': return 'M';
      case 'A': return 'A';
      case 'D': return 'D';
      case 'R': return 'R';
      case 'C': return 'C';
      case 'U': return 'U';
      default: return null;
    }
  };
  const first = pick(x);
  if (first) return first;
  const second = pick(y);
  return second ?? 'M';
}


export async function gitStatusMap(root: string): Promise<GitStatusOutcome> {
  const cached = cache.get(root);
  if (cached && Date.now() - cached.outcome.ranAt < CACHE_TTL_MS) return cached.outcome;

  let outcome: GitStatusOutcome;
  const probe = await runProcess('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { cwd: root, timeoutMs: 5_000 });
  if (probe.exitCode !== 0) {
    outcome = { map: null, reason: 'not a git repository', ranAt: Date.now() };
  } else {
    const status = await runProcess('git', ['-C', root, 'status', '--porcelain'], { cwd: root, timeoutMs: 10_000 });
    if (status.exitCode !== 0) {
      outcome = { map: null, reason: status.stderr.trim().slice(0, 120) || 'git status failed', ranAt: Date.now() };
    } else {
      const map = new Map<string, GitLetter>();
      for (const line of status.stdout.split('\n')) {
        if (line.length < 4) continue;
        const x = line[0];
        const y = line[1];
        let file = line.slice(3).trim();
        if (!file) continue;
        const arrow = file.indexOf(' -> ');
        if (arrow >= 0) file = file.slice(arrow + 4);
        if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
        map.set(file.split(path.sep).join('/'), classify(x, y));
      }
      outcome = { map, ranAt: Date.now() };
    }
  }

  cache.set(root, { outcome });
  return outcome;
}


export function gitDirBadge(map: Map<string, GitLetter>, prefix: string): string {
  const counts = new Map<string, number>();
  let total = 0;
  for (const [file, letter] of map) {
    if (!file.startsWith(prefix)) continue;
    counts.set(letter, (counts.get(letter) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return '';
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([letter, count]) => `${count}${letter === '??' ? '?' : letter}`);
  const more = total > 50 ? '+' : '';
  return ` [git: ${parts.join(', ')}${more}]`;
}


export function gitFileBadge(map: Map<string, GitLetter>, file: string): string {
  const letter = map.get(file);
  return letter ? ` [${letter === '??' ? '??' : letter}]` : '';
}
