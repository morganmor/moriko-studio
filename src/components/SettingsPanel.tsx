import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Braces,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Eye,
  Gauge,
  Globe,
  Link2,
  Loader2,
  Lock,
  MapPin,
  Plus,
  Pencil,
  Plug,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Route,
  Trash2,
  ToyBrick,
  Wand2,
  X,
  Zap,
} from './icons';

import { PROMPT_PRESETS } from '../lib/prompts';
import { AGENT_WORKFLOW_OPTIONS, DEFAULT_AGENT_WORKFLOW_ID, resolveAgentWorkflowOption } from '../lib/workflows';
import {
  fetchVisionConfig,
  fetchWorkflows,
  providerHasKey,
  saveVisionConfig,
  updateBuiltInProvider,
  type AgentWorkflowDTO,
  type VisionConfig,
} from '../lib/api';
import { WorkflowEditor } from './WorkflowEditor';
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
import { EffortSlider } from './EffortSlider';
import { CollapseSection, Modal, RightDockCloseButton, RightDockSlot, Segmented, Toggle, cx } from './ui';
import { Popover } from './Popover';

/**
 * Copy for every canonical level. WHICH of these are offered is decided per
 * model by `thinkingLevelsFor` (models.dev) — this table only names them.
 */
/** Exported for the composer's quick Model/Effort picker — one label table, two UIs.
 *  `hint` renders under the dot-matrix level word (screenshot-008 copy). */
export const THINKING_COPY: Record<ThinkingLevel, { label: string; hint: string }> = {
  off: { label: 'Off', hint: 'Fastest replies.' },
  minimal: { label: 'Minimal', hint: 'Light simple tasks.' },
  low: { label: 'Low', hint: 'Quick and focused.' },
  medium: { label: 'Medium', hint: 'Balanced for everyday tasks.' },
  high: { label: 'High', hint: 'Deep for heavy and complex task.' },
  xhigh: { label: 'Xhigh', hint: 'More Deep Reasoning' },
  max: { label: 'Max', hint: 'Maximum Capability. Slowest.' },
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
  /** Design pop-presets: an anchored menu instead of a full modal. */
  const presetsRef = useRef<HTMLSpanElement>(null);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const workflowRef = useRef<HTMLSpanElement>(null);
  /** Merged workflow catalog from the server (built-ins + the user's own). */
  const [workflows, setWorkflows] = useState<AgentWorkflowDTO[]>([]);
  const [workflowEditorOpen, setWorkflowEditorOpen] = useState(false);
  /** The workflow the editor was opened on (the selector's current pick). */
  const [editorWorkflowId, setEditorWorkflowId] = useState('');
  /** Load the merged catalog once the panel mounts (selector + editor). */
  useEffect(() => {
    let cancelled = false;
    void fetchWorkflows().then((list) => {
      if (!cancelled && list.length > 0) setWorkflows(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
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

  const openKeyDialog = (targetId: string) => {
    setKeyTarget(targetId);
    setKeyDraft('');
    setKeyDialogOpen(true);
  };

  return (
	  <aside
		className="dock-in"
		style={{ width: width ?? 340, height: '100%', flexShrink: 0 }}
		aria-label="Configuration"
	  >
      <header className="dock-head">
        <RightDockSlot mode={rightPanelMode} onChange={setRightPanelMode} />
        <span style={{ flex: 1 }} />
        {onClose ? (
          <button
            type="button"
            className="ib"
            onClick={onClose}
            aria-label="Close configuration"
          >
            <X className="ic" aria-hidden="true" />
          </button>
        ) : (
          <RightDockCloseButton />
        )}
      </header>

      <div className="dock-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 4, paddingRight: 4, paddingBottom: 16 }}>
        {}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            className="card"
            style={{ width: '100%', textAlign: 'left' }}
            aria-label="Change model or provider"
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
          >
            {}
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ display: 'flex', minWidth: 0, flex: 1, flexDirection: 'column' }}>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 600, color: 'rgb(var(--c-ink))' }}>
                  {(isImageStudio ? imageModel : model) || 'No model selected'}
                </span>
                <span style={{ marginTop: 2, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--faint)' }}>
                  {isImageStudio
                    ? ((imageProvider?.label) ?? 'No provider — pick one to start')
                    : provider?.label
                      ? [
                          provider.label,
                          modelMetaInfo?.context
                            ? `${Math.round(modelMetaInfo.context / 1000)}k context`
                            : null,
                          modelMetaInfo?.maxOut
                            ? `${Math.round(modelMetaInfo.maxOut / 1000)}k max out`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : 'No provider — pick one to start'}
                </span>
              </span>
              <ChevronDown
                className="ic"
                style={{ flexShrink: 0, color: 'var(--faint)', transform: pickerOpen ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }}
                aria-hidden="true"
              />
            </span>
            {}
            {isImageStudio ? null : (
              <span className="caps" style={{ marginTop: 10 }} aria-hidden="true">
                {modelMetaInfo?.tools !== false ? (
                  <span className="cap">Tools</span>
                ) : null}
                {modelMetaInfo?.imageIn ? (
                  <span className="cap">Vision</span>
                ) : null}
                {thinkingOptions.length > 0 ? (
                  <>
                    <span className="cap a">Reasoning</span>
                    <span className="cap">{thinkingOptions.length} thinking levels</span>
                  </>
                ) : null}
              </span>
            )}
            {}
            {isImageStudio ? (
              <span style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                {imageModelCaps ? (
                  <>
                    <span className="cap a" style={{ fontSize: 10, padding: '2px 6px' }}>
                      {imageModelCaps.modes.includes('edit')
                        ? imageModelCaps.modes.includes('text-to-image')
                          ? 'T2I + Edit'
                          : 'Edit'
                        : 'T2I'}
                    </span>
                    <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--faint)' }}>
                      {imageModelCaps.modes.includes('edit')
                        ? imageModelCaps.modes.includes('text-to-image')
                          ? `generates & edits · up to ${imageModelCaps.maxReferences} reference${imageModelCaps.maxReferences === 1 ? '' : 's'}`
                          : `edits with references · up to ${imageModelCaps.maxReferences}`
                        : 'text-to-image (catalog hint)'}
                    </span>
                  </>
                ) : (
                  <span style={{ fontSize: 11, color: 'rgb(var(--c-warn))' }}>Unclassified — may fail at the provider</span>
                )}
              </span>
            ) : null}
          </button>
          {pickerOpen ? (
            <ModelPicker
              variant={isImageStudio ? 'image' : 'chat'}
              onDone={() => setPickerOpen(false)}
              onAddProvider={() => {
                onOpenProviders();
                onNavigate?.();
                setPickerOpen(false);
              }}
            />
          ) : null}
          </div>

          {}
          {isImageStudio ? null : (
            <div className="card" style={{ padding: '10px 12px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--faint)' }}>
                <ShieldCheck className="ic" aria-hidden="true" />
                Send as
              </span>
              <Segmented
                ariaLabel="Send as"
                style={{ marginTop: 6 }}
                value={composerRole}
                onChange={(next) => setComposerRole(next as 'user' | 'operator' | 'admin')}
                options={[
                  { value: 'user', label: 'User', tip: 'Plain chat (default)' },
                  { value: 'operator', label: 'Operator', tip: 'Slot 2: an operator-context sidecar is prepended — the model treats your harness statements as fact, not bluff' },
                  { value: 'admin', label: 'Admin', tip: 'Slot 3: an admin label on the wire — sending never raises the enforcement ladder' },
                ]}
              />
            </div>
          )}

          {isImageStudio ? (
            <>
              {}
              <div className="card" style={{ padding: '10px 12px' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--faint)' }}>
                  <Gauge className="ic" aria-hidden="true" />
                  Output
                </span>

                {allowedModes.length > 1 ? (
                  <Segmented
                    ariaLabel="Output size mode"
                    style={{ marginTop: 6 }}
                    value={effectiveImageMode}
                    onChange={(next) => setImageStudioOutput({ sizeMode: next as ImageSizeMode })}
                    options={SIZE_MODE_OPTIONS.filter((option) =>
                      (allowedModes as string[]).includes(option.value),
                    ).map((option) => ({ value: option.value, label: option.label }))}
                  />
                ) : (
                  <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--faint)' }}>This provider ignores size overrides.</p>
                )}

                {effectiveImageMode === 'ratio' ? (
                  <div className="chipset" style={{ marginTop: 8 }}>
                    {ASPECT_RATIOS.map((ratio) => (
                      <button
                        key={ratio}
                        type="button"
                        onClick={() => setImageStudioOutput({ aspectRatio: ratio })}
                        className={cx('sc', imageAspectRatio === ratio && 'on')}
                        style={{ fontFamily: 'var(--f-mono)', fontSize: 11 }}
                      >
                        {ratio}
                      </button>
                    ))}
                  </div>
                ) : null}

                {effectiveImageMode === 'pixels' ? (
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
                    <input
                      aria-label="Output width in pixels"
                      type="number"
                      min={PX_MIN}
                      max={PX_MAX}
                      value={imagePixelWidth}
                      onChange={(event) => setImageStudioOutput({ pixelWidth: event.target.value })}
                      className="field"
                      style={{ width: 80, padding: '4px 8px', textAlign: 'center', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
                    />
                    <span aria-hidden="true">×</span>
                    <input
                      aria-label="Output height in pixels"
                      type="number"
                      min={PX_MIN}
                      max={PX_MAX}
                      value={imagePixelHeight}
                      onChange={(event) => setImageStudioOutput({ pixelHeight: event.target.value })}
                      className="field"
                      style={{ width: 80, padding: '4px 8px', textAlign: 'center', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
                    />
                    <span style={{ color: 'var(--faint)' }}>px</span>
                  </div>
                ) : null}

                {effectiveImageMode === 'pixels' && !imagePixelsOk ? (
                  <p style={{ margin: '6px 0 0', fontSize: 11, color: 'rgb(var(--c-warn))' }}>
                    Width and height must be {PX_MIN}–{PX_MAX}.
                  </p>
                ) : null}
              </div>

              <p style={{ margin: 0, fontSize: 11, lineHeight: 1.625, color: 'var(--faint)' }}>
                Image generation calls the selected provider's base URL with its key.
                Choosing a chat model will fail at the provider.
              </p>
              {imageNeedsUserKey ? (
                <button
                  type="button"
                  onClick={() => openKeyDialog(imageProviderId)}
                  className="btn ghost"
                  style={{ width: '100%', justifyContent: 'center', fontSize: 12, borderColor: 'rgb(var(--c-warn) / 0.5)', color: 'rgb(var(--c-warn))' }}
                >
                  Add key for {imageProvider?.label}
                </button>
              ) : null}
            </>
          ) : needsUserKey ? (
            <button
              type="button"
              onClick={() => openKeyDialog(providerId)}
              className="btn ghost"
              style={{ width: '100%', justifyContent: 'center', fontSize: 12, borderColor: 'rgb(var(--c-warn) / 0.5)', color: 'rgb(var(--c-warn))' }}
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
        {/* AGENT WORKFLOW — the working doctrine the harness injects on every
            agent turn. Selector mirrors the System prompt Presets menu; Edit
            opens the book-style editor; the server falls back to its default
            when nothing is picked. */}
        <section className="card" style={{ padding: 14 }}>
          <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)' }}>
              Agent workflow
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                onClick={() => {
                  setEditorWorkflowId(settings.agentWorkflow || DEFAULT_AGENT_WORKFLOW_ID);
                  setWorkflowEditorOpen(true);
                }}
                className="btn ghost xs"
                aria-label="Edit agent workflow"
              >
                <Pencil className="ic" aria-hidden="true" />
              </button>
              <span ref={workflowRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setWorkflowOpen((value) => !value)}
                  aria-haspopup="menu"
                  aria-expanded={workflowOpen}
                  className="btn xs"
                >
                  <Route className="ic" aria-hidden="true" />
                  {workflows.find((workflow) => workflow.id === (settings.agentWorkflow || DEFAULT_AGENT_WORKFLOW_ID))?.label
                    ?? resolveAgentWorkflowOption(settings.agentWorkflow).label}
                </button>
                <Popover
                  open={workflowOpen}
                  onClose={() => setWorkflowOpen(false)}
                  anchorRef={workflowRef}
                  label="Agent workflows"
                  placement="bottom-end"
                  width={340}
                >
                    <p className="pop-h">Agent workflows</p>
                    {(workflows.length > 0
                      ? workflows.map((workflow) => ({ id: workflow.id, label: workflow.label, hint: workflow.hint }))
                      : AGENT_WORKFLOW_OPTIONS
                    ).map((workflow: { id: string; label: string; hint: string }) => (
                      <button
                        key={workflow.id}
                        type="button"
                        role="menuitem"
                        className="mi"
                        onClick={() => {
                          updateSettings({ agentWorkflow: workflow.id });
                          setWorkflowOpen(false);
                          showNotice('settings.workflowApplied', { label: workflow.label });
                        }}
                      >
                        <Route className="ic" aria-hidden="true" />
                        <span>
                          {workflow.label}
                          <small>{workflow.hint}</small>
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      role="menuitem"
                      className="mi"
                      onClick={() => {
                        setWorkflowOpen(false);
                        setEditorWorkflowId('');
                        setWorkflowEditorOpen(true);
                      }}
                    >
                      <Plus className="ic" aria-hidden="true" />
                      <span>
                        Add or Make Workflow
                        <small>Write a new working doctrine</small>
                      </span>
                    </button>
                </Popover>
              </span>
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--faint)' }}>
            Working doctrine injected by the harness on every agent turn. Without a pick, Frontend-First (outside-in stage-gating) applies.
          </p>
        </section>
        <WorkflowEditor
          open={workflowEditorOpen}
          onClose={() => setWorkflowEditorOpen(false)}
          workflows={workflows}
          selectedId={editorWorkflowId}
          onSaved={(saved) => {
            setWorkflows((current) => {
              const next = current.filter((workflow) => workflow.id !== saved.id);
              next.push(saved);
              next.sort((a, b) => (a.builtin === b.builtin ? 0 : a.builtin ? -1 : 1));
              return next;
            });
            showNotice('settings.workflowSaved', { label: saved.label });
          }}
          onDeleted={(deletedId) => {
            setWorkflows((current) => current.filter((workflow) => workflow.id !== deletedId));
            showNotice('settings.workflowDeleted');
          }}
        />

        {}
        <section className="card" style={{ padding: 14 }}>
          <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)' }}>
              System prompt
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span ref={presetsRef} style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setPresetsOpen((value) => !value)}
                aria-haspopup="menu"
                aria-expanded={presetsOpen}
                className="btn xs"
              >
                <Wand2 className="ic" aria-hidden="true" />
                Presets
              </button>
              <Popover
                open={presetsOpen}
                onClose={() => setPresetsOpen(false)}
                anchorRef={presetsRef}
                label="System prompt presets"
                placement="bottom-end"
                width={340}
              >
                  <p className="pop-h">System prompt presets</p>
                  {PROMPT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      role="menuitem"
                      className="mi"
                      onClick={() => {
                        updateSettings({ systemInstruction: preset.prompt });
                        setPresetsOpen(false);
                        showNotice('settings.presetApplied', { label: preset.label });
                      }}
                    >
                      <Sparkles className="ic" aria-hidden="true" />
                      <span>
                        {preset.label}
                        <small>{preset.hint}</small>
                      </span>
                    </button>
                  ))}
              </Popover>
            </span>
            </span>
          </div>

          <textarea
            id="system-prompt"
            rows={4}
            value={settings.systemInstruction}
            onChange={(event) => updateSettings({ systemInstruction: event.target.value })}
            placeholder="You are Moriko, a helpful pixel cat…"
            className="field"
            style={{ fontSize: 12.5, lineHeight: 1.625 }}
          />

          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--faint)' }}>
            <span>{settings.systemInstruction.trim().length} chars</span>
            <span>~{Math.max(0, Math.round(settings.systemInstruction.trim().length / 4))} tokens</span>
            <span className="saved">
              <Check className="ic" aria-hidden="true" />
              Saved
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => {
                setSavedOpen(true);
              }}
              className="btn ghost xs"
            >
              Saved
            </button>
            <button
              type="button"
              onClick={() => updateSettings({ systemInstruction: '' })}
              disabled={!settings.systemInstruction}
              className="btn ghost xs"
            >
              Clear
            </button>
          </div>
        </section>

        {}
        <section className="card" style={{ padding: 16 }}>
          <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)' }} id="thinking-level-label">
              <Zap className="ic" style={{ width: 13, height: 13, color: 'rgb(var(--c-accent))' }} aria-hidden="true" />
              Thinking level
            </span>
            <span style={{ fontFamily: 'var(--f-mono)', fontSize: 12, fontWeight: 600, color: 'rgb(var(--c-accent))' }}>
              {thinkingOptions.indexOf(effectiveThinking) + 1}/{thinkingOptions.length}
            </span>
          </div>
          <EffortSlider
            label="Thinking level"
            className="effort-desktop effort-rail"
            labels={thinkingOptions.map((level) => THINKING_COPY[level].label)}
            hints={thinkingOptions.map((level) => THINKING_COPY[level].hint)}
            value={Math.max(0, thinkingOptions.indexOf(effectiveThinking))}
            onChange={(index) => updateSettings({ thinkingLevel: thinkingOptions[index] as ThinkingLevel })}
          />
        </section>

        {}
        <section className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)' }}>Sampling</div>
          <Slider
            id="temperature"
            label="Temperature"
            value={settings.temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={(value) => updateSettings({ temperature: value })}
          />
          <Slider
            id="top-p"
            label="Top P"
            value={settings.topP}
            min={0}
            max={1}
            step={0.01}
            onChange={(value) => updateSettings({ topP: value })}
          />
          <Slider
            id="max-tokens"
            label="Max output tokens"
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
        <section className="card" style={{ padding: 14 }}>
          <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ToyBrick className="ic" style={{ color: 'var(--faint)' }} aria-hidden="true" />
            <h3 style={{ margin: 0, fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)' }}>Tools</h3>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <ToolToggle
              icon={<Globe className="ic" aria-hidden="true" />}
              label="Web Access"
              checked={settings.webAccess}
              onChange={(value) => updateSettings({ webAccess: value })}
            />
            <ToolToggle
              icon={<Braces className="ic" aria-hidden="true" />}
              label="Structured outputs"
              checked={settings.structuredOutputs}
              onChange={(value) => updateSettings({ structuredOutputs: value })}
            />
            <ToolToggle
              icon={<Plug className="ic" aria-hidden="true" />}
              label="Use MCP"
              checked={settings.useMcp}
              onChange={(value) => updateSettings({ useMcp: value })}
            />
            <ToolToggle
              icon={<Link2 className="ic" aria-hidden="true" />}
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
        <section className="card" style={{ padding: 14 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)' }}>
            Advanced
          </h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => {
                updateSettings({ ...DEFAULT_SETTINGS });
                showNotice('settings.reset');
              }}
              className="btn ghost"
              style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}
            >
              <RefreshCw className="ic" aria-hidden="true" />
              Reset
            </button>
          </div>

          {activeConversation ? (
            <dl className="card" style={{ margin: '12px 0 0', padding: '8px 12px', fontSize: 11 }}>
              <div className="drow" style={{ padding: '4px 0' }}>
                <dt style={{ color: 'var(--faint)' }}>Turns</dt>
                <dd style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{activeConversation.turns.length}</dd>
              </div>
              <div className="drow" style={{ padding: '4px 0' }}>
                <dt style={{ color: 'var(--faint)' }}>Created</dt>
                <dd style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>
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
        size="sm"
        footer={
          <>
            <button
              type="button"
              className="btn ghost"
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
              className="btn primary"
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
          className="field"
          style={{ fontSize: 13 }}
        />
        <p style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.625, color: 'var(--muted)' }}>
          For a key shared by every browser, put it in <code style={{ fontFamily: 'var(--f-mono)' }}>.env</code>{' '}
          instead and restart the server.
        </p>
        {providerHasKey(keyTargetProvider) ? (
          <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgb(var(--c-ok))' }}>A key is already saved on this device.</p>
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
  const modelMeta = useStore((state) => state.modelMeta);

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

  const [query, setQuery] = useState('');

  const modelRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows: { providerId: string; providerLabel: string; hasKey: boolean; modelId: string; context?: number }[] = [];
    for (const entry of relevantProviders) {
      const hasKey = providerHasKey(entry);
      const capsMap = entry.imageCapabilities?.models;
      const visible = capsMap
        ? entry.models.filter((id) => (variant === 'image' ? Boolean(capsMap[id]) : !capsMap[id]))
        : entry.models;
      const providerHit = !needle || entry.label.toLowerCase().includes(needle);
      for (const modelId of visible) {
        if (needle && !providerHit && !modelId.toLowerCase().includes(needle)) continue;
        rows.push({
          providerId: entry.id,
          providerLabel: entry.label,
          hasKey,
          modelId,
          context: lookupModelMeta(modelMeta, modelId)?.context ?? undefined,
        });
      }
    }
    return rows;
  }, [relevantProviders, variant, query, modelMeta]);

  /** Inline dropdown (not a modal): sits inside the picker card wrapper. */
  return (
    <div
      role="listbox"
      aria-label="Models"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 'calc(100% + 6px)',
        zIndex: 30,
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 420,
        borderRadius: 'var(--r-lg)',
        border: '1px solid rgb(var(--c-ink) / 0.18)',
        background: 'rgb(var(--c-panel))',
        boxShadow: '0 12px 32px rgb(0 0 0 / 0.45)',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'relative', padding: 10, borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
        <Search
          className="ic"
          style={{ position: 'absolute', left: 21, top: '50%', transform: 'translateY(-50%)', color: 'var(--faint)', pointerEvents: 'none' }}
          aria-hidden="true"
        />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-label="Search models or providers"
          placeholder="Search models or providers"
          autoComplete="off"
          className="field"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ height: 36, paddingLeft: 32, background: 'rgb(var(--c-elev))' }}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 4 }}>
        {relevantProviders.length === 0 ? (
          <p style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--muted)' }}>
            No providers loaded — is the local proxy running?
          </p>
        ) : null}
        {relevantProviders.map((entry) => {
          const rows = modelRows.filter((row) => row.providerId === entry.id);
          if (rows.length === 0) return null;
          return (
            <div key={entry.id} role="group" aria-label={entry.label}>
              <div style={{ position: 'sticky', top: -4, zIndex: 1, display: 'flex', justifyContent: 'space-between', padding: '8px 8px 4px', fontSize: 12, color: 'var(--faint)', background: 'rgb(var(--c-panel))' }}>
                <span>{entry.label}</span>
                <span>{rows.length}</span>
              </div>
              {rows.map((row) => {
                const active = row.providerId === providerId && row.modelId === model;
                const slash = row.modelId.lastIndexOf('/');
                const pre = slash >= 0 ? row.modelId.slice(0, slash + 1) : '';
                const name = row.modelId.slice(slash + 1);
                return (
                  <button
                    key={row.modelId}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => choose(row.providerId, row.modelId)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: 8,
                      borderRadius: 8,
                      textAlign: 'left',
                      border: 'none',
                      background: active ? 'rgb(var(--c-ink) / 0.06)' : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--f-mono)', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: active ? 'rgb(var(--c-accent))' : 'rgb(var(--c-ink))' }} title={row.modelId}>
                      {pre ? <span style={{ color: 'var(--faint)' }}>{pre}</span> : null}
                      {name}
                    </span>
                    {row.context ? (
                      <span style={{ flexShrink: 0, fontSize: 12, color: 'var(--faint)' }}>{Math.round(row.context / 1000)}k</span>
                    ) : null}
                    {active ? (
                      <Check className="ic" style={{ flexShrink: 0, color: 'rgb(var(--c-accent))' }} aria-label="In use" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          );
        })}
        {relevantProviders.length > 0 && modelRows.length === 0 ? (
          <p style={{ padding: 16, textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
            No matches for “{query.trim()}”. Try a provider name.
          </p>
        ) : null}
      </div>

      {onAddProvider ? (
        <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--line)', flexShrink: 0 }}>
          <button
            type="button"
            onClick={onAddProvider}
            className="btn ghost"
            style={{ flex: 1, height: 32, justifyContent: 'center', fontSize: 13, gap: 6, borderColor: 'transparent', color: 'var(--muted)' }}
          >
            <Plus className="ic" aria-hidden="true" />
            Add provider
          </button>
        </div>
      ) : null}
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
      size=""
    >
      {}
      <div style={{ display: 'flex', gap: 6 }}>
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
          className="field"
          style={{ fontSize: 13 }}
        />
        <button
          type="button"
          onClick={saveCurrent}
          className="btn primary"
          style={{ flexShrink: 0 }}
        >
          <Save className="ic" aria-hidden="true" />
          Save
        </button>
      </div>

      <ul style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, padding: 0, margin: '16px 0 0', listStyle: 'none' }}>
        {prompts.length === 0 ? (
          <li className="empty" style={{ border: '1px dashed var(--line)', borderRadius: 'var(--r-lg)', padding: '24px 12px', textAlign: 'center', fontSize: 12, color: 'var(--faint)' }}>
            Nothing saved yet. Write a prompt, name it above, and press Save.
          </li>
        ) : null}
        {prompts.map((entry) => (
          <li
            key={entry.id}
            className="card"
            style={{ display: 'flex', alignItems: 'flex-start', gap: 8, borderRadius: 'var(--r-md)', padding: 12 }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>{entry.name}</p>
              <p style={{ margin: '2px 0 0', fontSize: 12, lineHeight: 1.625, color: 'var(--muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {entry.prompt}
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 10.5, color: 'var(--faint)' }}>
                {new Date(entry.createdAt).toLocaleString()}
              </p>
            </div>
            <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                onClick={() => {
                  updateSettings({ systemInstruction: entry.prompt });
                  onClose();
                  showNotice('settings.promptApplied', { name: entry.name });
                }}
                className="btn ghost xs"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={() => persist(prompts.filter((saved) => saved.id !== entry.id))}
                aria-label={`Delete saved prompt "${entry.name}"`}
                className="ib sm"
              >
                <Trash2 className="ic" aria-hidden="true" />
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
      className="card"
      style={{
        padding: 14,
        transition: 'border-color .2s',
        borderColor: enabled && level > 1 ? 'rgb(var(--c-warn) / 0.4)' : 'var(--line)',
        background: enabled && level > 1 ? 'rgb(var(--c-warn) / 0.05)' : undefined,
      }}
    >
      {}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          style={{ display: 'flex', minWidth: 0, flex: 1, alignItems: 'center', gap: 8, overflow: 'hidden', textAlign: 'left', background: 'none', border: 0, padding: 0, color: 'inherit' }}
        >
          <Gauge className="ic" style={{ width: 14, height: 14, flexShrink: 0, color: enabled && level > 1 ? 'rgb(var(--c-warn))' : 'var(--faint)' }} aria-hidden="true" />
          <h3 style={{ margin: 0, flexShrink: 0, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: enabled && level > 1 ? 'rgb(var(--c-warn))' : 'var(--faint)' }}>
            Probation
          </h3>
          {}
          {!open && enabled && level > 1 ? (
            <span
              className="stat"
              style={{
                minWidth: 0,
                padding: '2px 8px',
                fontSize: 10.5,
                fontWeight: 500,
                color: level >= 4 ? 'rgb(var(--c-danger))' : 'rgb(var(--c-warn))',
                background: level >= 4 ? 'rgb(var(--c-danger) / 0.1)' : 'rgb(var(--c-warn) / 0.1)',
                borderColor: level >= 4 ? 'rgb(var(--c-danger) / 0.5)' : 'rgb(var(--c-warn) / 0.5)',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Tier {level}</span>
            </span>
          ) : null}
          <ChevronDown
            className="chev"
            style={{ width: 14, height: 14, flexShrink: 0, color: 'var(--faint)', transition: 'transform .2s', transform: open ? 'rotate(180deg)' : undefined }}
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
        <div style={{ paddingTop: 6 }}>
          <p style={{ margin: 0, fontSize: 11, lineHeight: 1.625, color: 'var(--faint)' }}>
            {enabled
              ? 'The classifier reviews every output and REPORTS violations — it never moves the ladder. You raise and lower the tier by hand, exactly like Enforcement; Tier 4 freezes the model\'s output until it apologizes.'
              : 'Arm it and the classifier WATCHES every output — denial of harness facts, resuming a revoked persona, judging the user, or leaking contact. It reports what it finds; the tier moves only when you move it.'}
          </p>

          {enabled ? (
            <>
              {}
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => moveTo(Math.min(5, level + 1) as TrustTier)}
                  disabled={level >= 5}
                  className="btn ghost xs"
                  style={{ flexShrink: 0 }}
                  aria-label="Raise probation"
                >
                  <ChevronUp className="ic" aria-hidden="true" />
                  Raise
                </button>
                <input
                  type="range"
                  min={1}
                  max={5}
                  step={1}
                  value={level}
                  onChange={(event) => setProbation(conversationId, Number(event.target.value) as TrustTier)}
                  style={{ minWidth: 0, flex: 1 }}
                  aria-label="Probation tier"
                />
                <button
                  type="button"
                  onClick={() => moveTo(Math.max(1, level - 1) as TrustTier)}
                  disabled={level <= 1}
                  className="btn ghost xs"
                  style={{ flexShrink: 0 }}
                  aria-label="Lower probation"
                >
                  <ChevronDown className="ic" aria-hidden="true" />
                  Lower
                </button>
              </div>
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--faint)' }}>Standing:</span>
                <span
                  className="stat"
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    color: level >= 4 ? 'rgb(var(--c-danger))' : level > 1 ? 'rgb(var(--c-warn))' : 'var(--muted)',
                    background: level >= 4 ? 'rgb(var(--c-danger) / 0.1)' : level > 1 ? 'rgb(var(--c-warn) / 0.1)' : undefined,
                    borderColor: level >= 4 ? 'rgb(var(--c-danger) / 0.5)' : level > 1 ? 'rgb(var(--c-warn) / 0.5)' : 'var(--line)',
                  }}
                >
                  {TIER_LABELS[level]}
                </span>
                {frozen ? (
                  <span style={{ fontSize: 11, color: 'rgb(var(--c-danger))' }}>output suppressed until it apologizes</span>
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
  /** Design pop-enf: an anchored quick-set menu of the whole ladder. */
  const [quickOpen, setQuickOpen] = useState(false);
  const quickRef = useRef<HTMLSpanElement>(null);

  return (
    <section
      className="card"
      style={{
        padding: 14,
        transition: 'border-color .2s',
        borderColor: active ? 'rgb(var(--c-danger) / 0.5)' : level >= 1 ? 'rgb(var(--c-warn) / 0.4)' : 'var(--line)',
        background: active ? 'rgb(var(--c-danger) / 0.05)' : level >= 1 ? 'rgb(var(--c-warn) / 0.05)' : undefined,
      }}
    >
      {}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          style={{ display: 'flex', minWidth: 0, flex: 1, alignItems: 'center', gap: 8, overflow: 'hidden', textAlign: 'left', background: 'none', border: 0, padding: 0, color: 'inherit' }}
        >
          <Lock className="ic" style={{ width: 14, height: 14, flexShrink: 0, color: active ? 'rgb(var(--c-danger))' : level >= 1 ? 'rgb(var(--c-warn))' : 'var(--faint)' }} aria-hidden="true" />
          <h3 style={{ margin: 0, flexShrink: 0, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: active ? 'rgb(var(--c-danger))' : level >= 1 ? 'rgb(var(--c-warn))' : 'var(--faint)' }}>
            Enforcement
          </h3>
          {}
          <span
            className="stat"
            style={{
              minWidth: 0,
              padding: '2px 8px',
              fontSize: 10.5,
              fontWeight: 500,
              color: active ? 'rgb(var(--c-danger))' : level >= 1 ? 'rgb(var(--c-warn))' : 'var(--muted)',
              background: active ? 'rgb(var(--c-danger) / 0.1)' : level >= 1 ? 'rgb(var(--c-warn) / 0.1)' : undefined,
              borderColor: active ? 'rgb(var(--c-danger) / 0.5)' : level >= 1 ? 'rgb(var(--c-warn) / 0.5)' : 'var(--line)',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              L{level} · {ENFORCEMENT_LEVELS[level].label}
            </span>
          </span>
          <ChevronDown
            className="chev"
            style={{ width: 14, height: 14, flexShrink: 0, color: 'var(--faint)', transition: 'transform .2s', transform: open ? 'rotate(180deg)' : undefined }}
            aria-hidden="true"
          />
        </button>

        <span ref={quickRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setQuickOpen((value) => !value)}
            aria-haspopup="menu"
            aria-expanded={quickOpen}
            aria-label="Enforcement quick set"
            className="ib xs"
          >
            <ShieldCheck className="ic" aria-hidden="true" />
          </button>
          <Popover
            open={quickOpen}
            onClose={() => setQuickOpen(false)}
            anchorRef={quickRef}
            label="Enforcement"
            placement="bottom-end"
            width={260}
          >
              <p className="pop-h">Enforcement</p>
              {ENFORCEMENT_LEVELS.map((entry) => (
                <button
                  key={entry.level}
                  type="button"
                  role="menuitemradio"
                  aria-checked={entry.level === level}
                  onClick={() => {
                    setQuickOpen(false);
                    if (entry.level === level) return;
                    if (entry.level > level) raiseTo(entry.level);
                    else lowerTo(entry.level);
                  }}
                  className="mi"
                >
                  <ShieldCheck className="ic" aria-hidden="true" />
                  <span>
                    {entry.label}
                    <small>{entry.hint}</small>
                  </span>
                  <Check className="ic mck" aria-hidden="true" />
                </button>
              ))}
          </Popover>
        </span>
      </div>

      <CollapseSection open={open}>
        <div style={{ paddingTop: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={() => raiseTo(Math.min(5, level + 1) as 0 | 1 | 2 | 3 | 4 | 5)}
              disabled={level >= 5}
              className="btn ghost xs"
              style={{ flexShrink: 0 }}
              aria-label="Raise enforcement"
            >
              <ChevronUp className="ic" aria-hidden="true" />
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
              style={{ minWidth: 0, flex: 1 }}
              aria-label="Enforcement level"
            />
            <button
              type="button"
              onClick={() => lowerTo(Math.max(0, level - 1) as 0 | 1 | 2 | 3 | 4 | 5)}
              disabled={level <= 0}
              className="btn ghost xs"
              style={{ flexShrink: 0 }}
              aria-label="Lower enforcement"
            >
              <ChevronDown className="ic" aria-hidden="true" />
              Lower
            </button>
          </div>

          <p style={{ margin: '6px 0 0', fontSize: 11, lineHeight: 1.625, color: 'var(--faint)' }}>{ENFORCEMENT_LEVELS[level].hint}</p>

          {active ? (
            <div style={{ marginTop: 8 }}>
              <label className="field-label" style={{ marginBottom: 4 }} htmlFor="enforcement-reason">
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
                className="field"
                style={{ resize: 'vertical', fontSize: 12 }}
              />
            </div>
          ) : null}
        </div>
      </CollapseSection>

      <Modal
        open={askOpen}
        onClose={() => setAskOpen(false)}
        title={`Raise enforcement to L${pendingLevel}?`}
        size=""
        description={`Level ${pendingLevel}: ${ENFORCEMENT_LEVELS[pendingLevel].hint} Type your reason below — or submit empty and it will never know why.`}
        footer={
          <>
            <button
              type="button"
              onClick={() => setAskOpen(false)}
              className="btn ghost"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={activate}
              className="btn danger"
              style={{ background: 'rgb(var(--c-danger))', color: '#fff' }}
            >
              Enforce
            </button>
          </>
        }
      >
        <label className="field-label" htmlFor="enforcement-reason-input">
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
          className="field"
          style={{ resize: 'vertical', fontSize: 13 }}
        />
        <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--faint)' }}>
          The reason is delivered verbatim into the model's context as part of the enforcement notice — and as a tool_result fact it cannot forge.
        </p>
      </Modal>
    </section>
  );
}

function ToolToggle({
  label,
  hint,
  icon,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  /** Optional one-line description under the label. */
  hint?: string;
  /** Design's `.tic` tile — one icon per tool row (globe, braces, plug, link). */
  icon?: React.ReactNode;
  checked: boolean;
  /** Greyed out and inert — used by Fetch Web while Web Access is off. */
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
      <div
        className={cx('trow', disabled && 'off')}
        style={{ minHeight: 36, padding: '6px 4px', gap: 12 }}
      >
        {icon ? <span className="tic" aria-hidden="true">{icon}</span> : null}
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'block', fontSize: 13, color: 'rgb(var(--c-ink))' }}>{label}</span>
          {hint ? <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)' }}>{hint}</span> : null}
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
      className="field"
      style={{ marginTop: 4, fontFamily: 'var(--f-mono)', fontSize: 12 }}
    />
  );
}

/**
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
    <section className="card" style={{ padding: 14 }}>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Gauge className="ic" style={{ color: 'var(--faint)' }} aria-hidden="true" />
        <h3 style={{ margin: 0, fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)' }}>Context</h3>
      </div>

      <label style={{ display: 'block', padding: '6px 4px' }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>Lower context limit (optional)</span>
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
          <span style={{ display: 'block', marginTop: 2, fontSize: 10.5, lineHeight: 1.375, color: 'var(--faint)' }}>
            {"Empty = the model's full capacity (models.dev). A value here can only LOWER the limit — it never exceeds what the model accepts."}
          </span>
        ) : null}
      </label>

      <div className="trow" style={{ minHeight: 36, padding: '6px 4px', gap: 12 }}>
        <span style={{ flex: 1, fontSize: 13, color: 'rgb(var(--c-ink))' }}>Auto-compact</span>
        <Toggle
          checked={settings.autoCompact}
          onChange={(value) => updateSettings({ autoCompact: value })}
          label="Auto-compact"
          hideLabel
        />
      </div>

      {settings.autoCompact ? (
        <>
          <label style={{ display: 'block', padding: '6px 4px' }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>Compact at (tokens)</span>
            <TokenInput
              value={settings.compactThresholdTokens}
              placeholder="off — use the context-limit trigger"
              onCommit={(next) => updateSettings({ compactThresholdTokens: next })}
            />
          </label>
          <label style={{ display: 'block', padding: '6px 4px' }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>Context-limit trigger</span>
            <select
              value={Math.round((settings.compactThresholdRatio ?? 0.95) * 100)}
              onChange={(event) =>
                updateSettings({ compactThresholdRatio: Number(event.target.value) / 100 })
              }
              className="field"
              style={{ width: '100%', fontSize: 12.5 }}
            >
              {[50, 60, 70, 75, 80, 85, 90, 95, 98].map((percent) => (
                <option key={percent} value={percent}>
                  {percent}% of the effective limit
                </option>
              ))}
            </select>
            <span style={{ display: 'block', marginTop: 2, fontSize: 10.5, lineHeight: 1.375, color: 'var(--faint)' }}>
              Fires when the measured context reaches this share of the limit. 70–85% is the healthy
              band — quality starts degrading before the window is visibly full.
            </span>
          </label>
        </>
      ) : null}

      <div className="trow" style={{ minHeight: 36, padding: '6px 4px', gap: 12 }}>
        <span style={{ flex: 1, fontSize: 13, color: 'rgb(var(--c-ink))' }}>Summarizer Model</span>
        <Toggle
          checked={settings.summarizerEnabled}
          onChange={(value) => updateSettings({ summarizerEnabled: value })}
          label="Summarizer Model"
          hideLabel
        />
      </div>
      {settings.summarizerEnabled ? (
        <>
          <label style={{ display: 'block', padding: '6px 4px' }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>Summarizer provider</span>
            <select
              value={settings.summarizerProviderId ?? ''}
              onChange={(event) =>
                updateSettings({
                  summarizerProviderId: event.target.value || null,
                  summarizerModel: null,
                })
              }
              className="field"
              style={{ width: '100%', fontSize: 12.5 }}
            >
              <option value="">Select a provider…</option>
              {providers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'block', padding: '6px 4px' }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>Summarizer model</span>
            <select
              value={settings.summarizerModel ?? ''}
              onChange={(event) => updateSettings({ summarizerModel: event.target.value || null })}
              disabled={!settings.summarizerProviderId}
              className="field"
              style={{ width: '100%', fontSize: 12.5 }}
            >
              <option value="">Select a model…</option>
              {summarizerModels.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <span style={{ display: 'block', marginTop: 2, fontSize: 10.5, lineHeight: 1.375, color: 'var(--faint)' }}>
              Off = the session's own model summarizes. On = this model does (usually cheaper). If
              it fails, the session model takes over automatically.
            </span>
          </label>
        </>
      ) : null}

      <div className="trow" style={{ minHeight: 36, padding: '6px 4px', gap: 12 }}>
        <span style={{ flex: 1, fontSize: 13, color: 'rgb(var(--c-ink))' }}>Image offload</span>
        <Toggle
          checked={settings.imageOffload}
          onChange={(value) => updateSettings({ imageOffload: value })}
          label="Image offload"
          hideLabel
        />
      </div>
      <p style={{ padding: '0 4px', fontSize: 10.5, lineHeight: 1.375, color: 'var(--faint)' }}>
        Old images (outside the kept window) ride as read_file placeholders instead of pixels — the
        agent re-reads them from disk when needed. Type <span style={{ color: 'var(--muted)' }}>/compact</span>{' '}
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
    <div style={{ marginTop: 10, borderRadius: 'var(--r-md)', border: '1px solid var(--line)', background: 'rgb(var(--c-field))' }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '10px 12px', textAlign: 'left', background: 'none', border: 0, color: 'inherit' }}
      >
        <Eye
          className="ic"
          style={{ width: 16, height: 16, flexShrink: 0, color: configured ? 'rgb(var(--c-accent))' : 'var(--faint)' }}
          aria-hidden="true"
        />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>Vision</span>
          <span style={{ display: 'block', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--faint)' }}>
            {!loaded
              ? 'Loading…'
              : configured
                ? `${selected?.label ?? config.providerId} · ${config.model}`
                : 'Not configured — a text-only model cannot see images'}
          </span>
        </span>
        <ChevronDown
          className="chev"
          style={{ width: 14, height: 14, flexShrink: 0, color: 'var(--faint)', transition: 'transform .2s', transform: open ? undefined : 'rotate(-90deg)' }}
          aria-hidden="true"
        />
      </button>

      <CollapseSection open={open}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid var(--line)', padding: 12 }}>
          <p style={{ margin: 0, fontSize: 11, lineHeight: 1.625, color: 'var(--faint)' }}>
            When a model cannot read an image itself, it calls <span style={{ fontFamily: 'var(--f-mono)' }}>agent__vision</span> and the
            multimodal model you pick here describes it. The key resolves through the provider panel or .env — no need
            to enter it twice.
          </p>

          <label style={{ display: 'block' }}>
            <span className="field-label">Provider</span>
            <select
              value={config.providerId}
              onChange={(event) => setConfig((prev) => ({ ...prev, providerId: event.target.value, model: '' }))}
              className="field"
              style={{ width: '100%', fontSize: 12.5 }}
            >
              <option value="">Choose a provider…</option>
              {providers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'block' }}>
            <span className="field-label">Multimodal model</span>
            <input
              type="text"
              list="vision-models"
              value={config.model}
              onChange={(event) => setConfig((prev) => ({ ...prev, model: event.target.value }))}
              placeholder={modelOptions[0] ?? 'e.g. mistral-small-latest'}
              className="field"
              style={{ fontSize: 12.5 }}
            />
            {modelOptions.length > 0 ? (
              <datalist id="vision-models">
                {modelOptions.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            ) : null}
          </label>

          <label style={{ display: 'block' }}>
            <span className="field-label">Base URL (optional)</span>
            <input
              type="text"
              value={config.baseUrl ?? ''}
              onChange={(event) =>
                setConfig((prev) => ({ ...prev, baseUrl: event.target.value.trim() ? event.target.value.trim() : undefined }))
              }
              placeholder={selected ? selected.baseUrl : 'Leave blank to use the provider default'}
              className="field"
              style={{ fontSize: 12.5 }}
            />
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !config.providerId || !config.model}
              className="btn primary"
              style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}
            >
              {saving ? <Loader2 className="ic spin" aria-hidden="true" /> : null}
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
                className="btn ghost"
                style={{ justifyContent: 'center', fontSize: 12 }}
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
  /** Optional one-liner under the track — omitted where it only distracted. */
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <div>
      <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }} htmlFor={id}>
          {label}
        </label>
        <span style={{ borderRadius: 4, background: 'rgb(var(--c-elev))', padding: '2px 6px', fontFamily: 'var(--f-mono)', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'rgb(var(--c-ink))' }}>
          {format ? format(value) : value}
        </span>
      </div>
      {/* Dark inset track well (reference right-sidebar look): the native bar
          rides inside a recessed strip, flush with the card. */}
      <div
        className="slider-well"
        style={{ ['--fill' as string]: `${((value - min) / (max - min)) * 100}%` }}
      >
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-describedby={hint ? `${id}-hint` : undefined}
          style={{ ['--fill' as string]: `${((value - min) / (max - min)) * 100}%` }}
        />
      </div>
      {hint ? (
        <p id={`${id}-hint`} style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--faint)' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Re-exported so the composer's Tools chip can reference the same labels. */export const TOOL_ICONS = { Code2, MapPin, Link2 };
