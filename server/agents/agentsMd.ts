/**
 * AGENTS.md loader (V1: global + workspace root — hierarchical nested files
 * are a documented follow-up) — the standards-research pick: agents.md files
 * are plain Markdown, discovered hierarchically, merged top-down (Codex,
 * Amp, the agents.md spec). V1 scope:
 *
 *   global : ~/.moriko-studio/AGENTS.md  (fallback AGENT.md)
 *   root   : <workspace>/AGENTS.md      (fallback AGENT.md, then CLAUDE.md —
 *            the common aliases other harnesses accept)
 *
 * EFFICIENCY: stat-based cache — a hit costs two stat() calls, a re-read only
 * happens when mtime/size changed. Total payload capped (64 KB) so a giant
 * file cannot silently eat the context window.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { morikoHome } from '../paths.js';

/** Total cap across all sources — beyond this the tail is truncated. */
const MAX_TOTAL = 64 * 1024;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  content: string;
}
/** path → fresh entry. In-process; the dev server restarts on edit anyway. */
const cache = new Map<string, CacheEntry>();

function readFresh(file: string): string | null {
  try {
    const stat = statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.content;
    const content = readFileSync(file, 'utf8');
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, content });
    return content;
  } catch {
    return null;
  }
}

/** First existing candidate, Codex-style preference order. */
function pick(candidates: string[]): string | null {
  for (const file of candidates) {
    if (existsSync(file)) return file;
  }
  return null;
}

export interface AgentsMdResult {
  /** Merged Markdown (global first, workspace last = most specific wins). */
  content: string;
  /** Absolute paths actually loaded, in order. */
  sources: string[];
}

export function collectAgentsMd(workspaceRoot?: string): AgentsMdResult | null {
  const sources: string[] = [];
  const sections: string[] = [];

  const globalFile = pick([
    path.join(morikoHome, 'AGENTS.md'),
    path.join(morikoHome, 'AGENT.md'),
  ]);
  const rootFile = workspaceRoot
    ? pick([
        path.join(workspaceRoot, 'AGENTS.md'),
        path.join(workspaceRoot, 'AGENT.md'),
        path.join(workspaceRoot, 'CLAUDE.md'),
      ])
    : null;

  let budget = MAX_TOTAL;
  for (const [file, label] of [
    [globalFile, 'Global instructions (~/.moriko-studio)'],
    [rootFile, workspaceRoot ? `Workspace: ${workspaceRoot}` : ''],
  ] as const) {
    if (!file || !label) continue;
    const text = readFresh(file);
    if (text === null || !text.trim()) continue;
    const header = `### ${label} — ${path.basename(file)}`;
    let body = text;
    if (header.length + body.length > budget) {
      body = `${body.slice(0, Math.max(0, budget))}\n\n[… AGENTS.md truncated at the ${MAX_TOTAL / 1024} KB cap …]`;
    }
    budget -= header.length + body.length;
    sections.push(`${header}\n${body.trim()}`);
    sources.push(file);
    if (budget <= 0) break;
  }

  if (sections.length === 0) return null;
  return { content: sections.join('\n\n'), sources };
}
