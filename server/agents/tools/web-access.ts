/**
 * isWebTool() — catalogue + dispatch filter for the Web Access kill-switch.
 *
 * True for every tool that reaches the PUBLIC web: the 70 agent__browser_*
 * tools, agent__fetch and agent__download. Controlled by settings.webAccess
 * (default OFF): off = these tools leave the catalogue entirely and the
 * dispatcher refuses direct/nested calls (see dispatcher.ts guard).
 */
import type { AgentToolDef } from './shared.js';
import { toolByName } from './registry.js';
import './registered.js';

/** Wire names outside the browser block that still reach the public web. */
const WEB_MISC = new Set(['agent__fetch', 'agent__download']);

/** Exported for the loop's tool catalogue filter (Web Access setting). */
export function isWebTool(wireName: string): boolean {
  return wireName.startsWith('agent__browser_') || WEB_MISC.has(wireName) || toolByName(wireName)?.web === true;
}

/** Convenience: filter a defs array down to the non-web subset (or keep all). */
export function withoutWebTools(defs: AgentToolDef[]): AgentToolDef[] {
  return defs.filter((def) => !isWebTool(def.wireName));
}
