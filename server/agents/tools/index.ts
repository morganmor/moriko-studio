/**
 * Built-in agent harness tools: list, grep, read_file, edit_file, rename,
 * move (cut), copy, delete, and 20+ more.
 *
 * ENTRY POINT — `server/agents/tools.js` resolves to THIS file (the directory
 * index). The implementations live in the sibling modules (one file per tool
 * group), the catalogue in ./catalogue.ts, and the dispatch switch in
 * ./dispatcher.ts. The public surface the four consumers depend on
 * (routes.ts, systemPrompt.ts, journal.ts, mcp/loop.ts) is unchanged:
 *
 *   - listAgentToolDefs()  — the 92-tool catalogue
 *   - callAgentTool()      — the dispatcher (never throws)
 *   - isTerminalTool()     — terminal-mode catalogue filter
 *   - isWebTool()          — Web Access kill-switch catalogue filter
 *   - types: AgentToolDef, ToolImage, HarnessToolResult, AgentToolContext
 *
 * The tools speak the same result shape as MCP (`{ ok, text, isError }`) so
 * `server/mcp/loop.ts` can execute them through one code path, and the wire
 * names carry the `agent__` prefix (mirroring `mcp__<server>__<tool>`) so the
 * loop can dispatch them without a registry lookup.
 *
 * Safety posture:
 *  - Operations inside the ACTIVE workspace root run freely.
 *  - Any operation that resolves OUTSIDE the root pauses and waits for an
 *    explicit user decision (see permissions.ts) — fails closed.
 *  - Shell execution via the native system terminal (cmd.exe on Windows,
 *    /bin/sh on Unix): the agent has full shell access. The workspace-write
 *    sandbox clamps cwd and scrubs secrets; the workspace root itself can
 *    never be deleted or moved.
 */

export type { AgentToolDef, ToolImage, HarnessToolResult, AgentToolContext } from './shared.js';

export { listAgentToolDefs } from './catalogue.js';
export { callAgentTool } from './dispatcher.js';

export { isTerminalTool } from './terminal.js';
export { isWebTool } from './web-access.js';

export { harnessReloadNow } from '../reload.js';
