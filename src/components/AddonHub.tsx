

import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Modal, RightDockCloseButton, RightDockSlot, Toggle, cx } from './ui';
import { useStore } from '../store/useStore';
import type { AddonClientEntry } from '../types/addon';

type HubTab = 'installed' | 'permissions' | 'logs';


interface TerminalEntry {
  at: number;
  level: string;
  text: string;
  source?: 'system' | 'addon';
  durationMs?: number;
}


function fmtTime(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}


function fmtDur(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

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


function AddonTerminal({ addons, initialId }: { addons: AddonClientEntry[]; initialId: string | null }) {
  const [target, setTarget] = useState<string>(initialId ?? 'all');
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [auto, setAuto] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const load = useCallback(async (id: string) => {
    try {
      const resp = id === 'all' ? await fetch('/api/addons/logs') : await fetch(`/api/addons/${id}/logs`);
      if (!resp.ok) return;
      const payload = await resp.json() as { logs: TerminalEntry[] };
      setEntries(payload.logs);
    } catch {  }
  }, []);

  useEffect(() => { void load(target); }, [target, load]);
  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => void load(target), 2000);
    return () => window.clearInterval(timer);
  }, [auto, target, load]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const onErrorScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const errCount = entries.filter((entry) => entry.level === 'error').length;
  const warnCount = entries.filter((entry) => entry.level === 'warn').length;
  const shown = entries.length;
  const total = addons.length;

  return (
    <div className="aterm">
      <div className="aterm-bar">
        <span className="aterm-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="aterm-title">
          {target === 'all' ? 'addon-logs — all' : `addon-logs — ${target}`}
        </span>
        <span className="aterm-chips">
          {errCount > 0 ? <span className="aterm-chip err">{errCount} err</span> : null}
          {warnCount > 0 ? <span className="aterm-chip warn">{warnCount} warn</span> : null}
          <span className="aterm-chip">{shown} lines</span>
        </span>
        <button
          type="button"
          className={cx('aterm-btn', auto && 'on')}
          onClick={() => setAuto((value) => !value)}
        >
          {auto ? '● live' : '○ paused'}
        </button>
        <button type="button" className="aterm-btn" onClick={() => void load(target)}>↻</button>
      </div>
      <div className="aterm-pick">
        <select
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          aria-label="Addon log stream"
          className="aterm-select"
        >
          <option value="all">all addons ({total})</option>
          {addons.map((addon) => (
            <option key={addon.id} value={addon.id}>{addon.id}</option>
          ))}
        </select>
      </div>
      <div
        ref={scrollRef}
        onScroll={onErrorScroll}
        className="aterm-body"
        role="log"
        aria-live="polite"
      >
        {shown === 0 ? (
          <div className="aterm-line muted">— no log output yet —</div>
        ) : (
          entries.map((entry, index) => (
            <div key={index} className={cx('aterm-line', entry.level, entry.source)}>
              <span className="aterm-time">{fmtTime(entry.at)}</span>
              <span className="aterm-lvl">{entry.level.toUpperCase().padEnd(5)}</span>
              {entry.source === 'system' ? <span className="aterm-src">SYS</span> : null}
              {entry.durationMs !== undefined ? <span className="aterm-dur">{fmtDur(entry.durationMs)}</span> : null}
              <span className="aterm-text">{entry.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export const AddonHub = memo(function AddonHub() {
  const [addons, setAddons] = useState<AddonClientEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<HubTab>('installed');
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

  
  const openLogs = useCallback((id: string) => {
    setLogsFor(id);
    setTab('logs');
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
        <AddonTerminal addons={addons} initialId={logsFor} />
      )}
    </div>
  );
});


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


export function AddonHubModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [addons, setAddons] = useState<AddonClientEntry[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const setView = useStore((state) => state.setView);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch('/api/addons');
      if (resp.ok) {
        const payload = await resp.json() as { addons: AddonClientEntry[] };
        setAddons(payload.addons);
      }
    } catch {  }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const onReload = () => void refresh();
    window.addEventListener('moriko:addons-reloaded', onReload);
    return () => window.removeEventListener('moriko:addons-reloaded', onReload);
  }, [open, refresh]);

  const toggle = async (id: string) => {
    setBusyId(id);
    try {
      const resp = await fetch(`/api/addons/${id}/toggle`, { method: 'POST' });
      if (resp.ok) {
        const { reseeded } = await resp.json() as { reseeded?: boolean };
        if (reseeded) useStore.getState().showNotice('addon.reseeded', { detail: id });
      }
      await refresh();
    } finally { setBusyId(null); }
  };

  
  const reloadAll = async () => {
    setReloading(true);
    try {
      const resp = await fetch('/api/addons/reload', { method: 'POST' });
      window.dispatchEvent(new CustomEvent('moriko:addons-reloaded'));
      useStore.getState().showNotice(resp.ok ? 'addon.reloaded' : 'addon.reloadFailed', { detail: 'all' });
      await refresh();
    } finally { setReloading(false); }
  };

  const openHub = () => {
    onClose();
    setView('addons');
  };

  return (
    <Modal open={open} onClose={onClose} title="Addon Hub" description="Enable, disable, or reload installed addons." size="sm">
      <div className="addon-hub-list" style={{ maxHeight: '52vh', overflowY: 'auto', display: 'grid', gap: 8 }}>
        {addons.length === 0 ? (
          <p className="addon-hub-empty">No addons installed.</p>
        ) : (
          addons.map((addon) => (
            <div key={addon.id} className="card addon-hub-card" style={{ padding: '10px 12px' }}>
              <div className="addon-hub-head" style={{ margin: 0, gap: 10 }}>
                <div className="addon-hub-id" style={{ minWidth: 0, flex: 1 }}>
                  <strong>{addon.name}</strong>
                  <span className="addon-hub-ver">
                    {addon.description ? ` — ${addon.description} ` : ''}v{addon.version}
                  </span>
                  {addon.status === 'needs-consent' ? (
                    <span className={cx('addon-hub-status', 'tone-warn')}>needs approval</span>
                  ) : addon.loadError || addon.status === 'error' ? (
                    <span className={cx('addon-hub-status', 'tone-danger')}>error</span>
                  ) : null}
                </div>
                <Toggle
                  checked={addon.enabled}
                  hideLabel
                  disabled={busyId === addon.id}
                  onChange={() => void toggle(addon.id)}
                  label={`${addon.enabled ? 'Disable' : 'Enable'} ${addon.name}`}
                />
              </div>
              {addon.status === 'needs-consent' ? (
                <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>
                  Approve it on the Hub page before it can run.
                </p>
              ) : null}
            </div>
          ))
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button type="button" className="btn xs ghost" disabled={reloading} onClick={() => void reloadAll()}>
          {reloading ? 'Reloading…' : '⟳ Reload all'}
        </button>
        <button type="button" className="btn xs" onClick={openHub}>Open full Addon Hub</button>
      </div>
    </Modal>
  );
}
