/**
 * Council sync — prompt fragment, membership projection, cross-session broadcast.
 *
 * The host owns the conversation records; the server cannot enumerate them.
 * The panel pushes a projection of the ACTIVE council through the syncSessions
 * RPC whenever it mounts or membership changes. That projection backs the
 * agent tools (council_status / council_broadcast) and the prompt fragment
 * (council identity + members + shared brief).
 *
 * Projection shape (per council):
 *   { councilId, councilTitle, members: [{ sessionId, role, label, agentId, agentName }] }
 */
import { getBrief, getDirective, saveProjection, loadProjections } from './store.js';

const INJECT_KEY = 'council-board';

/** councilId → projection. */
const projections = new Map();
/** sessionId → councilId (fast lookup for the caller's council). */
const sessionIndex = new Map();

function normProjection(p) {
  if (!p || typeof p !== 'object') return null;
  const councilId = String(p.councilId ?? '');
  if (!councilId) return null;
  const members = Array.isArray(p.members) ? p.members.map((m) => ({
    sessionId: String(m?.sessionId ?? ''),
    role: m?.role === 'main' ? 'main' : 'sub',
    label: String(m?.label ?? ''),
    agentId: m?.agentId ? String(m.agentId) : null,
    agentName: m?.agentName ? String(m.agentName) : '',
  })).filter((m) => m.sessionId) : [];
  return {
    councilId,
    councilTitle: String(p.councilTitle ?? ''),
    members,
    at: Date.now(),
  };
}

/** Upsert the projection for a council (called by the panel RPC syncSessions).
 *  Also PERSISTS it — the maps alone die with the server process, and a
 *  graceful reload mid-council must not orphan every member. */
export function upsertProjection(api, sessionId, projection) {
  const norm = normProjection(projection);
  if (!norm) return;
  projections.set(norm.councilId, norm);
  for (const m of norm.members) sessionIndex.set(m.sessionId, norm.councilId);
  try { void saveProjection(api, sessionId, norm.councilId, norm); } catch {  }
  try { void api.bus.publish('council.changed', { event: { type: 'synced', target: norm.councilId }, at: Date.now() }); } catch {  }
}

/** Rebuild the maps from the workspace doc after a server restart. */
function rehydrate(api, sessionId) {
  try {
    for (const { projection } of loadProjections(api, sessionId)) {
      const norm = normProjection(projection);
      if (!norm || projections.has(norm.councilId)) continue;
      projections.set(norm.councilId, norm);
      for (const m of norm.members) sessionIndex.set(m.sessionId, norm.councilId);
    }
  } catch {  }
}

/** The caller's council projection (null when the panel never synced it). */
export function membershipOf(api, sessionId) {
  const sid = String(sessionId ?? '');
  let councilId = sessionIndex.get(sid);
  if (!councilId) {
    rehydrate(api, sessionId);
    councilId = sessionIndex.get(sid);
  }
  if (!councilId) {
    councilId = synthesizeFromConversations(api, sid);
  }
  if (!councilId) return null;
  return projections.get(councilId) ?? null;
}

/** Build + cache a projection from conversation records (server-side truth). */
function synthesizeFromConversations(api, sessionId) {
  try {
    const convos = api.sessions.listConversations?.() ?? [];
    const mine = convos.find((c) => c.id === sessionId && c.councilId);
    if (!mine) return null;
    const members = convos
      .filter((c) => c.councilId === mine.councilId && (c.councilRole === 'main' || c.councilRole === 'sub'))
      .map((c) => ({
        sessionId: c.id,
        role: c.councilRole === 'main' ? 'main' : 'sub',
        label: c.title ?? '',
        agentId: c.councilAgentId ?? null,
        agentName: (c.title ?? '').replace(' · council', ''),
      }));
    if (members.length === 0) return null;
    const norm = normProjection({ councilId: mine.councilId, councilTitle: mine.title ?? '', members });
    if (!norm) return null;
    projections.set(norm.councilId, norm);
    for (const m of norm.members) sessionIndex.set(m.sessionId, norm.councilId);
    return norm.councilId;
  } catch {
    return null;
  }
}

/** Is this session currently RUNNING a turn? (the registry lists live runs only). */
export function isSessionActive(api, sessionId) {
  try { return Boolean(api.sessions.get(sessionId)); } catch { return false; }
}

/**
 * Wake IDLE sub-sessions. A queued injection is only drained by a RUNNING
 * adapter at its next round boundary, so a message to an idle sub-session sits
 * forever (the "orchestrator message never arrives" bug). The wake is now a
 * SERVER-SIDE run start (api.sessions.startRun → self-POST /api/chat): no bus,
 * no SSE, no browser hop — the old bus→SSE→bridge chain dropped frames in a
 * verified live test, so it is gone. A 'council:wake' bus notice is still
 * published for UI observers only.
 */
export async function wakeSessions(api, items): Promise<boolean> {
  if (!items || items.length === 0) return true;
  try { void api.bus.publish('council:wake', { items, at: Date.now() }); } catch {  }
  let allOk = true;
  for (const item of items) {
    if (!item?.sessionId || !item?.text) continue;
    try {
      const report = await api.sessions.startRun(item.sessionId, item.text);
      if (!report?.started) {
        allOk = false;
        console.error(`[council] wake failed for ${item.sessionId}: ${report?.error ?? 'unknown'}`);
      }
    } catch (error) {
      allOk = false;
      console.error(`[council] wake failed for ${item.sessionId}: ${String(error)}`);
    }
  }
  return allOk;
}

/** Broadcast a short notice to the OTHER members of a council. */
export async function broadcastToCouncil(api, sessionId, mem, text) {
  const targets = mem.members
    .map((m) => m.sessionId)
    .filter((id) => id && id !== String(sessionId ?? ''));
  if (targets.length === 0) return { delivered: 0, queued: 0 };
  try {
    const report = await api.sessions.inject(targets, {
      text: `Council notice from ${mem.members.find((m) => m.sessionId === sessionId)?.agentName || 'a member'}: ${text}`,
      level: 'info',
      key: `${INJECT_KEY}:${mem.councilId}:${Date.now()}`,
      ttlMs: 5 * 60 * 1000,
    });
    return { delivered: report?.delivered ?? 0, queued: report?.queued ?? 0 };
  } catch {  }
  return { delivered: 0, queued: 0 };
}

/** Per-session prompt fragment: council identity + members + shared brief. */
export function createPromptFragment(api) {
  return {
    id: 'council-board',
    order: 38,
    budgetChars: 2200,
    build(ctx) {
      const mem = membershipOf(api, ctx.sessionId);
      if (!mem) return [];
      const me = mem.members.find((m) => m.sessionId === ctx.sessionId);
      const myLabel = me
        ? (me.role === 'main' ? 'the Main Session (hub)' : `Sub Session ${me.label}`)
        : 'a member';
      const lines = [
        `COUNCIL: you are ${myLabel} of council "${mem.councilTitle || 'untitled'}" (${mem.councilId}). ` +
        `A council is one shared conversation container holding N sub sessions — one per agent. ` +
        `Each member has its OWN context; check council_status before duplicating work.`,
        ...(me?.role === 'main' ? [
          `ORCHESTRATOR DUTIES: to send a task/instruction to a sub-session use council_send — a RUNNING target gets it injected at its next round boundary, an IDLE target is WOKEN and starts a run immediately. ` +
          `Use council_status first to see which agents already have sub-sessions. council_broadcast is for passive notices only. ` +
          `To halt a member mid-response use council_stop (agentId or "all"). ` +
          `Dispatching NEW agents (creating their sub-session) is USER-ONLY via the RSAT board.`,
        ] : [
          `Coordinate with council_broadcast (delivers to the others at their next round).`,
        ]),
        `Members (${mem.members.length}): ` + mem.members.map((m) =>
          `${m.role === 'main' ? 'Main (hub)' : `Sub ${m.label}`}${m.agentName ? ` = ${m.agentName}` : ''}`
        ).join(', '),
      ];
      const brief = getBrief(api, ctx.sessionId, mem.councilId);
      if (brief) lines.push('Shared council brief:', brief);
      const dir = getDirective(api, ctx.sessionId);
      if (dir) lines.push('Dispatch directive (ack with council_ack once absorbed):', dir.text);
      lines.push('COLLABORATION: Before writing code, use rsat_context to see what other agents changed. Build on their work — never duplicate or contradict. After significant changes, use rsat_remember to record decisions so other agents can see them.');
      return lines;
    },
  };
}

/** Fire the SSE frame + cross-session injections for one panel event. */
export async function broadcast(api, sessionId, event) {
  try {
    await api.bus.publish('council.changed', { event: { ...event }, at: Date.now() });
  } catch {  }
  try {
    const doc = membershipOf(api, sessionId);
    if (doc) api.status.set({
      id: 'council',
      text: `${doc.members.length} member${doc.members.length === 1 ? '' : 's'}`,
      tone: 'info',
    });
  } catch {  }
}
