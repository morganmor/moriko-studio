
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { morikoHome } from '../paths.js';


const MAX_TOTAL = 64 * 1024;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  content: string;
}

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


function pick(candidates: string[]): string | null {
  for (const file of candidates) {
    if (existsSync(file)) return file;
  }
  return null;
}

export interface AgentsMdResult {
  
  content: string;
  
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
