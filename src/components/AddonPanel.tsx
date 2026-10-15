/**
 * AddonPanel — management panel for installed addons.
 * Shown as a tab in the right dock (next to Config / Tree).
 */

import { memo, useEffect, useState } from 'react';
import { RightDockCloseButton, RightDockSlot, cx } from './ui';
import { useStore } from '../store/useStore';
import type { AddonClientEntry } from '../types/addon';

function CollapsibleItem({ title, subtitle, defaultOpen = false, children }: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card" style={{ borderRadius: 'var(--r-lg)', overflow: 'hidden', background: 'rgb(var(--c-elev))', padding: 0 }}>
      <button
        style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', textAlign: 'left' }}
        onClick={() => setOpen(!open)}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>{title}</span>
          {subtitle && <span style={{ fontSize: 10, color: 'var(--muted)' }}>{subtitle}</span>}
        </div>
        <span style={{ fontSize: 12, color: 'var(--muted)', transition: 'transform .2s', transform: open ? 'rotate(90deg)' : undefined }}>▶</span>
      </button>
      <div className={cx('col', !open && 'shut')}>
        <div className="col-in">
          <div style={{ padding: '0 12px 8px' }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

export const AddonPanel = memo(function AddonPanel({ width: _width }: { width?: number }) {
  const [addons, setAddons] = useState<AddonClientEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/addons');
      if (resp.ok) {
        const payload = await resp.json() as { addons: AddonClientEntry[] };
        setAddons(payload.addons);
      }
    } catch {  }
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);

  // LIVE REGISTRY: toggle/reload/delete from any client repaints the panel.
  useEffect(() => {
    const onReload = () => void refresh();
    window.addEventListener('moriko:addons-reloaded', onReload);
    return () => window.removeEventListener('moriko:addons-reloaded', onReload);
  }, []);

  const toggle = async (id: string) => {
    await fetch(`/api/addons/${id}/toggle`, { method: 'POST' });
    void refresh();
  };

  const rightPanelMode = useStore((state) => state.rightPanelMode);
  const setRightPanelMode = useStore((state) => state.setRightPanelMode);

  return (
    <div className="dock-card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 6, padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
        <RightDockSlot mode={rightPanelMode} onChange={setRightPanelMode} />
        <RightDockCloseButton />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading ? (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading addons…</div>
        ) : addons.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            No addons installed. Addon directory: <code style={{ fontSize: 12 }}>~/.moriko-studio/addons/</code>
          </div>
        ) : (
          addons.map((addon) => (
            <CollapsibleItem
              key={addon.id}
              title={addon.name}
              subtitle={`v${addon.version} · ${addon.hasTools ? 'T' : ''}${addon.hasWidgets ? 'W' : ''}${addon.commands.length ? 'C' : ''}`}
              defaultOpen={false}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>{addon.description}</p>
                {addon.commands.length > 0 && (
                  <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                    Commands: {addon.commands.map((c) => `/${c.name}`).join(', ')}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    className="btn xs"
                    style={{
                      background: addon.enabled ? 'rgb(var(--c-ok))' : 'rgb(var(--c-elev))',
                      color: addon.enabled ? '#fff' : 'var(--muted)',
                      borderColor: 'transparent',
                    }}
                    onClick={() => toggle(addon.id)}
                  >
                    {addon.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                  {addon.hasTools && <span className="cap" style={{ color: '#7ab8ff' }}>tools</span>}
                  {addon.hasWidgets && <span className="cap" style={{ color: '#c9a6ff' }}>widgets</span>}
                  {addon.commands.length > 0 && <span className="cap" style={{ color: '#ffc46b' }}>commands</span>}
                </div>
              </div>
            </CollapsibleItem>
          ))
        )}
        <button
          className="nav"
          style={{ height: 'auto', marginTop: 8, padding: '4px 8px', fontSize: 12 }}
          onClick={() =>
            fetch('/api/addons/reload', { method: 'POST' }).then(() => {
              refresh();
              // SlashMenu re-fetches /api/addons/commands on this event.
              window.dispatchEvent(new CustomEvent('moriko:addons-reloaded'));
            })
          }
        >
          ↻ Reload all addons
        </button>
      </div>
    </div>
  );
});
