import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Download, Folder, Loader2, MessageSquare, Palette, Plug, RotateCcw, Upload } from './icons';

import {
  fetchStorageLocation,
  reloadHarness,
  saveStorageLocation,
  type StorageLocationView,
} from '../lib/api';
import { exportAll, importBundle } from '../lib/exportImport';
import { isMotionReduced } from '../lib/appearance';
import { McpServersCard } from './McpServersCard';
import { isPhantomConversation, useStore } from '../store/useStore';
import type { Accent, Density, FontFamily, ThemeMode } from '../types';
import { Tip, Modal, Toggle } from './ui';

/** Theme cards (design panel-settings): live previews scoping each scheme. */
const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; preview: ReactNode }> = [
  {
    value: 'light',
    label: 'Light',
    preview: (
      <span className="thp scope-light">
        <i />
        <b />
        <em />
      </span>
    ),
  },
  {
    value: 'dark',
    label: 'Dark',
    preview: (
      <span className="thp scope-dark">
        <i />
        <b />
        <em />
      </span>
    ),
  },
  {
    value: 'mocha',
    label: 'Mocha',
    preview: (
      <span className="thp scope-dark scope-mocha">
        <i />
        <b />
        <em />
      </span>
    ),
  },
  {
    value: 'system',
    label: 'System',
    preview: (
      <span className="thp split">
        <span className="scope-light">
          <i />
          <b />
        </span>
        <span className="scope-dark">
          <i />
          <b />
        </span>
      </span>
    ),
  },
];

/** Accent swatches — each button carries its own data-accent so the circle
 *  paints with THAT swatch's colour instead of the active one. */
const ACCENT_OPTIONS: Array<{ value: Accent; label: string }> = [
  { value: 'ember', label: 'Ember' },
  { value: 'sakura', label: 'Sakura' },
  { value: 'matcha', label: 'Matcha' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'violet', label: 'Violet' },
];

const FONT_SEG: Array<{ value: FontFamily; label: string }> = [
  { value: 'inter', label: 'Inter' },
  { value: 'system', label: 'System' },
  { value: 'mono', label: 'Mono' },
];

const DENSITY_SEG: Array<{ value: Density; label: string }> = [
  { value: 'comfy', label: 'Comfy' },
  { value: 'compact', label: 'Compact' },
];

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
      <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>{label}</span>
        <span style={{ borderRadius: 4, background: 'rgb(var(--c-elev))', padding: '2px 6px', fontFamily: 'var(--f-mono)', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'rgb(var(--c-ink))' }}>
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
        style={{ ['--fill' as string]: `${((value - min) / (max - min)) * 100}%` }}
      />
      {hint ? <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--faint)' }}>{hint}</p> : null}
    </div>
  );
}

/**
 * Segmented control with the design's sliding indicator (initSeg mechanism):
 * .ind tracks the checked button's offsetLeft/width, and a ResizeObserver
 * re-lays it out whenever the control changes size.
 */
function SegControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const indRef = useRef<HTMLSpanElement>(null);

  const layout = useCallback(() => {
    const root = rootRef.current;
    const indicator = indRef.current;
    if (!root || !indicator) return;
    const active = root.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!active || !active.offsetWidth) return;
    indicator.style.setProperty('--x', `${active.offsetLeft}px`);
    indicator.style.setProperty('--w', `${active.offsetWidth}px`);
  }, []);

  useLayoutEffect(layout, [value, layout]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(layout);
    observer.observe(root);
    return () => observer.disconnect();
  }, [layout]);

  return (
    <div ref={rootRef} className="seg sm" role="radiogroup" aria-label={label}>
      <span ref={indRef} className="ind" aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--line)', background: 'rgb(var(--c-elev) / 0.4)', padding: '10px 12px' }}>
        <p style={{ margin: 0, fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--faint)' }}>Current data folder</p>
        <p style={{ margin: '2px 0 0', overflowWrap: 'break-word', fontFamily: 'var(--f-mono)', fontSize: 12, color: 'rgb(var(--c-ink))' }}>
          {view?.current ?? '…'}
        </p>
        {view?.pending && view.pending !== view.current ? (
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'rgb(var(--c-accent))' }}>
            Saved: {view.pending} — press Reload harness to apply.
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor="storage-location-input" className="field-label">
          Custom location
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id="storage-location-input"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={view?.default ?? '~/.moriko-studio'}
            spellCheck={false}
            autoComplete="off"
            className="field"
            style={{ minWidth: 0, flex: 1, fontSize: 12 }}
          />
        </div>
        <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--faint)' }}>
          The new folder starts empty — data in the previous location is left untouched. Applies after Reload harness.
        </p>
        {error ? <p style={{ margin: '4px 0 0', fontSize: 11, color: 'rgb(var(--c-danger))' }}>{error}</p> : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        <button
          type="button"
          className="btn sm"
          style={{ borderColor: 'rgb(var(--c-accent) / 0.6)', background: 'var(--c-accent-soft)', color: 'rgb(var(--c-ink))' }}
          disabled={saving || !dirty || draft.trim() === ''}
          onClick={() => void commit(() => saveStorageLocation(draft))}
        >
          {saving ? <Loader2 className="ic spin" aria-hidden="true" /> : null}
          Save
        </button>
        <span style={{ width: 1, height: 20, margin: '0 4px', background: 'var(--line)' }} aria-hidden="true" />
        <Tip label="Restart the local server — applies the new data folder">
        <button
          type="button"
          className="btn sm"
          onClick={reload}
          disabled={reloading}
          aria-label="Reload harness"
        >
          {reloading ? (
            <Loader2 className="ic spin" aria-hidden="true" />
          ) : (
            <RotateCcw className="ic" aria-hidden="true" />
          )}
          {reloading ? 'Reloading…' : 'Reload harness'}
        </button>
        </Tip>
      </div>
    </div>
  );
}

type SettingsTab = 'appearance' | 'mcp' | 'storage' | 'conversations';

/** One sidebar entry. */
const NAV_GROUPS: Array<{ label: string; items: Array<{ id: SettingsTab; label: string; icon: ReactNode }> }> = [
  {
    label: 'General',
    items: [{ id: 'appearance', label: 'Appearance', icon: <Palette className="ic" aria-hidden="true" /> }],
  },
  {
    label: 'Integrations',
    items: [{ id: 'mcp', label: 'MCP servers', icon: <Plug className="ic" aria-hidden="true" /> }],
  },
  {
    label: 'Data',
    items: [
      { id: 'storage', label: 'Storage', icon: <Folder className="ic" aria-hidden="true" /> },
      { id: 'conversations', label: 'Conversations', icon: <MessageSquare className="ic" aria-hidden="true" /> },
    ],
  },
];

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
  const [tab, setTab] = useState<SettingsTab>('appearance');
  const theme = useStore((state) => state.theme);
  const setTheme = useStore((state) => state.setTheme);
  const accent = useStore((state) => state.accent);
  const setAccent = useStore((state) => state.setAccent);
  const density = useStore((state) => state.density);
  const setDensity = useStore((state) => state.setDensity);
  const ambient = useStore((state) => state.ambient);
  const setAmbient = useStore((state) => state.setAmbient);
  const reduceMotion = useStore((state) => state.reduceMotion);
  const setReduceMotion = useStore((state) => state.setReduceMotion);
  const confirmDel = useStore((state) => state.confirmDel);
  const setConfirmDel = useStore((state) => state.setConfirmDel);
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
      size="wide"
    >
      <div className="set-body">
        <nav className="set-nav" role="tablist" aria-label="Settings sections">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="gl">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  role="tab"
                  aria-selected={tab === item.id}
                  onClick={() => setTab(item.id)}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="set-content">
          {tab === 'appearance' && (
            <div className="set-panel">
              <div className="set-head">
                <h3>Appearance</h3>
                <p>Theme, accent, and the workspace feel.</p>
              </div>
              <div className="set-sec">
                <div className="lab">Theme</div>
                <div className="themes" role="radiogroup" aria-label="Theme">
                  {THEME_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={theme === option.value}
                      onClick={(event) => setTheme(option.value, event)}
                      className="thc"
                    >
                      {option.preview}
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-sec">
                <div className="lab">Accent</div>
                <div className="swatches" role="radiogroup" aria-label="Accent">
                  {ACCENT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={accent === option.value}
                      aria-label={option.label}
                      data-accent={option.value}
                      onClick={() => setAccent(option.value)}
                      className="swt"
                    />
                  ))}
                </div>
              </div>
              <div className="set-sec">
                <div className="lab">Interface</div>
                <div className="set-row">
                  <div className="min0">
                    <b>Font</b>
                    <span>Inter, System UI, or JetBrains Mono.</span>
                  </div>
                  <SegControl label="Font" value={fontFamily} options={FONT_SEG} onChange={setFontFamily} />
                </div>
                <div className="set-row">
                  <div className="min0">
                    <b>Density</b>
                    <span>Row height and spacing.</span>
                  </div>
                  <SegControl label="Density" value={density} options={DENSITY_SEG} onChange={setDensity} />
                </div>
                <div className="set-row">
                  <div className="min0">
                    <b>Reduce motion</b>
                    <span>Follows your OS until changed.</span>
                  </div>
                  <Toggle
                    hideLabel
                    label="Reduce motion"
                    checked={isMotionReduced(reduceMotion)}
                    onChange={setReduceMotion}
                  />
                </div>
                <div className="set-row">
                  <div className="min0">
                    <b>Ambient glow</b>
                    <span>Soft drifting light behind the app.</span>
                  </div>
                  <Toggle hideLabel label="Ambient glow" checked={ambient} onChange={setAmbient} />
                </div>
                <div className="set-row">
                  <div className="min0">
                    <b>Confirm before delete</b>
                    <span>Otherwise delete instantly.</span>
                  </div>
                  <Toggle hideLabel label="Confirm before delete" checked={confirmDel} onChange={setConfirmDel} />
                </div>
              </div>
              <div className="set-sec">
                <div className="lab">Scale</div>
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
                <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--faint)' }}>
                    App scales everything except the chat; context scales the conversation and composer only.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setFontScale(1);
                      setContextScale(1);
                    }}
                    className="nav"
                    style={{ height: 'auto', flexShrink: 0, padding: 0, fontSize: 11, gap: 4 }}
                  >
                    <RotateCcw className="ic" style={{ width: 12, height: 12 }} aria-hidden="true" />
                    Reset
                  </button>
                </div>
              </div>
            </div>
          )}

          {tab === 'mcp' && (
            <div className="set-panel">
              <div className="set-head">
                <h3>MCP servers</h3>
                <p>Register tool servers (local command or remote URL) the model may call when Use MCP is on. Enable the toggle in Configuration → Tools.</p>
              </div>
              <McpServersCard />
            </div>
          )}

          {tab === 'storage' && (
            <div className="set-panel">
              <div className="set-head">
                <h3>Storage</h3>
                <p>Everything lives in one folder on this machine — chats, providers, images, agent state.</p>
              </div>
              <StorageLocationSection />
            </div>
          )}

          {tab === 'conversations' && (
            <div className="set-panel">
              <div className="set-head">
                <h3>Conversations</h3>
                <p>Portability for your chats.</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                <div>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>Export conversations</p>
                  <p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>
                    Download all {conversationCount} conversation(s) as a JSON bundle.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ flexShrink: 0 }}
                  onClick={() => void exportAll()}
                >
                  <Download className="ic" aria-hidden="true" />
                  Export
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                <div>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>Import conversations</p>
                  <p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>
                    Restore from a Moriko export bundle (.json). Replaces current chats.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ flexShrink: 0 }}
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="ic" aria-hidden="true" />
                  Import
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void importBundle(file, async () => {});
                  }}
                />
              </div>
              <div className="set-sec" style={{ marginTop: 4 }}>
                <div className="lab" style={{ color: 'rgb(var(--c-danger))' }}>Danger zone</div>
                <div style={{ border: '1px solid rgb(var(--c-danger) / 0.4)', borderRadius: 'var(--r-lg)', padding: '12px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                    <div>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>Clear all conversations</p>
                      <p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>
                        Permanently removes every chat from this device.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleClear}
                      className="btn danger sm"
                      style={{
                        flexShrink: 0,
                        background: confirmClear ? 'rgb(var(--c-danger) / 0.1)' : 'transparent',
                        borderColor: confirmClear ? 'rgb(var(--c-danger))' : 'rgb(var(--c-danger) / 0.4)',
                      }}
                    >
                      {confirmClear ? 'Click again to confirm' : 'Clear'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
