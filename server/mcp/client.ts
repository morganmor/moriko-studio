import { spawn, type ChildProcess } from 'node:child_process';
import { coerceText } from '../textUtil.js';
import { LivenessTimeout, deadline, withDeadline } from '../liveness.js';

/**
 * Minimal MCP client — the protocol subset Moriko needs:
 *   initialize → notifications/initialized → tools/list → tools/call
 *
 * Two transports (spec 2026-07-28):
 *  - `McpStdioClient`: spawns the local server, newline-delimited JSON-RPC
 *    over stdin/stdout (the standard MCP stdio framing).
 *  - `McpHttpClient`: Streamable HTTP — POST the JSON-RPC message, accept
 *    either a JSON response or an SSE stream, honour `Mcp-Session-Id`.
 *
 * Deliberately dependency-free: the surface above is small, stable, and
 * keeps the proxy's install footprint untouched.
 */

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  ok: boolean;
  /** Concatenated text content; empty when the tool returned nothing. */
  text: string;
  isError: boolean;
}

export interface McpClient {
  /** Establishes the session (initialize handshake) and returns tool defs. */
  connect(): Promise<McpToolDef[]>;
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 60_000;

function nextId(): number {
  return Math.floor(Math.random() * 1_000_000) + 1;
}

function extractText(result: { content?: Array<{ type?: string; text?: unknown }>; isError?: boolean }): McpToolResult {
  const text = (result.content ?? [])
    .map((part) => (part.type === 'text' ? (coerceText(part.text) ?? '') : ''))
    .filter(Boolean)
    .join('\n');
  return { ok: !result.isError, text, isError: result.isError === true };
}


export class McpStdioClient implements McpClient {
  private child: ChildProcess | null = null;
  private buffer = '';
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private stderrTail: string[] = [];
  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string> | undefined;
  private readonly label: string;

  constructor(
    command: string,
    args: string[],
    env: Record<string, string> | undefined,
    label: string,
  ) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.label = label;
  }

  async connect(): Promise<McpToolDef[]> {
    let command = this.command;
    let args = [...this.args];
    if (process.platform === 'win32' && /^(npx|npm|pnpm|yarn)(\.cmd)?$/i.test(command)) {
      args = ['/c', command.replace(/\.cmd$/i, ''), ...args];
      command = 'cmd';
    }

    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.env ?? {}) },
      shell: false,
      windowsHide: true,
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = [...this.stderrTail.slice(-9), chunk.trim()];
    });
    this.child.on('exit', (code) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`${this.label} exited (code ${code ?? 'signal'})`));
      }
      this.pending.clear();
    });

    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'moriko', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return this.listTools();
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.startsWith('{')) {
        try {
          const message = JSON.parse(line) as {
            id?: number;
            result?: unknown;
            error?: { message?: string };
          };
          const id = message.id;
          if (typeof id === 'number') {
            const pending = this.pending.get(id);
            if (pending) {
              this.pending.delete(id);
              if (message.error) pending.reject(new Error(message.error.message ?? 'MCP error'));
              else pending.resolve(message.result);
            }
          }
        } catch {
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    this.child?.stdin?.write(`${payload}\n`);
  }

  private rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = nextId();
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    return withDeadline(REQUEST_TIMEOUT_MS, 'MCP_RPC_TIMEOUT', (signal) =>
      new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
          this.pending.delete(id);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new LivenessTimeout('MCP_RPC_TIMEOUT', REQUEST_TIMEOUT_MS),
          );
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        this.pending.set(id, {
          resolve: (value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value as T);
          },
          reject: (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        });
        this.child?.stdin?.write(`${payload}\n`);
      }),
    );
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = await this.rpc<{ tools?: McpToolDef[] }>('tools/list', {});
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.rpc<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }>(
      'tools/call',
      { name, arguments: args },
    );
    return extractText(result);
  }

  async close(): Promise<void> {
    this.child?.kill();
    this.child = null;
  }

  lastStderr(): string {
    return this.stderrTail.join('\n').slice(-600);
  }
}


export class McpHttpClient implements McpClient {
  private sessionId: string | null = null;
  private readonly url: string;
  private readonly headers: Record<string, string> | undefined;
  private readonly label: string;

  constructor(
    url: string,
    headers: Record<string, string> | undefined,
    label: string,
  ) {
    this.url = url;
    this.headers = headers;
    this.label = label;
  }

  private async post(body: Record<string, unknown>, expectResponse: boolean): Promise<unknown> {
    const bound = deadline(undefined, REQUEST_TIMEOUT_MS, 'MCP_HTTP_TIMEOUT');
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        signal: bound.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...(this.headers ?? {}),
        },
        body: JSON.stringify(body),
      });

      const session = response.headers.get('Mcp-Session-Id');
      if (session) this.sessionId = session;

      if (response.status === 202 || !expectResponse) {
        await response.arrayBuffer().catch(() => undefined);
        return null;
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`${this.label} HTTP ${response.status}: ${detail.slice(0, 200)}`);
      }
      return await this.readResponse(response);
    } finally {
      bound.clear();
    }
  }

  /** Parses one MCP HTTP response body: plain JSON, or a single-message SSE stream. */
  private async readResponse(response: Response): Promise<unknown> {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const raw = await response.text();
      for (const frame of raw.split('\n\n')) {
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) {
            try {
              const message = JSON.parse(line.slice(5).trim()) as {
                id?: number;
                result?: unknown;
                error?: { message?: string };
              };
              if (message.result !== undefined || message.error) {
                if (message.error) {
                  throw new Error(coerceText(message.error.message) ?? 'MCP error');
                }
                return message.result;
              }
            } catch (error) {
              if (error instanceof SyntaxError) continue;
              throw error;
            }
          }
        }
      }
      return null;
    }

    const message = (await response.json()) as { result?: unknown; error?: { message?: unknown } };
    if (message.error) throw new Error(coerceText(message.error.message) ?? 'MCP error');
    return message.result;
  }

  async connect(): Promise<McpToolDef[]> {
    const result = await this.post(
      {
        jsonrpc: '2.0',
        id: nextId(),
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'moriko', version: '1.0.0' },
        },
      },
      true,
    ) as { serverInfo?: { name?: string } } | null;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false).catch(() => null);
    void result;
    return this.listTools();
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = await this.post(
      { jsonrpc: '2.0', id: nextId(), method: 'tools/list', params: {} },
      true,
    ) as { tools?: McpToolDef[] } | null;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.post(
      { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name, arguments: args } },
      true,
    ) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null;
    return extractText(result ?? {});
  }

  async close(): Promise<void> {
    this.sessionId = null;
  }
}
