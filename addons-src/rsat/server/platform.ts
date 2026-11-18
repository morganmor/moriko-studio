

import { agentBySession } from './agents.js';


export function touchedPathsOf(api, tool, args) {
  try {
    return api.harness.touchedPaths(tool, args) || [];
  } catch {
    return [];
  }
}


export function agentActor(ctx) {
  let rec = null;
  try { rec = agentBySession(ctx?.api, ctx?.sessionId) ?? null; } catch { rec = null; }
  return {
    kind: 'agent',
    agentId: rec?.id,
    name: rec?.name ?? ctx?.actor?.model ?? 'agent',
    sessionId: ctx?.sessionId,
    model: ctx?.actor?.model,
    label: rec?.name,
  };
}

export function userActor(name) {
  return { kind: 'user', name: name || 'user' };
}


const activityRing = [];
const ACTIVITY_LIMIT = 300;
const activityWaiters = new Set<() => void>();

export function pushActivity(entry) {
  activityRing.push({ at: Date.now(), ...entry });
  if (activityRing.length > ACTIVITY_LIMIT) activityRing.shift();
  for (const notify of [...activityWaiters]) {
    try { notify?.(); } catch {  }
    activityWaiters.delete(notify);
  }
}

export function readActivity(limit = 100) {
  return activityRing.slice(-limit).reverse();
}
