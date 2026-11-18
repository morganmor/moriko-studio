import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../atomicWrite.js';
import { readStateDir } from '../paths.js';



const STORE_DIR = readStateDir;

export interface ReadEntry {
  
  hash: string;
  
  mtime: number;
  
  gRev: number;
  
  fromLine: number;
  toLine: number;
  
  intervals?: LineInterval[];
  
  rev: number;
  
  lastOp: 'read' | 'write';
}

export interface LineInterval {
  from: number;
  to: number;
}


export function mergeLineIntervals(intervals: LineInterval[]): LineInterval[] {
  const valid = intervals.filter((iv) => Number.isFinite(iv.from) && Number.isFinite(iv.to) && iv.to >= iv.from);
  if (valid.length <= 1) return valid.map((i) => ({ ...i }));
  const sorted = [...valid].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: LineInterval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.from <= prev.to + 1) {
      prev.to = Math.max(prev.to, curr.to);
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}


export function isRangeCoveredByReadEntry(
  entry: { fromLine: number; toLine: number; intervals?: LineInterval[] } | undefined,
  targetFrom: number,
  targetTo: number = targetFrom,
): boolean {
  if (!entry) return false;
  if (entry.toLine >= Number.MAX_SAFE_INTEGER) return true;
  if (Array.isArray(entry.intervals) && entry.intervals.length > 0) {
    return entry.intervals.some((iv) => targetFrom >= iv.from && targetTo <= iv.to);
  }
  return targetFrom >= entry.fromLine && targetTo <= entry.toLine;
}


export function isInsertionPointCovered(
  entry: { fromLine: number; toLine: number; intervals?: LineInterval[] } | undefined,
  insertAt: number,
): boolean {
  if (!entry) return false;
  if (entry.toLine >= Number.MAX_SAFE_INTEGER) return true;
  if (Array.isArray(entry.intervals) && entry.intervals.length > 0) {
    return entry.intervals.some((iv) => insertAt >= iv.from && insertAt <= iv.to + 1);
  }
  return insertAt >= entry.fromLine && insertAt <= entry.toLine + 1;
}


export function shiftIntervalsForEdit(
  existing: LineInterval[] | undefined,
  fallbackFrom: number,
  fallbackTo: number,
  editStartLine: number,
  oldSpanLines: number,
  newSpanLines: number,
): LineInterval[] {
  const base: LineInterval[] =
    existing && existing.length > 0 ? existing.map((i) => ({ ...i })) : [{ from: fallbackFrom, to: fallbackTo }];
  const delta = newSpanLines - oldSpanLines;
  const editEndOld = editStartLine + Math.max(oldSpanLines, 1) - 1;
  const editEndNew = editStartLine + Math.max(newSpanLines, 1) - 1;

  const shifted: LineInterval[] = [];
  for (const iv of base) {
    if (iv.to >= Number.MAX_SAFE_INTEGER) {
      continue;
    }
    if (iv.to < editStartLine) {
      shifted.push({ ...iv });
    } else if (iv.from > editEndOld) {
      shifted.push({
        from: Math.max(1, iv.from + delta),
        to: Math.max(1, iv.to + delta),
      });
    } else {
      shifted.push({
        from: Math.min(iv.from, editStartLine),
        to: Math.max(editEndNew, iv.to + delta),
      });
    }
  }
  shifted.push({ from: editStartLine, to: Math.max(editStartLine, editEndNew) });
  return mergeLineIntervals(shifted);
}


export function formatReadIntervals(
  entry: { fromLine: number; toLine: number; intervals?: LineInterval[] },
): string {
  if (entry.toLine >= Number.MAX_SAFE_INTEGER) return 'all lines';
  if (Array.isArray(entry.intervals) && entry.intervals.length > 0) {
    return entry.intervals.map((iv) => `${iv.from}–${iv.to}`).join(', ');
  }
  return `${entry.fromLine}–${entry.toLine}`;
}


function parseIntervals(
  raw: unknown,
  fallbackFrom: number,
  fallbackTo: number,
): LineInterval[] {
  if (Array.isArray(raw)) {
    const parsed = raw
      .filter((iv): iv is Record<string, unknown> => !!iv && typeof iv === 'object')
      .map((iv) => ({
        from: typeof iv.from === 'number' && Number.isFinite(iv.from) ? Math.trunc(iv.from) : NaN,
        to: typeof iv.to === 'number' && Number.isFinite(iv.to) ? Math.trunc(iv.to) : NaN,
      }))
      .filter((iv) => iv.to >= iv.from && iv.from >= 1);
    if (parsed.length > 0) return mergeLineIntervals(parsed);
  }
  return [{ from: fallbackFrom, to: fallbackTo }];
}


const sessions = new Map<string, Map<string, ReadEntry>>();
const loaded = new Set<string>();

interface LedgerEntry {
  gRev: number;
  hash: string;
  mtime: number;
  
  session: string;
  at: number;
}

const LEDGER_FILE = path.join(STORE_DIR, 'fs-ledger.json');
let ledgerCache: Map<string, LedgerEntry> | null = null;

function loadLedger(): Map<string, LedgerEntry> {
  if (ledgerCache) return ledgerCache;
  const map = new Map<string, LedgerEntry>();
  try {
    if (existsSync(LEDGER_FILE)) {
      const parsed = JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          const rec = value as Record<string, unknown> | null;
          if (rec && typeof rec === 'object' && typeof rec.gRev === 'number') {
            map.set(key, {
              gRev: rec.gRev,
              hash: typeof rec.hash === 'string' ? rec.hash : '',
              mtime: typeof rec.mtime === 'number' ? rec.mtime : 0,
              session: typeof rec.session === 'string' ? rec.session : '',
              at: typeof rec.at === 'number' ? rec.at : 0,
            });
          }
        }
      }
    }
  } catch {
  }
  ledgerCache = map;
  return map;
}

function persistLedger(): void {
  try {
    atomicWriteJson(LEDGER_FILE, Object.fromEntries(loadLedger().entries()));
  } catch (error) {
    console.error('[read-policy] failed to persist fs-ledger:', error);
  }
}


export function ledgerRevOf(absolute: string): number {
  return loadLedger().get(absolute)?.gRev ?? 0;
}

const contextIds = new Map<string, string>();

function contextFile(session: string): string {
  return path.join(STORE_DIR, `${session}.ctx.json`);
}


export function syncSessionContext(session: string | undefined, contextId: string | undefined): boolean {
  if (!session || !contextId) return false;
  let current = contextIds.get(session);
  if (current === undefined) {
    current = '';
    try {
      if (existsSync(contextFile(session))) {
        const parsed = JSON.parse(readFileSync(contextFile(session), 'utf8')) as { id?: unknown } | null;
        if (parsed && typeof parsed.id === 'string') current = parsed.id;
      }
    } catch {
    }
    contextIds.set(session, current);
  }
  if (current === contextId) return false;
  sessions.delete(session);
  loaded.delete(session);
  try {
    atomicWriteJson(storePath(session), {});
  } catch {
  }
  try {
    atomicWriteJson(contextFile(session), { id: contextId });
  } catch {
  }
  contextIds.set(session, contextId);
  return true;
}

function storePath(session: string): string {
  return path.join(STORE_DIR, `${session}.json`);
}

function load(session: string): Map<string, ReadEntry> {
  if (sessions.has(session)) return sessions.get(session)!;
  const map = new Map<string, ReadEntry>();
  try {
    if (existsSync(storePath(session))) {
      const parsed = JSON.parse(readFileSync(storePath(session), 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (value && typeof value === 'object') {
            const entry = value as Record<string, unknown>;
            if (typeof entry.hash === 'string' && typeof entry.mtime === 'number') {
              const legacyFrom = typeof entry.fromLine === 'number' ? entry.fromLine : 1;
              const legacyTo = typeof entry.toLine === 'number' ? entry.toLine : Number.MAX_SAFE_INTEGER;
              map.set(key, {
                hash: entry.hash,
                mtime: entry.mtime,
                gRev: typeof entry.gRev === 'number' ? entry.gRev : 0,
                fromLine: legacyFrom,
                toLine: legacyTo,
                rev: typeof entry.rev === 'number' ? entry.rev : 1,
                lastOp: entry.lastOp === 'write' ? 'write' : 'read',
                intervals: parseIntervals(entry.intervals, legacyFrom, legacyTo),
              });
            }
          }
        }
      }
    }
  } catch {
  }
  loaded.add(session);
  sessions.set(session, map);
  return map;
}

function persist(session: string): void {
  try {
    const map = sessions.get(session);
    const payload = map ? Object.fromEntries(map.entries()) : {};
    atomicWriteJson(storePath(session), payload);
  } catch (error) {
    console.error('[read-policy] failed to persist read state:', error);
  }
}


export function recordRead(
  session: string | undefined,
  absolute: string,
  content: string,
  mtime: number,
  fromLine: number,
  toLine: number,
): ReadEntry | undefined {
  if (!session) return undefined;
  const map = load(session);
  const previous = map.get(absolute);
  const hash = createHash('sha256').update(content).digest('hex');

  let entry: ReadEntry;
  if (!previous || previous.hash !== hash) {
    entry = {
      hash,
      mtime,
      gRev: ledgerRevOf(absolute),
      fromLine,
      toLine,
      intervals: [{ from: fromLine, to: toLine }],
      rev: (previous?.rev ?? 0) + 1,
      lastOp: 'read',
    };
  } else if (previous.toLine >= Number.MAX_SAFE_INTEGER) {
    entry = {
      hash,
      mtime,
      gRev: ledgerRevOf(absolute),
      fromLine: previous.fromLine,
      toLine: previous.toLine,
      intervals: previous.intervals ?? [{ from: previous.fromLine, to: previous.toLine }],
      rev: previous.rev + 1,
      lastOp: 'read',
    };
  } else {
    const base: LineInterval[] =
      Array.isArray(previous.intervals) && previous.intervals.length > 0
        ? previous.intervals.map((i) => ({ ...i }))
        : [{ from: previous.fromLine, to: previous.toLine }];
    const intervals = mergeLineIntervals([...base, { from: fromLine, to: toLine }]);
    entry = {
      hash,
      mtime,
      gRev: ledgerRevOf(absolute),
      fromLine: intervals[0].from,
      toLine: intervals[intervals.length - 1].to,
      intervals,
      rev: previous.rev + 1,
      lastOp: 'read',
    };
  }
  map.set(absolute, entry);
  persist(session);
  return entry;
}


export function hasCurrentRead(
  session: string | undefined,
  absolute: string,
  currentContent: string,
  currentMtime: number,
): boolean {
  if (!session) return false;
  const map = load(session);
  const entry = map.get(absolute);
  if (!entry) return false;
  if (entry.gRev !== ledgerRevOf(absolute)) return false;
  if (entry.mtime !== currentMtime) return false;
  return entry.hash === createHash('sha256').update(currentContent).digest('hex');
}


export function recordAfterWrite(
  session: string | undefined,
  absolute: string,
  content: string,
  mtime: number,
  meta?: { op?: 'add' | 'modify' | 'delete' | 'rename' | 'copy'; tool?: string; from?: string },
  updatedIntervals?: LineInterval[],
): void {
  const ledger = loadLedger();
  const existedBefore = ledger.has(absolute) || existsSync(absolute);
  const op = meta?.op ?? (existedBefore ? 'modify' : 'add');
  ledger.set(absolute, {
    gRev: (ledger.get(absolute)?.gRev ?? 0) + 1,
    hash: createHash('sha256').update(content).digest('hex'),
    mtime,
    session: session ?? '',
    at: Date.now(),
  });
  persistLedger();

  try {
    const bytesAfter = Buffer.byteLength(content, 'utf8');
    queueFsChange({
      sessionId: session,
      path: absolute,
      op,
      tool: meta?.tool ?? 'agent__write',
      from: meta?.from,
      bytesAfter,
      hashAfter: createHash('sha256').update(content).digest('hex').slice(0, 16),
    });
  } catch {  }

  if (session) {
    const map = load(session);
    const previous = map.get(absolute);
    const intervals = Array.isArray(updatedIntervals) && updatedIntervals.length > 0
      ? mergeLineIntervals(updatedIntervals)
      : undefined;
    map.set(absolute, {
      hash: createHash('sha256').update(content).digest('hex'),
      mtime,
      fromLine: intervals ? intervals[0].from : 1,
      toLine: intervals ? intervals[intervals.length - 1].to : Number.MAX_SAFE_INTEGER,
      ...(intervals ? { intervals } : {}),
      gRev: ledgerRevOf(absolute),
      rev: (previous?.rev ?? 0) + 1,
      lastOp: 'write',
    });
    persist(session);
  }

  void invalidateSearchIndexInline(absolute);
  void invalidateDepsGraphInline(absolute);
}


function invalidateSearchIndexInline(absolute: string): void {
  try {
    const ws = owningWorkspaceInline(absolute);
    if (ws) {
      const { invalidateSearchIndex } = require('./search.js') as typeof import('./search.js');
      const rel = path.relative(ws, absolute).split(path.sep).join('/');
      invalidateSearchIndex(ws, rel);
    }
  } catch {
  }
}


function owningWorkspaceInline(absolute: string): string | null {
  try {
    const { listWorkspaces, isInsideRoot, addonsSrcRoot } = require('./workspace.js') as typeof import('./workspace.js');
    const src = addonsSrcRoot();
    if (src && isInsideRoot(absolute, src)) return src;
    for (const workspace of listWorkspaces()) {
      if (isInsideRoot(absolute, workspace.path)) return workspace.path;
    }
    return null;
  } catch {
    return null;
  }
}


function invalidateDepsGraphInline(_absolute: string): void {
  try {
    const ws = owningWorkspaceInline(_absolute);
    if (ws) {
      const { invalidateDepsGraph } = require('./deps.js') as typeof import('./deps.js');
      invalidateDepsGraph(ws);
    }
  } catch {
  }
}


export interface FsChangeEvent {
  sessionId?: string;
  path: string;
  op: 'add' | 'modify' | 'delete' | 'rename' | 'copy';
  tool: string;
  from?: string;
  bytesAfter?: number;
  hashAfter?: string;
}


export function recordFsChange(event: FsChangeEvent): void {
  queueFsChange(event);
}

const fsChangeBuffer: FsChangeEvent[] = [];
let fsChangeTimer: ReturnType<typeof setTimeout> | null = null;

function queueFsChange(event: FsChangeEvent): void {
  const ws = owningWorkspaceInline(event.path);
  if (!ws) return;
  const rel = path.relative(ws, event.path).split(path.sep).join('/');
  fsChangeBuffer.push({ ...event, path: rel });
  if (fsChangeTimer) return;
  fsChangeTimer = setTimeout(() => {
    fsChangeTimer = null;
    const batch = fsChangeBuffer.splice(0, fsChangeBuffer.length);
    if (batch.length === 0) return;
    void (async () => {
      try {
        const { emitPointAsync } = await import('../addons/points.js');
        for (const entry of batch) emitPointAsync('fs.change', entry);
      } catch {  }
    })();
  }, 50);
  fsChangeTimer.unref?.();
}


export function listSessionEntries(
  session: string | undefined,
): Array<{ absolute: string; entry: ReadEntry }> {
  if (!session) return [];
  return [...load(session).entries()].map(([absolute, entry]) => ({
    absolute,
    entry: { ...entry },
  }));
}


export function getReadEntry(
  session: string | undefined,
  absolute: string,
): ReadEntry | undefined {
  if (!session) return undefined;
  return load(session).get(absolute);
}


export interface RenderedScope {
  
  key: string;
  
  hash: string;
  
  rev: number;
  
  at: number;
}

const renderedScopes = new Map<string, RenderedScope>();

function scopeSlot(session: string, absolute: string): string {
  return `${session}\u0000${absolute}`;
}

export function markRenderedScope(
  session: string | undefined,
  absolute: string,
  key: string,
  hash: string,
  rev: number,
): void {
  if (!session) return;
  renderedScopes.set(scopeSlot(session, absolute), { key, hash, rev, at: Date.now() });
}

export function getRenderedScope(
  session: string | undefined,
  absolute: string,
): RenderedScope | undefined {
  if (!session) return undefined;
  return renderedScopes.get(scopeSlot(session, absolute));
}


const structural = new Map<string, Set<string>>();

export function markStructuralRead(session: string | undefined, absolute: string): void {
  if (!session) return;
  let set = structural.get(session);
  if (!set) {
    set = new Set();
    structural.set(session, set);
  }
  set.add(absolute);
}

export function hasStructuralRead(session: string | undefined, absolute: string): boolean {
  if (!session) return true;
  return structural.get(session)?.has(absolute) ?? false;
}


export function readRequiredMessage(relative: string): string {
  return (
    `Read-before-edit policy: "${relative}" has not been read in this conversation. ` +
    'Call agent__read_file on it first (the line numbers it returns are the anchors for your edit), ' +
    'then retry the edit. Editing a file you have never seen is refused to prevent clobbered content.'
  );
}


export function staleReadMessage(relative: string, readRev: number): string {
  return (
    `Stale read: "${relative}" was modified after your read #${readRev} — ` +
    `by another session, another agent, or the user's editor. The hash and/or the global write-revision ` +
    `no longer match your read. ` +
    `Next step: call agent__read_file on it again to refresh your view, then retry the edit. ` +
    `Do NOT retry with the same oldString — the content beneath it has changed.`
  );
}


export function outOfRangeMessage(
  relative: string,
  fromLine: number,
  toLine: number,
  anchorLine: number,
  entry?: { fromLine: number; toLine: number; intervals?: LineInterval[] },
): string {
  const windowLabel = entry ? formatReadIntervals(entry) : `${fromLine}–${toLine}`;
  return (
    `Anchor outside your read window: "${relative}" was read at lines [${windowLabel}], ` +
    `but your oldString matches around line ${anchorLine} — outside every covered interval. ` +
    `Next step: agent__read_file path="${relative}" offsetLine=${Math.max(1, anchorLine - 10)} maxLines=30, ` +
    `then retry with an anchor inside your read window.`
  );
}


export function outOfRangeLinesMessage(
  relative: string,
  from: number,
  to: number,
  readFrom: number,
  readTo: number,
  entry?: { fromLine: number; toLine: number; intervals?: LineInterval[] },
): string {
  const windowLabel = entry ? formatReadIntervals(entry) : `${readFrom}–${readTo}`;
  return (
    `editLines ${from}–${to} is outside your read window [${windowLabel}] for "${relative}". ` +
    `Line-range edits may only touch regions you have actually seen. ` +
    `Next step: agent__read_file path="${relative}" offsetLine=${Math.max(1, from - 10)} maxLines=${to - from + 21}, ` +
    `then retry the same editLines.`
  );
}
