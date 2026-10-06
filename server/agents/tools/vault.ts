/**
 * agent__vault_list / agent__vault_restore — the undo system. Every edit and
 * delete snapshots the prior state into the vault; restore brings it back.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, bool, formatSize, truncateOutput, resolveWithPermission } from './shared.js';
import { listSnapshots, findSnapshot, restoreSnapshot, type VaultEntryMeta } from '../vault.js';
import { buildUnifiedDiff, diffStatFromOps } from '../diff.js';
import { recordAfterWrite, hasCurrentRead, getReadEntry, readRequiredMessage, staleReadMessage } from '../read-policy.js';

function renderVaultEntry(entry: VaultEntryMeta): string {
  const when = new Date(entry.createdAt).toISOString().replace('T', ' ').slice(0, 19);
  return `(${entry.id}) ${entry.originalPath} — ${entry.operation}, ${formatSize(entry.size)}, ${when}`;
}

export async function vaultListTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const query = str(args, 'query').trim() || undefined;
  const entries = listSnapshots(ctx.sessionId, query);
  if (entries.length === 0) {
    return { ok: true, isError: false, text: query ? `No vault snapshots matching "${query}".` : 'The vault is empty — edits and deletes snapshot automatically.' };
  }
  return { ok: true, isError: false, text: truncateOutput(entries.slice(0, 60).map(renderVaultEntry).join('\n') + (entries.length > 60 ? `\n…${entries.length - 60} more` : '')) };
}

export async function vaultRestoreTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const snapshotId = str(args, 'snapshotId').trim();
  if (!snapshotId) return { ok: false, isError: true, text: 'vault_restore needs a "snapshotId" (read vault_list first).' };
  const to = str(args, 'to').trim() || undefined;
  const dryRun = bool(args, 'dryRun');

  // DRY RUN: preview what the restore would change WITHOUT touching disk.
  if (dryRun) {
    const entry = findSnapshot(ctx.sessionId, snapshotId);
    if (!entry) {
      return { ok: false, isError: true, text: `No vault snapshot with id "${snapshotId}" in this session (try vault_list).` };
    }
    const targetPath = to ? path.resolve(to) : entry.originalPath;
    let snapshotText: string;
    let currentText = '';
    try {
      const raw = readFileSync(entry.storedPath);
      snapshotText = raw.toString('utf8');
      if (snapshotText.includes('\0')) {
        return { ok: true, isError: false, text: `dryRun — snapshot ${snapshotId} is BINARY (${formatSize(entry.size)}); restore would replace the file at ${targetPath} wholesale.` };
      }
    } catch {
      return { ok: false, isError: true, text: `Snapshot file is missing on disk (purged?): ${entry.storedPath}` };
    }
    try {
      currentText = readFileSync(targetPath, 'utf8');
    } catch {
      return {
        ok: true, isError: false,
        text: `dryRun — target ${targetPath} does not exist; restore would CREATE it (${formatSize(entry.size)}).`,
        diff: buildUnifiedDiff('', snapshotText, targetPath),
        diffstat: diffStatFromOps('', snapshotText),
      };
    }
    if (currentText === snapshotText) {
      return { ok: true, isError: false, text: `dryRun — the target already matches the snapshot; restore would be a no-op.` };
    }
    return {
      ok: true, isError: false,
      text:
        `dryRun — NO changes written. Restoring snapshot ${snapshotId} → ${targetPath} would change ` +
        `${Buffer.byteLength(currentText, 'utf8')} → ${Buffer.byteLength(snapshotText, 'utf8')} bytes. ` +
        'Call again with dryRun: false to apply.',
      diff: buildUnifiedDiff(currentText, snapshotText, targetPath),
      diffstat: diffStatFromOps(currentText, snapshotText),
    };
  }

  let target = to;
  if (target) {
    const resolved = await resolveWithPermission('vault_restore', target, ctx, 'write');
    target = resolved.absolute;
  }
  const snapshotMeta = findSnapshot(ctx.sessionId, snapshotId);
  if (!snapshotMeta) {
    return { ok: false, isError: true, text: `No vault snapshot with id "${snapshotId}" in this session (try vault_list).` };
  }
  const destPath = target ?? snapshotMeta.originalPath;
  try {
    const current = readFileSync(destPath, 'utf8');
    const readEntry = getReadEntry(ctx.sessionId, destPath);
    if (!hasCurrentRead(ctx.sessionId, destPath, current, statSync(destPath).mtimeMs)) {
      return {
        ok: false, isError: true,
        text: readEntry ? staleReadMessage(destPath, readEntry.rev) : readRequiredMessage(destPath),
      };
    }
  } catch {
  }
  try {
    const outcome = restoreSnapshot(ctx.sessionId, snapshotId, target);
    try {
      const restored = readFileSync(outcome.target, 'utf8');
      recordAfterWrite(ctx.sessionId, outcome.target, restored, statSync(outcome.target).mtimeMs);
    } catch {
    }
    const note = outcome.previousEntryId ? ` The overwritten file was snapshotted first (${outcome.previousEntryId}).` : '';
    return {
      ok: true,
      isError: false,
      text: `Restored snapshot ${snapshotId} → ${outcome.target}.${note}`,
      diff: outcome.diff,
      diffstat: outcome.diffstat,
    };
  } catch (error) {
    return { ok: false, isError: true, text: error instanceof Error ? error.message : 'vault_restore failed.' };
  }
}
