
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, bool } from './shared.js';
import { healEditedContent, formatHealNotes } from '../edit-heal.js';
import { buildUnifiedDiff, diffStatFromOps } from '../diff.js';
import { recordAfterWrite } from '../read-policy.js';
import { resolveWriteTarget, loadEditable, verifyWrittenSyntax } from './edit-core.js';
import { snapshotFile, restoreSnapshot } from '../vault.js';

export async function overwriteTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const resolved = await resolveWriteTarget('overwrite', str(args, 'path'), ctx);
  if (!resolved.ok) return resolved.result;
  const { absolute, relative, exists } = resolved.target;

  if (!exists) {
    return {
      ok: false, isError: true,
      text: `"${relative}" does not exist — overwrite only replaces an existing file. Create it with agent__write.`,
    };
  }

  if (!('content' in args)) {
    return { ok: false, isError: true, text: 'overwrite needs a "content" string (the full replacement text).' };
  }
  const content = str(args, 'content');
  const dryRun = bool(args, 'dryRun');
  const verifySyntax = args.verifySyntax === undefined ? true : bool(args, 'verifySyntax');

  const loaded = loadEditable(resolved.target, ctx, 'overwrite', str(args, 'expectedReadHash'));
  if (!loaded.ok) return loaded.result;
  const original = loaded.data.content;

  const heal = healEditedContent(original, content, absolute);
  const healNote = formatHealNotes(heal);
  const finalContent = heal.content;

  if (dryRun) {
    return {
      ok: true,
      isError: false,
      text:
        `dryRun -- NO changes written. Overwriting ${relative} ` +
        `(${Buffer.byteLength(finalContent, 'utf8')} bytes) would succeed — call overwrite again with dryRun: false to apply.` +
        healNote,
      diff: buildUnifiedDiff(original, finalContent, relative),
      diffstat: diffStatFromOps(original, finalContent),
    };
  }

  const snap = snapshotFile(ctx.sessionId, absolute, 'overwrite');
  try {
    writeFileSync(absolute, finalContent, 'utf8');
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Could not write ${relative}: ${error instanceof Error ? error.message : 'write failed'}`,
    };
  }

  if (verifySyntax) {
    const probe = await verifyWrittenSyntax(absolute, finalContent);
    if (probe.failed) {
      const snapshotId = snap.entry?.id;
      if (snapshotId) {
        try {
          restoreSnapshot(ctx.sessionId, snapshotId);
          const restored = readFileSync(absolute, 'utf8');
          recordAfterWrite(ctx.sessionId, absolute, restored, statSync(absolute).mtimeMs, { tool: 'agent__overwrite' });
          return {
            ok: false,
            isError: true,
            text:
              `SYNTAX GUARD — overwrite rolled back: ${probe.failed} ` +
              `The file was restored to snapshot ${snapshotId}; nothing is broken on disk.` +
              healNote +
              ' Next step: re-read the file and craft content that keeps it parseable.',
          };
        } catch (restoreError) {
          return {
            ok: false,
            isError: true,
            text:
              `SYNTAX GUARD: ${probe.failed} — AND the rollback failed ` +
              `(${restoreError instanceof Error ? restoreError.message : 'unknown'}). ` +
              `Inspect the file with read_file; vault snapshot id ${snapshotId}.`,
          };
        }
      }
      return {
        ok: false,
        isError: true,
        text: `SYNTAX GUARD: ${probe.failed} — no vault snapshot available to roll back; inspect the file now.`,
      };
    }
  }

  let postMtime = 0;
  try {
    postMtime = statSync(absolute).mtimeMs;
  } catch {
    postMtime = Date.now();
  }
  recordAfterWrite(ctx.sessionId, absolute, finalContent, postMtime, { tool: 'agent__overwrite' });

  const vaultNote = snap.entry?.id ? ` vault: ${snap.entry.id}` : '';
  return {
    ok: true,
    isError: false,
    text: `Overwrote ${relative} (${Buffer.byteLength(finalContent, 'utf8')} bytes).${vaultNote}` + healNote,
    diff: buildUnifiedDiff(original, finalContent, relative),
    diffstat: diffStatFromOps(original, finalContent),
  };
}
