/**
 * AddonTopbarButtons — the TopBar's addon launch buttons, driven by a simple
 * editable whitelist (`~/.moriko-studio/topbar-addons.json`, served at
 * /api/addons/topbar-buttons; POST the same route to change it).
 *
 * Only ENABLED and healthy addons that appear in the list render — the list is
 * the anti-crowding gate, so installing an addon never auto-floods the topbar.
 * Each button masks the addon's own resources/icon.svg (the RSAT gem pattern)
 * and opens the addon's first sidebar view.
 */

import { useEffect, useState } from 'react';

import { useStore } from '../store/useStore';

interface Entry {
  id: string;
  label: string;
  viewId: string;
}

/** One topbar button per whitelisted, enabled addon. */
export function AddonTopbarButtons() {
  const setView = useStore((s) => s.setView);
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [list, addons, views] = await Promise.all([
          fetch('/api/addons/topbar-buttons').then((r) => (r.ok ? r.json() : null)),
          fetch('/api/addons').then((r) => (r.ok ? r.json() : null)),
          fetch('/api/addons/views').then((r) => (r.ok ? r.json() : null)),
        ]);
        if (cancelled) return;
        const ids: string[] = Array.isArray(list?.addons) ? list.addons : [];
        const registry = (addons?.addons ?? []) as Array<{
          id: string; name: string; shortName?: string; enabled: boolean;
          loadError: string | null; status?: string;
        }>;
        const viewList = (views?.views ?? []) as Array<{ addonId: string; id: string; location: string }>;
        setEntries(
          ids.flatMap((id) => {
            const addon = registry.find((a) => a.id === id);
            if (!addon || !addon.enabled || addon.loadError || addon.status === 'needs-consent') return [];
            const view = viewList.find((v) => v.addonId === id && v.location === 'sidebar');
            if (!view) return [];
            return [{ id, label: addon.shortName ?? addon.name, viewId: view.id }];
          }),
        );
      } catch { /* transient — retry on next reload event */ }
    };
    void load();
    const onReload = () => void load();
    window.addEventListener('moriko:addons-reloaded', onReload);
    return () => {
      cancelled = true;
      window.removeEventListener('moriko:addons-reloaded', onReload);
    };
  }, []);

  return (
    <>
      {entries.map((entry) => {
        const iconUrl = `/api/addons/${entry.id}/client/resources/icon.svg`;
        return (
          <button
            key={entry.id}
            type="button"
            className="ib"
            onClick={() => setView(`addon:${entry.id}/${entry.viewId}` as never)}
            aria-label={`Open ${entry.label}`}
          >
            <span
              className="tb-addon-ic"
              aria-hidden="true"
              style={{ maskImage: `url("${iconUrl}")`, WebkitMaskImage: `url("${iconUrl}")` }}
            />
          </button>
        );
      })}
    </>
  );
}
