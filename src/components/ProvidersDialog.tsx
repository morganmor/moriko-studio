import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Download,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Upload,
  X,
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

  const selected = providers.find((entry) => entry.id === selectedId);

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
  }, [selected]);

  const refresh = async () => {
    await loadProviders();
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
      // Draft-first: a draft with an endpoint probes statelessly (no save
      // needed); a SAVED custom provider falls back to its stored id.
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
      description="Built-in providers take the API key you paste below; custom ones you add here are stored by the local server."
      size="max-w-4xl"
      footer={
        <>
          <button
            type="button"
            className="pill-button text-muted hover:text-ink"
            onClick={onClose}
          >
            Close
          </button>
          {editing ? (
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="pill-button bg-accent text-accent-ink"
            >
              {saving ? 'Saving…' : 'Save provider'}
            </button>
          ) : selected && !selected.builtIn ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="pill-button bg-accent text-accent-ink"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              Edit
            </button>
          ) : null}
        </>
      }
    >
      {/* 2B: the two panes scroll INDEPENDENTLY, each under its own ceiling.
          (A grid-level max-h + overflow-hidden CLIPPED the content instead of
          scrolling it — the row track stayed content-sized, so the inner
          overflow never engaged and the bottom was unreachable.) */}
      <div className="grid items-start gap-4 md:grid-cols-[220px_1fr]">
        {}
        <div className="flex max-h-[70vh] flex-col gap-1.5">
          <button
            type="button"
            onClick={() => startNew()}
            className="flex w-full shrink-0 items-center gap-2 rounded-control border border-dashed border-hairline px-3 py-2 text-[13px] font-medium text-muted transition-colors hover:border-accent/50 hover:text-ink"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add provider
          </button>

          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5">
            {providers.map((provider) => (
              <li key={provider.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(provider.id)}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-[13px] transition-colors',
                    provider.id === selectedId
                      ? 'bg-elevated font-medium text-ink'
                      : 'text-muted hover:bg-elevated/60 hover:text-ink',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{provider.label}</span>
                  {provider.id === providerId ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-label="In use" />
                  ) : null}
                  {}
                  <span
                    className={cx(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                      providerHasKey(provider)
                        ? 'bg-success/15 text-success'
                        : 'bg-warning/15 text-warning',
                    )}
                  >
                    {providerHasKey(provider) ? 'key' : 'no key'}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={refresh}
            className="pill-button w-full shrink-0 justify-center py-1.5 text-[12px] text-muted hover:text-ink"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Refresh
          </button>
        </div>

        {}
        <div className="max-h-[70vh] min-w-0 overflow-y-auto rounded-card border border-hairline bg-canvas p-4">
          {editing ? (
            <div className="space-y-3.5">
              <div className="flex flex-wrap gap-1.5">
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
                    className="rounded-full border border-hairline px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
                  >
                    {template.label}
                  </button>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
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
                  className="field font-mono text-[12.5px]"
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
                  className="field font-mono text-[12.5px]"
                />
              </Field>

              {}
              {selected && !selected.builtIn && providerHasKey(selected) ? (
                <button
                  type="button"
                  onClick={() => void clearStoredKey()}
                  className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-danger transition-colors hover:underline"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Remove stored key
                </button>
              ) : null}

              <div className="rounded-control border border-hairline bg-surface p-3">
                <p className="field-label mb-2">Image generation (optional)</p>

                <div className="grid gap-3 sm:grid-cols-2">
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
                      className="field font-mono text-[11.5px] leading-relaxed"
                    />
                  </Field>
                ) : null}
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="field-label mb-0">Models</span>
                  <button
                    type="button"
                    onClick={discoverModels}
                    disabled={loadingModels}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline disabled:opacity-50"
                  >
                    <RefreshCw
                      className={cx('h-3 w-3', loadingModels && 'animate-spin')}
                      aria-hidden="true"
                    />
                    Fetch from provider
                  </button>
                </div>

                <div className="flex gap-1.5">
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
                    className="field font-mono text-[12.5px]"
                  />
                  <button
                    type="button"
                    onClick={addModel}
                    className="pill-button shrink-0 border border-hairline text-muted hover:text-ink"
                  >
                    Add
                  </button>
                </div>

                {draft.models.length > 0 ? (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {draft.models.map((model) => (
                      <li key={model}>
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-2.5 py-1 font-mono text-[11px] text-muted">
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
                            className="text-faint transition-colors hover:text-danger"
                          >
                            ×
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[11px] text-faint">
                    No models yet. Add ids manually, or save and fetch them from the provider.
                  </p>
                )}
              </div>
            </div>
          ) : selected ? (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-ink">{selected.label}</h3>
                  <p className="mt-0.5 break-all font-mono text-[11.5px] text-faint">
                    {selected.baseUrl}
                  </p>
                </div>
                <span
                  className={cx(
                    'shrink-0 rounded px-2 py-0.5 text-[11px]',
                    providerHasKey(selected)
                      ? 'bg-success/15 text-success'
                      : 'bg-warning/15 text-warning',
                  )}
                >
                  {providerHasKey(selected) ? 'Ready' : 'Key required'}
                </span>
              </div>

              {selected.note ? (
                <p className="text-[12.5px] leading-relaxed text-muted">{selected.note}</p>
              ) : null}

              {}
              {selected.builtIn ? (
              <div className="rounded-control border border-hairline bg-surface p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="field-label">API key</p>
                  {selected.docsUrl ? (
                    <a
                      href={selected.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11.5px] font-medium text-accent transition-colors hover:underline"
                    >
                      How to get one
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
                <div className="flex gap-1.5">
                  <input
                    type="password"
                    value={builtInKey}
                    onChange={(event) => setBuiltInKey(event.target.value)}
                    placeholder={
                      providerHasKey(selected) ? '•••••••• (stored)' : 'Paste your API key…'
                    }
                    autoComplete="off"
                    spellCheck={false}
                    className="field font-mono text-[12.5px]"
                  />
                  <button
                    type="button"
                    disabled={!builtInKey.trim() || saving}
                    onClick={() => void patchBuiltIn({ apiKey: builtInKey.trim() }, `Key saved for ${selected.label}.`)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-control bg-accent px-3 py-2 text-[12px] font-medium text-canvas transition-opacity disabled:opacity-40"
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    Save
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-[11px] text-faint">
                    Stored in ~/.moriko/api-keys.json — never sent to the browser.
                  </p>
                  {providerHasKey(selected) ? (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void patchBuiltIn({ apiKey: '' }, `Stored key removed from ${selected.label}.`)}
                      className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-danger transition-colors hover:underline"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                      Remove
                    </button>
                  ) : null}
                </div>

                {}
                <div className="mt-3 border-t border-hairline pt-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="field-label">Model ids</p>
                    {}
                    {selected.builtIn && selected.kind === 'openai' ? (
                      <button
                        type="button"
                        disabled={saving || fetchingModels}
                        onClick={() => void fetchLiveModels()}
                        className="inline-flex items-center gap-1 text-[11.5px] font-medium text-accent transition-colors hover:underline disabled:opacity-40"
                      >
                        <RefreshCw className={cx('h-3 w-3', fetchingModels && 'animate-spin')} aria-hidden="true" />
                        Fetch latest models
                      </button>
                    ) : null}
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      value={builtInModelInput}
                      onChange={(event) => setBuiltInModelInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          const ids = builtInModelInput
                            .split(/[,\n]/)
                            .map((id) => id.trim())
                            .filter(Boolean);
                          if (ids.length > 0) {
                            void patchBuiltIn({ addModels: ids }, 'Model ids added.');
                          }
                        }
                      }}
                      placeholder="model-id-1, model-id-2, …"
                      autoComplete="off"
                      spellCheck={false}
                      className="field font-mono text-[12.5px]"
                    />
                    <button
                      type="button"
                      disabled={!builtInModelInput.trim() || saving}
                      onClick={() => {
                        const ids = builtInModelInput
                          .split(/[,\n]/)
                          .map((id) => id.trim())
                          .filter(Boolean);
                        if (ids.length > 0) {
                          void patchBuiltIn({ addModels: ids }, 'Model ids added.');
                        }
                      }}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-control bg-elevated px-3 py-2 text-[12px] font-medium text-ink transition-colors hover:bg-accent-soft disabled:opacity-40"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      Add
                    </button>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-faint">
                    {selected.kind === 'openai' ? (
                      <>&quot;Fetch latest models&quot; opens a picker of ids the catalogue does NOT have yet — you choose what to add; existing ids are never touched. Added ids merge and appear in the chat model picker.</>
                    ) : (
                      <>Added ids merge with the built-in list and appear in Image Studio&apos;s picker. For Tensor.Art: the number in a model page URL. For Civitai: a full AIR URN from a model page.</>
                    )}
                  </p>
                </div>
              </div>
              ) : null}

              <dl className="space-y-1.5 rounded-control border border-hairline bg-surface px-3 py-2.5 text-[12px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-faint">Format</dt>
                  <dd className="font-mono text-muted">{selected.kind}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-faint">Origin</dt>
                  <dd className="text-muted">{selected.builtIn ? 'Built-in' : 'Custom'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-faint">Key source</dt>
                  <dd className="text-muted">
                    {selected.hasServerKey
                      ? selected.builtIn && !selected.userSuppliedKey
                        ? '.env'
                        : '~/.moriko/api-keys.json'
                      : 'not configured'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-faint">Models</dt>
                  <dd className="tabular-nums text-muted">{selected.models.length}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-faint">Image adapter</dt>
                  <dd className="font-mono text-muted">
                    {selected.imageAdapter ?? 'auto'}
                    {selected.imageCapabilities
                      ? ` · ${selected.imageCapabilities.execution}`
                      : ''}
                  </dd>
                </div>
              </dl>

              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setProvider(selected.id);
                    showNotice('provider.nowUsing', { label: selected.label });
                  }}
                  className={cx(
                    'pill-button border border-hairline text-[12px]',
                    selected.id === providerId ? 'text-success' : 'text-muted hover:text-ink',
                  )}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  {selected.id === providerId ? 'In use' : 'Use this provider'}
                </button>

                {selected.docsUrl ? (
                  <a
                    href={selected.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="pill-button border border-hairline text-[12px] text-muted hover:text-ink"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    Docs
                  </a>
                ) : null}
              </div>

              {selected.models.length > 0 ? (
                <div>
                  <p className="field-label">Suggested models</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {selected.models.map((model) => (
                      <li key={model}>
                        <button
                          type="button"
                          onClick={() => {
                            setProvider(selected.id, model);
                            showNotice('provider.modelSetTo', { model });
                          }}
                          className="rounded-full border border-hairline bg-surface px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
                        >
                          {model}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {!selected.builtIn ? (
                <div className="border-t border-hairline pt-3">
                  {confirmDelete ? (
                    <div className="flex items-center gap-2">
                      <p className="flex-1 text-[12px] text-danger">
                        Delete “{selected.label}”? This cannot be undone.
                      </p>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        className="pill-button py-1 text-[12px] text-muted hover:text-ink"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={remove}
                        className="pill-button bg-danger py-1 text-[12px] text-white"
                      >
                        Delete
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="pill-button border border-danger/40 py-1 text-[12px] text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Delete provider
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center text-center">
              <Server className="mb-3 h-8 w-8 text-faint" aria-hidden="true" />
              <p className="text-[13px] font-medium text-ink">Select a provider</p>
              <p className="mt-1 max-w-xs text-[12px] text-muted">
                Pick one from the list to see its configuration, or add your own.
              </p>
              <div className="mt-4 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => startNew()}
                  className="pill-button bg-accent text-[12px] text-accent-ink"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Add provider
                </button>
                <label className="pill-button cursor-pointer border border-hairline text-[12px] text-muted hover:text-ink">
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />
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
                  className="pill-button border border-hairline text-[12px] text-muted hover:text-ink"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
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

  // PORTAL to document.body — same reason as Modal: #root's transform makes
  // this overlay a descendant of a lower stacking context, so its z-[60]
  // loses to the body-level dialog backdrop (z-50) and renders behind it.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Select models to add"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-hairline bg-surface shadow-popover">
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-4 py-3">
          <div>
            <p className="text-sm font-medium text-ink">Select models</p>
            <p className="mt-0.5 text-[11.5px] text-muted">
              Fetched from the provider. Already-added ids are hidden — they can't be touched from here.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close model picker"
            className="shrink-0 text-faint transition-colors hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-4 pt-3">
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
            className="field font-mono text-[12.5px]"
          />
        </div>

        <div className="flex items-center gap-1.5 px-4 pb-2 pt-2">
          <button
            type="button"
            onClick={() => setAllFiltered(true)}
            disabled={filtered.length === 0 || allFilteredPicked}
            className="pill-button border border-hairline py-1 text-[11.5px] text-muted hover:text-ink disabled:opacity-40"
          >
            <Check className="h-3 w-3" aria-hidden="true" />
            Select all{query.trim() ? ' (shown)' : ''}
          </button>
          <button
            type="button"
            onClick={() => setAllFiltered(false)}
            disabled={filtered.length === 0}
            className="pill-button border border-hairline py-1 text-[11.5px] text-muted hover:text-ink disabled:opacity-40"
          >
            <X className="h-3 w-3" aria-hidden="true" />
            Deselect all{query.trim() ? ' (shown)' : ''}
          </button>
          <span className="ml-auto text-[11px] text-faint">{filtered.length} shown</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-[12px] text-faint">
              No models match &quot;{query.trim()}&quot;.
            </p>
          ) : (
            filtered.map((model) => (
              <label
                key={model}
                className="flex cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-1.5 transition-colors hover:bg-surface"
              >
                <input
                  type="checkbox"
                  checked={picked.has(model)}
                  onChange={() => toggle(model)}
                  className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{model}</span>
              </label>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-hairline px-4 py-3">
          <span className="text-[11.5px] text-faint">
            {picked.size} of {models.length} selected
          </span>
          <div className="flex gap-1.5">
            <button type="button" onClick={onClose} className="pill-button text-muted hover:text-ink">
              Cancel
            </button>
            <button
              type="button"
              disabled={picked.size === 0 || busy}
              onClick={() => onApply([...picked])}
              className="pill-button bg-accent text-accent-ink disabled:opacity-40"
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


