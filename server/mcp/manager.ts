import type { McpServerConfig } from './config.js';
import { getServer, listServers } from './config.js';
import { McpHttpClient, McpStdioClient, type McpClient, type McpToolDef, type McpToolResult } from './client.js';

export { listServersMasked } from './config.js';

/**
 * The MCP host: one client per ENABLED server, tool discovery aggregated
 * across servers, and namespaced wire names so two servers can both expose
 * `read_file` without colliding.
 *
 * Wire name format: `mcp__<serverName>__<toolName>` (server names are
 * sanitized to [a-zA-Z0-9_-]).
 */

export type McpStatus = 'off' | 'connected' | 'error';

interface McpConnection {
  client: McpClient;
  tools: McpToolDef[];
  status: McpStatus;
  error?: string;
  toolCount: number;
}

const connections = new Map<string, McpConnection>();
const CALL_TIMEOUT_MS = 90_000;

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'server';
}

function createClient(config: McpServerConfig): McpClient {
  if (config.transport === 'http') {
    if (!config.url) throw new Error('Remote MCP server has no URL.');
    return new McpHttpClient(config.url, config.headers ?? {}, config.name);
  }
  if (!config.command) throw new Error('Local MCP server has no command.');
  return new McpStdioClient(config.command, config.args ?? [], config.env, config.name);
}

/** Connects (or refreshes) one server; the Settings "Test" + tools route use it. */
export async function ensureConnection(config: McpServerConfig): Promise<McpConnection> {
  const existing = connections.get(config.id);
  if (existing && existing.status === 'connected') return existing;

  await connections.get(config.id)?.client.close().catch(() => undefined);
  connections.delete(config.id);

  if (!config.enabled) {
    const off: McpConnection = { client: null as unknown as McpClient, tools: [], status: 'off', toolCount: 0 };
    connections.set(config.id, off);
    return off;
  }

  try {
    const client = createClient(config);
    const tools = await client.connect();
    const connection: McpConnection = { client, tools, status: 'connected', toolCount: tools.length };
    connections.set(config.id, connection);
    return connection;
  } catch (error) {
    const connection: McpConnection = {
      client: null as unknown as McpClient,
      tools: [],
      status: 'error',
      error: error instanceof Error ? error.message : 'connection failed',
      toolCount: 0,
    };
    connections.set(config.id, connection);
    throw error;
  }
}

/** Connects (or refreshes) one server and reports its tools — Settings "Test". */
export async function testServer(id: string): Promise<{ ok: boolean; toolCount: number; error?: string }> {
  const config = getServer(id);
  if (!config) return { ok: false, toolCount: 0, error: 'Unknown MCP server.' };
  try {
    const connection = await ensureConnection(config);
    return { ok: connection.status === 'connected', toolCount: connection.toolCount };
  } catch (error) {
    return {
      ok: false,
      toolCount: 0,
      error: error instanceof Error ? error.message : 'connection failed',
    };
  }
}

export interface McpWireTool {
  wireName: string;
  serverId: string;
  serverName: string;
  toolName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Tools the user switched OFF for a server are excluded from the catalogue. */
function isToolDisabled(config: McpServerConfig, toolName: string): boolean {
  return Array.isArray(config.disabledTools) && config.disabledTools.includes(toolName);
}

/**
 * Aggregated tool catalogue across every enabled+connected server. Failures
 * of individual servers are reported in the status map, not thrown — one bad
 * server must not disable the rest. Per-server disabled tools are filtered
 * out here, so the model never even sees them.
 */
export async function listWireTools(): Promise<{ tools: McpWireTool[]; statuses: Record<string, { status: McpStatus; error?: string; toolCount: number }> }> {
  const tools: McpWireTool[] = [];
  const statuses: Record<string, { status: McpStatus; error?: string; toolCount: number }> = {};

  for (const config of listServers()) {
    if (!config.enabled) {
      statuses[config.id] = { status: 'off', toolCount: 0 };
      continue;
    }
    try {
      const connection = await ensureConnection(config);
      const activeTools = connection.tools.filter((tool) => !isToolDisabled(config, tool.name));
      for (const tool of activeTools) {
        tools.push({
          wireName: `mcp__${sanitizeName(config.name)}__${tool.name}`,
          serverId: config.id,
          serverName: config.name,
          toolName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
      statuses[config.id] = { status: connection.status, toolCount: activeTools.length };
    } catch (error) {
      statuses[config.id] = {
        status: 'error',
        error: error instanceof Error ? error.message : 'connection failed',
        toolCount: 0,
      };
    }
  }
  return { tools, statuses };
}

/** Executes one tool by its namespaced wire name. Never throws. */
export async function callWireTool(wireName: string, args: Record<string, unknown>): Promise<McpToolResult & { serverName: string; toolName: string }> {
  const { tools } = await listWireTools();
  const tool = tools.find((entry) => entry.wireName === wireName);
  if (!tool) {
    return { ok: false, text: `Unknown tool "${wireName}" — the MCP server may have disconnected.`, isError: true, serverName: '?', toolName: wireName };
  }
  const config = getServer(tool.serverId);
  if (!config) {
    return { ok: false, text: `MCP server for "${wireName}" was removed.`, isError: true, serverName: '?', toolName: tool.toolName };
  }

  try {
    const connection = await ensureConnection(config);
    const result = await Promise.race([
      connection.client.callTool(tool.toolName, args),
      new Promise<McpToolResult>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${tool.toolName}" timed out after 90s`)), CALL_TIMEOUT_MS),
      ),
    ]);
    return { ...result, serverName: config.name, toolName: tool.toolName };
  } catch (error) {
    return {
      ok: false,
      text: error instanceof Error ? error.message : 'tool call failed',
      isError: true,
      serverName: config.name,
      toolName: tool.toolName,
    };
  }
}

export async function dropConnection(id: string): Promise<void> {
  await connections.get(id)?.client.close().catch(() => undefined);
  connections.delete(id);
}

/** Server shutdown: kill every spawned stdio child. */
export async function shutdownAll(): Promise<void> {
  for (const connection of connections.values()) {
    await connection.client.close().catch(() => undefined);
  }
  connections.clear();
}
