

import type { AddonElement, AddonHook, AddonMatcher } from './types.js';
import { addonHookCount } from './registry.js';

export type PointSemantics = 'observe' | 'mutate' | 'cancel';

export interface PointDef {
  name: string;
  semantics: PointSemantics;
  
  timeoutMs: number;
}


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
  'message.user': { name: 'message.user', semantics: 'mutate', timeoutMs: 1500 },
  'prompt.build': { name: 'prompt.build', semantics: 'mutate', timeoutMs: 1500 },
  'tools.catalogue': { name: 'tools.catalogue', semantics: 'mutate', timeoutMs: 1500 },
  'compaction.before': { name: 'compaction.before', semantics: 'observe', timeoutMs: 1500 },
  'compaction.after': { name: 'compaction.after', semantics: 'observe', timeoutMs: 1500 },
};

export interface PointOutcome {
  
  deny?: string;
  
  value?: unknown;
  
  result?: unknown;
  text?: string;
  element?: AddonElement;
}


function isKnownPoint(name: string): boolean {
  return name in POINTS;
}


export async function emitPoint(name: string, payload: unknown): Promise<PointOutcome> {
  if (!isKnownPoint(name)) return {};
  if (addonHookCount() === 0) return {};
  const { emitAddonEvent } = await import('./registry.js');
  const { createAddonApi } = await import('./api.js');
  try {
    return await emitAddonEvent(name as never, payload, createAddonApi('__harness__'));
  } catch (error) {
    console.error(`[addons] emitPoint(${name}) failed:`, error);
    return {};
  }
}


export function emitPointAsync(name: string, payload: unknown): void {
  void emitPoint(name, payload).catch(() => {  });
}

export type { AddonHook, AddonMatcher };
