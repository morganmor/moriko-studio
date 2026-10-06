import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, ListFilter, Loader2, Plus, Trash2 } from './icons';

import {
  addMcpServer,
  deleteMcpServer,
  listMcpServers,
  listServerTools,
  testMcpServer,
  updateMcpServer,
  type McpServerTool,
} from '../lib/api';
import { Tip, cx } from './ui';

/**
 * MCP server manager inside Settings. Users register tool servers here —
 * a LOCAL one runs as a command the proxy spawns (stdio), a REMOTE one is
 * a Streamable HTTP endpoint with optional auth headers.
 *
 * Each row has a tools panel: the server's discovered tools with per-tool
 * on/off checkboxes. Disabled tools are filtered out of the catalogue the
 * model receives.
 */

interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  enabled: boolean;
  command?: string;
  args?: string[];
  url?: string;
  disabledTools?: string[];
}

type TestState = { ok: boolean; toolCount: number; error?: string };

/** "KEY=VALUE" or "Key: Value" per line → object; blank lines ignored. */
function parsePairBlock(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.includes('=') ? '=' : ':';
    const at = trimmed.indexOf(separator);
    if (at <= 0) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

export function McpServersCard() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: '',
    transport: 'stdio' as 'stdio' | 'http',
    command: '',
    args: '',
    env: '',
    url: '',
    headers: '',
  });
  const [testStates, setTestStates] = useState<Record<string, TestState | 'testing'>>({});
  const [busy, setBusy] = useState(false);
  /** Per-server tools panel: which are open, and their tool list. */
  const [openPanels, setOpenPanels] = useState<Set<string>>(new Set());
  const [toolsByServer, setToolsByServer] = useState<Record<string, McpServerTool[] | 'loading'>>({});

  const refresh = useCallback(async () => {
    try {
      const { servers: list } = await listMcpServers();
      setServers(list);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleAdd = async () => {
    if (!form.name.trim() || busy) return;
    setBusy(true);
    try {
      await addMcpServer({
        name: form.name.trim(),
        transport: form.transport,
        ...(form.transport === 'stdio'
          ? { command: form.command.trim(), args: form.args.split(/\s+/).filter(Boolean), env: parsePairBlock(form.env) }
          : { url: form.url.trim(), headers: parsePairBlock(form.headers) }),
        enabled: true,
      });
      setForm({ name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '' });
      setAdding(false);
      await refresh();
    } catch {
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async (id: string) => {
    setTestStates((prev) => ({ ...prev, [id]: 'testing' }));
    try {
      const result = await testMcpServer(id);
      setTestStates((prev) => ({ ...prev, [id]: result }));
    } catch (error) {
      setTestStates((prev) => ({
        ...prev,
        [id]: { ok: false, toolCount: 0, error: error instanceof Error ? error.message : 'test failed' },
      }));
    }
  };

  /** Opens (or closes) the per-server tools panel, loading the tool list. */
  const togglePanel = async (id: string) => {
    setOpenPanels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!toolsByServer[id]) {
      setToolsByServer((prev) => ({ ...prev, [id]: 'loading' }));
      try {
        const tools = await listServerTools(id);
        setToolsByServer((prev) => ({ ...prev, [id]: tools }));
      } catch {
        setToolsByServer((prev) => ({ ...prev, [id]: [] }));
      }
    }
  };

  /** Flips one tool on/off: optimistically update, then persist the full list. */
  const toggleTool = async (server: McpServer, toolName: string, enabled: boolean) => {
    const current = toolsByServer[server.id];
    if (!current || current === 'loading') return;
    const next = current.map((tool) =>
      tool.name === toolName ? { ...tool, disabled: !enabled } : tool,
    );
    setToolsByServer((prev) => ({ ...prev, [server.id]: next }));
    try {
      await updateMcpServer(server.id, {
        disabledTools: next.filter((tool) => tool.disabled).map((tool) => tool.name),
      });
      await refresh();
    } catch {
      setToolsByServer((prev) => ({ ...prev, [server.id]: current }));
    }
  };

  return (
    <div className="space-y-3">
      {loaded && servers.length === 0 && !adding ? (
        <p className="text-[12px] text-muted">
          No MCP servers yet. Add one below (e.g. a local filesystem server) and enable
          "Use MCP" in Configuration to let the model call its tools.
        </p>
      ) : null}

      <ul className="space-y-2">
        {servers.map((server) => {
          const test = testStates[server.id];
          const tools = toolsByServer[server.id];
          const panelOpen = openPanels.has(server.id);
          const activeCount = tools && tools !== 'loading'
            ? tools.filter((tool) => !tool.disabled).length
            : null;
          return (
            <li
              key={server.id}
              className="rounded-control border border-hairline bg-canvas px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink">{server.name}</p>
                  <p className="truncate text-[11px] text-faint">
                    {server.transport === 'stdio'
                      ? `local · ${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim()
                      : `remote · ${server.url ?? ''}`}
                  </p>
                  {activeCount !== null ? (
                    <p className="mt-0.5 text-[11px] text-faint">
                      {activeCount} of {tools === 'loading' ? '…' : tools.length} tools active
                    </p>
                  ) : null}
                  {test && test !== 'testing' ? (
                    <p className={cx('mt-0.5 text-[11px]', test.ok ? 'text-success' : 'text-danger')}>
                      {test.ok ? `${test.toolCount} tool(s) available` : test.error ?? 'connection failed'}
                    </p>
                  ) : null}
                  {test === 'testing' ? <p className="mt-0.5 text-[11px] text-faint">Testing…</p> : null}
                </div>
                <Tip label="Choose which tools this server exposes to the model" align="end">
                  <button
                    type="button"
                    onClick={() => void togglePanel(server.id)}
                    className={cx('icon-button h-7 w-7', panelOpen && 'text-accent')}
                    aria-label={`Tools of ${server.name}`}
                    aria-expanded={panelOpen}
                  >
                    <ListFilter className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </Tip>
                <Tip label="Connect and list its tools" align="end">
                  <button
                    type="button"
                    onClick={() => void handleTest(server.id)}
                    className="icon-button h-7 w-7"
                    aria-label={`Test ${server.name}`}
                  >
                    <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </Tip>
                <button
                  type="button"
                  onClick={async () => {
                    await updateMcpServer(server.id, { enabled: !server.enabled });
                    await refresh();
                  }}
                  className={cx(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                    server.enabled ? 'bg-success/15 text-success' : 'bg-hairline text-faint',
                  )}
                >
                  {server.enabled ? 'on' : 'off'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await deleteMcpServer(server.id);
                    await refresh();
                  }}
                  className="icon-button h-7 w-7 shrink-0"
                  aria-label={`Delete ${server.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>

              {panelOpen ? (
                <div className="mt-2 border-t border-hairline pt-2">
                  {tools === 'loading' ? (
                    <p className="flex items-center gap-1.5 text-[11.5px] text-faint">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      Connecting and listing tools…
                    </p>
                  ) : tools.length === 0 ? (
                    <p className="text-[11.5px] text-faint">
                      No tools discovered — press the flask to test the connection first.
                    </p>
                  ) : (
                    <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
                      {tools.map((tool) => (
                        <li key={tool.name}>
                          <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 transition-colors hover:bg-surface">
                            <input
                              type="checkbox"
                              checked={!tool.disabled}
                              onChange={(event) => void toggleTool(server, tool.name, event.target.checked)}
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                              aria-label={`${tool.name} enabled`}
                            />
                            <span className="min-w-0">
                              <span className="block font-mono text-[11.5px] text-ink">{tool.name}</span>
                              {tool.description ? (
                                <span className="block truncate text-[10.5px] text-faint">{tool.description}</span>
                              ) : null}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className="space-y-2 rounded-control border border-hairline bg-canvas p-3">
          <input
            value={form.name}
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="Server name, e.g. Filesystem"
            className="field text-[12.5px]"
          />
          <div className="flex gap-2">
            {(['stdio', 'http'] as const).map((transport) => (
              <button
                key={transport}
                type="button"
                onClick={() => setForm((prev) => ({ ...prev, transport }))}
                aria-pressed={form.transport === transport}
                className={cx(
                  'pill-button flex-1 justify-center border text-[12px] transition-colors',
                  form.transport === transport
                    ? 'border-accent/60 bg-accent-soft text-ink'
                    : 'border-hairline text-muted hover:text-ink',
                )}
              >
                {transport === 'stdio' ? 'Local command' : 'Remote URL'}
              </button>
            ))}
          </div>

          {form.transport === 'stdio' ? (
            <>
              <input
                value={form.command}
                onChange={(event) => setForm((prev) => ({ ...prev, command: event.target.value }))}
                placeholder="Command, e.g. npx"
                className="field font-mono text-[12px]"
              />
              <input
                value={form.args}
                onChange={(event) => setForm((prev) => ({ ...prev, args: event.target.value }))}
                placeholder="Arguments (space separated), e.g. -y @modelcontextprotocol/server-filesystem C:/path"
                className="field font-mono text-[12px]"
              />
              <textarea
                value={form.env}
                onChange={(event) => setForm((prev) => ({ ...prev, env: event.target.value }))}
                placeholder={"Optional env vars — one per line:\nAPI_KEY=abc123"}
                rows={2}
                className="field font-mono text-[12px]"
              />
            </>
          ) : (
            <>
              <input
                value={form.url}
                onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))}
                placeholder="https://mcp.example.com/mcp"
                className="field font-mono text-[12px]"
              />
              <textarea
                value={form.headers}
                onChange={(event) => setForm((prev) => ({ ...prev, headers: event.target.value }))}
                placeholder={"Optional headers — one per line:\nAuthorization: Bearer abc123"}
                rows={2}
                className="field font-mono text-[12px]"
              />
            </>
          )}

          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="pill-button border border-hairline text-[12px] text-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={busy || !form.name.trim()}
              className="pill-button bg-accent text-[12px] font-medium text-accent-ink transition-opacity disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add server
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="pill-button w-full justify-center border border-dashed border-hairline text-[12px] font-medium text-muted transition-colors hover:border-accent/50 hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add MCP server
        </button>
      )}
    </div>
  );
}
