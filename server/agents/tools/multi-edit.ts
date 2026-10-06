/**
 * agent__multi_edit — atomic multi-edit: apply a batch of { oldString,
 * newString, replaceAll? } replacements to ONE file, all-or-nothing. Every
 * oldString is verified sequentially (each against the result of the
 * previous); NOTHING is written unless the whole batch validates — one
 * snapshot, one diff.
 *
 * Same safety posture as edit_file (read-before-edit, optimistic concurrency,
 * EOL preservation, syntax-guard rollback) via the shared edit-core.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, bool } from './shared.js';
import { diagnoseNoMatch, diagnoseMultiMatch, occurrenceLines } from '../edit-diagnostics.js';
import { resolveWriteTarget, loadEditable, finishEdit } from './edit-core.js';

interface MultiEdit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export async function multiEditTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const inputPath = str(args, 'path');
  const dryRun = bool(args, 'dryRun');
  const expectedReadHash = str(args, 'expectedReadHash').trim();
  const preserveEol = args.preserveEol === undefined ? true : bool(args, 'preserveEol');
  const verifySyntax = args.verifySyntax === undefined ? true : bool(args, 'verifySyntax');

  const parsed = parseMultiEdits(args.edits);
  if (parsed.error) return { ok: false, isError: true, text: parsed.error };
  if (!parsed.edits) {
    return { ok: false, isError: true, text: 'multi_edit needs a native "edits" array of { oldString, newString, replaceAll? }.' };
  }

  const resolved = await resolveWriteTarget('multi_edit', inputPath, ctx);
  if (!resolved.ok) return resolved.result;
  const { absolute, relative } = resolved.target;

  const loaded = loadEditable(resolved.target, ctx, 'multi_edit', expectedReadHash);
  if (!loaded.ok) return loaded.result;
  const content = loaded.data.content;

  let work = content;
  let normalizedWork = false;
  for (let index = 0; index < parsed.edits.length; index += 1) {
    const edit = parsed.edits[index];
    let occurrences = occurrenceLines(work, edit.oldString);
    if (occurrences.length === 0 && !edit.oldString.includes('\r')) {
      const normContent = work.replace(/\r\n/g, '\n');
      if (normContent !== work) {
        const normOccurrences = occurrenceLines(normContent, edit.oldString);
        if (normOccurrences.length > 0) {
          work = normContent;
          normalizedWork = true;
          occurrences = normOccurrences;
        }
      }
    }
    if (occurrences.length === 0) {
      const failure = diagnoseNoMatch({ relative, content: work, oldString: edit.oldString });
      return {
        ok: false, isError: true,
        text: `edits[${index}] did not match — BATCH CANCELLED, nothing was written.\n${failure.report}`,
      };
    }
    if (occurrences.length > 1 && !edit.replaceAll) {
      const failure = diagnoseMultiMatch(relative, occurrences, edit.replaceAll);
      return {
        ok: false, isError: true,
        text: `edits[${index}] matches ${occurrences.length} times — BATCH CANCELLED, nothing was written.\n${failure.report}`,
      };
    }
    let replacement = edit.newString;
    if (
      preserveEol && !normalizedWork && replacement.includes('\n') &&
      work.includes('\r\n') && !replacement.includes('\r\n')
    ) {
      replacement = replacement.replace(/\n/g, '\r\n');
    }
    if (edit.replaceAll) {
      work = work.split(edit.oldString).join(replacement);
    } else {
      const pos = work.indexOf(edit.oldString);
      work = work.slice(0, pos) + replacement + work.slice(pos + edit.oldString.length);
    }
  }

  return finishEdit(
    ctx, absolute, relative, content, work, normalizedWork, parsed.edits.length,
    dryRun, verifySyntax, 'multi_edit',
    ` Atomic multi-edit: ${parsed.edits.length} replacement(s) applied in sequence.`,
  );
}

function parseMultiEdits(value: unknown): { edits?: MultiEdit[]; error?: string } {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) {
    return {
      error:
        `edits must be a NATIVE array of { oldString, newString, replaceAll? } — got ` +
        `${value === null ? 'null' : typeof value}. Pass a native array, e.g. ` +
        `edits: [{ "oldString": "old", "newString": "new" }], not a JSON-encoded string.`,
    };
  }
  if (value.length === 0) return { error: 'edits must contain at least one entry.' };
  if (value.length > 50) return { error: 'edits too large (max 50 per call — split into smaller batches).' };
  const edits: MultiEdit[] = [];
  const errors: string[] = [];
  let badCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index] as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      badCount += 1;
      if (errors.length < 3) errors.push(`edits[${index}] must be an object { oldString, newString }.`);
      continue;
    }
    const oldString = typeof raw.oldString === 'string' ? raw.oldString : '';
    const newString = typeof raw.newString === 'string' ? raw.newString : '';
    if (oldString === '') {
      badCount += 1;
      if (errors.length < 3) errors.push(`edits[${index}].oldString must be non-empty (file creation is not part of a batch).`);
      continue;
    }
    if (oldString === newString) {
      badCount += 1;
      if (errors.length < 3) errors.push(`edits[${index}].oldString equals its newString — a guaranteed no-op (use an empty newString to delete the match instead).`);
      continue;
    }
    edits.push({ oldString, newString, replaceAll: raw.replaceAll === true });
  }
  if (badCount > 0) {
    const more = badCount > errors.length ? ` (${badCount - errors.length} more not shown)` : '';
    return {
      error:
        `edits has ${badCount} problem(s)${more}:\n  • ${errors.join('\n  • ')}\n` +
        `Fix all and resend in one call.`,
    };
  }
  return { edits };
}