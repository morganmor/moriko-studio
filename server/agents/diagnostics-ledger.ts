/**
 * DIAGNOSTICS LEDGER — the memory behind Todo invariant 3 ("no false
 * completion").
 *
 * A todo may not be marked `completed` while a file this session edited still
 * carries a syntax diagnostic the edit INTRODUCED. Without this, "done" means
 * "the model said so" — which is exactly the claim a checklist exists to
 * replace.
 *
 * Only NEW diagnostics are recorded: the pipeline snapshots each touched
 * file's diagnostics BEFORE the handler runs and diffs after. A file that was
 * already broken before the agent touched it never blocks completion, because
 * the agent did not break it.
 *
 * In-memory and session-scoped: a restart clears the ledger, and the next edit
 * simply repopulates it.
 */
export interface UnresolvedDiagnostic {
  line: number;
  column: number;
  code: number;
  message: string;
}

export interface UnresolvedFile {
  file: string;
  items: UnresolvedDiagnostic[];
}

/** session → (workspace-relative file → introduced diagnostics). */
const ledger = new Map<string, Map<string, UnresolvedDiagnostic[]>>();

function sessionMap(sessionId: string): Map<string, UnresolvedDiagnostic[]> {
  let map = ledger.get(sessionId);
  if (!map) {
    map = new Map();
    ledger.set(sessionId, map);
  }
  return map;
}

function relKey(relPath: string): string {
  return relPath.trim().replace(/\\/g, '/');
}

/** Stable identity of one diagnostic, used to diff before/after. */
export function diagnosticSignature(item: { line: number; column: number; code: number }): string {
  return `${item.line}:${item.column}:${item.code}`;
}

/**
 * Records the diagnostics a call INTRODUCED in one file. An empty list CLEARS
 * the file — that is how a fixed error stops blocking completion.
 */
export function recordFileDiagnostics(
  sessionId: string | undefined,
  relPath: string,
  items: UnresolvedDiagnostic[],
): void {
  if (!sessionId || !sessionId.trim()) return;
  const map = sessionMap(sessionId);
  const key = relKey(relPath);
  if (items.length === 0) {
    map.delete(key);
    return;
  }
  map.set(key, items);
}

export function clearFileDiagnostics(sessionId: string | undefined, relPath: string): void {
  recordFileDiagnostics(sessionId, relPath, []);
}

/** Files currently in the ledger — the pipeline re-checks these after an edit
 *  so an error fixed in file A also clears a stale entry from file A. */
export function ledgerFiles(sessionId: string | undefined): string[] {
  if (!sessionId) return [];
  return [...(ledger.get(sessionId)?.keys() ?? [])];
}

export function listUnresolvedDiagnostics(sessionId: string | undefined): UnresolvedFile[] {
  if (!sessionId) return [];
  const map = ledger.get(sessionId);
  if (!map) return [];
  const out: UnresolvedFile[] = [];
  for (const [file, items] of map) {
    if (items.length > 0) out.push({ file, items });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export function unresolvedCount(sessionId: string | undefined): number {
  return listUnresolvedDiagnostics(sessionId).length;
}

/** Called when a session's context is rebuilt (compaction / model swap). */
export function clearDiagnosticsLedger(sessionId: string | undefined): void {
  if (!sessionId) return;
  ledger.delete(sessionId);
}
