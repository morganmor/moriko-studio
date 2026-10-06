import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code2,
  CornerDownLeft,
  Eraser,
  FileText,
  Film,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Link2,
  Loader2,
  Music,
  Paperclip,
  Plug,
  ShieldCheck,
  Square,
  SquareTerminal,
  Target,
  Waypoints,
  Wrench,
  X,
} from './icons';

import { attachmentRefUrl, storeBytesRef, uploadAttachment } from '../lib/api';

import { uid } from '../lib/storage';
import { contextBreakdown, reasoningFootprint } from '../lib/compaction';
import { useEffectiveSettings, useStore } from '../store/useStore';
import { CatEyeModeToggle, useTypewriterStatus } from './CatEyeModeToggle';
import { lookupModelMeta, nearestThinkingLevel, thinkingLadderFor } from '../lib/modelMeta';
import type { TurnAttachment } from '../types';
import { ImageLightbox } from './ImageLightbox';
import { Tip, Toggle, cx } from './ui';
import { THINKING_COPY } from './SettingsPanel';

/** Hard caps so a base64 attachment stays a sane thing to sync to the device. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;

const FILE_ACCEPT =
  'image/*,video/*,audio/*,.pdf,.txt,.md,.markdown,.csv,.json,.xml,.yaml,.yml,.docx,.xlsx,.pptx';

function attachmentIcon(mime: string): typeof FileText {
  if (mime.startsWith('image/')) return ImageIcon;
  if (mime.startsWith('video/')) return Film;
  if (mime.startsWith('audio/')) return Music;
  return FileText;
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * P1 CLS: probe an image's intrinsic size from its data URL so the thread can
 * reserve the right box before the bitmap decodes. Resolves undefined for
 * anything that isn't a decodable image (or fails to load) — callers treat
 * that as "no dimensions known".
 */
function readImageDimensions(dataUrl: string): Promise<{ width: number; height: number } | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(undefined);
    image.src = dataUrl;
  });
}

const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|xml|yaml|yml|svg|log|ini|toml|env|sql|html?|css|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bat|ps1|lua|r|swift|dart|vue|svelte|graphql|prisma|dockerfile|gitignore)$/i;

/**
 * Text-like files are inlined as plain text so EVERY provider can read them.
 * SVG counts as text: browsers report its mime as image/svg+xml, but it is
 * XML SOURCE — providers refuse it as an image ("could not decode image"),
 * and the model needs the markup itself to recreate or edit the drawing.
 */
function isTextLike(file: File): boolean {
  return file.type === 'image/svg+xml' || file.type.startsWith('text/') || TEXT_EXTENSIONS.test(file.name);
}

interface ComposerProps {
  onSend: (text: string, attachments?: TurnAttachment[], attachmentPaths?: string[]) => void;
  onStop: () => void;
  streaming: boolean;
  /** Why sending is blocked, shown inline instead of as a dead button. */
  blockedReason?: string;
  draft: string;
  onDraftChange: (value: string) => void;
  /** 'docked' sits at the bottom of the thread (default); 'centered' floats
   *  in the empty state under the brand block, without the top rule. */
  variant?: 'docked' | 'centered';
  /** NATIVE workspace pick — opens the device's own folder dialog and
   *  registers the selection as the active agent workspace. */
  onPickWorkspace?: () => void;
  /** Opens/closes the Goals & plans panel. */
  onToggleGoals?: () => void;
  goalsOpen?: boolean;
  /**
   * STEER: inject the draft into a RUNNING generation's context. Called with
   * the trimmed text; returns true when the server queued it (202). When the
   * run already ended (409) the caller keeps the draft so the user can send
   * it as a normal message instead.
   */
  /** DSH-style steer: the draft PLUS attachments (images/files) ride as one
      ordinary user message into the live generation's context. */
  onSteer?: (
    text: string,
    attachments?: TurnAttachment[],
  ) => Promise<{ id: string | null } | import('../lib/api').SteerFailure>;
  /** SEND REMINDER: pushes the server-owned Writing-Rules reminder into the
      running generation — one click, no typing. Same steer channel. The
      failure variant carries the real reason (old server, network drop) so
      the notice never lies with "the run just finished". */
  onSendReminder?: () => Promise<{ id: string | null } | import('../lib/api').SteerFailure>;
  /** Turn arrows in the right cluster: jump to the earliest / newest turn.
   *  Rendered only when the handler is wired (thread view), so the empty-state
   *  composer stays clean. */
  onNavigateFirstTurn?: () => void;
  onNavigateLatest?: () => void;
  /**
   * ATTACHMENT DIRECTORY: the workspace paths of the picked attachments,
   * forwarded to the request so the harness injects them into the system
   * prompt. Empty when no workspace is registered (data URLs still carry the
   * files) — the model is only told about paths it can actually use.
   */
  attachmentPaths?: string[];
}

/**
 * Composer.
 *
 * Autogrows up to a fixed ceiling so a long prompt never swallows the thread,
 * and keeps Enter-to-send with Shift+Enter for newlines. Every control here is
 * wired: stub affordances that only raised a "not implemented" toast were
 * removed instead of shipped.
 */
export function Composer({
  onSend,
  onStop,
  streaming,
  blockedReason,
  draft,
  onDraftChange,
  variant = 'docked',
  onPickWorkspace,
  onToggleGoals,
  goalsOpen = false,
  onSteer,
  onSendReminder,
  onNavigateFirstTurn,
  onNavigateLatest,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [attachments, setAttachments] = useState<TurnAttachment[]>([]);
  /** Full-size preview URL for an image attachment the user clicked. */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /** Document (text/markdown/code) attachment being previewed in the modal. */
  const [previewDoc, setPreviewDoc] = useState<TurnAttachment | null>(null);

  /* PORTAL OVERLAY PARITY WITH Modal: this preview is a raw createPortal
     div, so Escape and the body scroll-lock never applied to it — Escape
     did nothing and the thread scrolled behind the backdrop. */
  useEffect(() => {
    if (!previewDoc) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewDoc(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [previewDoc]);
  const [steerBusy, setSteerBusy] = useState(false);
  useEffect(() => {
    if (!toolsOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-tools-popover]')) return;
      setToolsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setToolsOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [toolsOpen]);
  const settings = useEffectiveSettings();
  const terminalMode = settings.terminalMode ?? 'auto';
  const updateSettings = useStore((state) => state.updateSettings);
  const showNotice = useStore((state) => state.showNotice);
  const agentWorkspace = useStore((state) =>
    state.agentWorkspaces.find((workspace) => workspace.id === state.activeAgentWorkspaceId),
  );
  const activeChatId = useStore((state) => state.activeId);
  const goalRunning = useStore((state) =>
    (state.activeConversation()?.goals ?? []).some((goal) => goal.status === 'running'),
  );
  // P5 BUGFIX (regresi multi-baris): cache guard saya meninggalkan
  const lastAutoGrowHeight = useRef(0);
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    let frame = 0;
    const grow = () => {
      element.style.height = 'auto';
      const target = Math.min(element.scrollHeight, 200);
      if (Math.abs(target - lastAutoGrowHeight.current) < 1) {
        element.style.height = `${lastAutoGrowHeight.current}px`;
        return;
      }
      lastAutoGrowHeight.current = target;
      element.style.height = `${target}px`;
    };
    frame = requestAnimationFrame(grow);
    return () => cancelAnimationFrame(frame);
  }, [draft]);

  const canSend =
    (draft.trim().length > 0 || attachments.length > 0) &&
    !streaming &&
    !blockedReason;

  /** Paste support: screenshots (Ctrl+V) and copied files attach like picks. */
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.files ?? []).filter((file) => file.size > 0);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  const submit = () => {
    if (!canSend) return;
    const paths = attachments
      .map((attachment) => attachment.path)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    onSend(draft.trim(), attachments.length > 0 ? attachments : undefined, paths.length > 0 ? paths : undefined);
    setAttachments([]);
  };

  /**
   * STEER (DSH-style): hand the draft PLUS the attached images/files to the
   * running generation — the same content a normal send would carry, entering
   * the model's context between tool rounds as an ordinary user message. The
   * draft and attachments are only cleared when the server actually queued
   * the steer — on a 409 (the run ended between typing and pressing) both
   * stay so the user can send it as an ordinary message.
   */
  const submitSteer = async () => {
    if (!onSteer || steerBusy || (draft.trim().length === 0 && attachments.length === 0)) return;
    setSteerBusy(true);
    try {
      const result = await onSteer(draft.trim(), attachments);
      if (result.id) {
        onDraftChange('');
        setAttachments([]);
      } else {
        showNotice('run.steeredAsNew');
      }
    } finally {
      setSteerBusy(false);
    }
  };

  const [dragActive, setDragActive] = useState(false);
  /** FLASH mode — diketik sekali, tahan 10 detik, lalu backspace keluar. */
  const modeStatus = useTypewriterStatus(settings.agentMode ? 'AGENT MODE ACTIVE' : 'CHAT MODE ONLY', 10_000);

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDragActive(true);
    }
  };

  const onDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files ?? []).filter((file) => file.size > 0);
    if (files.length === 0) return;
    void addFiles(files);
  };

  /** Reads picked files into data URLs, enforcing the size/count caps. */
  const addFiles = async (files: File[] | FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    const picked = Array.from(files).slice(0, Math.max(room, 0));
    if (picked.length === 0) {
      showNotice('attachments.tooMany', { max: MAX_ATTACHMENTS });
      return;
    }
    const state = useStore.getState();
    if (state.model) {
      const meta = lookupModelMeta(state.modelMeta, state.model);
      const hasImage = picked.some((file) => file.type.startsWith('image/') && file.type !== 'image/svg+xml');
      if (hasImage && meta && !meta.imageIn) {
        showNotice('attachments.imageNotSupported', { model: state.model });
      }
    }
    const loaded: TurnAttachment[] = [];
    for (const file of picked) {
      if (file.size > MAX_FILE_BYTES) {
        showNotice('attachments.tooLarge', { name: file.name });
        continue;
      }
      try {
        if (isTextLike(file)) {
          // preview modal) AND an on-disk path (so the model reads the FULL
          const [textContent, path] = await Promise.all([
            readAsText(file),
            uploadAttachment(file, activeChatId ?? undefined),
          ]);
          loaded.push({
            id: uid('att'),
            name: file.name,
            mime: file.type || 'text/plain',
            size: file.size,
            textContent,
            ...(path ? { path } : {}),
          });
        } else {
          const [dataUrl, path, bytesRef] = await Promise.all([
            readAsDataUrl(file),
            uploadAttachment(file, activeChatId ?? undefined),
            storeBytesRef(await file.arrayBuffer(), file.type || 'application/octet-stream'),
          ]);
          const dimensions = (file.type || '').startsWith('image/')
            ? await readImageDimensions(dataUrl)
            : undefined;
          const keepInline = bytesRef === null;
          loaded.push({
            id: uid('att'),
            name: file.name,
            mime: file.type || 'application/octet-stream',
            size: file.size,
            ...(keepInline ? { dataUrl } : { dataRef: bytesRef! }),
            ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
            ...(path ? { path } : {}),
          });
        }
      } catch {
        showNotice('attachments.readFailed', { name: file.name });
      }
    }
    if (loaded.length > 0) setAttachments((prev) => [...prev, ...loaded]);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (streaming && onSteer && draft.trim().length > 0) {
        void submitSteer();
        return;
      }
      submit();
    }
  };

  return (
    <div
      className={
        variant === 'centered'
          ? 'w-full px-2 pb-2'
          :
            'animate-slide-down bg-transparent px-6 pb-6 pt-0'
      }
    >
      {}
      <div className="mx-auto w-full max-w-4xl">
        {}
        {blockedReason ? (
          <p className="mb-2 text-[12px] text-warning" role="status">
            {blockedReason}
          </p>
        ) : null}

        {/* MODE STATUS — flash sekali: diketik → tahan 10s → backspace keluar.
            Setelah `done` barisnya TIDAK dirender, jadi strip ini tidak lagi
            menutupi context di atas composer. */}
        {modeStatus.done ? null : (
          <div
            aria-hidden="true"
            className={cx(
              'flex h-[18px] select-none items-center px-1.5 font-mono text-[12px] font-medium tracking-[0.2em] transition-colors duration-300',
              settings.agentMode ? 'text-accent' : 'text-faint',
              variant === 'centered' ? 'mb-2 self-start' : 'mb-2',
            )}
          >
            <span>{modeStatus.text}</span>
            <span className="cat-eye-cursor" />
          </div>
        )}

        {/* Turn navigation sits BESIDE the input panel — a sibling of the
            card, never a control inside it. ABSOLUTE: the buttons claim no
            width/height from the row, so the card keeps its full symmetric
            mx-auto-centered width and never shifts when they appear. */}
        <div className="relative flex items-center gap-3">
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          className={cx(
            // GLOW IKUT MODE (contoh .ag-panel[data-mode]): Agent → border +
            // glow oranye (fokus memperkuat); Chat only → polos tanpa glow.
            'flex min-w-0 flex-1 flex-col rounded-3xl border bg-elevated p-3 transition-all',
            settings.agentMode
              ? 'border-accent/60 shadow-[0_0_0_1px_rgb(var(--c-accent)/0.18),0_0_24px_-6px_rgb(var(--c-accent)/0.35)] focus-within:border-accent/60 focus-within:shadow-[0_0_0_1px_rgb(var(--c-accent)/0.35),0_0_32px_-6px_rgb(var(--c-accent)/0.5)]'
              : 'border-hairline focus-within:border-muted/60',
            dragActive ? 'border-accent bg-accent-soft' : '',
          )}
        >
          <label className="sr-only" htmlFor="composer-input">
            Message
          </label>
          <textarea
            id="composer-input"
            ref={textareaRef}
            rows={2}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder="Ask Moriko anything…"
            style={{
              zoom: 'calc(var(--app-zoom, 1) / var(--ctx-scale, 1))',
              fontSize: 'calc(15px * var(--ctx-scale, 1) / var(--app-zoom, 1))',
            }}
            className="max-h-[200px] w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink placeholder:text-faint focus:outline-none"
          />

          {attachments.length > 0 ? (
            // ATTACHMENT STRIP ON TOP (ChatGPT-style): thumbnails live ABOVE
            // the input line, inside the same card. flex + order-first keeps
            // the DOM unchanged while painting the strip first.
            <div className="order-first mb-2 flex flex-wrap items-center gap-1.5">
              {attachments.map((attachment) => {
                const isImage = attachment.mime.startsWith('image/') && (attachment.dataRef || attachment.dataUrl);
                if (isImage) {
                  return (
                    <div
                      key={attachment.id}
                      className="group/thumb relative h-16 w-16 shrink-0 overflow-hidden rounded-control border border-hairline bg-elevated"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setPreviewUrl(attachment.dataRef ? attachmentRefUrl(attachment.dataRef.hash, attachment.dataRef.mime) : attachment.dataUrl!)
                        }
                        className="h-full w-full"
                        aria-label={`Preview ${attachment.name}`}
                      >
                        <img
                          src={attachment.dataRef ? attachmentRefUrl(attachment.dataRef.hash, attachment.dataRef.mime) : attachment.dataUrl}
                          alt={attachment.name}
                          className="h-full w-full object-cover transition-transform hover:scale-105"
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))}
                        aria-label={`Remove ${attachment.name}`}
                        className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover/thumb:opacity-100"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                  );
                }
                // Text-like documents get a preview card: click opens a modal
                if (attachment.textContent !== undefined) {
                  const Icon = attachmentIcon(attachment.mime);
                  return (
                    <div
                      key={attachment.id}
                      className="group/doc relative h-16 w-16 shrink-0 overflow-hidden rounded-control border border-hairline bg-elevated"
                    >
                      <button
                        type="button"
                        onClick={() => setPreviewDoc(attachment)}
                        className="flex h-full w-full flex-col items-center justify-center gap-1 transition-colors hover:bg-elevated/60"
                        aria-label={`Preview ${attachment.name}`}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
                        <span className="max-w-[52px] truncate px-1 text-[9px] text-faint">{attachment.name}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))}
                        aria-label={`Remove ${attachment.name}`}
                        className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover/doc:opacity-100"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                  );
                }
                const Icon = attachmentIcon(attachment.mime);
                return (
                  <span
                    key={attachment.id}
                    className="inline-flex items-center gap-1.5 rounded-control border border-hairline bg-elevated px-2 py-1 text-[11.5px] text-ink"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />
                    <span className="max-w-[160px] truncate">{attachment.name}</span>
                    <span className="shrink-0 text-faint">{formatBytes(attachment.size)}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))}
                      aria-label={`Remove ${attachment.name}`}
                      className="rounded p-1 text-faint transition-colors hover:text-ink"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </span>
                );
              })}
            </div>
          ) : null}

          {previewUrl ? (
            <ImageLightbox url={previewUrl} onClose={() => setPreviewUrl(null)} />
          ) : null}

          {previewDoc?.textContent !== undefined
            ? createPortal(
                <div
                  className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-8"
                  onClick={() => setPreviewDoc(null)}
                >
                  <div
                    className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-hairline bg-surface shadow-popover"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-faint" aria-hidden="true" />
                        <span className="text-sm text-ink">{previewDoc.name}</span>
                        <span className="text-[11px] text-faint">{formatBytes(previewDoc.size)}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPreviewDoc(null)}
                        aria-label="Close preview"
                        className="icon-button"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                    {}
                    <pre className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] leading-relaxed text-ink whitespace-pre-wrap break-words">
                      {previewDoc.textContent}
                    </pre>
                  </div>
                </div>,
                document.body,
              )
            : null}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {}
            {/* CAT-EYE TOGGLE — pengganti segmen Chat/Agent generik. Mata
                terpejam = Chat only; mata terbuka = Agent (mengikuti
                agent_input_panel_cat_eye.html). Status ketik ada DI ATAS
                panel (posisi contoh), bukan di dalam toolbar. */}
            <CatEyeModeToggle
              agent={settings.agentMode}
              onToggle={() => updateSettings({ agentMode: !settings.agentMode })}
            />

            {}
            <button
              type="button"
              className="icon-button"
              aria-label="Attach files"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="h-4 w-4" aria-hidden="true" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={FILE_ACCEPT}
              className="hidden"
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = '';
              }}
            />
            {dragActive ? (
              <span className="shrink-0 text-[11px] font-medium text-accent">Drop to attach</span>
            ) : null}

            {/* Opens the Goals panel: plans, goals and todo lists. A running
                goal (auto-loop) pulses the dot so it is noticeable. */}
            <button
              type="button"
              className={cx(
                'icon-button relative',
                goalRunning && 'text-accent',
              )}
              aria-label="Goals and plans"
              aria-pressed={goalsOpen}
              onClick={onToggleGoals}
            >
              <Target className="h-4 w-4" aria-hidden="true" />
              {goalRunning ? (
                <span className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
              ) : null}
            </button>

            {}
            <div className="relative" data-tools-popover>
              <button
                type="button"
                onClick={() => setToolsOpen((open) => !open)}
                aria-expanded={toolsOpen}
                aria-haspopup="true"
                aria-label="Tools"
                className={cx(
                  'pill-button gap-1.5 border border-hairline py-1.5',
                  toolsOpen ? 'bg-elevated text-ink' : 'text-muted hover:text-ink',
                )}
              >
                <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
              </button>

              <div
                role="menu"
                aria-hidden={!toolsOpen}
                className={cx(
                  'absolute bottom-full left-0 z-20 mb-2 w-72 rounded-card border border-hairline bg-elevated p-1.5 shadow-popover',
                  // Same reverse-transition close as the Model/Effort menu.
                  'transition-[opacity,transform,visibility] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
                  toolsOpen
                    ? 'visible opacity-100 scale-100'
                    : 'invisible opacity-0 scale-[0.97] pointer-events-none',
                )}
              >
                    <ToolRow
                      icon={Globe}
                      label="Web Access"
                      hint="Browser, fetch & download tools"
                      checked={settings.webAccess}
                      onChange={(value) => updateSettings({ webAccess: value })}
                    />
                    <ToolRow
                      icon={Code2}
                      label="Structured outputs"
                      hint="Ask for a single JSON object"
                      checked={settings.structuredOutputs}
                      onChange={(value) => updateSettings({ structuredOutputs: value })}
                    />
                    <ToolRow
                      icon={Plug}
                      label="Use MCP"
                      hint="Model may call your registered MCP servers"
                      checked={settings.useMcp}
                      onChange={(value) => updateSettings({ useMcp: value })}
                    />
                    <ToolRow
                      icon={Link2}
                      label="Fetch Web"
                      hint="Links you paste are fetched for the model"
                      checked={settings.fetchWeb}
                      onChange={(value) => updateSettings({ fetchWeb: value })}
                    />
                    {}
                    <div className="mt-1 border-t border-hairline px-2.5 pt-2">
                      <p className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
                        <SquareTerminal className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                        Terminal
                      </p>
                      <div className="mt-1.5 flex gap-1" role="radiogroup" aria-label="Terminal mode">
                        {(['off', 'ask', 'auto'] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            role="radio"
                            aria-checked={terminalMode === mode}
                            onClick={() => updateSettings({ terminalMode: mode })}
                            className={cx(
                              'flex-1 rounded-control border px-2 py-1 font-mono text-[11px] capitalize transition-colors',
                              terminalMode === mode
                                ? 'border-accent/60 bg-accent-soft text-ink'
                                : 'border-hairline text-muted hover:border-accent/40 hover:text-ink',
                            )}
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                      <p className="mt-1 text-[10.5px] leading-snug text-faint">
                        {terminalMode === 'off'
                          ? 'run/git tools hidden from the agent'
                          : terminalMode === 'ask'
                            ? 'every command asks you first'
                            : 'commands run silently · git push/clone still ask'}
                      </p>
                      <ToolRow
                        icon={ShieldCheck}
                        label="Confirm deletes"
                        hint="Deleting files always asks you first"
                        checked={settings.confirmDeletes === true}
                        onChange={(value) => updateSettings({ confirmDeletes: value })}
                      />
                    </div>
              </div>
            </div>

            {}
            {settings.agentMode && onPickWorkspace ? (
              <>
                <button
                  type="button"
                  onClick={onPickWorkspace}
                  className={cx(
                    'inline-flex max-w-[220px] items-center gap-1.5 rounded-control border px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                    agentWorkspace
                      ? 'border-accent/40 bg-accent-soft text-ink'
                      : 'border-hairline text-muted hover:text-ink',
                  )}
                >
                  <FolderOpen
                    className={cx('h-3.5 w-3.5 shrink-0', agentWorkspace ? 'text-accent' : 'text-faint')}
                    aria-hidden="true"
                  />
                  <span className="truncate">
                    {agentWorkspace ? agentWorkspace.label : 'Pick workspace'}
                  </span>
                </button>
              </>
            ) : null}

            <span className="flex-1" />

            {}
            <ModelEffortPicker />

            <ContextChip streaming={streaming} />

            {streaming ? (
              <>
                {onSendReminder ? (
                  <Tip label="Send Reminder — push the system rules (Writing Rules) into the running generation">
                  <button
                    type="button"
                    onClick={() => void onSendReminder()}
                    aria-label="Send Reminder"
                    className="pill-button border border-hairline bg-elevated text-ink"
                  >
                    <Bell className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  </Tip>
                ) : null}
                {!onSteer || draft.trim().length === 0 ? (
                <button
                  type="button"
                  onClick={onStop}
                  aria-label="Stop the generation"
                  className="pill-button border border-hairline bg-elevated text-ink"
                >
                  <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                </button>
              ) : (
                <>
                  <Tip label="Stop the generation">
                  <button
                    type="button"
                    onClick={onStop}
                    disabled={steerBusy}
                    aria-label="Stop the generation"
                    className="icon-button border border-hairline bg-elevated text-ink"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                  </button>
                  </Tip>
                  <Tip label="Steer — inject this into the running generation">
                  <button
                    type="button"
                    onClick={() => void submitSteer()}
                    disabled={steerBusy}
                    className={cx(
                      'pill-button text-accent-ink transition-colors',
                      steerBusy
                        ? 'bg-accent/70'
                        : 'bg-accent hover:brightness-110',
                    )}
                  >
                    {steerBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Waypoints className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    Steer
                  </button>
                  </Tip>
                </>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label="Send"
                className="pill-button bg-accent text-accent-ink hover:brightness-110"
              >
                <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

          {onNavigateLatest ? (
            <div className="absolute left-full top-1/2 ml-3 flex -translate-y-1/2 flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={onNavigateFirstTurn}
                aria-label="Jump to the earliest turn"
                className="icon-button h-8 w-8 border border-hairline bg-elevated text-muted hover:text-ink"
              >
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={onNavigateLatest}
                aria-label="Jump to the latest turn"
                className="icon-button h-8 w-8 border border-hairline bg-elevated text-muted hover:text-ink"
              >
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Model + reasoning quick pick (DeepSeek-style): a pill reading
 * `model · effort`, opening a two-row popover (Model › / Effort ›) with the
 * option lists. NOT a second source of truth — it reads and writes the SAME
 * store fields the Configuration sidebar uses (`setProvider`,
 * `updateSettings({ thinkingLevel })`, the same `thinkingLadderFor` /
 * `nearestThinkingLevel` derivation and `THINKING_COPY` labels), so both
 * UIs always show and change one shared state.
 */
function ModelEffortPicker() {
  const providers = useStore((state) => state.providers);
  const providerId = useStore((state) => state.providerId);
  const model = useStore((state) => state.model);
  const modelMeta = useStore((state) => state.modelMeta);
  const setProvider = useStore((state) => state.setProvider);
  const showNotice = useStore((state) => state.showNotice);
  const updateSettings = useStore((state) => state.updateSettings);
  const settings = useEffectiveSettings();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'root' | 'model' | 'effort'>('root');

  // Same lazy metadata retry as the Configuration panel: the ladder is
  // meaningless while the catalog map is still empty.
  useEffect(() => {
    if (Object.keys(modelMeta).length === 0) void useStore.getState().ensureModelMeta();
  }, [modelMeta, model, providerId]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-model-popover]')) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const thinking = thinkingLadderFor(modelMeta, providerId, model ?? '');
  const effectiveThinking = nearestThinkingLevel(thinking.levels, settings.thinkingLevel);
  const effortLabel = THINKING_COPY[effectiveThinking].label;

  // Same chat-variant filter as ModelPicker: drop image-only gateways.
  const relevantProviders = providers.filter((entry) => {
    const caps = entry.imageCapabilities?.models;
    return !caps || entry.models.some((id) => !caps[id]);
  });

  const chooseModel = (nextProvider: string, nextModel: string) => {
    setProvider(nextProvider, nextModel);
    showNotice('settings.modelSelected', { model: nextModel });
    setOpen(false);
  };

  const backRow = (
    <button
      type="button"
      onClick={() => setView('root')}
      className="flex w-full items-center gap-1.5 rounded-control px-2 py-1.5 text-[11.5px] text-muted transition-colors hover:bg-surface hover:text-ink"
    >
      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
      Back
    </button>
  );

  return (
    <div className="relative min-w-0" data-model-popover>
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          // Reset on OPEN, not close: closing leaves the current sub-view
          // untouched so the fade-out shows what it opened from — no flash
          // back to the root rows mid-animation.
          if (next) setView('root');
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Model and reasoning effort"
        className={cx(
          'pill-button gap-1.5 border border-hairline py-1.5',
          open ? 'bg-elevated text-ink' : 'text-muted hover:text-ink',
        )}
      >
        <span className="max-w-[140px] truncate text-ink">{model || 'No model'}</span>
        <span className="text-faint">·</span>
        <span className="text-accent">{effortLabel}</span>
        <ChevronUp className={cx('h-3 w-3 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>

      <div
        role="menu"
        aria-hidden={!open}
        className={cx(
          'absolute bottom-full right-0 z-20 mb-2 w-80 rounded-card border border-hairline bg-elevated p-1.5 shadow-popover',
          // Mirrors `animate-scale-in` (180ms / 0.97↔1 / same curve) but as a
          // TRANSITION so closing plays it in reverse instead of unmounting
          // instantly. visibility flips at transition end → fade-out finishes
          // before the menu leaves the a11y tree / tab order.
          'transition-[opacity,transform,visibility] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
          open
            ? 'visible opacity-100 scale-100'
            : 'invisible opacity-0 scale-[0.97] pointer-events-none',
        )}
      >
          {view === 'root' ? (
            <>
              <button
                type="button"
                onClick={() => setView('model')}
                className="flex w-full items-center justify-between gap-2 rounded-control px-3 py-2 text-[12.5px] transition-colors hover:bg-surface"
              >
                <span className="text-muted">Model</span>
                <span className="flex min-w-0 items-center gap-1 text-ink">
                  <span className="truncate">{model || 'None'}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />
                </span>
              </button>
              <button
                type="button"
                onClick={() => setView('effort')}
                className="flex w-full items-center justify-between gap-2 rounded-control px-3 py-2 text-[12.5px] transition-colors hover:bg-surface"
              >
                <span className="text-muted">Effort</span>
                <span className="flex items-center gap-1 text-ink">
                  {effortLabel}
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />
                </span>
              </button>
            </>
          ) : null}

          {view === 'model' ? (
            <div>
              {/* Scroll list ONLY — Back lives in the footer below, so it
                  never scrolls out of reach. */}
              <div className="max-h-64 overflow-y-auto">
                {relevantProviders.map((entry) => (
                  <div key={entry.id} className="mb-1">
                    <p className="px-3 py-1 text-[10.5px] font-medium uppercase tracking-wide text-faint">
                      {entry.label || entry.id}
                    </p>
                    {entry.models.map((name) => (
                      <button
                        key={`${entry.id}/${name}`}
                        type="button"
                        onClick={() => chooseModel(entry.id, name)}
                        className={cx(
                          'flex w-full items-center justify-between gap-2 rounded-control px-3 py-1.5 text-left text-[12.5px] transition-colors',
                          entry.id === providerId && name === model
                            ? 'bg-accent/15 text-ink'
                            : 'text-muted hover:bg-surface hover:text-ink',
                        )}
                      >
                        <span className="truncate">{name}</span>
                        {entry.id === providerId && name === model ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              <div className="mt-1 border-t border-hairline pt-1">{backRow}</div>
            </div>
          ) : null}

          {view === 'effort' ? (
            <div>
              {thinking.levels.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    updateSettings({ thinkingLevel: value });
                    setOpen(false);
                  }}
                  className={cx(
                    'flex w-full items-center justify-between gap-2 rounded-control px-3 py-1.5 text-left text-[12.5px] transition-colors',
                    value === effectiveThinking
                      ? 'bg-accent/15 text-ink'
                      : 'text-muted hover:bg-surface hover:text-ink',
                  )}
                >
                  <span>{THINKING_COPY[value].label}</span>
                  {value === effectiveThinking ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                  ) : null}
                </button>
              ))}
              <div className="mt-1 border-t border-hairline pt-1">{backRow}</div>
            </div>
          ) : null}
      </div>
    </div>
  );
}

function ToolRow({
  icon: Icon,
  label,
  hint,
  checked,
  onChange,
}: {
  icon: typeof Code2;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {  return (
    <div className="flex items-center gap-3 rounded-control px-2.5 py-2 transition-colors hover:bg-surface">
      <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink">{label}</p>
        <p className="truncate text-[11px] text-faint">{hint}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} hideLabel />
    </div>
  );
}

/**
 * Context usage ring inside the input panel's toolbar. The ring shows the
 * active/limit ratio at a glance; CLICKING it opens a DeepSeek-web-style
 * popover: % of context used, ~active / limit with a progress bar, and a
 * System prompt / Tool definitions / Messages breakdown plus the session
 * grand total.
 */
function ContextChip({ streaming }: { streaming: boolean }) {
  const activeConversation = useStore((state) => state.activeConversation());
  const model = useStore((state) => state.model);
  const modelMetaMap = useStore((state) => state.modelMeta);
  const [open, setOpen] = useState(false);
  const [confirmTrim, setConfirmTrim] = useState(false);
  useEffect(() => {
    if (!open) setConfirmTrim(false);
  }, [open]);
  const [throttledConversation, setThrottledConversation] = useState(activeConversation);
  const lastComputeRef = useRef(0);
  useEffect(() => {
    const now = Date.now();
    if (open || now - lastComputeRef.current >= 500) {
      lastComputeRef.current = now;
      setThrottledConversation(activeConversation);
    }
  }, [activeConversation, open]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-context-popover]')) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  if (!activeConversation) return null;

  const modelMetaInfo = model ? lookupModelMeta(modelMetaMap, model) : undefined;
  const conversation = throttledConversation ?? activeConversation;
  const breakdown = useMemo(
    () => contextBreakdown(conversation, modelMetaInfo),
    [conversation, modelMetaInfo],
  );
  const reasoning = useMemo(
    () => reasoningFootprint(conversation),
    [conversation],
  );
  const fmt = (value: number): string => Math.round(value).toLocaleString('id-ID');
  const ratio =
    breakdown.effectiveLimit && breakdown.effectiveLimit > 0
      ? Math.min(breakdown.activeTokens / breakdown.effectiveLimit, 1)
      : null;
  const pct = ratio !== null ? Math.round(ratio * 100) : null;
  const hot = ratio !== null && ratio >= 0.95;
  const circumference = 2 * Math.PI * 6;

  const applyTrim = (): void => {
    const state = useStore.getState();
    const conversation = state.activeConversation();
    if (!conversation) return;
    state.trimReasoning(conversation.id);
    setConfirmTrim(false);
  };

  return (
    <div className="relative" data-context-popover>
      {open ? (
        <div
          role="dialog"
          aria-label="Context usage breakdown"
          className="animate-scale-in absolute bottom-full right-0 z-20 mb-2 w-64 rounded-card border border-hairline bg-elevated p-3 shadow-popover"
        >
            <p className="text-[12.5px] font-semibold text-ink">
              {pct !== null ? `${pct}% of context used` : 'Context usage'}
            </p>
            {ratio !== null && breakdown.effectiveLimit ? (
              <>
                <p className="mt-0.5 font-mono text-[11.5px] tabular-nums text-muted">
                  ~{fmt(breakdown.activeTokens)} / {fmt(breakdown.effectiveLimit)}
                </p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hairline">
                  <div
                    className={cx('h-full rounded-full transition-[width] duration-500', hot ? 'bg-warning' : 'bg-accent')}
                    style={{ width: `${ratio * 100}%` }}
                  />
                </div>
              </>
            ) : null}
            <dl className="mt-2.5 space-y-1.5 text-[12px]">
              <BreakdownRow dot="bg-hairline" label="System prompt" value={`~${fmt(breakdown.systemTokens)}`} />
              <BreakdownRow dot="bg-accent/50" label="Tool definitions" value={`~${fmt(breakdown.toolsTokens)}`} />
              <BreakdownRow dot="bg-accent" label="Messages" value={`~${fmt(breakdown.messagesTokens)}`} />
            </dl>
            {}
            <dl className="ml-[3px] mt-1 space-y-1 border-l border-hairline pl-3 text-[11.5px]">
              <BreakdownRow dot="bg-accent/25" label="Output" value={`~${fmt(breakdown.outputTokens)}`} faint />
              <BreakdownRow dot="bg-accent/40" label="Reasoning" value={`~${fmt(breakdown.reasoningTokens)}`} faint />
            </dl>
            <div className="mt-2.5 flex items-center justify-between border-t border-hairline pt-2 text-[12px]">
              <span className="text-faint">Session total</span>
              <span className="font-mono tabular-nums text-muted">Σ{fmt(breakdown.totalUsedTokens)} used</span>
            </div>
            <p className="mt-1.5 text-[10.5px] leading-snug text-faint">
              {breakdown.limitSource === 'manual'
                ? 'Limit: manually lowered below the model capacity.'
                : breakdown.limitSource === 'fallback'
                  ? 'Limit: assumed 256K — no models.dev metadata for this model. Set a lower context limit for a tighter cap.'
                  : breakdown.effectiveLimit
                    ? 'Limit: the model built-in capacity (models.dev).'
                    : 'Limit: unknown — no models.dev metadata for this model.'}
            </p>
            {}
            {reasoning.turns > 0 ? (
              <div className="mt-2.5 border-t border-hairline pt-2">
                {confirmTrim ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11.5px] leading-snug text-muted">
                      Trim all reasoning in this chat?
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setConfirmTrim(false)}
                        className="rounded-[6px] px-1.5 py-0.5 text-[11.5px] text-faint transition-colors hover:text-ink"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={applyTrim}
                        className="rounded-[6px] bg-danger/10 px-1.5 py-0.5 text-[11.5px] font-medium text-danger transition-colors hover:bg-danger/20"
                      >
                        Trim
                      </button>
                    </div>
                  </div>
                ) : (
                  <Tip
                    className="w-full"
                    align="start"
                    label={
                      streaming
                        ? 'Reasoning is still being written — finish or stop the run first.'
                        : 'Reasoning is kept for the whole conversation. Trim it only when YOU decide the context is heavy.'
                    }
                  >
                  <button
                    type="button"
                    onClick={() => setConfirmTrim(true)}
                    disabled={streaming}
                    className="flex w-full items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-left text-[12px] text-muted transition-colors hover:bg-surface hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted"
                  >
                    <Eraser className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">Trim reasoning</span>
                    <span className="font-mono text-[11px] tabular-nums text-faint">~{fmt(reasoning.tokens)}</span>
                  </button>
                  </Tip>
                )}
              </div>
            ) : (
              <p className="mt-2.5 border-t border-hairline pt-2 text-[10.5px] leading-snug text-faint">
                Reasoning is kept for the whole conversation — nothing is trimmed automatically.
              </p>
            )}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Context usage details"
        className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:text-ink"
      >
        <svg viewBox="0 0 16 16" className={cx('h-[18px] w-[18px] -rotate-90', hot ? 'text-warning' : 'text-accent')} aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${(ratio ?? 0) * circumference} ${circumference}`}
          />
        </svg>
      </button>
    </div>
  );
}

/**
 * What the trim button would remove: every reasoning block still stored on the
 * conversation — the legacy per-turn field plus the per-round reasoning
 * segments — priced with the SAME estimator the context meter uses, so the
 * number on the button is the number the meter would drop.
 */
function BreakdownRow({
  dot,
  label,
  value,
  faint,
}: {
  dot: string;
  label: string;
  value: string;
  /** Sub-row of another bucket: lighter ink so the nesting reads at a glance. */
  faint?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={cx('h-2 w-2 shrink-0 rounded-[3px]', dot)} aria-hidden="true" />
      <dt className={cx('min-w-0 flex-1 truncate', faint ? 'text-faint' : 'text-muted')}>{label}</dt>
      <dd className={cx('font-mono tabular-nums', faint ? 'text-faint' : 'text-muted')}>{value}</dd>
    </div>
  );
}
