import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../atomicWrite.js';
import { readStateDir } from '../paths.js';

/**
 * READ-BEFORE-EDIT POLICY — MULTI-SESSION ENFORCEMENT.
 *
 * The harness refuses a WRITE (edit_file / apply_patch / vault_restore) to a
 * file the model has not READ in its CURRENT context. Editing blind is the
 * number-one cause of botched anchors and clobbered content; the refusal
 * message points back to agent__read_file.
 *
 * Three stores, one invariant — "the model's view is the file's truth":
 *
 *  1. Per-session receipts (`<session>.json`): what the model actually read,
 *     with the line window it saw (union, monotonic) and the read revision
 *     quoted in read_file footers.
 *  2. The GLOBAL fs-ledger (`fs-ledger.json`): every write from ANY session
 *     advances the file's revision (gRev). A receipt whose gRev lags the
 *     ledger is VOID — a write in another session (or another branch of this
 *     one) always forces a re-read, even when bytes+mtime round-trip back.
 *  3. Context identity (`<session>.ctx.json`): the client sends a context id
 *     that changes whenever the model's context is rebuilt (regenerate, new
 *     chat, model switch, post-compaction). A changed id clears ALL receipts
 *     of the session — ghost receipts from an earlier sitting never edit.
 *
 * FAIL CLOSED when there is no session key: untracked callers cannot edit.
 * Sessions that never read anything cost nothing: every store is lazy.
 */

const STORE_DIR = readStateDir;

export interface ReadEntry {
  /** Content hash at read time — detects external modification. */
  hash: string;
  /** mtime at read time (ms). A changed mtime invalidates the read. */
  mtime: number;
  /**
   * Global write-revision of the file AT RECORD TIME (fs-ledger). Any write —
   * by ANY session — advances the ledger; a stale gRev voids this receipt
   * even when the bytes + mtime round-trip back. Multi-session enforcement.
   */
  gRev: number;
  /** Line range the model actually saw (for a sharper refusal message). */
  fromLine: number;
  toLine: number;
  /**
   * Per-file revision for this session — bumped on every successful write.
   * Surfaced in read_file's footer (`read#N`) so the model can tell when the
   * file it holds is stale relative to its own last edit.
   */
  rev: number;
  /** Which operation last touched this entry — drives list "touched" statuses. */
  lastOp: 'read' | 'write';
}

/** session -> path -> entry. Loaded lazily, written through on change. */
const sessions = new Map<string, Map<string, ReadEntry>>();
const loaded = new Set<string>();

interface LedgerEntry {
  gRev: number;
  hash: string;
  mtime: number;
  /** Which session performed the write ('' for sessionless callers). */
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

/** Current global write-revision of a file (0 = never written by this harness). */
export function ledgerRevOf(absolute: string): number {
  return loadLedger().get(absolute)?.gRev ?? 0;
}

const contextIds = new Map<string, string>();

function contextFile(session: string): string {
  return path.join(STORE_DIR, `${session}.ctx.json`);
}

/**
 * Adopts the client's context id for this session. When the id DIFFERS from
 * the previous one, all receipts of the session are cleared (they belong to
 * a context the model no longer sits in). Idempotent within one sitting.
 * Returns true when receipts were cleared.
 */
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
              map.set(key, {
                hash: entry.hash,
                mtime: entry.mtime,
                gRev: typeof entry.gRev === 'number' ? entry.gRev : 0,
                fromLine: typeof entry.fromLine === 'number' ? entry.fromLine : 1,
                toLine: typeof entry.toLine === 'number' ? entry.toLine : Number.MAX_SAFE_INTEGER,
                rev: typeof entry.rev === 'number' ? entry.rev : 1,
                lastOp: entry.lastOp === 'write' ? 'write' : 'read',
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

/**
 * Records that the model read `absolute` (content + range). Called by
 * readFileTool on every successful read.
 *
 * UNION READ WINDOW: successive reads MERGE their line ranges instead of
 * overwriting them. Reading lines 1–400 then 401–800 leaves the window as
 * 1–800, so an edit anchored at line 150 (already seen) is NOT refused.
 * The only writer of a full-file window is recordAfterWrite (it sets
 * 1..MAX_SAFE_INTEGER, which union preserves trivially).
 */
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
  const entry: ReadEntry = {
    hash: createHash('sha256').update(content).digest('hex'),
    mtime,
    gRev: ledgerRevOf(absolute),
    fromLine: previous ? Math.min(previous.fromLine, fromLine) : fromLine,
    toLine: previous ? Math.max(previous.toLine, toLine) : toLine,
    rev: (previous?.rev ?? 0) + 1,
    lastOp: 'read',
  };
  map.set(absolute, entry);
  persist(session);
  return entry;
}

/**
 * True when the model has a CURRENT read of `absolute` in this session:
 * recorded, and the file has not changed on disk since (mtime + hash).
 * Callers pass the current content so the hash check is exact.
 */
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

/**
 * Refreshes the read state after a successful write: the model knows exactly
 * what it just wrote, so the new content counts as "read". This keeps a
 * follow-up edit (or a vault_restore to the same path) frictionless — the
 * entry is UPDATED, not deleted, so the chain read → edit → restore never
 * trips the policy.
 */
export function recordAfterWrite(
  session: string | undefined,
  absolute: string,
  content: string,
  mtime: number,
): void {
  const ledger = loadLedger();
  ledger.set(absolute, {
    gRev: (ledger.get(absolute)?.gRev ?? 0) + 1,
    hash: createHash('sha256').update(content).digest('hex'),
    mtime,
    session: session ?? '',
    at: Date.now(),
  });
  persistLedger();

  if (session) {
    const map = load(session);
    const previous = map.get(absolute);
    map.set(absolute, {
      hash: createHash('sha256').update(content).digest('hex'),
      mtime,
      fromLine: 1,
      toLine: Number.MAX_SAFE_INTEGER,
      gRev: ledgerRevOf(absolute),
      rev: (previous?.rev ?? 0) + 1,
      lastOp: 'write',
    });
    persist(session);
  }

  void invalidateSearchIndexInline(absolute);
  void invalidateDepsGraphInline(absolute);
}

/** Fire-and-forget invalidation — avoids circular import at module scope. */
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

/**
 * The workspace that OWNS the touched file — resolved from the file's own
 * path, not from the "active" selection. With per-session workspaces several
 * roots may be live at once, and the invalidation must hit the index of the
 * root the write actually landed in.
 */
function owningWorkspaceInline(absolute: string): string | null {
  try {
    const { listWorkspaces, isInsideRoot } = require('./workspace.js') as typeof import('./workspace.js');
    for (const workspace of listWorkspaces()) {
      if (isInsideRoot(absolute, workspace.path)) return workspace.path;
    }
    return null;
  } catch {
    return null;
  }
}

/** Same fire-and-forget pattern for the import graph (5 s TTL cache). */
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

/**
 * All read entries of a session (copies), keyed by absolute path — the data
 * source for `agent__list mode: "touched"` (session footprint).
 */
export function listSessionEntries(
  session: string | undefined,
): Array<{ absolute: string; entry: ReadEntry }> {
  if (!session) return [];
  return [...load(session).entries()].map(([absolute, entry]) => ({
    absolute,
    entry: { ...entry },
  }));
}

/**
 * The active read entry for a path, if any. Callers (edit_file) use it to
 * enforce the line-range the model actually saw and to quote the read
 * revision in refusal messages.
 */
export function getReadEntry(
  session: string | undefined,
  absolute: string,
): ReadEntry | undefined {
  if (!session) return undefined;
  return load(session).get(absolute);
}

/**
 * STRUCTURAL-READ MEMORY (fold-first enforcement, soft).
 *
 * A fold/outline/read_all call MAps a file structurally (signature tree or
 * symbol map). readFileTool window mode consults this: a partial, top-anchored
 * window read of a file that was never mapped this session gets a one-line
 * fold-first hint. Once mapped, the hint stops. Deliberately in-memory (a
 * cross-restart lapse only re-shows a harmless hint) and deliberately NOT
 * stored as a ReadEntry — fold is not a read receipt and must never satisfy
 * the read-before-edit gate.
 */
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

/**
 * The refusal the model sees when it tries to edit blind.
 */
export function readRequiredMessage(relative: string): string {
  return (
    `Read-before-edit policy: "${relative}" has not been read in this conversation. ` +
    'Call agent__read_file on it first (the line numbers it returns are the anchors for your edit), ' +
    'then retry the edit. Editing a file you have never seen is refused to prevent clobbered content.'
  );
}

/**
 * The refusal when the file changed on disk after the model's read
 * (external modification). Quotes the read revision so the model can
 * compare against its own last-known state.
 */
export function staleReadMessage(relative: string, readRev: number): string {
  return (
    `Stale read: "${relative}" was modified after your read #${readRev} — ` +
    `by another session, another agent, or the user's editor. The hash and/or the global write-revision ` +
    `no longer match your read. ` +
    `Next step: call agent__read_file on it again to refresh your view, then retry the edit. ` +
    `Do NOT retry with the same oldString — the content beneath it has changed.`
  );
}

/**
 * The refusal when the edit's anchor lies outside the line range the model
 * actually read (e.g. it read lines 1–400 but anchors at line 512).
 */
export function outOfRangeMessage(
  relative: string,
  fromLine: number,
  toLine: number,
  anchorLine: number,
): string {
  return (
    `Anchor outside your read window: "${relative}" was read as lines ${fromLine}–${toLine}, ` +
    `but your oldString first matches around line ${anchorLine}. ` +
    `Next step: agent__read_file path="${relative}" offsetLine=${Math.max(1, anchorLine - 10)} maxLines=30, ` +
    `then retry with an anchor you have actually seen.`
  );
}

/**
 * The refusal when a line-RANGE edit (editLines) targets lines outside the
 * window the model actually read.
 */
export function outOfRangeLinesMessage(
  relative: string,
  from: number,
  to: number,
  readFrom: number,
  readTo: number,
): string {
  return (
    `editLines ${from}–${to} is outside your read window (${readFrom}–${readTo}) for "${relative}". ` +
    `Line-range edits may only touch regions you have actually seen. ` +
    `Next step: agent__read_file path="${relative}" offsetLine=${Math.max(1, from - 10)} maxLines=${to - from + 21}, ` +
    `then retry the same editLines.`
  );
}
