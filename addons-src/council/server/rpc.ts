
import { getBrief, setBrief, setDirective, getOrchestrator, setOrchestrator } from './store.js';
import { upsertProjection, membershipOf, wakeSessions, isSessionActive } from './sync.js';

const ok = (result) => result;


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


export async function syncSessions(api, sessionId, body) {
  upsertProjection(api, sessionId, body?.projection ?? null);
  return ok({ synced: true });
}


export async function saveBrief(api, sessionId, body) {
  const councilId = typeof body?.councilId === 'string' ? body.councilId : '';
  const brief = typeof body?.brief === 'string' ? body.brief : '';
  if (!councilId) throw new Error('No active council.');
  await setBrief(api, sessionId, councilId, brief);
  return ok({ saved: true, brief });
}


export async function setOrchestratorRpc(api, sessionId, body) {
  const councilId = typeof body?.councilId === 'string' ? body.councilId : '';
  const agentId = typeof body?.orchestratorAgentId === 'string' ? body.orchestratorAgentId : '';
  if (!councilId) throw new Error('No active council.');
  await setOrchestrator(api, sessionId, councilId, agentId);
  try { void api.bus.publish('council.changed', { event: { type: 'orchestrator', target: councilId, agentId }, at: Date.now() }); } catch {  }
  return ok({ saved: true, orchestratorAgentId: agentId });
}


export async function dispatch(api, sessionId, body) {
  const target = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const councilId = typeof body?.councilId === 'string' ? body.councilId : '';
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!target || !councilId || !text) throw new Error('dispatch requires sessionId, councilId, text.');
  await setDirective(api, target, councilId, text);
  await wakeSessions(api, [{ sessionId: target, text }]);
  return ok({ queued: true, woke: true });
}


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
