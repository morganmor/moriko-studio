import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  Cpu,
  Download,
  MessageSquare,
  Plug,
  RefreshCw,
  Upload,
} from './icons';

import { useStore } from '../store/useStore';
import { exportAll, importBundle } from '../lib/exportImport';
import { isMotionReduced } from '../lib/appearance';
import { storage } from '../lib/storage';
import { EmptyState } from './ui';
import { UsageChart } from './UsageChart';

/** Server-side ledger windows — the selector's options (1 day .. 12 months). */
const USAGE_WINDOW_LABELS: Record<string, string> = {
  '1d': '1 day',
  '3d': '3 days',
  '7d': '7 days',
  '14d': '14 days',
  '30d': '30 days',
  '3mo': '3 months',
  '6mo': '6 months',
  '12mo': '12 months',
};

/** Design's range tabs are compact (1D / 7D / 3M) — long labels stay for prose. */
const USAGE_TAB_LABELS: Record<string, string> = {
  '1d': '1D',
  '3d': '3D',
  '7d': '7D',
  '14d': '14D',
  '30d': '30D',
  '3mo': '3M',
  '6mo': '6M',
  '12mo': '12M',
};

/** Design's fmtN(): 12.4M / 340k / 950 — compact KPI and sumline numbers. */
function fmtN(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e8 ? 0 : 1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(value));
}

interface UsageProvider {
  providerId: string;
  requests: number;
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
}

interface UsagePayload {
  windows: string[];
  window: string;
  providers: UsageProvider[];
  totals: { requests: number; prompt: number; completion: number; total: number; cacheRead: number };
  /** Per-calendar-day series (zero-filled, oldest → newest) for the chart. */
  daily?: Array<{ date: string; requests: number; prompt: number; completion: number; total: number; cacheRead: number }>;
}

/** Which providers fold into the big total — checked per provider.
 *  PRIVACY (2026-10): device state via storage.ts (ui-state.json), NOT
 *  localStorage — the browser stores nothing (see AGENTS.md privacy rule).
 *  Legacy dashboard.usage.* keys are adopted+erased by adoptLegacyBrowserState. */
function loadCheckedProviders(): string[] {
  return storage.loadDashboardUsageProviders();
}

function saveCheckedProviders(ids: string[]): void {
  storage.saveDashboardUsageProviders(ids);
}

/**
 * Dashboard: environment health at a glance, laid out like
 * design/dashboard/moriko-design-1-panel-dashboard.html — KPI cards with the
 * count-up roll, a panel with range tabs over the grow-animated bar chart,
 * the By provider / Provider status pair, and the on-device rows.
 *
 * The point is to answer "why can't I send a message?" without making the user
 * open a terminal.
 */
export function DashboardView({ onOpenProviders }: { onOpenProviders: () => void }) {
  const providers = useStore((state) => state.providers);
  const conversations = useStore((state) => state.conversations);
  const providersError = useStore((state) => state.providersError);
  const loadProviders = useStore((state) => state.loadProviders);
  const providerId = useStore((state) => state.providerId);

  const stats = useMemo(() => {
    const turns = conversations.reduce((total, conversation) => total + conversation.turns.length, 0);
    return { turns };
  }, [conversations]);

  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [usageWindow, setUsageWindow] = useState<string>(() => storage.loadDashboardUsageWindow());
  const [checked, setChecked] = useState<string[]>(() => loadCheckedProviders());
  const [usageLoading, setUsageLoading] = useState(true);

  const lastWindowRef = useRef(usageWindow);
  useEffect(() => {
    let cancelled = false;
    if (lastWindowRef.current !== usageWindow) {
      lastWindowRef.current = usageWindow;
      setUsageLoading(true);
      storage.saveDashboardUsageWindow(usageWindow);
    }
    const params = new URLSearchParams({ window: usageWindow });
    if (checked.length > 0) params.set('providers', checked.join(','));
    fetch(`/api/usage?${params}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: UsagePayload | null) => {
        if (cancelled) return;
        setUsage(payload);
        setUsageLoading(false);
      })
      .catch(() => !cancelled && setUsageLoading(false));
    return () => { cancelled = true; };
  }, [usageWindow, checked]);

  const providerLabel = (id: string): string =>
    providers.find((provider) => provider.id === id)?.label ?? id;

  const selectedProviders = useMemo(() => {
    if (!usage) return [];
    if (checked.length === 0) return usage.providers;
    return usage.providers.filter((entry) => checked.includes(entry.providerId));
  }, [usage, checked]);

  const selectedTotal = useMemo(
    () => selectedProviders.reduce((sum, entry) => sum + entry.total, 0),
    [selectedProviders],
  );
  const selectedRequests = useMemo(
    () => selectedProviders.reduce((sum, entry) => sum + entry.requests, 0),
    [selectedProviders],
  );
  /** Prompt/output/cache of the CHECKED subset — headline, breakdown and chart stay consistent. */
  const selectedBreakdown = useMemo(
    () =>
      selectedProviders.reduce(
        (totals, entry) => ({
          prompt: totals.prompt + entry.prompt,
          completion: totals.completion + entry.completion,
          cacheRead: totals.cacheRead + entry.cacheRead,
        }),
        { prompt: 0, completion: 0, cacheRead: 0 },
      ),
    [selectedProviders],
  );

  const toggleChecked = (id: string) => {
    setChecked((previous) => {
      let next: string[];
      if (previous.length === 0) {
        // Nothing stored = every row included (totals unfiltered). First click
        // switches to an explicit subset that excludes exactly the clicked
        // row, so the checkbox always reflects what the design promises.
        next = (usage?.providers ?? [])
          .map((entry) => entry.providerId)
          .filter((providerId) => providerId !== id);
      } else {
        next = previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id];
      }
      saveCheckedProviders(next);
      return next;
    });
  };

  const ready = providers.filter((provider) => provider.hasServerKey);
  const missing = providers.filter((provider) => !provider.hasServerKey);
  const keyRatio = providers.length > 0 ? (ready.length / providers.length) * 100 : 0;

  /** Design's .spot — an accent radial follows the pointer inside a KPI card. */
  const handleSpotMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('.spot');
    if (!card) return;
    const box = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${event.clientX - box.left}px`);
    card.style.setProperty('--my', `${event.clientY - box.top}px`);
  };

  return (
    <div className="page wide view-enter">
      <header className="page-head">
        <div>
          <h2>Dashboard</h2>
          <p>Local workspace status. Nothing here leaves your machine.</p>
        </div>
        <div className="acts">
          <label className="btn ghost" style={{ cursor: 'pointer' }}>
            <Upload className="ic" aria-hidden="true" />
            Import
            <input
              type="file"
              accept="application/json"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importBundle(file, loadProviders);
                event.target.value = '';
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => void exportAll()}
            className="btn ghost"
          >
            <Download className="ic" aria-hidden="true" />
            Export
          </button>
        </div>
      </header>

      {providersError ? (
        <div className="card" style={{ marginBottom: 24, padding: 16, borderColor: 'rgb(var(--c-danger) / 0.4)', background: 'rgb(var(--c-danger) / 0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <AlertTriangle className="ic" style={{ marginTop: 2, color: 'rgb(var(--c-danger))' }} aria-hidden="true" />
            <div>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'rgb(var(--c-danger))' }}>The local proxy is unreachable</p>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>{providersError}</p>
              <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                Start it with <code style={{ fontFamily: 'var(--f-mono)' }}>npm run dev</code>, then reload.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="kpis" onPointerMove={handleSpotMove}>
        <Kpi icon={<Plug className="ic" aria-hidden="true" />} label="Providers ready" hint={`of ${providers.length} configured`}>
          <CountUp value={ready.length} />
        </Kpi>
        <Kpi icon={<MessageSquare className="ic" aria-hidden="true" />} label="Conversations" hint={`${stats.turns} turns stored`}>
          <CountUp value={conversations.length} />
        </Kpi>
        <Kpi
          icon={<Activity className="ic" aria-hidden="true" />}
          label="Tokens"
          hint={usage ? `last ${USAGE_WINDOW_LABELS[usage.window] ?? usageWindow} · persisted` : 'from the on-disk usage ledger'}
        >
          <CountUp value={selectedTotal} pending={usageLoading} format={fmtN} />
        </Kpi>
        <Kpi
          icon={<RefreshCw className="ic" aria-hidden="true" />}
          label="Runs"
          hint={usage ? `${selectedProviders.length} provider${selectedProviders.length === 1 ? '' : 's'} included` : 'from the on-disk usage ledger'}
        >
          <CountUp value={selectedRequests} pending={usageLoading} />
        </Kpi>
      </div>

      <section className="panel">
        <div className="ph">
          <div>
            <h3>Token usage</h3>
            {usage && selectedProviders.length > 0 ? (
              <p className="sumline">
                {fmtN(selectedTotal)} tokens · {selectedRequests} runs · prompt {fmtN(selectedBreakdown.prompt)} · output {fmtN(selectedBreakdown.completion)}
                {selectedBreakdown.cacheRead > 0 ? ` · cache ${fmtN(selectedBreakdown.cacheRead)}` : ''}
              </p>
            ) : null}
          </div>
          <div className="tabs" role="tablist" aria-label="Usage window">
            {(usage?.windows ?? Object.keys(USAGE_WINDOW_LABELS)).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={usageWindow === key}
                onClick={() => setUsageWindow(key)}
                className="tab"
              >
                {USAGE_TAB_LABELS[key] ?? key}
              </button>
            ))}
          </div>
        </div>

        {usageLoading && !usage ? (
          <p className="hint2">Loading usage…</p>
        ) : !usage || usage.providers.length === 0 ? (
          <EmptyState
            icon={<Activity className="ic" />}
            title="No usage in this window yet"
            description="Every run reports usage here — per provider, persisted on disk, surviving provider switches and chat clears."
          />
        ) : (
          <UsageChart days={usage.daily ?? []} />
        )}
      </section>

      <div className="grid2">
        <section className="panel">
          <div className="ph">
            <div>
              <h3>By provider</h3>
              <p>Toggle a provider to include it in totals.</p>
            </div>
          </div>
          {usage && usage.providers.length > 0 ? (
            <div>
              {usage.providers.map((entry) => {
                const included = checked.length === 0 || checked.includes(entry.providerId);
                const maxTotal = Math.max(...usage.providers.map((row) => row.total));
                return (
                  <div
                    key={entry.providerId}
                    className={included ? 'urow' : 'urow off'}
                    role="checkbox"
                    tabIndex={0}
                    aria-checked={included}
                    onClick={() => toggleChecked(entry.providerId)}
                    onKeyDown={(event) => {
                      if (event.key === ' ' || event.key === 'Enter') {
                        event.preventDefault();
                        toggleChecked(entry.providerId);
                      }
                    }}
                  >
                    <span className="ck">
                      <Check className="ic" aria-hidden="true" />
                    </span>
                    <span className="ub2">
                      <b>{providerLabel(entry.providerId)}</b>
                      <span className="ubar">
                        <i
                          style={
                            { '--w': `${maxTotal > 0 ? (entry.total / maxTotal) * 100 : 0}%` } as React.CSSProperties
                          }
                        />
                      </span>
                      <small>
                        {entry.requests} runs · prompt {fmtN(entry.prompt)} · output {fmtN(entry.completion)}
                        {entry.cacheRead > 0 ? ` · cache ${fmtN(entry.cacheRead)}` : ''}
                      </small>
                    </span>
                    <span className="uv">{fmtN(entry.total)}</span>
                  </div>
                );
              })}
              {checked.length > 0 && checked.length < usage.providers.length ? (
                <p className="hint2">
                  Total folds {checked.length} checked provider{checked.length === 1 ? '' : 's'} — uncheck all to include everything.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="hint2">No usage recorded in this window yet.</p>
          )}
        </section>

        <section className="panel">
          <div className="ph">
            <div>
              <h3>Provider status</h3>
              <p>{ready.length} of {providers.length} ready</p>
            </div>
            <button type="button" onClick={onOpenProviders} className="btn xs ghost">
              Manage
            </button>
          </div>

          {providers.length === 0 ? (
            <EmptyState
              icon={<Cpu className="ic" />}
              title="No providers loaded"
              description="The proxy exposes built-in providers automatically. Check that it is running."
            />
          ) : (
            <div>
              {providers.map((provider) => (
                <div key={provider.id} className="prow">
                  <span className="pav" aria-hidden="true">{provider.label.slice(0, 2)}</span>
                  <span className="min0">
                    <b>{provider.label}</b>
                    <span>{provider.baseUrl}</span>
                  </span>
                  {provider.id === providerId ? <span className="cap a">active</span> : null}
                  {provider.hasServerKey ? (
                    <span className="stat ok">Ready</span>
                  ) : (
                    <button type="button" className="stat req" onClick={onOpenProviders}>
                      Key required
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {missing.length > 0 ? (
            <p className="hint2">
              {missing.length} provider{missing.length === 1 ? '' : 's'} need a key — add them to{' '}
              <code>.env</code> and restart the server, or paste a key per browser in Configuration → Add key.
            </p>
          ) : null}
        </section>
      </div>

      <section className="panel">
        <div className="ph">
          <div>
            <h3>On this device</h3>
            <p>Stored on your machine — nothing here leaves it.</p>
          </div>
        </div>
        <div className="drow">
          <span>Device store</span>
          <b>On your computer</b>
        </div>
        <div className="drow">
          <span>Conversations</span>
          <b>{conversations.length} loaded</b>
        </div>
        <div className="drow">
          <span>Provider keys</span>
          <span className="meter">
            <i style={{ '--w': `${keyRatio}%` } as React.CSSProperties} />
          </span>
          <b>{ready.length} / {providers.length}</b>
        </div>
        <div className="drow">
          <span>Custom providers</span>
          <b>{providers.filter((provider) => !provider.builtIn).length} stored</b>
        </div>
      </section>
    </div>
  );
}

/** Design's KPI card: .kpi.spot with .kl label, .kv value, .ks hint. */
function Kpi({
  icon,
  label,
  hint,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="kpi spot">
      <span className="kl">
        {icon}
        {label}
      </span>
      <b className="kv">{children}</b>
      <span className="ks">{hint}</span>
    </div>
  );
}

/**
 * Design's countUp(): a 700ms ease-out-cubic roll from the previous value, so
 * KPI numbers animate up when data (or the range) changes instead of jumping.
 * Honors the reduce setting — an explicit choice or the OS preference.
 */
function CountUp({
  value,
  pending,
  format,
}: {
  value: number;
  pending?: boolean;
  format?: (value: number) => string;
}) {
  const reduceMotion = useStore((state) => state.reduceMotion);
  const formatValue = format ?? ((number: number) => Math.round(number).toLocaleString('en-US'));
  const lastRef = useRef(0);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (pending) return;
    const from = lastRef.current;
    lastRef.current = value;
    if (from === value || isMotionReduced(reduceMotion)) {
      setShown(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number): void => {
      const k = Math.min(1, (now - start) / 700);
      setShown(from + (value - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, pending, reduceMotion]);

  return <>{pending ? '…' : formatValue(shown)}</>;
}
