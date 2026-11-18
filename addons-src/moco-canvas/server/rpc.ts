

import { applyBatch, type CanvasOp } from '../client/ops.ts';
import { buildDelta, buildReadout, inspectNode, outline } from '../client/readout.ts';
import { type Viewport } from '../client/scene.ts';
import { TEMPLATES } from '../client/templates.ts';
import {
  DocError,
  commitBatch,
  commitHistory,
  commitNew,
  listDocs,
  readLog,
  readScene,
  replay,
  resolveWorkspace,
  sanitizeDocId,
} from './store.ts';

export interface PanelState {
  docs: Array<{ id: string; rev: number; dna: string; template: string; ops: number; updatedAt: string }>;
  doc: string | null;
  scene: unknown;
  templates: Array<{ id: string; name: string; hint: string }>;
  log: Array<{ rev: number; at: string; actor: string; kind: string; note?: string }>;
}

function pickDocId(ws: ReturnType<typeof resolveWorkspace>, requested: unknown): string | null {
  if (typeof requested === 'string' && requested.trim()) return sanitizeDocId(requested);
  const docs = listDocs(ws);
  return docs.length ? docs[0].id : null;
}


export function rpcState(api: any, sessionId: string | undefined, body: Record<string, unknown>) {
  const ws = resolveWorkspace(api, sessionId);
  const docId = pickDocId(ws, body?.doc);
  const scene = docId ? readScene(ws, docId) ?? null : null;
  const entries = docId ? readLog(ws, docId) : [];
  const state: PanelState = {
    docs: listDocs(ws),
    doc: docId,
    scene: scene ?? null,
    templates: TEMPLATES.map(({ id, name, hint }) => ({ id, name, hint })),
    log: entries.slice(-40).map((e) => ({ rev: e.rev, at: e.at, actor: e.actor, kind: e.kind, note: e.note })),
  };
  return state;
}


export async function rpcApply(api: any, sessionId: string | undefined, body: Record<string, unknown>) {
  const ws = resolveWorkspace(api, sessionId);
  const docId = sanitizeDocId(String(body?.doc ?? ''));
  const ops = Array.isArray(body?.ops) ? (body.ops as CanvasOp[]) : [];
  if (ops.length === 0) throw new DocError('apply requires "ops".');
  const before = readScene(ws, docId) ?? replay(readLog(ws, docId), docId).scene;
  const committed = await commitBatch(ws, docId, ops, 'user');
  if (!committed.outcome.ok) {
    return { ok: false, error: committed.outcome.rejected?.note ?? 'batch rejected', scene: before };
  }
  void api?.bus?.publish?.('moco-canvas.commit', { doc: docId, rev: committed.scene.rev, actor: 'user', ops: ops.length });
  notifyAgentsOfUserEdit(api, docId, committed);
  const viewport = (typeof body?.viewport === 'string' ? body.viewport : 'lg') as Viewport;
  return {
    ok: true,
    scene: committed.scene,
    delta: buildDelta(
      { notes: committed.outcome.notes, changed: committed.outcome.changed, before, after: committed.scene },
      viewport,
    ),
    notes: committed.outcome.notes,
    lint: buildReadout(committed.scene, viewport).lint,
  };
}


function notifyAgentsOfUserEdit(api: any, docId: string, committed: { scene: { rev: number }; outcome: { notes: string[]; changed: string[] } }) {
  try {
    const inject = api?.sessions?.inject;
    if (typeof inject !== 'function') return;
    const what = committed.outcome.notes.join('; ').slice(0, 300);
    const nodes = committed.outcome.changed.slice(0, 8).join(', ');
    inject('all-active', {
      text: `Moco Canvas · USER edited "${docId}" (rev ${committed.scene.rev}): ${what || `touched ${nodes}`}. Read the canvas before your next op — user changes are authoritative.`,
      level: 'info',
      key: `moco-canvas:user-${docId}-${committed.scene.rev}`,
      ttlMs: 10 * 60_000,
    });
  } catch {
  }
}


export async function rpcHistory(api: any, sessionId: string | undefined, body: Record<string, unknown>) {
  const ws = resolveWorkspace(api, sessionId);
  const docId = sanitizeDocId(String(body?.doc ?? ''));
  const kind = body?.kind === 'redo' ? 'redo' : 'undo';
  const result = await commitHistory(ws, docId, kind, 'user');
  void api?.bus?.publish?.('moco-canvas.commit', { doc: docId, rev: result.scene.rev, actor: 'user', kind });
  return { ok: result.ok, scene: result.scene, note: result.note };
}


export async function rpcNew(api: any, sessionId: string | undefined, body: Record<string, unknown>) {
  const ws = resolveWorkspace(api, sessionId);
  const docId = sanitizeDocId(String(body?.doc ?? 'landing'));
  const template = typeof body?.template === 'string' ? body.template : 'split-diptych';
  const dna = typeof body?.dna === 'string' ? body.dna : 'editorial';
  const created = await commitNew(ws, docId, template, dna, 'user');
  void api?.bus?.publish?.('moco-canvas.commit', { doc: docId, rev: created.scene.rev, actor: 'user', kind: 'new' });
  return { ok: true, doc: docId, scene: created.scene };
}


export function rpcInspect(api: any, sessionId: string | undefined, body: Record<string, unknown>) {
  const ws = resolveWorkspace(api, sessionId);
  const docId = sanitizeDocId(String(body?.doc ?? ''));
  const scene = readScene(ws, docId) ?? replay(readLog(ws, docId), docId).scene;
  const focus = typeof body?.focus === 'string' ? body.focus : null;
  return {
    outline: outline(scene),
    detail: focus ? inspectNode(scene, focus) : null,
    readout: buildReadout(scene, (typeof body?.viewport === 'string' ? body.viewport : 'lg') as Viewport),
  };
}


export function rpcPreview(api: any, sessionId: string | undefined, body: Record<string, unknown>) {
  const ws = resolveWorkspace(api, sessionId);
  const docId = sanitizeDocId(String(body?.doc ?? ''));
  const scene = readScene(ws, docId) ?? replay(readLog(ws, docId), docId).scene;
  const ops = Array.isArray(body?.ops) ? (body.ops as CanvasOp[]) : [];
  const outcome = applyBatch(scene, ops);
  return { ok: outcome.ok, notes: outcome.notes, error: outcome.rejected?.note ?? null, scene: outcome.ok ? outcome.scene : scene };
}

export const rpcHandlers = {
  state: rpcState,
  apply: rpcApply,
  history: rpcHistory,
  new: rpcNew,
  inspect: rpcInspect,
  preview: rpcPreview,
};
