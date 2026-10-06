/**
 * agent__batch_read — read multiple files in ONE call. Collapses the explore
 * phase (reading 3-5 files to understand context) from 3-5 round-trips into 1.
 * Each file gets its own numbered window with sha footer + read receipt.
 */
import { readFileSync, statSync } from 'node:fs';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { num, truncateOutput, resolveWithPermission } from './shared.js';
import { getActiveWorkspace } from '../workspace.js';
import { recordRead } from '../read-policy.js';
import { sha256 } from '../edit-diagnostics.js';
import { MAX_READ_BYTES, MAX_OUTPUT_CHARS } from './shared.js';

export async function batchReadTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const rawPaths = args.paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    return { ok: false, isError: true, text: 'batch_read needs a "paths" array of file paths (max 6).' };
  }
  if (rawPaths.length > 6) {
    return { ok: false, isError: true, text: `batch_read accepts at most 6 files — got ${rawPaths.length}. Split across calls.` };
  }
  const maxLinesPer = Math.min(Math.max(num(args, 'maxLines') ?? 400, 1), 1000);
  const ws = getActiveWorkspace(ctx.sessionId);
  if (!ws) {
    return { ok: false, isError: true, text: 'No active workspace — set one in the workspace picker first.' };
  }

  const sections: string[] = [];
  let totalBudget = MAX_OUTPUT_CHARS - 200;

  for (let i = 0; i < rawPaths.length; i += 1) {
    const inputPath = String(rawPaths[i] ?? '').trim();
    if (!inputPath) continue;
    const { absolute, relative } = await resolveWithPermission('read_file', inputPath, ctx);

    let stats;
    try { stats = statSync(absolute); } catch {
      sections.push(`\n=== [${i + 1}/${rawPaths.length}] ${inputPath} — NOT FOUND ===\n`);
      continue;
    }
    if (stats.isDirectory()) {
      sections.push(`\n=== [${i + 1}/${rawPaths.length}] ${relative} — DIRECTORY (use list) ===\n`);
      continue;
    }
    if (stats.size > MAX_READ_BYTES) {
      sections.push(`\n=== [${i + 1}/${rawPaths.length}] ${relative} — too large (${(stats.size / 1_000_000).toFixed(1)} MB) ===\n`);
      continue;
    }

    let content: string;
    try { content = readFileSync(absolute, 'utf8'); } catch {
      sections.push(`\n=== [${i + 1}/${rawPaths.length}] ${relative} — read failed ===\n`);
      continue;
    }
    if (content.includes('\0')) {
      sections.push(`\n=== [${i + 1}/${rawPaths.length}] ${relative} — binary ===\n`);
      continue;
    }

    const lines = content.split('\n');
    const view = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    const eol = content.includes('\r\n') ? 'CRLF' : 'LF';
    const contentHash = sha256(content);

    const sliceEnd = Math.min(maxLinesPer, view.length);
    const slice: string[] = [];
    for (let n = 0; n < sliceEnd; n += 1) {
      slice.push(`${String(n + 1).padStart(5)}| ${view[n]}`);
    }

    const entry = recordRead(ctx.sessionId, absolute, content, stats.mtimeMs, 1, Math.max(view.length, 1));

    const header =
      `\n=== [${i + 1}/${rawPaths.length}] ${relative} — lines 1–${sliceEnd} of ${view.length} | ${eol} | utf-8 | sha256:${contentHash.slice(0, 12)} | read#${entry?.rev ?? 1} ===`;
    const body = slice.join('\n');
    const footer =
      view.length > sliceEnd ? `[next: "r:1:${sliceEnd + 1}" — ${view.length - sliceEnd} more line(s); pass continueFrom to read on]` : `[EOF]`;

    const section = `${header}\n${body}\n${footer}`;
    if (section.length > totalBudget) {
      sections.push(`\n=== [${i + 1}/${rawPaths.length}] ${relative} — output budget exceeded, use read_file separately ===`);
      break;
    }
    sections.push(section);
    totalBudget -= section.length;
  }

  return {
    ok: true,
    isError: false,
    text: truncateOutput(`# batch read — ${rawPaths.length} file(s)\n${sections.join('\n')}`),
  };
}
