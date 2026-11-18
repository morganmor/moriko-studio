
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, bool } from './shared.js';
import { healEditedContent, formatHealNotes } from '../edit-heal.js';
import { buildUnifiedDiff, diffStatFromOps } from '../diff.js';
import { recordAfterWrite } from '../read-policy.js';
import { resolveWriteTarget, verifyWrittenSyntax } from './edit-core.js';

export async function writeTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const resolved = await resolveWriteTarget('write', str(args, 'path'), ctx);
  if (!resolved.ok) return resolved.result;
  const { absolute, relative, exists } = resolved.target;

  const content = str(args, 'content');
  const dryRun = bool(args, 'dryRun');
  const verifySyntax = args.verifySyntax === undefined ? true : bool(args, 'verifySyntax');

  if (!('content' in args)) {
    return { ok: false, isError: true, text: 'write needs a "content" string (the full text to write).' };
  }

  if (exists) {
    return {
      ok: false, isError: true,
      text:
        `"${relative}" already exists — write only creates NEW files. To replace its full content, use ` +
        `agent__overwrite (read it first); for targeted changes, use the edit tools ` +
        `(agent__edit_file, agent__edit_lines, agent__multi_edit, agent__edit_between, agent__insert_at_line).`,
    };
  }

  if (!content) {
    return { ok: false, isError: true, text: 'Creating an empty file needs no write tool call — nothing to write. If you intended to create an empty file, pass a single newline: content: "\\n".' };
  }

  const heal = healEditedContent('', content, absolute);
  const healNote = formatHealNotes(heal);
  const finalContent = heal.content;

  if (dryRun) {
    return {
      ok: true,
      isError: false,
      text:
        `dryRun -- NO changes written. Creating ${relative} ` +
        `(${Buffer.byteLength(finalContent, 'utf8')} bytes) would succeed — call write again with dryRun: false to apply.` +
        healNote,
      diff: buildUnifiedDiff('', finalContent, relative),
      diffstat: diffStatFromOps('', finalContent),
    };
  }

  try {
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, finalContent, 'utf8');
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Could not write ${relative}: ${error instanceof Error ? error.message : 'write failed'}`,
    };
  }

  if (verifySyntax) {
    const syntaxFailure = await verifyWrittenSyntax(absolute, finalContent);
    if (syntaxFailure.failed) {
      try {
        rmSync(absolute, { force: true });
      } catch {
      }
      return {
        ok: false,
        isError: true,
        text:
          `Creation rolled back — ${relative} was removed:` +
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
  recordAfterWrite(ctx.sessionId, absolute, finalContent, postMtime);

  return {
    ok: true,
    isError: false,
    text: `Created ${relative} (${Buffer.byteLength(finalContent, 'utf8')} bytes).` + healNote,
    diff: buildUnifiedDiff('', finalContent, relative),
    diffstat: diffStatFromOps('', finalContent),
  };
}