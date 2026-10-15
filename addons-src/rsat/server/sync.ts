/**
 * RSA/T multi-agent sync (R4) — presence, notifications, injection, prompt
 * fragments, and the sidebar status item.
 *
 * Presence: the board shows every RUNNING harness session (from the platform
 * session registry) + who holds which claim.
 * Injection: when an achievement is claimed/released/completed, other RUNNING
 * sessions get ONE short, idempotent notice at their next round boundary
 * (sessions.inject → system-injection block, user decision Q2).
 * Prompt fragment (per-session): "you hold X; A-003 is held by Agent B" —
 * the A-09 fix: session-scoped, budgeted, never global.
 */

import { listSessions } from './platform-live.js';
import { pushActivity } from './platform.js';
import { loadDoc } from './store.js';
import { agentBySession, memoryOfSession } from './agents.js';

const INJECT_KEY = 'rsat-board';

/** Which board events announce themselves to the actor's conversation. */
function eventLevelOf(type: string): 'info' | 'warn' | null {
  if (type === 'claimed' || type === 'released') return 'warn';
  if (type === 'completed') return 'info';
  return null;
}

/** Fire the SSE frames + per-session harness event for one board event. */
export async function broadcast(api, sessionId, event) {
  pushActivity({ kind: 'board', ...event });
  try {
    await api.bus.publish('rsat.changed', { event: { ...event }, at: Date.now() });
  } catch { /* bus is best-effort */ }
  // HARNESS-EVENT (per-session only): the actor's own conversation gets a
  // dedicated event turn — NOT a user message, NOT broadcast to others.
  const level = eventLevelOf(event.type);
  if (level) {
    const text = `RSA/T: ${event.target} was ${event.type} by ${event.by?.label ?? event.by?.name ?? 'an agent'}.`;
    try {
      api.events.emit(sessionId, { text, level, key: `${INJECT_KEY}:${event.target}:${event.type}` });
      pushActivity({ kind: 'inject', text, delivered: 1, queued: 0, target: event.target });
    } catch { /* event emit is best-effort */ }
  }

  // Sidebar status item: progress + claim count.
  try {
    const doc = loadDoc(api, sessionId);
    if (doc) {
      const done = doc.achievements.filter((a) => a.state === 'done').length;
      const total = doc.achievements.length;
      const active = doc.achievements.filter((a) => ['claimed', 'in_progress', 'review'].includes(a.state)).length;
      api.status.set({
        id: 'board',
        text: `${done}/${total} done`,
        tone: active > 0 ? 'info' : 'muted',
        progress: total > 0 ? done / total : undefined,
        badge: active > 0 ? active : undefined,
        pulse: active > 0,
      });
    }
  } catch { /* status is best-effort */ }

  // Achievement toast (Q: only for completions, only when enabled).
  try {
    if (event.type === 'completed' && api.settings.get('showToast') !== false) {
      const { toastAchievement } = await import('./notify.js');
      toastAchievement(api, event);
    }
  } catch { /* best-effort */ }
}

/** Identity block: named-agent declaration + structured memory (survives swaps). */
function identityLines(api, sessionId) {
  let rec = null;
  try { rec = agentBySession(api, sessionId); } catch { /* registry not loaded */ }
  if (!rec) return [];
  const lines = [
    `IDENTITY: You are "${rec.name}" [${rec.id}] on this board (session ${String(sessionId).slice(0, 8)}). ` +
    `Any other session — even one running the same model — is a DIFFERENT agent. ` +
    `Never say you already did work that is not yours; check rsat_status and your own claims only.`,
  ];
  const mem = memoryOfSession(api, sessionId);
  if (mem.length > 0) {
    // Window 16 entry: keputusan terkini + fakta lama yang masih relevan.
    lines.push(`YOUR MEMORY (structured, survives model swaps — newest last, ${mem.length} total):`);
    for (const m of mem.slice(-16)) lines.push(`  [${m.kind}] ${m.text}`);
  }
  return lines;
}

/** The per-session prompt fragment (A-09 successor, budgeted by the host). */
export function createPromptFragment(api) {
  return {
    id: 'rsat-board',
    order: 40,
    budgetChars: 2000,
    build(ctx) {
      const doc = loadDoc(api, ctx.sessionId);
      if (!doc || doc.prd.status !== 'running') return [];
      const mine = (doc.achievements || []).filter(
        (a) => a.claim?.by?.sessionId === ctx.sessionId && ['claimed', 'in_progress', 'review'].includes(a.state),
      );
      const others = (doc.achievements || []).filter(
        (a) => ['claimed', 'in_progress', 'review'].includes(a.state) && a.claim?.by?.sessionId !== ctx.sessionId,
      );
      const lines = [`RSA/T PRD "${doc.prd.title}" is running (use the rsat tools for board actions):`];

      // Identity-first: named agents declare who they are (helper — keeps build() small).
      lines.push(...identityLines(api, ctx.sessionId));

      for (const a of mine) {
        lines.push(`- You hold ${a.id} "${a.title}" (state ${a.state})${a.progressNote ? ` — last note: ${a.progressNote.text}` : ''}. Stay inside its scope; heartbeat is automatic on every rsat tool call. REPORT each acceptance criterion via rsat_progress (the USER ticks the boxes).`);
      }
      for (const a of others.slice(0, 5)) {
        lines.push(`- ${a.id} is held by ${a.claim.label ?? 'another agent'} — do not edit its scope. Use rsat_context to see what they changed.`);
      }
      const available = (doc.achievements || []).filter((a) => a.state === 'available').slice(0, 5);
      if (available.length > 0) lines.push(`- Available to claim: ${available.map((a) => a.id).join(', ')} (rsat_status first).`);
      // Cross-agent awareness: architecture + recent decisions
      if (doc.prd.architecture) lines.push(`Architecture: ${doc.prd.architecture}`);
      if (doc.prd.modules?.length > 0) {
        lines.push(`Architecture Layer Matrix: ${doc.prd.modules.slice(0, 8).map((m) => `${m.id}:${m.name}${m.layer ? `(${m.layer})` : ''}${m.allowedImports?.length ? `->[${m.allowedImports.join(',')}]` : ''}`).join(' · ')}`);
      }
      if (doc.prd.milestones?.length > 0) {
        lines.push(`Milestones: ${doc.prd.milestones.slice(0, 8).map((m) => `${m.id} ${m.title}`).join(' · ')}`);
      }
      if (doc.prd.technicalDecisions?.length > 0) {
        lines.push(`Key decisions: ${doc.prd.technicalDecisions.slice(-3).map((td) => td.text).join('; ')}`);
      }
      lines.push('IMPORTANT: Before writing code or changing exports, call rsat_interlink (returns @RSLK v1 node-wire topology & blast radius) and rsat_context to see upstream/downstream symbol wires and avoid breaking other agents.');
      return lines;
    },
  };
}

/** Presence snapshot for the board UI. */
export function presence(api, sessionId) {
  let sessions = [];
  try { sessions = listSessions(api); } catch { sessions = []; }
  return sessions.map((s) => {
    let rec = null;
    try { rec = agentBySession(api, s.sessionId); } catch { /* registry not loaded */ }
    return {
      sessionId: s.sessionId,
      model: s.model ?? null,
      startedAt: s.startedAt,
      lastActive: s.lastActive,
      isSelf: s.sessionId === sessionId,
      agentId: rec?.id ?? null,
      label: rec?.name ?? s.model ?? 'session',
    };
  });
}
