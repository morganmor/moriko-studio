/**
 * RSA/T file ledger (R5) — every workspace fs.change lands in the ledger of
 * the achievement that owns the path (holder first, else the covering scope),
 * plus a one-line "agent summary" for the board's Files tab.
 *
 * fs.change events carry relative paths inside the workspace; shell tools
 * (unknown:true) are recorded as "untracked command" entries so the board
 * stays honest about what the guard cannot see.
 */

import { inScope } from './model.js';
import { loadDoc, appendLedger } from './store.js';
import { pushActivity } from './platform.js';
import { agentBySession } from './agents.js';

/** loadDoc yang tidak pernah melempar (workspace salah/corrupt → null). */
function tryLoad(api, sessionId) {
  try { return loadDoc(api, sessionId); } catch { return null; }
}

/** loadDoc dari workspace PENULIS file (sessionId), fallback ke pinned ws. */
function docForWrite(api, sessionId) {
  return (sessionId ? tryLoad(api, sessionId) : null) ?? tryLoad(api, undefined);
}

/** Aktor ledger: registry binding menang — ledger menunjukkan agent siapa. */
function ledgerActor(api, sessionId) {
  let rec = null;
  try { rec = agentBySession(api, sessionId); } catch { rec = null; }
  return rec
    ? { kind: 'agent', agentId: rec.id, sessionId, label: rec.name }
    : { kind: 'agent', sessionId };
}

/**
 * Create the fs.change observer. Events fire per file (batched by the host).
 * Attribution: the fs.change entry carries the WRITING session's id — resolve
 * the doc from THAT session's workspace (per-session binding), falling back
 * to the addon's pinned workspace when the writer has none (user writes).
 */
export function createLedger(api) {
  return async function ledgerHook($, event) {
    const sessionId = event?.sessionId;
    const rel = String(event?.path ?? '').replace(/\\/g, '/');
    if (!rel) return;
    if (rel.startsWith('.moriko/rsat/')) return;

    const doc = docForWrite(api, sessionId);
    if (!doc) return;

    const op = event?.op ?? 'modify';
    const candidates = (doc.achievements || []).filter(
      (a) => ['claimed', 'in_progress', 'review'].includes(a.state) && inScope(a.scope, rel),
    );
    if (candidates.length === 0) return;

    const record = {
      path: rel,
      op,
      tool: event?.tool ?? 'unknown',
      from: event?.from,
      by: ledgerActor(api, sessionId),
      summary: `${op} ${rel} (${event?.tool ?? 'tool'})`,
    };

    for (const a of candidates.slice(0, 3)) {
      try {
        await appendLedger(api, sessionId, a.id, record);
        const a2 = docForWrite(api, sessionId)?.achievements?.find((x) => x.id === a.id);
        if (a2 && !(a2.files || []).some((f) => f.path === rel && f.op === op)) {
          a2.files = [...(a2.files || []).slice(-99), { path: rel, op, at: new Date().toISOString(), by: record.by, summary: '', pending: true }];
          const { saveDoc } = await import('./store.js');
          await saveDoc(api, sessionId, docForWrite(api, sessionId), null);
        }
      } catch {  }
    }
    pushActivity({ kind: 'file', text: `${op} ${rel}`, achievementId: candidates[0].id, sessionId });
  };
}
