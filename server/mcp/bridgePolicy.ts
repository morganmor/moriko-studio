/**
 * BRIDGE TOOL POLICY — which harness-native agent tools the MCP bridge
 * exposes to EXTERNAL chat clients (Claude.ai, ChatGPT, Gemini custom apps).
 *
 * Two sets, per the owner's request (2026-10-21): the READ set and the EDIT
 * set. Each external call runs through the REAL dispatcher (`callAgentTool`)
 * with a synthetic context bound to the configured Main Session, so every
 * harness enforcement layer (read-before-edit receipts, workspace jail, vault
 * snapshots, spatial gates, syntax guards) applies to external callers
 * exactly as it does in-chat.
 *
 * Deliberately NOT exposed even though handlers exist: execute-tier tools
 * (run/git/task/exec/test), session-UI tools (goals/todos/checkpoint/undo),
 * browser toolkit (Web Access kill-switch), ask_user/permission channels
 * (no UI to answer), and approval-required tools (stop-sub-agent).
 */
import type { AgentToolDef } from '../agents/tools/shared.js';

/** Tools that mutate the workspace — exposed under the same wire names. */
const EDIT_TOOLS = new Set([
  'edit_file',
  'multi_edit',
  'write',
  'apply_patch',
  'edit_lines',
  'edit_between',
  'insert_at_line',
]);

/** Read/observe tools exposed to external clients. */
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
  'screenshot', // standalone headless capture — inline image, no disk writes
]);

export const BRIDGE_TOOL_NAMES = [...READ_TOOLS, ...EDIT_TOOLS];

export function isBridgeExposedTool(name: string): boolean {
  return READ_TOOLS.has(name) || EDIT_TOOLS.has(name);
}

export function isBridgeEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name);
}

/** Curates the harness catalogue into bridge tool defs (read + edit sets). */
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
