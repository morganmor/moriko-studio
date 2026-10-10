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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {loaded && servers.length === 0 && !adding ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
          No MCP servers yet. Add one below (e.g. a local filesystem server) and enable
          "Use MCP" in Configuration to let the model call its tools.
        </p>
      ) : null}

      <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 0, margin: 0, listStyle: 'none' }}>
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
              className="card"
              style={{ borderRadius: 'var(--r-md)', padding: '8px 12px', background: 'rgb(var(--c-canvas))' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>{server.name}</p>
                  <p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--faint)' }}>
                    {server.transport === 'stdio'
                      ? `local · ${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim()
                      : `remote · ${server.url ?? ''}`}
                  </p>
                  {activeCount !== null ? (
                    <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--faint)' }}>
                      {activeCount} of {tools === 'loading' ? '…' : tools.length} tools active
                    </p>
                  ) : null}
                  {test && test !== 'testing' ? (
                    <p style={{ margin: '2px 0 0', fontSize: 11, color: test.ok ? 'rgb(var(--c-ok))' : 'rgb(var(--c-danger))' }}>
                      {test.ok ? `${test.toolCount} tool(s) available` : test.error ?? 'connection failed'}
                    </p>
                  ) : null}
                  {test === 'testing' ? <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--faint)' }}>Testing…</p> : null}
                </div>
                <Tip label="Choose which tools this server exposes to the model" align="end">
                  <button
                    type="button"
                    onClick={() => void togglePanel(server.id)}
                    className={cx('ib sm', panelOpen && 'on')}
                    aria-label={`Tools of ${server.name}`}
                    aria-expanded={panelOpen}
                  >
                    <ListFilter className="ic" aria-hidden="true" />
                  </button>
                </Tip>
                <Tip label="Connect and list its tools" align="end">
                  <button
                    type="button"
                    onClick={() => void handleTest(server.id)}
                    className="ib sm"
                    aria-label={`Test ${server.name}`}
                  >
                    <FlaskConical className="ic" aria-hidden="true" />
                  </button>
                </Tip>
                <button
                  type="button"
                  onClick={async () => {
                    await updateMcpServer(server.id, { enabled: !server.enabled });
                    await refresh();
                  }}
                  className="stat"
                  style={{
                    flexShrink: 0,
                    fontSize: 10,
                    fontWeight: 500,
                    color: server.enabled ? 'rgb(var(--c-ok))' : 'var(--faint)',
                    background: server.enabled ? 'rgb(var(--c-ok) / 0.08)' : 'rgb(var(--c-line))',
                    borderColor: server.enabled ? 'rgb(var(--c-ok) / 0.35)' : 'var(--line)',
                  }}
                >
                  {server.enabled ? 'on' : 'off'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await deleteMcpServer(server.id);
                    await refresh();
                  }}
                  className="ib sm"
                  style={{ flexShrink: 0 }}
                  aria-label={`Delete ${server.name}`}
                >
                  <Trash2 className="ic" aria-hidden="true" />
                </button>
              </div>

              {panelOpen ? (
                <div style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                  {tools === 'loading' ? (
                    <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--faint)' }}>
                      <Loader2 className="ic spin" aria-hidden="true" />
                      Connecting and listing tools…
                    </p>
                  ) : tools.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 11.5, color: 'var(--faint)' }}>
                      No tools discovered — press the flask to test the connection first.
                    </p>
                  ) : (
                    <ul style={{ maxHeight: 224, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 4, padding: '0 4px 0 0', margin: 0, listStyle: 'none' }}>
                      {tools.map((tool) => (
                        <li key={tool.name}>
                          <label style={{ display: 'flex', cursor: 'pointer', alignItems: 'flex-start', gap: 8, borderRadius: 4, padding: '4px', fontSize: 11.5 }}>
                            <input
                              type="checkbox"
                              checked={!tool.disabled}
                              onChange={(event) => void toggleTool(server, tool.name, event.target.checked)}
                              style={{ marginTop: 2, width: 14, height: 14, flexShrink: 0, accentColor: 'rgb(var(--c-accent))' }}
                              aria-label={`${tool.name} enabled`}
                            />
                            <span style={{ minWidth: 0 }}>
                              <span style={{ display: 'block', fontFamily: 'var(--f-mono)', fontSize: 11.5, color: 'rgb(var(--c-ink))' }}>{tool.name}</span>
                              {tool.description ? (
                                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, color: 'var(--faint)' }}>{tool.description}</span>
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
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, borderRadius: 'var(--r-md)', padding: 12, background: 'rgb(var(--c-canvas))' }}>
          <input
            value={form.name}
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="Server name, e.g. Filesystem"
            className="field"
            style={{ fontSize: 12.5 }}
          />
          <div className="chipset">
            {(['stdio', 'http'] as const).map((transport) => (
              <button
                key={transport}
                type="button"
                onClick={() => setForm((prev) => ({ ...prev, transport }))}
                aria-pressed={form.transport === transport}
                className={cx('sc', form.transport === transport && 'on')}
                style={{ flex: 1, justifyContent: 'center' }}
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
                className="field"
                style={{ fontFamily: 'var(--f-mono)', fontSize: 12 }}
              />
              <input
                value={form.args}
                onChange={(event) => setForm((prev) => ({ ...prev, args: event.target.value }))}
                placeholder="Arguments (space separated), e.g. -y @modelcontextprotocol/server-filesystem C:/path"
                className="field"
                style={{ fontFamily: 'var(--f-mono)', fontSize: 12 }}
              />
              <textarea
                value={form.env}
                onChange={(event) => setForm((prev) => ({ ...prev, env: event.target.value }))}
                placeholder={"Optional env vars — one per line:\nAPI_KEY=abc123"}
                rows={2}
                className="field"
                style={{ fontFamily: 'var(--f-mono)', fontSize: 12 }}
              />
            </>
          ) : (
            <>
              <input
                value={form.url}
                onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))}
                placeholder="https://mcp.example.com/mcp"
                className="field"
                style={{ fontFamily: 'var(--f-mono)', fontSize: 12 }}
              />
              <textarea
                value={form.headers}
                onChange={(event) => setForm((prev) => ({ ...prev, headers: event.target.value }))}
                placeholder={"Optional headers — one per line:\nAuthorization: Bearer abc123"}
                rows={2}
                className="field"
                style={{ fontFamily: 'var(--f-mono)', fontSize: 12 }}
              />
            </>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="btn ghost sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={busy || !form.name.trim()}
              className="btn primary sm"
            >
              <Plus className="ic" aria-hidden="true" />
              Add server
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="btn ghost"
          style={{ width: '100%', justifyContent: 'center', borderStyle: 'dashed', fontSize: 12.5 }}
        >
          <Plus className="ic" aria-hidden="true" />
          Add MCP server
        </button>
      )}
    </div>
  );
}
