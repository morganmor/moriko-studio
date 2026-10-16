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
import {
  diagnoseNoMatch, diagnoseMultiMatch, occurrenceLines,
  positionOfOccurrenceNearLine, matchWithElasticIndent, plausiblyApplied,
} from '../edit-diagnostics.js';
import { isRangeCoveredByReadEntry, outOfRangeMessage, shiftIntervalsForEdit } from '../read-policy.js';
import { resolveWriteTarget, loadEditable, finishEdit } from './edit-core.js';

interface MultiEditItem {
  oldString: string;
  newString: string;
  replaceAll: boolean;
  lineHint?: number;
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
    return { ok: false, isError: true, text: 'multi_edit needs a native "edits" array of { oldString, newString, replaceAll?, lineHint? }.' };
  }

  const resolved = await resolveWriteTarget('multi_edit', inputPath, ctx);
  if (!resolved.ok) return resolved.result;
  const { absolute, relative } = resolved.target;

  const loaded = loadEditable(resolved.target, ctx, 'multi_edit', expectedReadHash);
  if (!loaded.ok) return loaded.result;
  const content = loaded.data.content;
  const readEntry = loaded.data.readEntry;

  let activeIntervals = readEntry?.intervals
    ? [...readEntry.intervals.map((i) => ({ ...i }))]
    : readEntry
      ? [{ from: readEntry.fromLine, to: readEntry.toLine }]
      : [];
  const fullFileRead = !readEntry || readEntry.toLine >= Number.MAX_SAFE_INTEGER;

  let work = content;
  let normalizedWork = false;
  let elasticCount = 0;
  let skippedAlreadyApplied = 0;

  for (let index = 0; index < parsed.edits.length; index += 1) {
    const edit = parsed.edits[index];
    let targetOld = edit.oldString;
    let replacement = edit.newString;

    let occurrences = occurrenceLines(work, targetOld);
    if (occurrences.length === 0 && !targetOld.includes('\r')) {
      const normContent = work.replace(/\r\n/g, '\n');
      if (normContent !== work) {
        const normOccurrences = occurrenceLines(normContent, targetOld);
        if (normOccurrences.length > 0) {
          work = normContent;
          normalizedWork = true;
          occurrences = normOccurrences;
        }
      }
    }

    if (occurrences.length === 0) {
      if (replacement && work.includes(replacement) && plausiblyApplied(targetOld, replacement)) {
        skippedAlreadyApplied += 1;
        continue;
      }
      const normWork = normalizedWork ? work : work.replace(/\r\n/g, '\n');
      const elastic = matchWithElasticIndent(
        normWork,
        targetOld.replace(/\r\n/g, '\n'),
        replacement.replace(/\r\n/g, '\n'),
      );
      if (elastic.status === 'unique') {
        work = normWork;
        normalizedWork = content.includes('\r\n');
        targetOld = elastic.match.matchedOriginalSlice;
        replacement = elastic.match.reindentedNewString;
        occurrences = [elastic.match.startLine];
        elasticCount += 1;
      } else {
        const failure = diagnoseNoMatch({ relative, content: work, oldString: edit.oldString, lineHint: edit.lineHint });
        return {
          ok: false, isError: true,
          text: `edits[${index}] did not match — BATCH CANCELLED, nothing was written.\n${failure.report}`,
        };
      }
    }

    let selectedLine: number | null = occurrences.length === 1 ? occurrences[0] : null;
    if (occurrences.length > 1 && !edit.replaceAll) {
      if (edit.lineHint !== undefined) {
        let bestLine: number | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        let ties = 0;
        for (const ln of occurrences) {
          const d = Math.abs(ln - edit.lineHint);
          if (d < bestDist) { bestDist = d; bestLine = ln; ties = 1; }
          else if (d === bestDist) { ties += 1; }
        }
        if (bestLine !== null && ties === 1) selectedLine = bestLine;
      }
      if (selectedLine === null) {
        const failure = diagnoseMultiMatch(relative, occurrences, edit.replaceAll);
        return {
          ok: false, isError: true,
          text: `edits[${index}] matches ${occurrences.length} times — BATCH CANCELLED, nothing was written.\n${failure.report}`,
        };
      }
    }

    if (!fullFileRead && readEntry) {
      const linesToCheck = edit.replaceAll ? occurrences : [selectedLine!];
      const oldSpan = Math.max(targetOld.split('\n').length, 1);
      for (const ln of linesToCheck) {
        const covered = isRangeCoveredByReadEntry(
          { fromLine: readEntry.fromLine, toLine: readEntry.toLine, intervals: activeIntervals },
          ln,
          ln + oldSpan - 1,
        );
        if (!covered) {
          return {
            ok: false, isError: true,
            text: `edits[${index}] targets unread lines — BATCH CANCELLED.\n` +
              outOfRangeMessage(relative, readEntry.fromLine, readEntry.toLine, ln, {
                fromLine: readEntry.fromLine,
                toLine: readEntry.toLine,
                intervals: activeIntervals,
              }),
          };
        }
      }
    }

    if (
      preserveEol && !normalizedWork && replacement.includes('\n') &&
      work.includes('\r\n') && !replacement.includes('\r\n')
    ) {
      replacement = replacement.replace(/\n/g, '\r\n');
    }

    const oldSpanLines = Math.max(targetOld.split('\n').length, 1);
    const newSpanLines = Math.max(replacement.split('\n').length, 1);

    if (edit.replaceAll) {
      work = work.split(targetOld).join(replacement);
    } else {
      const pos = positionOfOccurrenceNearLine(work, targetOld, selectedLine!);
      work = work.slice(0, pos) + replacement + work.slice(pos + targetOld.length);
      if (!fullFileRead && readEntry) {
        activeIntervals = shiftIntervalsForEdit(
          activeIntervals,
          readEntry.fromLine,
          readEntry.toLine,
          selectedLine!,
          oldSpanLines,
          newSpanLines,
        );
      }
    }
  }

  if (skippedAlreadyApplied === parsed.edits.length) {
    return {
      ok: true,
      isError: false,
      text: `already applied — all ${parsed.edits.length} edit(s) in the batch are already present in ${relative}. No changes were written.`,
    };
  }

  const extraNotes =
    (elasticCount > 0 ? ` (${elasticCount} item(s) auto-aligned via elastic indentation.)` : '') +
    (skippedAlreadyApplied > 0 ? ` (${skippedAlreadyApplied} item(s) already present, skipped.)` : '');

  return finishEdit(
    ctx, absolute, relative, content, work, normalizedWork,
    Math.max(parsed.edits.length - skippedAlreadyApplied, 1),
    dryRun, verifySyntax, 'multi_edit',
    ` Atomic multi-edit: ${parsed.edits.length} item(s) processed.${extraNotes}`,
  );
}

function parseMultiEdits(value: unknown): { edits?: MultiEditItem[]; error?: string } {
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
  const edits: MultiEditItem[] = [];
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
    edits.push({
      oldString,
      newString,
      replaceAll: raw.replaceAll === true,
      lineHint: typeof raw.lineHint === 'number' && Number.isFinite(raw.lineHint) ? Math.trunc(raw.lineHint) : undefined,
    });
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