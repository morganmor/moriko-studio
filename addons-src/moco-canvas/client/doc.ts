
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAddonBus, useSession } from '@moriko/host';

import { walk, type Scene, type SceneNode, type Viewport } from './scene.ts';
import { type CanvasOp } from './ops.ts';
import { compileScene } from './compile.ts';
import { buildReadout } from './readout.ts';

export interface FlatNode {
  node: SceneNode;
  depth: number;
  parentId: string | null;
}

export interface LogLine {
  rev: number;
  at: string;
  actor: string;
  kind: string;
  note?: string;
}

export interface DocSummary {
  id: string;
  rev: number;
  dna: string;
  template: string;
  ops: number;
  updatedAt: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  hint: string;
}

interface StatePayload {
  docs: DocSummary[];
  doc: string | null;
  scene: Scene | null;
  templates: TemplateSummary[];
  log: LogLine[];
}

const HISTORY_LIMIT = 30;


async function rpc<T>(addonId: string, name: string, body: Record<string, unknown> = {}): Promise<T> {
  const resp = await fetch(`/api/addons/${addonId}/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await resp.json().catch(() => null)) as { result?: T; error?: string } | null;
  if (!resp.ok || !payload) throw new Error(payload?.error ?? `RPC "${name}" failed (${resp.status})`);
  return payload.result as T;
}

const ADDON = 'moco-canvas';

export function useCanvasDoc() {
  const { conversationId } = useSession();
  const [scene, setScene] = useState<Scene | null>(null);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [docId, setDocId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>('lg');
  const [showGrid, setShowGrid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [liveDragInfo, setLiveDragInfo] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [future, setFuture] = useState<string[]>([]);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const initialMount = useRef(true);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((kind: 'ok' | 'error', text: string) => {
    setNotice({ kind, text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4200);
  }, []);

  const adopt = useCallback((payload: StatePayload, keepSelection = true) => {
    setDocs(payload.docs ?? []);
    setTemplates(payload.templates ?? []);
    setDocId(payload.doc ?? null);
    setScene(payload.scene ?? null);
    setLog(payload.log ?? []);
    if (!keepSelection) setSelected(null);
  }, []);

  const refresh = useCallback(
    async (target?: string | null) => {
      try {
        const payload = await rpc<StatePayload>(ADDON, 'state', { sessionId: conversationId, ...(target ? { doc: target } : {}) });
        adopt(payload);
        setEngineError(null);
        return payload;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'failed to load state';
        setEngineError(message);
        flash('error', message);
        return null;
      }
    },
    [conversationId, adopt, flash],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const commitFrame = useAddonBus('moco-canvas.commit');
  useEffect(() => {
    if (!commitFrame) return;
    const frameDoc = (commitFrame as { payload?: { doc?: string } }).payload?.doc;
    if (frameDoc && docId && frameDoc !== docId) return;
    void refresh(docId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitFrame]);

  useEffect(() => {
    if (!scene || !selected) return;
    const exists = (() => {
      let hit = false;
      walk(scene.root, (node) => {
        if (node.id === selected) hit = true;
      });
      return hit;
    })();
    if (!exists) setSelected(null);
  }, [scene, selected]);

  const compiled = useMemo(() => (scene ? compileScene(scene) : null), [scene]);
  const readout = useMemo(() => (scene ? buildReadout(scene, viewport) : null), [scene, viewport]);

  const flat = useMemo<FlatNode[]>(() => {
    if (!scene) return [];
    const out: FlatNode[] = [];
    walk(scene.root, (node, parent) => {
      if (node.kind === 'page') return;
      out.push({ node, depth: parent && parent.kind !== 'page' ? 1 : 0, parentId: parent?.id ?? null });
    });
    return out;
  }, [scene]);

  
  const runOps = useCallback(
    async (ops: CanvasOp[], label?: string) => {
      if (!scene || !docId || ops.length === 0) return;
      setBusy(true);
      try {
        const result = await rpc<{ ok: boolean; scene: Scene; error?: string; notes?: string[]; delta?: string }>(
          ADDON,
          'apply',
          { sessionId: conversationId, doc: docId, ops, viewport },
        );
        if (!result.ok) {
          flash('error', result.error ?? 'op rejected');
          return;
        }
        setHistory((prev) => [docId, ...prev].slice(0, HISTORY_LIMIT));
        setFuture([]);
        setScene(result.scene);
        void refresh(docId);
        if (label) flash('ok', label);
      } catch (error) {
        flash('error', error instanceof Error ? error.message : 'apply failed');
      } finally {
        setBusy(false);
      }
    },
    [scene, docId, viewport, conversationId, refresh, flash],
  );

  const runOp = useCallback((op: CanvasOp) => void runOps([op]), [runOps]);

  const undo = useCallback(async () => {
    if (!docId) return;
    setBusy(true);
    try {
      const result = await rpc<{ ok: boolean; scene: Scene; note: string }>(ADDON, 'history', { sessionId: conversationId, doc: docId, kind: 'undo' });
      setScene(result.scene);
      setFuture((prev) => [docId, ...prev].slice(0, HISTORY_LIMIT));
      flash(result.ok ? 'ok' : 'error', result.note);
      void refresh(docId);
    } catch (error) {
      flash('error', error instanceof Error ? error.message : 'undo failed');
    } finally {
      setBusy(false);
    }
  }, [docId, conversationId, refresh, flash]);

  const redo = useCallback(async () => {
    if (!docId) return;
    setBusy(true);
    try {
      const result = await rpc<{ ok: boolean; scene: Scene; note: string }>(ADDON, 'history', { sessionId: conversationId, doc: docId, kind: 'redo' });
      setScene(result.scene);
      flash(result.ok ? 'ok' : 'error', result.note);
      void refresh(docId);
    } catch (error) {
      flash('error', error instanceof Error ? error.message : 'redo failed');
    } finally {
      setBusy(false);
    }
  }, [docId, conversationId, refresh, flash]);

  const createDoc = useCallback(
    async (template: string, doc = docId ?? 'landing') => {
      setBusy(true);
      try {
        const result = await rpc<{ ok: boolean; doc: string; scene: Scene }>(ADDON, 'new', { sessionId: conversationId, doc, template });
        setScene(result.scene);
        setDocId(result.doc);
        setSelected(null);
        await refresh(result.doc);
        flash('ok', `document ${result.doc} created from ${template}`);
      } catch (error) {
        flash('error', error instanceof Error ? error.message : 'failed to create document');
      } finally {
        setBusy(false);
      }
    },
    [docId, refresh, flash],
  );

  const openDoc = useCallback(
    async (next: string) => {
      setSelected(null);
      await refresh(next);
    },
    [refresh],
  );

  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false;
      return;
    }
    const frame = frameRef.current;
    if (!frame || !compiled) return;
    try {
      const doc = frame.contentDocument;
      const win = frame.contentWindow as (Window & { __mcvSync?: (opts: unknown) => void }) | null;
      if (!doc || !win) return;
      const sx = win.scrollX;
      const sy = win.scrollY;
      const styleEl = doc.getElementById('mcv-compiled-css');
      if (styleEl && styleEl.textContent !== compiled.css) styleEl.textContent = compiled.css;
      const rootEl = doc.getElementById('mcv-scene-root');
      if (rootEl) rootEl.innerHTML = compiled.bodyHtml;
      win.scrollTo(sx, sy);
      win.__mcvSync?.({ selected, showGrid });
    } catch {
    }
  }, [compiled, selected, showGrid]);

  useEffect(() => {
    try {
      const win = frameRef.current?.contentWindow as (Window & { __mcvSync?: (opts: unknown) => void }) | null;
      win?.__mcvSync?.({ selected, showGrid });
    } catch {}
  }, [selected, showGrid]);

  usePreviewBridge(frameRef, flat, setSelected, runOp, setLiveDragInfo);

  const selectedNode = selected ? flat.find((f) => f.node.id === selected)?.node ?? null : null;

  return {
    scene,
    compiled,
    readout,
    flat,
    selected,
    setSelected,
    selectedNode,
    viewport,
    setViewport,
    showGrid,
    setShowGrid,
    docs,
    docId,
    templates,
    log,
    rev: scene?.rev ?? 0,
    runOp,
    runOps,
    undo,
    redo,
    canUndo: history.length > 0,
    canRedo: future.length > 0,
    createDoc,
    openDoc,
    refresh,
    busy,
    notice,
    engineError,
    frameRef,
    liveDragInfo,
  };
}


function usePreviewBridge(
  frameRef: React.RefObject<HTMLIFrameElement | null>,
  flat: FlatNode[],
  setSelected: (id: string) => void,
  runOp: (op: CanvasOp) => void,
  setLiveDragInfo: (info: string | null) => void,
): void {
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data as {
        type?: string;
        id?: string;
        col?: number;
        row?: number;
        c1?: number;
        r1?: number;
        c2?: number;
        r2?: number;
        toIndex?: number;
        detail?: string;
      };
      if (!data || typeof data.type !== 'string') return;

      if (data.type === 'mcv-select' && data.id) {
        if (flat.some((f) => f.node.id === data.id)) setSelected(data.id);
        return;
      }
      if (data.type === 'mcv-drag-live') {
        setLiveDragInfo(data.detail ?? null);
        return;
      }
      if (data.type === 'mcv-drag-end') {
        setLiveDragInfo(null);
        return;
      }
      if (data.type === 'mcv-move' && data.id && typeof data.col === 'number' && typeof data.row === 'number') {
        const col = data.col;
        const row = data.row;
        runOp({ op: 'move', id: data.id, at: `${String.fromCharCode(64 + col)}${row}` });
        return;
      }
      if (data.type === 'mcv-span' && data.id && typeof data.c1 === 'number' && typeof data.c2 === 'number' && typeof data.r1 === 'number' && typeof data.r2 === 'number') {
        runOp({ op: 'span', id: data.id, c1: data.c1, r1: data.r1, c2: data.c2, r2: data.r2 });
        return;
      }
      if (data.type === 'mcv-reorder' && data.id && typeof data.toIndex === 'number') {
        runOp({ op: 'reorder', id: data.id, index: data.toIndex });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameRef, flat, setSelected, runOp, setLiveDragInfo]);
}
