/**
 * AddonViewHost (Addon v2, A6) — full-page host for `ViewId = addon:<id>/<view>`.
 *
 * Loads the addon's client module from the server-transpiled route
 * (GET /api/addons/:id/client/<view>.js — ONE React instance via the host
 * shim), mounts the exported component inside a themed error boundary +
 * skeleton. A dead/removed addon degrades to a themed "addon not found"
 * panel and bounces the user back to the Hub — never a blank screen.
 */

import { Component, lazy, Suspense, useEffect, useState, type ComponentType } from 'react';

import { LazyViewFallback, cx } from './ui';
import { useStore } from '../store/useStore';
import { addonClientVersion } from '../addons/clientVersion';

class AddonViewErrorBoundary extends Component<{ label: string; children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('[AddonViewHost] render failed:', error); }
  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ margin: '32px auto', maxWidth: 560, padding: 20, textAlign: 'center' }}>
          <p style={{ fontSize: 14, fontWeight: 600 }}>Addon view failed to load.</p>
          <p style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>{this.state.error.message}</p>
          <p style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
            Open the <strong>Addon Hub</strong> (sidebar → Addons) to inspect the addon's logs.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const viewCache = new Map<string, ComponentType>();

/** `addon:rsat/board` → { addonId: 'rsat', view: 'board' }. */
export function parseAddonView(view: string): { addonId: string; view: string } | null {
  const m = /^addon:([a-z0-9][a-z0-9-]*)\/([\w.-]+)$/.exec(view);
  return m ? { addonId: m[1], view: m[2] } : null;
}

const FALLBACK_VIEW: Record<string, string> = {
  overview: 'board',
  board: 'board',
  tree: 'board',
  interlinked: 'board',
  activity: 'board',
  files: 'board',
  settings: 'board',
};

function getLazyView(addonId: string, view: string): ComponentType<{ viewName?: string }> {
  const v = addonClientVersion();
  const key = `${addonId}/${view}@${v}`;
  const cached = viewCache.get(key);
  if (cached) return cached;
  const file = FALLBACK_VIEW[view] ?? view;
  const Lazy = lazy(() =>
    import(/* @vite-ignore */ `/api/addons/${addonId}/client/${file}.js?v=${v}`)
      .then((mod) => {
        const component = (mod.default ?? mod[view] ?? mod.RsatApp ?? mod.App) as ComponentType<{ viewName?: string }> | undefined;
        if (!component) throw new Error(`Module "${file}.js" has no default export.`);
        return { default: component };
      })
      .catch(async (error) => {
        if (file !== 'board') {
          const mod = await import(/* @vite-ignore */ `/api/addons/${addonId}/client/board.js?v=${v}`);
          const component = (mod.default ?? mod.RsatApp) as ComponentType<{ viewName?: string }> | undefined;
          if (component) return { default: component };
        }
        throw error;
      }),
  );
  viewCache.set(key, Lazy);
  return Lazy;
}

export function AddonViewHost({ viewKey }: { viewKey: string }) {
  const parsed = parseAddonView(viewKey);
  const setView = useStore((state) => state.setView);
  const [missing, setMissing] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/addons/views')
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((payload: { views?: Array<{ addonId: string; id: string; location: string }> } | null) => {
        if (cancelled || !payload?.views) return;
        const hit = payload.views.some((v) => v.addonId === parsed?.addonId && v.id === parsed.view && v.location === 'sidebar');
        setMissing(!hit);
      })
      .catch(() => {  });
    return () => { cancelled = true; };
  }, [parsed?.addonId, parsed?.view, tick]);

  useEffect(() => {
    const onReload = () => setTick((n) => n + 1);
    window.addEventListener('moriko:addons-reloaded', onReload);
    return () => window.removeEventListener('moriko:addons-reloaded', onReload);
  }, []);

  if (!parsed) return null;

  if (missing) {
    return (
      <div className="card" style={{ margin: '32px auto', maxWidth: 480, padding: 20, textAlign: 'center' }}>
        <p style={{ fontSize: 14, fontWeight: 600 }}>This addon view is not available.</p>
        <p style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
          The addon may have been removed or disabled.
        </p>
        <button
          type="button"
          className={cx('btn xs')}
          style={{ marginTop: 12 }}
          onClick={() => setView('addons')}
        >
          Open Addon Hub
        </button>
      </div>
    );
  }

  const Lazy = getLazyView(parsed.addonId, parsed.view);
  return (
    <AddonViewErrorBoundary label={viewKey}>
      <Suspense fallback={<LazyViewFallback label="Addon view" />}>
        <Lazy viewName={parsed.view} />
      </Suspense>
    </AddonViewErrorBoundary>
  );
}
