
import type { AgentToolDef, AgentToolContext, HarnessToolResult } from './shared.js';

export type ToolCategory =
  | 'read' | 'edit' | 'nav' | 'quality' | 'arch' | 'game' | 'ui'
  | 'orchestration' | 'web' | 'misc';

export interface ToolSpec {
  
  def: AgentToolDef;
  handler: (args: Record<string, unknown>, ctx: AgentToolContext) => Promise<HarnessToolResult>;
  
  readOnly?: boolean;
  
  web?: boolean;
  
  terminal?: boolean;
  category: ToolCategory;
}


const registry = new Map<string, ToolSpec>();


export const registeredModules: string[] = [];

export function defineTool(spec: ToolSpec): ToolSpec {
  const bare = spec.def.wireName.replace(/^agent__/, '');
  if (registry.has(bare)) {
    throw new Error(`defineTool: "${spec.def.wireName}" already registered`);
  }
  registry.set(bare, spec);
  return spec;
}

export function registeredTools(): ToolSpec[] {
  return [...registry.values()];
}

export function toolByName(wireNameOrBare: string): ToolSpec | undefined {
  return registry.get(wireNameOrBare.replace(/^agent__/, ''));
}
