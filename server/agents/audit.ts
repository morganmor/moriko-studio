import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { auditDir } from '../paths.js';



const AUDIT_DIR = auditDir;

export interface AuditEntry {
  at: number;
  session: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  
  args: string;
  
  argsLen?: number;
  argsTruncated?: boolean;
  
  errorCode?: string;
}

function sessionFile(session: string): string {
  const safe = session.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
  return path.join(AUDIT_DIR, `${safe}.jsonl`);
}

export function auditToolCall(entry: Omit<AuditEntry, 'at'>): void {
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    const safe = entry.session.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
    const line = JSON.stringify({ ...entry, session: safe, at: Date.now() }) + '\n';
    appendFileSync(sessionFile(entry.session), line, 'utf8');
  } catch {
  }
}


export function readAudit(session: string, limit = 200): AuditEntry[] {
  try {
    const file = sessionFile(session);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const entries: AuditEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
      }
    }
    return entries.slice(-limit).reverse();
  } catch {
    return [];
  }
}
