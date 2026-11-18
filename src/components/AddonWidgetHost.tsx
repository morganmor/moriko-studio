

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


const lazyCache = new Map<string, ComponentType>();

function getLazyWidget(entry: WidgetEntry): ComponentType {
  const v = addonClientVersion();
  const key = `${entry.addonId}/${entry.component}@${v}`;
  const cached = lazyCache.get(key);
  if (cached) return cached;
  const Lazy = lazy(() => {
    const rel = entry.component.replace(/^\.\//, '').replace(/\.tsx$/, '');
    return import( `/api/addons/${entry.addonId}/client/${rel}.js?v=${v}`)
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
