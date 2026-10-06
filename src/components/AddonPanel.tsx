/**
 * AddonPanel — management panel for installed addons.
 * Shown as a tab in the right dock (next to Config / Tree).
 */

import { memo, useEffect, useState } from 'react';
import { RightDockCloseButton, RightDockSlot } from './ui';
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
    <div className="rounded-lg border border-line bg-elevated overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-left"
        onClick={() => setOpen(!open)}
      >
        <div className="flex flex-col">
          <span className="text-xs font-medium">{title}</span>
          {subtitle && <span className="text-[10px] text-muted">{subtitle}</span>}
        </div>
        <span className={`text-xs text-muted transition-transform duration-200 ${open ? 'rotate-90' : ''}`}>▶</span>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-2">{children}</div>
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
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);

  const toggle = async (id: string) => {
    await fetch(`/api/addons/${id}/toggle`, { method: 'POST' });
    void refresh();
  };

  const rightPanelMode = useStore((state) => state.rightPanelMode);
  const setRightPanelMode = useStore((state) => state.setRightPanelMode);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <RightDockSlot mode={rightPanelMode} onChange={setRightPanelMode} />
        <RightDockCloseButton />
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading ? (
          <div className="text-xs text-muted">Loading addons…</div>
        ) : addons.length === 0 ? (
          <div className="text-xs text-muted">
            No addons installed. Addon directory: <code className="text-xs">~/.moriko-studio/addons/</code>
          </div>
        ) : (
          addons.map((addon) => (
            <CollapsibleItem
              key={addon.id}
              title={addon.name}
              subtitle={`v${addon.version} · ${addon.hasTools ? 'T' : ''}${addon.hasWidgets ? 'W' : ''}${addon.commands.length ? 'C' : ''}`}
              defaultOpen={false}
            >
              <div className="space-y-2 py-2">
                <p className="text-xs text-muted">{addon.description}</p>
                {addon.commands.length > 0 && (
                  <div className="text-[10px] text-muted">
                    Commands: {addon.commands.map((c) => `/${c.name}`).join(', ')}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button
                    className={`text-xs px-2 py-1 rounded ${addon.enabled ? 'bg-green-600 text-white' : 'bg-elevated text-muted'}`}
                    onClick={() => toggle(addon.id)}
                  >
                    {addon.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                  {addon.hasTools && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-400">tools</span>}
                  {addon.hasWidgets && <span className="text-xs px-1.5 py-0.5 rounded bg-purple-600/20 text-purple-400">widgets</span>}
                  {addon.commands.length > 0 && <span className="text-xs px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-400">commands</span>}
                </div>
              </div>
            </CollapsibleItem>
          ))
        )}
        <button
          className="text-xs text-muted hover:text-fg mt-2"
          onClick={() => fetch('/api/addons/reload', { method: 'POST' }).then(() => refresh())}
        >
          ↻ Reload all addons
        </button>
      </div>
    </div>
  );
});
