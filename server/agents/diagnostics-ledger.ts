
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


export function diagnosticSignature(item: { line: number; column: number; code: number }): string {
  return `${item.line}:${item.column}:${item.code}`;
}


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


export function clearDiagnosticsLedger(sessionId: string | undefined): void {
  if (!sessionId) return;
  ledger.delete(sessionId);
}
