import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  KeyRound,
  Upload,
} from './icons';

import { useStore } from '../store/useStore';
import { exportAll, importBundle } from '../lib/exportImport';
import { storage } from '../lib/storage';
import { EmptyState, cx } from './ui';
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
 * Dashboard: environment health at a glance.
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

  // ── Usage ledger (server-side, per-provider, windowed) ──
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [usageWindow, setUsageWindow] = useState<string>(() => storage.loadDashboardUsageWindow());
  const [checked, setChecked] = useState<string[]>(() => loadCheckedProviders());
  const [usageLoading, setUsageLoading] = useState(true);

  const lastWindowRef = useRef(usageWindow);
  useEffect(() => {
    let cancelled = false;
    // Only a WINDOW switch blanks the card; provider checkbox toggles refetch
    // silently (the previous chart stays until the filtered series lands).
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

  // Aggregation: every checked provider folds into the headline number; when
  // nothing is checked (or all), the TOTAL is everything. The user can check
  // any subset (provider A + B only, one provider, etc.).
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
      const next = previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id];
      saveCheckedProviders(next);
      return next;
    });
  };

  const ready = providers.filter((provider) => provider.hasServerKey);
  const missing = providers.filter((provider) => !provider.hasServerKey);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-normal tracking-tight text-ink">Dashboard</h2>
          <p className="mt-1 text-sm text-muted">
            Local workspace status. Nothing here leaves your machine.
          </p>
        </div>
        <div className="flex gap-1.5">
          <label className="pill-button cursor-pointer border border-hairline text-[12px] text-muted hover:text-ink">
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
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
            className="pill-button border border-hairline text-[12px] text-muted hover:text-ink"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Export
          </button>
        </div>
      </header>

      {providersError ? (
        <div className="mb-6 rounded-card border border-danger/40 bg-danger/5 p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-danger">The local proxy is unreachable</p>
              <p className="mt-1 text-[13px] text-muted">{providersError}</p>
              <p className="mt-2 text-[12px] text-muted">
                Start it with <code className="font-mono">npm run dev</code>, then reload.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          icon={<Cpu className="h-4 w-4" />}
          label="Providers ready"
          value={`${ready.length}/${providers.length}`}
          tone={ready.length > 0 ? 'ok' : 'warn'}
        />
        <StatCard
          icon={<Database className="h-4 w-4" />}
          label="Conversations"
          value={String(conversations.length)}
          hint={`${stats.turns} turns`}
          tone="neutral"
        />
        <StatCard
          icon={<Activity className="h-4 w-4" />}
          label="Tokens used"
          value={usageLoading ? '…' : selectedTotal.toLocaleString()}
          hint={usage ? `${USAGE_WINDOW_LABELS[usage.window] ?? usageWindow} · ${selectedRequests} runs · persisted` : 'from the on-disk usage ledger'}
          tone="neutral"
        />
      </div>

      {/* ── TOKEN ACCUMULATION — windowed, per-provider, flexible aggregation ── */}
      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-ink">Token usage</h3>
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Usage window">
            {(usage?.windows ?? Object.keys(USAGE_WINDOW_LABELS)).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={usageWindow === key}
                onClick={() => setUsageWindow(key)}
                className={cx(
                  'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                  usageWindow === key ? 'bg-accent text-on-accent' : 'text-faint hover:text-ink',
                )}
              >
                {USAGE_WINDOW_LABELS[key] ?? key}
              </button>
            ))}
          </div>
        </div>

        {usageLoading ? (
          <p className="text-[12.5px] text-muted">Loading usage…</p>
        ) : !usage || usage.providers.length === 0 ? (
          <p className="rounded-card border border-hairline bg-surface px-4 py-3 text-[12.5px] text-muted">
            No usage recorded in this window yet. Every run reports usage here — per provider,
            persisted on disk, surviving provider switches and chat clears.
          </p>
        ) : (
          <div className="overflow-hidden rounded-card border border-hairline bg-surface">
            {/* Headline: the SELECTED aggregation (all by default, or the
                user's checked subset). */}
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline px-4 py-3">
              <div>
                <p className="text-2xl font-normal tabular-nums text-ink">{selectedTotal.toLocaleString()}</p>
                <p className="text-[11px] text-faint">
                  tokens · {selectedRequests} runs · {selectedProviders.length}/{usage.providers.length} providers
                </p>
              </div>
              <div className="text-right text-[11px] tabular-nums text-faint">
                <p>Prompt {selectedBreakdown.prompt.toLocaleString()} · Output {selectedBreakdown.completion.toLocaleString()}</p>
                {selectedBreakdown.cacheRead > 0 ? <p>Cache hits {selectedBreakdown.cacheRead.toLocaleString()}</p> : null}
              </div>
            </div>

            {}
            {usage.daily && usage.daily.length > 0 ? <UsageChart days={usage.daily} /> : null}

            {/* Per-provider rows with aggregation checkboxes. */}
            <ul>
              {usage.providers.map((entry) => (
                <li
                  key={entry.providerId}
                  className="flex items-center gap-3 border-b border-hairline px-4 py-2.5 last:border-b-0"
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={checked.includes(entry.providerId)}
                      onChange={() => toggleChecked(entry.providerId)}
                      className="h-3.5 w-3.5 shrink-0 accent-[rgb(var(--c-accent))]"
                      aria-label={`Include ${providerLabel(entry.providerId)} in the total`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-ink">
                        {providerLabel(entry.providerId)}
                      </span>
                      <span className="block text-[10.5px] text-faint">
                        {entry.requests} runs · prompt {entry.prompt.toLocaleString()} · output {entry.completion.toLocaleString()}
                        {entry.cacheRead > 0 ? ` · cache ${entry.cacheRead.toLocaleString()}` : ''}
                      </span>
                    </span>
                  </label>
                  <span className="shrink-0 text-[13px] tabular-nums text-muted">{entry.total.toLocaleString()}</span>
                </li>
              ))}
            </ul>
            {checked.length > 0 && checked.length < usage.providers.length ? (
              <p className="border-t border-hairline px-4 py-2 text-[10.5px] text-faint">
                Total folds {checked.length} checked provider{checked.length === 1 ? '' : 's'} — uncheck all to include everything.
              </p>
            ) : null}
          </div>
        )}
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-ink">Provider status</h3>
          <button
            type="button"
            onClick={onOpenProviders}
            className="text-[12px] font-medium text-accent hover:underline"
          >
            Manage
          </button>
        </div>

        {providers.length === 0 ? (
          <EmptyState
            icon={<Cpu className="h-5 w-5" />}
            title="No providers loaded"
            description="The proxy exposes built-in providers automatically. Check that it is running."
          />
        ) : (
          <ul className="space-y-1.5">
            {providers.map((provider) => (
              <li
                key={provider.id}
                className={cx(
                  'flex items-center gap-3 rounded-card border bg-surface px-3.5 py-2.5',
                  provider.id === providerId ? 'border-accent/50' : 'border-hairline',
                )}
              >
                <span aria-hidden="true">
                  {provider.hasServerKey ? (
                    <CheckCircle2 className="h-4 w-4 text-success" />
                  ) : (
                    <KeyRound className="h-4 w-4 text-warning" />
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink">
                    {provider.label}
                    {provider.id === providerId ? (
                      <span className="ml-2 text-[11px] font-normal text-accent">active</span>
                    ) : null}
                  </p>
                  <p className="truncate font-mono text-[11px] text-faint">{provider.baseUrl}</p>
                </div>

                {}
                <span
                  className={cx(
                    'shrink-0 rounded px-2 py-0.5 text-[11px]',
                    provider.hasServerKey
                      ? 'bg-success/15 text-success'
                      : 'bg-warning/15 text-warning',
                  )}
                >
                  {provider.hasServerKey ? 'Ready' : 'Key required'}
                </span>
              </li>
            ))}
          </ul>
        )}

        {missing.length > 0 ? (
          <div className="mt-4 rounded-card border border-hairline bg-surface p-4">
            <p className="text-[13px] font-medium text-ink">
              {missing.length} provider{missing.length === 1 ? '' : 's'} need a key
            </p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
              Add them to <code className="font-mono">.env</code> and restart the server, or paste a
              key per browser in Configuration → Add key.
            </p>
          </div>
        ) : null}
      </section>

      <section className="mt-8">
        <h3 className="mb-3 text-[13px] font-semibold text-ink">Device storage</h3>
        <dl className="space-y-1.5 rounded-card border border-hairline bg-surface px-4 py-3 text-[12.5px]">
          <Row label="Device store" value="On Your Computer" />
          <Row label="Conversations" value={`${conversations.length} loaded`} />
          <Row
            label="Provider keys"
            value={`${providers.filter((p) => p.hasServerKey).length} in the device vault`}
          />
          <Row label="Custom providers" value={`${providers.filter((p) => !p.builtIn).length} stored server-side`} />
        </dl>
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone: 'ok' | 'warn' | 'neutral';
}) {
  const toneClass =
    tone === 'ok' ? 'text-success' : tone === 'warn' ? 'text-warning' : 'text-muted';

  return (
    <div className="rounded-card border border-hairline bg-surface p-4">
      <div className={cx('mb-2 flex items-center gap-2', toneClass)}>
        <span aria-hidden="true">{icon}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-2xl font-normal tabular-nums text-ink">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-faint">{hint}</p> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-faint">{label}</dt>
      <dd className="text-right text-muted">{value}</dd>
    </div>
  );
}
