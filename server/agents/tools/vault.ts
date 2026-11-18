
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, bool, formatSize, truncateOutput, resolveWithPermission, num } from './shared.js';
import { listSnapshots, findSnapshot, restoreSnapshot, type RestoreRange, type VaultEntryMeta } from '../vault.js';
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


function diffAgainstSnapshot(
  ctx: AgentToolContext,
  snapshotId: string,
  to?: string,
): HarnessToolResult {
  const entry = findSnapshot(ctx.sessionId, snapshotId);
  if (!entry) {
    return { ok: false, isError: true, text: `No vault snapshot with id "${snapshotId}" in this session (try vault_list).` };
  }
  const targetPath = to ? path.resolve(to) : entry.originalPath;
  let snapshotText: string;
  try {
    const raw = readFileSync(entry.storedPath);
    snapshotText = raw.toString('utf8');
    if (snapshotText.includes('\0')) {
      return { ok: true, isError: false, text: `Snapshot ${snapshotId} is BINARY (${formatSize(entry.size)}); a restore would replace the file at ${targetPath} wholesale.` };
    }
  } catch {
    return { ok: false, isError: true, text: `Snapshot file is missing on disk (purged?): ${entry.storedPath}` };
  }
  try {
    const currentText = readFileSync(targetPath, 'utf8');
    if (currentText === snapshotText) {
      return { ok: true, isError: false, text: `The target already matches the snapshot — nothing to restore.` };
    }
    return {
      ok: true, isError: false,
      text:
        `Diff ${targetPath}: current (${Buffer.byteLength(currentText, 'utf8')} bytes) → ` +
        `snapshot ${snapshotId} (${Buffer.byteLength(snapshotText, 'utf8')} bytes). ` +
        `Snapshot content: .moriko/vault/… (grep/read it directly for full text).`,
      diff: buildUnifiedDiff(currentText, snapshotText, targetPath),
      diffstat: diffStatFromOps(currentText, snapshotText),
    };
  } catch {
    const lines = snapshotText.split(/\r\n|\n|\r/);
    return {
      ok: true, isError: false,
      text:
        `Target ${targetPath} does not exist. Snapshot ${snapshotId} would be restored as a NEW file ` +
        `(${formatSize(entry.size)}, ${lines.length} lines). Snapshot head:\n` +
        truncateOutput(lines.slice(0, 60).join('\n')),
      diff: buildUnifiedDiff('', snapshotText, targetPath),
      diffstat: diffStatFromOps('', snapshotText),
    };
  }
}

export async function vaultDiffTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const snapshotId = str(args, 'snapshotId').trim();
  if (!snapshotId) return { ok: false, isError: true, text: 'vault_diff needs a "snapshotId" (read vault_list first).' };
  return diffAgainstSnapshot(ctx, snapshotId, str(args, 'to').trim() || undefined);
}

export async function vaultRestoreTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const snapshotId = str(args, 'snapshotId').trim();
  if (!snapshotId) return { ok: false, isError: true, text: 'vault_restore needs a "snapshotId" (read vault_list first).' };
  const to = str(args, 'to').trim() || undefined;
  const dryRun = bool(args, 'dryRun');

  const hasRange = args.rangeFrom !== undefined || args.rangeTo !== undefined;
  let range: RestoreRange | undefined;
  if (hasRange) {
    const from = num(args, 'rangeFrom');
    const toLine = num(args, 'rangeTo');
    if (!from || !toLine || from < 1 || toLine < from) {
      return { ok: false, isError: true, text: `Invalid range (${from}..${toLine}) — needs 1 <= rangeFrom <= rangeTo.` };
    }
    range = { from: Math.floor(from), to: Math.floor(toLine) };
  }

  // DRY RUN: preview what the restore would change WITHOUT touching disk.
  if (dryRun) {
    if (range) {
      const entry = findSnapshot(ctx.sessionId, snapshotId);
      if (!entry) {
        return { ok: false, isError: true, text: `No vault snapshot with id "${snapshotId}" in this session (try vault_list).` };
      }
      const targetPath = to ? path.resolve(to) : entry.originalPath;
      try {
        const cur = readFileSync(targetPath, 'utf8').split(/\r\n|\n|\r/);
        const snap = readFileSync(entry.storedPath, 'utf8').split(/\r\n|\n|\r/);
        const from = Math.min(Math.max(1, range.from), cur.length);
        const toLine = Math.min(range.to, cur.length);
        const merged = [...cur.slice(0, from - 1), ...snap.slice(from - 1, toLine), ...cur.slice(toLine)];
        const before = cur.join('\n');
        const after = merged.join('\n');
        if (before === after) {
          return { ok: true, isError: false, text: `dryRun — the range ${from}..${toLine} already matches the snapshot; restore would be a no-op.` };
        }
        return {
          ok: true, isError: false,
          text: `dryRun — NO changes written. Range restore ${from}..${toLine} from snapshot ${snapshotId} → ${targetPath}. Call again with dryRun: false to apply.`,
          diff: buildUnifiedDiff(before, after, targetPath),
          diffstat: diffStatFromOps(before, after),
        };
      } catch (error) {
        return { ok: false, isError: true, text: error instanceof Error ? error.message : 'dryRun failed.' };
      }
    }
    return diffAgainstSnapshot(ctx, snapshotId, to);
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
  if (!range) {
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
  }
  try {
    const outcome = restoreSnapshot(ctx.sessionId, snapshotId, target, range);
    try {
      const restored = readFileSync(outcome.target, 'utf8');
      recordAfterWrite(ctx.sessionId, outcome.target, restored, statSync(outcome.target).mtimeMs);
    } catch {
    }
    const rangeNote = outcome.range ? ` (range ${outcome.range.from}–${outcome.range.to} spliced; rest of the file untouched)` : '';
    const note = outcome.previousEntryId ? ` The overwritten file was snapshotted first (${outcome.previousEntryId}).` : '';
    return {
      ok: true,
      isError: false,
      text: `Restored snapshot ${snapshotId} → ${outcome.target}${rangeNote}.${note}`,
      diff: outcome.diff,
      diffstat: outcome.diffstat,
    };
  } catch (error) {
    return { ok: false, isError: true, text: error instanceof Error ? error.message : 'vault_restore failed.' };
  }
}
