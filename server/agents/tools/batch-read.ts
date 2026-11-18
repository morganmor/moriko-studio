
import { readFileSync, statSync } from 'node:fs';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { num, resolveWithPermission } from './shared.js';
import { getActiveWorkspace } from '../workspace.js';
import { recordRead } from '../read-policy.js';
import { sha256 } from '../edit-diagnostics.js';
import { MAX_READ_BYTES } from './shared.js';

interface BatchEntry {
  path: string;
  
  maxLines: number;
}


function parseEntries(args: Record<string, unknown>): { entries: BatchEntry[]; problem?: string } {
  const raw = Array.isArray(args.files) ? args.files : Array.isArray(args.paths) ? args.paths : null;
  if (!raw) {
    return { entries: [], problem: 'batch_read needs a "files" array: [{ path, maxLines }, …].' };
  }
  if (raw.length === 0) return { entries: [], problem: 'batch_read "files" array is empty.' };

  const entries: BatchEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item === 'string') {
      return {
        entries: [],
        problem: `Entry ${i + 1} ("${item}") has no maxLines — every file needs its own limit, e.g. { "path": "${item}", "maxLines": 400 }.`,
      };
    }
    if (!item || typeof item !== 'object') {
      return { entries: [], problem: `Entry ${i + 1} is not an object — use { path, maxLines }.` };
    }
    const record = item as Record<string, unknown>;
    const filePath = typeof record.path === 'string' ? record.path.trim() : '';
    const maxLines = num(record, 'maxLines');
    if (!filePath) return { entries: [], problem: `Entry ${i + 1} is missing "path".` };
    if (maxLines === undefined || maxLines <= 0) {
      return {
        entries: [],
        problem: `Entry ${i + 1} ("${filePath}") is missing "maxLines" — the caller must state the per-file line limit (no default exists).`,
      };
    }
    entries.push({ path: filePath, maxLines: Math.floor(maxLines) });
  }
  return { entries };
}

export async function batchReadTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const { entries, problem } = parseEntries(args);
  if (problem) return { ok: false, isError: true, text: problem };

  const ws = getActiveWorkspace(ctx.sessionId);
  if (!ws) {
    return { ok: false, isError: true, text: 'No active workspace — set one in the workspace picker first.' };
  }

  const sections: string[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const { path: inputPath, maxLines } = entries[i];
    const { absolute, relative } = await resolveWithPermission('read_file', inputPath, ctx);

    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      sections.push(`\n=== [${i + 1}/${entries.length}] ${inputPath} — NOT FOUND ===\n`);
      continue;
    }
    if (stats.isDirectory()) {
      sections.push(`\n=== [${i + 1}/${entries.length}] ${relative} — DIRECTORY (use list) ===\n`);
      continue;
    }
    if (stats.size > MAX_READ_BYTES) {
      sections.push(`\n=== [${i + 1}/${entries.length}] ${relative} — too large (${(stats.size / 1_000_000).toFixed(1)} MB) ===\n`);
      continue;
    }

    let content: string;
    try {
      content = readFileSync(absolute, 'utf8');
    } catch {
      sections.push(`\n=== [${i + 1}/${entries.length}] ${relative} — read failed ===\n`);
      continue;
    }
    if (content.includes('\0')) {
      sections.push(`\n=== [${i + 1}/${entries.length}] ${relative} — binary ===\n`);
      continue;
    }

    const lines = content.split('\n');
    const view = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    const eol = content.includes('\r\n') ? 'CRLF' : 'LF';
    const contentHash = sha256(content);

    const sliceEnd = Math.min(maxLines, view.length);
    const slice: string[] = [];
    for (let n = 0; n < sliceEnd; n += 1) {
      slice.push(`${String(n + 1).padStart(5)}| ${view[n]}`);
    }

    const entry = recordRead(ctx.sessionId, absolute, content, stats.mtimeMs, 1, Math.max(view.length, 1));

    const header =
      `\n=== [${i + 1}/${entries.length}] ${relative} — lines 1–${sliceEnd} of ${view.length} | ${eol} | utf-8 | sha256:${contentHash.slice(0, 12)} | read#${entry?.rev ?? 1} ===`;
    const body = slice.join('\n');
    const footer =
      view.length > sliceEnd ? `[next: "r:1:${sliceEnd + 1}" — ${view.length - sliceEnd} more line(s); pass continueFrom to read on]` : `[EOF]`;

    sections.push(`${header}\n${body}\n${footer}`);
  }

  return {
    ok: true,
    isError: false,
    text: `# batch read — ${entries.length} file(s)\n${sections.join('\n')}`,
  };
}
