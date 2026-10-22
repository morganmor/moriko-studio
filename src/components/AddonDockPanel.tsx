/**
 * AddonDockPanel — the right dock's addon WORKSPACE (replaces the old
 * AddonDockShortcut stub that just linked to the Hub page).
 *
 * Structure (per the agreed blueprint):
 *   • One picker dropdown at the top — lists ENABLED addons only. Choosing one
 *     opens its canvas directly (no nested same-name submenu).
 *   • Multi-page addons (e.g. RSA/T) render their pages as tabs INSIDE this
 *     panel; the left rail never floods again.
 *   • Single-page addons open their canvas directly.
 *
 * The Addon Hub (toggle on/off, reload, permissions) moved to the rfoot
 * button — see AddonHubModal in AddonHub.tsx.
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Check } from './icons';
import { DIcon } from './designIcons';
import { RightDockCloseButton, RightDockSlot, cx, LazyViewFallback } from './ui';
import { useStore } from '../store/useStore';
import type { AddonClientEntry, AddonViewClientEntry } from '../types/addon';

const LazyAddonViewHost = lazy(() =>
  import('./AddonViewHost').then((m) => ({ default: m.AddonViewHost })),
);

/** Which addon page is open in the dock — persisted per device. */
export type AddonDockSelection = string; // "addonId" or "addonId/viewId"

export function AddonDockPanel() {
  const setView = useStore((state) => state.setView);
  const rightPanelMode = useStore((state) => state.rightPanelMode);
  const setRightPanelMode = useStore((state) => state.setRightPanelMode);

  const [addons, setAddons] = useState<AddonClientEntry[]>([]);
  const [views, setViews] = useState<AddonViewClientEntry[]>([]);
  const [selection, setSelection] = useState<AddonDockSelection | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Load registry data (same endpoints as the old sidebar section).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [a, v] = await Promise.all([
          fetch('/api/addons').then((resp) => (resp.ok ? resp.json() : null)),
          fetch('/api/addons/views').then((resp) => (resp.ok ? resp.json() : null)),
        ]);
        if (cancelled) return;
        if (a?.addons) setAddons(a.addons as AddonClientEntry[]);
        if (v?.views) setViews(v.views as AddonViewClientEntry[]);
      } catch { /* offline: empty state shows */ }
    };
    void load();
    const onReload = () => void load();
    window.addEventListener('moriko:addons-reloaded', onReload);
    return () => {
      cancelled = true;
      window.removeEventListener('moriko:addons-reloaded', onReload);
    };
  }, []);

  // Only enabled, healthy addons appear in the picker.
  const usable = addons.filter(
    (addon) => addon.enabled && addon.status !== 'needs-consent' && !addon.loadError,
  );

  // Drop stale selection when the chosen addon becomes disabled.
  useEffect(() => {
    if (!selection) return;
    const addonId = selection.includes('/') ? selection.split('/')[0] : selection;
    const alive = addons.some((a) => a.id === addonId && a.enabled && !a.loadError);
    if (!alive) setSelection(null);
  }, [addons, selection]);

  const selectedAddon = selection ? addons.find((a) => a.id === selection.split('/')[0]) : null;
  const selectedViewId = selection?.includes('/') ? selection.split('/')[1] : null;
  // Multi-page addon: which page is active (null = first page).
  const activePage =
    selectedAddon && selectedViewId
      ? views.find((v) => v.addonId === selectedAddon.id && v.id === selectedViewId) ?? null
      : null;
  const selectedPages = selectedAddon
    ? views.filter((v) => v.addonId === selectedAddon.id && v.location === 'sidebar')
    : [];

  // Dropdown positioning (same pattern as RightDockSlot).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (anchorRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (!open) {
      const box = anchorRef.current?.getBoundingClientRect();
      if (box) {
        const flip = box.bottom + 220 > window.innerHeight;
        const left = Math.max(8, Math.min(box.left, window.innerWidth - 240));
        setPos(
          flip
            ? { bottom: window.innerHeight - box.top + 6, left }
            : { top: box.bottom + 6, left },
        );
      }
    }
    setOpen((value) => !value);
  };

  const viewKey = selection && selection.includes('/') ? `addon:${selection}` : null;

  return (
    <div className="dock-card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Top bar: single-slot switcher + the addon picker + close */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
        <RightDockSlot mode={rightPanelMode} onChange={setRightPanelMode} />
        <div style={{ position: 'relative', flexShrink: 0, minWidth: 0, flex: 1 }}>
          <button
            ref={anchorRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
            className="rd-slot dswitch"
            style={{ width: '100%', maxWidth: 'none' }}
          >
            <span className="icw" aria-hidden="true">
              <DIcon name="addon" className="ic" />
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedAddon ? (selectedAddon.shortName ?? selectedAddon.name) : 'Choose addon…'}
            </span>
          </button>
          {open && pos
            ? createPortal(
                <div
                  ref={menuRef}
                  role="menu"
                  aria-label="Addon workspace"
                  style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, minWidth: 220 }}
                  className="pop open"
                >
                  {usable.length === 0 ? (
                    <span className="mi" style={{ minHeight: 32, fontSize: 12, color: 'var(--muted)' }}>
                      No enabled addons — open the Hub (plug icon, sidebar footer).
                    </span>
                  ) : (
                    usable.map((addon) => {
                      const addonViews = views.filter((v) => v.addonId === addon.id && v.location === 'sidebar');
                      return (
                        <button
                          key={addon.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selectedAddon?.id === addon.id}
                          onClick={() => {
                            // One-page addons open the canvas directly; multi-page
                            // addons open their first page (tabs render below).
                            setSelection(addonViews.length > 0 ? `${addon.id}/${addonViews[0].id}` : addon.id);
                            setOpen(false);
                          }}
                          className="mi"
                          style={{ minHeight: 32, fontSize: 12.5 }}
                        >
                          <Check className="ic mck" aria-hidden="true" />
                          {addon.shortName ?? addon.name}
                        </button>
                      );
                    })
                  )}
                </div>,
                document.body,
              )
            : null}
        </div>
        <RightDockCloseButton />
      </div>

      {/* Multi-page addon: page tabs INSIDE the panel, never in the left rail */}
      {selectedAddon && selectedPages.length > 1 ? (
        <div role="tablist" aria-label={`${selectedAddon.name} pages`} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '8px 12px 0' }}>
          {selectedPages.map((page) => {
            const active = activePage?.id === page.id || (selectedPages.length === 1 && !activePage);
            return (
              <button
                key={page.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={cx('addon-tab', active && 'on')}
                onClick={() => setSelection(`${selectedAddon.id}/${page.id}`)}
              >
                {page.title}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* The addon canvas itself — hosted by the same loader the full page uses */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {viewKey ? (
          <Suspense fallback={<LazyViewFallback label="Addon view" />}>
            <LazyAddonViewHost viewKey={viewKey} />
          </Suspense>
        ) : selectedAddon && !viewKey ? (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 16 }}>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>
              {selectedAddon.name} has no panel pages — it contributes tools/commands only.
            </p>
          </div>
          ) : (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 16 }}>
            <div style={{ textAlign: 'center', display: 'grid', gap: 10 }}>
              <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Pick an addon above to open its workspace.</p>
              <button type="button" className="btn xs" onClick={() => setView('addons')}>
                Open Addon Hub
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
