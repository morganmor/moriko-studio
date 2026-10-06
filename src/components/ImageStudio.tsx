import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Check,
  CheckSquare,
  CornerDownLeft,
  Crop,
  ImagePlus,
  ListFilter,
  Plus,
  Sliders,
  Sparkles,
  Square,
  Trash2,
  X,
} from './icons';

import { cleanupImages } from '../lib/api';
import { MAX_REFERENCE_BYTES, readFileAsDataUrl, referenceFromUrl } from '../lib/imageEdit';
import { allowedSizeModes, pixelsValid } from '../lib/imageOutput';
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
  const imageSessions = useStore((state) => state.imageSessions);
  const activeImageSessionId = useStore((state) => state.activeImageSessionId);
  const loadImageSessions = useStore((state) => state.loadImageSessions);
  const imageRetentionDays = useStore((state) => state.imageRetentionDays);
  const setImageRetentionDays = useStore((state) => state.setImageRetentionDays);
  const sizeMode = useStore((state) => state.imageSizeMode);
  const aspectRatio = useStore((state) => state.imageAspectRatio);
  const pixelWidth = useStore((state) => state.imagePixelWidth);
  const pixelHeight = useStore((state) => state.imagePixelHeight);

  const [prompt, setPrompt] = useState('');
  const gen = useStore((state) => state.imageGen);
  const startImageGeneration = useStore((state) => state.startImageGeneration);
  const cancelImageGeneration = useStore((state) => state.cancelImageGeneration);
  const clearImageGenError = useStore((state) => state.clearImageGenError);
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
    if (busy || !ready || !prompt.trim()) return;
    // Size: Default + a reference attached → reuse the INPUT image's resolution
    // (rounded to a multiple of 8). Without this the provider gets no size
    // parameter at all and falls back to its own arbitrary default (760×1280),
    // which distorts the edit relative to the source image.
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
        // Unreadable reference → fall through to the provider default.
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
      // PASS-THROUGH: every attached image leaves the client. The local HF
      // classifier never gates transmission — the endpoint's own capacity
      // does, and the server refuses over-cap requests with a clear message
      // instead of silently dropping anything.
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
        showNotice('image.tooLarge', { name: file.name });
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
  // making the final decision again (the same veto that stripped images).
  // If the tag is wrong we let the request through and the provider's own
  // rejection surfaces verbatim via errorReport.
  const canGenerate = ready && prompt.trim().length > 0 && !busy && !sizeInvalid;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
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
      {}
      {dragActive ? (
        <div className="pointer-events-none absolute inset-x-4 top-4 z-20 flex items-center justify-center rounded-card border-2 border-dashed border-accent bg-accent/10 py-16 backdrop-blur-[1px]">
          <span className="rounded-control bg-elevated px-3 py-1.5 text-[13px] font-medium text-ink shadow-popover">
            Drop images to attach
          </span>
        </div>
      ) : null}

      {}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-6" style={{ zoom: fontScale }}>
          {gen.error ? (
            <div
              role="alert"
              className="mb-4 flex items-start justify-between gap-3 rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] leading-relaxed text-danger"
            >
              <p className="whitespace-pre-line">
                {gen.error}
                {gen.errorAt ? (
                  <span className="text-danger/70">
                    {' '}
                    — failed at {new Date(gen.errorAt).toLocaleTimeString()}
                  </span>
                ) : null}
              </p>
              <button
                type="button"
                onClick={clearImageGenError}
                aria-label="Dismiss error"
                className="shrink-0 rounded p-0.5 text-danger/70 transition-colors hover:text-danger"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {showHero ? (
            <section className="flex flex-col items-center py-14 text-center">
              <Sparkles className="h-9 w-9 text-accent/80" aria-hidden="true" />
              <h2 className="mt-4 text-[26px] font-semibold tracking-tight text-ink">
                What do you want to create?
              </h2>
              {!ready ? (
                <p className="mt-3 text-[12.5px] text-faint">
                  Pick a provider and model in Configuration to start.
                </p>
              ) : !activeSession ? (
                <p className="mt-3 text-[12.5px] text-faint">
                  No session selected — generating creates one automatically.
                </p>
              ) : null}
            </section>
          ) : (
            <section>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[13px] font-semibold text-ink">
                  Results
                  {activeSession ? (
                    <span className="ml-2 inline-flex items-center gap-1.5 font-normal text-faint">
                      {activeSession.label}
                      {busy && gen.sessionId === activeSession.id ? (
                        <span
                          className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
                          aria-label="This session is generating"
                        />
                      ) : null}
                    </span>
                  ) : null}
                </h2>
                {!selectMode && notSaved.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => addToGallery(notSaved)}
                    className="pill-button border border-hairline py-1 text-[11px] text-muted hover:text-ink"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Save all to Gallery ({notSaved.length})
                  </button>
                ) : null}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
                  className={cx(
                    'pill-button border py-1 text-[11px]',
                    selectMode
                      ? 'border-accent/60 text-ink'
                      : 'border-hairline text-muted hover:text-ink',
                  )}
                >
                  <ListFilter className="h-3.5 w-3.5" aria-hidden="true" />
                  {selectMode ? 'Selecting…' : 'Select'}
                </button>

                {selectMode && selected.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => void runCleanup({ urls: selected })}
                    className="pill-button border border-danger/40 py-1 text-[11px] text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
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
                    className="pill-button border border-danger/40 py-1 text-[11px] text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Cleanup all
                  </button>
                ) : null}
              </div>

              <ul className="mt-2 grid grid-cols-4 gap-2">
                {}
                {busy && gen.sessionId === activeImageSessionId ? (
                  <li className="relative">
                    <div
                      role="status"
                      aria-label="Generating image"
                      className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-control border border-dashed border-accent/50 bg-elevated/40"
                    >
                      <Sparkles className="h-5 w-5 animate-pulse text-accent" aria-hidden="true" />
                      <span className="text-[11px] tabular-nums text-faint">
                        {gen.phase === 'submitting' ? 'Submitting…' : `${gen.elapsed}s`}
                      </span>
                    </div>
                  </li>
                ) : null}
                {sessionItems.map((item) => {
                  const url = item.url;
                  const saved = inGallery.has(url);
                  const isSelected = selected.includes(url);
                  return (
                    <li key={url} className="group relative">
                      <button
                        type="button"
                        onClick={() =>
                          selectMode
                            ? setSelected((prev) =>
                                prev.includes(url)
                                  ? prev.filter((entry) => entry !== url)
                                  : [...prev, url],
                              )
                            : setLightbox(url)
                        }
                        aria-label={
                          selectMode
                            ? isSelected
                              ? 'Deselect image for cleanup'
                              : 'Select image for cleanup'
                            : 'Open full-size image'
                        }
                        className={cx(
                          'block aspect-square w-full overflow-hidden rounded-control border transition-colors',
                          isSelected
                            ? 'border-accent ring-2 ring-accent/40'
                            : 'border-hairline hover:border-accent/60',
                        )}
                      >
                        <img
                          src={url}
                          alt={`Generated image — ${item.prompt.slice(0, 60) || 'no prompt'}`}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      </button>

                      {}
                      {!selectMode ? (
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 hidden rounded-b-control bg-gradient-to-t from-black/85 via-black/45 to-transparent p-1.5 pt-5 group-hover:block">
                          <p className="truncate text-[10.5px] text-white/85">
                            {item.prompt || 'No prompt'}
                          </p>
                          <div className="mt-1 flex justify-end gap-1">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void useAsReference(url);
                              }}
                              className="pointer-events-auto rounded-full bg-white/15 px-2 py-0.5 text-[10.5px] text-white transition-colors hover:bg-white/30"
                            >
                              Use as reference
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setEditor({ src: url, index: null });
                              }}
                              className="pointer-events-auto flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10.5px] text-white transition-colors hover:bg-white/30"
                            >
                              <Crop className="h-3 w-3" aria-hidden="true" />
                              Edit
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {selectMode ? (
                        <span
                          aria-hidden="true"
                          className={cx(
                            'absolute right-1 top-1 rounded p-1',
                            isSelected ? 'bg-accent text-accent-ink' : 'bg-black/55 text-white/70',
                          )}
                        >
                          {isSelected ? (
                            <CheckSquare className="h-3.5 w-3.5" />
                          ) : (
                            <Square className="h-3.5 w-3.5" />
                          )}
                        </span>
                      ) : saved ? (
                        <span
                          aria-label="Already in Gallery"
                          className="absolute right-1 top-1 rounded bg-black/55 p-1 text-success"
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => addToGallery([url])}
                          aria-label="Save to Gallery"
                          className="absolute right-1 top-1 rounded bg-black/55 p-1 text-white/80 opacity-0 transition-opacity hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      </div>

      {}
      <div className="px-6 py-4">
        <div className="mx-auto w-full max-w-3xl" style={{ zoom: fontScale }}>
          <div className="rounded-card border border-hairline p-3 transition-colors focus-within:border-accent/60">
            {}
            {!canSendRefs && referenceImages.length > 0 ? (
              <div className="mb-2 flex flex-wrap items-center gap-2 rounded-control border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11.5px] text-warning">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {provider?.label ?? 'This provider'}'s adapter cannot send
                  reference images — they will NOT be forwarded, and the provider never sees
                  them. You can still edit them below.
                </span>
                <button
                  type="button"
                  onClick={requestImagePicker}
                  className="pill-button shrink-0 border border-warning/40 px-2 py-0.5 text-[11px] hover:text-ink"
                >
                  Switch provider
                </button>
              </div>
            ) : null}

            {}
            {canSendRefs && !isEditModel && referenceImages.length > 0 ? (
              <div className="mb-2 flex flex-wrap items-center gap-2 rounded-control border border-hairline bg-elevated px-2.5 py-1.5 text-[11.5px] text-muted">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  Local metadata classifies {model} as text-to-image. Your references are
                  still attached and will be sent — check your provider's docs if unsure;
                  Moriko can't verify model capability on its own.
                </span>
              </div>
            ) : null}

            {}
            {requiresReference && referenceImages.length === 0 ? (
              <p className="mb-2 text-[11.5px] text-warning">
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
              rows={1}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  generate();
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
                  : 'Describe the image you want…'
              }
              className="max-h-[200px] w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink placeholder:text-faint focus:outline-none"
            />

            {}
            {referenceImages.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {referenceImages.map((dataUrl, index) => (
                  <span key={`${index}-${dataUrl.slice(-16)}`} className="group/thumb relative inline-flex">
                    <img
                      src={dataUrl}
                      alt={`Reference ${index + 1}`}
                      draggable={false}
                      className="h-14 w-14 rounded-control border border-hairline object-cover"
                    />
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-control bg-black/55 text-white opacity-0 transition-opacity group-hover/thumb:opacity-100">
                      <Crop className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <button
                      type="button"
                      aria-label={`Edit reference ${index + 1}`}
                      onClick={() => setEditor({ src: dataUrl, index })}
                      className="absolute inset-0 rounded-control focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                    />
                    <button
                      type="button"
                      aria-label={`Remove reference ${index + 1}`}
                      onClick={() => removeImageReference(index)}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-hairline bg-surface text-muted transition-colors hover:text-ink"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="icon-button"
                aria-label="Image settings"
                onClick={toggleSettings}
              >
                <Sliders className="h-4 w-4" aria-hidden="true" />
              </button>

              {}
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
                  className="icon-button"
                  aria-label="Add reference images"
                  onClick={() => referenceInputRef.current?.click()}
                >
                  <ImagePlus className="h-4 w-4" aria-hidden="true" />
                </button>
              </Tip>

              {referenceImages.length > 0 ? (
                <span className="text-[11px] tabular-nums text-faint">
                  {referenceImages.length}/{trayCap}
                </span>
              ) : null}

              {busy ? (
                <span className="text-[12px] tabular-nums text-faint">
                  {gen.phase === 'submitting'
                    ? 'Submitting…'
                    : `${gen.elapsed}s · polling every ${IMAGE_GEN_POLL_S}s`}
                </span>
              ) : null}

              <span className="flex-1" />

              {busy ? (
                <button
                  type="button"
                  onClick={cancelImageGeneration}
                  className="pill-button border border-hairline bg-elevated px-3 py-1.5 text-ink"
                >
                  <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={generate}
                  disabled={!canGenerate}
                  className="pill-button bg-accent px-4 py-1.5 text-[13px] font-semibold text-accent-ink hover:brightness-110 disabled:opacity-50"
                >
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  Generate
                  <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-faint">
            <ArrowUp className="h-3 w-3" aria-hidden="true" />
            Enter to generate, Shift + Enter for a new line. Images: paste, attach, or drop them here.
          </p>
        </div>
      </div>

      {}
      {lightbox ? (
        <ImageLightbox
          url={lightbox}
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

      {}
      {editor ? (
        <ImageEditorModal open src={editor.src} onClose={() => setEditor(null)} onApply={applyEdit} />
      ) : null}
    </div>
  );
}
