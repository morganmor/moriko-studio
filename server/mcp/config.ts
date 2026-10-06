import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { atomicWriteJson } from '../atomicWrite.js';
import { mcpFile } from '../paths.js';

/**
 * Persisted configuration for MCP servers the user registered in Settings.
 *
 * Two transports (MCP spec 2026-07-28):
 *  - `stdio`  — LOCAL server: the proxy spawns `command args…` and speaks
 *               JSON-RPC over the process's stdin/stdout.
 *  - `http`   — REMOTE server: Streamable HTTP (POST JSON-RPC, optional
 *               session id, SSE or JSON responses), auth via static headers.
 *
 * `headers` may hold secrets; everything that leaves the server is masked
 * (see `maskServers`) — full values are used internally only.
 *
 * Stored at `~/.moriko/mcp.json` (see paths.ts) — machine-level config that
 * survives a fresh checkout of the repo.
 */

const CONFIG_FILE = mcpFile;

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  /** stdio only: executable and arguments. */
  command?: string;
  args?: string[];
  /** stdio only: extra environment variables for the child process. */
  env?: Record<string, string>;
  /** http only: the endpoint URL. */
  url?: string;
  /** http only: static auth headers (may contain secrets). */
  headers?: Record<string, string>;
  /**
   * Tool names the user switched OFF for this server — they are filtered out
   * of the catalogue offered to the model entirely.
   */
  disabledTools?: string[];
  createdAt: string;
}

export interface McpConfigFile {
  version: 1;
  servers: McpServerConfig[];
}

const EMPTY: McpConfigFile = { version: 1, servers: [] };

let cache: McpConfigFile | null = null;

function load(): McpConfigFile {
  if (cache) return cache;
  try {
    if (existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as McpConfigFile;
      cache = {
        version: 1,
        servers: Array.isArray(parsed.servers) ? parsed.servers : [],
      };
      return cache;
    }
  } catch {
  }
  cache = { ...EMPTY };
  return cache;
}

function persist(next: McpConfigFile): void {
  cache = next;
  atomicWriteJson(CONFIG_FILE, next);
}

export function listServers(): McpServerConfig[] {
  return load().servers;
}

export function getServer(id: string): McpServerConfig | undefined {
  return load().servers.find((server) => server.id === id);
}

/**
 * Merges user-submitted env/headers with the stored ones: masked sentinel
 * values ('***' from a GET) mean "unchanged" and keep the real secret.
 */
function mergeSecrets(
  incoming: Record<string, string> | undefined,
  existing: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!incoming) return undefined;
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = value === '***' && existing ? existing[key] ?? value : value;
  }
  return merged;
}

export function upsertServer(
  input: Partial<McpServerConfig> & { name: string; transport: McpTransport },
): McpServerConfig {
  const store = load();
  const existing = input.id ? store.servers.find((server) => server.id === input.id) : undefined;
  const server: McpServerConfig = {
    id: existing?.id ?? randomUUID(),
    name: input.name.trim() || existing?.name || 'MCP server',
    transport: input.transport === 'http' ? 'http' : 'stdio',
    enabled: input.enabled ?? existing?.enabled ?? true,
    command: input.transport === 'stdio' ? input.command?.trim() || existing?.command : undefined,
    args: input.transport === 'stdio' ? input.args ?? existing?.args ?? [] : undefined,
    env:
      input.transport === 'stdio'
        ? mergeSecrets(input.env ?? existing?.env, existing?.env)
        : undefined,
    url: input.transport === 'http' ? input.url?.trim() || existing?.url : undefined,
    headers:
      input.transport === 'http'
        ? mergeSecrets(input.headers ?? existing?.headers, existing?.headers)
        : undefined,
    disabledTools: Array.isArray(input.disabledTools)
      ? input.disabledTools.map(String)
      : existing?.disabledTools,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  const servers = existing
    ? store.servers.map((entry) => (entry.id === server.id ? server : entry))
    : [...store.servers, server];
  persist({ version: 1, servers });
  return server;
}

export function removeServer(id: string): boolean {
  const store = load();
  const servers = store.servers.filter((server) => server.id !== id);
  if (servers.length === store.servers.length) return false;
  persist({ version: 1, servers });
  return true;
}

/** Secrets never reach the browser: header values render as masked stubs. */
function maskServers(servers: McpServerConfig[]): McpServerConfig[] {
  return servers.map((server) => ({
    ...server,
    env: server.env
      ? Object.fromEntries(Object.entries(server.env).map(([key]) => [key, '***']))
      : undefined,
    headers: server.headers
      ? Object.fromEntries(Object.entries(server.headers).map(([key]) => [key, '***']))
      : undefined,
  }));
}

export function listServersMasked(): McpServerConfig[] {
  return maskServers(listServers());
}

export function getServerMasked(id: string): McpServerConfig | undefined {
  const found = getServer(id);
  return found ? maskServers([found])[0] : undefined;
}
