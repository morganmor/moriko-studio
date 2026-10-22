/**
 * Moco Canvas — Studio Panel (P1).
 * Live engine view: the scene comes from the op engine (RPC), every gesture is
 * an op, and the readout is the same one the agent reads.
 */
import { useState } from 'react';

import type { CanvasOp } from './ops.ts';
import { navigate } from '@moriko/host';
import { findParent, parseAt, formatAt, rectWidth, rectHeight, type SceneNode } from './scene.ts';
import type { Readout } from './readout.ts';
import { MCV_CSS } from './styles.ts';
import { useCanvasDoc, type FlatNode, type DocSummary, type TemplateSummary, type LogLine } from './doc.ts';
import type { Viewport } from './scene.ts';

export default function Canvas() {
  const {
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
    rev,
    runOp,
    undo,
    redo,
    canUndo,
    canRedo,
    createDoc,
    openDoc,
    busy,
    notice,
    engineError,
    frameRef,
    liveDragInfo,
  } = useCanvasDoc();

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isRailOpen, setIsRailOpen] = useState(true);
  const [showNew, setShowNew] = useState(false);

  if (!scene || !compiled || !readout) {
    return (
      <div className="mcv mcv-boot">
        <style dangerouslySetInnerHTML={{ __html: MCV_CSS }} />
        <div className="mcv-boot-card">
          <h1 className="mcv-title">Moco Canvas</h1>
          {engineError ? (
            <>
              <p className="mcv-notice" data-kind="error">Engine not responding: {engineError}</p>
              <p className="mcv-empty">
                This panel needs the <code>state</code> RPC from the addon server. Reload the addon in the Addon Hub
                (Disable → Enable) or restart the server, then reopen the panel.
              </p>
            </>
          ) : (
            <p className="mcv-empty">{busy ? 'Loading documents…' : 'No documents in this workspace yet.'}</p>
          )}
          {!busy && (
            <div className="mcv-insp-row">
              {(templates.length ? templates : FALLBACK_TEMPLATES).slice(0, 4).map((t) => (
                <button key={t.id} className="mcv-btn" onClick={() => void createDoc(t.id, 'landing')} disabled={Boolean(engineError)}>
                  {t.name}
                </button>
              ))}
            </div>
          )}
          {notice && <p className="mcv-notice" data-kind={notice.kind}>{notice.text}</p>}
        </div>
      </div>
    );
  }

  const critical = readout.lint.filter((l) => l.severity === 'critical').length;

  return (
    <div className="mcv">
      <style dangerouslySetInnerHTML={{ __html: MCV_CSS }} />

      {/* 1. Studio Top Bar */}
      <header className="mcv-topbar">
        <div className="mcv-brand">
          <button type="button" className="mcv-btn" onClick={() => navigate('playground')} aria-label="Back to chat">
            ← Back
          </button>
          <h1 className="mcv-title">Moco Canvas</h1>
          <span className="mcv-chip">
            {scene.id} · dna <b>{scene.dna}</b> · rev <b>{rev}</b>
          </span>
        </div>

        <div className="mcv-toolbar-group">
          <DocPicker docs={docs} docId={docId} onPick={(id) => void openDoc(id)} />
          <button className="mcv-btn" data-active={showNew ? '1' : '0'} onClick={() => setShowNew(!showNew)}>
            New
          </button>
          {(['sm', 'md', 'lg'] as Viewport[]).map((vp) => (
            <button key={vp} className="mcv-seg" data-on={viewport === vp ? '1' : '0'} onClick={() => setViewport(vp)}>
              {vp} · {scene.breakpoints[vp]}
            </button>
          ))}
          <button className="mcv-btn" data-active={showGrid ? '1' : '0'} onClick={() => setShowGrid(!showGrid)}>
            Grid
          </button>
        </div>

        <div className="mcv-toolbar-group">
          <button className="mcv-btn" onClick={() => void undo()} disabled={!canUndo || busy}>
            Undo
          </button>
          <button className="mcv-btn" onClick={() => void redo()} disabled={!canRedo || busy}>
            Redo
          </button>
          <button className="mcv-btn" data-active={isDrawerOpen ? '1' : '0'} onClick={() => setIsDrawerOpen(!isDrawerOpen)}>
            Readout {critical > 0 ? `(${critical} crit)` : readout.lint.length > 0 ? `(${readout.lint.length})` : '✓'}
          </button>
          <button className="mcv-btn" data-active={isRailOpen ? '1' : '0'} onClick={() => setIsRailOpen(!isRailOpen)}>
            Inspector
          </button>
        </div>
      </header>

      {showNew && (
        <div className="mcv-newbar">
          <span className="mcv-insp-label">Template</span>
          {(templates.length ? templates : FALLBACK_TEMPLATES).map((t) => (
            <button key={t.id} className="mcv-btn" onClick={() => { setShowNew(false); void createDoc(t.id, docId ?? 'landing'); }}>
              {t.name}
            </button>
          ))}
          <span className="mcv-newbar-hint">Overwrites the active document from a template (the log keeps the full history).</span>
        </div>
      )}

      {/* 2. Main Studio Workspace */}
      <div className="mcv-workspace">
        <div className="mcv-canvas-area">
          <div className="mcv-stage-viewport">
            <div className="mcv-artboard" data-vp={viewport}>
              <iframe
                ref={frameRef}
                key={viewport}
                aria-label="Moco Canvas preview"
                sandbox="allow-scripts allow-same-origin"
                srcDoc={compiled.html}
              />
            </div>

            <div className="mcv-hud">
              {liveDragInfo ? (
                <>
                  <span className="mcv-hud-badge">DRAG</span>
                  <span>{liveDragInfo}</span>
                </>
              ) : selectedNode ? (
                <>
                  <span className="mcv-hud-badge">{selectedNode.id}</span>
                  <span className="mcv-hud-info">
                    {selectedNode.at ? `grid ${selectedNode.at}` : selectedNode.kind === 'frame' ? (selectedNode.layout?.mode ?? 'frame') : 'in stack'}
                  </span>
                </>
              ) : (
                <span className="mcv-hud-info">Click an element to select, drag to move, pull handles to change span</span>
              )}
            </div>

            {notice && (
              <div className="mcv-toast" data-kind={notice.kind} role="status">
                {notice.text}
              </div>
            )}
          </div>

          <div className="mcv-drawer" data-open={isDrawerOpen ? '1' : '0'}>
            <div className="mcv-drawer-bar" onClick={() => setIsDrawerOpen(!isDrawerOpen)}>
              <span>
                <b>Spatial Readout</b> · {readout.header}
              </span>
              <span>{isDrawerOpen ? '▼ Hide' : '▲ Open char-map & lint'}</span>
            </div>
            {isDrawerOpen && (
              <div className="mcv-drawer-content">
                <pre className="mcv-drawer-map">{readout.charmap}</pre>
                <div className="mcv-drawer-side">
                  <div>
                    <h2 className="mcv-h">
                      <span>Relational Facts</span>
                      <span>{readout.facts.length}</span>
                    </h2>
                    <ul className="mcv-facts">
                      {readout.facts.map((fact, i) => (
                        <li key={i}>{fact}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h2 className="mcv-h">
                      <span>Lint 2D (intent)</span>
                      <span>{readout.lint.length}</span>
                    </h2>
                    <div className="mcv-lint">
                      {readout.lint.length === 0 ? (
                        <p className="mcv-empty">No intent-geometry violations.</p>
                      ) : (
                        readout.lint.map((l, i) => (
                          <div className="mcv-lint-row" key={`${l.rule}-${i}`}>
                            <span className="mcv-sev" data-s={l.severity}>
                              {l.severity}
                            </span>
                            <span>
                              <b>{l.rule}</b> {l.detail}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="mcv-rail" data-open={isRailOpen ? '1' : '0'}>
          {selectedNode && <NodeInspector node={selectedNode} root={scene.root} onRunOp={runOp} onSelect={setSelected} />}
          <NodeTree flat={flat} selected={selected} onSelect={setSelected} />
          <OpLogPanel log={log} />
        </aside>
      </div>
    </div>
  );
}

const FALLBACK_TEMPLATES: TemplateSummary[] = [
  { id: 'split-diptych', name: 'Split Diptych', hint: '' },
  { id: 'spec-sheet', name: 'Spec Sheet', hint: '' },
  { id: 'stack-list', name: 'Stack List', hint: '' },
  { id: 'blank', name: 'Blank grid', hint: '' },
];

function DocPicker({ docs, docId, onPick }: { docs: DocSummary[]; docId: string | null; onPick: (id: string) => void }) {
  if (docs.length <= 1) {
    return <span className="mcv-chip">{docId ?? '—'}</span>;
  }
  return (
    <select className="mcv-select" value={docId ?? ''} onChange={(e) => onPick(e.target.value)} aria-label="Document">
      {docs.map((d) => (
        <option key={d.id} value={d.id}>
          {d.id} · rev {d.rev}
        </option>
      ))}
    </select>
  );
}

function NodeInspector({
  node,
  root,
  onRunOp,
  onSelect,
}: {
  node: SceneNode;
  root: SceneNode;
  onRunOp: (op: CanvasOp) => void;
  onSelect: (id: string) => void;
}) {
  const rect = parseAt(node.at);
  const parent = findParent(root, node.id);
  const isStackChild = parent?.layout?.mode === 'stack';

  const moveTo = (c1: number, r1: number) => {
    if (!rect) return;
    onRunOp({ op: 'move', id: node.id, at: formatAt({ c1, r1, c2: c1 + rectWidth(rect) - 1, r2: r1 + rectHeight(rect) - 1 }) });
  };
  const resizeBy = (dw: number, dh: number) => {
    if (!rect) return;
    onRunOp({ op: 'resize', id: node.id, w: Math.max(1, rectWidth(rect) + dw), h: Math.max(1, rectHeight(rect) + dh) });
  };
  const reorder = (dir: 'up' | 'down') => {
    if (!parent?.children) return;
    const cur = parent.children.findIndex((c) => c.id === node.id);
    if (cur < 0) return;
    onRunOp({ op: 'reorder', id: node.id, index: dir === 'up' ? cur - 1 : cur + 1 });
  };
  const locked = node.style?.locked === true;
  const toggleLock = () => onRunOp({ op: locked ? 'unlock' : 'lock', id: node.id });

  return (
    <section className="mcv-insp">
      <div className="mcv-insp-head">
        <span className="mcv-insp-id">{node.id}{locked ? ' 🔒' : ''}</span>
        <span className="mcv-insp-row">
          <span className="mcv-insp-at">{node.at ?? (isStackChild ? 'in stack' : (node.layout?.mode ?? 'node'))}</span>
          <button className="mcv-btn" data-active={locked ? '1' : '0'} onClick={toggleLock}>
            {locked ? 'Unlock' : 'Lock'}
          </button>
        </span>
      </div>
      {locked && (
        <p className="mcv-insp-label">Locked — the agent cannot move, restyle, or delete this node until you unlock it.</p>
      )}

      {rect ? (
        <>
          <div>
            <div className="mcv-insp-label">Grid position</div>
            <div className="mcv-insp-row">
              <button className="mcv-btn" onClick={() => moveTo(rect.c1 - 1, rect.r1)}>← col</button>
              <button className="mcv-btn" onClick={() => moveTo(rect.c1 + 1, rect.r1)}>col →</button>
              <button className="mcv-btn" onClick={() => moveTo(rect.c1, rect.r1 - 1)}>↑ row</button>
              <button className="mcv-btn" onClick={() => moveTo(rect.c1, rect.r1 + 1)}>row ↓</button>
            </div>
          </div>
          <div>
            <div className="mcv-insp-label">Span ({rectWidth(rect)}×{rectHeight(rect)} cells)</div>
            <div className="mcv-insp-row">
              <button className="mcv-btn" onClick={() => resizeBy(-1, 0)}>−col</button>
              <button className="mcv-btn" onClick={() => resizeBy(1, 0)}>+col</button>
              <button className="mcv-btn" onClick={() => resizeBy(0, -1)}>−row</button>
              <button className="mcv-btn" onClick={() => resizeBy(0, 1)}>+row</button>
            </div>
          </div>
        </>
      ) : isStackChild ? (
        <div>
          <div className="mcv-insp-label">Stack order in {parent?.id}</div>
          <div className="mcv-insp-row">
            <button className="mcv-btn" onClick={() => reorder('up')}>↑ up</button>
            <button className="mcv-btn" onClick={() => reorder('down')}>↓ down</button>
            {parent && <button className="mcv-btn" onClick={() => onSelect(parent.id)}>parent ({parent.id})</button>}
          </div>
        </div>
      ) : null}

      {node.kind === 'text' && (
        <div>
          <div className="mcv-insp-label">Typography</div>
          <div className="mcv-insp-row">
            {(['display', 'heading', 'body', 'caption', 'mono'] as const).map((role) => (
              <button key={role} className="mcv-btn" data-active={node.role === role ? '1' : '0'} onClick={() => onRunOp({ op: 'style', id: node.id, role })}>
                {role}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function NodeTree({ flat, selected, onSelect }: { flat: FlatNode[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <section>
      <h2 className="mcv-h">
        <span>Nodes</span>
        <span>{flat.length}</span>
      </h2>
      <ul className="mcv-tree">
        {flat.map(({ node, depth }) => (
          <li
            key={node.id}
            data-sel={selected === node.id ? '1' : '0'}
            onClick={() => onSelect(node.id)}
            style={{ paddingLeft: `${4 + depth * 12}px` }}
          >
            <span className="id">
              {node.id} <span className="kind">{node.kind}</span>
            </span>
            <span className="at">{node.at ?? (node.layout?.mode ?? '')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function OpLogPanel({ log }: { log: LogLine[] }) {
  return (
    <section>
      <h2 className="mcv-h">
        <span>Op Log</span>
        <span>{log.length}</span>
      </h2>
      {log.length === 0 ? (
        <p className="mcv-empty">No ops yet — drag a node in the preview or use the inspector controls.</p>
      ) : (
        <ul className="mcv-log">
          {[...log].reverse().map((entry) => (
            <li key={`${entry.rev}-${entry.at}-${entry.kind}`} data-rev={`${entry.rev}.`} data-actor={entry.actor} data-rejected={entry.kind === 'ops' && !entry.note ? '1' : '0'}>
              <span className="mcv-log-kind">{entry.kind}</span> {entry.note ?? ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
