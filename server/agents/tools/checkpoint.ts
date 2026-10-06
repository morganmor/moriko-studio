/**
 * agent__checkpoint / agent__undo / agent__checkpoint_list — named rollback
 * points for multi-step refactors, now with UI-STATE (F6): every checkpoint
 * freezes the layout IR alongside the file snapshots, and undo reports the
 * spatial drift the rollback reintroduces — the model sees WHERE the layout
 * moved, not just which files changed.
 */
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { AgentToolContext } from './shared.js';
import { str } from './shared.js';
import { getActiveWorkspace } from '../workspace.js';
import { snapshotFile, restoreSnapshot, findSnapshot } from '../vault.js';
import { recordAfterWrite, listSessionEntries } from '../read-policy.js';
import {
  spatialMapForRoot,
  invalidateSpatialMapCache,
  diffSpatialMaps,
  renderSpatialDiff,
  buildSpatialMap as buildStaticMap,
  type SpatialMap,
} from '../spatial.js';

/** Per-session store: label → checkpoint (files + the layout IR at that moment). */
const checkpoints = new Map<string, Map<string, Checkpoint>>();

interface Checkpoint {
  label: string;
  timestamp: number;
  /** Map of relative-path -> snapshotId in the vault. */
  files: Map<string, string>;
  /** F6: the static spatial map at checkpoint time (UI-state half of the rollback). */
  spatial: SpatialMap | null;
}

function checkpointsForSession(sessionId: string | undefined): Map<string, Checkpoint> {
  if (!sessionId) return new Map();
  let m = checkpoints.get(sessionId);
  if (!m) {
    m = new Map();
    checkpoints.set(sessionId, m);
  }
  return m;
}

export interface CheckpointToolDeps {
  /** Vault operations — injectable so tests can run without the real store. */
  snapshot: typeof snapshotFile;
  find: typeof findSnapshot;
  restore: typeof restoreSnapshot;
  /** Session ledger ops — same injectability. */
  ledger: typeof recordAfterWrite;
  sessionEntries: typeof listSessionEntries;
  workspace: typeof getActiveWorkspace;
}

const defaultDeps: CheckpointToolDeps = {
  snapshot: snapshotFile,
  find: findSnapshot,
  restore: restoreSnapshot,
  ledger: recordAfterWrite,
  sessionEntries: listSessionEntries,
  workspace: getActiveWorkspace,
};

export interface CheckpointReport {
  ok: boolean;
  isError: boolean;
  text: string;
}

/**
 * agent__checkpoint — snapshot all edited files this session under a label,
 * PLUS the layout IR at that moment (the UI-state half of the rollback point).
 */
export async function checkpointTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
  deps: CheckpointToolDeps = defaultDeps,
): Promise<CheckpointReport> {
  const label = str(args, 'label').trim();
  if (!label) {
    return { ok: false, isError: true, text: 'checkpoint needs a "label" (e.g. "before refactor").' };
  }

  const editedFiles = deps
    .sessionEntries(ctx.sessionId)
    .filter((entry) => entry.entry.lastOp === 'write')
    .map((entry) => entry.absolute);
  if (editedFiles.length === 0) {
    return {
      ok: true,
      isError: false,
      text: `Checkpoint "${label}" created — no files edited yet this session (empty checkpoint).`,
    };
  }

  const ws = deps.workspace(ctx.sessionId);
  if (!ws) return { ok: false, isError: true, text: 'No active workspace.' };

  const files = new Map<string, string>();
  let snapshotted = 0;
  for (const absPath of editedFiles) {
    const relPath = path.relative(ws.path, absPath);
    const outcome = deps.snapshot(ctx.sessionId, absPath, 'checkpoint');
    if (outcome.entry) {
      files.set(relPath, outcome.entry.id);
      snapshotted += 1;
    }
  }

  let spatial: SpatialMap | null = null;
  try {
    spatial = spatialMapForRoot(ws.path, { refresh: true });
  } catch {
    spatial = null;
  }

  const store = checkpointsForSession(ctx.sessionId);
  store.set(label, { label, timestamp: Date.now(), files, spatial });

  return {
    ok: true,
    isError: false,
    text: `Checkpoint "${label}" created — ${snapshotted} file(s) snapshotted${
      spatial ? `, layout IR frozen (${spatial.regions.length} region(s), ${spatial.collisions.length} collision(s))` : ''
    }. Use agent__undo { label: "${label}" } to restore.`,
  };
}

/**
 * agent__undo — restore a named checkpoint (or latest), then report the
 * SPATIAL DRIFT the rollback introduces: the model sees not only which files
 * changed but WHERE the layout moved, before it reports anything done.
 */
export async function undoTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
  deps: CheckpointToolDeps = defaultDeps,
): Promise<CheckpointReport> {
  const store = checkpointsForSession(ctx.sessionId);
  if (store.size === 0) {
    return { ok: false, isError: true, text: 'No checkpoints this session. Use agent__checkpoint { label } first.' };
  }
  const label = str(args, 'label').trim();
  let checkpoint: Checkpoint | undefined;
  if (label) {
    checkpoint = store.get(label);
    if (!checkpoint) {
      return { ok: false, isError: true, text: `No checkpoint named "${label}". Use agent__checkpoint_list to see options.` };
    }
  } else {
    checkpoint = [...store.values()].sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  const ws = deps.workspace(ctx.sessionId);
  if (!ws) return { ok: false, isError: true, text: 'No active workspace.' };

  let restored = 0;
  const diffs: string[] = [];
  /** F6: relPath → content BEFORE the restore — from the vault pre-restore snapshots. */
  const preRestore = new Map<string, string>();
  for (const [relPath, snapshotId] of checkpoint.files) {
    const absolute = path.join(ws.path, relPath);
    const meta = deps.find(ctx.sessionId, snapshotId);
    if (!meta) {
      diffs.push(`  ${relPath} — snapshot lost`);
      continue;
    }
    try {
      try {
        preRestore.set(relPath, readFileSync(absolute, 'utf8'));
      } catch {
      }
      const outcome = deps.restore(ctx.sessionId, snapshotId, absolute);
      restored += 1;
      diffs.push(`  ${relPath} — restored`);
      if (outcome.diff) diffs.push(outcome.diff);
      try {
        const restoredContent = readFileSync(absolute, 'utf8');
        deps.ledger(ctx.sessionId, absolute, restoredContent, statSync(absolute).mtimeMs);
      } catch {
      }
    } catch (error) {
      diffs.push(`  ${relPath} — ${error instanceof Error ? error.message : 'restore failed'}`);
    }
  }

  invalidateSpatialMapCache(ws.path);

  let drift = '';
  try {
    if (preRestore.size > 0) {
      const beforeSources: Array<{ path: string; content: string }> = [];
      for (const [relPath, content] of preRestore) {
        beforeSources.push({ path: relPath, content });
      }
      const afterSources: Array<{ path: string; content: string }> = [];
      for (const [relPath] of preRestore) {
        try {
          afterSources.push({ path: relPath, content: readFileSync(path.join(ws.path, relPath), 'utf8') });
        } catch {
        }
      }
      const diff = diffSpatialMaps(
        buildStaticMap(beforeSources),
        buildStaticMap(afterSources),
      );
      const spatiallyQuiet =
        diff.added.length === 0 &&
        diff.removed.length === 0 &&
        diff.changed.length === 0 &&
        diff.newCollisions.length === 0 &&
        diff.resolvedCollisions.length === 0;
      if (!spatiallyQuiet) {
        drift = [
          '',
          'SPATIAL DRIFT (the undo changed the layout vs the pre-undo state):',
          renderSpatialDiff(diff),
          diff.newCollisions.length > 0
            ? '⚠ the restored state REINTRODUCES collision candidate(s) — fix or re-checkpoint before reporting done'
            : '(compare against the runtime tier before judging — later work may have been intentional)',
        ].join('\n');
      }
    }
  } catch {
    drift = '';
  }

  return {
    ok: true,
    isError: false,
    text: `Restored checkpoint "${checkpoint.label}" — ${restored} file(s).\n${diffs.join('\n')}${drift}`,
  };
}

/** agent__checkpoint_list — list all checkpoints for this session. */
export async function checkpointListTool(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
  deps: CheckpointToolDeps = defaultDeps,
): Promise<CheckpointReport> {
  void args;
  void deps;
  const store = checkpointsForSession(ctx.sessionId);
  if (store.size === 0) {
    return { ok: true, isError: false, text: 'No checkpoints this session.' };
  }
  const entries = [...store.values()].sort((a, b) => a.timestamp - b.timestamp);
  const lines = entries.map((cp) => {
    const age = Math.round((Date.now() - cp.timestamp) / 1000);
    const spatialNote = cp.spatial ? `, IR: ${cp.spatial.regions.length} region(s)` : '';
    return `  "${cp.label}" — ${cp.files.size} file(s), ${age}s ago${spatialNote}`;
  });
  return { ok: true, isError: false, text: `# checkpoints (${store.size})\n${lines.join('\n')}` };
}
