/**
 * agent__deps — import graph: "what breaks if I change this file?"
 *
 * Parses import/require/dynamic-import specifiers of the JS/TS family and
 * returns, for ONE file: what it imports (relative files + external packages),
 * what imports IT (direct dependents), and a bounded BFS count of all
 * reachable dependents (blast radius, radius ≤ 3). Check this BEFORE
 * renaming/moving/changing signatures of shared files.
 *
 * agent__hash — SHA-256 of arbitrary text (idempotency check, content key).
 * agent__remind — schedule a reminder for THIS conversation.
 */
import { createHash } from 'node:crypto';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput, requireGoalSession } from './shared.js';
import { queryDeps } from '../deps.js';
import { fuzzyHint } from '../fuzzy.js';
import { getActiveWorkspace, isInsideRoot } from '../workspace.js';
import { createReminder, listReminders, renderReminder } from '../../reminders/store.js';
import path from 'node:path';

export function depsTool(args: Record<string, unknown>, ctx: AgentToolContext): HarnessToolResult {
  const inputPath = str(args, 'path').trim();
  if (!inputPath) {
    return { ok: false, isError: true, text: 'deps needs a "path" (file relative to the workspace root).' };
  }
  const ws = getActiveWorkspace(ctx.sessionId);
  if (!ws) return { ok: false, isError: true, text: 'No active workspace — set one in the workspace picker first.' };
  const absolute = path.resolve(ws.path, inputPath);
  if (!isInsideRoot(absolute, ws.path)) {
    return { ok: false, isError: true, text: `"${inputPath}" is outside the workspace root.` };
  }
  const report = queryDeps(ws.path, absolute);
  if (!report) {
    return {
      ok: false,
      isError: true,
      text: `No import-graph edges for "${inputPath}"${fuzzyHint(absolute)} — it is outside the JS/TS family (ts/tsx/js/jsx/mjs/cjs), or nothing imports it and it imports nothing tracked.`,
    };
  }
  const parts: string[] = [`# import graph — ${report.file} (${report.filesScanned} file(s) scanned)`];
  parts.push('');
  parts.push(`imports (${report.imports.length}):`);
  parts.push(report.imports.length ? report.imports.map((p) => `  → ${p}`).join('\n') : '  (none tracked)');
  parts.push('');
  parts.push(`imported by (${report.importedBy.length}):`);
  parts.push(report.importedBy.length ? report.importedBy.map((p) => `  ← ${p}`).join('\n') : '  (nothing — safe to change freely)');
  parts.push('');
  parts.push(`external packages (${report.externals.length}): ${report.externals.join(', ') || '(none)'}`);
  parts.push('');
  parts.push(
    `blast radius: ${report.reachableDependents} file(s) reachable through the import chain (BFS radius ≤ 3). ` +
      'Signature/type changes here propagate to all of them — run their tests after editing.',
  );
  return { ok: true, isError: false, text: truncateOutput(parts.join('\n')) };
}

export function hashTool(args: Record<string, unknown>): HarnessToolResult {
  return {
    ok: true,
    isError: false,
    text: createHash('sha256').update(str(args, 'text')).digest('hex'),
  };
}

export async function remindTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const sessionId = requireGoalSession(ctx);
  const input: { label: string; inMinutes?: number; fireAt?: number | string } = {
    label: str(args, 'label'),
  };
  const minutes = num(args, 'inMinutes');
  if (minutes !== undefined) input.inMinutes = minutes;
  const at = str(args, 'at').trim();
  if (at) input.fireAt = at;
  try {
    const reminder = createReminder(sessionId, input);
    const pending = listReminders(sessionId, false);
    return {
      ok: true,
      isError: false,
      text:
        `Reminder scheduled (id: ${reminder.id}): "${reminder.label}" — fires ${new Date(reminder.fireAt).toISOString()}. ` +
        `When it is due, the next message in this conversation surfaces it automatically.` +
        (pending.length > 1 ? `\nPending reminders in this conversation:\n${pending.map(renderReminder).join('\n')}` : ''),
    };
  } catch (error) {
    return { ok: false, isError: true, text: error instanceof Error ? error.message : 'remind failed.' };
  }
}
