/**
 * agent__explain_error — paste a stack trace and get EVERY workspace frame read
 * and annotated in ONE call.
 *
 * Frames inside the workspace get read receipts, so the very windows that
 * explain the crash are directly editable afterwards.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, truncateOutput, requireWorkspace, MAX_READ_BYTES, MAX_OUTPUT_CHARS } from './shared.js';
import { recordRead } from '../read-policy.js';
import { isInsideRoot, isInsideAllowedDir } from '../workspace.js';

interface ErrorFrame {
  file: string;
  line: number;
  column?: number;
}

/** Extracts file:line frames from JS/TS stacks and Python tracebacks. */
export function parseErrorFrames(error: string): ErrorFrame[] {
  const frames: ErrorFrame[] = [];
  const push = (file: string, line: number, column?: number): void => {
    if (!file || !Number.isFinite(line) || line < 1) return;
    if (file.startsWith('node:') || file.includes('node:internal')) return;
    frames.push({ file, line, column });
  };
  for (const match of error.matchAll(/File "([^"]+)", line (\d+)/g)) {
    push(match[1], Number(match[2]));
  }
  for (const match of error.matchAll(/([^\s()'"]*[\\/][^\s()'"]*?):(\d+):(\d+)/g)) {
    push(match[1], Number(match[2]), Number(match[3]));
  }
  return frames;
}

export async function explainErrorTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const error = str(args, 'error');
  if (!error.trim()) {
    return { ok: false, isError: true, text: 'explain_error needs the "error" text (paste the whole stack trace).' };
  }
  const { root } = requireWorkspace(ctx);
  const frames = parseErrorFrames(error).slice(0, 12);
  if (frames.length === 0) {
    return {
      ok: false, isError: true,
      text: 'No file:line frames found. Supported: JS/TS stacks (path:line:col) and Python tracebacks (File "path", line N).',
    };
  }

  const sections: string[] = [`# error — ${error.split('\n')[0].trim().slice(0, 300)}`];
  let receipts = 0;
  let skipped = 0;
  let budget = MAX_OUTPUT_CHARS;
  const seen = new Set<string>();
  for (const frame of frames) {
    if (budget <= 500 || receipts >= 8) break;
    const key = `${frame.file}:${frame.line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const candidate = path.isAbsolute(frame.file)
      ? frame.file
      : path.resolve(root, frame.file.replace(/^file:\/\//, ''));
    let inside = false;
    try {
      inside = isInsideRoot(candidate, root) || isInsideAllowedDir(candidate);
    } catch {
      inside = false;
    }
    if (!inside) {
      skipped += 1;
      continue;
    }
    let content: string;
    let mtime: number;
    try {
      const st = statSync(candidate);
      if (!st.isFile() || st.size > MAX_READ_BYTES) throw new Error('skip');
      content = readFileSync(candidate, 'utf8');
      mtime = st.mtimeMs;
    } catch {
      skipped += 1;
      continue;
    }
    if (content.includes('\0')) {
      skipped += 1;
      continue;
    }
    const lines = content.split('\n');
    const view = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    if (frame.line > view.length) {
      skipped += 1;
      continue;
    }
    const from = Math.max(1, frame.line - 12);
    const to = Math.min(view.length, frame.line + 12);
    const rel = path.relative(root, candidate) || candidate;

    const body: string[] = [];
    for (let n = from; n <= to; n += 1) {
      const row = `${String(n).padStart(5)}${n === frame.line ? '>' : '|'} ${view[n - 1]}`;
      if (row.length + 1 > budget - 300) {
        body.push('    …(frame truncated at output budget)');
        break;
      }
      body.push(row);
      budget -= row.length + 1;
    }
    const receipt = recordRead(ctx.sessionId, candidate, content, mtime, from, to);
    receipts += 1;
    sections.push(
      `── frame ${receipts}: ${rel}:${frame.line}${frame.column ? `:${frame.column}` : ''} · window ${from}–${to} · read#${receipt?.rev ?? 1} granted\n` +
        body.join('\n'),
    );
  }

  if (receipts === 0) {
    return {
      ok: true, isError: false,
      text:
        `${sections[0]}\n\nAll ${skipped} frame(s) are outside the workspace or unreadable — nothing to annotate. ` +
        'If the error comes from a dependency, grep its installed source instead.',
    };
  }
  return {
    ok: true, isError: false,
    text: truncateOutput(
      `${sections.join('\n\n')}\n\n[${receipts} frame window(s) read (receipts granted); ${skipped} frame(s) skipped]\n` +
        'Next step: the frames above carry read receipts — anchor edits or editLines inside these windows directly.',
    ),
  };
}
