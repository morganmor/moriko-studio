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
  const activeId = useStore((state) => state.activeId);
  const showNotice = useStore((state) => state.showNotice);
  const queueComposerFiles = useStore((state) => state.queueComposerFiles);

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

  /**
   * TREE ATTACH (right-dock design): clicking a file fetches it through the
   * workspace-scoped raw endpoint and hands it to the composer's normal
   * attachment pipeline as a reference. The raw route already clamps to the
   * active workspace and 403s on traversal, so no extra guard is needed here.
   */
  const attachFile = useCallback(
    async (node: TreeNodeInfo) => {
      try {
        const params = new URLSearchParams();
        if (activeId) params.set('sessionId', activeId);
        const query = params.toString();
        const response = await fetch(
          `/api/agent/raw/${node.relPath.split('/').map(encodeURIComponent).join('/')}${query ? `?${query}` : ''}`,
        );
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        queueComposerFiles([new File([blob], node.name, { type: blob.type || 'application/octet-stream' })]);
        showNotice('tree.attached', { name: node.name });
      } catch {
        showNotice('tree.attachFailed', { name: node.name });
      }
    },
    [activeId, queueComposerFiles, showNotice],
  );

  const rows = useMemo(
    () => (treeView ? flatten(treeView.root, expanded, filter) : []),
    [treeView, expanded, filter],
  );

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

  useTreeLive(boundWorkspaceId, true);

  const stats = treeView?.stats;

  return (
    <aside
      className="dock-in"
      style={{ height: '100%', width: width ?? 300, flexShrink: 0, overflow: 'hidden', borderRadius: 'var(--r-xl)', border: '1px solid var(--line)', background: 'rgb(var(--c-elev))', boxShadow: 'var(--sh1)' }}
      role="region"
      aria-label="Project structure"
    >
      {}
      <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 6, borderBottom: '1px solid var(--line)', background: 'rgb(var(--c-elev))', padding: '6px 10px' }}>
        <Folder className="ic" style={{ color: 'rgb(var(--c-accent))' }} aria-hidden="true" />
        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
          {treeView?.root.name ?? 'Project tree'}
        </span>
        <RightDockCloseButton />
      </div>
      <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 6, borderBottom: '1px solid var(--line)', background: 'rgb(var(--c-elev))', padding: '6px 10px' }}>
        <RightDockSlot mode={rightPanelMode} onChange={setRightPanelMode} />
        <div style={{ flex: 1 }} />
        {treeView?.refreshing ? (
          <Loader2 className="ic spin" style={{ flexShrink: 0, color: 'var(--faint)' }} aria-hidden="true" />
        ) : null}
        <button
          type="button"
          className="ib xs"
          style={{ flexShrink: 0 }}
          onClick={() => setRulesOpen((value) => !value)}
          aria-label="Ignore rules"
        >
          <SlidersHorizontal className="ic" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ib xs"
          style={{ flexShrink: 0 }}
          onClick={() => workspaceId && void refreshTreeView(workspaceId)}
          aria-label="Rebuild index"
        >
          <RefreshCw className="ic" aria-hidden="true" />
        </button>
      </div>

      {}
      <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 6, borderBottom: '1px solid var(--line)', padding: '6px 10px' }}>
        <Filter className="ic" style={{ flexShrink: 0, color: 'var(--faint)' }} aria-hidden="true" />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter…"
          spellCheck={false}
          style={{ minWidth: 0, flex: 1, background: 'transparent', border: 0, outline: 0, fontSize: 12, color: 'rgb(var(--c-ink))' }}
        />
        {stats ? (
            <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--faint)' }}>
              {stats.files}f·{Math.max(0, stats.dirs - 1)}d{stats.truncated ? ' ⋯' : ''}
            </span>
        ) : null}
      </div>

      {}
      <CollapseSection open={showRules}>
        <div style={{ flexShrink: 0, borderBottom: '1px solid var(--line)', background: 'rgb(var(--c-canvas))', padding: '8px 10px' }}>
          <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Settings2 className="ic" style={{ width: 12, height: 12, color: 'var(--faint)' }} aria-hidden="true" />
            <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)' }}>Ignore rules (this workspace)</span>
          </div>
          <input
            value={ruleDirs}
            onChange={(event) => setRuleDirs(event.target.value)}
            placeholder="dirs: temp, scratch"
            spellCheck={false}
            className="field"
            style={{ marginBottom: 4, fontSize: 11.5, padding: '4px 8px' }}
          />
          <input
            value={rulePatterns}
            onChange={(event) => setRulePatterns(event.target.value)}
            placeholder="patterns: *.log, *.tmp"
            spellCheck={false}
            className="field"
            style={{ marginBottom: 6, fontSize: 11.5, padding: '4px 8px' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
            <button type="button" className="btn ghost xs" onClick={() => setRulesOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary xs"
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
        style={{ minHeight: 0, flex: 1, overflowY: 'auto', overflowX: 'hidden' }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {rows.length === 0 ? (
          <p style={{ padding: '16px 12px', fontSize: 11.5, color: 'var(--faint)' }}>
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
                  className={cx('pt-tree-row', isDir ? 'pt-dir' : 'pt-file')}
                  style={{ top: index * ROW_H, height: ROW_H, paddingLeft: 8 + row.depth * 12, width: '100%', textAlign: 'left', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                  onClick={() => {
                    if (isDir) toggle(node.relPath);
                    else void attachFile(node);
                  }}
                >
                  {isDir ? (
                    isOpen ? (
                      <ChevronDown className="ic" style={{ width: 12, height: 12, flexShrink: 0, color: 'var(--faint)' }} aria-hidden="true" />
                    ) : (
                      <ChevronRight className="ic" style={{ width: 12, height: 12, flexShrink: 0, color: 'var(--faint)' }} aria-hidden="true" />
                    )
                  ) : (
                    <span style={{ display: 'inline-block', width: 12, flexShrink: 0 }} />
                  )}
                  {isDir ? (
                    <Folder className="ic" style={{ width: 14, height: 14, flexShrink: 0, color: 'rgb(var(--c-accent) / 0.8)' }} aria-hidden="true" />
                  ) : (
                    <FileIcon className="ic" style={{ width: 14, height: 14, flexShrink: 0, color: 'var(--faint)' }} aria-hidden="true" />
                  )}
                  <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isDir ? 'rgb(var(--c-ink))' : 'var(--muted)' }}>{node.name}</span>
                  {node.kind === 'file' && node.size > 0 ? (
                    <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--faint)' }}>{formatSize(node.size)}</span>
                  ) : null}
                  {node.truncated ? <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--faint)' }}>⋯</span> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <p className="hint2" style={{ flexShrink: 0, margin: 0, padding: '6px 12px 10px', borderTop: '1px solid var(--line)' }}>
        Click a file to attach it to the composer as a reference.
      </p>
    </aside>
  );
}
