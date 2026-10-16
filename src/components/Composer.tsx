import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  Cpu,
  Eraser,
  FileText,
  Film,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Link2,
  ListFilter,
  ListTodo,
  Loader2,
  Music,
  Paperclip,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Target,
  Wand2,
  Waypoints,
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
import { Popover } from './Popover';
import { SlashMenu, useSlashMenu, type SlashCommand } from './SlashMenu';
import { EffortSlider } from './EffortSlider';
import { Tip, Toggle, cx } from './ui';
import { useIsPhone } from '../hooks/useIsPhone';
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

function isTextLike(file: File): boolean {
  return file.type === 'image/svg+xml' || file.type.startsWith('text/') || TEXT_EXTENSIONS.test(file.name);
}

interface ComposerProps {
  onSend: (text: string, attachments?: TurnAttachment[], attachmentPaths?: string[]) => void;
  onStop: () => void;
  streaming: boolean;
  blockedReason?: string;
  draft: string;
  onDraftChange: (value: string) => void;
  variant?: 'docked' | 'centered';
  onPickWorkspace?: () => void;
  onToggleGoals?: () => void;
  goalsOpen?: boolean;
  onToggleTodos?: () => void;
  /**
   * STEER: inject the draft into a RUNNING generation's context. Called with
   * the trimmed text; returns true when the server queued it (202). When the
   * run already ended (409) the caller keeps the draft so the user can send
   * it as a normal message instead.
   */
  onSteer?: (
    text: string,
    attachments?: TurnAttachment[],
  ) => Promise<{ id: string | null } | import('../lib/api').SteerFailure>;
  onSendReminder?: () => Promise<{ id: string | null } | import('../lib/api').SteerFailure>;
  onNavigateFirstTurn?: () => void;
  onNavigateLatest?: () => void;
  /**
   * ATTACHMENT DIRECTORY: the workspace paths of the picked attachments.
   */
  attachmentPaths?: string[];
}

/**
 * Composer.
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
  onToggleTodos,
  onSteer,
  onSendReminder,
  onNavigateFirstTurn,
  onNavigateLatest,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [attachments, setAttachments] = useState<TurnAttachment[]>([]);
  /** SLASH COMMAND INPUT (design Moriko-Design2): typing "/" opens the
   *  command listbox above the textarea. See SlashMenu.tsx. */
  const theme = useStore((state) => state.theme);
  const setTheme = useStore((state) => state.setTheme);
  const newConversation = useStore((state) => state.newConversation);

  const runSlashCommand = async (command: SlashCommand, args: string): Promise<void> => {
    if (command.builtin) {
      switch (command.c) {
        case '/theme': {
          const next = theme === 'light' ? 'dark' : 'light';
          setTheme(next);
          showNotice('slash.themeSwitched', { label: next });
          return;
        }
        case '/clear':
          newConversation();
          showNotice('slash.clearStarted');
          return;
        case '/image': {
          const request = args.trim();
          const state = useStore.getState();
          const active = state.conversations.find((conversation) => conversation.id === state.activeId);
          const agentMode = active?.settings.agentMode ?? state.pendingSettings.agentMode;
          if (request && agentMode) {
            const paths = attachments
              .map((attachment) => attachment.path)
              .filter((value): value is string => typeof value === 'string' && value.length > 0);
            onSend(`/image ${request}`, attachments.length > 0 ? attachments : undefined, paths.length > 0 ? paths : undefined);
            setAttachments([]);
            showNotice('slash.imageQueued');
            return;
          }
          state.requestImageStudioPrompt(request);
          state.setView('imagestudio');
          showNotice('slash.imageOpened');
          return;
        }
        case '/help':
          window.dispatchEvent(new CustomEvent('moriko:open-shortcuts'));
          showNotice('slash.helpOpened');
          return;
        case '/model':
          showNotice('slash.modelOpened');
          window.dispatchEvent(new CustomEvent('moriko:open-model-picker'));
          return;
        case '/compact':
          onSend(args ? `/compact ${args}` : '/compact');
          return;
        default:
          return;
      }
    }
    try {
      const resp = await fetch('/api/addons/commands/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: command.c.slice(1), args }),
      });
      const payload = (await resp.json()) as { text?: string; error?: string };
      if (!resp.ok) {
        showNotice('slash.runFailed', { detail: payload.error ?? resp.statusText });
        return;
      }
      showNotice('slash.addonRan', { name: command.c, detail: payload.text ?? 'done' });
    } catch (error) {
      showNotice('slash.runFailed', { detail: error instanceof Error ? error.message : 'network error' });
    }
  };

  /** The built-in command list (design SLASH minus /plan — skipped by request). */
  const slashBuiltins = useMemo<SlashCommand[]>(
    () => [
      { c: '/compact', h: 'Summarize older turns', builtin: true, argumentHint: '[focus]' },
      { c: '/model', h: 'Switch model', builtin: true },
      { c: '/image', h: 'Generate an image — agent, or open Image Studio', builtin: true, argumentHint: '[prompt]' },
      { c: '/clear', h: 'Start a fresh chat', builtin: true },
      { c: '/theme', h: 'Toggle light / dark', builtin: true },
      { c: '/help', h: 'Keyboard shortcuts', builtin: true },
    ],
    [],
  );
  const slash = useSlashMenu(draft, onDraftChange, (command, args) => void runSlashCommand(command, args), slashBuiltins);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
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
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const settings = useEffectiveSettings();
  const terminalMode = settings.terminalMode ?? 'auto';
  const bannerFull = settings.agentMode ? 'AGENT MODE ACTIVE' : 'CHAT MODE ONLY';
  const { text: bannerText, done: bannerDone } = useTypewriterStatus(bannerFull, 10_000);
  const updateSettings = useStore((state) => state.updateSettings);
  const showNotice = useStore((state) => state.showNotice);
  const enabledToolCount = useMemo(() => {
    let count = 0;
    if (settings.webAccess) count += 1;
    if (settings.structuredOutputs) count += 1;
    if (settings.useMcp) count += 1;
    if (settings.fetchWeb && settings.webAccess) count += 1;
    if (terminalMode !== 'off') count += 1;
    return count;
  }, [settings.webAccess, settings.structuredOutputs, settings.useMcp, settings.fetchWeb, terminalMode]);
  const agentWorkspace = useStore((state) =>
    state.agentWorkspaces.find((workspace) => workspace.id === state.activeAgentWorkspaceId),
  );
  const activeChatId = useStore((state) => state.activeId);
  const goalRunning = useStore((state) =>
    (state.activeConversation()?.goals ?? []).some((goal) => goal.status === 'running'),
  );
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

  /** Plus menu actions — shared by the desktop popover and the phone sheet. */
  const closePlus = () => setPlusOpen(false);
  const plusBody = (
    <PlusMenuBody
      onUpload={() => {
        closePlus();
        fileInputRef.current?.click();
      }}
      onPlanMode={() => {
        closePlus();
        const trimmed = draft.trimStart();
        if (!trimmed.startsWith('/plan')) onDraftChange(`/plan ${trimmed}`);
        textareaRef.current?.focus();
      }}
      onGoals={() => {
        closePlus();
        onToggleGoals?.();
      }}
      onTodos={() => {
        closePlus();
        onToggleTodos?.();
      }}
      onSlash={() => {
        closePlus();
        window.dispatchEvent(new CustomEvent('moriko:open-palette'));
      }}
      onStudio={() => {
        closePlus();
        useStore.getState().setView('imagestudio');
      }}
      onWorkspace={onPickWorkspace}
      goalRunning={goalRunning}
      goalsOpen={goalsOpen}
      workspaceLabel={agentWorkspace?.label}
      showWorkspace={Boolean(settings.agentMode && onPickWorkspace)}
    />
  );

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
    const text = draft.trim();
    if (text.startsWith('/') && slash.runText(text)) return;
    const paths = attachments
      .map((attachment) => attachment.path)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    onSend(draft.trim(), attachments.length > 0 ? attachments : undefined, paths.length > 0 ? paths : undefined);
    setAttachments([]);
  };

  /**
   * STEER : hand the draft PLUS the attached images/files to the
   * running generation — the same content a normal send would carry, entering
   * the model's context between tool rounds as an ordinary user message.
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

  /** TREE ATTACH (right-dock design): files picked in the project tree ride a
   *  store queue into THIS pipeline, so they get the exact same caps, mime
   *  checks, upload and dataRef handling as drag-dropped files. The ref keeps
   *  the consumer on the latest closure (attachment count changes per render). */
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  const queuedFiles = useStore((state) => state.composerQueuedFiles);
  const clearComposerQueuedFiles = useStore((state) => state.clearComposerQueuedFiles);
  useEffect(() => {
    if (queuedFiles.length === 0) return;
    const files = queuedFiles;
    clearComposerQueuedFiles();
    void addFilesRef.current(files);
  }, [queuedFiles, clearComposerQueuedFiles]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.key(event)) return;
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
      className={cx(
        'composer-shell',
        variant === 'centered' && 'composer-shell-centered',
      )}
    >
      {}
      <div style={{ margin: '0 auto', width: '100%', maxWidth: 'var(--composer-w)' }}>
        {}
        {blockedReason ? (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'rgb(var(--c-warn))' }} role="status">
            {blockedReason}
          </p>
        ) : null}

        {}
        {}
        {bannerDone ? null : (
          <div
            aria-hidden="true"
            className={cx('mode-banner', settings.agentMode && 'on')}
          >
            <span>{bannerText}</span>
            <span className="cat-eye-cursor" />
          </div>
        )}

        {}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          className={cx(
            'composer',
            settings.agentMode && 'agent',
            dragActive && 'dragging',
            streaming && 'composer-busy',
          )}
          style={{ position: 'relative', display: 'flex', minWidth: 0, flex: 1, flexDirection: 'column' }}
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
            className="composer-ta"
          />

          {slash.list ? (
            <SlashMenu
              list={slash.list}
              sel={slash.sel}
              onPick={slash.click}
              onHover={(index) => {
                if (index !== slash.sel) slash.hover(index);
              }}
            />
          ) : null}

          {attachments.length > 0 ? (
            <div className="composer-attach order-first">
              {attachments.map((attachment) => {
                const isImage = attachment.mime.startsWith('image/') && (attachment.dataRef || attachment.dataUrl);
                if (isImage) {
                  return (
                    <div key={attachment.id} className="att">
                      <button
                        type="button"
                        onClick={() =>
                          setPreviewUrl(attachment.dataRef ? attachmentRefUrl(attachment.dataRef.hash, attachment.dataRef.mime) : attachment.dataUrl!)
                        }
                        style={{ width: '100%', height: '100%', padding: 0 }}
                        aria-label={`Preview ${attachment.name}`}
                      >
                        <img
                          src={attachment.dataRef ? attachmentRefUrl(attachment.dataRef.hash, attachment.dataRef.mime) : attachment.dataUrl}
                          alt={attachment.name}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      </button>
                      <button
                        type="button"
                        className="att-x"
                        onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))}
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <X className="ic" aria-hidden="true" />
                      </button>
                    </div>
                  );
                }
                if (attachment.textContent !== undefined) {
                  const Icon = attachmentIcon(attachment.mime);
                  return (
                    <div key={attachment.id} className="att">
                      <button
                        type="button"
                        onClick={() => setPreviewDoc(attachment)}
                        className="att-doc"
                        aria-label={`Preview ${attachment.name}`}
                      >
                        <Icon className="ic" aria-hidden="true" />
                        <span>{attachment.name}</span>
                      </button>
                      <button
                        type="button"
                        className="att-x"
                        onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))}
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <X className="ic" aria-hidden="true" />
                      </button>
                    </div>
                  );
                }
                const Icon = attachmentIcon(attachment.mime);
                return (
                  <span
                    key={attachment.id}
                    className="att-chip"
                  >
                    <Icon className="ic" aria-hidden="true" />
                    <span className="att-n">{attachment.name}</span>
                    <span className="att-s">{formatBytes(attachment.size)}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))}
                      aria-label={`Remove ${attachment.name}`}
                    >
                      <X className="ic" aria-hidden="true" />
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
                  className="modal open"
                  style={{ zIndex: 60, padding: 32, background: 'rgb(var(--c-shadow) / 0.8)' }}
                  onClick={() => setPreviewDoc(null)}
                >
                  <div
                    className="mpanel"
                    style={{ maxWidth: 672 }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="mh">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <FileText className="ic" style={{ color: 'var(--faint)' }} aria-hidden="true" />
                        <span style={{ fontSize: 14, color: 'rgb(var(--c-ink))' }}>{previewDoc.name}</span>
                        <span style={{ fontSize: 11, color: 'var(--faint)' }}>{formatBytes(previewDoc.size)}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPreviewDoc(null)}
                        aria-label="Close preview"
                        className="ib"
                      >
                        <X className="ic" aria-hidden="true" />
                      </button>
                    </div>
                    {}
                    <pre style={{ margin: 0, minHeight: 0, flex: 1, overflow: 'auto', padding: '12px 16px', fontSize: 13, lineHeight: 1.625, color: 'rgb(var(--c-ink))', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
                      {previewDoc.textContent}
                    </pre>
                  </div>
                </div>,
                document.body,
              )
            : null}

          <div className="composer-controls">
            {}
            {}
            <div className="composer-row-1 contents">
            <CatEyeModeToggle
              agent={settings.agentMode}
              onToggle={() => updateSettings({ agentMode: !settings.agentMode })}
            />

            {}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }} data-plus-popover>
              <button
                ref={plusButtonRef}
                type="button"
                className={cx('ib', goalRunning && 'on')}
                aria-label="Add files, plans and workspace"
                aria-expanded={plusOpen}
                aria-haspopup="menu"
                onClick={() => setPlusOpen((value) => !value)}
              >
                <Plus className="ic" aria-hidden="true" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={FILE_ACCEPT}
                hidden
                onChange={(event) => {
                  void addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              {dragActive ? (
                <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 500, color: 'rgb(var(--c-accent))' }}>Drop to attach</span>
              ) : null}

              <Popover
                open={plusOpen}
                onClose={() => setPlusOpen(false)}
                anchorRef={plusButtonRef}
                label="Add"
                width={288}
              >
                {plusBody}
              </Popover>
            </div>


            {}
            <div style={{ position: 'relative' }} data-tools-popover>
              <button
                ref={toolsButtonRef}
                type="button"
                onClick={() => setToolsOpen((open) => !open)}
                aria-expanded={toolsOpen}
                aria-haspopup="true"
                aria-label="Tools"
                className={cx('pill', toolsOpen && 'on')}
              >
                <Plug className="ic" aria-hidden="true" />
                <span>Tools</span>
                {enabledToolCount > 0 ? <span className="tcount">{enabledToolCount}</span> : null}
              </button>

              <Popover
                open={toolsOpen}
                onClose={() => setToolsOpen(false)}
                anchorRef={toolsButtonRef}
                label="Tools for this chat"
                width={288}
              >
                    <p className="pop-h">Tools for this chat</p>
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
                    <p className="pop-h">Terminal</p>
                      <div className="seg" style={{ marginTop: 0, display: 'flex', borderRadius: 12, border: '1px solid var(--line)', background: 'rgb(var(--c-field))', padding: 3 }} role="radiogroup" aria-label="Terminal mode">
                        {(['off', 'ask', 'auto'] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            role="radio"
                            aria-checked={terminalMode === mode}
                            onClick={() => updateSettings({ terminalMode: mode })}
                            style={{
                              height: 26,
                              flex: 1,
                              borderRadius: 9,
                              padding: '0 8px',
                              fontFamily: 'var(--f-mono)',
                              fontSize: 12,
                              fontWeight: 500,
                              textTransform: 'capitalize',
                              color: terminalMode === mode ? 'rgb(var(--c-ink))' : 'var(--muted)',
                              background: terminalMode === mode ? 'rgb(var(--c-elev))' : 'transparent',
                            }}
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                      <p style={{ margin: '4px 0 0', fontSize: 10.5, lineHeight: 1.375, color: 'var(--faint)' }}>
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
              </Popover>
            </div>

            {}
            <div className="composer-actions contents">
            <ContextChip streaming={streaming} />

            {streaming ? (
              <>
                {onSendReminder ? (
                  <Tip label="Send Reminder — push the system rules (Writing Rules) into the running generation">
                  <button
                    type="button"
                    onClick={() => void onSendReminder()}
                    aria-label="Send Reminder"
                    className="pill"
                  >
                    <Bell className="ic" aria-hidden="true" />
                  </button>
                  </Tip>
                ) : null}
                {!onSteer || draft.trim().length === 0 ? (
                <button
                  type="button"
                  onClick={onStop}
                  aria-label="Stop the generation"
                  className="pill"
                >
                  <Square className="ic" style={{ fill: 'currentColor' }} aria-hidden="true" />
                </button>
              ) : (
                <>
                  <Tip label="Stop the generation">
                  <button
                    type="button"
                    onClick={onStop}
                    disabled={steerBusy}
                    aria-label="Stop the generation"
                    className="ib"
                    style={{ border: '1px solid var(--line)', background: 'rgb(var(--c-elev))', color: 'rgb(var(--c-ink))' }}
                  >
                    <Square className="ic" style={{ fill: 'currentColor' }} aria-hidden="true" />
                  </button>
                  </Tip>
                  <Tip label="Steer — inject this into the running generation">
                  <button
                    type="button"
                    onClick={() => void submitSteer()}
                    disabled={steerBusy}
                    className="btn primary sm"
                  >
                    {steerBusy ? (
                      <Loader2 className="ic spin" aria-hidden="true" />
                    ) : (
                      <Waypoints className="ic" aria-hidden="true" />
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
                className="send"
              >
                <ArrowUp className="ic" aria-hidden="true" />
              </button>
            )}
            </div>
            </div>


            {}
            <div className="composer-row-2 contents">
              <span className="composer-spacer" style={{ flex: 1 }} />

              <ModelEffortPicker />
            </div>
          </div>
        </div>

          {onNavigateLatest ? (
            <div className="composer-nav">
              <button
                type="button"
                onClick={onNavigateFirstTurn}
                aria-label="Jump to the earliest turn"
                className="ib"
                style={{ border: '1px solid var(--line)', background: 'rgb(var(--c-elev))', color: 'var(--muted)' }}
              >
                <ChevronUp className="ic" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={onNavigateLatest}
                aria-label="Jump to the latest turn"
                className="ib"
                style={{ border: '1px solid var(--line)', background: 'rgb(var(--c-elev))', color: 'var(--muted)' }}
              >
                <ChevronDown className="ic" aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>

        {}
        <div className="composer-hint" style={{ display: 'flex', justifyContent: 'center', gap: 14, paddingTop: 8, fontSize: 11.5, color: 'var(--faint)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><kbd>Enter</kbd> send</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><kbd>Shift Enter</kbd> newline</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><kbd>/</kbd> commands</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><kbd>Esc</kbd> stop</span>
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
  const [panel, setPanel] = useState<'quick' | 'model' | 'effort' | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const isPhone = useIsPhone();

  useEffect(() => {
    if (Object.keys(modelMeta).length === 0) void useStore.getState().ensureModelMeta();
  }, [modelMeta, model, providerId]);

  const modelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onOpenModelPicker = () => {
      setModelQuery('');
      setPanel('quick');
    };
    window.addEventListener('moriko:open-model-picker', onOpenModelPicker);
    return () => window.removeEventListener('moriko:open-model-picker', onOpenModelPicker);
  }, []);

  const thinking = thinkingLadderFor(modelMeta, providerId, model ?? '');
  const effectiveThinking = nearestThinkingLevel(thinking.levels, settings.thinkingLevel);
  const effortLabel = THINKING_COPY[effectiveThinking].label;

  const relevantProviders = providers.filter((entry) => {
    const caps = entry.imageCapabilities?.models;
    return !caps || entry.models.some((id) => !caps[id]);
  });

  const chooseModel = (nextProvider: string, nextModel: string) => {
    setProvider(nextProvider, nextModel);
    showNotice('settings.modelSelected', { model: nextModel });
    setPanel(null);
  };


  return (
    <div className="cc-chip cc-model" style={{ position: 'relative', minWidth: 0 }} data-model-popover>
      <button
        ref={modelButtonRef}
        type="button"
        onClick={() => {
          const next = panel === 'quick' ? null : 'quick';
          if (next) setModelQuery('');
          setPanel(next);
        }}
        aria-expanded={panel !== null}
        aria-haspopup="menu"
        aria-label="Model and reasoning effort"
        className={cx('pill model', panel && 'on')}
      >
        <span className="mn" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'rgb(var(--c-ink))' }}>
          {isPhone ? ((model ?? '').split('/').pop() || 'No model') : (model || 'No model')}
        </span>
        <span style={{ color: 'var(--faint)' }}>·</span>
        <span style={{ color: 'rgb(var(--c-accent))' }}>{effortLabel}</span>
        <ChevronUp className="chev" style={{ transform: panel ? 'rotate(180deg)' : undefined }} aria-hidden="true" />
      </button>

      <Popover
        open={panel === 'quick'}
        onClose={() => setPanel(null)}
        anchorRef={modelButtonRef}
        label="Model and reasoning"
        placement="bottom-end"
        width={260}
      >
        <button type="button" role="menuitem" className="mi" onClick={() => { setModelQuery(''); setPanel('model'); }}>
          <Cpu className="ic" aria-hidden="true" />
          <span>
            Model
            <small>{model || 'No model'}</small>
          </span>
          <ChevronRight className="ic" style={{ color: 'var(--faint)' }} aria-hidden="true" />
        </button>
        <button type="button" role="menuitem" className="mi" onClick={() => setPanel('effort')}>
          <Sparkles className="ic" aria-hidden="true" />
          <span>
            Reasoning
            <small>{effortLabel}</small>
          </span>
          <ChevronRight className="ic" style={{ color: 'var(--faint)' }} aria-hidden="true" />
        </button>
      </Popover>

      <Popover
        open={panel === 'model'}
        onClose={() => setPanel(null)}
        onBack={() => setPanel('quick')}
        anchorRef={modelButtonRef}
        label="Choose model"
        placement="bottom-end"
        width={320}
      >
          <label className="mp-search">
            <Search className="ic" aria-hidden="true" />
            <input
              type="search"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  const first = (event.currentTarget.closest('.pop') as HTMLElement | null)?.querySelector<HTMLElement>(
                    '.mp-list .mi',
                  );
                  first?.click();
                }
              }}
              placeholder="Search models"
              aria-label="Search models"
              autoComplete="off"
              style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'none', fontSize: 13, color: 'rgb(var(--c-ink))' }}
            />
          </label>
          <div className="mp-list">
            {(() => {
              const needle = modelQuery.trim().toLowerCase();
              const groups = relevantProviders
                .map((entry) => ({
                  ...entry,
                  models: needle
                    ? entry.models.filter(
                        (name) =>
                          name.toLowerCase().includes(needle) ||
                          (entry.label || entry.id).toLowerCase().includes(needle),
                      )
                    : entry.models,
                }))
                .filter((entry) => entry.models.length > 0);
              if (groups.length === 0) return <p className="pop-empty">No models match.</p>;
              return groups.map((entry) => (
                <div key={entry.id} style={{ marginBottom: 4 }}>
                  <p className="mg">{entry.label || entry.id}</p>
                  {entry.models.map((name) => (
                    <button
                      key={`${entry.id}/${name}`}
                      type="button"
                      onClick={() => chooseModel(entry.id, name)}
                      className="mi"
                      role="menuitemradio"
                      aria-checked={entry.id === providerId && name === model}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {name}
                      </span>
                      {entry.id === providerId && name === model ? (
                        <Check className="ic mck" aria-hidden="true" />
                      ) : null}
                    </button>
                  ))}
                </div>
              ));
            })()}
          </div>
      </Popover>

      <Popover
        open={panel === 'effort'}
        onClose={() => setPanel(null)}
        onBack={() => setPanel('quick')}
        anchorRef={modelButtonRef}
        label="Thinking level"
        placement="bottom-end"
        width={320}
      >
          <div className="mp-eff">
            <p className="pop-h" style={{ padding: '4px 4px 4px 10px' }}>
              Thinking level
            </p>
            <EffortSlider
              labels={thinking.levels.map((level) => THINKING_COPY[level].label)}
              hints={thinking.levels.map((level) => THINKING_COPY[level].hint)}
              value={Math.max(0, thinking.levels.indexOf(effectiveThinking))}
              onChange={(index) => updateSettings({ thinkingLevel: thinking.levels[index] })}
              active={panel === 'effort'}
              className="effort-desktop"
            />
          </div>
      </Popover>
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
    <div className="trow" style={{ padding: '8px 0', borderTop: 'none', gap: 12 }}>
      <span className="tic" aria-hidden="true">
        <Icon className="ic" />
      </span>
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>{label}</p>
        <p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--faint)' }}>{hint}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} hideLabel />
    </div>
  );
}

interface PlusMenuBodyProps {
  onUpload: () => void;
  onPlanMode: () => void;
  onGoals: () => void;
  onTodos: () => void;
  onSlash: () => void;
  onStudio: () => void;
  onWorkspace?: () => void;
  goalRunning: boolean;
  goalsOpen: boolean;
  workspaceLabel?: string;
  showWorkspace: boolean;
}

function PlusMenuBody({
  onUpload,
  onPlanMode,
  onGoals,
  onTodos,
  onSlash,
  onStudio,
  onWorkspace,
  goalRunning,
  goalsOpen,
  workspaceLabel,
  showWorkspace,
}: PlusMenuBodyProps) {
  return (
    <>
      <PlusMenuRow icon={Paperclip} label="Upload files" hint="Images, code, text · or drop / paste" onClick={onUpload} />
      <PlusMenuRow icon={Waypoints} label="Plan mode" hint="Insert /plan" onClick={onPlanMode} />
      <PlusMenuRow
        icon={Target}
        label="Goals & plans"
        hint="Goals, plans & todos"
        onClick={onGoals}
        dot={goalRunning}
        active={goalsOpen}
      />
      <PlusMenuRow icon={ListTodo} label="Todos" hint="Standalone todos (no goal)" onClick={onTodos} />
      <PlusMenuRow icon={ListFilter} label="Slash command" hint="Browse all commands" onClick={onSlash} />
      <PlusMenuRow icon={Wand2} label="Generate image" hint="Open Image Studio" onClick={onStudio} />
      {showWorkspace && onWorkspace ? (
        <PlusMenuRow
          icon={FolderOpen}
          label="Pick workspace"
          hint={workspaceLabel ?? 'Choose where the agent works'}
          onClick={onWorkspace}
        />
      ) : null}
    </>
  );
}

function PlusMenuRow({
  icon: Icon,
  label,
  hint,
  onClick,
  dot,
  active,
}: {
  icon: typeof Code2;
  label: string;
  hint: string;
  onClick: () => void;
  dot?: boolean;
  active?: boolean;
}) {
  return (
    <button type="button" role="menuitem" data-plus-item onClick={onClick} className={cx('mi', active && 'on')}>
      <Icon className="ic" style={{ color: 'var(--muted)' }} aria-hidden="true" />
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <b style={{ fontWeight: 500, color: 'rgb(var(--c-ink))' }}>{label}</b>
          {dot ? (
            <span className="livechip" style={{ display: 'inline-flex', height: 'auto', padding: '0 4px', flex: 'none' }}>
              <span className="ld" />
            </span>
          ) : null}
        </div>
        <small>{hint}</small>
      </div>
    </button>
  );
}


/**
 * Context usage ring inside the input panel's toolbar.
 */
function ContextChip({ streaming }: { streaming: boolean }) {
  const activeConversation = useStore((state) => state.activeConversation());
  const model = useStore((state) => state.model);
  const modelMetaMap = useStore((state) => state.modelMeta);
  const settings = useEffectiveSettings();
  const [open, setOpen] = useState(false);
  const contextButtonRef = useRef<HTMLButtonElement>(null);
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
  const modelMetaInfo = model ? lookupModelMeta(modelMetaMap, model) : undefined;
  const conversation = throttledConversation ?? activeConversation;
  const breakdown = useMemo(
    () => (conversation ? contextBreakdown(conversation, modelMetaInfo) : null),
    [conversation, modelMetaInfo],
  );
  const reasoning = useMemo(
    () => (conversation ? reasoningFootprint(conversation) : null),
    [conversation],
  );
  if (!activeConversation || !breakdown || !reasoning) return null;
  const fmt = (value: number): string => Math.round(value).toLocaleString('id-ID');
  const ratio =
    breakdown.effectiveLimit && breakdown.effectiveLimit > 0
      ? Math.min(breakdown.activeTokens / breakdown.effectiveLimit, 1)
      : null;
  const pct = ratio !== null ? Math.round(ratio * 100) : null;
  const hot = ratio !== null && ratio >= 0.95;
  const denom = breakdown.effectiveLimit && breakdown.effectiveLimit > 0 ? breakdown.effectiveLimit : Math.max(1, breakdown.activeTokens);
  const bucketPct = (tokens: number): number => Math.min(100, Math.max(0, (tokens / denom) * 100));
  const fmtK = (value: number): string => {
    if (value < 1000) return String(Math.round(value));
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  };

  const applyTrim = (): void => {
    const state = useStore.getState();
    const conversation = state.activeConversation();
    if (!conversation) return;
    state.trimReasoning(conversation.id);
    setConfirmTrim(false);
  };

  return (
    <div className="cc-ctx" style={{ position: 'relative' }} data-context-popover>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={contextButtonRef}
        label="Context usage"
        role="dialog"
        placement="bottom-end"
        width={300}
      >
        <div className="cx">
          <div className="cx-top">
            <b>{pct !== null ? `${pct}%` : fmtK(breakdown.activeTokens)}</b>
            <span>
              {breakdown.effectiveLimit
                ? `${fmt(breakdown.activeTokens)} / ${fmt(breakdown.effectiveLimit)} tokens`
                : `${fmt(breakdown.activeTokens)} tokens`}
            </span>
          </div>
          <div className="cbar2">
            <i className="s1" style={{ width: `${bucketPct(breakdown.systemTokens)}%` }} />
            <i className="s2" style={{ width: `${bucketPct(breakdown.toolsTokens)}%` }} />
            <i className="s3" style={{ width: `${bucketPct(breakdown.outputTokens)}%` }} />
            <i className="s4" style={{ width: `${bucketPct(breakdown.reasoningTokens)}%` }} />
            {settings.autoCompact ? (
              <span
                className="mk"
                style={{ left: `${Math.min(100, Math.max(0, settings.compactThresholdRatio * 100))}%` }}
              />
            ) : null}
          </div>
          <div className="crow2">
            <i className="dot s1" />
            <span>System prompt</span>
            <b>{fmtK(breakdown.systemTokens)}</b>
          </div>
          <div className="crow2">
            <i className="dot s2" />
            <span>Tool definitions</span>
            <b>{fmtK(breakdown.toolsTokens)}</b>
          </div>
          <div className="crow2">
            <i className="dot s3" />
            <span>Messages</span>
            <b>{fmtK(breakdown.outputTokens)}</b>
          </div>
          <div className="crow2">
            <i className="dot s4" />
            <span>Reasoning</span>
            <b>{fmtK(breakdown.reasoningTokens)}</b>
          </div>
          <div className="cx-f">
            {settings.autoCompact
              ? `Auto-compact at ${Math.round(settings.compactThresholdRatio * 100)}%.`
              : breakdown.limitSource === 'manual'
                ? 'Limit: manually lowered below the model capacity.'
                : breakdown.limitSource === 'fallback'
                  ? 'Limit: assumed 256K — no models.dev metadata for this model.'
                  : breakdown.effectiveLimit
                    ? 'Limit: the model built-in capacity (models.dev).'
                    : 'Limit: unknown — no models.dev metadata for this model.'}
          </div>
          {reasoning.turns > 0 ? (
            <div style={{ marginTop: 8 }}>
              {confirmTrim ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 11.5, lineHeight: 1.375, color: 'var(--muted)' }}>
                    Trim all reasoning in this chat?
                  </span>
                  <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 4 }}>
                    <button
                      type="button"
                      onClick={() => setConfirmTrim(false)}
                      style={{ borderRadius: 6, padding: '2px 6px', fontSize: 11.5, color: 'var(--faint)' }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={applyTrim}
                      style={{ borderRadius: 6, background: 'rgb(var(--c-danger) / 0.1)', padding: '2px 6px', fontSize: 11.5, fontWeight: 500, color: 'rgb(var(--c-danger))' }}
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
                  style={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: 6,
                    borderRadius: 6,
                    padding: '4px 6px',
                    textAlign: 'left',
                    fontSize: 12,
                    color: 'var(--muted)',
                    opacity: streaming ? 0.5 : 1,
                    cursor: streaming ? 'not-allowed' : undefined,
                  }}
                >
                  <Eraser className="ic" aria-hidden="true" />
                  <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Trim reasoning</span>
                  <span style={{ fontFamily: 'var(--f-mono)', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--faint)' }}>~{fmt(reasoning.tokens)}</span>
                </button>
                </Tip>
              )}
            </div>
          ) : null}
        </div>
      </Popover>

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        ref={contextButtonRef}
        aria-label="Context usage details"
        className="ib"
      >
        <svg
          viewBox="0 0 16 16"
          className={cx('ring', hot && 'hot')}
          aria-hidden="true"
        >
          <circle className="trk" cx="8" cy="8" r="6" />
          {}
          <circle
            className="arc"
            cx="8"
            cy="8"
            r="6"
            pathLength={100}
            style={{ '--p': ratio !== null ? ratio * 100 : 0 } as React.CSSProperties}
          />
        </svg>
      </button>
    </div>
  );
}


