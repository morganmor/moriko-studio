/**
 * ProjectTreePanel (Fase B → Fase 4) — the REALTIME PROJECT STRUCTURE panel.
 *
 * FASE 4 (6B): the panel is now DOCKED in the right sidebar column, sharing
 * the fold/width chrome with the Configuration panel (rightPanelMode switch in
 * the TopBar). The old floating chrome — drag-by-header, corner resize,
 * collapse-pill, device geometry — is gone; a docked panel is always where
 * the user left it. Rendering stays manual windowing over a FLATTENED
 * visible-row list (no deps): only the rows inside the viewport + overscroll
 * mount, so a 20k-node workspace scrolls at 60fps. The tree data lives in
 * the store and is updated in place by tree deltas (in-stream `tree_update`
 * or the idle SSE channel — see useTreeLive).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  Filter,
  Loader2,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
} from './icons';

import { useStore } from '../store/useStore';
import { streamTreeEvents } from '../lib/api';
import type { TreeNodeInfo } from '../types';
import { CollapseSection, RightDockCloseButton, RightDockSlot, cx } from './ui';


interface FlatRow {
  depth: number;
  node: TreeNodeInfo;
  expanded: boolean;
}

const ROW_H = 22;
const OVERSCAN = 8;

/** Depth-first flatten honoring the expanded set + filter. Dirs collapsed by
 *  default UNTIL touched — the panel opens showing the first two levels. */
function flatten(root: TreeNodeInfo, expanded: Set<string>, filter: string): FlatRow[] {
  const rows: FlatRow[] = [];
  const needle = filter.trim().toLowerCase();

  const matches = (node: TreeNodeInfo): boolean => !needle || node.name.toLowerCase().includes(needle);
  const subtreeMatches = (node: TreeNodeInfo): boolean => {
    if (matches(node)) return true;
    return node.children.some((child) => (child.kind === 'dir' ? subtreeMatches(child) : matches(child)));
  };

  const visit = (node: TreeNodeInfo, depth: number): void => {
    for (const child of node.children) {
      if (needle && !subtreeMatches(child)) continue;
      rows.push({ depth, node: child, expanded: expanded.has(child.relPath) });
      if (child.kind === 'dir' && (expanded.has(child.relPath) || Boolean(needle))) {
        visit(child, depth + 1);
      }
    }
  };
  visit(root, 0);
  return rows;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


/** Subscribes to the dedicated SSE channel and mirrors deltas into the store.
 *
 *  BOUND TO THE SESSION'S WORKSPACE, not to whatever the store happens to
 *  hold: the bootstrap/recovery step inside the loop re-fetches whenever the
 *  view is missing or stale (the reported "no contents at all" bug — the
 *  panel opened while the server was mid-reload, the first fetch died, and
 *  the old code never recovered because it keyed the loop off the very state
 *  that failed). The loop itself IS the fallback polling: on any SSE error it
 *  retries after a beat, and a hello-version drift triggers one full refetch.
 */
function useTreeLive(workspaceId: string | null, active: boolean): void {
  useEffect(() => {
    if (!workspaceId || !active) return;
    let cancelled = false;
    (async () => {
      for (;;) {
        if (cancelled) return;
        try {
          const store = useStore.getState();
          if (!store.treeView || store.treeView.workspaceId !== workspaceId) {
            await store.loadTreeView(workspaceId);
            if (cancelled) return;
          }
          for await (const event of streamTreeEvents(workspaceId)) {
            if (cancelled) return;
            if (event.type === 'tree_hello') {
              const view = useStore.getState().treeView;
              if (!view || view.workspaceId !== workspaceId || view.version < event.version) {
                void useStore.getState().loadTreeView(workspaceId);
              }
              continue;
            }
            useStore.getState().applyTreeDelta(event.workspaceId, event);
          }
        } catch {
        }
        if (cancelled) return;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, active]);
}


export function ProjectTreePanel({ width }: { width?: number }) {
  const treeView = useStore((state) => state.treeView);
  const treeRules = useStore((state) => state.treeRules);
  const refreshTreeView = useStore((state) => state.refreshTreeView);
  const saveTreeRules = useStore((state) => state.saveTreeRules);
  const boundWorkspaceId = useStore((state) => state.activeAgentWorkspaceId);
  const rightPanelMode = useStore((state) => state.rightPanelMode);
  const setRightPanelMode = useStore((state) => state.setRightPanelMode);

  const [filter, setFilter] = useState('');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [ruleDirs, setRuleDirs] = useState('');
  const [rulePatterns, setRulePatterns] = useState('');

  const workspaceId = treeView?.workspaceId ?? null;
  const showRules = rulesOpen && Boolean(workspaceId);

  useLayoutEffect(() => {
    if (showRules && treeRules) {
      setRuleDirs(treeRules.dirs.join(', '));
      setRulePatterns(treeRules.patterns.join(', '));
    }
  }, [showRules, treeRules]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const rootName = treeView?.root.name ?? '';
  useEffect(() => {
    if (!treeView) return;
    setExpanded((current) => {
      if (current.size > 0) return current;
      const seeded = new Set<string>();
      for (const child of treeView.root.children) {
        if (child.kind === 'dir') seeded.add(child.relPath);
      }
      return seeded;
    });
  }, [treeView, rootName]);

  const toggle = useCallback((relPath: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  }, []);

  const rows = useMemo(
    () => (treeView ? flatten(treeView.root, expanded, filter) : []),
    [treeView, expanded, filter],
  );

  // Docked: the scroll container's OWN height drives the window (a docked
  // panel has no fixed geometry — the fold column sets the width, the aside
  // fills the height), so a ResizeObserver keeps the viewport honest across
  // resizes of the dock itself.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(360);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewportH(element.clientHeight));
    observer.observe(element);
    setViewportH(element.clientHeight);
    return () => observer.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const visible = rows.slice(first, last);

  // Docked panels only mount while they are the visible right-dock mode.
  useTreeLive(boundWorkspaceId, true);

  const stats = treeView?.stats;

  return (
    <aside
      className="my-5 ml-2 mr-4 flex h-[calc(100%-2.5rem)] shrink-0 flex-col overflow-hidden rounded-2xl border border-hairline bg-elevated shadow-workspace"
      style={{ width: width ?? 300 }}
      role="region"
      aria-label="Project structure"
    >
      {/* Two-row header: row 1 = workspace identity + close; row 2 = the
          sidebar slot and panel actions — a 300px dock cannot fit all of them
          on one line without crushing the workspace title. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-hairline bg-elevated px-2.5 py-1.5">
        <Folder className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
          {treeView?.root.name ?? 'Project tree'}
        </span>
        <RightDockCloseButton />
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-hairline bg-elevated px-2.5 py-1.5">
        <RightDockSlot mode={rightPanelMode} onChange={setRightPanelMode} />
        <div className="flex-1" />
        {treeView?.refreshing ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-faint" aria-hidden="true" />
        ) : null}
        <button
          type="button"
          className="icon-button h-6 w-6 shrink-0"
          onClick={() => setRulesOpen((value) => !value)}
          aria-label="Ignore rules"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button h-6 w-6 shrink-0"
          onClick={() => workspaceId && void refreshTreeView(workspaceId)}
          aria-label="Rebuild index"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-hairline px-2.5 py-1.5">
        <Filter className="h-3 w-3 shrink-0 text-faint" aria-hidden="true" />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-faint"
        />
        {stats ? (
            <span className="shrink-0 text-[10.5px] text-faint">
              {stats.files}f·{Math.max(0, stats.dirs - 1)}d{stats.truncated ? ' ⋯' : ''}
            </span>
        ) : null}
      </div>

      {}
      <CollapseSection open={showRules}>
        <div className="shrink-0 border-b border-hairline bg-canvas px-2.5 py-2">
          <div className="mb-1 flex items-center gap-1.5">
            <Settings2 className="h-3 w-3 text-faint" aria-hidden="true" />
            <span className="text-[11px] font-medium text-muted">Ignore rules (this workspace)</span>
          </div>
          <input
            value={ruleDirs}
            onChange={(event) => setRuleDirs(event.target.value)}
            placeholder="dirs: temp, scratch"
            spellCheck={false}
            className="mb-1 w-full rounded-control border border-hairline bg-surface px-2 py-1 text-[11.5px] text-ink outline-none placeholder:text-faint"
          />
          <input
            value={rulePatterns}
            onChange={(event) => setRulePatterns(event.target.value)}
            placeholder="patterns: *.log, *.tmp"
            spellCheck={false}
            className="mb-1.5 w-full rounded-control border border-hairline bg-surface px-2 py-1 text-[11.5px] text-ink outline-none placeholder:text-faint"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button type="button" className="pill-button text-[11px] text-muted hover:text-ink" onClick={() => setRulesOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="pill-button bg-accent text-[11px] text-accent-ink hover:brightness-110"
              onClick={() => {
                if (!workspaceId) return;
                void saveTreeRules(workspaceId, {
                  dirs: ruleDirs.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean),
                  patterns: rulePatterns.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean),
                });
                setRulesOpen(false);
              }}
            >
              Save + rebuild
            </button>
          </div>
        </div>
      </CollapseSection>

      {}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-[11.5px] text-faint">
            {treeView ? 'No entries match the filter.' : 'No workspace bound to this chat.'}
          </p>
        ) : (
          <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
            {visible.map((row, i) => {
              const index = first + i;
              const node = row.node;
              const isDir = node.kind === 'dir';
              const isOpen = row.expanded || Boolean(filter.trim());
              return (
                <button
                  key={node.relPath}
                  type="button"
                  className={cx(
                    'absolute left-0 flex w-full items-center gap-1 px-2 text-left text-[12px] transition-colors hover:bg-elevated',
                    isDir ? 'text-ink' : 'text-muted',
                  )}
                  style={{ top: index * ROW_H, height: ROW_H, paddingLeft: 8 + row.depth * 12 }}
                  onClick={() => isDir && toggle(node.relPath)}
                >
                  {isDir ? (
                    isOpen ? (
                      <ChevronDown className="h-3 w-3 shrink-0 text-faint" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0 text-faint" aria-hidden="true" />
                    )
                  ) : (
                    <span className="inline-block w-3 shrink-0" />
                  )}
                  {isDir ? (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-accent/80" aria-hidden="true" />
                  ) : (
                    <FileIcon className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                  {node.kind === 'file' && node.size > 0 ? (
                    <span className="shrink-0 text-[10px] text-faint">{formatSize(node.size)}</span>
                  ) : null}
                  {node.truncated ? <span className="shrink-0 text-[10px] text-faint">⋯</span> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
