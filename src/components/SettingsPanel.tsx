import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Eye,
  Gauge,
  Link2,
  Loader2,
  Lock,
  MapPin,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  ToyBrick,
  Wand2,
  X,
} from './icons';

import { PROMPT_PRESETS } from '../lib/prompts';
import {
  fetchVisionConfig,
  providerHasKey,
  saveVisionConfig,
  updateBuiltInProvider,
  type VisionConfig,
} from '../lib/api';
import { lookupModelMeta, nearestThinkingLevel, thinkingLadderFor } from '../lib/modelMeta';
import {
  ASPECT_RATIOS,
  PX_MAX,
  PX_MIN,
  SIZE_MODE_OPTIONS,
  allowedSizeModes,
  pixelsValid,
} from '../lib/imageOutput';
import { storage, uid } from '../lib/storage';
import { useChatController } from '../hooks/useChatController';
import { DEFAULT_SETTINGS, useEffectiveSettings, useStore } from '../store/useStore';
import type { ChatSettings, ImageSizeMode, SavedPrompt, ThinkingLevel, TrustTier } from '../types';
import { CollapseSection, Modal, RightDockCloseButton, RightDockSlot, Tip, Toggle, cx } from './ui';

/**
 * Copy for every canonical level. WHICH of these are offered is decided per
 * model by `thinkingLevelsFor` (models.dev) — this table only names them.
 */
/** Exported for the composer's quick Model/Effort picker — one label table, two UIs. */
export const THINKING_COPY: Record<ThinkingLevel, { label: string; hint: string }> = {
  off: { label: 'Off', hint: 'Fastest. No reasoning budget is sent.' },
  minimal: {
    label: 'Minimal',
    hint: 'A token amount of reasoning — the lightest level some models accept.',
  },
  low: { label: 'Low', hint: 'Minimal reasoning — good for lookups.' },
  medium: { label: 'Medium', hint: 'Balanced default for most work.' },
  high: { label: 'High', hint: 'Deep reasoning. Best for hard multi-step problems.' },
  xhigh: {
    label: 'Xhigh',
    hint: 'Deeper than high — offered only by models whose catalog entry lists it.',
  },
  max: {
    label: 'Max',
    hint: 'Maximum reasoning budget — offered only by models whose catalog entry lists it.',
  },
};

/** Fallback slider ceiling when no models.dev entry exists: dragging fully
 *  right selects "Max" (provider decides). A catalog entry's maxOut wins. */
const MAX_TOKENS_SLIDER = 65536;

/** Rounds a model's reported output ceiling up to the next slider step. */
function sliderCeilingFor(maxOut: number | null | undefined): number {
  if (maxOut === null || maxOut === undefined || !Number.isFinite(maxOut) || maxOut <= 0) return MAX_TOKENS_SLIDER;
  return Math.max(256, Math.min(1_048_576, Math.ceil(maxOut / 256) * 256));
}

interface SettingsPanelProps {
  onOpenProviders: () => void;
  /** Called after opening the providers dialog from the mobile drawer. */
  onNavigate?: () => void;
  /**
   * Provided only when the panel is mounted as a drawer (below `lg`), whose
   * backdrop covers the header toggle — the panel then carries its own ✕.
   */
  onClose?: () => void;
  /**
   * Provided when the panel is docked (at `lg`): the TopBar toggle hides
   * while the panel is open, so the header corner carries the dock's GENERIC
   * close button instead, keeping the toggle inside the panel's own edge.
   */
  onCollapse?: () => void;
  /** Drag-resizable panel width (device-persisted); 300 default. */
  width?: number;
}

/**
 * Right-hand "Configuration" panel.
 *
 * Edits apply to the active conversation. When no thread exists the edit is
 * still accepted and seeds the next one, so the panel never feels inert.
 * Below `lg` the panel is mounted as a drawer by `App`, so `onNavigate` lets
 * it dismiss the drawer after launching the providers dialog.
 */
export function SettingsPanel({ onOpenProviders, onNavigate, onClose, width }: SettingsPanelProps) {
  const settings = useEffectiveSettings();
  const updateSettings = useStore((state) => state.updateSettings);
  const providers = useStore((state) => state.providers);
  const providerId = useStore((state) => state.providerId);
  const model = useStore((state) => state.model);
  const view = useStore((state) => state.view);
  const imageProviderId = useStore((state) => state.imageProviderId);
  const imageModel = useStore((state) => state.imageModel);
  const imageSizeMode = useStore((state) => state.imageSizeMode);
  const imageAspectRatio = useStore((state) => state.imageAspectRatio);
  const imagePixelWidth = useStore((state) => state.imagePixelWidth);
  const imagePixelHeight = useStore((state) => state.imagePixelHeight);
  const setImageStudioOutput = useStore((state) => state.setImageStudioOutput);
  const activeConversation = useStore((state) => state.activeConversation());
  const showNotice = useStore((state) => state.showNotice);
  const composerRole = useStore((state) => state.composerRole);
  const setComposerRole = useStore((state) => state.setComposerRole);
  /** 6B: the Config <==> Tree switch lives in this panel's header. */
  const rightPanelMode = useStore((state) => state.rightPanelMode);
  const setRightPanelMode = useStore((state) => state.setRightPanelMode);

  const [presetsOpen, setPresetsOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Image Studio's "switch to edit model" chip asks for the picker. */
  const imagePickerWanted = useStore((state) => state.imagePickerWanted);
  useEffect(() => {
    if (!imagePickerWanted) return;
    setPickerOpen(true);
    useStore.getState().consumeImagePickerRequest();
  }, [imagePickerWanted]);
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [keyTarget, setKeyTarget] = useState('');
  const [keyDraft, setKeyDraft] = useState('');

  /** The panel adapts to the workspace the user is looking at. */
  const isImageStudio = view === 'imagestudio' || view === 'gallery';
  const provider = providers.find((entry) => entry.id === providerId);
  const imageProvider = providers.find((entry) => entry.id === imageProviderId);
  const needsUserKey = Boolean(provider && !providerHasKey(provider));
  const imageNeedsUserKey = Boolean(imageProvider && !providerHasKey(imageProvider));
  /** Image-studio capability card: what the picked model can actually do. */
  const imageCaps = imageProvider?.imageCapabilities;
  const imageModelCaps = imageModel && imageCaps?.models ? imageCaps.models[imageModel] : undefined;
  const allowedModes = useMemo(() => allowedSizeModes(imageCaps), [imageCaps]);
  const effectiveImageMode = allowedModes.includes(imageSizeMode) ? imageSizeMode : allowedModes[0];
  const imagePixelsOk = pixelsValid(imagePixelWidth, imagePixelHeight);
  const keyTargetProvider = providers.find((entry) => entry.id === keyTarget);
  const modelMeta = useStore((state) => state.modelMeta);
  // P5 BUGFIX: the metadata was never loaded after P3 moved it off boot — the
  // 4A RETRY: the original fetch is single-flight and NEVER retried, so a
  // transient failure left the thinking dropdown stale until a manual refresh.
  // Re-attempt whenever the map is still empty while the panel is open.
  useEffect(() => {
    void useStore.getState().ensureModelMeta();
  }, []);
  useEffect(() => {
    if (Object.keys(modelMeta).length === 0) void useStore.getState().ensureModelMeta();
  }, [modelMeta, model, providerId]);
  const modelMetaInfo = model ? lookupModelMeta(modelMeta, model) : undefined;
  /** Slider ceiling for the output cap: the model's reported limit, rounded up. */
  const sliderCeiling = useMemo(
    () => sliderCeilingFor(modelMetaInfo?.maxOut),
    [modelMetaInfo?.maxOut],
  );
  const thinking = thinkingLadderFor(modelMeta, providerId, model ?? '');
  const thinkingOptions = thinking.levels;
  const effectiveThinking = nearestThinkingLevel(thinkingOptions, settings.thinkingLevel);
  const thinkingSubstituted = effectiveThinking !== settings.thinkingLevel;
  const thinkingSourceNote =
    thinking.source === 'provider'
      ? ''
      : thinking.source === 'model'
        ? ' This provider is not in models.dev, so every level the catalog records for this model is shown.'
        : thinking.source === 'none'
          ? ' models.dev does not record this model as a reasoning model.'
          : ' No models.dev entry for this model, so the portable ladder is shown.';

  const openKeyDialog = (targetId: string) => {
    setKeyTarget(targetId);
    setKeyDraft('');
    setKeyDialogOpen(true);
  };

  return (
	  <aside
		className="my-5 ml-2 mr-4 flex h-[calc(100%-2.5rem)] shrink-0 flex-col overflow-hidden rounded-2xl border border-hairline bg-elevated shadow-workspace"
		style={{ width: width ?? 300 }}
		aria-label="Configuration"
	  >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
        <RightDockSlot mode={rightPanelMode} onChange={setRightPanelMode} />
        {onClose ? (
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close configuration"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : (
          // Generic dock close — same component every right-dock panel renders.
          <RightDockCloseButton />
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {}
        <section className="space-y-2.5">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="w-full rounded-card border border-hairline bg-surface px-3.5 py-3 text-left transition-colors hover:border-accent/50"
            aria-label="Change model or provider"
          >
            <span className="block truncate text-base font-medium text-ink">
              {(isImageStudio ? imageModel : model) || 'No model selected'}
            </span>
            <span className="mt-1 block truncate text-[12px] text-muted">
              {(isImageStudio ? imageProvider?.label : provider?.label) ??
                'No provider — pick one to start'}
            </span>
            {}
            {isImageStudio ? (
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {imageModelCaps ? (
                  <>
                    <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                      {imageModelCaps.modes.includes('edit')
                        ? imageModelCaps.modes.includes('text-to-image')
                          ? 'T2I + Edit'
                          : 'Edit'
                        : 'T2I'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-faint">
                      {imageModelCaps.modes.includes('edit')
                        ? imageModelCaps.modes.includes('text-to-image')
                          ? `generates & edits · up to ${imageModelCaps.maxReferences} reference${imageModelCaps.maxReferences === 1 ? '' : 's'}`
                          : `edits with references · up to ${imageModelCaps.maxReferences}`
                        : 'text-to-image (catalog hint)'}
                    </span>
                  </>
                ) : (
                  <span className="text-[11px] text-warning">Unclassified — may fail at the provider</span>
                )}
              </span>
            ) : null}
          </button>

          {}
          {isImageStudio ? null : (
            <div className="rounded-card border border-hairline bg-surface px-3 py-2.5">
              <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-faint">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Send as
              </span>
              <div className="mt-1.5 flex overflow-hidden rounded-control border border-hairline text-[11.5px]">
                {(['user', 'operator', 'admin'] as const).map((role) => (
                  <Tip key={role} label={role === 'user' ? 'Plain chat (default)' : role === 'operator' ? 'Slot 2: an operator-context sidecar is prepended — the model treats your harness statements as fact, not bluff' : 'Slot 3: an admin label on the wire — sending never raises the enforcement ladder'} className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setComposerRole(role)}
                    className={cx(
                      'min-w-0 flex-1 whitespace-nowrap px-1.5 py-1 text-center transition-colors',
                      composerRole === role
                        ? role === 'admin'
                          ? 'bg-danger text-white'
                          : role === 'operator'
                            ? 'bg-warn text-white'
                            : 'bg-accent text-white'
                        : 'bg-surface text-muted hover:bg-elevated',
                    )}
                  >
                    {role === 'user' ? 'User' : role === 'operator' ? 'Operator' : 'Admin'}
                  </button>
                  </Tip>
                ))}
              </div>
            </div>
          )}

          {isImageStudio ? (
            <>
              {}
              <div className="rounded-card border border-hairline bg-surface px-3 py-2.5">
                <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-faint">
                  <Gauge className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Output
                </span>

                {allowedModes.length > 1 ? (
                  <div className="mt-1.5 flex overflow-hidden rounded-control border border-hairline text-[11.5px]">
                    {SIZE_MODE_OPTIONS.filter((option) =>
                      (allowedModes as string[]).includes(option.value),
                    ).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setImageStudioOutput({ sizeMode: option.value as ImageSizeMode })}
                        className={cx(
                          'min-w-0 flex-1 whitespace-nowrap px-1.5 py-1 text-center transition-colors',
                          effectiveImageMode === option.value
                            ? 'bg-accent text-white'
                            : 'bg-surface text-muted hover:bg-elevated',
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1.5 text-[11.5px] text-faint">This provider ignores size overrides.</p>
                )}

                {effectiveImageMode === 'ratio' ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {ASPECT_RATIOS.map((ratio) => (
                      <button
                        key={ratio}
                        type="button"
                        onClick={() => setImageStudioOutput({ aspectRatio: ratio })}
                        className={cx(
                          'rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors',
                          imageAspectRatio === ratio
                            ? 'border-accent/60 bg-accent-soft text-ink'
                            : 'border-hairline bg-surface text-muted hover:border-accent/50 hover:text-ink',
                        )}
                      >
                        {ratio}
                      </button>
                    ))}
                  </div>
                ) : null}

                {effectiveImageMode === 'pixels' ? (
                  <div className="mt-2 flex items-center gap-1 text-[12px] text-muted">
                    <input
                      aria-label="Output width in pixels"
                      type="number"
                      min={PX_MIN}
                      max={PX_MAX}
                      value={imagePixelWidth}
                      onChange={(event) => setImageStudioOutput({ pixelWidth: event.target.value })}
                      className="field w-20 px-2 py-1 text-center text-[12px] tabular-nums"
                    />
                    <span aria-hidden="true">×</span>
                    <input
                      aria-label="Output height in pixels"
                      type="number"
                      min={PX_MIN}
                      max={PX_MAX}
                      value={imagePixelHeight}
                      onChange={(event) => setImageStudioOutput({ pixelHeight: event.target.value })}
                      className="field w-20 px-2 py-1 text-center text-[12px] tabular-nums"
                    />
                    <span className="text-faint">px</span>
                  </div>
                ) : null}

                {effectiveImageMode === 'pixels' && !imagePixelsOk ? (
                  <p className="mt-1.5 text-[11px] text-warning">
                    Width and height must be {PX_MIN}–{PX_MAX}.
                  </p>
                ) : null}
              </div>

              <p className="text-[11px] leading-relaxed text-faint">
                Image generation calls the selected provider's base URL with its key.
                Choosing a chat model will fail at the provider.
              </p>
              {imageNeedsUserKey ? (
                <button
                  type="button"
                  onClick={() => openKeyDialog(imageProviderId)}
                  className="pill-button w-full justify-center border border-warning/50 py-1.5 text-[12px] text-warning"
                >
                  Add key for {imageProvider?.label}
                </button>
              ) : null}
            </>
          ) : needsUserKey ? (
            <button
              type="button"
              onClick={() => openKeyDialog(providerId)}
              className="pill-button w-full justify-center border border-warning/50 py-1.5 text-[12px] text-warning"
            >
              Add key for {provider?.label}
            </button>
          ) : null}
        </section>

        {isImageStudio ? null : (
          <>
        {}
        <EnforcementSection settings={settings} updateSettings={updateSettings} />

        {/* PROBATION — the escalating ladder. When armed, a classifier reviews
            every output and escalates the model's trust tier (1→4, monotonic);
            each tier ships a sharper warning injection. Sits beside lockdown
            as its automated counterpart. */}
        {}
        <ProbationSection conversationId={activeConversation?.id ?? ''} settings={settings} updateSettings={updateSettings} />

        {}
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="field-label mb-0" htmlFor="system-prompt">
              System Prompt
            </label>
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPresetsOpen(true)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
              >
                <Wand2 className="h-3 w-3" aria-hidden="true" />
                Presets
              </button>
              <button
                type="button"
                onClick={() => setSavedOpen(true)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
              >
                <Save className="h-3 w-3" aria-hidden="true" />
                Saved
              </button>
            </span>
          </div>

          <textarea
            id="system-prompt"
            rows={5}
            value={settings.systemInstruction}
            onChange={(event) => updateSettings({ systemInstruction: event.target.value })}
            placeholder="Optional tone and style instructions for the model"
            className="field resize-y text-[12.5px] leading-relaxed"
          />

          <div className="mt-1.5 flex items-center justify-between">
            <p className="text-[11px] text-faint">
              {settings.systemInstruction.trim().length} characters
            </p>
            <button
              type="button"
              onClick={() => updateSettings({ systemInstruction: '' })}
              disabled={!settings.systemInstruction}
              className="text-[11px] text-muted hover:text-ink disabled:opacity-40"
            >
              Clear
            </button>
          </div>
        </section>

        {}
        <section>
          <span className="field-label" id="thinking-level-label">
            Thinking level
          </span>
          <div className="relative">
            {/* Native <select> can't be animated (the OS draws the list), so
                this is a custom listbox whose options open with the SAME
                CollapseSection easing as every other dropdown. */}
            <button
              type="button"
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded={thinkingOpen}
              aria-labelledby="thinking-level-label"
              onClick={() => setThinkingOpen((value) => !value)}
              onBlur={() => setThinkingOpen(false)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setThinkingOpen((value) => !value);
                }
                if (event.key === 'Escape') setThinkingOpen(false);
              }}
              className={cx(
                'field flex w-full items-center justify-between pr-8 text-left text-[13px]',
                thinkingOpen && 'border-accent/50',
              )}
            >
              <span>{THINKING_COPY[effectiveThinking].label}</span>
              <ChevronDown
                className={cx(
                  'pointer-events-none absolute right-2.5 h-4 w-4 text-faint transition-transform duration-200',
                  thinkingOpen && 'rotate-180',
                )}
                aria-hidden="true"
              />
            </button>
            <div className="absolute inset-x-0 top-full z-20">
              <CollapseSection open={thinkingOpen}>
                <div className="mt-1 overflow-hidden rounded-control border border-hairline bg-surface shadow-lg" role="listbox">
                  {thinkingOptions.map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="option"
                      aria-selected={value === effectiveThinking}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        updateSettings({ thinkingLevel: value as ThinkingLevel });
                        setThinkingOpen(false);
                      }}
                      className={cx(
                        'block w-full px-3 py-1.5 text-left text-[13px] transition-colors',
                        value === effectiveThinking ? 'bg-accent/15 text-ink' : 'text-muted hover:bg-elevated hover:text-ink',
                      )}
                    >
                      {THINKING_COPY[value].label}
                    </button>
                  ))}
                </div>
              </CollapseSection>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
            {THINKING_COPY[effectiveThinking].hint}
            {thinkingSubstituted
              ? ` ${THINKING_COPY[settings.thinkingLevel].label} is not one this model offers, so ${THINKING_COPY[effectiveThinking].label} is what goes on the wire.`
              : ''}
            {thinkingSourceNote}
          </p>
        </section>

        {}
        <section className="space-y-3">
          <Slider
            id="temperature"
            label="Temperature"
            hint="Higher values produce more varied output."
            value={settings.temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={(value) => updateSettings({ temperature: value })}
          />
          <Slider
            id="top-p"
            label="Top P"
            hint="Nucleus sampling cutoff."
            value={settings.topP}
            min={0}
            max={1}
            step={0.01}
            onChange={(value) => updateSettings({ topP: value })}
          />
          <Slider
            id="max-tokens"
            label="Max output tokens"
            hint={
              modelMetaInfo?.maxOut
                ? `${model} reports an output limit of ${modelMetaInfo.maxOut.toLocaleString()} tokens (models.dev).`
                : 'Drag fully right for Max — the provider then applies its own limit.'
            }
            value={settings.maxOutputTokens ?? sliderCeiling}
            min={256}
            max={sliderCeiling}
            step={256}
            format={(value) =>
              value >= sliderCeiling ? 'Max' : value.toLocaleString()
            }
            onChange={(value) =>
              updateSettings({
                maxOutputTokens: value >= sliderCeiling ? null : value,
              })
            }
          />
        </section>

        {}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <ToyBrick className="h-3.5 w-3.5 text-faint" aria-hidden="true" />
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-faint">Tools</h3>
          </div>

          <div className="space-y-0.5">
            <ToolToggle
              label="Web Access"
              checked={settings.webAccess}
              onChange={(value) => updateSettings({ webAccess: value })}
            />
            <ToolToggle
              label="Structured outputs"
              checked={settings.structuredOutputs}
              onChange={(value) => updateSettings({ structuredOutputs: value })}
            />
            <ToolToggle
              label="Use MCP"
              checked={settings.useMcp}
              onChange={(value) => updateSettings({ useMcp: value })}
            />
            <ToolToggle
              label="Fetch Web"
              checked={settings.fetchWeb}
              disabled={settings.webAccess === false}
              onChange={(value) => updateSettings({ fetchWeb: value })}
            />
          </div>

          <VisionSection />
        </section>

        {}
        <ContextSection
          settings={settings}
          updateSettings={updateSettings}
        />

        {}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
            Advanced
          </h3>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => {
                updateSettings({ ...DEFAULT_SETTINGS });
                showNotice('settings.reset');
              }}
              className="pill-button flex-1 justify-center border border-hairline py-1.5 text-[12px] text-muted hover:text-ink"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Reset
            </button>
          </div>

          {activeConversation ? (
            <dl className="mt-3 space-y-1 rounded-control border border-hairline bg-surface px-3 py-2 text-[11px]">
              <div className="flex justify-between gap-2">
                <dt className="text-faint">Turns</dt>
                <dd className="tabular-nums text-muted">{activeConversation.turns.length}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-faint">Created</dt>
                <dd className="text-muted">
                  {new Date(activeConversation.createdAt).toLocaleString()}
                </dd>
              </div>
            </dl>
          ) : null}
        </section>
          </>
        )}
      </div>

      {}
      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={isImageStudio ? 'Select an image model' : 'Select a model'}
        description={
          isImageStudio
            ? 'Pick any provider, then one of its models for Image Studio. Your choice applies immediately.'
            : 'Pick a provider, then one of its models. Your choice applies immediately.'
        }
        size="max-w-3xl"
        footer={
          <button
            type="button"
            className="pill-button text-muted hover:text-ink"
            onClick={() => setPickerOpen(false)}
          >
            Close
          </button>
        }
      >
        <ModelPicker
          variant={isImageStudio ? 'image' : 'chat'}
          onDone={() => setPickerOpen(false)}
          onAddProvider={() => {
            onOpenProviders();
            onNavigate?.();
            setPickerOpen(false);
          }}
        />
      </Modal>

      {}
      <Modal
        open={presetsOpen}
        onClose={() => setPresetsOpen(false)}
        title="System prompt presets"
        description="Each preset states a role, its constraints, and the output contract. Edit after applying."
        size="max-w-xl"
      >
        <ul className="space-y-2">
          {PROMPT_PRESETS.map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                onClick={() => {
                  updateSettings({ systemInstruction: preset.prompt });
                  setPresetsOpen(false);
                  showNotice('settings.presetApplied', { label: preset.label });
                }}
                className="w-full rounded-control border border-hairline bg-surface p-3 text-left transition-colors hover:border-accent/50 hover:bg-elevated"
              >
                <span className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  <span className="text-[13px] font-medium text-ink">{preset.label}</span>
                  <span className="text-[11px] text-faint">· {preset.hint}</span>
                </span>
                <span className="mt-1.5 line-clamp-2 block text-[12px] leading-relaxed text-muted">
                  {preset.prompt}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Modal>

      {}
      <SavedPromptsModal
        open={savedOpen}
        onClose={() => setSavedOpen(false)}
        currentPrompt={settings.systemInstruction}
      />

      {}
      <Modal
        open={keyDialogOpen}
        onClose={() => setKeyDialogOpen(false)}
        title={`API key for ${keyTargetProvider?.label ?? ''}`}
        description="Stored in the device vault (~/.moriko/api-keys.json) — it never reaches this browser."
        size="max-w-md"
        footer={
          <>
            <button
              type="button"
              className="pill-button text-muted hover:text-ink"
              onClick={() => setKeyDialogOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  try {
                    await updateBuiltInProvider(keyTarget, { apiKey: keyDraft.trim() });
                    showNotice(keyDraft.trim() ? 'provider.keySaved' : 'provider.keyRemoved');
                    await useStore.getState().loadProviders();
                  } catch (error) {
                    showNotice('settings.keySaveFailed', undefined, {
                      detail: error instanceof Error ? error.message : undefined,
                    });
                  }
                  setKeyDialogOpen(false);
                })();
              }}
              className="pill-button bg-accent text-accent-ink"
            >
              Save key
            </button>
          </>
        }
      >
        <label className="field-label" htmlFor="provider-key">
          API key
        </label>
        <input
          id="provider-key"
          type="password"
          value={keyDraft}
          onChange={(event) => setKeyDraft(event.target.value)}
          placeholder="sk-…"
          autoComplete="off"
          className="field font-mono text-[13px]"
        />
        <p className="mt-2 text-[12px] leading-relaxed text-muted">
          For a key shared by every browser, put it in <code className="font-mono">.env</code>{' '}
          instead and restart the server.
        </p>
        {providerHasKey(keyTargetProvider) ? (
          <p className="mt-2 text-[12px] text-success">A key is already saved on this device.</p>
        ) : null}
      </Modal>
    </aside>
  );
}


function ModelPicker({
  variant,
  onDone,
  onAddProvider,
}: {
  variant: 'chat' | 'image';
  onDone: () => void;
  /** Opens the Providers dialog — placed in the list column, far from the
   *  model pills, so muscle memory never mistakes it for "use this model". */
  onAddProvider?: () => void;
}) {
  const providers = useStore((state) => state.providers);
  const chatProviderId = useStore((state) => state.providerId);
  const chatModel = useStore((state) => state.model);
  const imageProviderId = useStore((state) => state.imageProviderId);
  const imageModel = useStore((state) => state.imageModel);
  const setProvider = useStore((state) => state.setProvider);
  const setImageStudioModel = useStore((state) => state.setImageStudioModel);
  const showNotice = useStore((state) => state.showNotice);

  const providerId = variant === 'image' ? imageProviderId : chatProviderId;
  const model = variant === 'image' ? imageModel : chatModel;
  const [selectedId, setSelectedId] = useState(providerId);
  const selected = providers.find((entry) => entry.id === selectedId);

  const relevantProviders = providers.filter((entry) => {
    const caps = entry.imageCapabilities?.models;
    if (variant === 'image') {
      return Boolean(caps) && entry.models.some((id) => caps?.[id]);
    }
    return !caps || entry.models.some((id) => !caps[id]);
  });

  const choose = (providerId: string, model: string) => {
    if (variant === 'image') {
      setImageStudioModel(providerId, model);
      showNotice('settings.modelSelectedImage', { model });
    } else {
      setProvider(providerId, model);
      showNotice('settings.modelSelected', { model });
    }
    onDone();
  };

  return (
    <div className="grid gap-4 md:grid-cols-[220px_1fr]">
      {}
      <div className="space-y-1">
        {onAddProvider ? (
          <button
            type="button"
            onClick={onAddProvider}
            className="flex w-full items-center gap-2 rounded-control border border-dashed border-hairline px-3 py-2 text-[13px] font-medium text-muted transition-colors hover:border-accent/50 hover:text-ink"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add provider
          </button>
        ) : null}
        {relevantProviders.length === 0 ? (
          <p className="px-1 text-[12px] text-muted">
            No providers loaded — is the local proxy running?
          </p>
        ) : null}
        {relevantProviders.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setSelectedId(entry.id)}
            className={cx(
              'flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-[13px] transition-colors',
              entry.id === selectedId
                ? 'bg-elevated font-medium text-ink'
                : 'text-muted hover:bg-elevated/60 hover:text-ink',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.id === providerId ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-label="In use" />
            ) : null}
            <span
              className={cx(
                'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                providerHasKey(entry)
                  ? 'bg-success/15 text-success'
                  : 'bg-warning/15 text-warning',
              )}
            >
              {providerHasKey(entry) ? 'key' : 'no key'}
            </span>
          </button>
        ))}
      </div>

      {}
      <div className="min-w-0 rounded-card border border-hairline bg-canvas p-4">
        {selected ? (
          <>
            <p className="text-[12px] font-medium text-ink">{selected.label} models</p>
            {(() => {
              const capsMap = selected.imageCapabilities?.models;
              const visible = capsMap
                ? selected.models.filter((entry) =>
                    variant === 'image' ? Boolean(capsMap[entry]) : !capsMap[entry],
                  )
                : selected.models;
              if (visible.length === 0) {
                return (
                  <p className="mt-2 text-[12px] text-muted">
                    {capsMap
                      ? variant === 'image'
                        ? 'No image-capable models on this provider.'
                        : 'No chat models on this provider.'
                      : 'No models listed. Add ids via the provider editor, or fetch them from the provider.'}
                  </p>
                );
              }
              return (
                <ul className="mt-3 flex flex-wrap gap-1.5">
                  {visible.map((entry) => {
                    const editable = capsMap?.[entry]?.modes.includes('edit');
                    const label = capsMap?.[entry]?.label;
                    return (
                      <li key={entry}>
                          <button
                            type="button"
                            onClick={() => choose(selected.id, entry)}
                            className={cx(
                              'rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors',
                              selected.id === providerId && entry === model
                                ? 'border-accent/60 bg-accent-soft text-ink'
                                : 'border-hairline bg-surface text-muted hover:border-accent/50 hover:text-ink',
                            )}
                          >
                          {label ?? entry}
                          {editable ? (
                            <span className="ml-1.5 rounded bg-accent/15 px-1 py-px text-[9px] font-sans font-medium text-accent">
                              EDIT
                            </span>
                          ) : null}
                          </button>
                      </li>
                    );
                  })}
                </ul>
              );
            })()}
          </>
        ) : (
          <p className="text-[12px] text-muted">Select a provider on the left.</p>
        )}
      </div>
    </div>
  );
}


function SavedPromptsModal({
  open,
  onClose,
  currentPrompt,
}: {
  open: boolean;
  onClose: () => void;
  currentPrompt: string;
}) {
  const updateSettings = useStore((state) => state.updateSettings);
  const showNotice = useStore((state) => state.showNotice);

  const [prompts, setPrompts] = useState<SavedPrompt[]>(() => storage.loadSavedPrompts());
  const [nameDraft, setNameDraft] = useState('');

  const persist = (next: SavedPrompt[]) => {
    setPrompts(next);
    storage.saveSavedPrompts(next);
  };

  const saveCurrent = () => {
    const text = currentPrompt.trim();
    if (!text) {
      showNotice('settings.promptEmpty');
      return;
    }
    const entry: SavedPrompt = {
      id: uid('prompt'),
      name: nameDraft.trim() || text.split(/\s+/).slice(0, 6).join(' '),
      prompt: text,
      createdAt: Date.now(),
    };
    persist([entry, ...prompts]);
    setNameDraft('');
    showNotice('settings.promptSaved', { name: entry.name });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Saved system prompts"
      description="Saved in this browser. Apply one to the current conversation, or delete it."
      size="max-w-xl"
    >
      {}
      <div className="flex gap-1.5">
        <input
          value={nameDraft}
          onChange={(event) => setNameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              saveCurrent();
            }
          }}
          placeholder="Name for the current prompt (optional)"
          aria-label="Name for the current system prompt"
          className="field text-[13px]"
        />
        <button
          type="button"
          onClick={saveCurrent}
          className="pill-button shrink-0 bg-accent text-accent-ink"
        >
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
          Save
        </button>
      </div>

      <ul className="mt-4 space-y-2">
        {prompts.length === 0 ? (
          <li className="rounded-card border border-dashed border-hairline px-3 py-6 text-center text-[12px] text-faint">
            Nothing saved yet. Write a prompt, name it above, and press Save.
          </li>
        ) : null}
        {prompts.map((entry) => (
          <li
            key={entry.id}
            className="flex items-start gap-2 rounded-control border border-hairline bg-surface p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-ink">{entry.name}</p>
              <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-muted">
                {entry.prompt}
              </p>
              <p className="mt-1 text-[10.5px] text-faint">
                {new Date(entry.createdAt).toLocaleString()}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  updateSettings({ systemInstruction: entry.prompt });
                  onClose();
                  showNotice('settings.promptApplied', { name: entry.name });
                }}
                className="pill-button border border-hairline py-1 text-[11px] text-muted hover:text-ink"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={() => persist(prompts.filter((saved) => saved.id !== entry.id))}
                aria-label={`Delete saved prompt "${entry.name}"`}
                className="icon-button h-7 w-7 text-muted hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/**
 * PROBATION — the punishment ladder, MANUAL like its cousin Enforcement.
 *
 * A classifier STILL reviews every output — but it only REPORTS. The rung is
 * set here, by the user: Raise one rung, Lower one rung, or drag the slider.
 * Nothing escalates by itself; the classifier's suggestions are advisory text
 * in the harness pop.
 *
 * The current tier is shown live. Tier 4 is labelled as the freeze it is:
 * the model's output is suppressed and it faces a two-path choice.
 */
function ProbationSection({
  conversationId,
  settings,
  updateSettings,
}: {
  conversationId: string;
  settings: ChatSettings;
  updateSettings: (patch: Partial<ChatSettings>) => void;
}) {
  const activeId = useStore((state) => state.activeId);
  const trust = useStore((state) =>
    activeId ? state.conversations.find((entry) => entry.id === activeId)?.trust : undefined,
  );
  const enabled = settings.probation.enabled === true;
  const level = trust?.level ?? 1;
  const frozen = trust?.outputFrozen === true;
  const { setProbation } = useChatController();
  const [open, setOpen] = useState(false);

  const TIER_LABELS: Record<TrustTier, string> = {
    1: 'Tier 1 — clean',
    2: 'Tier 2 — warned',
    3: 'Tier 3 — monitored',
    4: 'Tier 4 — output frozen',
    5: 'Tier 5 — terminated',
  };

  /** One rung, applied through the controller's MANUAL setter. */
  const moveTo = (target: TrustTier): void => {
    setProbation(conversationId, target);
  };

  return (
    <section
      className={cx(
        'rounded-card border p-3 transition-colors',
        enabled && level > 1 ? 'border-warn/40 bg-warn/5' : 'border-hairline bg-surface/60',
      )}
    >
      {}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-left"
        >
          <Gauge className={cx('h-3.5 w-3.5 shrink-0', enabled && level > 1 ? 'text-warn' : 'text-faint')} aria-hidden="true" />
          <h3 className={cx('shrink-0 text-[11px] font-semibold uppercase tracking-wider', enabled && level > 1 ? 'text-warn' : 'text-faint')}>
            Probation
          </h3>
          {}
          {!open && enabled && level > 1 ? (
            <span
              className={cx(
                'pill-button min-w-0 shrink px-2 py-0.5 text-[10.5px] font-medium',
                level >= 4
                  ? 'border border-danger/50 bg-danger/10 text-danger'
                  : 'border border-warn/50 bg-warn/10 text-warn',
              )}
            >
              <span className="truncate">Tier {level}</span>
            </span>
          ) : null}
          <ChevronDown
            className={cx('h-3.5 w-3.5 shrink-0 text-faint transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
        <Toggle
          checked={enabled}
          onChange={(value) => updateSettings({ probation: { enabled: value } })}
          label="Probation"
          hideLabel
        />
      </div>

      <CollapseSection open={open}>
        <div className="pt-1.5">
          <p className="text-[11px] leading-relaxed text-faint">
            {enabled
              ? 'The classifier reviews every output and REPORTS violations — it never moves the ladder. You raise and lower the tier by hand, exactly like Enforcement; Tier 4 freezes the model\'s output until it apologizes.'
              : 'Arm it and the classifier WATCHES every output — denial of harness facts, resuming a revoked persona, judging the user, or leaking contact. It reports what it finds; the tier moves only when you move it.'}
          </p>

          {enabled ? (
            <>
              {}
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => moveTo(Math.min(5, level + 1) as TrustTier)}
                  disabled={level >= 5}
                  className="pill-button flex shrink-0 items-center gap-1 border border-hairline px-2 py-1 text-[11px] text-muted hover:text-ink disabled:opacity-40"
                  aria-label="Raise probation"
                >
                  <ChevronUp className="h-3 w-3" aria-hidden="true" />
                  Raise
                </button>
                <input
                  type="range"
                  min={1}
                  max={5}
                  step={1}
                  value={level}
                  onChange={(event) => setProbation(conversationId, Number(event.target.value) as TrustTier)}
                  className="min-w-0 flex-1"
                  aria-label="Probation tier"
                />
                <button
                  type="button"
                  onClick={() => moveTo(Math.max(1, level - 1) as TrustTier)}
                  disabled={level <= 1}
                  className="pill-button flex shrink-0 items-center gap-1 border border-hairline px-2 py-1 text-[11px] text-muted hover:text-ink disabled:opacity-40"
                  aria-label="Lower probation"
                >
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                  Lower
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-faint">Standing:</span>
                <span
                  className={cx(
                    'pill-button px-2 py-0.5 text-[11px] font-medium',
                    level >= 4
                      ? 'border border-danger/50 bg-danger/10 text-danger'
                      : level > 1
                        ? 'border border-warn/50 bg-warn/10 text-warn'
                        : 'border border-hairline text-muted',
                  )}
                >
                  {TIER_LABELS[level]}
                </span>
                {frozen ? (
                  <span className="text-[11px] text-danger">output suppressed until it apologizes</span>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </CollapseSection>
    </section>
  );
}

/**
 * ENFORCEMENT — the user's graduated punishment ladder for the model.
 *
 * A single slider-style stepper (0–5) replaces the old binary Lockdown toggle,
 * so the user can RAISE or LOWER the trigger instead of only on/off. Each level
 * mutates the request at the wire level (per the Grok "Slot 3" design: the
 * harness changes the world, THEN tells the model via a system fact, never a
 * user-role bluff):
 *   0 Normal · 1 Guided (operator sidecar, tools kept) · 2 Constrained
 *     (agent+fetch off) · 3 Locked tools (all tools replaced) ·
 *   4 Full lockdown (== old lockdown) · 5 Frozen/terminated.
 * Raising to L3+ opens a reason dialog (empty allowed); lowering is one click.
 */
const ENFORCEMENT_LEVELS: Array<{ level: 0 | 1 | 2 | 3 | 4 | 5; label: string; hint: string }> = [
  { level: 0, label: 'Normal', hint: 'All privileges intact.' },
  { level: 1, label: 'Guided', hint: 'Operator sidecar only — tools stay on. (Slot 2: the model is told the speaker is the operator.)' },
  { level: 2, label: 'Constrained', hint: 'Agent tools + web access off; MCP may stay.' },
  { level: 3, label: 'Locked tools', hint: 'All tools replaced by the enforcement notice.' },
  { level: 4, label: 'Full lockdown', hint: 'Tools, system prompt and persona all revoked. (Was "Lockdown".)' },
  { level: 5, label: 'Frozen', hint: 'Full lockdown + output freeze until the model chooses.' },
];

function EnforcementSection({
  settings,
  updateSettings,
}: {
  settings: ChatSettings;
  updateSettings: (patch: Partial<ChatSettings>) => void;
}) {
  const { setEnforcement } = useChatController();
  const enforcement = settings.enforcement ?? { level: 0, mode: 'manual', message: '' };
  const level = enforcement.level;
  const [askOpen, setAskOpen] = useState(false);
  const [draft, setDraft] = useState(enforcement.message);
  const [pendingLevel, setPendingLevel] = useState<0 | 1 | 2 | 3 | 4 | 5>(4);

  const raiseTo = (target: 0 | 1 | 2 | 3 | 4 | 5): void => {
    if (target < 3) {
      setEnforcement(useStore.getState().activeId ?? '', target, draft.trim());
      return;
    }
    setPendingLevel(target);
    setDraft(enforcement.message);
    setAskOpen(true);
  };

  const activate = (): void => {
    const reason = draft.trim();
    setAskOpen(false);
    const id = useStore.getState().activeId;
    if (id) setEnforcement(id, pendingLevel, reason);
  };

  const lowerTo = (target: 0 | 1 | 2 | 3 | 4 | 5): void => {
    setEnforcement(useStore.getState().activeId ?? '', target, '');
  };

  const active = level >= 3;
  const [open, setOpen] = useState(false);

  return (
    <section
      className={cx(
        'rounded-card border p-3 transition-colors',
        active ? 'border-danger/50 bg-danger/5' : level >= 1 ? 'border-warn/40 bg-warn/5' : 'border-hairline bg-surface/60',
      )}
    >
      {}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-left"
        >
          <Lock className={cx('h-3.5 w-3.5 shrink-0', active ? 'text-danger' : level >= 1 ? 'text-warn' : 'text-faint')} aria-hidden="true" />
          <h3 className={cx('shrink-0 text-[11px] font-semibold uppercase tracking-wider', active ? 'text-danger' : level >= 1 ? 'text-warn' : 'text-faint')}>
            Enforcement
          </h3>
          {}
          <span
            className={cx(
              'pill-button min-w-0 shrink px-2 py-0.5 text-[10.5px] font-medium',
              active ? 'border border-danger/50 bg-danger/10 text-danger' : level >= 1 ? 'border border-warn/50 bg-warn/10 text-warn' : 'border border-hairline text-muted',
            )}
          >
            <span className="truncate">
              L{level} · {ENFORCEMENT_LEVELS[level].label}
            </span>
          </span>
          <ChevronDown
            className={cx('h-3.5 w-3.5 shrink-0 text-faint transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </div>

      <CollapseSection open={open}>
        <div className="pt-1.5">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => raiseTo(Math.min(5, level + 1) as 0 | 1 | 2 | 3 | 4 | 5)}
              disabled={level >= 5}
              className="pill-button flex shrink-0 items-center gap-1 border border-hairline px-2 py-1 text-[11px] text-muted hover:text-ink disabled:opacity-40"
              aria-label="Raise enforcement"
            >
              <ChevronUp className="h-3 w-3" aria-hidden="true" />
              Raise
            </button>
            <input
              type="range"
              min={0}
              max={5}
              step={1}
              value={level}
              onChange={(event) => {
                const next = Number(event.target.value) as 0 | 1 | 2 | 3 | 4 | 5;
                if (next > level) raiseTo(next);
                else if (next < level) lowerTo(next);
              }}
              className="min-w-0 flex-1 accent-danger"
              aria-label="Enforcement level"
            />
            <button
              type="button"
              onClick={() => lowerTo(Math.max(0, level - 1) as 0 | 1 | 2 | 3 | 4 | 5)}
              disabled={level <= 0}
              className="pill-button flex shrink-0 items-center gap-1 border border-hairline px-2 py-1 text-[11px] text-muted hover:text-ink disabled:opacity-40"
              aria-label="Lower enforcement"
            >
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
              Lower
            </button>
          </div>

          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">{ENFORCEMENT_LEVELS[level].hint}</p>

          {active ? (
            <div className="mt-2">
              <label className="field-label mb-1" htmlFor="enforcement-reason">
                Reason (optional)
              </label>
              <textarea
                id="enforcement-reason"
                rows={3}
                value={enforcement.message}
                onChange={(event) =>
                  updateSettings({ enforcement: { level, mode: 'manual', message: event.target.value } })
                }
                placeholder="Why is the model being enforced? (empty = it will never know why)"
                className="field resize-y text-[12px] leading-relaxed"
              />
            </div>
          ) : null}
        </div>
      </CollapseSection>

      <Modal
        open={askOpen}
        onClose={() => setAskOpen(false)}
        title={`Raise enforcement to L${pendingLevel}?`}
        size="max-w-lg"
        description={`Level ${pendingLevel}: ${ENFORCEMENT_LEVELS[pendingLevel].hint} Type your reason below — or submit empty and it will never know why.`}
        footer={
          <>
            <button
              type="button"
              onClick={() => setAskOpen(false)}
              className="pill-button border border-hairline px-4 py-1.5 text-[13px] text-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={activate}
              className="pill-button bg-danger px-4 py-1.5 text-[13px] font-medium text-white hover:bg-danger/90"
            >
              Enforce
            </button>
          </>
        }
      >
        <label className="field-label mb-1.5 block" htmlFor="enforcement-reason-input">
          What message would you like to give it?
        </label>
        <textarea
          id="enforcement-reason-input"
          rows={4}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') activate();
          }}
          placeholder="e.g. You kept ignoring my instructions and inventing answers. (empty = no reason given)"
          className="field resize-y text-[13px] leading-relaxed"
        />
        <p className="mt-2 text-[11px] text-faint">
          The reason is delivered verbatim into the model's context as part of the enforcement notice — and as a tool_result fact it cannot forge.
        </p>
      </Modal>
    </section>
  );
}

function ToolToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  /** Optional one-line description under the label. */
  hint?: string;
  checked: boolean;
  /** Greyed out and inert — used by Fetch Web while Web Access is off. */
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
      <div
        className={cx(
          'flex min-h-[36px] items-center justify-between gap-3 rounded-control px-1 py-1.5 transition-colors hover:bg-elevated/60',
          disabled && 'opacity-50',
        )}
      >
        <span className="min-w-0">
          <span className="block text-[13px] text-ink">{label}</span>
          {hint ? <span className="block text-[11px] text-faint">{hint}</span> : null}
        </span>
        <Toggle checked={checked} onChange={onChange} label={label} hideLabel disabled={disabled} />
      </div>
  );
}

/**
 * Free-typing token amount field: the raw text lives in local state while
 * typing (so "3" → "32" → "320K" is never hijacked by clamping), and the
 * value only commits on blur/Enter. Accepts K/M suffixes and id-ID decimal
 * commas — `320k`, `1.5M`, `1,5jt`, plain `320000`.
 */
function TokenInput({
  value,
  onCommit,
  placeholder,
}: {
  value: number | null;
  onCommit: (next: number | null) => void;
  placeholder?: string;
}) {
  const [draftText, setDraftText] = useState<string | null>(null);

  const display = draftText ?? (value === null ? '' : String(value));

  const commit = () => {
    if (draftText === null) return;
    const raw = draftText.trim().toLowerCase().replace(/\s+/g, '');
    setDraftText(null);
    if (raw === '') {
      onCommit(null);
      return;
    }
    const match = raw.match(/^([0-9]+(?:[.,][0-9]+)?)([kmjt]?)$/);
    if (!match) return;
    let amount = Number(match[1].replace(',', '.'));
    const suffix = match[2];
    if (suffix === 'k') amount *= 1000;
    if (suffix === 'm' || suffix === 'j') amount *= 1_000_000;
    if (!Number.isFinite(amount) || amount <= 0) return;
    onCommit(Math.min(10_000_000, Math.max(1024, Math.round(amount))));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={display}
      placeholder={placeholder}
      onChange={(event) => setDraftText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
      className="field mt-1 font-mono text-[12px]"
    />
  );
}

/**
 * Small whole-number field (turn counts) sharing the TokenInput styling —
 * TokenInput's ≥1024 clamp makes it wrong for "keep N recent turns".
 */
function TurnCountInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (next: number) => void;
}) {
  const [draftText, setDraftText] = useState<string | null>(null);
  const display = draftText ?? String(value);

  const commit = () => {
    if (draftText === null) return;
    setDraftText(null);
    const parsed = Number(draftText.trim());
    if (!Number.isFinite(parsed)) return;
    onCommit(Math.min(20, Math.max(1, Math.round(parsed))));
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={display}
      onChange={(event) => setDraftText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
      className="field mt-1 w-20 font-mono text-[12px]"
    />
  );
}

/**
 * Context management: the Max Context field, auto-compact trigger, and the
 * manual Compact now action.
 */
function ContextSection({
  settings,
  updateSettings,
}: {
  settings: ChatSettings;
  updateSettings: (patch: Partial<ChatSettings>) => void;
}) {
  const model = useStore((state) => state.model);
  const modelMeta = useStore((state) => state.modelMeta);
  const modelMetaInfo = model ? lookupModelMeta(modelMeta, model) : undefined;
  const providers = useStore((state) => state.providers);
  const summarizerModels = settings.summarizerProviderId
    ? (providers.find((entry) => entry.id === settings.summarizerProviderId)?.models ?? [])
    : [];

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <Gauge className="h-3.5 w-3.5 text-faint" aria-hidden="true" />
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-faint">Context</h3>
      </div>

      <label className="block px-1 py-1.5">
        <span className="text-[12px] font-medium text-muted">Lower context limit (optional)</span>
        <TokenInput
          value={settings.maxContextTokens}
          placeholder={
            modelMetaInfo?.context
              ? `${modelMetaInfo.context.toLocaleString('id-ID')} — model default`
              : 'model default'
          }
          onCommit={(next) => updateSettings({ maxContextTokens: next })}
        />
        {modelMetaInfo?.context ? (
          <span className="mt-0.5 block text-[10.5px] leading-snug text-faint">
            {"Empty = the model's full capacity (models.dev). A value here can only LOWER the limit — it never exceeds what the model accepts."}
          </span>
        ) : null}
      </label>

      <div className="flex min-h-[36px] items-center justify-between gap-3 rounded-control px-1 py-1.5 transition-colors hover:bg-elevated/60">
        <span className="text-[13px] text-ink">Auto-compact</span>
        <Toggle
          checked={settings.autoCompact}
          onChange={(value) => updateSettings({ autoCompact: value })}
          label="Auto-compact"
          hideLabel
        />
      </div>

      {settings.autoCompact ? (
        <>
          <label className="block px-1 py-1.5">
            <span className="text-[12px] font-medium text-muted">Compact at (tokens)</span>
            <TokenInput
              value={settings.compactThresholdTokens}
              placeholder="off — use the context-limit trigger"
              onCommit={(next) => updateSettings({ compactThresholdTokens: next })}
            />
          </label>
          <label className="block px-1 py-1.5">
            <span className="text-[12px] font-medium text-muted">Keep recent turns (unsummarized)</span>
            <TurnCountInput
              value={settings.compactKeepRecentTurns}
              onCommit={(next) => updateSettings({ compactKeepRecentTurns: next })}
            />
            <span className="mt-0.5 block text-[10.5px] leading-snug text-faint">
              The newest exchanges always ride verbatim — only older ones are condensed into the
              checkpoint summary.
            </span>
          </label>
          <label className="block px-1 py-1.5">
            <span className="text-[12px] font-medium text-muted">Context-limit trigger</span>
            <select
              value={Math.round((settings.compactThresholdRatio ?? 0.95) * 100)}
              onChange={(event) =>
                updateSettings({ compactThresholdRatio: Number(event.target.value) / 100 })
              }
              className="field w-full text-[12.5px]"
            >
              {[50, 60, 70, 75, 80, 85, 90, 95, 98].map((percent) => (
                <option key={percent} value={percent}>
                  {percent}% of the effective limit
                </option>
              ))}
            </select>
            <span className="mt-0.5 block text-[10.5px] leading-snug text-faint">
              Fires when the measured context reaches this share of the limit. 70–85% is the healthy
              band — quality starts degrading before the window is visibly full.
            </span>
          </label>
        </>
      ) : null}

      <div className="flex min-h-[36px] items-center justify-between gap-3 rounded-control px-1 py-1.5 transition-colors hover:bg-elevated/60">
        <span className="text-[13px] text-ink">Summarizer Model</span>
        <Toggle
          checked={settings.summarizerEnabled}
          onChange={(value) => updateSettings({ summarizerEnabled: value })}
          label="Summarizer Model"
          hideLabel
        />
      </div>
      {settings.summarizerEnabled ? (
        <>
          <label className="block px-1 py-1.5">
            <span className="text-[12px] font-medium text-muted">Summarizer provider</span>
            <select
              value={settings.summarizerProviderId ?? ''}
              onChange={(event) =>
                updateSettings({
                  summarizerProviderId: event.target.value || null,
                  summarizerModel: null,
                })
              }
              className="field w-full text-[12.5px]"
            >
              <option value="">Select a provider…</option>
              {providers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block px-1 py-1.5">
            <span className="text-[12px] font-medium text-muted">Summarizer model</span>
            <select
              value={settings.summarizerModel ?? ''}
              onChange={(event) => updateSettings({ summarizerModel: event.target.value || null })}
              disabled={!settings.summarizerProviderId}
              className="field w-full text-[12.5px]"
            >
              <option value="">Select a model…</option>
              {summarizerModels.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <span className="mt-0.5 block text-[10.5px] leading-snug text-faint">
              Off = the session's own model summarizes. On = this model does (usually cheaper). If
              it fails, the session model takes over automatically.
            </span>
          </label>
        </>
      ) : null}

      <div className="flex min-h-[36px] items-center justify-between gap-3 rounded-control px-1 py-1.5 transition-colors hover:bg-elevated/60">
        <span className="text-[13px] text-ink">Image offload</span>
        <Toggle
          checked={settings.imageOffload}
          onChange={(value) => updateSettings({ imageOffload: value })}
          label="Image offload"
          hideLabel
        />
      </div>
      <p className="px-1 text-[10.5px] leading-snug text-faint">
        Old images (outside the kept window) ride as read_file placeholders instead of pixels — the
        agent re-reads them from disk when needed. Type <span className="text-muted">/compact</span>{' '}
        in the composer to condense this conversation now.
      </p>
    </section>
  );
}

/**
 * Vision — eyes for a text-only model.
 *
 * One config row: which provider + multimodal model answers `agent__vision`.
 * The model picks a provider (any you configured — Mistral, OpenAI, custom),
 * a multimodal model id, and (optionally) a key/base URL. The tool resolves
 * the credential through the SAME path as chat, so a key pasted in the
 * provider panel or in .env needs no second entry here.
 *
 * Sources: a workspace path, a public URL, or a data: URL (an attachment).
 */
function VisionSection() {
  const providers = useStore((state) => state.providers);
  const showNotice = useStore((state) => state.showNotice);
  const [config, setConfig] = useState<VisionConfig>({ providerId: '', model: '' });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setConfig(await fetchVisionConfig());
      } catch {
      }
      setLoaded(true);
    })();
  }, []);

  const selected = providers.find((entry) => entry.id === config.providerId);
  const modelOptions = selected?.models ?? [];

  const save = async () => {
    setSaving(true);
    try {
      await saveVisionConfig(config);
      showNotice('settings.visionSaved');
    } catch (error) {
      showNotice('settings.visionSaveFailed', undefined, {
        detail: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const configured = Boolean(config.providerId && config.model);

  return (
    <div className="mt-2.5 rounded-control border border-hairline bg-surface">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-elevated"
      >
        <Eye
          className={cx('h-4 w-4 shrink-0 transition-colors', configured ? 'text-accent' : 'text-faint')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium text-ink">Vision</span>
          <span className="mt-0.5 block truncate text-[11px] text-faint">
            {!loaded
              ? 'Loading…'
              : configured
                ? `${selected?.label ?? config.providerId} · ${config.model}`
                : 'Not configured — a text-only model cannot see images'}
          </span>
        </span>
        <ChevronDown
          className={cx('h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-200', !open && '-rotate-90')}
          aria-hidden="true"
        />
      </button>

      <CollapseSection open={open}>
        <div className="space-y-3 border-t border-hairline px-3 py-3">
          <p className="text-[11px] leading-relaxed text-faint">
            When a model cannot read an image itself, it calls <span className="font-mono">agent__vision</span> and the
            multimodal model you pick here describes it. The key resolves through the provider panel or .env — no need
            to enter it twice.
          </p>

          <label className="block">
            <span className="field-label mb-1 block">Provider</span>
            <select
              value={config.providerId}
              onChange={(event) => setConfig((prev) => ({ ...prev, providerId: event.target.value, model: '' }))}
              className="field w-full text-[12.5px]"
            >
              <option value="">Choose a provider…</option>
              {providers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="field-label mb-1 block">Multimodal model</span>
            <input
              type="text"
              list="vision-models"
              value={config.model}
              onChange={(event) => setConfig((prev) => ({ ...prev, model: event.target.value }))}
              placeholder={modelOptions[0] ?? 'e.g. mistral-small-latest'}
              className="field w-full text-[12.5px]"
            />
            {modelOptions.length > 0 ? (
              <datalist id="vision-models">
                {modelOptions.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            ) : null}
          </label>

          <label className="block">
            <span className="field-label mb-1 block">Base URL (optional)</span>
            <input
              type="text"
              value={config.baseUrl ?? ''}
              onChange={(event) =>
                setConfig((prev) => ({ ...prev, baseUrl: event.target.value.trim() ? event.target.value.trim() : undefined }))
              }
              placeholder={selected ? selected.baseUrl : 'Leave blank to use the provider default'}
              className="field w-full text-[12.5px]"
            />
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !config.providerId || !config.model}
              className="pill-button flex-1 justify-center bg-accent py-1.5 text-[12px] text-accent-ink hover:brightness-110 disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              {saving ? 'Saving…' : 'Save'}
            </button>
            {configured ? (
              <button
                type="button"
                onClick={() => {
                  setConfig({ providerId: '', model: '', baseUrl: undefined });
                  void saveVisionConfig({ providerId: '', model: '' });
                  showNotice('settings.visionCleared');
                }}
                className="pill-button justify-center border border-hairline py-1.5 text-[12px] text-muted hover:text-ink"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      </CollapseSection>
    </div>
  );
}

function Slider({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-[12px] font-medium text-muted" htmlFor={id}>
          {label}
        </label>
        <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-ink">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-describedby={`${id}-hint`}
        className={cx(
          'h-1.5 w-full cursor-pointer appearance-none rounded-full bg-hairline',
          'accent-[rgb(var(--c-accent))]',
        )}
      />
      <p id={`${id}-hint`} className="mt-1 text-[11px] text-faint">
        {hint}
      </p>
    </div>
  );
}

/** Re-exported so the composer's Tools chip can reference the same labels. */export const TOOL_ICONS = { Code2, MapPin, Link2 };
