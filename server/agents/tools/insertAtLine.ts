/**
 * agent__insert_at_line — place newString BEFORE a given line (or at EOF via
 * append: true) through the same safe path as edit_file: read-before-edit +
 * optimistic concurrency + read-range enforcement (the insertion point must
 * touch the window the model actually read), LF-space splice, vault snapshot,
 * syntax guard.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, bool } from './shared.js';
import { resolveWriteTarget, loadEditable, finishEdit } from './edit-core.js';

interface InsertSpec {
  line: number | null;
  append: boolean;
}

export async function insertAtLineTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const inputPath = str(args, 'path');
  const newString = str(args, 'newString');
  const dryRun = bool(args, 'dryRun');
  const expectedReadHash = str(args, 'expectedReadHash').trim();
  const verifySyntax = args.verifySyntax === undefined ? true : bool(args, 'verifySyntax');

  const insert = parseInsert({ insertAtLine: args.insertAtLine, append: args.append });
  if (insert.error) return { ok: false, isError: true, text: insert.error };
  if (!insert.spec) {
    return { ok: false, isError: true, text: 'insert_at_line needs "insertAtLine" (a 1-based line) or "append": true.' };
  }

  const resolved = await resolveWriteTarget('insert_at_line', inputPath, ctx);
  if (!resolved.ok) return resolved.result;
  const { absolute, relative } = resolved.target;

  const loaded = loadEditable(resolved.target, ctx, 'insert_at_line', expectedReadHash);
  if (!loaded.ok) return loaded.result;
  const content = loaded.data.content;
  const readEntry = loaded.data.readEntry;

  const crlf = content.includes('\r\n');
  const base = crlf ? content.replace(/\r\n/g, '\n') : content;
  const rawLines = base.split('\n');
  const view = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;

  const insertAt = insert.spec.append ? view.length + 1 : insert.spec.line as number;
  if (insertAt > view.length + 1) {
    return {
      ok: false, isError: true,
      text: `insertAtLine ${insertAt} is past EOF — "${relative}" has ${view.length} line(s) (use ${view.length + 1}, or append: true for EOF).`,
    };
  }

  if (readEntry && readEntry.toLine < Number.MAX_SAFE_INTEGER) {
    const touches = insertAt >= readEntry.fromLine && insertAt <= readEntry.toLine + 1;
    if (!touches) {
      return {
        ok: false, isError: true,
        text:
          `insertion before line ${insertAt} is outside your read window (${readEntry.fromLine}–${readEntry.toLine}) for "${relative}". ` +
          `Insert only where you have actually seen the neighborhood. ` +
          `Next step: agent__read_file path="${relative}" offsetLine=${Math.max(1, insertAt - 10)} maxLines=25, then retry.`,
      };
    }
  }

  const newLines = newString === '' ? [] : newString.replace(/\r/g, '').split('\n');
  if (newLines.length === 0) {
    return { ok: false, isError: true, text: 'Insert needs non-empty "newString" content (an empty insert would be a no-op).' };
  }
  const at = insertAt - 1;
  let next = [...view.slice(0, at), ...newLines, ...view.slice(at)].join('\n');
  if (base.endsWith('\n') && !next.endsWith('\n')) next += '\n';
  if (crlf) next = next.replace(/\n/g, '\r\n');

  return finishEdit(
    ctx, absolute, relative, content, next, false,
    newLines.length, dryRun, verifySyntax, 'insert_at_line',
    insert.spec.append
      ? ` Appended ${newLines.length} line(s) at EOF via append.`
      : ` Inserted ${newLines.length} line(s) before line ${insertAt} via insertAtLine.`,
  );
}

function parseInsert(value: { insertAtLine: unknown; append: unknown }): { spec?: InsertSpec; error?: string } {
  const hasLine = value.insertAtLine !== undefined && value.insertAtLine !== null;
  const hasAppend = value.append === true;
  if (!hasLine && !hasAppend) return {};
  if (hasLine && hasAppend) {
    return { error: 'Pass either insertAtLine or append — not both (append: true already means EOF).' };
  }
  if (hasAppend) return { spec: { line: null, append: true } };
  const line = typeof value.insertAtLine === 'number' && Number.isFinite(value.insertAtLine)
    ? Math.trunc(value.insertAtLine)
    : NaN;
  if (!Number.isFinite(line) || line < 1) {
    return {
      error:
        'insertAtLine must be a positive 1-based line number (newString is inserted BEFORE it), ' +
        'e.g. insertAtLine: 10.',
    };
  }
  return { spec: { line, append: false } };
}