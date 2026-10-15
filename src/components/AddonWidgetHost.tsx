/**
 * AddonWidgetHost — renders addon-provided widgets into designated render sites.
 *
 * Render sites (from Claude Code Mods pattern):
 * - thread-sidebar: panel samping thread
 * - composer-band: band di atas composer
 * - right-dock: tab tambahan di dock kanan
 * - floating: overlay (fixed position)
 * - tool-row: override ToolCallCard
 * - spinner: override ActivityTicker
 *
 * Widgets are loaded from the server's /api/addons/widgets endpoint.
 * Each widget declares a site and a component path.
 * The component is dynamically imported via Vite's module proxy.
 *
 * FLOATING SITE + THE ZOOM CONTAINING BLOCK: #root carries
 * `transform: scale(var(--app-zoom))`, and ANY transform on an ancestor makes
 * it the containing block for position:fixed descendants (CSS transforms
 * spec) — inside #root a fixed element is positioned and SCALED in #root's
 * local space, so drag math against window.innerWidth drags 10% slow at zoom
 * 0.9 and clamps ~150px short of the right edge. The floating site therefore
 * portals to document.body, exactly like NoticeCenter ("fixed positioning
 * must escape transformed ancestors"): fixed coordinates become real viewport
 * pixels and cursor tracking is 1:1 at any zoom.
 */

import { memo, useEffect, useState, lazy, Suspense, Component, ComponentType } from 'react';
import { createPortal } from 'react-dom';
import type { RenderSite } from '../types/addon';
import { addonClientVersion } from '../addons/clientVersion';

interface WidgetEntry {
  addonId: string;
  site: RenderSite;
  component: string;
  label?: string;
}

const widgetRegistry: WidgetEntry[] = [];
let registryVersion = 0;

export async function refreshAddonWidgets(): Promise<void> {
  try {
    const resp = await fetch('/api/addons/widgets');
    if (!resp.ok) return;
    const payload = await resp.json() as { widgets: Array<{ addonId: string; site: RenderSite; component: string; label?: string }> };
    widgetRegistry.length = 0;
    widgetRegistry.push(...payload.widgets);
    registryVersion++;
  } catch {
  }
}

class WidgetErrorBoundary extends Component<{ addonId: string; children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(`[addon:${this.props.addonId}] widget error:`, error); }
  render() {
    if (this.state.error) {
      return <div style={{ padding: 8, fontSize: 12, color: 'rgb(var(--c-danger))' }}>Widget error: {this.state.error.message}</div>;
    }
    return this.props.children;
  }
}

const WidgetFallback = () => <div style={{ height: 32, borderRadius: 4, background: 'rgb(var(--c-elev))', animation: 'breathe 2s ease-in-out infinite' }} />;

/** One lazy component per (addonId, component) — a lazy() created inside
 *  render gets a fresh identity on every host re-render, which REMOUNTS the
 *  whole widget subtree (state loss, media reload, drag reset). */
const lazyCache = new Map<string, ComponentType>();

function getLazyWidget(entry: WidgetEntry): ComponentType {
  // Module version in the key + URL: a registry change loads fresh code
  // (the browser module map is keyed by full URL incl. query).
  const v = addonClientVersion();
  const key = `${entry.addonId}/${entry.component}@${v}`;
  const cached = lazyCache.get(key);
  if (cached) return cached;
  const Lazy = lazy(() => {
    const rel = entry.component.replace(/^\.\//, '').replace(/\.tsx$/, '');
    // v2 (A5): the server transpiles + jails the module and rewrites its bare
    // imports to the host shim (ONE React instance) — works in dev AND prod.
    return import(/* @vite-ignore */ `/api/addons/${entry.addonId}/client/${rel}.js?v=${v}`)
      .then((m) => ({ default: (m.default ?? m[entry.addonId]) as ComponentType }))
      .catch(() => ({ default: WidgetFallback }));
  });
  lazyCache.set(key, Lazy);
  return Lazy;
}

export const AddonWidgetHost = memo(function AddonWidgetHost({
  site,
  streaming = false,
}: {
  site: RenderSite;
  streaming?: boolean;
}) {
  const [, setVersion] = useState(0);

  useEffect(() => {
    void refreshAddonWidgets().then(() => setVersion(registryVersion));
  }, []);

  // LIVE REGISTRY: toggle/reload/delete repaint widgets without a refresh.
  useEffect(() => {
    const onReload = () => void refreshAddonWidgets().then(() => setVersion(registryVersion));
    window.addEventListener('moriko:addons-reloaded', onReload);
    return () => window.removeEventListener('moriko:addons-reloaded', onReload);
  }, []);

  useEffect(() => {
    void refreshAddonWidgets().then(() => setVersion(registryVersion));
  }, [streaming]);

  const visible = widgetRegistry.filter((w) => w.site === site);

  if (visible.length === 0) return null;

  const slot = (
    <div className="addon-widget-slot" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {visible.map((w) => {
        const Lazy = getLazyWidget(w);
        return (
          <WidgetErrorBoundary key={`${w.addonId}-${w.site}`} addonId={w.addonId}>
            <Suspense fallback={<WidgetFallback />}>
              <Lazy />
            </Suspense>
          </WidgetErrorBoundary>
        );
      })}
    </div>
  );

  if (site === 'floating') return createPortal(slot, document.body);
  return slot;
});
