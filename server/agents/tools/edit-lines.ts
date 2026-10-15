/**
 * agent__edit_lines — replace a line RANGE (1-based, inclusive) with newString.
 * The range MUST lie inside the window the model actually read on the current
 * revision — no blind line surgery. Same safety posture as edit_file via the
 * shared edit-core.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, bool, numField } from './shared.js';
import { resolveWriteTarget, replaceLineRange, loadEditable } from './edit-core.js';

export async function editLinesTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const inputPath = str(args, 'path');
  const newString = str(args, 'newString');
  const dryRun = bool(args, 'dryRun');
  const expectedReadHash = str(args, 'expectedReadHash').trim();
  const preserveEol = args.preserveEol === undefined ? true : bool(args, 'preserveEol');
  const verifySyntax = args.verifySyntax === undefined ? true : bool(args, 'verifySyntax');

  // Anchor baris OPSIONAL: bila model melampirkan teks yang ia yakin ada di
  // baris from/to, mismate off-by-one tertangkap SEBELUM penulisan.
  const expectedStartLine = str(args, 'expectedStartLine').trim();
  const expectedEndLine = str(args, 'expectedEndLine').trim();

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

  if (!resolved.target.exists) {
    return replaceLineRange(resolved.target, ctx, {
      range: { from, to },
      dryRun, expectedReadHash, preserveEol, verifySyntax, newString,
      toolName: 'edit_lines',
    });
  }

  // Verifikasi anchor: muat file sekali, cocokkan teks baris, lalu lempar
  // hasil muatannya ke replaceLineRange (tanpa pembacaan disk kedua).
  if (expectedStartLine || expectedEndLine) {
    const loaded = loadEditable(resolved.target, ctx, 'edit_lines', expectedReadHash);
    if (!loaded.ok) return loaded.result;
    const base = loaded.data.content.replace(/\r\n/g, '\n');
    const rawLines = base.split('\n');
    const view = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
    if (expectedStartLine) {
      const actual = (view[from - 1] ?? '').trim();
      if (!actual.includes(expectedStartLine)) {
        return {
          ok: false, isError: true,
          text:
            `expectedStartLine mismatch at line ${from}: line reads \`${actual.slice(0, 120)}\`, ` +
            `your anchor was \`${expectedStartLine.slice(0, 120)}\`. ` +
            `Line numbers are stale — re-read with agent__read_file and retry (or drop expectedStartLine to edit blindly).`,
        };
      }
    }
    if (expectedEndLine) {
      const actual = (view[to - 1] ?? '').trim();
      if (!actual.includes(expectedEndLine)) {
        return {
          ok: false, isError: true,
          text:
            `expectedEndLine mismatch at line ${to}: line reads \`${actual.slice(0, 120)}\`, ` +
            `your anchor was \`${expectedEndLine.slice(0, 120)}\`. ` +
            `Line numbers are stale — re-read with agent__read_file and retry (or drop expectedEndLine to edit blindly).`,
        };
      }
    }
    return replaceLineRange(resolved.target, ctx, {
      range: { from, to },
      dryRun, expectedReadHash, preserveEol, verifySyntax, newString,
      toolName: 'edit_lines',
      preloaded: loaded.data,
    });
  }

  return replaceLineRange(resolved.target, ctx, {
    range: { from, to },
    dryRun, expectedReadHash, preserveEol, verifySyntax, newString,
    toolName: 'edit_lines',
  });
}