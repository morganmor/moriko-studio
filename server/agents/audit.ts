import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { auditDir } from '../paths.js';

/**
 * HARNESS AUDIT LOG — one JSONL line per executed agent tool call, persisted
 * under `~/.moriko/audit/`. Append-only, one file per session, so the user
 * can always answer "what did the agent do?" even after the conversation was
 * cleared. Written best-effort: audit failures never break a tool call.
 */

const AUDIT_DIR = auditDir;

export interface AuditEntry {
  at: number;
  session: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  /** Short arg digest (paths/command) — never full contents. */
  args: string;
  /**
   * AUDIT FIDELITY (anti-"logs look truncated"): the TOTAL serialized length
   * of the args, plus an EXPLICIT truncation flag. A silent slice(0,300) made
   * audit lines indistinguishable from provider-side truncation; with these
   * two fields the reader always knows what was cut and how much survived.
   */
  argsLen?: number;
  argsTruncated?: boolean;
  /** Stable failure classification, when the result carries one. */
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

/** Newest-first page of the session's audit trail. */
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
