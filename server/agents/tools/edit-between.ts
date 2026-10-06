/**
 * agent__edit_between — replace everything between two UNIQUE anchors. The
 * region resolves to a line range and executes through replaceLineRange, so
 * the whole safe path (read-receipt, snapshot, syntax guard) applies
 * unchanged. start must match exactly once; end is the FIRST occurrence after
 * start (more than one after start -> refused with a pointer to edit_lines).
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, bool } from './shared.js';
import { diagnoseNoMatch, occurrenceLines } from '../edit-diagnostics.js';
import { resolveWriteTarget, loadEditable, replaceLineRange } from './edit-core.js';

export async function editBetweenTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const inputPath = str(args, 'path');
  const dryRun = bool(args, 'dryRun');
  const expectedReadHash = str(args, 'expectedReadHash').trim();
  const verifySyntax = args.verifySyntax === undefined ? true : bool(args, 'verifySyntax');

  const start = str(args, 'start');
  const end = str(args, 'end');
  if (!start || !end) {
    return { ok: false, isError: true, text: 'edit_between needs non-empty "start" and "end" anchor strings.' };
  }
  const newString = str(args, 'newString');
  const includeAnchors = bool(args, 'includeAnchors');

  const resolved = await resolveWriteTarget('edit_between', inputPath, ctx);
  if (!resolved.ok) return resolved.result;
  const { relative } = resolved.target;

  const loaded = loadEditable(resolved.target, ctx, 'edit_between', expectedReadHash);
  if (!loaded.ok) return loaded.result;
  const content = loaded.data.content;

  const normContent = content.includes('\r\n') ? content.replace(/\r\n/g, '\n') : content;
  const startOcc = occurrenceLines(normContent, start);
  if (startOcc.length === 0) {
    const failure = diagnoseNoMatch({ relative, content: normContent, oldString: start });
    return { ok: false, isError: true, text: `edit_between start anchor not found.\n${failure.report}` };
  }
  if (startOcc.length > 1) {
    return {
      ok: false, isError: true,
      text:
        `edit_between start anchor matches ${startOcc.length} times (lines ${startOcc.slice(0, 8).join(', ')}${startOcc.length > 8 ? ', …' : ''}) — anchors must be unique. ` +
        `Next step: use agent__edit_lines with an explicit range, or pick a longer anchor.`,
    };
  }
  const startLine = startOcc[0];
  const endOcc = occurrenceLines(normContent, end);
  const endAfter = endOcc.filter((ln) => ln > startLine);
  if (endAfter.length === 0) {
    return {
      ok: false, isError: true,
      text:
        (endOcc.length === 0
          ? `edit_between end anchor not found.\n${diagnoseNoMatch({ relative, content: normContent, oldString: end }).report}`
          : `edit_between end anchor only appears BEFORE the start anchor (line ${endOcc[0]} vs start ${startLine}) — pick an anchor after line ${startLine}. `) +
        'Alternatively use agent__edit_lines with an explicit range.',
    };
  }
  if (endAfter.length > 1) {
    return {
      ok: false, isError: true,
      text:
        `edit_between end anchor matches ${endAfter.length} times after the start anchor (lines ${endAfter.slice(0, 8).join(', ')}${endAfter.length > 8 ? ', …' : ''}) — anchors must be unique. ` +
        `Next step: use agent__edit_lines with an explicit range, or pick a longer anchor.`,
    };
  }
  const endLine = endAfter[0];
  const from = includeAnchors ? startLine : startLine + 1;
  const to = includeAnchors ? endLine : endLine - 1;
  if (from > to) {
    return {
      ok: false, isError: true,
      text:
        `edit_between anchors touch: start is line ${startLine}, end is line ${endLine}, leaving nothing to replace` +
        `${includeAnchors ? ' — use distinct start/end anchors.' : ' with includeAnchors: false — retry with includeAnchors: true to replace the anchors too.'}`,
    };
  }

  // No-op guard: replacing the region with identical text is a guaranteed no-op.
  const rawLines = normContent.split('\n');
  const view = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
  const regionText = view.slice(from - 1, to).join('\n');
  if (regionText === newString || regionText + '\n' === newString) {
    return {
      ok: false, isError: true,
      text: 'edit_between is a guaranteed no-op: the region between the anchors already equals "newString". Provide different replacement text.',
    };
  }

  return replaceLineRange(resolved.target, ctx, {
    range: { from, to },
    dryRun, expectedReadHash, preserveEol: true, verifySyntax,
    newString,
    toolName: 'edit_between',
    note:
      ` Replaced lines ${from}–${to} between anchors ` +
      `(start anchor line ${startLine}, end anchor line ${endLine}${includeAnchors ? ', anchors included' : ', anchors kept'}).`,
  });
}