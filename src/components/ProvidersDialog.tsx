import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
  Upload,
  X,
  Zap,
} from './icons';

import {
  createProvider,
  deleteProvider,
  fetchRemoteModels,
  probeRemoteModels,
  providerHasKey,
  updateBuiltInProvider,
} from '../lib/api';
import { uid } from '../lib/storage';
import { useStore } from '../store/useStore';
import { exportAll, importBundle } from '../lib/exportImport';
import type { ProviderDraft, ProviderKind } from '../types';
import { Field, Modal, cx } from './ui';

const EMPTY_DRAFT: ProviderDraft = {
  id: '',
  label: '',
  kind: 'openai',
  baseUrl: '',
  apiKey: '',
  models: [],
  imageAdapter: '',
  imageConfigText: '',
};

/** Image adapter choices; '' means the server auto-detects from the base URL. */
const IMAGE_ADAPTER_OPTIONS = [
  { value: '', label: 'Auto-detect' },
  { value: 'openai-sync', label: 'OpenAI-compatible (sync)' },
  { value: 'modelscope-async', label: 'ModelScope (async tasks)' },
  { value: 'declarative', label: 'Custom / declarative (JSON config)' },
];

const KIND_OPTIONS: Array<{ value: ProviderKind; label: string; hint: string }> = [
  { value: 'openai', label: 'OpenAI-compatible', hint: '/chat/completions' },
  { value: 'gemini', label: 'Google Gemini', hint: 'generateContent' },
  { value: 'anthropic', label: 'Anthropic', hint: '/messages' },
];

/** Starting points offered when adding a provider, so nothing is blank. */
const QUICK_TEMPLATES: Array<{ label: string; draft: Partial<ProviderDraft> }> = [
  {
    label: 'OpenAI-compatible',
    draft: { label: 'My provider', kind: 'openai', baseUrl: 'https://api.example.com/v1' },
  },
];

interface ProvidersDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Provider manager.
 *
 * Two panes: the catalogue on the left, the editor on the right. Built-in
 * providers are read-only and say where their key comes from; custom ones are
 * fully editable and persisted server-side.
 */
export function ProvidersDialog({ open, onClose }: ProvidersDialogProps) {
  const providers = useStore((state) => state.providers);
  const loadProviders = useStore((state) => state.loadProviders);
  const providerId = useStore((state) => state.providerId);
  const setProvider = useStore((state) => state.setProvider);
  const showNotice = useStore((state) => state.showNotice);

  const [selectedId, setSelectedId] = useState<string>(providerId);
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  /** True while a built-in's live /models fetch is in flight. */
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelInput, setModelInput] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Draft key for a BUILT-IN provider (saved via the dedicated endpoint). */
  const [builtInKey, setBuiltInKey] = useState('');
  /** Draft model ids for a BUILT-IN provider (comma-separated is fine). */
  const [builtInModelInput, setBuiltInModelInput] = useState('');
  /**
   * Open model picker after a live fetch: the provider's /models list minus
   * everything already in the catalogue, with search + checkboxes so the user
   * decides what lands instead of the fetch dumping every id in at once.
   */
  const [modelPicker, setModelPicker] = useState<{ models: string[]; target: 'draft' | 'builtin' } | null>(null);
  /** Left pane: provider search query ("Cari provider"). */
  const [query, setQuery] = useState('');
  /** API key field reveal toggle (right pane). */
  const [showKey, setShowKey] = useState(false);
  /** "Test" connectivity probe result: Connected · N ms / Connection failed. */
  const [testResult, setTestResult] = useState<{ ok: boolean; ms: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  /** Base-URL copy feedback (icon flips to a check briefly). */
  const [copied, setCopied] = useState(false);
  /** API-key copy feedback (icon flips to a check briefly). */
  const [keyCopied, setKeyCopied] = useState(false);
  const activeModel = useStore((state) => state.model);

  const selected = providers.find((entry) => entry.id === selectedId);
  /** Key currently typed in the field (built-ins keep their own draft). */
  const keyValue = selected ? (selected.builtIn ? builtInKey : draft.apiKey) : '';

  useEffect(() => {
    if (!selected) return;
    setDraft({
      id: selected.id,
      label: selected.label,
      kind: selected.kind,
      baseUrl: selected.baseUrl,
      apiKey: '',
      models: selected.models,
      imageAdapter: selected.imageAdapter ?? '',
      imageConfigText: selected.imageConfig
        ? JSON.stringify(selected.imageConfig, null, 2)
        : '',
    });
    setEditing(false);
    setConfirmDelete(false);
    setShowKey(false);
    setTestResult(null);
    setCopied(false);
  }, [selected]);

  const refresh = async () => {
    await loadProviders();
  };

  /**
   * Connectivity "Test": round-trips /models through the server proxy and
   * measures the wall time — the right pane's "Connected · N ms" line.
   */
  const runTest = async () => {
    if (!selected) return;
    setTesting(true);
    setTestResult(null);
    const started = performance.now();
    try {
      await fetchRemoteModels(selected.id);
      setTestResult({ ok: true, ms: Math.round(performance.now() - started) });
    } catch (error) {
      setTestResult({
        ok: false,
        ms: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setTesting(false);
    }
  };

  /** Copies the selected provider's base URL; check icon for 1.6s. */
  const copyUrl = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.baseUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  /** Copies the typed API key; check icon for 1.6s. */
  const copyKey = async () => {
    if (!keyValue) return;
    try {
      await navigator.clipboard.writeText(keyValue);
      setKeyCopied(true);
      window.setTimeout(() => setKeyCopied(false), 1600);
    } catch {
      setKeyCopied(false);
    }
  };

  /** Saves (or clears) the UI-supplied key, or edits model ids, for a built-in. */
  const patchBuiltIn = async (
    patch: { apiKey?: string; addModels?: string[]; removeModels?: string[]; setModels?: string[] },
    successMessage: string,
  ) => {
    if (!selected || !selected.builtIn) return;
    setSaving(true);
    try {
      await updateBuiltInProvider(selected.id, patch);
      await refresh();
      setBuiltInKey('');
      setBuiltInModelInput('');
      showNotice('provider.updated', { message: successMessage });
    } catch (error) {
      showNotice('provider.updateFailed', undefined, error instanceof Error ? { detail: error.message } : undefined);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Pulls the provider's LIVE /models list through the server proxy and opens
   * the model picker: the user chooses which ids land in the built-in's
   * catalogue (already-present ids are hidden and untouched — no more
   * replace-everything fetches, and no re-adding stale curated defaults by
   * accident). Non-chat entries (embeddings, image, audio, moderation) are
   * filtered out so the chat picker stays usable.
   */
  const fetchLiveModels = async () => {
    if (!selected || !selected.builtIn) return;
    setFetchingModels(true);
    try {
      const raw = await fetchRemoteModels(selected.id);
      const NON_CHAT = /embedding|dall-e|whisper|tts|moderation|babbage|davinci|audio|realtime|transcribe|image|search|codex/i;
      const models = raw.filter((id) => !NON_CHAT.test(id));
      const fresh = models.filter((id) => !selected.models.includes(id));
      if (models.length === 0) {
        showNotice('provider.fetchNone');
        return;
      }
      if (fresh.length === 0) {
        showNotice('provider.fetchAllKnown', { count: models.length });
        return;
      }
      setModelPicker({ models: fresh, target: 'builtin' });
    } catch (error) {
      showNotice('provider.fetchFailed', undefined, error instanceof Error ? { detail: error.message } : undefined);
    } finally {
      setFetchingModels(false);
    }
  };

  const startNew = (template?: Partial<ProviderDraft>) => {    const base = template ?? QUICK_TEMPLATES[0].draft;
    setSelectedId('');
    setDraft({ ...EMPTY_DRAFT, id: uid('provider'), models: [], ...base });
    setEditing(true);
    setConfirmDelete(false);
  };

  const save = async () => {
    if (!draft.label.trim() || !draft.baseUrl.trim()) {
      showNotice('provider.labelUrlRequired');
      return;
    }

    let imageConfig: Record<string, unknown> | undefined;
    if (draft.imageConfigText.trim()) {
      try {
        const parsed = JSON.parse(draft.imageConfigText) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          showNotice('provider.imageConfigObject');
          return;
        }
        imageConfig = parsed as Record<string, unknown>;
      } catch {
        showNotice('provider.imageConfigJson');
        return;
      }
    }
    if (draft.imageAdapter === 'declarative' && !imageConfig) {
      showNotice('provider.imageConfigRequired');
      return;
    }

    setSaving(true);
    try {
      const saved = await createProvider({
        id: providers.some((entry) => entry.id === draft.id) ? draft.id : undefined,
        label: draft.label,
        kind: draft.kind,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || undefined,
        models: draft.models,
        imageAdapter: draft.imageAdapter || undefined,
        imageConfig,
      });


      await refresh();
      setSelectedId(saved.id);
      setEditing(false);
      showNotice('provider.saved', { label: saved.label });
    } catch (error) {
      showNotice('provider.saveFailed', undefined, error instanceof Error ? { detail: error.message } : undefined);
    } finally {
      setSaving(false);
    }
  };

  /** Removes a stored credential without touching the rest of the record. */
  const clearStoredKey = async () => {
    if (!selected || selected.builtIn) return;
    try {
      await createProvider({
        id: selected.id,
        label: selected.label,
        kind: selected.kind,
        baseUrl: selected.baseUrl,
        apiKey: '',
        models: selected.models,
        imageAdapter: selected.imageAdapter || undefined,
        imageConfig: selected.imageConfig,
      });
      setDraft((current) => ({ ...current, apiKey: '' }));
      showNotice('provider.keyRemoved');
    } catch (error) {
      showNotice('provider.keyRemoveFailed', undefined, error instanceof Error ? { detail: error.message } : undefined);
    }
  };

  const remove = async () => {
    if (!selected || selected.builtIn) return;
    try {
      await deleteProvider(selected.id);
      await refresh();
      setSelectedId('');
      setDraft(EMPTY_DRAFT);
      showNotice('provider.deleted');
    } catch (error) {
      showNotice('provider.deleteFailed', undefined, error instanceof Error ? { detail: error.message } : undefined);
    }
  };

  const discoverModels = async () => {
    setLoadingModels(true);
    try {
      const models = draft.baseUrl.trim()
        ? await probeRemoteModels({
            baseUrl: draft.baseUrl.trim(),
            apiKey: draft.apiKey || undefined,
            kind: draft.kind,
          })
        : providers.some((entry) => entry.id === draft.id)
          ? await fetchRemoteModels(draft.id, draft.apiKey || undefined)
          : [];
      if (models.length === 0 && !draft.baseUrl.trim()) {
        showNotice('provider.saveFirst');
        return;
      }
      const fresh = models.filter((id) => !draft.models.includes(id));
      if (models.length === 0) {
        showNotice('provider.fetchEmpty');
      } else if (fresh.length === 0) {
        showNotice('provider.fetchAllAdded', { count: models.length });
      } else {
        setModelPicker({ models: fresh, target: 'draft' });
      }
    } catch (error) {
      showNotice('provider.discoveryFailed', undefined, {
        detail: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setLoadingModels(false);
    }
  };

  /** Applies the picker's selection to the draft (custom) or the built-in catalogue. */
  const applyPicked = (picked: string[]) => {
    const target = modelPicker?.target ?? 'draft';
    setModelPicker(null);
    if (picked.length === 0) return;
    if (target === 'draft') {
      setDraft((current) => ({
        ...current,
        models: [...current.models, ...picked.filter((id) => !current.models.includes(id))],
      }));
      showNotice('provider.modelsAddedUnsaved', { count: picked.length });
    } else if (selected) {
      void patchBuiltIn({ addModels: picked }, `${picked.length} model id(s) added to ${selected.label}.`);
    }
  };

  const addModel = () => {
    const value = modelInput.trim();
    if (!value) return;
    setDraft((current) =>
      current.models.includes(value)
        ? current
        : { ...current, models: [...current.models, value] },
    );
    setModelInput('');
  };

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title="Providers"
      description="Select or add provider"
      size="wide"
      footer={
        <button type="button" className="btn ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      {}
      <div className={cx('card', 'md:grid2col')} style={{ padding: 0, gap: 0 }}>
        {}
        {/* Kiri: sidebar katalog (referensi .side) — cari, grup, daftar, tambah. */}
        <aside
          className="prov-side"
          style={{
            display: 'flex',
            maxHeight: '70vh',
            minHeight: 0,
            flexDirection: 'column',
            gap: 10,
            padding: 12,
            minWidth: 0,
          }}
        >
          {/* Search + refresh — baris atas (referensi: "Cari provider" + ikon) */}
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
              <Search
                className="ic"
                aria-hidden="true"
                style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--faint)', pointerEvents: 'none' }}
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Cari provider"
                aria-label="Cari provider"
                className="field"
                style={{ minWidth: 0, fontSize: 12.5, paddingLeft: 32, height: 36 }}
              />
            </div>
            <button
              type="button"
              onClick={refresh}
              className="ib"
              aria-label="Refresh provider list"
              style={{ flexShrink: 0, width: 36, height: 36, border: '1px solid var(--line)', borderRadius: 'var(--r-sm)' }}
            >
              <RefreshCw className="ic" aria-hidden="true" />
            </button>
          </div>

          {(() => {
            const needle = query.trim().toLowerCase();
            const visible = needle
              ? providers.filter((provider) => provider.label.toLowerCase().includes(needle))
              : providers;
            const groups: Array<{ label: string; items: typeof providers }> = [
              { label: 'Built-in', items: visible.filter((provider) => provider.builtIn) },
              { label: 'Custom', items: visible.filter((provider) => !provider.builtIn) },
            ];
            return (
              <ul style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', paddingRight: 2, margin: 0, listStyle: 'none' }}>
                {groups.map((group) => (group.items.length > 0 ? (
                  <li key={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <p style={{ margin: '4px 8px 4px', fontSize: 11, fontWeight: 500, color: 'var(--faint)' }}>
                      {group.label}
                    </p>
                    {group.items.map((provider) => {
                      const hasKey = providerHasKey(provider);
                      return (
                        <button
                          key={provider.id}
                          type="button"
                          onClick={() => setSelectedId(provider.id)}
                          className={cx('mi', provider.id === selectedId && 'on')}
                          style={{
                            alignItems: 'center',
                            gap: 10,
                            padding: '8px 10px',
                            border: '1px solid',
                            borderRadius: 'var(--r-sm)',
                            borderColor: provider.id === selectedId ? 'var(--line)' : 'transparent',
                            background: provider.id === selectedId ? 'rgb(var(--c-ink) / 0.05)' : undefined,
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style={{ flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%', background: hasKey ? 'rgb(var(--c-ok))' : 'rgb(var(--c-warn))' }}
                          />
                          <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
                            <b style={{ fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {provider.label}
                            </b>
                            <small style={{ fontSize: 10.5, fontWeight: 400, color: 'var(--faint)' }}>
                              {hasKey ? 'Ready' : 'Needs key'}
                            </small>
                          </span>
                          {provider.id === providerId ? (
                            <Check className="ic mck" style={{ opacity: 1, flexShrink: 0 }} aria-label="In use" />
                          ) : null}
                        </button>
                      );
                    })}
                  </li>
                ) : null))}
                {visible.length === 0 ? (
                  <li style={{ padding: '10px 6px', fontSize: 12, color: 'var(--faint)', textAlign: 'center' }}>
                    Tidak ada provider yang cocok.
                  </li>
                ) : null}
              </ul>
            );
          })()}

          <button
            type="button"
            onClick={() => startNew()}
            className="btn ghost"
            style={{ width: '100%', flexShrink: 0, justifyContent: 'center', height: 36, fontSize: 12.5, fontWeight: 500 }}
          >
            <Plus className="ic" aria-hidden="true" />
            Add provider
          </button>
        </aside>

        {}
        <div className="card prov-pane" style={{ maxHeight: '70vh', minWidth: 0, overflowY: 'auto', padding: 22, border: 'none', borderRadius: 0 }}>
          {editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'rgb(var(--c-ink))' }}>
                {selected ? `Edit ${draft.label}` : 'Add provider'}
              </h3>
              <div className="chipset">
                {QUICK_TEMPLATES.map((template) => (
                  <button
                    key={template.label}
                    type="button"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        ...template.draft,
                        id: current.id,
                      }))
                    }
                    className="sc"
                    style={{ fontSize: 11 }}
                  >
                    {template.label}
                  </button>
                ))}
              </div>

              <div className="grid2">
                <Field label="Display name" htmlFor="draft-label">
                  <input
                    id="draft-label"
                    value={draft.label}
                    onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                    placeholder="Acme Inference"
                    className="field"
                  />
                </Field>

                <Field label="API format" htmlFor="draft-kind" hint={KIND_OPTIONS.find((k) => k.value === draft.kind)?.hint}>
                  <select
                    id="draft-kind"
                    value={draft.kind}
                    onChange={(event) =>
                      setDraft({ ...draft, kind: event.target.value as ProviderKind })
                    }
                    className="field"
                  >
                    {KIND_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field
                label="Base URL"
                htmlFor="draft-base"
                hint="Include the version segment, e.g. https://api.example.com/v1"
              >
                <input
                  id="draft-base"
                  value={draft.baseUrl}
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                  className="field"
                  style={{ fontFamily: 'var(--f-mono)', fontSize: 12.5 }}
                />
              </Field>

              <Field
                label="API key"
                htmlFor="draft-key"
                hint={
                  providerHasKey(selected)
                    ? 'A key is already stored — leave empty to keep it.'
                    : "Stored in the server's data directory. Leave empty for local runtimes."
                }
              >
                <input
                  id="draft-key"
                  type="password"
                  value={draft.apiKey}
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                  placeholder={providerHasKey(selected) ? '•••••••• (stored)' : 'sk-…'}
                  autoComplete="off"
                  className="field"
                  style={{ fontFamily: 'var(--f-mono)', fontSize: 12.5 }}
                />
              </Field>

              {}
              {selected && !selected.builtIn && providerHasKey(selected) ? (
                <button
                  type="button"
                  onClick={() => void clearStoredKey()}
                  className="mi danger"
                  style={{ display: 'inline-flex', width: 'auto', minHeight: 0, padding: '4px 6px', gap: 6, fontSize: 11.5, fontWeight: 500, textDecoration: 'underline' }}
                >
                  <Trash2 className="ic" aria-hidden="true" />
                  Remove stored key
                </button>
              ) : null}

              <div className="card" style={{ padding: 12 }}>
                <p className="field-label" style={{ marginBottom: 8 }}>Image generation (optional)</p>

                <div className="grid2">
                  <Field
                    label="Adapter"
                    htmlFor="draft-image-adapter"
                    hint="Auto-detect picks per base URL"
                  >
                    <select
                      id="draft-image-adapter"
                      value={draft.imageAdapter}
                      onChange={(event) =>
                        setDraft({ ...draft, imageAdapter: event.target.value })
                      }
                      className="field"
                    >
                      {IMAGE_ADAPTER_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                {draft.imageAdapter === 'declarative' ? (
                  <Field
                    label="Adapter configuration (JSON)"
                    htmlFor="draft-image-config"
                    hint="submit.{path,body,taskIdPath} + poll.{path,statusPath,imagesPath,successValue,failedValue}"
                  >
                    <textarea
                      id="draft-image-config"
                      value={draft.imageConfigText}
                      onChange={(event) =>
                        setDraft({ ...draft, imageConfigText: event.target.value })
                      }
                      rows={9}
                      spellCheck={false}
                      placeholder={`{
  "submit": {
    "path": "/gen/start",
    "body": { "model": "{model}", "text": "{prompt}" },
    "taskIdPath": "result.uid"
  },
  "poll": {
    "path": "/gen/check?id={taskId}",
    "statusPath": "state",
    "imagesPath": "frames[*].link",
    "successValue": "DONE_OK",
    "failedValue": "DONE_BAD"
  }
}`}
                      className="field"
                      style={{ fontFamily: 'var(--f-mono)', fontSize: 11.5, lineHeight: 1.625 }}
                    />
                  </Field>
                ) : null}
              </div>

              <div>
                <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="field-label" style={{ marginBottom: 0 }}>Models</span>
                  <button
                    type="button"
                    onClick={discoverModels}
                    disabled={loadingModels}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 500, color: 'rgb(var(--c-accent))', textDecoration: 'underline', opacity: loadingModels ? 0.5 : 1 }}
                  >
                    <RefreshCw
                      className={cx('ic', loadingModels && 'spin')}
                      style={{ width: 12, height: 12 }}
                      aria-hidden="true"
                    />
                    Fetch from provider
                  </button>
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={modelInput}
                    onChange={(event) => setModelInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addModel();
                      }
                    }}
                    placeholder="model-id"
                    aria-label="Add a model id"
                    className="field"
                    style={{ fontFamily: 'var(--f-mono)', fontSize: 12.5 }}
                  />
                  <button
                    type="button"
                    onClick={addModel}
                    className="btn ghost"
                    style={{ flexShrink: 0 }}
                  >
                    Add
                  </button>
                </div>

                {draft.models.length > 0 ? (
                  <ul className="chipset" style={{ margin: '8px 0 0', listStyle: 'none' }}>
                    {draft.models.map((model) => (
                      <li key={model}>
                        <span className="att-chip" style={{ borderRadius: 999, height: 26, fontFamily: 'var(--f-mono)', fontSize: 11 }}>
                          {model}
                          <button
                            type="button"
                            onClick={() =>
                              setDraft({
                                ...draft,
                                models: draft.models.filter((entry) => entry !== model),
                              })
                            }
                            aria-label={`Remove ${model}`}
                            style={{ color: 'var(--faint)' }}
                          >
                            ×
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--faint)' }}>
                    No models yet. Add ids manually, or save and fetch them from the provider.
                  </p>
                )}
              </div>

              {/* Aksi form (referensi: Cancel + Save di kanan) */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
                  {saving ? 'Saving…' : selected ? 'Save changes' : 'Add provider'}
                </button>
              </div>
            </div>
          ) : selected ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Top: judul + badge + URL di kiri, aksi (Test/Edit/Use) di kanan */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'rgb(var(--c-ink))' }}>{selected.label}</h3>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        padding: '2px 8px',
                        borderRadius: 6,
                        color: providerHasKey(selected) ? 'rgb(var(--c-ok))' : 'rgb(var(--c-warn))',
                        background: providerHasKey(selected) ? 'rgb(var(--c-ok) / 0.12)' : 'rgb(var(--c-warn) / 0.12)',
                      }}
                    >
                      {providerHasKey(selected) ? 'Ready' : 'Needs key'}
                    </span>
                    {selected.id === providerId ? (
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          padding: '2px 8px',
                          borderRadius: 6,
                          color: 'rgb(var(--c-accent))',
                          background: 'rgb(var(--c-accent) / 0.14)',
                        }}
                      >
                        In use
                      </span>
                    ) : null}
                  </div>
                  {/* Base URL + copy (monospace, satu baris) */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
                    <p style={{ margin: 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320, fontFamily: 'var(--f-mono)', fontSize: 12, color: 'var(--muted)' }}>
                      {selected.baseUrl}
                    </p>
                    <button
                      type="button"
                      className="ib"
                      onClick={() => void copyUrl()}
                      aria-label="Copy base URL"
                      style={{ flexShrink: 0, width: 28, height: 28, background: 'transparent', border: 'none' }}
                    >
                      {copied
                        ? <Check className="ic" style={{ color: 'rgb(var(--c-ok))' }} aria-hidden="true" />
                        : <Copy className="ic" aria-hidden="true" />}
                    </button>
                    {selected.docsUrl ? (
                      <a href={selected.docsUrl} target="_blank" rel="noopener noreferrer" className="ib" aria-label="Provider docs" style={{ width: 28, height: 28 }}>
                        <ExternalLink className="ic" aria-hidden="true" />
                      </a>
                    ) : null}
                  </div>
                </div>

                {/* Aksi kanan (referensi: Test / Edit / Use this provider) */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => void runTest()}
                    disabled={testing}
                  >
                    {testing
                      ? <Loader2 className="ic spin" aria-hidden="true" />
                      : <Zap className="ic" aria-hidden="true" />}
                    Test
                  </button>
                  {!selected.builtIn ? (
                    <button type="button" className="btn sm ghost" onClick={() => setEditing(true)}>
                      <Pencil className="ic" aria-hidden="true" />
                      Edit
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setProvider(selected.id);
                      showNotice('provider.nowUsing', { label: selected.label });
                    }}
                    className={selected.id === providerId ? 'btn sm ghost' : 'btn sm primary'}
                  >
                    {selected.id === providerId ? <Check className="ic" aria-hidden="true" /> : null}
                    {selected.id === providerId ? 'In use' : 'Use this provider'}
                  </button>
                </div>
              </div>

              {selected.note ? (
                <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.625, color: 'var(--muted)' }}>{selected.note}</p>
              ) : null}

              {/* Status koneksi: Testing… / Connected · N ms / Connection failed */}
              {testing ? (
                <p
                  role="status"
                  style={{
                    margin: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    color: 'var(--muted)',
                  }}
                >
                  Testing connection…
                </p>
              ) : testResult ? (
                <p
                  role="status"
                  style={{
                    margin: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    fontWeight: 500,
                    color: testResult.ok ? 'rgb(var(--c-ok))' : 'rgb(var(--c-danger))',
                  }}
                >
                  {testResult.ok
                    ? <Check className="ic" style={{ width: 14, height: 14 }} aria-hidden="true" />
                    : <X className="ic" style={{ width: 14, height: 14 }} aria-hidden="true" />}
                  {testResult.ok
                    ? `Connected · ${testResult.ms} ms`
                    : `Connection failed${testResult.error ? ` — ${testResult.error}` : ''}`}
                </p>
              ) : null}

              {/* API key: input (eye toggle) + save + caption + remove */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                  <p className="field-label" style={{ margin: 0 }}>API key</p>
                  {selected.docsUrl ? (
                    <a href={selected.docsUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 500, color: 'rgb(var(--c-accent))' }}>
                      How to get one
                      <ExternalLink className="ic" style={{ width: 12, height: 12 }} aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={selected.builtIn ? builtInKey : draft.apiKey}
                    onChange={(event) => {
                      if (selected.builtIn) setBuiltInKey(event.target.value);
                      else setDraft({ ...draft, apiKey: event.target.value });
                    }}
                    placeholder={providerHasKey(selected) ? '•••••••••••• (stored)' : selected.builtIn ? 'Paste your API key...' : 'sk-...'}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="API key"
                    className="field"
                    style={{ flex: 1, minWidth: 0, fontFamily: 'var(--f-mono)', fontSize: 12.5 }}
                  />
                  <button
                    type="button"
                    className="ib"
                    onClick={() => setShowKey((value) => !value)}
                    aria-label={showKey ? 'Hide API key' : 'Show API key'}
                    style={{ flexShrink: 0, border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', background: 'rgb(var(--c-field))' }}
                  >
                    {showKey ? <EyeOff className="ic" aria-hidden="true" /> : <Eye className="ic" aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="ib"
                    onClick={() => void copyKey()}
                    aria-label="Copy API key"
                    disabled={!keyValue}
                    style={{ flexShrink: 0, border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', background: 'rgb(var(--c-field))', opacity: keyValue ? 1 : 0.45 }}
                  >
                    {keyCopied
                      ? <Check className="ic" style={{ color: 'rgb(var(--c-ok))' }} aria-hidden="true" />
                      : <Copy className="ic" aria-hidden="true" />}
                  </button>
                  {keyValue ? (
                    <button
                      type="button"
                      className="btn primary sm"
                      style={{ flexShrink: 0 }}
                      disabled={saving}
                      onClick={() => {
                        if (selected.builtIn) void patchBuiltIn({ apiKey: builtInKey.trim() }, `Key saved for ${selected.label}.`);
                        else void save();
                      }}
                    >
                      Save
                    </button>
                  ) : null}
                </div>

                <div style={{ marginTop: 6 }}>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--faint)' }}>
                    Stored in ~/.moriko/api-keys.json
                  </p>
                </div>
              </div>

              {/* Default model: chip aktif = accent solid + check (sesuai referensi) */}
              <div>
                <p className="field-label" style={{ marginBottom: 8 }}>Default model</p>
                {selected.models.length > 0 ? (
                  <ul className="chipset" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {selected.models.map((name) => {
                      const isActive = selected.id === providerId && name === activeModel;
                      return (
                        <li key={name}>
                          <button
                            type="button"
                            onClick={() => {
                              setProvider(selected.id, name);
                              showNotice('provider.modelSetTo', { model: name });
                            }}
                            className="sc"
                            aria-pressed={isActive}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              height: 32,
                              padding: '0 12px',
                              borderRadius: 8,
                              fontFamily: 'var(--f-mono)',
                              fontSize: 13,
                            }}
                          >
                            {isActive
                              ? <Check className="ic" style={{ width: 12, height: 12 }} aria-hidden="true" />
                              : null}
                            {name}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p style={{ margin: 0, fontSize: 12.5, color: 'var(--faint)' }}>
                    Belum ada model. Tambahkan lewat Edit.
                  </p>
                )}
              </div>

              {/* Details: sel terpisah (referensi .grid3/.cell) */}
              <div>
                <p className="field-label" style={{ marginBottom: 8 }}>Details</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                  {(
                    [
                      ['Format', selected.kind],
                      ['Origin', selected.builtIn ? 'Built-in' : 'Custom'],
                      ['Image adapter', `${selected.imageAdapter || 'auto'}${selected.imageCapabilities ? ` · ${selected.imageCapabilities.execution}` : ''}`],
                    ] as Array<[string, string]>
                  ).map(([label, value]) => (
                    <div
                      key={label}
                      style={{ minWidth: 0, padding: '10px 12px', borderRadius: 'var(--r-sm)', background: 'rgb(var(--c-field))' }}
                    >
                      <p style={{ margin: 0, fontSize: 12, color: 'var(--faint)' }}>{label}</p>
                      <p style={{ margin: '4px 0 0', overflowWrap: 'break-word', fontSize: 13, color: 'rgb(var(--c-ink))' }}>{value}</p>
                    </div>
                  ))}
                </div>
              </div>


              {/* Model ids — manajemen katalog built-in (tetap ada) */}
              {selected.builtIn ? (
                <div className="card" style={{ padding: 12 }}>
                  <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <p className="field-label" style={{ margin: 0 }}>Model ids</p>
                    {selected.kind === 'openai' ? (
                      <button
                        type="button"
                        disabled={saving || fetchingModels}
                        onClick={() => void fetchLiveModels()}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 500, color: 'rgb(var(--c-accent))', textDecoration: 'underline', opacity: saving || fetchingModels ? 0.4 : 1 }}
                      >
                        <RefreshCw className={cx('ic', fetchingModels && 'spin')} style={{ width: 12, height: 12 }} aria-hidden="true" />
                        Fetch latest models
                      </button>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={builtInModelInput}
                      onChange={(event) => setBuiltInModelInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          const ids = builtInModelInput.split(/[,\n]/).map((id) => id.trim()).filter(Boolean);
                          if (ids.length > 0) void patchBuiltIn({ addModels: ids }, 'Model ids added.');
                        }
                      }}
                      placeholder="model-id-1, model-id-2, ..."
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="Add model ids"
                      className="field"
                      style={{ fontFamily: 'var(--f-mono)', fontSize: 12.5 }}
                    />
                    <button
                      type="button"
                      disabled={!builtInModelInput.trim() || saving}
                      onClick={() => {
                        const ids = builtInModelInput.split(/[,\n]/).map((id) => id.trim()).filter(Boolean);
                        if (ids.length > 0) void patchBuiltIn({ addModels: ids }, 'Model ids added.');
                      }}
                      className="btn sm"
                      style={{ flexShrink: 0 }}
                    >
                      <Plus className="ic" aria-hidden="true" />
                      Add
                    </button>
                  </div>
                  <p style={{ margin: '8px 0 0', fontSize: 11, lineHeight: 1.625, color: 'var(--faint)' }}>
                    {selected.kind === 'openai'
                      ? '"Fetch latest models" opens a picker of ids the catalogue does NOT have yet — you choose what to add; existing ids are never touched. Added ids merge and appear in the chat model picker.'
                      : <>Added ids merge with the built-in list and appear in Image Studio&apos;s picker.</>}
                  </p>
                </div>
              ) : null}

              {/* Danger zone (referensi .zone): teks kiri + aksi merah kanan, konfirmasi inline */}
              {!selected.builtIn || providerHasKey(selected) ? (
                <div style={{ marginTop: 12, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
                  {confirmDelete ? (
                    <div
                      style={{
                        background: 'rgb(var(--c-danger) / 0.1)',
                        border: '1px solid rgb(var(--c-danger) / 0.4)',
                        borderRadius: 'var(--r-sm)',
                        padding: '12px 14px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        flexWrap: 'wrap',
                        fontSize: 13,
                        color: 'rgb(var(--c-danger))',
                      }}
                    >
                      <span>
                        {selected.builtIn
                          ? `Delete the saved key for ${selected.label}?`
                          : `Delete ${selected.label} and its key? This action cannot be undone.`}
                      </span>
                      <span style={{ display: 'flex', gap: 8 }}>
                        <button type="button" onClick={() => setConfirmDelete(false)} className="btn ghost sm">Cancel</button>
                        <button
                          type="button"
                          onClick={() => {
                            if (selected.builtIn) {
                              void patchBuiltIn({ apiKey: '' }, `Stored key removed from ${selected.label}.`);
                              setConfirmDelete(false);
                            } else {
                              void remove().finally(() => setConfirmDelete(false));
                            }
                          }}
                          className="btn sm"
                          style={{ background: 'rgb(var(--c-danger))', color: '#fff', borderColor: 'transparent' }}
                        >
                          {selected.builtIn ? 'Remove' : 'Delete'}
                        </button>
                      </span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', fontSize: 13, color: 'var(--muted)' }}>
                      <span>
                        {selected.builtIn
                          ? 'Delete key from this device.'
                          : 'Delete this provider from list.'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(true)}
                        className="btn sm ghost"
                        style={{ color: 'rgb(var(--c-danger))', borderColor: 'rgb(var(--c-danger) / 0.45)' }}
                      >
                        <Trash2 className="ic" aria-hidden="true" />
                        {selected.builtIn ? 'Remove key' : 'Delete provider'}
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="empty" style={{ minHeight: 220 }}>
              <Server className="ic" style={{ width: 32, height: 32, color: 'var(--faint)', marginBottom: 12 }} aria-hidden="true" />
              <b>Select a provider</b>
              <p>Pick one from the list to see its configuration, or add your own.</p>
              <div className="chipset" style={{ marginTop: 16 }}>
                <button
                  type="button"
                  onClick={() => startNew()}
                  className="btn primary sm"
                >
                  <Plus className="ic" aria-hidden="true" />
                  Add provider
                </button>
                <label className="btn ghost sm" style={{ cursor: 'pointer' }}>
                  <Upload className="ic" aria-hidden="true" />
                  Import
                  <input
                    type="file"
                    accept="application/json"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void importBundle(file, refresh);
                      event.target.value = '';
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => exportAll()}
                  className="btn ghost sm"
                >
                  <Download className="ic" aria-hidden="true" />
                  Export
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
    {/* PORTAL to document.body: the <Modal> backdrop is body-level at z-50,
        while #root's scale() transform traps this picker in a LOWER stacking
        context — its z-[60] then paints BEHIND the Providers dialog. Body-level
        it also escapes any transform containing block (dock/panel bug again). */}
    {open && modelPicker ? (
      <ModelPickerOverlay
        models={modelPicker.models}
        busy={saving || loadingModels || fetchingModels}
        onApply={applyPicked}
        onClose={() => setModelPicker(null)}
      />
    ) : null}
    </>
  );
}

/**
 * Post-fetch model chooser: the provider's live /models list (already-added
 * ids excluded by the caller) with search, per-model checkboxes and
 * select/deselect-all — the user decides what lands in the catalogue instead
 * of the fetch dumping every id in at once.
 */
function ModelPickerOverlay({
  models,
  busy,
  onApply,
  onClose,
}: {
  models: string[];
  busy?: boolean;
  onApply: (picked: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(models));

  const queryLower = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (queryLower ? models.filter((model) => model.toLowerCase().includes(queryLower)) : models),
    [models, queryLower],
  );
  const allFilteredPicked = filtered.length > 0 && filtered.every((model) => picked.has(model));

  const toggle = (model: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  const setAllFiltered = (pick: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      for (const model of filtered) {
        if (pick) next.add(model);
        else next.delete(model);
      }
      return next;
    });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Select models to add"
      className="modal open"
      style={{ zIndex: 80 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="mpanel" style={{ maxWidth: 672 }}>
        <div className="mh">
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>Select models</p>
            <p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'var(--muted)' }}>
              Fetched from the provider. Already-added ids are hidden — they can't be touched from here.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close model picker"
            className="ib"
          >
            <X className="ic" aria-hidden="true" />
          </button>
        </div>

        <div style={{ padding: '12px 16px 0' }}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (picked.size > 0) onApply([...picked]);
              }
            }}
            placeholder="Search models…"
            aria-label="Search fetched models"
            autoFocus
            className="field"
            style={{ fontFamily: 'var(--f-mono)', fontSize: 12.5 }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px' }}>
          <button
            type="button"
            onClick={() => setAllFiltered(true)}
            disabled={filtered.length === 0 || allFilteredPicked}
            className="btn ghost xs"
          >
            <Check className="ic" aria-hidden="true" />
            Select all{query.trim() ? ' (shown)' : ''}
          </button>
          <button
            type="button"
            onClick={() => setAllFiltered(false)}
            disabled={filtered.length === 0}
            className="btn ghost xs"
          >
            <X className="ic" aria-hidden="true" />
            Deselect all{query.trim() ? ' (shown)' : ''}
          </button>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--faint)' }}>{filtered.length} shown</span>
        </div>

        <div style={{ minHeight: 0, flex: 1, overflowY: 'auto', padding: '0 8px 4px' }}>
          {filtered.length === 0 ? (
            <p className="pop-empty">
              No models match &quot;{query.trim()}&quot;.
            </p>
          ) : (
            filtered.map((model) => (
              <label
                key={model}
                style={{ display: 'flex', cursor: 'pointer', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 'var(--r-sm)' }}
              >
                <input
                  type="checkbox"
                  checked={picked.has(model)}
                  onChange={() => toggle(model)}
                  style={{ accentColor: 'rgb(var(--c-accent))' }}
                />
                <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--f-mono)', fontSize: 11.5, color: 'var(--muted)' }}>{model}</span>
              </label>
            ))
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderTop: '1px solid var(--line)', padding: '12px 16px' }}>
          <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>
            {picked.size} of {models.length} selected
          </span>
          <div className="acts">
            <button type="button" onClick={onClose} className="btn ghost">
              Cancel
            </button>
            <button
              type="button"
              disabled={picked.size === 0 || busy}
              onClick={() => onApply([...picked])}
              className="btn primary"
            >
              Add {picked.size} model{picked.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
