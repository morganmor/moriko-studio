/**
 * Council panel RPC — /api/addons/council/rpc/*.
 *
 * The panel reads membership from the HOST store (it lives in the host page)
 * and pushes a projection here through `syncSessions`; brief edits go through
 * `setBrief`. Creation of councils and sub sessions is host-owned (DOM
 * events moriko:council-create / moriko:council-sub-create handled in App.tsx),
 * so this RPC surface is intentionally thin: state + sync + brief + a roster
 * bridge to RSA/T (via mod-to-mod api.use('rsat')).
 */
import { getBrief, setBrief, setDirective, getOrchestrator, setOrchestrator } from './store.js';
import { upsertProjection, membershipOf, wakeSessions, isSessionActive } from './sync.js';

const ok = (result) => result;

/** Full panel state: brief for the active council + RSAT roster (when present). */
export async function state(api, sessionId, body) {
  const councilId = typeof body?.councilId === 'string' ? body.councilId : '';
  const mem = membershipOf(api, sessionId);
  const brief = councilId ? getBrief(api, sessionId, councilId) : '';
  let rsatAgents = [];
  try {
    const rsat = api.api?.use?.('rsat');
    if (rsat && typeof rsat.listAgents === 'function') {
      rsatAgents = rsat.listAgents(sessionId) ?? [];
    }
  } catch {  }
  return ok({ councilId, brief, members: mem?.members ?? [], rsatAgents, orchestratorAgentId: getOrchestrator(api, sessionId, councilId) });
}

/** Push the membership projection from the host store (panel → server). */
export async function syncSessions(api, sessionId, body) {
  upsertProjection(api, sessionId, body?.projection ?? null);
  return ok({ synced: true });
}

/** Persist the shared brief. */
export async function saveBrief(api, sessionId, body) {
  const councilId = typeof body?.councilId === 'string' ? body.councilId : '';
  const brief = typeof body?.brief === 'string' ? body.brief : '';
  if (!councilId) throw new Error('No active council.');
  await setBrief(api, sessionId, councilId, brief);
  return ok({ saved: true, brief });
}

/** Designate (or clear) the orchestrator agent for the active council. */
export async function setOrchestratorRpc(api, sessionId, body) {
  const councilId = typeof body?.councilId === 'string' ? body.councilId : '';
  const agentId = typeof body?.orchestratorAgentId === 'string' ? body.orchestratorAgentId : '';
  if (!councilId) throw new Error('No active council.');
  await setOrchestrator(api, sessionId, councilId, agentId);
  try { void api.bus.publish('council.changed', { event: { type: 'orchestrator', target: councilId, agentId }, at: Date.now() }); } catch {  }
  return ok({ saved: true, orchestratorAgentId: agentId });
}

/**
 * Queue a dispatch directive for a sub session (council panel → host event →
 * this RPC). The directive rides the prompt fragment (context channel), and a
 * WAKE is published so the sub session actually starts a run — an idle session
 * never fetches on its own, so without the wake the directive (and the agent)
 * would sit idle forever.
 */
export async function dispatch(api, sessionId, body) {
  const target = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const councilId = typeof body?.councilId === 'string' ? body.councilId : '';
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!target || !councilId || !text) throw new Error('dispatch requires sessionId, councilId, text.');
  await setDirective(api, target, councilId, text);
  await wakeSessions(api, [{ sessionId: target, text }]);
  return ok({ queued: true, woke: true });
}

/** Send a message to a sub-session (user-initiated from the panel). */
export async function sendMessage(api, sessionId, body) {
  const target = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!target || !text) throw new Error('sendMessage requires sessionId and text.');
  const message = `Message from operator: ${text}`;
  if (isSessionActive(api, target)) {
    try {
      await api.sessions.inject([target], {
        text: message,
        level: 'info',
        key: `council-msg:${Date.now()}`,
        ttlMs: 10 * 60 * 1000,
      });
    } catch (e) { throw new Error(`Failed to send: ${String(e)}`); }
    return ok({ sent: true });
  }
  await wakeSessions(api, [{ sessionId: target, text: message }]);
  return ok({ sent: true, woke: true });
}

export const rpcHandlers = { state, syncSessions, saveBrief, dispatch, sendMessage, setOrchestrator: setOrchestratorRpc };
