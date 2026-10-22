/**
 * Moco Canvas — document store (P1).
 *
 *   .moriko/moco-canvas/<doc>.scene.json   the scene (single source of truth)
 *   .moriko/moco-canvas/<doc>.ops.jsonl    append-only op log (undo/redo)
 *
 * Writes go through the harness workspace handle, so vault snapshots and the
 * read-policy ledger ride along (plan §19.4 point 3). One write QUEUE per
 * document serialises concurrent writers — the log is single-writer by design
 * (plan §19.3 point 5).
 */

import path from 'node:path';

import { applyBatch, type BatchOutcome, type CanvasOp } from '../client/ops.ts';
import { buildScene, DEFAULT_TEMPLATE } from '../client/templates.ts';
import { cloneScene, type Scene } from '../client/scene.ts';

export const DIR = '.moriko/moco-canvas';

export interface WorkspaceHandle {
  root(): string | null;
  read(filePath: string): string;
  write(filePath: string, content: string): Promise<void>;
  list(dir: string): string[];
  exists(filePath: string): boolean;
}

export type LogKind = 'new' | 'ops' | 'undo' | 'redo';

export interface LogEntry {
  rev: number;
  at: string;
  actor: 'agent' | 'user';
  kind: LogKind;
  /** mutation batch (kind: 'ops') */
  ops?: CanvasOp[];
  /** document seed (kind: 'new') */
  template?: string;
  dna?: string;
  note?: string;
}

export interface DocInfo {
  id: string;
  rev: number;
  dna: string;
  template: string;
  ops: number;
  updatedAt: string;
}

export class DocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocError';
  }
}

/** Queue tail per `<root>/<doc>`. */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  queues.set(key, next.then(() => undefined, () => undefined));
  return next;
}

export function sanitizeDocId(raw: string): string {
  const id = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
  if (!id) throw new DocError('document name is empty — use letters/digits, e.g. "landing".');
  if (id.length > 48) throw new DocError('document name is limited to 48 characters.');
  return id;
}

export function scenePath(doc: string): string {
  return path.posix.join(DIR, `${doc}.scene.json`);
}

export function logPath(doc: string): string {
  return path.posix.join(DIR, `${doc}.ops.jsonl`);
}

export function resolveWorkspace(api: any, sessionId?: string): WorkspaceHandle {
  const forSession = api?.workspace?.forSession?.(sessionId);
  if (forSession?.root?.()) return forSession as WorkspaceHandle;
  const global = api?.workspace;
  if (global?.root?.()) return global as WorkspaceHandle;
  throw new DocError('no active workspace — open a workspace in Moriko and try again.');
}

export function listDocs(ws: WorkspaceHandle): DocInfo[] {
  let files: string[] = [];
  try {
    files = ws.list(DIR);
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith('.scene.json'))
    .map((file) => {
      const id = file.replace(/\.scene\.json$/, '');
      const scene = readScene(ws, id);
      const ops = readLog(ws, id).length;
      return {
        id,
        rev: scene?.rev ?? 0,
        dna: scene?.dna ?? '—',
        template: scene?.template ?? '—',
        ops,
        updatedAt: readUpdatedAt(ws, id),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function readUpdatedAt(ws: WorkspaceHandle, doc: string): string {
  const entries = readLog(ws, doc);
  return entries.length ? entries[entries.length - 1].at : '';
}

export function readScene(ws: WorkspaceHandle, doc: string): Scene | null {
  const raw = ws.read(scenePath(doc));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Scene;
    if (!parsed || parsed.version !== 1 || !parsed.root) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readLog(ws: WorkspaceHandle, doc: string): LogEntry[] {
  const raw = ws.read(logPath(doc));
  if (!raw) return [];
  const out: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as LogEntry);
    } catch {
      // A torn line (crash mid-write) is skipped, not fatal: the scene file
      // remains the authority for the current revision.
    }
  }
  return out;
}

/** Serialise the log; the caller owns truncation semantics. */
function writeLog(ws: WorkspaceHandle, doc: string, entries: LogEntry[]): Promise<void> {
  const body = entries.map((e) => JSON.stringify(e)).join('\n');
  return ws.write(logPath(doc), body ? `${body}\n` : '');
}

export interface ReplayResult {
  scene: Scene;
  /** scenes popped by undo — redo can push them back */
  redo: Scene[];
  /** entries that failed to apply (kept for honesty, not silently dropped) */
  skipped: string[];
}

/**
 * Rebuild a document from its log. Deterministic: ops are pure, so the same
 * log always yields the same scene — that is what makes undo/redo file-backed.
 */
export function replay(entries: LogEntry[], fallbackDoc: string): ReplayResult {
  let scene: Scene | null = null;
  const undoStack: Scene[] = [];
  const redoStack: Scene[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (entry.kind === 'new') {
      scene = buildScene(fallbackDoc, entry.template ?? DEFAULT_TEMPLATE, entry.dna ?? 'editorial');
      undoStack.length = 0;
      redoStack.length = 0;
      continue;
    }
    if (!scene) continue;
    if (entry.kind === 'ops') {
      // Replay honours the original actor: user batches bypassed the lock
      // guard when committed, so they must bypass it here too (P3 co-edit).
      const outcome = applyBatch(scene, entry.ops ?? [], entry.actor === 'user');
      if (outcome.ok) {
        undoStack.push(scene);
        redoStack.length = 0;
        scene = outcome.scene;
      } else {
        skipped.push(`rev ${entry.rev}: ${outcome.rejected?.note ?? 'batch rejected'}`);
      }
      continue;
    }
    if (entry.kind === 'undo') {
      const prev = undoStack.pop();
      if (prev) {
        redoStack.push(scene);
        scene = prev;
      }
      continue;
    }
    if (entry.kind === 'redo') {
      const next = redoStack.pop();
      if (next) {
        undoStack.push(scene);
        scene = next;
      }
    }
  }

  const final = scene ?? buildScene(fallbackDoc, DEFAULT_TEMPLATE, 'editorial');
  return { scene: final, redo: redoStack, skipped };
}

export interface CommitResult {
  scene: Scene;
  outcome: BatchOutcome;
  entry: LogEntry;
}

/** Apply a mutation batch and persist scene + log atomically (per document). */
export async function commitBatch(
  ws: WorkspaceHandle,
  doc: string,
  ops: CanvasOp[],
  actor: 'agent' | 'user',
): Promise<CommitResult> {
  const key = `${ws.root() ?? '?'}::${doc}`;
  return enqueue(key, async () => {
    const entries = readLog(ws, doc);
    const current = readScene(ws, doc) ?? replay(entries, doc).scene;
    // P3 co-edit: only user-driven batches bypass the lock guard.
    const outcome = applyBatch(current, ops, actor === 'user');
    if (!outcome.ok) {
      return {
        scene: current,
        outcome,
        entry: { rev: current.rev, at: new Date().toISOString(), actor, kind: 'ops', ops, note: outcome.rejected?.note },
      };
    }
    const entry: LogEntry = {
      rev: outcome.scene.rev,
      at: new Date().toISOString(),
      actor,
      kind: 'ops',
      ops,
      note: outcome.notes.join(' · ').slice(0, 400),
    };
    await ws.write(scenePath(doc), JSON.stringify(outcome.scene, null, 2));
    await writeLog(ws, doc, [...entries, entry]);
    return { scene: outcome.scene, outcome, entry };
  });
}

/** Undo/redo are log entries too, so they survive a restart. */
export async function commitHistory(
  ws: WorkspaceHandle,
  doc: string,
  kind: 'undo' | 'redo',
  actor: 'agent' | 'user',
): Promise<{ ok: boolean; scene: Scene; note: string }> {
  const key = `${ws.root() ?? '?'}::${doc}`;
  return enqueue(key, async () => {
    const entries = readLog(ws, doc);
    if (entries.length === 0) return { ok: false, scene: replay(entries, doc).scene, note: 'log is empty — nothing to undo.' };
    const before = replay(entries, doc).scene;
    const entry: LogEntry = { rev: before.rev, at: new Date().toISOString(), actor, kind };
    const next = replay([...entries, entry], doc);
    if (kind === 'undo' && next.scene.rev === before.rev && next.scene.root === before.root) {
      return { ok: false, scene: before, note: 'nothing to undo (undo/redo are already balanced).' };
    }
    await ws.write(scenePath(doc), JSON.stringify(next.scene, null, 2));
    await writeLog(ws, doc, [...entries, entry]);
    return { ok: true, scene: next.scene, note: `${kind} → rev ${next.scene.rev}` };
  });
}

/** Create (or reset) a document from a template. */
export async function commitNew(
  ws: WorkspaceHandle,
  doc: string,
  template: string,
  dna: string,
  actor: 'agent' | 'user',
): Promise<{ scene: Scene; entry: LogEntry }> {
  const key = `${ws.root() ?? '?'}::${doc}`;
  return enqueue(key, async () => {
    const entries = readLog(ws, doc);
    const scene = buildScene(doc, template, dna);
    const entry: LogEntry = { rev: scene.rev, at: new Date().toISOString(), actor, kind: 'new', template, dna };
    await ws.write(scenePath(doc), JSON.stringify(scene, null, 2));
    await writeLog(ws, doc, [...entries, entry]);
    return { scene, entry };
  });
}

export function snapshot(scene: Scene): Scene {
  return cloneScene(scene);
}
