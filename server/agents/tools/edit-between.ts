/**
 * agent__edit_between — replace everything between two UNIQUE anchors. The
 * region resolves to a line range and executes through replaceLineRange, so
 * the whole safe path (read-receipt, snapshot, syntax guard) applies
 * unchanged. start must match exactly once; end is the FIRST occurrence after
 * start (more than one after start -> refused with a pointer to edit_lines).
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, bool, num } from './shared.js';
import { diagnoseNoMatch, occurrenceLines } from '../edit-diagnostics.js';
import { isRangeCoveredByReadEntry } from '../read-policy.js';
import { resolveWriteTarget, loadEditable, replaceLineRange } from './edit-core.js';

export async function editBetweenTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const inputPath = str(args, 'path');
  const dryRun = bool(args, 'dryRun');
  const expectedReadHash = str(args, 'expectedReadHash').trim();
  const verifySyntax = args.verifySyntax === undefined ? true : bool(args, 'verifySyntax');
  const lineHint = num(args, 'lineHint');

  const rawStart = str(args, 'start');
  const rawEnd = str(args, 'end');
  if (!rawStart || !rawEnd) {
    return { ok: false, isError: true, text: 'edit_between needs non-empty "start" and "end" anchor strings.' };
  }
  const newString = str(args, 'newString');
  const includeAnchors = bool(args, 'includeAnchors');

  const resolved = await resolveWriteTarget('edit_between', inputPath, ctx);
  if (!resolved.ok) return resolved.result;
  const { relative } = resolved.target;

  const loaded = loadEditable(resolved.target, ctx, 'edit_between', expectedReadHash);
  if (!loaded.ok) return loaded.result;
  const { content, readEntry } = loaded.data;

  const normContent = content.includes('\r\n') ? content.replace(/\r\n/g, '\n') : content;
  const start = rawStart.replace(/\r\n/g, '\n');
  const end = rawEnd.replace(/\r\n/g, '\n');

  const startSpanLines = start.split('\n').length;
  const endSpanLines = end.split('\n').length;

  let startOcc = occurrenceLines(normContent, start);
  if (startOcc.length === 0) {
    const failure = diagnoseNoMatch({ relative, content: normContent, oldString: start, lineHint });
    return { ok: false, isError: true, text: `edit_between start anchor not found.\n${failure.report}` };
  }

  // Disambiguasi start anchor: prioritaskan lineHint, lalu kemunculan di
  // dalam jendela yang sudah dibaca — bukan langsung menolak.
  if (startOcc.length > 1) {
    if (lineHint !== undefined) {
      const sorted = [...startOcc].sort((a, b) => Math.abs(a - lineHint) - Math.abs(b - lineHint));
      if (Math.abs(sorted[0] - lineHint) < Math.abs(sorted[1] - lineHint)) {
        startOcc = [sorted[0]];
      }
    } else if (readEntry && readEntry.toLine < Number.MAX_SAFE_INTEGER) {
      const inReadWindow = startOcc.filter((ln) => isRangeCoveredByReadEntry(readEntry, ln, ln + startSpanLines - 1));
      if (inReadWindow.length === 1) {
        startOcc = inReadWindow;
      }
    }
  }

  if (startOcc.length > 1) {
    return {
      ok: false, isError: true,
      text:
        `edit_between start anchor matches ${startOcc.length} times (lines ${startOcc.slice(0, 8).join(', ')}${startOcc.length > 8 ? ', …' : ''}) — anchors must be unique. ` +
        `Next step: pass lineHint to disambiguate, use a longer start anchor, or use agent__edit_lines.`,
    };
  }
  const startLine = startOcc[0];
  const startEndLine = startLine + startSpanLines - 1;

  const endOcc = occurrenceLines(normContent, end);
  // Anchor `end` harus dimulai SETELAH baris terakhir anchor `start`.
  const endAfter = endOcc.filter((ln) => ln > startEndLine);
  if (endAfter.length === 0) {
    return {
      ok: false, isError: true,
      text:
        (endOcc.length === 0
          ? `edit_between end anchor not found.\n${diagnoseNoMatch({ relative, content: normContent, oldString: end }).report}`
          : `edit_between end anchor only appears BEFORE or INSIDE the start anchor (line ${endOcc[0]} vs start lines ${startLine}–${startEndLine}) — pick an anchor after line ${startEndLine}. `) +
        'Alternatively use agent__edit_lines with an explicit range.',
    };
  }

  // Beberapa kemunculan `end` setelah start: firstMatchEnd: true memilih yang
  // pertama; jika hanya satu yang membuat seluruh region berada di jendela
  // baca, pilih itu — bukan langsung menolak.
  let selectedEndMatches = endAfter;
  if (selectedEndMatches.length > 1 && bool(args, 'firstMatchEnd')) {
    selectedEndMatches = [selectedEndMatches[0]];
  } else if (selectedEndMatches.length > 1 && readEntry && readEntry.toLine < Number.MAX_SAFE_INTEGER) {
    const inRead = selectedEndMatches.filter((ln) => isRangeCoveredByReadEntry(readEntry, startLine, ln + endSpanLines - 1));
    if (inRead.length === 1) selectedEndMatches = inRead;
  }

  if (selectedEndMatches.length > 1) {
    return {
      ok: false, isError: true,
      text:
        `edit_between end anchor matches ${selectedEndMatches.length} times after the start anchor (lines ${selectedEndMatches.slice(0, 8).join(', ')}${selectedEndMatches.length > 8 ? ', …' : ''}). ` +
        `Next step: pick a more specific end anchor, pass firstMatchEnd: true to stop at line ${selectedEndMatches[0]}, or use agent__edit_lines.`,
    };
  }
  const endLine = selectedEndMatches[0];
  const endEndLine = endLine + endSpanLines - 1;

  // Batas baris yang benar untuk anchor BANYAK BARIS:
  //  • includeAnchors: false → mulai SETELAH baris terakhir anchor start
  //    (dulu `startLine + 1` menghapus ekor anchor start sendiri);
  //  • includeAnchors: true → berhenti di baris terakhir anchor end
  //    (dulu `endLine` menyisakan potongan baris anchor end).
  const from = includeAnchors ? startLine : startEndLine + 1;
  const to = includeAnchors ? endEndLine : endLine - 1;
  if (from > to) {
    return {
      ok: false, isError: true,
      text:
        `edit_between anchors touch: start occupies lines ${startLine}–${startEndLine}, end occupies lines ${endLine}–${endEndLine}, leaving nothing between them` +
        `${includeAnchors ? ' — use distinct start/end anchors.' : ' with includeAnchors: false — retry with includeAnchors: true to replace the anchors too, or use agent__insert_at_line.'}`,
    };
  }

  const rawLines = normContent.split('\n');
  const view = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
  const regionText = view.slice(from - 1, to).join('\n');
  const normNew = newString.replace(/\r\n/g, '\n');
  if (regionText === normNew || regionText + '\n' === normNew) {
    return {
      ok: false, isError: true,
      text: 'edit_between is a guaranteed no-op: the region between the anchors already equals "newString". Provide different replacement text.',
    };
  }

  return replaceLineRange(resolved.target, ctx, {
    range: { from, to },
    dryRun,
    expectedReadHash,
    preserveEol: true,
    verifySyntax,
    newString,
    toolName: 'edit_between',
    preloaded: loaded.data, // hindari pembacaan disk kedua di replaceLineRange
    note:
      ` Replaced lines ${from}–${to} between anchors ` +
      `(start lines ${startLine}–${startEndLine}, end lines ${endLine}–${endEndLine}${includeAnchors ? ', anchors included' : ', anchors kept'}).`,
  });
}