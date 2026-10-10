import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckSquare,
  Crop,
  Download,
  History,
  ImagePlus,
  ListFilter,
  Plus,
  Save,
  Sliders,
  Sparkles,
  Square,
  Trash2,
  X,
} from './icons';

import { cleanupImages } from '../lib/api';
import { MAX_REFERENCE_BYTES, readFileAsDataUrl, referenceFromUrl } from '../lib/imageEdit';
import { ASPECT_RATIOS, SIZE_MODE_OPTIONS, allowedSizeModes, pixelsValid } from '../lib/imageOutput';
import { useStore } from '../store/useStore';
import type { ImageSizeMode } from '../types';
import { ImageEditorModal } from './ImageEditorModal';
import { ImageLightbox } from './ImageLightbox';
import { PillSelect } from './PillSelect';
import { Tip, cx } from './ui';

/** Matches the poll cadence in the store, for the status line only. */
const IMAGE_GEN_POLL_S = 4;

/** Reference slots offered while the model is NOT edit-capable (local tray). */
const DEFAULT_TRAY_CAP = 4;

/** Retention choices for temporary images, in days (0 = never auto-delete). */
const RETENTION_OPTIONS = [
  { value: '0', label: 'Never' },
  { value: '1', label: '1 day' },
  { value: '3', label: '3 days' },
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
];

/** Starter prompts from the design's empty state (.samples chips). */
const SAMPLE_PROMPTS = [
  'pixel cat on a neon rooftop',
  'dreamy pastel clouds',
  'sunset dunes, minimal',
];

/** Design tile aspect (--ar) from a "W:H" preset; anything else is square. */
const ratioValue = (ratio: string): number => {
  const [w, h] = ratio.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 1;
};

/** Design's download filename: moriko-<prompt-slug>.jpg */
const downloadImage = (url: string, prompt: string) => {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'image';
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `moriko-${slug}.jpg`;
  anchor.click();
};

/**
 * Image Studio — a text-to-image playground for async generation APIs
 * (ModelScope's submit → poll → download pattern).
 *
 * Layout mirrors the chat workspace: results (or the hero empty state) scroll
 * above, the prompt sits in a docked composer at the bottom. Upload / edit
 * tools are ALWAYS available: files come in via picker, paste or drag & drop,
 * the client-side editor (crop / rotate / flip / resize) works for every
 * model, and whether references reach the provider is decided by the model's
 * capabilities (with a one-click switch to an edit model).
 */
export function ImageStudio() {
  const showNotice = useStore((state) => state.showNotice);
  const providers = useStore((state) => state.providers);
  const providerId = useStore((state) => state.imageProviderId);
  const model = useStore((state) => state.imageModel);
  const toggleSettings = useStore((state) => state.toggleSettings);
  const requestImagePicker = useStore((state) => state.requestImagePicker);
  const fontScale = useStore((state) => state.fontScale);
  const galleryImages = useStore((state) => state.galleryImages);
  const addToGallery = useStore((state) => state.addToGallery);
  const removeFromGallery = useStore((state) => state.removeFromGallery);
  const imageSessions = useStore((state) => state.imageSessions);
  const activeImageSessionId = useStore((state) => state.activeImageSessionId);
  const loadImageSessions = useStore((state) => state.loadImageSessions);
  const imageRetentionDays = useStore((state) => state.imageRetentionDays);
  const setImageRetentionDays = useStore((state) => state.setImageRetentionDays);
  const sizeMode = useStore((state) => state.imageSizeMode);
  const aspectRatio = useStore((state) => state.imageAspectRatio);
  const pixelWidth = useStore((state) => state.imagePixelWidth);
  const pixelHeight = useStore((state) => state.imagePixelHeight);
  const setView = useStore((state) => state.setView);
  const selectImageSession = useStore((state) => state.selectImageSession);
  const setImageStudioOutput = useStore((state) => state.setImageStudioOutput);

  const [prompt, setPrompt] = useState('');
  const gen = useStore((state) => state.imageGen);
  const startImageGeneration = useStore((state) => state.startImageGeneration);
  const cancelImageGeneration = useStore((state) => state.cancelImageGeneration);
  const clearImageGenError = useStore((state) => state.clearImageGenError);

  /** /image [prompt] pre-fill — the slash command set this before switching views. */
  useEffect(() => {
    const wanted = useStore.getState().imageStudioPromptWanted;
    if (wanted !== null) {
      if (wanted.trim()) setPrompt(wanted);
      useStore.getState().consumeImageStudioPromptRequest();
    }
  }, []);
  /** Shared reference tray — lives in the store so the editor modal and the
      results grid can feed it without prop drilling. */
  const referenceImages = useStore((state) => state.imageReferences);
  const addImageReferences = useStore((state) => state.addImageReferences);
  const removeImageReference = useStore((state) => state.removeImageReference);
  const replaceImageReference = useStore((state) => state.replaceImageReference);
  /** Bulk-cleanup mode: cards become toggles instead of lightbox openers. */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  /** Client-side editor: which image (tray slot or generated result). */
  const [editor, setEditor] = useState<{ src: string; index: number | null } | null>(null);
  /** Drag & drop of image files anywhere over the studio. */
  const [dragActive, setDragActive] = useState(false);
  const referenceInputRef = useRef<HTMLInputElement>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Design .sform: shake target when Generate fires with an empty prompt. */
  const sformRef = useRef<HTMLDivElement>(null);

  const provider = providers.find((entry) => entry.id === providerId);
  const ready = Boolean(providerId && model);
  const busy = gen.phase === 'submitting' || gen.phase === 'generating';

  const caps = provider?.imageCapabilities;
  const modelCaps = model ? caps?.models?.[model] : undefined;
  const isEditModel = modelCaps?.modes.includes('edit') ?? false;
  /**
   * ENDPOINT authority — what this provider's adapter can actually carry
   * upstream (adapter.capabilities.maxReferences). This, not the HF tag,
   * decides both the tray cap and whether references leave the client.
   */
  const endpointRefs = caps?.maxReferences ?? DEFAULT_TRAY_CAP;
  const canSendRefs = endpointRefs > 0;
  /**
   * Tray = what you may ATTACH. When the endpoint can't carry references the
   * tray stays open (editing works for every model); when it can, the endpoint
   * capacity is the ceiling — the server refuses over-cap requests loudly, so
   * matching it here avoids a guaranteed 400.
   */
  const trayCap = canSendRefs ? Math.max(endpointRefs, 1) : DEFAULT_TRAY_CAP;
  const allowedModes = useMemo<ImageSizeMode[]>(() => allowedSizeModes(caps), [caps]);
  const effectiveMode: ImageSizeMode = allowedModes.includes(sizeMode) ? sizeMode : allowedModes[0];

  const pixelsOk = pixelsValid(pixelWidth, pixelHeight);
  const width = Number(pixelWidth);
  const height = Number(pixelHeight);
  const sizeInvalid = effectiveMode === 'pixels' && !pixelsOk;
  const inGallery = new Set(galleryImages);

  const activeSession = imageSessions.find((s) => s.id === activeImageSessionId) ?? null;
  const sessionItems = useMemo(
    () => (activeSession ? [...activeSession.items].reverse() : []),
    [activeSession],
  );
  const notSaved = sessionItems
    .map((item) => item.url)
    .filter((url) => !inGallery.has(url));
  /** Hero while idle & empty; while generating, the Results grid takes over
      so the pulsing skeleton + elapsed timer are visible (first image too). */
  const showHero = sessionItems.length === 0 && !busy;

  useEffect(() => {
    void loadImageSessions();
    void useStore.getState().loadImageSettings();
  }, [loadImageSessions]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [prompt]);

  const generate = async () => {
    if (busy || !ready) return;
    if (!prompt.trim()) {
      // Design mechanism: an empty prompt shakes the form instead of a dead button.
      const form = sformRef.current;
      if (form) {
        form.classList.remove('shake');
        void form.offsetWidth;
        form.classList.add('shake');
      }
      textareaRef.current?.focus();
      showNotice('image.emptyPrompt');
      return;
    }
    let refWidth: number | undefined;
    let refHeight: number | undefined;
    if (effectiveMode === 'off' && referenceImages[0]) {
      try {
        const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
          const probe = new Image();
          probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
          probe.onerror = () => reject(new Error('reference unreadable'));
          probe.src = referenceImages[0];
        });
        const round8 = (value: number) => Math.max(8, Math.round(value / 8) * 8);
        refWidth = round8(dims.w);
        refHeight = round8(dims.h);
      } catch {
      }
    }
    void startImageGeneration({
      providerId,
      model,
      prompt: prompt.trim(),
      aspectRatio: effectiveMode === 'ratio' ? aspectRatio : undefined,
      width:
        effectiveMode === 'pixels' && pixelsOk
          ? Math.round(width)
          : refWidth,
      height:
        effectiveMode === 'pixels' && pixelsOk
          ? Math.round(height)
          : refHeight,
      images:
        canSendRefs && referenceImages.length > 0 ? referenceImages : undefined,
    });
  };

  /** Reads picked/pasted/dropped images into the tray, enforcing the cap. */
  const addReferences = async (files: File[] | FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    const loaded: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) {
        showNotice('image.notAnImage', { name: file.name });
        continue;
      }
      if (file.size > MAX_REFERENCE_BYTES) {
        showNotice('image.tooLarge', { name: file.name, max: MAX_REFERENCE_BYTES / (1024 * 1024) });
        continue;
      }
      try {
        loaded.push(await readFileAsDataUrl(file));
      } catch {
        showNotice('image.readFailed', { name: file.name });
      }
    }
    if (loaded.length === 0) return;
    const room = trayCap - referenceImages.length;
    if (room <= 0) {
      showNotice(isEditModel ? 'image.tooManyRefs' : 'image.trayFull', { model, max: trayCap });
      return;
    }
    if (loaded.length > room) {
      showNotice('image.extraRefsSkipped', { room });
    }
    addImageReferences(loaded.slice(0, room));
  };

  /** Generated result → reference tray (fetch → data URL, cap applies). */
  const useAsReference = async (url: string): Promise<void> => {
    const room = trayCap - referenceImages.length;
    if (room <= 0) {
      showNotice(isEditModel ? 'image.tooManyRefs' : 'image.trayFull', { model, max: trayCap });
      return;
    }
    try {
      addImageReferences([await referenceFromUrl(url)]);
      showNotice('image.refAttached');
    } catch {
      showNotice('image.refFetchFailed');
    }
  };

  /** Editor output: replaces the edited tray slot, or joins the tray. */
  const applyEdit = (dataUrl: string): void => {
    if (editor && editor.index !== null) {
      replaceImageReference(editor.index, dataUrl);
      showNotice('image.editApplied');
      return;
    }
    if (referenceImages.length >= trayCap) {
      showNotice(isEditModel ? 'image.tooManyRefs' : 'image.trayFull', { model, max: trayCap });
      return;
    }
    addImageReferences([dataUrl]);
    showNotice('image.editApplied');
  };

  /** Deletes temporary images (selected or all); the Gallery copy is protected
   * server-side, so a "cleanup all" can never destroy permanent images. */
  const runCleanup = async (options: { all?: boolean; urls?: string[] }) => {
    try {
      const result = await cleanupImages(options);
      showNotice(
        result.skipped > 0 ? 'image.cleanupDoneKept' : 'image.cleanupDone',
        result.skipped > 0 ? { removed: result.removed, kept: result.skipped } : { removed: result.removed },
      );
      setSelected([]);
      setSelectMode(false);
      await loadImageSessions();
    } catch (cause) {
      showNotice('image.cleanupFailed', undefined, cause instanceof Error ? { detail: cause.message } : undefined);
    }
  };

  /** Edit-only models need a reference; dual-mode ones (FLUX.2 klein/dev)
      also generate from plain text, so an empty reference is fine. This is a
      catalog HINT — it never blocks transmission, the endpoint does. */
  const requiresReference = isEditModel && !modelCaps?.modes.includes('text-to-image');
  // NOTE: a catalog hint never BLOCKS Generate — blocking is the classifier
  // An empty prompt is NOT disabled either — it shakes the form (design mechanism).
  const canGenerate = ready && !busy && !sizeInvalid;

  /** Design .page-head subtitle: session stats, or the first-run hint. */
  const studioSub = activeSession
    ? `${activeSession.items.length} image${activeSession.items.length === 1 ? '' : 's'} · ${new Date(activeSession.updatedAt).toLocaleDateString()}`
    : ready
      ? 'Describe an image, choose a size, then press Generate.'
      : 'Pick a provider and model in Configuration to start.';

  /** Design topbar action: fresh prompt + no session (generation creates one). */
  const newSession = () => {
    selectImageSession(null);
    setPrompt('');
    clearImageGenError();
    textareaRef.current?.focus();
  };

  return (
    <div
      className="view-enter"
      style={{ position: 'relative', display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column' }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        void addReferences(event.dataTransfer.files);
      }}
    >
      <div style={{ minHeight: 0, flex: 1, overflowY: 'auto' }}>
        <div className="page" style={{ zoom: fontScale }}>
          {/* Design .page-head: title + live subtitle + History / New session. */}
          <div className="page-head">
            <div>
              <h2>Image Studio</h2>
              <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--muted)' }}>{studioSub}</p>
            </div>
            <div className="acts">
              <button type="button" className="btn ghost" onClick={() => setView('imagehistory')}>
                <History className="ic" aria-hidden="true" />
                History
              </button>
              <button type="button" className="btn ghost" onClick={newSession} disabled={busy}>
                <Plus className="ic" aria-hidden="true" />
                New session
              </button>
            </div>
          </div>

          {gen.error ? (
            <div
              role="alert"
              className="card"
              style={{ marginBottom: 16, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '8px 12px', fontSize: 12.5, lineHeight: 1.625, color: 'rgb(var(--c-danger))', borderColor: 'rgb(var(--c-danger) / 0.4)', background: 'rgb(var(--c-danger) / 0.1)' }}
            >
              <p style={{ margin: 0, whiteSpace: 'pre-line' }}>
                {gen.error}
                {gen.errorAt ? (
                  <span style={{ color: 'rgb(var(--c-danger) / 0.7)' }}>
                    {' '}
                    — failed at {new Date(gen.errorAt).toLocaleTimeString()}
                  </span>
                ) : null}
              </p>
              <button
                type="button"
                onClick={clearImageGenError}
                aria-label="Dismiss error"
                className="ib xs"
                style={{ color: 'rgb(var(--c-danger) / 0.7)' }}
              >
                <X className="ic" aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {/* Design .sform: prompt card + controls row (focus glow, shake). */}
          <div className="sform" ref={sformRef}>
            {dragActive ? (
              <div style={{ position: 'absolute', inset: 0, zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'inherit', border: '2px dashed rgb(var(--c-accent))', background: 'rgb(var(--c-accent) / 0.1)', pointerEvents: 'none', backdropFilter: 'blur(1px)' }}>
                <span className="btn">Drop images to attach</span>
              </div>
            ) : null}

            {!canSendRefs && referenceImages.length > 0 ? (
              <div
                className="card"
                style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 11.5, color: 'rgb(var(--c-warn))', borderColor: 'rgb(var(--c-warn) / 0.4)', background: 'rgb(var(--c-warn) / 0.1)' }}
              >
                <AlertTriangle className="ic" style={{ width: 14, height: 14, flexShrink: 0 }} aria-hidden="true" />
                <span style={{ minWidth: 0, flex: 1 }}>
                  {provider?.label ?? 'This provider'}'s adapter cannot send
                  reference images — they will NOT be forwarded, and the provider never sees
                  them. You can still edit them below.
                </span>
                <button
                  type="button"
                  onClick={requestImagePicker}
                  className="btn ghost xs"
                  style={{ flexShrink: 0, color: 'rgb(var(--c-warn))', borderColor: 'rgb(var(--c-warn) / 0.4)' }}
                >
                  Switch provider
                </button>
              </div>
            ) : null}

            {canSendRefs && !isEditModel && referenceImages.length > 0 ? (
              <div
                className="card"
                style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 11.5, color: 'var(--muted)', background: 'rgb(var(--c-elev))' }}
              >
                <AlertTriangle className="ic" style={{ width: 14, height: 14, flexShrink: 0, color: 'rgb(var(--c-warn))' }} aria-hidden="true" />
                <span style={{ minWidth: 0, flex: 1 }}>
                  Local metadata classifies {model} as text-to-image. Your references are
                  still attached and will be sent — check your provider's docs if unsure;
                  Moriko can't verify model capability on its own.
                </span>
              </div>
            ) : null}

            {requiresReference && referenceImages.length === 0 ? (
              <p style={{ margin: '0 0 8px', fontSize: 11.5, color: 'rgb(var(--c-warn))' }}>
                Local metadata says this model edits with references — add at least one
                (attach, paste, or drop a file), or Generate may be rejected by the provider.
              </p>
            ) : null}

            <label className="sr-only" htmlFor="image-prompt">
              Image prompt
            </label>
            <textarea
              id="image-prompt"
              ref={textareaRef}
              rows={2}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void generate();
                }
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files ?? []).filter(
                  (file) => file.size > 0 && file.type.startsWith('image/'),
                );
                if (files.length === 0) return;
                event.preventDefault();
                void addReferences(files);
              }}
              placeholder={
                isEditModel
                  ? 'Describe the edit — what should change?'
                  : 'Describe the image you want… e.g. pixel cat on a neon rooftop'
              }
              style={{ display: 'block', width: '100%', border: 0, outline: 0, background: 'none', resize: 'none', padding: '6px 6px 10px', fontSize: 15, lineHeight: 1.5, color: 'inherit' }}
            />

            {referenceImages.length > 0 ? (
              <div className="composer-attach" style={{ marginTop: 4 }}>
                {referenceImages.map((dataUrl, index) => (
                  <span key={`${index}-${dataUrl.slice(-16)}`} className="att" style={{ width: 56, height: 56 }}>
                    <span className="att-clip">
                      <img
                        src={dataUrl}
                        alt={`Reference ${index + 1}`}
                        draggable={false}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    </span>
                    <button
                      type="button"
                      aria-label={`Edit reference ${index + 1}`}
                      onClick={() => setEditor({ src: dataUrl, index })}
                      className="att-doc att-over"
                    >
                      <Crop className="ic" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="att-x"
                      aria-label={`Remove reference ${index + 1}`}
                      onClick={() => removeImageReference(index)}
                    >
                      <X className="ic" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="srow" style={{ marginTop: 8 }}>
              {allowedModes.length > 1 ? (
                <div className="chipset" role="group" aria-label="Output size mode">
                  {SIZE_MODE_OPTIONS.filter((option) =>
                    (allowedModes as readonly string[]).includes(option.value),
                  ).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={effectiveMode === option.value}
                      onClick={() => setImageStudioOutput({ sizeMode: option.value as ImageSizeMode })}
                      className={cx('sc', effectiveMode === option.value && 'on')}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}

              {effectiveMode === 'ratio' ? (
                <div className="chipset" role="group" aria-label="Aspect ratio">
                  {ASPECT_RATIOS.map((ratio) => (
                    <button
                      key={ratio}
                      type="button"
                      aria-pressed={aspectRatio === ratio}
                      onClick={() => setImageStudioOutput({ aspectRatio: ratio })}
                      className={cx('sc', aspectRatio === ratio && 'on')}
                      style={{ fontFamily: 'var(--f-mono)', fontSize: 11 }}
                    >
                      {ratio}
                    </button>
                  ))}
                </div>
              ) : null}

              {effectiveMode === 'pixels' ? (
                <div className="chipset" style={{ alignItems: 'center', gap: 6 }}>
                  <input
                    type="number"
                    min={64}
                    max={4096}
                    value={pixelWidth}
                    onChange={(event) => setImageStudioOutput({ pixelWidth: event.target.value })}
                    aria-label="Width in pixels"
                    className="field"
                    style={{ width: 78, height: 30, fontSize: 12 }}
                  />
                  <span aria-hidden="true" style={{ fontSize: 11, color: 'var(--faint)' }}>×</span>
                  <input
                    type="number"
                    min={64}
                    max={4096}
                    value={pixelHeight}
                    onChange={(event) => setImageStudioOutput({ pixelHeight: event.target.value })}
                    aria-label="Height in pixels"
                    className="field"
                    style={{ width: 78, height: 30, fontSize: 12 }}
                  />
                  {!pixelsOk ? (
                    <span style={{ fontSize: 11, color: 'rgb(var(--c-danger))' }}>64–4096</span>
                  ) : null}
                </div>
              ) : null}

              <span className="grow" />

              <input
                ref={referenceInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  void addReferences(event.target.files);
                  event.target.value = '';
                }}
              />
              <Tip label="Attach images">
                <button
                  type="button"
                  className="ib"
                  aria-label="Add reference images"
                  onClick={() => referenceInputRef.current?.click()}
                >
                  <ImagePlus className="ic" aria-hidden="true" />
                </button>
              </Tip>

              {referenceImages.length > 0 ? (
                <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--faint)' }}>
                  {referenceImages.length}/{trayCap}
                </span>
              ) : null}

              <Tip label="Image settings">
                <button type="button" className="ib" aria-label="Image settings" onClick={toggleSettings}>
                  <Sliders className="ic" aria-hidden="true" />
                </button>
              </Tip>

              {busy ? (
                <>
                  <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--faint)' }}>
                    {gen.phase === 'submitting'
                      ? 'Submitting…'
                      : `${gen.elapsed}s · polling every ${IMAGE_GEN_POLL_S}s`}
                  </span>
                  <button type="button" onClick={cancelImageGeneration} className="btn sm">
                    <Square className="ic" style={{ fill: 'currentColor' }} aria-hidden="true" />
                    Stop
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => void generate()} disabled={!canGenerate} className="btn primary">
                  <Sparkles className="ic" aria-hidden="true" />
                  <span>Generate</span>
                  <kbd>Ctrl ↵</kbd>
                </button>
              )}
            </div>
          </div>

          {/* Design #sOut: empty state with sample prompts, or the session tiles. */}
          {showHero ? (
            <div className="empty" style={{ padding: '44px 18px' }}>
              <div className="eic">
                <Sparkles className="ic" aria-hidden="true" />
              </div>
              <b>{ready ? 'Describe an image' : 'No provider or model selected'}</b>
              <p>
                {ready
                  ? 'Pick a size, then press Generate — images are created through your configured provider.'
                  : 'Pick a provider and model in Configuration to start.'}
              </p>
              {ready ? (
                <div className="samples">
                  {SAMPLE_PROMPTS.map((sample) => (
                    <button
                      key={sample}
                      type="button"
                      className="sc"
                      onClick={() => {
                        setPrompt(sample);
                        textareaRef.current?.focus();
                      }}
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <section>
              <div className="sess-h">
                <b>{activeSession ? activeSession.label : 'Results'}</b>
                {!selectMode && notSaved.length > 0 ? (
                  <button type="button" onClick={() => addToGallery(notSaved)} className="btn ghost xs">
                    <Save className="ic" aria-hidden="true" />
                    Save all ({notSaved.length})
                  </button>
                ) : null}
              </div>

              <div className="chipset" style={{ marginBottom: 12 }}>
                {imageRetentionDays !== null ? (
                  <PillSelect
                    label="Temporary image auto-delete window"
                    value={String(imageRetentionDays)}
                    options={RETENTION_OPTIONS}
                    menuClassName="w-28"
                    direction="down"
                    onChange={(next) => void setImageRetentionDays(Number(next))}
                  />
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    setSelectMode((mode) => !mode);
                    setSelected([]);
                  }}
                  aria-pressed={selectMode}
                  className={cx('sc', selectMode && 'on')}
                >
                  <ListFilter className="ic" style={{ width: 13, height: 13, marginRight: 4 }} aria-hidden="true" />
                  {selectMode ? 'Selecting…' : 'Select'}
                </button>

                {selectMode && selected.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => void runCleanup({ urls: selected })}
                    className="sc"
                    style={{ color: 'rgb(var(--c-danger))', borderColor: 'rgb(var(--c-danger) / 0.4)' }}
                  >
                    <Trash2 className="ic" style={{ width: 13, height: 13, marginRight: 4 }} aria-hidden="true" />
                    Cleanup selected ({selected.length})
                  </button>
                ) : null}

                {selectMode ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm('Clean up ALL temporary images? Images saved to the Gallery are kept.')) {
                        void runCleanup({ all: true });
                      }
                    }}
                    className="sc"
                    style={{ color: 'rgb(var(--c-danger))', borderColor: 'rgb(var(--c-danger) / 0.4)' }}
                  >
                    <Trash2 className="ic" style={{ width: 13, height: 13, marginRight: 4 }} aria-hidden="true" />
                    Cleanup all
                  </button>
                ) : null}
              </div>

              <ul className="tiles" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {busy && gen.sessionId === activeImageSessionId ? (
                  <li key="generating">
                    <div
                      role="status"
                      aria-label="Generating image"
                      className="tile skel"
                      style={{ ['--ar' as string]: effectiveMode === 'ratio' ? ratioValue(aspectRatio) : 1 }}
                    >
                      {gen.phase === 'submitting' ? 'Submitting…' : `${gen.elapsed}s`}
                    </div>
                  </li>
                ) : null}
                {sessionItems.map((item) => {
                  const url = item.url;
                  const saved = inGallery.has(url);
                  const isSelected = selected.includes(url);
                  return (
                    <li key={url}>
                      <div
                        className="tile"
                        style={{ ['--ar' as string]: effectiveMode === 'ratio' ? ratioValue(aspectRatio) : 1 }}
                        role="button"
                        tabIndex={0}
                        aria-label={
                          selectMode
                            ? isSelected
                              ? 'Deselect image for cleanup'
                              : 'Select image for cleanup'
                            : `Open image — ${item.prompt.slice(0, 60) || 'no prompt'}`
                        }
                        onClick={() =>
                          selectMode
                            ? setSelected((prev) =>
                                prev.includes(url)
                                  ? prev.filter((entry) => entry !== url)
                                  : [...prev, url],
                              )
                            : setLightbox(url)
                        }
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          if (selectMode) {
                            setSelected((prev) =>
                              prev.includes(url)
                                ? prev.filter((entry) => entry !== url)
                                : [...prev, url],
                            );
                          } else {
                            setLightbox(url);
                          }
                        }}
                      >
                        <img src={url} alt="" loading="lazy" draggable={false} />
                        {!selectMode ? (
                          <div className="tov">
                            <div className="tbtns">
                              <button
                                type="button"
                                className={cx(saved && 'on')}
                                aria-label={saved ? 'Remove from Gallery' : 'Save to Gallery'}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (saved) void removeFromGallery(url);
                                  else void addToGallery([url]);
                                }}
                              >
                                <Save className="ic" style={{ fill: saved ? 'currentColor' : 'none' }} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                aria-label="Download"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  downloadImage(url, item.prompt);
                                }}
                              >
                                <Download className="ic" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                aria-label="Use as reference"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void useAsReference(url);
                                }}
                              >
                                <ImagePlus className="ic" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                aria-label="Edit image"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setEditor({ src: url, index: null });
                                }}
                              >
                                <Crop className="ic" aria-hidden="true" />
                              </button>
                            </div>
                            <span className="tcap">{item.prompt || 'No prompt'}</span>
                          </div>
                        ) : null}
                        {selectMode ? (
                          <span
                            aria-hidden="true"
                            style={{
                              position: 'absolute',
                              right: 4,
                              top: 4,
                              borderRadius: 6,
                              padding: 4,
                              background: isSelected ? 'rgb(var(--c-accent))' : 'rgb(var(--c-shadow) / 0.55)',
                              color: isSelected ? 'rgb(var(--c-accent-ink))' : 'rgb(var(--c-paper) / 0.7)',
                            }}
                          >
                            {isSelected ? (
                              <CheckSquare className="ic" style={{ width: 14, height: 14 }} />
                            ) : (
                              <Square className="ic" style={{ width: 14, height: 14 }} />
                            )}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      </div>

      {lightbox ? (
        <ImageLightbox
          url={lightbox}
          urls={sessionItems.map((entry) => entry.url)}
          onNavigate={setLightbox}
          title={activeSession?.label}
          prompt={sessionItems.find((entry) => entry.url === lightbox)?.prompt}
          saved={inGallery.has(lightbox)}
          onToggleSave={() => {
            if (inGallery.has(lightbox)) void removeFromGallery(lightbox);
            else void addToGallery([lightbox]);
          }}
          onClose={() => setLightbox(null)}
          onUsePrompt={(value) => {
            setPrompt(value);
            document.getElementById('image-prompt')?.focus();
          }}
          onUseReference={() => void useAsReference(lightbox)}
          onEditImage={() => {
            setEditor({ src: lightbox, index: null });
            setLightbox(null);
          }}
        />
      ) : null}

      {editor ? (
        <ImageEditorModal open src={editor.src} onClose={() => setEditor(null)} onApply={applyEdit} />
      ) : null}
    </div>
  );
}
