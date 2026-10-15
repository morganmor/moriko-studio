/**
 * RSA/T scope guard (R3) — two hooks:
 *
 *  tool.call  → STRICT mode denies out-of-scope edits by non-holders here
 *               (with anti-runaway escalation after repeated strikes).
 *  tool.result → ADVISORY mode appends the note to the tool result text
 *               (A-19 mutation channel) so the model SEES the scope warning
 *               without being blocked.
 *
 * Honest limitation (stated in the board + README): shell tools
 * (agent__run/git/exec/task_*) touch UNKNOWN paths — the guard cannot fence
 * them; the ledger still records every observable write.
 */

import { agentBySession } from './agents.js';
import { touchedPathsOf } from './platform.js';
import { loadDoc } from './store.js';
import { coveringAchievements } from './engine.js';
import { inspectFileArchImpact, invalidateInterlinkCache } from './interlink.js';

const WRITE_TOOLS = new Set([
  'agent__edit_file', 'agent__multi_edit', 'agent__edit_lines', 'agent__edit_between',
  'agent__insert_at_line', 'agent__write', 'agent__apply_patch', 'agent__refactor',
  'agent__rename', 'agent__move', 'agent__copy', 'agent__delete', 'agent__backend',
  'agent__layout_edit',
]);

/** sessionId → recent out-of-scope strikes (anti-runaway). */
const strikes = new Map();
/** sessionId+tool → advisory note waiting for the matching tool.result. */
const pendingNotes = new Map();
const STRIKE_WINDOW_MS = 10 * 60 * 1000;
const STRIKE_LIMIT = 5;

function addStrike(sessionId) {
  const now = Date.now();
  const list = (strikes.get(sessionId) ?? []).filter((t) => now - t < STRIKE_WINDOW_MS);
  list.push(now);
  strikes.set(sessionId, list);
  return list.length;
}

function clearStrikes(sessionId) {
  strikes.delete(sessionId);
}

/** Compute the scope violation notes for one write call (shared by both hooks). */
function scopeNotes(api, sessionId, tool, args) {
  const doc = loadDoc(api, sessionId);
  if (!doc || doc.prd.status !== 'running') return [];
  const touched = touchedPathsOf(api, tool, args ?? {});
  const known = (touched ?? []).filter((t) => !t.unknown && (t.path || t.from));
  if (known.length === 0) return [];
  const notes = [];
  for (const t of known) {
    for (const rel of [t.path, t.from, t.to].filter(Boolean)) {
      if (String(rel).replace(/\\/g, '/').startsWith('.moriko/rsat/')) continue;
      const holders = coveringAchievements(doc, rel);
      if (holders.length === 0) continue; // unclaimed scope → no fence
      // Own scope = the claim is bound to THIS agent's identity (registry),
      // or to this session directly (user actions / pre-registry claims).
      let myAgentId = null;
      try { myAgentId = agentBySession(api, sessionId)?.id ?? null; } catch { /* registry not loaded */ }
      if (holders.some((h) => h.claim?.by?.agentId === myAgentId || h.claim?.by?.sessionId === sessionId)) continue;
      const who = holders.map((h) => `${h.id} (held by ${h.claim?.label ?? 'another agent'})`).join(', ');
      notes.push(`RSA/T scope: "${rel}" is inside the scope of ${who}, not yours. Propose rsat_scope widen with a reason, or coordinate with the holder before touching it.`);
    }
  }
  return notes;
}

/** Compute architectural blast-radius & layer violation advisories for a write. */
function archImpactNotes(api, sessionId, tool, args) {
  const touched = touchedPathsOf(api, tool, args ?? {});
  const known = (touched ?? []).filter((t) => !t.unknown && (t.path || t.from));
  if (known.length === 0) return [];
  const advisories = [];
  for (const t of known) {
    for (const rel of [t.path, t.to].filter(Boolean)) {
      const impact = inspectFileArchImpact(api, sessionId, rel);
      if (!impact) continue;
      if (impact.violation) {
        advisories.push(`RSA/T arch-guard: ${impact.violation}`);
      }
      if (impact.crossDownstream.length > 0) {
        advisories.push(
          `RSA/T interlink blast-radius: "${rel}" feeds ${impact.crossDownstream.length} cross-quest file(s): ${impact.crossDownstream.slice(0, 4).join(', ')}. Keep exported contract signatures intact or call rsat_interlink to verify.`,
        );
      }
    }
  }
  return advisories;
}

/** tool.call hook — strict denies + anti-runaway. */
export function createGuard(api) {
  return async function guardCall($, event, next) {
    const tool = event?.tool ?? '';
    if (!WRITE_TOOLS.has(tool)) return next(event);
    const sessionId = event?.sessionId;
    if (!sessionId) return next(event);

    const notes = scopeNotes(api, sessionId, tool, event.args ?? {});
    const archNotes = archImpactNotes(api, sessionId, tool, event.args ?? {});
    if (notes.length === 0) {
      clearStrikes(sessionId);
      if (archNotes.length > 0) {
        pendingNotes.set(`${sessionId}\u0000${tool}`, archNotes.join(' '));
      }
      return next(event);
    }

    const mode = api.settings.get('guardMode') === 'strict' ? 'strict' : 'advisory';
    const count = addStrike(sessionId);

    if (mode === 'strict') {
      if (count >= STRIKE_LIMIT) {
        return {
          deny: `RSA/T guard: repeated out-of-scope edits (${count} in 10 min). Check your claimed achievement's scope, propose a change (rsat_scope), release the claim (rsat_release), or ask the user. This deny protects the other agent's work.`,
        };
      }
      return {
        deny: `${notes.join(' ')} DENIED (strict mode) — use rsat_scope to propose a change, or claim the achievement yourself.`,
      };
    }

    // advisory: let the call through, stash the note for the result hook.
    pendingNotes.set(`${sessionId}\u0000${tool}`, [...notes, ...archNotes].join(' '));
    return next(event);
  };
}

/** tool.result hook — advisory notes ride the A-19 mutation channel. */
export function createGuardResult(api) {
  return async function guardResult($, event) {
    const tool = event?.tool ?? '';
    const sessionId = event?.sessionId;
    if (!sessionId || !WRITE_TOOLS.has(tool)) return {};
    invalidateInterlinkCache();
    const key = `${sessionId}\u0000${tool}`;
    const note = pendingNotes.get(key);
    if (!note) return {};
    pendingNotes.delete(key);
    const result = event?.result;
    if (result && typeof result === 'object' && typeof result.text === 'string') {
      result.text += `\n[rsat advisory] ${note}`;
    }
    return {};
  };
}
