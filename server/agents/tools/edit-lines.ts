/**
 * agent__edit_lines — replace a line RANGE (1-based, inclusive) with newString.
 * The range MUST lie inside the window the model actually read on the current
 * revision — no blind line surgery. Same safety posture as edit_file via the
 * shared edit-core.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, bool, numField } from './shared.js';
import { resolveWriteTarget, replaceLineRange } from './edit-core.js';

export async function editLinesTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const inputPath = str(args, 'path');
  const newString = str(args, 'newString');
  const dryRun = bool(args, 'dryRun');
  const expectedReadHash = str(args, 'expectedReadHash').trim();
  const preserveEol = args.preserveEol === undefined ? true : bool(args, 'preserveEol');
  const verifySyntax = args.verifySyntax === undefined ? true : bool(args, 'verifySyntax');

  const from = numField(args, 'from');
  const to = numField(args, 'to');
  if (from === undefined || to === undefined) {
    return { ok: false, isError: true, text: 'edit_lines needs numeric "from" and "to" (1-based, inclusive).' };
  }
  if (from < 1 || to < from) {
    return { ok: false, isError: true, text: `edit_lines range ${from}–${to} is invalid: needs 1 ≤ from ≤ to.` };
  }
  if (to - from + 1 > 2000) {
    return { ok: false, isError: true, text: 'edit_lines range too large (> 2000 lines) — split it into smaller edits.' };
  }

  const resolved = await resolveWriteTarget('edit_lines', inputPath, ctx);
  if (!resolved.ok) return resolved.result;

  return replaceLineRange(resolved.target, ctx, {
    range: { from, to },
    dryRun, expectedReadHash, preserveEol, verifySyntax, newString,
    toolName: 'edit_lines',
  });
}