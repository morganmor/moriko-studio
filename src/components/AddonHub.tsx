/**
 * AddonHub (Addon v2, A6) — the full-page addon manager (ViewId = 'addons').
 *
 * Tabs: Installed · Permissions · Logs. The right dock's "Addons" tab stays as
 * a shortcut that opens this Hub. All data comes from GET /api/addons (the
 * registry's client entries carry status/permissions/logs metadata); actions
 * POST the existing routes (toggle/reload/permissions). Themed components
 * only — no native alert/confirm (deletes confirm through Modal).
 */

import { memo, useCallback, useEffect, useState } from 'react';

import { Modal, RightDockCloseButton, RightDockSlot, cx } from './ui';
import { useStore } from '../store/useStore';
import type { AddonClientEntry } from '../types/addon';

type HubTab = 'installed' | 'permissions' | 'logs';

function statusTone(status?: string): string {
  switch (status) {
    case 'active': return 'ok';
    case 'needs-consent': return 'warn';
    case 'blocked': case 'invalid': case 'error': return 'danger';
    case 'disabled': return 'muted';
    default: return 'muted';
  }
}

function AddonCard({ addon, onChanged, onOpenLogs }: {
  addon: AddonClientEntry;
  onChanged: () => void;
  onOpenLogs: (id: string) => void;
}) {
  const showNotice = useStore((state) => state.showNotice);
  const [detail, setDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const toggle = async () => {
    setBusy(true);
    try {
      const resp = await fetch(`/api/addons/${addon.id}/toggle`, { method: 'POST' });
      if (resp.ok) {
        const { reseeded } = await resp.json() as { reseeded?: boolean };
        if (reseeded) showNotice('addon.reseeded', { detail: addon.name });
      }
      onChanged();
    } finally { setBusy(false); }
  };

  const reload = async () => {
    setBusy(true);
    try {
      const resp = await fetch(`/api/addons/${addon.id}/reload`, { method: 'POST' });
      window.dispatchEvent(new CustomEvent('moriko:addons-reloaded'));
      if (resp.ok) {
        const { reseeded } = await resp.json() as { reseeded?: boolean };
        showNotice(reseeded ? 'addon.reseeded' : 'addon.reloaded', { detail: addon.name });
      } else {
        showNotice('addon.reloadFailed');
      }
      onChanged();
    } finally { setBusy(false); }
  };

  const grant = async () => {
    setBusy(true);
    try {
      await fetch(`/api/addons/${addon.id}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'grant' }),
      });
      showNotice('addon.consentGranted', { detail: addon.name });
      onChanged();
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await fetch(`/api/addons/${addon.id}`, { method: 'DELETE' });
      window.dispatchEvent(new CustomEvent('moriko:addons-reloaded'));
      onChanged();
    } finally { setBusy(false); setConfirmRemove(false); }
  };

  const contributions = [
    addon.hasTools ? `Tools${addon.commands ? '' : ''}` : null,
    addon.widgets.length > 0 ? `Widgets ${addon.widgets.length}` : null,
    addon.commands.length > 0 ? `Commands ${addon.commands.length}` : null,
  ].filter(Boolean) as string[];

  return (
    <div className={cx('card addon-hub-card', addon.status === 'error' && 'addon-hub-card-error')}>
      <div className="addon-hub-head">
        <div className="addon-hub-id">
          <strong>{addon.name}</strong>
          <span className="addon-hub-ver">v{addon.version}{addon.author ? ` · ${addon.author}` : ''}</span>
          <span className={cx('addon-hub-status', `tone-${statusTone(addon.status)}`)}>
            {addon.status ?? (addon.enabled ? 'active' : 'disabled')}
          </span>
          {addon.apiVersion === '1' ? <span className="addon-hub-legacy">legacy</span> : null}
        </div>
        <div className="addon-hub-actions">
          <button type="button" className="btn xs" disabled={busy} onClick={() => void toggle()}>
            {addon.enabled ? 'Disable' : 'Enable'}
          </button>
          <button type="button" className="btn xs" disabled={busy} onClick={() => void reload()}>Reload</button>
          <button type="button" className="btn xs ghost" onClick={() => setDetail((open) => !open)}>
            {detail ? 'Hide' : 'Details'}
          </button>
          <button type="button" className="btn xs ghost" onClick={() => onOpenLogs(addon.id)}>Logs</button>
          <button type="button" className="btn xs danger ghost" onClick={() => setConfirmRemove(true)}>Remove</button>
        </div>
      </div>

      {addon.status === 'needs-consent' ? (
        <div className="addon-hub-consent">
          <span>
            This addon asks for permissions before it can run:
            {' '}{(addon.permissions ?? []).join(', ')}
          </span>
          <button type="button" className="btn xs" disabled={busy} onClick={() => void grant()}>Grant & activate</button>
        </div>
      ) : null}

      {addon.loadError ? (
        <p className="addon-hub-error">{addon.loadError}</p>
      ) : (
        <p className="addon-hub-desc">{addon.description}</p>
      )}

      {contributions.length > 0 ? (
        <div className="addon-hub-chips">
          {contributions.map((chip) => <span key={chip} className="addon-pill">{chip}</span>)}
        </div>
      ) : null}

      {detail ? (
        <div className="addon-hub-detail">
          <p><strong>id:</strong> <code>{addon.id}</code> · <strong>api:</strong> v{addon.apiVersion ?? '1'}</p>
          {addon.commands.length > 0 ? (
            <p><strong>Commands:</strong> {addon.commands.map((c) => `/${c.name}`).join(' ')}</p>
          ) : null}
          {addon.widgets.length > 0 ? (
            <p><strong>Widgets:</strong> {addon.widgets.map((w) => w.site).join(', ')}</p>
          ) : null}
          {(addon.permissions ?? []).length > 0 ? (
            <p><strong>Permissions:</strong> {addon.permissions!.join(', ')}</p>
          ) : null}
        </div>
      ) : null}

      <Modal open={confirmRemove} onClose={() => setConfirmRemove(false)} title={`Remove ${addon.name}?`}>
        <p style={{ fontSize: 13, color: 'var(--muted)' }}>
          The addon folder <code>~/.moriko-studio/addons/{addon.id}/</code> is deleted from disk.
          {addon.builtin
            ? <> This is a built-in addon — its source folder <code>addons-src/{addon.id}/</code> is deleted too, so it will not come back on the next start.</>
            : null}
          This cannot be undone from here.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" className="btn xs ghost" onClick={() => setConfirmRemove(false)}>Cancel</button>
          <button type="button" className="btn xs danger" disabled={busy} onClick={() => void remove()}>Remove addon</button>
        </div>
      </Modal>
    </div>
  );
}

export const AddonHub = memo(function AddonHub() {
  const [addons, setAddons] = useState<AddonClientEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<HubTab>('installed');
  const [logs, setLogs] = useState<Array<{ addonId: string; at: number; level: string; text: string }>>([]);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const setView = useStore((state) => state.setView);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch('/api/addons');
      if (resp.ok) {
        const payload = await resp.json() as { addons: AddonClientEntry[] };
        setAddons(payload.addons);
      }
    } catch {  }
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const onReload = () => void refresh();
    window.addEventListener('moriko:addons-reloaded', onReload);
    return () => window.removeEventListener('moriko:addons-reloaded', onReload);
  }, [refresh]);

  const openLogs = useCallback(async (id: string) => {
    setLogsFor(id);
    setTab('logs');
    try {
      const resp = await fetch(`/api/addons/${id}/logs`);
      if (resp.ok) {
        const payload = await resp.json() as { logs: Array<{ at: number; level: string; text: string }> };
        setLogs(payload.logs.map((entry) => ({ addonId: id, ...entry })));
      }
    } catch {  }
  }, []);

  const tabs: Array<{ id: HubTab; label: string }> = [
    { id: 'installed', label: 'Installed' },
    { id: 'permissions', label: 'Permissions' },
    { id: 'logs', label: 'Logs' },
  ];

  return (
    <div className="addon-hub">
      <header className="addon-hub-top">
        <div>
          <h2 className="addon-hub-title">Addon Hub</h2>
          <p className="addon-hub-sub">
            Addons live in <code>~/.moriko-studio/addons/</code> — code runs inside the harness server with your permissions.
          </p>
        </div>
        <button type="button" className="btn xs ghost" onClick={() => setView('playground')}>Back to chat</button>
      </header>

      <div className="addon-tabs">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={cx('addon-tab', tab === entry.id && 'on')}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p style={{ padding: 24, fontSize: 12, color: 'var(--muted)' }}>Loading addons…</p>
      ) : tab === 'installed' ? (
        <div className="addon-hub-list">
          {addons.length === 0 ? (
            <p className="addon-hub-empty">
              No addons installed yet. Use <code>agent__addon_manage</code> in a chat, or drop a folder into the addons directory.
            </p>
          ) : (
            addons.map((addon) => (
              <AddonCard key={addon.id} addon={addon} onChanged={() => void refresh()} onOpenLogs={(id) => void openLogs(id)} />
            ))
          )}
        </div>
      ) : tab === 'permissions' ? (
        <div className="addon-hub-list">
          {addons.length === 0 ? (
            <p className="addon-hub-empty">No addons installed.</p>
          ) : (
            addons.map((addon) => (
              <div key={addon.id} className="card addon-hub-card">
                <strong>{addon.name}</strong>
                <table className="addon-perm-table">
                  <tbody>
                    {(addon.permissions ?? []).map((perm) => {
                      const granted = addon.permRecord?.granted.includes(perm) ?? false;
                      const builtin = addon.permRecord?.trust === 'builtin';
                      return (
                        <tr key={perm}>
                          <td><code>{perm}</code></td>
                          <td>{builtin ? 'builtin' : granted ? 'granted' : 'pending'}</td>
                          <td>
                            {granted && !builtin ? (
                              <button
                                type="button"
                                className="btn xs ghost"
                                onClick={() => {
                                  void fetch(`/api/addons/${addon.id}/permissions`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ action: 'revoke', permission: perm }),
                                  }).then(() => void refresh());
                                }}
                              >
                                Revoke
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                    {(addon.permissions ?? []).length === 0 ? (
                      <tr><td colSpan={3}>No sensitive permissions declared.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="addon-hub-list">
          {logsFor ? (
            <>
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>Latest {logs.length} log lines from <code>{logsFor}</code>.</p>
              <div className="card addon-hub-logcard">
                {logs.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--muted)' }}>No log output.</p>
                ) : (
                  logs.map((entry, index) => (
                    <div key={index} className={cx('addon-log-line', `lvl-${entry.level}`)}>
                      <span className="addon-log-time">{new Date(entry.at).toLocaleTimeString()}</span>
                      <span>{entry.text}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <p className="addon-hub-empty">Open Logs from an addon card.</p>
          )}
        </div>
      )}
    </div>
  );
});

/** Dock shortcut (right dock "Addons" tab) — opens the Hub page. */
export const AddonDockShortcut = memo(function AddonDockShortcut({ width: _width }: { width?: number }) {
  void _width;
  const setView = useStore((state) => state.setView);
  const rightPanelMode = useStore((state) => state.rightPanelMode);
  const setRightPanelMode = useStore((state) => state.setRightPanelMode);
  return (
    <div className="dock-card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
        <RightDockSlot mode={rightPanelMode} onChange={setRightPanelMode} />
        <RightDockCloseButton />
      </div>
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 16 }}>
        <button type="button" className="btn" onClick={() => setView('addons')}>Open Addon Hub</button>
      </div>
    </div>
  );
});
