/**
 * Platform access helpers for the RSAT addon (R0).
 *
 * The addon runs INSIDE the harness process but must not import harness
 * server modules by path (it gets seeded to ~/.moriko-studio/addons and the
 * relative path would break). Everything it needs arrives through the `ctx`
 * the loader passes to activate(). These thin wrappers give the rest of the
 * addon a stable, typed-ish surface.
 */

import { agentBySession } from './agents.js';

/** Touched-path extraction — delegated to the host API (A3). */
export function touchedPathsOf(api, tool, args) {
  try {
    return api.harness.touchedPaths(tool, args) || [];
  } catch {
    return [];
  }
}

/** Actor for an agent tool call (from the ctx the platform passes).
 *  Identity-first: when the session is BOUND to a named agent (dispatch),
 *  the registry record wins — two sessions running the same model are two
 *  DIFFERENT agents, and claims/labels must never collide on model name. */
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

/** Global in-memory event ring for the Live Activity panel (R4/R5). */
const activityRing = [];
const ACTIVITY_LIMIT = 300;
const activityWaiters = new Set<() => void>();

export function pushActivity(entry) {
  activityRing.push({ at: Date.now(), ...entry });
  if (activityRing.length > ACTIVITY_LIMIT) activityRing.shift();
  for (const notify of [...activityWaiters]) {
    try { notify?.(); } catch { /* listener died */ }
    activityWaiters.delete(notify);
  }
}

export function readActivity(limit = 100) {
  return activityRing.slice(-limit).reverse();
}
