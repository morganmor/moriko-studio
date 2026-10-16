/**
 * agent__edit_file — the DEFAULT edit tool: anchor mode (oldString/newString).
 * Replaces the first occurrence of oldString with newString (or every
 * occurrence when replaceAll: true). Unique-match by default; multiple matches
 * are disambiguated with lineHint or refused with their line numbers.
 *
 * Safety posture (shared via edit-core): read-before-edit policy, optimistic
 * concurrency (expectedReadHash), read-range enforcement, EOL preservation,
 * idempotency guard, prescriptive diagnosis, and a syntax guard that rolls
 * back broken writes.
 *
 * The other edit shapes live in their own tools: agent__multi_edit (batch),
 * agent__edit_lines (line range), agent__edit_between (anchor pair),
 * agent__insert_at_line (insert/append). File creation is agent__write.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, bool } from './shared.js';
import {
  diagnoseNoMatch, diagnoseMultiMatch, occurrenceLines,
  positionOfOccurrenceNearLine, plausiblyApplied, matchWithElasticIndent,
} from '../edit-diagnostics.js';
import { outOfRangeMessage, isRangeCoveredByReadEntry } from '../read-policy.js';
import { resolveWriteTarget, loadEditable, finishEdit } from './edit-core.js';

export async function editDefaultTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const oldString = str(args, 'oldString');
  const newString = str(args, 'newString');
  const replaceAll = bool(args, 'replaceAll');
  const dryRun = bool(args, 'dryRun');
  const expectedReadHash = str(args, 'expectedReadHash').trim();
  const lineHint = num(args, 'lineHint');
  const preserveEol = args.preserveEol === undefined ? true : bool(args, 'preserveEol');
  const verifySyntax = args.verifySyntax === undefined ? true : bool(args, 'verifySyntax');

  if (!('oldString' in args)) {
    return {
      ok: false, isError: true,
      text:
        'edit_file (anchor mode) needs an oldString/newString pair. File creation → agent__write; ' +
        'line ranges → agent__edit_lines; batch → agent__multi_edit; between-anchors → agent__edit_between; ' +
        'insertion → agent__insert_at_line.',
    };
  }
  if (oldString === '') {
    return {
      ok: false, isError: true,
      text: 'edit_file no longer creates files (empty oldString). Use agent__write to create a new file.',
    };
  }
  if (oldString === newString) {
    return {
      ok: false, isError: true,
      text: 'edit_file is a guaranteed no-op: oldString equals newString. Provide a different replacement (or use an empty newString to delete the match).',
    };
  }

  const resolved = await resolveWriteTarget('edit_file', str(args, 'path'), ctx);
  if (!resolved.ok) return resolved.result;
  const { absolute, relative, exists } = resolved.target;

  if (!exists) {
    return {
      ok: false, isError: true,
      text: `No such file: ${relative}. Create it with agent__write, or check the path with agent__list.`,
    };
  }

  const loaded = loadEditable(resolved.target, ctx, 'edit_file', expectedReadHash);
  if (!loaded.ok) return loaded.result;
  const content = loaded.data.content;
  const readEntry = loaded.data.readEntry;

  const rawOccurrences = occurrenceLines(content, oldString);
  let effectiveContent = content;
  let effectiveOldString = oldString;
  let normalized = false;

  if (rawOccurrences.length === 0 && content.includes('\r\n') && !oldString.includes('\r')) {
    const normContent = content.replace(/\r\n/g, '\n');
    const normOcc = occurrenceLines(normContent, oldString);
    if (normOcc.length > 0) {
      effectiveContent = normContent;
      effectiveOldString = oldString;
      normalized = true;
    }
  }

  let occurrences = normalized
    ? occurrenceLines(effectiveContent, effectiveOldString)
    : rawOccurrences;

  let effectiveNew = newString;
  let eolAdapted = false;
  let indentAligned = false;
  if (
    preserveEol && !normalized && newString.includes('\n') &&
    content.includes('\r\n') && !newString.includes('\r\n')
  ) {
    effectiveNew = newString.replace(/\n/g, '\r\n');
    eolAdapted = true;
  }

  if (occurrences.length === 0) {
    if (newString && content.includes(newString) && plausiblyApplied(oldString, newString)) {
      return {
        ok: true, isError: false,
        text:
          `already applied — oldString is absent but newString is already present in ${relative}. ` +
          'No changes were written. If this is unexpected, re-read the region before editing.',
      };
    }
    const normCheck = normalized ? effectiveContent : content.replace(/\r\n/g, '\n');
    const normOld = oldString.replace(/\r\n/g, '\n');
    const normNew = newString.replace(/\r\n/g, '\n');
    const elastic = matchWithElasticIndent(normCheck, normOld, normNew);
    if (elastic.status === 'unique') {
      effectiveContent = normCheck;
      effectiveOldString = elastic.match.matchedOriginalSlice;
      effectiveNew = elastic.match.reindentedNewString;
      normalized = content.includes('\r\n');
      occurrences = [elastic.match.startLine];
      indentAligned = true;
    } else {
      const failure = diagnoseNoMatch({ relative, content: effectiveContent, oldString, lineHint });
      return { ok: false, isError: true, text: failure.report };
    }
  }

  // BUG (lineHint ditolak lebih awal diperbaiki): disambiguasi target DIJALANKAN
  let targetLinesToVerify: number[] = [];
  let selectedOccurrenceLine: number | null = null;

  if (occurrences.length === 1) {
    selectedOccurrenceLine = occurrences[0];
    targetLinesToVerify = [occurrences[0]];
  } else if (replaceAll) {
    targetLinesToVerify = occurrences;
  } else {
    if (lineHint !== undefined) {
      let bestLine: number | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      let ties = 0;
      for (const ln of occurrences) {
        const distance = Math.abs(ln - lineHint);
        if (distance < bestDist) {
          bestDist = distance;
          bestLine = ln;
          ties = 1;
        } else if (distance === bestDist) {
          ties += 1;
        }
      }
      if (bestLine !== null && ties === 1) {
        selectedOccurrenceLine = bestLine;
        targetLinesToVerify = [bestLine];
      }
    }
    if (selectedOccurrenceLine === null) {
      const failure = diagnoseMultiMatch(relative, occurrences, replaceAll);
      return { ok: false, isError: true, text: failure.report };
    }
  }

  const eolNote =
    (eolAdapted ? ' newString line endings were adapted to the file\'s CRLF.' : '') +
    (indentAligned ? ' (matched via elastic indentation; newString auto-indented to match file.)' : '');

  if (readEntry && readEntry.toLine < Number.MAX_SAFE_INTEGER) {
    const spanLen = Math.max(effectiveOldString.split('\n').length, 1);
    for (const anchorLine of targetLinesToVerify) {
      if (!isRangeCoveredByReadEntry(readEntry, anchorLine, anchorLine + spanLen - 1)) {
        return {
          ok: false,
          isError: true,
          text: outOfRangeMessage(relative, readEntry.fromLine, readEntry.toLine, anchorLine, readEntry),
        };
      }
    }
  }

  let nextContent: string;
  if (replaceAll) {
    nextContent = effectiveContent.split(effectiveOldString).join(effectiveNew);
  } else {
    const pos = positionOfOccurrenceNearLine(effectiveContent, effectiveOldString, selectedOccurrenceLine!);
    nextContent =
      effectiveContent.slice(0, pos) + effectiveNew + effectiveContent.slice(pos + effectiveOldString.length);
  }

  return finishEdit(
    ctx, absolute, relative, content, nextContent, normalized,
    replaceAll ? occurrences.length : 1, dryRun, verifySyntax, 'edit_file', eolNote,
  );
}