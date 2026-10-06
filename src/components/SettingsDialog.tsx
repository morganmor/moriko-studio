import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Download, Loader2, RotateCcw, Upload } from './icons';

import {
  fetchStorageLocation,
  reloadHarness,
  saveStorageLocation,
  type StorageLocationView,
} from '../lib/api';
import { exportAll, importBundle } from '../lib/exportImport';
import { McpServersCard } from './McpServersCard';
import { isPhantomConversation, useStore } from '../store/useStore';
import type { FontFamily } from '../types';
import { Tip, Modal, cx } from './ui';

const FONT_OPTIONS: Array<{ value: FontFamily; label: string; stack: string }> = [
  { value: 'inter', label: 'Inter', stack: 'Inter, sans-serif' },
  { value: 'mono', label: 'JetBrains Mono', stack: "'JetBrains Mono', monospace" },
  { value: 'system', label: 'System UI', stack: 'system-ui, sans-serif' },
];

/** Card wrapper for one settings group. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="surface-card space-y-4 p-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description ? <p className="mt-1 text-[12px] leading-relaxed text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Labeled range slider, styled like the Configuration panel's sliders. */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-medium text-muted">{label}</span>
        <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-ink">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-hairline accent-[rgb(var(--c-accent))]"
      />
      {hint ? <p className="mt-1 text-[11px] text-faint">{hint}</p> : null}
    </div>
  );
}

/**
 * Data-location card: shows where Moriko keeps everything and lets the user
 * paste another folder path. MORIKO_HOME is read once at boot, so saving only
 * persists the choice in .env (+ copies data over); the Reload harness button
 * at the end of THIS card applies it.
 */
function StorageLocationSection() {
  const showNotice = useStore((state) => state.showNotice);
  const [view, setView] = useState<StorageLocationView | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    if (reloading) return;
    setReloading(true);
    setError(null);
    reloadHarness().catch((err: unknown) => {
      setReloading(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  useEffect(() => {
    let cancelled = false;
    void fetchStorageLocation()
      .then((data) => {
        if (cancelled) return;
        setView(data);
        setDraft(data.pending ?? data.current);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = async (action: () => Promise<StorageLocationView>) => {
    setSaving(true);
    setError(null);
    try {
      const next = await action();
      setView(next);
      setDraft(next.pending ?? next.current);
      showNotice('storage.saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const dirty = view !== null && draft.trim() !== (view.pending ?? view.current);

  return (
    <div className="space-y-3">
      <div className="rounded-control border border-hairline bg-elevated/40 px-3 py-2.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Current data folder</p>
        <p className="mt-0.5 break-all font-mono text-[12px] text-ink">
          {view?.current ?? '…'}
        </p>
        {view?.pending && view.pending !== view.current ? (
          <p className="mt-1 text-[11px] text-accent">
            Saved: {view.pending} — press Reload harness to apply.
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor="storage-location-input" className="field-label">
          Custom location
        </label>
        <div className="flex items-center gap-2">
          <input
            id="storage-location-input"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={view?.default ?? '~/.moriko-studio'}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-control border border-hairline bg-elevated px-2.5 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent/60"
          />
        </div>
        <p className="mt-1 text-[11px] text-faint">
          The new folder starts empty — data in the previous location is left untouched. Applies after Reload harness.
        </p>
        {error ? <p className="mt-1 text-[11px] text-danger">{error}</p> : null}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="pill-button border border-accent/60 bg-accent-soft px-3 py-1.5 text-ink disabled:opacity-50"
          disabled={saving || !dirty || draft.trim() === ''}
          onClick={() => void commit(() => saveStorageLocation(draft))}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Save
        </button>
        <span className="mx-1 h-5 w-px bg-hairline" aria-hidden="true" />
        <Tip label="Restart the local server — applies the new data folder">
        <button
          type="button"
          className="pill-button items-center border border-hairline px-3 py-1.5 text-muted hover:text-ink disabled:opacity-60"
          onClick={reload}
          disabled={reloading}
          aria-label="Reload harness"
        >
          {reloading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
          )}
          {reloading ? 'Reloading…' : 'Reload harness'}
        </button>
        </Tip>
      </div>
    </div>
  );
}

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Workspace preferences dialog, opened from the sidebar's Manage section.
 *
 * Appears over whatever view the user is on and closes via ✕, Escape, or a
 * backdrop click. Everything here is app-wide: theme, font size, font style,
 * and the data tools (export / import / clear conversations). Model and
 * per-conversation run settings live in the right-hand Configuration panel.
 */
export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const theme = useStore((state) => state.theme);
  const setTheme = useStore((state) => state.setTheme);
  const fontScale = useStore((state) => state.fontScale);
  const setFontScale = useStore((state) => state.setFontScale);
  const contextScale = useStore((state) => state.contextScale);
  const setContextScale = useStore((state) => state.setContextScale);
  const fontFamily = useStore((state) => state.fontFamily);
  const setFontFamily = useStore((state) => state.setFontFamily);
  const conversationCount = useStore(
    (state) => state.conversations.filter((entry) => !isPhantomConversation(entry)).length,
  );
  const clearAllConversations = useStore((state) => state.clearAllConversations);
  const showNotice = useStore((state) => state.showNotice);

  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const handleClear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 4000);
      return;
    }
    clearAllConversations();
    setConfirmClear(false);
    showNotice('conversations.cleared');
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      description="Customize the workspace and manage your data."
      size="max-w-2xl"
    >
      <div className="space-y-5">
        <Section title="Appearance" description="Theme, font size, and workspace font style.">
          <div>
            <p className="field-label">Theme</p>
            <div className="flex gap-2">
              {(['dark', 'light', 'mocha'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTheme(value)}
                  aria-pressed={theme === value}
                  className={cx(
                    'pill-button flex-1 justify-center border transition-colors',
                    theme === value
                      ? 'border-accent/60 bg-accent-soft text-ink'
                      : 'border-hairline text-muted hover:text-ink',
                  )}
                >
                  {value === 'mocha' ? 'Mocha' : value === 'dark' ? 'Dark' : 'Light'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <SliderRow
              label="Font size app"
              value={fontScale}
              min={0.8}
              max={1.4}
              step={0.01}
              format={(value) => `${Math.round(value * 100)}%`}
              onChange={setFontScale}
            />
            <SliderRow
              label="Font size context"
              value={contextScale}
              min={0.8}
              max={1.4}
              step={0.01}
              format={(value) => `${Math.round(value * 100)}%`}
              onChange={setContextScale}
            />
            <div className="mt-1 flex items-center justify-between">
              <p className="text-[11px] text-faint">
                App scales everything except the chat; context scales the conversation and composer only.
              </p>
              <button
                type="button"
                onClick={() => {
                  setFontScale(1);
                  setContextScale(1);
                }}
                className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted transition-colors hover:text-ink"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                Reset
              </button>
            </div>
          </div>

          <div>
            <p className="field-label">Font style</p>
            <div className="grid grid-cols-3 gap-2">
              {FONT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFontFamily(option.value)}
                  aria-pressed={fontFamily === option.value}
                  className={cx(
                    'rounded-control border px-3 py-2.5 text-left transition-colors',
                    fontFamily === option.value
                      ? 'border-accent/60 bg-accent-soft'
                      : 'border-hairline hover:border-accent/40',
                  )}
                >
                  <span className="block text-[13px] font-medium text-ink" style={{ fontFamily: option.stack }}>
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted" style={{ fontFamily: option.stack }}>
                    Aa Bb 123
                  </span>
                </button>
              ))}
            </div>
          </div>
        </Section>

        <Section
          title="MCP servers"
          description="Register tool servers (local command or remote URL) the model may call when Use MCP is on. Enable the toggle in Configuration → Tools."
        >
          <McpServersCard />
        </Section>

        <Section
          title="Data"
          description="Everything lives in one folder on this machine — chats, providers, images, agent state."
        >
          <StorageLocationSection />
        </Section>

        <Section title="Conversations" description="Portability for your chats.">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[13px] font-medium text-ink">Export conversations</p>
              <p className="mt-0.5 text-[11.5px] text-muted">
                Download all {conversationCount} conversation(s) as a JSON bundle.
              </p>
            </div>
            <button
              type="button"
              className="pill-button shrink-0 border border-hairline text-muted hover:text-ink"
              onClick={() => void exportAll()}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Export
            </button>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[13px] font-medium text-ink">Import conversations</p>
              <p className="mt-0.5 text-[11.5px] text-muted">
                Restore from a Moriko export bundle (.json). Replaces current chats.
              </p>
            </div>
            <button
              type="button"
              className="pill-button shrink-0 border border-hairline text-muted hover:text-ink"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-4 w-4" aria-hidden="true" />
              Import
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importBundle(file, async () => {});
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[13px] font-medium text-ink">Clear all conversations</p>
              <p className="mt-0.5 text-[11.5px] text-muted">
                Permanently removes every chat from this device.
              </p>
            </div>
            <button
              type="button"
              onClick={handleClear}
              className={cx(
                'pill-button shrink-0 border transition-colors',
                confirmClear
                  ? 'border-danger bg-danger/10 text-danger'
                  : 'border-danger/40 text-danger hover:bg-danger/10',
              )}
            >
              {confirmClear ? 'Click again to confirm' : 'Clear'}
            </button>
          </div>
        </Section>
      </div>
    </Modal>
  );
}
