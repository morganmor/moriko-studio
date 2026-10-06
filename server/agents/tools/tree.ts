/**
 * agent__tree_outline — the agent's window into the REALTIME PROJECT
 * STRUCTURE index (Fase B).
 *
 * Reads the SAME in-memory index the user's floating panel watches — never
 * the disk directly — so the agent and the user always see an identical,
 * up-to-date project structure at zero extra I/O cost. A workspace whose
 * index is not built yet triggers the single background walk on first call.
 *
 * agent__tree_refresh — force one rebuild walk (after mass generation, a git
 * checkout, or when the index looks stale). Returns the refreshed stats.
 */
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput } from './shared.js';
import { getActiveWorkspace } from '../workspace.js';
import { getTree, outlineFromMemory, refreshTree } from '../treeIndex.js';

function activeWorkspaceId(ctx: AgentToolContext): { id: string } | { error: string } {
  const workspace = getActiveWorkspace(ctx.sessionId);
  if (!workspace) {
    return { error: 'No active agent workspace. Pick one in the workspace picker first.' };
  }
  return { id: workspace.id };
}

export function treeOutlineTool(args: Record<string, unknown>, ctx: AgentToolContext): HarnessToolResult {
  const workspace = activeWorkspaceId(ctx);
  if ('error' in workspace) return { ok: false, isError: true, text: workspace.error };

  const view = getTree(workspace.id);
  if (!view) {
    return { ok: false, isError: true, text: 'The workspace folder no longer exists on disk.' };
  }

  const outline = outlineFromMemory(workspace.id, {
    depth: num(args, 'depth'),
    filter: str(args, 'filter'),
    maxEntries: num(args, 'maxEntries'),
  });
  if (outline === null) {
    return { ok: false, isError: true, text: 'The tree index is not available for this workspace yet — retry in a moment.' };
  }

  const refreshing = view.refreshing ? '\n(index refreshing in the background — deltas arrive via the panel; re-call for a fresher view)' : '';
  return { ok: true, isError: false, text: truncateOutput(outline + refreshing) };
}

export async function treeRefreshTool(_args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const workspace = activeWorkspaceId(ctx);
  if ('error' in workspace) return { ok: false, isError: true, text: workspace.error };
  await refreshTree(workspace.id);
  const view = getTree(workspace.id);
  if (!view) return { ok: false, isError: true, text: 'The workspace folder no longer exists on disk.' };
  const stats = view.stats;
  return {
    ok: true,
    isError: false,
    text: truncateOutput(
      `Tree rebuilt: ${stats.files} file(s), ${Math.max(0, stats.dirs - 1)} dir(s), ${stats.totalBytes} bytes` +
        `${stats.truncated ? ' (TRUNCATED — node/depth caps hit; use ignore rules or a filter)' : ''}, v${view.version}.`,
    ),
  };
}