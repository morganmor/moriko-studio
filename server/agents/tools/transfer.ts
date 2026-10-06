/**
 * agent__rename / agent__move / agent__copy / agent__delete — file operations.
 *
 * Safety posture:
 *  - Move/copy/rename NEVER overwrite (destination must not exist).
 *  - The workspace root itself can never be deleted or moved.
 *  - Deletes snapshot to the vault FIRST, so they are recoverable.
 *  - Everything outside the root resolves through the permission gate.
 *  - Long copies stream progress to the tool card.
 */
import { copyFileSync, cpSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import {
  str, bool,
  resolveWithPermission, resolveManyWithPermission, requireWorkspace,
  MAX_WALK_DEPTH,
} from './shared.js';
import { requestApproval } from '../permissions.js';
import { snapshotFile, snapshotTree } from '../vault.js';
import { fuzzyHint } from '../fuzzy.js';

/**
 * Shared move/copy core. Both source and destination resolve through the
 * permission gate (ONE approval request when they are outside the root);
 * the destination must not exist. `mode` picks rename vs copy semantics.
 */
async function transferTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
  mode: 'move' | 'copy',
): Promise<HarnessToolResult> {
  const fromRaw = str(args, 'from').trim();
  const toRaw = str(args, 'to').trim();
  if (!fromRaw || !toRaw) {
    return { ok: false, isError: true, text: `${mode} needs "from" and "to" paths.` };
  }

  const resolved = await resolveManyWithPermission(mode, [
    { key: 'from', value: fromRaw },
    { key: 'to', value: toRaw },
  ], ctx, 'write');
  const from = resolved.from;
  const to = resolved.to;

  let fromStats;
  try {
    fromStats = statSync(from.absolute);
  } catch {
    return { ok: false, isError: true, text: `No such file or directory: ${from.relative}${fuzzyHint(from.absolute)}` };
  }

  let toExists = false;
  try {
    toExists = statSync(to.absolute) !== undefined;
  } catch {
    toExists = false;
  }
  if (toExists) {
    return {
      ok: false,
      isError: true,
      text: `Destination already exists: ${to.relative}. ${mode === 'copy' ? 'Copy' : 'Move'} never overwrites — delete the destination first or pick another name.`,
    };
  }

  try {
    if (mode === 'move') {
      renameSync(from.absolute, to.absolute);
    } else if (fromStats.isDirectory()) {
      let copied = 0;
      const walkCopy = (src: string, dest: string, depth: number): void => {
        if (depth > MAX_WALK_DEPTH) return;
        mkdirSync(dest, { recursive: true });
        for (const entry of readdirSync(src, { withFileTypes: true })) {
          if (ctx.signal?.aborted) return;
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            walkCopy(srcPath, destPath, depth + 1);
          } else if (entry.isFile()) {
            copyFileSync(srcPath, destPath);
            copied += 1;
            if (copied % 10 === 0) ctx.onProgress?.(`Copying… ${copied} files`);
          }
        }
      };
      walkCopy(from.absolute, to.absolute, 0);
      ctx.onProgress?.(`Copied ${copied} files`);
    } else {
      cpSync(from.absolute, to.absolute, { recursive: fromStats.isDirectory(), errorOnExist: true, force: false });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (mode === 'move' && code === 'EXDEV') {
      try {
        cpSync(from.absolute, to.absolute, { recursive: fromStats.isDirectory(), errorOnExist: true, force: false });
        rmSync(from.absolute, { recursive: fromStats.isDirectory() });
      } catch (fallbackError) {
        return {
          ok: false,
          isError: true,
          text: `Move failed: ${fallbackError instanceof Error ? fallbackError.message : 'filesystem error'}`,
        };
      }
    } else {
      return {
        ok: false,
        isError: true,
        text: `${mode === 'copy' ? 'Copy' : 'Move'} failed: ${error instanceof Error ? error.message : 'filesystem error'}`,
      };
    }
  }

  const verb = mode === 'copy' ? 'Copied' : 'Moved';
  return {
    ok: true,
    isError: false,
    text: `${verb} ${from.relative} → ${to.relative}${fromStats.isDirectory() ? ' (directory)' : ''}.`,
  };
}

export async function renameTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const inputPath = str(args, 'path').trim();
  const name = str(args, 'name').trim();
  if (!inputPath) return { ok: false, isError: true, text: 'rename needs a "path".' };
  if (!name || /[/\\]/.test(name)) {
    return { ok: false, isError: true, text: 'rename needs "name": a plain file/folder name without path separators. Use move to change the directory.' };
  }

  const source = await resolveWithPermission('rename', inputPath, ctx, 'write');
  const destination = path.join(path.dirname(source.absolute), name);
  if (source.outside) {
    const granted = await requestApproval({ tool: 'rename', paths: [destination], root: requireWorkspace(ctx).root }, ctx);
    if (!granted) {
      throw new Error(`Permission denied: rename target "${destination}" is outside the workspace and was not approved.`);
    }
  }

  let toExists = false;
  try {
    toExists = statSync(destination) !== undefined;
  } catch {
    toExists = false;
  }
  if (toExists) {
    return { ok: false, isError: true, text: `"${name}" already exists in that directory — pick another name.` };
  }

  try {
    renameSync(source.absolute, destination);
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Rename failed: ${error instanceof Error ? error.message : 'filesystem error'}`,
    };
  }
  const newRelative = source.outside
    ? destination
    : path.join(path.dirname(source.relative), name).split(path.sep).join('/');
  return { ok: true, isError: false, text: `Renamed ${source.relative} → ${newRelative}.` };
}

export async function moveTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  return transferTool(args, ctx, 'move');
}

export async function copyTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  return transferTool(args, ctx, 'copy');
}

export async function deleteTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const inputPath = str(args, 'path').trim();
  if (!inputPath) {
    return { ok: false, isError: true, text: 'delete needs a "path".' };
  }

  const { root } = requireWorkspace(ctx);
  const { absolute, relative } = await resolveWithPermission('delete', inputPath, ctx, 'write');

  if (path.resolve(absolute) === path.resolve(root)) {
    return { ok: false, isError: true, text: 'Refusing to delete the workspace root itself.' };
  }

  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return { ok: false, isError: true, text: `No such file or directory: ${relative}${fuzzyHint(absolute)}` };
  }

  const recursive = bool(args, 'recursive');
  if (stats.isDirectory() && !recursive) {
    return {
      ok: false,
      isError: true,
      text: `"${relative}" is a directory — pass recursive: true to delete it with its contents (recoverable via the vault).`,
    };
  }

  if (ctx.confirmDeletes) {
    const granted = await requestApproval(
      { tool: 'delete', paths: [absolute], root },
      ctx,
    );
    if (!granted) {
      return { ok: false, isError: true, text: `The user did not approve deleting ${relative}.` };
    }
  }

  let vaultNote: string;
  if (stats.isFile()) {
    const outcome = snapshotFile(ctx.sessionId, absolute, 'delete');
    vaultNote = outcome.entry
      ? ` Previous version snapshotted (${outcome.entry.id}) — restore with vault_restore.`
      : ' NOT vaulted (too large) — this delete is permanent.';
  } else {
    const outcome = snapshotTree(ctx.sessionId, absolute, 'delete');
    vaultNote = outcome.files > 0
      ? ` ${outcome.files} file(s) snapshotted to the vault — restore with vault_restore.`
      : ' (empty directory — nothing to snapshot; delete is permanent.)';
  }

  try {
    rmSync(absolute, { recursive });
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Delete failed: ${error instanceof Error ? error.message : 'filesystem error'}`,
    };
  }
  return {
    ok: true,
    isError: false,
    text: `Deleted ${relative}${stats.isDirectory() ? ' (directory, recursive)' : ''}.${vaultNote}`,
  };
}
