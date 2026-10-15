/**
 * Harness Extension Points — HEP (Addon v2, A3).
 *
 * The versioned contract addons hook into: named points in the harness core,
 * each with semantics observe | mutate | cancel, priority ordering, timeouts
 * and error isolation. emitAddonEvent (v1) maps onto this — hooks registered
 * with the v1 registrar run for the same point names.
 *
 * Design: emitPoint is CHEAP when no hook matches (one Map lookup) so core
 * call sites pay ~nothing when addons are absent.
 */

import type { AddonElement, AddonHook, AddonMatcher } from './types.js';
import { addonHookCount } from './registry.js';

export type PointSemantics = 'observe' | 'mutate' | 'cancel';

export interface PointDef {
  name: string;
  semantics: PointSemantics;
  /** Default hook timeout. */
  timeoutMs: number;
}

/** The v1 HEP catalogue (§5.4). Points may be added; never renamed. */
export const POINTS: Record<string, PointDef> = {
  'harness.start': { name: 'harness.start', semantics: 'observe', timeoutMs: 5000 },
  'harness.stop': { name: 'harness.stop', semantics: 'observe', timeoutMs: 5000 },
  'session.open': { name: 'session.open', semantics: 'observe', timeoutMs: 5000 },
  'session.close': { name: 'session.close', semantics: 'observe', timeoutMs: 5000 },
  'turn.start': { name: 'turn.start', semantics: 'observe', timeoutMs: 5000 },
  'turn.end': { name: 'turn.end', semantics: 'observe', timeoutMs: 5000 },
  'round.start': { name: 'round.start', semantics: 'observe', timeoutMs: 1500 },
  'round.end': { name: 'round.end', semantics: 'observe', timeoutMs: 1500 },
  'tool.call': { name: 'tool.call', semantics: 'cancel', timeoutMs: 1500 },
  'tool.result': { name: 'tool.result', semantics: 'mutate', timeoutMs: 1500 },
  'fs.change': { name: 'fs.change', semantics: 'observe', timeoutMs: 1500 },
  'goal.change': { name: 'goal.change', semantics: 'observe', timeoutMs: 1500 },
  'workspace.bind': { name: 'workspace.bind', semantics: 'observe', timeoutMs: 1500 },
  'workspace.active': { name: 'workspace.active', semantics: 'observe', timeoutMs: 1500 },
  'command.run': { name: 'command.run', semantics: 'cancel', timeoutMs: 5000 },
  'ui.render': { name: 'ui.render', semantics: 'observe', timeoutMs: 1500 },
  // v1 event names kept as aliases so legacy hooks keep firing.
  'message.user': { name: 'message.user', semantics: 'mutate', timeoutMs: 1500 },
  'prompt.build': { name: 'prompt.build', semantics: 'mutate', timeoutMs: 1500 },
  'tools.catalogue': { name: 'tools.catalogue', semantics: 'mutate', timeoutMs: 1500 },
  'compaction.before': { name: 'compaction.before', semantics: 'observe', timeoutMs: 1500 },
  'compaction.after': { name: 'compaction.after', semantics: 'observe', timeoutMs: 1500 },
};

export interface PointOutcome {
  /** A cancel-semantics hook denied the operation; the reason is guided. */
  deny?: string;
  /** A mutate-semantics hook replaced the payload. */
  value?: unknown;
  /** A cancel-semantics hook short-circuited with a ready result. */
  result?: unknown;
  text?: string;
  element?: AddonElement;
}

/** Strip the HEP suffix — points are registered as plain event names. */
function isKnownPoint(name: string): boolean {
  return name in POINTS;
}

/**
 * Emit a harness extension point. Cheap no-op when no hooks are registered.
 * Legacy events (ui.render, command.run, …) are routed to the same chain.
 */
export async function emitPoint(name: string, payload: unknown): Promise<PointOutcome> {
  if (!isKnownPoint(name)) return {};
  if (addonHookCount() === 0) return {};
  // Delegate to the v1 chain (it already handles matchers, per-owner APIs,
  // error isolation). Point semantics are enforced by the CALLER reading the
  // outcome (deny/value/result).
  const { emitAddonEvent } = await import('./registry.js');
  const { createAddonApi } = await import('./api.js');
  try {
    return await emitAddonEvent(name as never, payload, createAddonApi('__harness__'));
  } catch (error) {
    console.error(`[addons] emitPoint(${name}) failed:`, error);
    return {};
  }
}

/** Synchronous fire-and-forget for observe points (fs.change, goal.change…). */
export function emitPointAsync(name: string, payload: unknown): void {
  void emitPoint(name, payload).catch(() => { /* isolated in emitPoint */ });
}

export type { AddonHook, AddonMatcher };
