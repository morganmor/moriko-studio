import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Link2 } from './icons';

/**
 * MCP Bridge card inside Settings → MCP. The bridge exposes Council + RSAT
 * agent tools and read-only workspace tools to external MCP clients
 * (claude.ai connectors, Gemini web custom apps). Here the user binds WHICH
 * Main Session acts as the external orchestrator and WHICH workspace the
 * read-only tools jail to — each Main Session has its own unique id.
 */

interface BridgeSession {
  id: string;
  title: string;
  councilRole?: string;
}
interface BridgeWorkspace {
  id: string;
  label: string;
  path: string;
}
interface BridgeSettings {
  token: string;
  sessionId: string;
  workspaceId: string;
  sessions: BridgeSession[];
  workspaces: BridgeWorkspace[];
  effective: { sessionId: string | null; workspacePath: string | null };
}

const fieldStyle = {
  width: '100%',
  fontSize: 12,
  padding: '6px 8px',
  borderRadius: 'var(--r-sm)',
  border: '1px solid var(--line)',
  background: 'rgb(var(--c-canvas))',
  color: 'rgb(var(--c-ink))',
} as const;

export function McpBridgeCard() {
  const [settings, setSettings] = useState<BridgeSettings | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/mcp-bridge');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSettings((await response.json()) as BridgeSettings);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patch = async (body: { sessionId?: string; workspaceId?: string }) => {
    try {
      const response = await fetch('/api/mcp-bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSettings((await response.json()) as BridgeSettings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save');
    }
  };

  const copyUrl = async () => {
    if (!settings) return;
    const url = `${window.location.origin}/mcp/${settings.token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable (http origin) — selection fallback
    }
  };

  if (error && !settings) {
    return <p style={{ margin: 0, fontSize: 12, color: 'rgb(var(--c-danger))' }}>MCP Bridge unavailable — {error}</p>;
  }
  if (!settings) {
    return <p style={{ margin: 0, fontSize: 12, color: 'var(--faint)' }}>Loading bridge settings…</p>;
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, borderRadius: 'var(--r-md)', padding: 12, background: 'rgb(var(--c-canvas))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-ink))', flex: 1 }}>MCP Bridge</p>
        <span
          className="stat"
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: settings.effective.sessionId ? 'rgb(var(--c-ok))' : 'var(--faint)',
            background: settings.effective.sessionId ? 'rgb(var(--c-ok) / 0.08)' : 'rgb(var(--c-line))',
            borderColor: settings.effective.sessionId ? 'rgb(var(--c-ok) / 0.35)' : 'var(--line)',
          }}
        >
          {settings.effective.sessionId ? 'bound' : 'no session'}
        </span>
      </div>

      <p style={{ margin: 0, fontSize: 11.5, color: 'var(--faint)' }}>
        External MCP clients (claude.ai connectors, Gemini web custom apps) call Council & RSAT tools and read workspace files — read-only.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          readOnly
          value={`/mcp/${settings.token}`}
          onFocus={(event) => event.currentTarget.select()}
          className="field"
          style={{ fontFamily: 'var(--f-mono)', fontSize: 11.5, flex: 1, minWidth: 0 }}
          aria-label="MCP bridge endpoint path with token"
        />
        <button type="button" onClick={() => void copyUrl()} className="ib sm" aria-label="Copy full endpoint URL">
          {copied ? <Check className="ic" aria-hidden="true" /> : <Copy className="ic" aria-hidden="true" />}
        </button>
        <a
          href="https://modelcontextprotocol.io/docs/develop/connect-remote-servers"
          target="_blank"
          rel="noreferrer"
          className="ib sm"
          aria-label="Remote MCP docs"
        >
          <Link2 className="ic" aria-hidden="true" />
        </a>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--faint)' }}>
        Main Session (actor for council/rsat tools)
        <select
          value={settings.sessionId}
          onChange={(event) => void patch({ sessionId: event.target.value })}
          style={fieldStyle}
        >
          <option value="">Auto — first council main conversation</option>
          {settings.sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title || session.id}
              {session.councilRole === 'main' ? ' · main' : ''}
            </option>
          ))}
        </select>
        <span style={{ fontFamily: 'var(--f-mono)', fontSize: 10 }}>
          {settings.effective.sessionId ? `active: ${settings.effective.sessionId}` : 'not bound'}
        </span>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--faint)' }}>
        Workspace (root for read-only ws_* tools)
        <select
          value={settings.workspaceId}
          onChange={(event) => void patch({ workspaceId: event.target.value })}
          style={fieldStyle}
        >
          <option value="">Auto — Moriko's active workspace</option>
          {settings.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.label} — {workspace.path}
            </option>
          ))}
        </select>
        <span style={{ fontFamily: 'var(--f-mono)', fontSize: 10 }}>
          {settings.effective.workspacePath ? `active: ${settings.effective.workspacePath}` : 'no workspace bound'}
        </span>
      </label>
    </div>
  );
}
