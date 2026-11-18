
import type { AgentToolDef } from './shared.js';
import { toolByName } from './registry.js';
import './registered.js';


const WEB_MISC = new Set(['agent__fetch', 'agent__download']);


export function isWebTool(wireName: string): boolean {
  return wireName.startsWith('agent__browser_') || WEB_MISC.has(wireName) || toolByName(wireName)?.web === true;
}


export function withoutWebTools(defs: AgentToolDef[]): AgentToolDef[] {
  return defs.filter((def) => !isWebTool(def.wireName));
}
