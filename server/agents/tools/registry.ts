/**
 * F0 — Unified tool registry: ONE place where a tool's definition AND its
 * operational metadata (readOnly / web / terminal / category) live together.
 *
 * New tools defined via defineTool() are picked up automatically by:
 *  - catalogue.ts  (defs appended in listAgentToolDefs)
 *  - dispatcher.ts (handler called before the legacy switch)
 *  - mcp/loop.ts   (readOnly → parallel-safe)
 *  - web-access.ts / terminal.ts (gates)
 *
 * Migrating the LEGACY tools into the registry is a follow-up, out of scope:
 * the switch dispatcher keeps serving them.
 */
import type { AgentToolDef, AgentToolContext, HarnessToolResult } from './shared.js';

export type ToolCategory =
  | 'read' | 'edit' | 'nav' | 'quality' | 'arch' | 'game' | 'ui'
  | 'orchestration' | 'web' | 'misc';

export interface ToolSpec {
  /** Wire name (agent__*), description (ONE line), inputSchema. */
  def: AgentToolDef;
  handler: (args: Record<string, unknown>, ctx: AgentToolContext) => Promise<HarnessToolResult>;
  /** Safe to run in parallel in the loop (read-only, no side effects). */
  readOnly?: boolean;
  /** Gated by the Web Access kill-switch. */
  web?: boolean;
  /** Gated by Terminal mode. */
  terminal?: boolean;
  category: ToolCategory;
}

/** Registry key: bare tool name (without the agent__ prefix). */
const registry = new Map<string, ToolSpec>();

/** Side-effect list used by tools/index.ts to force-load all defineTool modules. */
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
