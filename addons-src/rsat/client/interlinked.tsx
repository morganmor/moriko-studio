/**
 * RSA/T Interlinked — ComfyUI-style glowing node & wire architecture canvas
 * + @RSLK v1 Agent DSL preview.
 * Phase I (Frontend-First): Interactive pan/zoom canvas, draggable file/contract
 * nodes, glowing cubic-bezier wires (runtime, type, active-touch, cross-agent,
 * violation), spotlight hover/selection, inspector panel, and live @RSLK v1 view.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { rpc, tr } from './shared.tsx';
import { Ic } from './icon.tsx';
import { useRsat } from './store.tsx';

export type WireKind = 'data' | 'type' | 'active' | 'cross' | 'broken';

export interface InterlinkSocket {
  id: string;
  label: string;
  kind: 'runtime' | 'type' | 'hook' | 'store';
  contractStatus?: 'matched' | 'missing' | 'undeclared' | 'unscoped';
}

export interface ContractCheckSummary {
  questId?: string;
  declaredProvides: string[];
  declaredConsumes: string[];
  matchedProvides: string[];
  missingProvides: string[];
  undeclaredExports: string[];
  matchedConsumes: string[];
  missingConsumes: string[];
}

export interface InterlinkNode {
  id: string;
  file: string;
  title: string;
  moduleId: string;
  layer: 'presentation' | 'application' | 'domain' | 'infrastructure' | 'shared';
  questId?: string;
  holder?: string;
  state?: string;
  x: number;
  y: number;
  fanIn: number;
  fanOut: number;
  touched?: boolean;
  violation?: string;
  contractCheck?: ContractCheckSummary;
  isGhost?: boolean;
  inputs: InterlinkSocket[];
  outputs: InterlinkSocket[];
}

export interface InterlinkWire {
  id: string;
  fromNode: string;
  fromSocket: string;
  toNode: string;
  toSocket: string;
  symbols: string[];
  kind: WireKind;
  note?: string;
}

export interface ModuleCluster {
  id: string;
  name: string;
  layer: string;
  allowedImports: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

const NODE_W = 248;
const HEAD_H = 54;
const SOCK_H = 22;

const WIRE_VAR: Record<WireKind, string> = {
  data: 'var(--c-rsat-wire-data)',
  type: 'var(--c-rsat-wire-type)',
  active: 'var(--c-rsat-wire-active)',
  cross: 'var(--c-rsat-wire-cross)',
  broken: 'var(--c-rsat-wire-broken)',
};

const STATE_VAR: Record<string, string> = {
  done: 'var(--c-rsat-done)',
  in_progress: 'var(--c-rsat-running)',
  claimed: 'var(--c-rsat-claimed)',
  review: 'var(--c-rsat-review)',
  available: 'var(--c-rsat-available)',
  locked: 'var(--c-rsat-locked)',
  blocked: 'var(--c-rsat-blocked)',
};

/** Empty graph placeholder — the panel shows REAL scanned workspace data via
 *  the `interlinkGraph` RPC. No hardcoded fixture: an honest empty state is
 *  rendered when no workspace is bound or the scan found nothing. */
const EMPTY_GRAPH: { clusters: ModuleCluster[]; nodes: InterlinkNode[]; wires: InterlinkWire[] } = {
  clusters: [],
  nodes: [],
  wires: [],
};

/** Hitung titik koordinat X,Y dari pin socket untuk menggambar kurva Bezier. */
function socketCoords(
  node: InterlinkNode,
  socketId: string,
  side: 'in' | 'out',
): { x: number; y: number } {
  const list = side === 'in' ? node.inputs : node.outputs;
  const idx = Math.max(0, list.findIndex((s) => s.id === socketId));
  const x = side === 'in' ? node.x : node.x + NODE_W;
  const y = node.y + HEAD_H + 18 + idx * SOCK_H;
  return { x, y };
}

/** Generator Format Khusus Agent: @RSLK v1 (Token-Dense Topology & Blast Radius DSL). */
export function generateRslkDsl(
  clusters: ModuleCluster[],
  nodes: InterlinkNode[],
  wires: InterlinkWire[],
  focusNodeId: string | null,
   workspaceName: string,
): string {
  const broken = wires.filter((w) => w.kind === 'broken');
  const cross = wires.filter((w) => w.kind === 'cross');
  const lines: string[] = [
    `@RSLK v1 | ws="${workspaceName || 'moriko-workspace'}" | nodes=${nodes.length} wires=${wires.length} cross_agent=${cross.length} violations=${broken.length}`,
    `@LEGEND: [N:file] Node | --(sym)--> Runtime | ==(Type)==> Contract | ~~(sym)~~> Active Touch | !!(err)!!> Violation`,
    ``,
    `# 1. ARCHITECTURE MODULES & LAYER MATRIX`,
  ];

  for (const c of clusters) {
    lines.push(`[${c.id}] "${c.name}" (layer:${c.layer}) -> allowedImports:[${c.allowedImports.join(', ')}]`);
  }

  const targetNodes = focusNodeId ? nodes.filter((n) => n.id === focusNodeId) : nodes;
  lines.push(``, `# 2. INTERLINKED NODE TOPOLOGY ${focusNodeId ? `(FOCUSED: ${focusNodeId})` : '(FULL GRAPH)'}`);

  for (const n of targetNodes) {
    const I = n.fanIn + n.fanOut === 0 ? '0.00' : (n.fanOut / (n.fanIn + n.fanOut)).toFixed(2);
    const flags = [
      n.touched ? '*ACTIVE_TOUCH*' : '',
      n.violation ? '!VIOLATION!' : '',
    ].filter(Boolean).join(' ');
    lines.push(
      `[N:${n.file}] (quest:${n.questId ?? 'unassigned'} [${n.state ?? 'idle'} by ${n.holder ?? 'none'}] | mod:${n.moduleId} | layer:${n.layer} | fanIn:${n.fanIn} fanOut:${n.fanOut} I=${I}) ${flags}`.trim(),
    );
    if (n.outputs.length) {
      lines.push(
        `  PROVIDES: ${n.outputs
          .map((o) => {
            const st =
              o.contractStatus === 'matched'
                ? '✓'
                : o.contractStatus === 'missing'
                  ? '✗MISSING:'
                  : o.contractStatus === 'undeclared'
                    ? '?UNDECLARED:'
                    : '';
            return `${st}${o.label}:${o.kind}`;
          })
          .join(', ')}`,
      );
    }
    if (n.contractCheck && (n.contractCheck.declaredProvides.length > 0 || n.contractCheck.declaredConsumes.length > 0)) {
      lines.push(
        `  CONTRACT: matched=[${n.contractCheck.matchedProvides.join(',')}] missing=[${n.contractCheck.missingProvides.join(',')}] undeclared=[${n.contractCheck.undeclaredExports.join(',')}]`,
      );
    }
    const outWires = wires.filter((w) => w.fromNode === n.id);
    for (const w of outWires) {
      const dst = nodes.find((x) => x.id === w.toNode);
      if (!dst) continue;
      const arrow =
        w.kind === 'type'
          ? `==(${w.symbols.join(',')})==>`
          : w.kind === 'broken'
          ? `!!(${w.symbols.join(',')})!!>`
          : w.kind === 'active'
          ? `~~(${w.symbols.join(',')})~~>`
          : `--(${w.symbols.join(',')})-->`;
      const crossTag = w.kind === 'cross' ? ` [CROSS-AGENT: ${n.holder} -> ${dst.holder}]` : '';
      lines.push(`  |${arrow} [N:${dst.file}] (quest:${dst.questId} | mod:${dst.moduleId})${crossTag}`);
    }
    const inWires = wires.filter((w) => w.toNode === n.id);
    if (focusNodeId && inWires.length) {
      lines.push(`  UPSTREAM PROVIDERS (${inWires.length}):`);
      for (const w of inWires) {
        const src = nodes.find((x) => x.id === w.fromNode);
        if (src) lines.push(`  <--(${w.symbols.join(',')})-- [N:${src.file}] (quest:${src.questId} by ${src.holder})`);
      }
    }
  }

  lines.push(``, `# 3. ARCHITECTURAL & MULTI-AGENT ALERTS`);
  if (broken.length === 0 && cross.length === 0) {
    lines.push(`(clean — 0 layer violations, 0 cross-agent collisions)`);
  } else {
    for (const w of broken) {
      const src = nodes.find((x) => x.id === w.fromNode);
      const dst = nodes.find((x) => x.id === w.toNode);
      lines.push(`[ALERT:LAYER_VIOLATION] ${src?.file} -> ${dst?.file}: ${w.note ?? 'Forbidden cross-layer import'}`);
    }
    for (const w of cross) {
      const src = nodes.find((x) => x.id === w.fromNode);
      const dst = nodes.find((x) => x.id === w.toNode);
      lines.push(`[WARN:CROSS_AGENT_WIRE] ${src?.file} (${src?.holder}) feeds ${dst?.file} (${dst?.holder}) via [${w.symbols.join(', ')}]`);
    }
  }

  return lines.join('\n');
}

export default function Interlinked({ onOpen }: { onOpen: (id: string) => void }) {
  const s = useRsat();
  const lang = s.language === 'id' ? 'id' : 'en';
  const t = (k: string) => tr(lang, k);

  const fallback = EMPTY_GRAPH;
  const [liveGraph, setLiveGraph] = useState<{
    clusters: ModuleCluster[];
    nodes: InterlinkNode[];
    wires: InterlinkWire[];
    dsl?: string;
    stats?: { totalScanned?: number };
  } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [showInspect, setShowInspect] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [filter, setFilter] = useState<'all' | 'active' | 'cross' | 'broken'>('all');
  const [mode, setMode] = useState<'canvas' | 'rslk'>('canvas');
  const [query, setQuery] = useState('');
  const [selNodeId, setSelNodeId] = useState<string | null>(null);
  const [selWireId, setSelWireId] = useState<string | null>(null);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadLiveGraph = useCallback(async (force = false) => {
    setScanning(true);
    setScanError(null);
    try {
      const res = (await rpc('interlinkGraph', { force })) as {
        clusters?: ModuleCluster[];
        nodes?: InterlinkNode[];
        wires?: InterlinkWire[];
        dsl?: string;
        stats?: { totalScanned?: number };
      } | null;
      if (res && Array.isArray(res.nodes) && res.nodes.length > 0) {
        setLiveGraph({
          clusters: res.clusters ?? [],
          nodes: res.nodes,
          wires: res.wires ?? [],
          dsl: res.dsl,
          stats: res.stats,
        });
        setSelNodeId((prev) => (prev && res.nodes!.some((n) => n.id === prev) ? prev : res.nodes![0]?.id ?? null));
      } else {
        setLiveGraph(null);
        setScanError('No source files found in the bound workspace. Pick a workspace or create a PRD that scopes your project.');
      }
    } catch (err) {
      setLiveGraph(null);
      setScanError(err instanceof Error ? err.message : 'Failed to scan the workspace.');
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void loadLiveGraph(false);
  }, [loadLiveGraph, s.workspacePath, s.achs.length]);

  const initial = liveGraph ?? fallback;

  const vpRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const camRef = useRef({ x: 18, y: 14, z: 0.78 });
  const applyCam = useCallback(() => {
    const el = worldRef.current;
    if (el) {
      const { x, y, z } = camRef.current;
      el.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    }
    if (zoomLabelRef.current) {
      zoomLabelRef.current.textContent = `${Math.round(camRef.current.z * 100)}%`;
    }
  }, []);
  const [panning, setPanning] = useState(false);
  const zoomLabelRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<{
    kind: 'pan' | 'node';
    nodeId?: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
  } | null>(null);

  const nodes = useMemo(
    () =>
      initial.nodes.map((n) => ({
        ...n,
        x: positions[n.id]?.x ?? n.x,
        y: positions[n.id]?.y ?? n.y,
      })),
    [initial.nodes, positions],
  );

  const wires = initial.wires;
  const clusters = initial.clusters;

  const [vpEl, setVpEl] = useState<HTMLDivElement | null>(null);
  const setVpRef = useCallback((el: HTMLDivElement | null) => {
    vpRef.current = el;
    setVpEl(el);
  }, []);
  useEffect(() => {
    if (!vpEl) return;
    const el = vpEl;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      {
        const c = camRef.current;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const nz = Math.min(1.65, Math.max(0.42, +(c.z * factor).toFixed(3)));
        camRef.current = {
          x: mx - ((mx - c.x) / c.z) * nz,
          y: my - ((my - c.y) / c.z) * nz,
          z: nz,
        };
        applyCam();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [vpEl, applyCam]);

  const onVpDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // kalau tidak, klik tombolnya tertelan jadi pan (bug tombol LEGENDS).
    if ((e.target as HTMLElement).closest('.il-node, .il-wire-grp, .il-hud-ctl, .il-legend-ctl, .il-mini')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: camRef.current.x, oy: camRef.current.y };
    setPanning(true);
  };

  const onNodeDown = (e: ReactPointerEvent<HTMLDivElement>, node: InterlinkNode) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const vp = vpRef.current;
    if (vp) vp.setPointerCapture(e.pointerId);
    dragRef.current = {
      kind: 'node',
      nodeId: node.id,
      sx: e.clientX,
      sy: e.clientY,
      ox: node.x,
      oy: node.y,
    };
    setSelNodeId(node.id);
    setSelWireId(null);
    setShowInspect(true);
  };

  const dragRafRef = useRef<number | null>(null);
  const lastPtRef = useRef<{ x: number; y: number } | null>(null);

  const onVpMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pan') {
      camRef.current.x = d.ox + (e.clientX - d.sx);
      camRef.current.y = d.oy + (e.clientY - d.sy);
      applyCam();
    } else if (d.kind === 'node' && d.nodeId) {
      const dx = (e.clientX - d.sx) / camRef.current.z;
      const dy = (e.clientY - d.sy) / camRef.current.z;
      const nx = Math.max(16, Math.round((d.ox + dx) / 8) * 8);
      const ny = Math.max(16, Math.round((d.oy + dy) / 8) * 8);
      lastPtRef.current = { x: nx, y: ny };
      if (dragRafRef.current == null) {
        const nodeId = d.nodeId;
        dragRafRef.current = requestAnimationFrame(() => {
          dragRafRef.current = null;
          const pt = lastPtRef.current;
          if (pt) setPositions((p) => ({ ...p, [nodeId]: pt }));
        });
      }
    }
  };

  const onVpUp = (e?: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    if (d?.kind === 'pan' && e && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) {
      setSelNodeId(null);
      setSelWireId(null);
      return;
    }
    if (dragRafRef.current != null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
      const pt = lastPtRef.current;
      if (d?.kind === 'node' && d.nodeId && pt) setPositions((p) => ({ ...p, [d.nodeId!]: pt }));
    }
    if (d?.kind === 'node' && d.nodeId) {
      setPositions((latest) => {
        const pt = latest[d.nodeId!];
        if (pt) void rpc('saveNodePositions', { positions: { [d.nodeId!]: pt } }).catch(() => {});
        return latest;
      });
    }
  };

  const activeFocusNode = hoverNodeId ?? selNodeId;

  const visibleWires = useMemo(() => {
    return wires.filter((w) => {
      if (filter === 'active') return w.kind === 'active';
      if (filter === 'cross') return w.kind === 'cross';
      if (filter === 'broken') return w.kind === 'broken';
      return true;
    });
  }, [wires, filter]);

  const connectedNodeIds = useMemo(() => {
    const set = new Set<string>();
    if (selWireId) {
      const w = wires.find((x) => x.id === selWireId);
      if (w) {
        set.add(w.fromNode);
        set.add(w.toNode);
      }
      if (!activeFocusNode) return set;
    }
    if (!activeFocusNode) return null;
    set.add(activeFocusNode);
    for (const w of visibleWires) {
      if (w.fromNode === activeFocusNode) set.add(w.toNode);
      if (w.toNode === activeFocusNode) set.add(w.fromNode);
    }
    return set;
  }, [activeFocusNode, selWireId, visibleWires, wires]);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const selNode = nodes.find((n) => n.id === selNodeId) ?? null;
  const selWire = wires.find((w) => w.id === selWireId) ?? null;

  const rslkText = useMemo(
    () =>
      !selNodeId && liveGraph?.dsl
        ? liveGraph.dsl
        : generateRslkDsl(clusters, nodes, wires, selNodeId, s.workspacePath?.split(/[\\/]/).pop() ?? 'moriko-harness-source'),
    [clusters, nodes, wires, selNodeId, liveGraph, s.workspacePath],
  );

  const copyRslk = () => {
    try {
      navigator.clipboard?.writeText(rslkText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
    }
  };

  const qLower = query.trim().toLowerCase();

  return (
    <div className="il-shell">
      {}
      <div className="pn il-bar">
        <div className="row" style={{ gap: 6 }}>
          <Ic name="nodes" />
          <b style={{ font: '700 13px var(--f-px)', letterSpacing: '.05em', textTransform: 'uppercase' }}>
            {t('interlinked')}
          </b>
          <span className="chip">
            {scanning ? t('ilScanning') : liveGraph ? `LIVE · ${liveGraph.stats?.totalScanned ?? nodes.length} files` : scanError ? 'ERROR' : 'NO DATA'}
          </span>
          <span className="chip">{nodes.length} {t('ilNodesL')}</span>
          <span className="chip">{wires.length} {t('ilWiresL')}</span>
          {selNodeId ? (
            <button
              type="button"
              className="btn sm ghost"
              style={{ height: 22 }}
              onClick={() => {
                setSelNodeId(null);
                setSelWireId(null);
              }}
            >
              {t('ilClearSpot')}
            </button>
          ) : null}
          <button
            type="button"
            className="btn sm"
            aria-pressed={showInspect}
            title={t('ilToggleInsp')}
            onClick={() => setShowInspect((v) => !v)}
          >
            <Ic name="eye" sm /> {t('ilInspector')}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={scanning}
            onClick={() => void loadLiveGraph(true)}
          >
            <Ic name="refactor" sm /> {scanning ? t('ilScanning') : t('ilRescan')}
          </button>
        </div>

        <div className="seg-ctl" role="group" aria-label={t('ilWireFilter')}>
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            {t('all')} ({wires.length})
          </button>
          <button type="button" aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>
            {t('fActive')} ({wires.filter((w) => w.kind === 'active').length})
          </button>
          <button type="button" aria-pressed={filter === 'cross'} onClick={() => setFilter('cross')}>
            {t('fCross')} ({wires.filter((w) => w.kind === 'cross').length})
          </button>
          <button type="button" aria-pressed={filter === 'broken'} onClick={() => setFilter('broken')}>
            {t('fAlerts')} ({wires.filter((w) => w.kind === 'broken').length})
          </button>
        </div>

        <div className="field row" style={{ flex: '1 1 180px', maxWidth: 240 }}>
          <Ic name="search" sm />
          <input
            placeholder={t('ilFilterPh')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ background: 'none', border: 0, outline: 0, width: '100%' }}
          />
        </div>

        <div className="seg-ctl" style={{ marginLeft: 'auto' }} role="group" aria-label={t('ilViewMode')}>
          <button type="button" aria-pressed={mode === 'canvas'} onClick={() => setMode('canvas')}>
            <Ic name="nodes" sm /> {t('nodeCanvas')}
          </button>
          <button type="button" aria-pressed={mode === 'rslk'} onClick={() => setMode('rslk')}>
            <Ic name="code" sm /> {t('agentDsl')}
          </button>
        </div>
      </div>

      {!scanning && nodes.length === 0 ? (
        <div className="card col" style={{ gap: 12, padding: 24, alignItems: 'center', textAlign: 'center' }}>
          <b>{t('ilNoData')}</b>
          <div className="muted" style={{ fontSize: 12, maxWidth: 440 }}>
            {t('ilNoDataDesc')}
          </div>
          <code className="mono" style={{ fontSize: 11, opacity: 0.85, wordBreak: 'break-all' }}>
            {s.workspacePath || t('ilNoWs')}
          </code>
          {scanError ? (
            <div className="muted" style={{ fontSize: 11, color: 'var(--c-rsat-blocked)' }}>{scanError}</div>
          ) : null}
          <button type="button" className="btn sm" onClick={() => void loadLiveGraph(true)}>
            <Ic name="refactor" sm /> {scanning ? t('ilScanning') : t('ilScan')}
          </button>
        </div>
      ) : mode === 'rslk' ? (
        <div className="card col" style={{ gap: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div className="col" style={{ gap: 2 }}>
              <div className="eyebrow">AGENT ARCHITECTURAL PERCEPTION FORMAT (@RSLK v1)</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {t('ilRslkDesc')}
              </div>
            </div>
            <div className="row">
              {selNode ? (
                <button type="button" className="btn sm" onClick={() => setSelNodeId(null)}>
                  {t('ilShowFull')}
                </button>
              ) : null}
              <button type="button" className="btn sm" onClick={copyRslk}>
                <Ic name={copied ? 'check' : 'download'} sm /> {copied ? t('ilCopied') : t('ilCopy')}
              </button>
            </div>
          </div>
          <pre className="il-dsl">{rslkText}</pre>
        </div>
      ) : (
        <div className={showInspect ? 'il-workspace' : 'il-workspace full'}>
          {!showInspect && (selNode || selWire) ? (
            <div
              className="pn il-mini"
              onClick={() => setShowInspect(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setShowInspect(true); }}
            >
              {selWire ? (
                <>
                  <span className="chip">{t('ilWire')}</span>
                  <b className="mono" style={{ fontSize: 10.5 }}>{selWire.symbols.join(', ')}</b>
                  <span className="chip">{selWire.kind.toUpperCase()}</span>
                  <span className="mono muted" style={{ fontSize: 9.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selWire.fromNode.replace(/^n:/, '')} → {selWire.toNode.replace(/^n:/, '')}
                  </span>
                </>
              ) : selNode ? (
                <>
                  <span className="chip">{t('ilNode')}</span>
                  <b className="mono" style={{ fontSize: 10.5 }}>{selNode.file}</b>
                  {selNode.layer ? <span className="layer-pill">{selNode.layer}</span> : null}
                  {selNode.questId ? <span className="chip">{selNode.questId}</span> : null}
                  <span className="mono muted" style={{ fontSize: 9.5 }}>{t('ilFanIn')} {selNode.fanIn} · {t('ilFanOut')} {selNode.fanOut}</span>
                  {selNode.violation ? <span className="chip">⚠</span> : null}
                </>
              ) : null}
            </div>
          ) : null}
          <div
            ref={setVpRef}
            className={panning ? 'il-viewport panning' : 'il-viewport'}
            onPointerDown={onVpDown}
            onPointerMove={onVpMove}
            onPointerUp={onVpUp}
            onPointerCancel={onVpUp}
          >
            <div
              ref={worldRef}
              className="il-world"
              style={{ transform: `translate(${camRef.current.x}px, ${camRef.current.y}px) scale(${camRef.current.z})` }}
            >
              {}
              {clusters.map((c, ci) => (
                <div
                  key={`${c.id}-${ci}`}
                  className="il-mod-zone"
                  style={{
                    position: 'absolute',
                    left: c.x,
                    top: c.y,
                    width: c.w,
                    height: c.h,
                  }}
                >
                  <b>
                    <Ic name="layers" sm /> {c.id} · {c.name}
                  </b>
                  <div className="mono muted" style={{ fontSize: 10, marginTop: 2 }}>
                    layer: {c.layer} · allowed: [{c.allowedImports.join(', ')}]
                  </div>
                </div>
              ))}

              {}
              <svg className="il-wires" style={{ position: 'absolute', left: 0, top: 0 }}>
                {visibleWires.map((w) => {
                  const src = nodeById.get(w.fromNode);
                  const dst = nodeById.get(w.toNode);
                  if (!src || !dst) return null;
                  const p1 = socketCoords(src, w.fromSocket, 'out');
                  const p2 = socketCoords(dst, w.toSocket, 'in');
                  const dx = Math.max(70, Math.abs(p2.x - p1.x) * 0.48);
                  const d = `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
                  const mx = (p1.x + p2.x) / 2;
                  const my = (p1.y + p2.y) / 2 - 8;

                  const isHot =
                    selWireId === w.id ||
                    (activeFocusNode && (w.fromNode === activeFocusNode || w.toNode === activeFocusNode));
                  const isDim =
                    (selWireId && selWireId !== w.id) ||
                    (activeFocusNode && !isHot);

                  const cls = [
                    'il-wire-grp',
                    isHot ? 'hot' : '',
                    isDim ? 'dim' : '',
                    w.kind === 'broken' ? 'broken' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');

                  const q = s.ilQuality;
                  const flow =
                    q === 'high' ? (w.kind === 'active' || w.kind === 'cross' || isHot)
                    : q === 'medium' ? (w.kind === 'active' || w.kind === 'cross')
                    : false;

                  return (
                    <g
                      key={w.id}
                      className={cls}
                      style={{ '--wc': WIRE_VAR[w.kind] } as CSSProperties}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelWireId(w.id);
                        setSelNodeId(null);
                        setShowInspect(true);
                      }}
                    >
                      <path className="il-wire-glow" d={d} />
                      <path className="il-wire-core" d={d} />
                      {flow ? <path className="il-wire-pulse" d={d} /> : null}
                      {isHot ? (
                        <g transform={`translate(${mx}, ${my})`}>
                          <rect
                            x={-68}
                            y={-11}
                            width={136}
                            height={18}
                            fill="rgb(var(--c-rsat-tip-bg))"
                            stroke="rgb(var(--wc))"
                            strokeWidth={1.5}
                          />
                          <text
                            x={0}
                            y={2}
                            textAnchor="middle"
                            fill="rgb(var(--c-rsat-toast-ink))"
                            style={{ font: '700 9.5px var(--f-mono)' }}
                          >
                            {w.symbols.join(', ').slice(0, 22)}
                          </text>
                        </g>
                      ) : null}
                    </g>
                  );
                })}
              </svg>

              {}
              {nodes.map((node) => {
                const matchQuery =
                  !qLower ||
                  node.file.toLowerCase().includes(qLower) ||
                  node.title.toLowerCase().includes(qLower) ||
                  node.inputs.some((i) => i.label.toLowerCase().includes(qLower)) ||
                  node.outputs.some((o) => o.label.toLowerCase().includes(qLower));

                const isDim =
                  !matchQuery ||
                  (connectedNodeIds !== null && !connectedNodeIds.has(node.id));

                const cls = [
                  'il-node',
                  selNodeId === node.id ? 'sel' : '',
                  node.touched ? 'active-touch' : '',
                  node.violation ? 'violation' : '',
                  isDim ? 'dim' : '',
                ]
                  .filter(Boolean)
                  .join(' ');

                const stColor = STATE_VAR[node.state ?? 'available'] ?? 'var(--c-rsat-claimed)';

                return (
                  <div
                    key={node.id}
                    className={cls}
                    style={{ position: 'absolute', left: node.x, top: node.y }}
                    onPointerDown={(e) => onNodeDown(e, node)}
                    onPointerEnter={() => setHoverNodeId(node.id)}
                    onPointerLeave={() => setHoverNodeId((h) => (h === node.id ? null : h))}
                  >
                    <div className="il-nhead">
                      <span className="ndot" style={{ '--nc': stColor } as CSSProperties} />
                      <span className="trunc mono" style={{ flex: 1 }}>
                        {node.file}
                      </span>
                      {node.questId ? (
                        <button
                          type="button"
                          className="chip"
                          style={{ cursor: 'pointer' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(node.questId!);
                          }}
                        >
                          {node.questId}
                        </button>
                      ) : null}
                    </div>

                    <div className="il-nmeta">
                      <span className="trunc muted">{node.title}</span>
                      <span className="layer-pill">{node.layer}</span>
                    </div>

                    <div className="il-nbody">
                      {}
                      <div className="il-col-in">
                        {node.inputs.length ? (
                          node.inputs.map((inp, ii) => {
                            const st = inp.contractStatus;
                            const pinVar =
                              st === 'missing'
                                ? 'var(--c-rsat-wire-broken)'
                                : st === 'matched'
                                  ? 'var(--c-rsat-done)'
                                  : st === 'undeclared'
                                    ? 'var(--c-rsat-wire-cross)'
                                    : inp.kind === 'type'
                                      ? WIRE_VAR.type
                                      : inp.kind === 'hook'
                                        ? WIRE_VAR.active
                                        : WIRE_VAR.data;
                            const prefix =
                              st === 'matched' ? '✓ ' : st === 'missing' ? '✗ ' : st === 'undeclared' ? '? ' : '';
                            return (
                              <div key={`${inp.id}-${ii}`} className="il-sock">
                                <span
                                  className="il-pin"
                                  style={{ '--pc': pinVar } as CSSProperties}
                                />
                                <span className="trunc">{prefix}{inp.label}</span>
                              </div>
                            );
                          })
                        ) : (
                          <span className="faint mono" style={{ fontSize: 9.5, paddingLeft: 8 }}>
                            (root entry)
                          </span>
                        )}
                      </div>

                      {}
                      <div className="il-col-out">
                        {node.outputs.map((out, oi) => {
                          const st = out.contractStatus;
                          const pinVar =
                            st === 'missing'
                              ? 'var(--c-rsat-wire-broken)'
                              : st === 'matched'
                                ? 'var(--c-rsat-done)'
                                : st === 'undeclared'
                                  ? 'var(--c-rsat-wire-cross)'
                                  : out.kind === 'type'
                                    ? WIRE_VAR.type
                                    : out.kind === 'hook'
                                      ? WIRE_VAR.active
                                      : out.kind === 'store'
                                        ? WIRE_VAR.cross
                                        : WIRE_VAR.data;
                          const suffix =
                            st === 'matched' ? ' ✓' : st === 'missing' ? ' ✗' : st === 'undeclared' ? ' ?' : '';
                          return (
                            <div key={`${out.id}-${oi}`} className="il-sock">
                              <span className="trunc">{out.label}{suffix}</span>
                              <span
                                className="il-pin"
                                style={{ '--pc': pinVar } as CSSProperties}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="il-nfoot">
                      <span>
                        by <b style={{ color: 'rgb(var(--c-ink))' }}>{node.holder ?? 'unassigned'}</b>
                      </span>
                      <span className="mono">
                        in:{node.fanIn} · out:{node.fanOut}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {}
            <div
              className="il-hud-ctl"
              style={{ position: 'absolute', left: '50%', bottom: 12, transform: 'translateX(-50%)', display: 'flex', gap: 6, zIndex: 5 }}
            >
              <button
                type="button"
                className="btn sm"
                aria-label="Zoom out"
                onClick={() => {
                  const c = camRef.current;
                  camRef.current = { ...c, z: Math.max(0.42, +(c.z - 0.12).toFixed(2)) };
                  applyCam();
                }}
              >
                <Ic name="minus" sm />
              </button>
              <button
                type="button"
                ref={zoomLabelRef}
                className="btn sm mono"
                onClick={() => {
                  camRef.current = { x: 18, y: 14, z: 0.78 };
                  applyCam();
                }}
              >
                78%
              </button>
              <button
                type="button"
                className="btn sm"
                aria-label="Zoom in"
                onClick={() => {
                  const c = camRef.current;
                  camRef.current = { ...c, z: Math.min(1.65, +(c.z + 0.12).toFixed(2)) };
                  applyCam();
                }}
              >
                <Ic name="plus" sm />
              </button>
              <button
                type="button"
                className="btn sm"
                aria-label={t('ilResetPos')}
                onClick={() => setPositions({})}
              >
                <Ic name="fit" sm /> {t('ilReset')}
              </button>
            </div>

            {}
            <div className="il-legend-ctl">
              {showLegend ? (
                <div className="pn in il-legend-pop">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="eyebrow">{t('ilLegendTitle')}</span>
                    <button
                      type="button"
                      className="btn sm ghost"
                      style={{ height: 20 }}
                      aria-label={t('ilHide')}
                      onClick={() => setShowLegend(false)}
                    >
                      <Ic name="x" sm />
                    </button>
                  </div>
                  <span className="il-leg-i">
                    <i className="il-sw" style={{ '--wc': WIRE_VAR.data } as CSSProperties} /> {t('ilRuntime')}
                  </span>
                  <span className="il-leg-i">
                    <i className="il-sw" style={{ '--wc': WIRE_VAR.type } as CSSProperties} /> {t('ilType')}
                  </span>
                  <span className="il-leg-i">
                    <i className="il-sw" style={{ '--wc': WIRE_VAR.active } as CSSProperties} /> {t('ilActive')}
                  </span>
                  <span className="il-leg-i">
                    <i className="il-sw" style={{ '--wc': WIRE_VAR.cross } as CSSProperties} /> {t('ilCross')}
                  </span>
                  <span className="il-leg-i">
                    <i className="il-sw" style={{ '--wc': WIRE_VAR.broken } as CSSProperties} /> {t('ilBroken')}
                  </span>
                  <div className="col muted" style={{ fontSize: 11, gap: 3, borderTop: '1px solid rgb(var(--c-rsat-lo)/.4)', paddingTop: 6 }}>
                    <span>{t('ilCtl1')}</span>
                    <span>{t('ilCtl2')}</span>
                  </div>
                </div>
              ) : null}
              <button
                type="button"
                className="btn sm"
                aria-pressed={showLegend}
                onClick={() => setShowLegend((v) => !v)}
              >
                <Ic name="spark" sm /> {t('ilLegend')}
              </button>
            </div>
          </div>

          {}
          <aside className="pn il-side">
            <button
              type="button"
              className="btn sm ghost il-side-x"
              aria-label="Hide inspector"
              onClick={() => setShowInspect(false)}
            >
              <Ic name="x" sm />
            </button>
            {selWire ? (
              <>
                <div className="eyebrow">{t('ilWireInsp')}</div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b>{selWire.symbols.join(', ')}</b>
                  <span className="chip">{selWire.kind.toUpperCase()}</span>
                </div>
                <div className="pn in" style={{ padding: 10, fontSize: 12 }}>
                  <div>
                    <span className="muted">{t('ilSource')}</span>
                    <b className="mono">{nodes.find((n) => n.id === selWire.fromNode)?.file}</b>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <span className="muted">{t('ilTarget')}</span>
                    <b className="mono">{nodes.find((n) => n.id === selWire.toNode)?.file}</b>
                  </div>
                  {selWire.note ? (
                    <div style={{ marginTop: 8, color: 'rgb(var(--c-accent))' }}>{selWire.note}</div>
                  ) : null}
                </div>
              </>
            ) : selNode ? (
              <>
                <div className="eyebrow">{t('ilNodeInsp')}</div>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <b className="mono" style={{ fontSize: 13 }}>
                      {selNode.file}
                    </b>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {selNode.title}
                    </div>
                  </div>
                  <span className="layer-pill">{selNode.layer}</span>
                </div>

                {selNode.violation ? (
                  <div className="note" style={{ borderColor: 'rgb(var(--c-danger))', color: 'rgb(var(--c-danger))' }}>
                    <Ic name="shield" sm />
                    <span>{selNode.violation}</span>
                  </div>
                ) : null}

                <div className="pn in" style={{ padding: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <div className="eyebrow">MODULE</div>
                    <b>{selNode.moduleId}</b>
                  </div>
                  <div>
                    <div className="eyebrow">QUEST OWNER</div>
                    {selNode.questId ? (
                      <button
                        type="button"
                        className="chip"
                        onClick={() => onOpen(selNode.questId!)}
                      >
                        {selNode.questId} · {selNode.holder}
                      </button>
                    ) : (
                      <span className="muted">{t('ilUnassigned')}</span>
                    )}
                  </div>
                  <div>
                    <div className="eyebrow">{t('ilBlast')}</div>
                    <b>{selNode.fanIn} {t('ilDeps')}</b>
                  </div>
                  <div>
                    <div className="eyebrow">{t('ilInstab')}</div>
                    <b className="mono">
                      {selNode.fanIn + selNode.fanOut === 0
                        ? '0.00'
                        : (selNode.fanOut / (selNode.fanIn + selNode.fanOut)).toFixed(2)}
                    </b>
                  </div>
                </div>

                <div className="eyebrow">{t('contracts')} (PROVIDES / CONSUMES)</div>
                {selNode.contractCheck &&
                (selNode.contractCheck.declaredProvides.length > 0 ||
                  selNode.contractCheck.declaredConsumes.length > 0) ? (
                  <div className="pn in" style={{ padding: '6px 8px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <span className="pill st-done">
                      ✓ Matched: {selNode.contractCheck.matchedProvides.length}
                    </span>
                    {selNode.contractCheck.missingProvides.length > 0 ? (
                      <span className="pill st-danger">
                        ✗ Missing: {selNode.contractCheck.missingProvides.length}
                      </span>
                    ) : null}
                    {selNode.contractCheck.undeclaredExports.length > 0 ? (
                      <span className="pill st-warn">
                        ? Undeclared: {selNode.contractCheck.undeclaredExports.length}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <div className="col" style={{ gap: 6 }}>
                  {selNode.outputs.map((o, oi) => {
                    const st = o.contractStatus;
                    const badgeCls =
                      st === 'matched'
                        ? 'pill st-done'
                        : st === 'missing'
                          ? 'pill st-danger'
                          : st === 'undeclared'
                            ? 'pill st-warn'
                            : 'chip';
                    const badgeText =
                      st === 'matched'
                        ? 'OUT · ✓ MATCHED'
                        : st === 'missing'
                          ? 'OUT · ✗ MISSING'
                          : st === 'undeclared'
                            ? 'OUT · ? UNDECLARED'
                            : 'OUT';
                    return (
                      <div key={`${o.id}-${oi}`} className="qrow pn in" style={{ padding: '6px 8px' }}>
                        <span className={badgeCls}>{badgeText}</span>
                        <b className="mono" style={{ fontSize: 11.5, flex: 1 }}>
                          {o.label}
                        </b>
                        <span className="muted" style={{ fontSize: 11 }}>
                          {o.kind}
                        </span>
                      </div>
                    );
                  })}
                  {selNode.inputs.map((i, ii) => {
                    const st = i.contractStatus;
                    const badgeCls =
                      st === 'matched'
                        ? 'pill st-done'
                        : st === 'missing'
                          ? 'pill st-danger'
                          : st === 'undeclared'
                            ? 'pill st-warn'
                            : 'chip';
                    const badgeText =
                      st === 'matched'
                        ? 'IN · ✓ MATCHED'
                        : st === 'missing'
                          ? 'IN · ✗ MISSING'
                          : st === 'undeclared'
                            ? 'IN · ? UNDECLARED'
                            : 'IN';
                    return (
                      <div key={`${i.id}-${ii}`} className="qrow pn in" style={{ padding: '6px 8px' }}>
                        <span className={badgeCls}>{badgeText}</span>
                        <span className="mono" style={{ fontSize: 11.5, flex: 1 }}>
                          {i.label}
                        </span>
                        <span className="muted" style={{ fontSize: 11 }}>
                          {i.kind}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="muted" style={{ fontSize: 12.5 }}>
                {t('ilHintInspect')}
              </div>
            )}

            <div className="eyebrow" style={{ marginTop: 6 }}>
              LIVE AGENT @RSLK SNIPPET
            </div>
            <pre
              className="il-dsl"
              style={{ maxHeight: 'min(56vh, 560px)', fontSize: 10, whiteSpace: 'pre', flex: '1 1 auto', minHeight: 140 }}
            >
              {rslkText}
            </pre>
            <button type="button" className="btn sm" onClick={() => setMode('rslk')}>
              <Ic name="code" sm /> {t('ilOpenRslk')}
            </button>
          </aside>
        </div>
      )}
    </div>
  );
}
