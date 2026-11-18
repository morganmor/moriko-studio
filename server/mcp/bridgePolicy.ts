
import type { AgentToolDef } from '../agents/tools/shared.js';


const EDIT_TOOLS = new Set([
  'edit_file',
  'multi_edit',
  'write',
  'apply_patch',
  'edit_lines',
  'edit_between',
  'insert_at_line',
]);


const READ_TOOLS = new Set([
  'list',
  'grep',
  'glob',
  'read_file',
  'read_all',
  'read_symbol',
  'batch_read',
  'search',
  'interlinked',
  'screenshot',
]);

export const BRIDGE_TOOL_NAMES = [...READ_TOOLS, ...EDIT_TOOLS];

export function isBridgeExposedTool(name: string): boolean {
  return READ_TOOLS.has(name) || EDIT_TOOLS.has(name);
}

export function isBridgeEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name);
}


export function bridgeHarnessToolDefs(defs: AgentToolDef[]): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean };
}> {
  return defs
    .filter((def) => isBridgeExposedTool(def.wireName.replace(/^agent__/, '')))
    .map((def) => {
      const short = def.wireName.replace(/^agent__/, '');
      return {
        name: short,
        description: def.description,
        inputSchema: def.inputSchema as Record<string, unknown>,
        annotations: { readOnlyHint: !isBridgeEditTool(short) },
      };
    });
}
