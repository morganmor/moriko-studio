/**
 * agent__write — create a NEW file/document/text in the active workspace.
 *
 * This is the file-creation path that used to ride edit_file behind an empty
 * oldString. `write` creates parent directories, refuses to overwrite an
 * existing file (see the edit tools for that), runs the syntax guard (a
 * broken .json/.js write rolls back), and records the read state so the new
 * file is immediately editable.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, bool } from './shared.js';
import { buildUnifiedDiff, diffStatFromOps } from '../diff.js';
import { recordAfterWrite, hasCurrentRead, readRequiredMessage, staleReadMessage, getReadEntry } from '../read-policy.js';
import { resolveWriteTarget, verifyWrittenSyntax, hashGuardError } from './edit-core.js';

export async function writeTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const resolved = await resolveWriteTarget('write', str(args, 'path'), ctx);
  if (!resolved.ok) return resolved.result;
  const { absolute, relative, exists } = resolved.target;

  const content = str(args, 'content');
  const dryRun = bool(args, 'dryRun');
  const verifySyntax = args.verifySyntax === undefined ? true : bool(args, 'verifySyntax');
  const overwrite = bool(args, 'overwrite');

  if (!('content' in args)) {
    return { ok: false, isError: true, text: 'write needs a "content" string (the full text to write).' };
  }

  if (exists && !overwrite) {
    return {
      ok: false, isError: true,
      text:
        `"${relative}" already exists — write refuses to overwrite. To change it, use the edit tools ` +
        `(agent__edit_file, agent__edit_lines, agent__multi_edit, agent__edit_between, agent__insert_at_line) ` +
        `after reading it. Pass overwrite: true only if you really intend to replace the whole file, ` +
        `and read it first.`,
    };
  }

  if (exists && overwrite) {
    // Overwrite still honours read-before-edit: the caller must have seen the file.
    // Reuse the shared gate by loading through a lightweight check below.
    const loaded = await loadForOverwrite(absolute, relative, ctx, args);
    if (!loaded.ok) return loaded.result;
  }

  if (!content && !exists) {
    return { ok: false, isError: true, text: 'Creating an empty file needs no write tool call — nothing to write. If you intended to create an empty file, pass a single newline: content: "\\n".' };
  }

  if (dryRun) {
    return {
      ok: true,
      isError: false,
      text:
        `dryRun -- NO changes written. ${exists ? 'Overwriting' : 'Creating'} ${relative} ` +
        `(${Buffer.byteLength(content, 'utf8')} bytes) would succeed — call write again with dryRun: false to apply.`,
      diff: buildUnifiedDiff('', content, relative),
      diffstat: diffStatFromOps('', content),
    };
  }

  try {
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Could not write ${relative}: ${error instanceof Error ? error.message : 'write failed'}`,
    };
  }

  if (verifySyntax) {
    const syntaxFailure = await verifyWrittenSyntax(absolute, content);
    if (syntaxFailure.failed) {
      try {
        rmSync(absolute, { force: true });
      } catch {
      }
      return {
        ok: false,
        isError: true,
        text:
          (exists ? 'Overwrite rolled back —' : `Creation rolled back — ${relative} was removed:`) +
          ` syntax guard failed (${syntaxFailure.failed}) Fix the content and retry.`,
      };
    }
  }

  let postMtime = 0;
  try {
    postMtime = statSync(absolute).mtimeMs;
  } catch {
    postMtime = Date.now();
  }
  recordAfterWrite(ctx.sessionId, absolute, content, postMtime);

  return {
    ok: true,
    isError: false,
    text: `${exists ? 'Overwrote' : 'Created'} ${relative} (${Buffer.byteLength(content, 'utf8')} bytes).`,
    diff: buildUnifiedDiff('', content, relative),
    diffstat: diffStatFromOps('', content),
  };
}

/** Overwrite path: same read-before-edit gate as the edit tools. */
async function loadForOverwrite(
  absolute: string,
  relative: string,
  ctx: AgentToolContext,
  args: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; result: HarnessToolResult }> {
  let content: string;
  let mtime: number;
  try {
    const st = statSync(absolute);
    content = readFileSync(absolute, 'utf8');
    mtime = st.mtimeMs;
  } catch (error) {
    return { ok: false, result: { ok: false, isError: true, text: `Could not read ${relative}: ${error instanceof Error ? error.message : 'read failed'}` } };
  }
  const readEntry = getReadEntry(ctx.sessionId, absolute);
  if (!hasCurrentRead(ctx.sessionId, absolute, content, mtime)) {
    return {
      ok: false,
      result: { ok: false, isError: true, text: readEntry ? staleReadMessage(relative, readEntry.rev) : readRequiredMessage(relative) },
    };
  }
  const expectedReadHash = str(args, 'expectedReadHash').trim();
  const hashError = hashGuardError(content, expectedReadHash, relative);
  if (hashError) return { ok: false, result: { ok: false, isError: true, text: hashError } };
  return { ok: true };
}