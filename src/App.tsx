import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { AgentPermissionDialog } from './components/AgentPermissionDialog';
import { AgentAskUserDialog } from './components/AgentAskUserDialog';
import { CheckpointRail } from './components/CheckpointRail';
import { Composer } from './components/Composer';
import { AddonWidgetHost } from './components/AddonWidgetHost';
import { GoalsPanel } from './components/GoalsPanel';
import { Sidebar } from './components/Sidebar';
import { Thread } from './components/Thread';
import type { ThreadNavigation } from './components/Thread';
import { TopBar } from './components/TopBar';
import { attachmentRefWireUrl, pickNativeWorkspace, sendReminderPreset, steerWithParts } from './lib/api';
import { useChatController } from './hooks/useChatController';
import { isProviderConfigured } from './lib/providerStatus';
import { bootConversationSync, useStore } from './store/useStore';
import { LazyViewBoundary, LazyViewFallback, cx } from './components/ui';
import type { TurnAttachment } from './types';

const LazyProvidersDialog = lazy(() =>
  import('./components/ProvidersDialog').then((m) => ({ default: m.ProvidersDialog })),
);
const LazySettingsPanel = lazy(() =>
  import('./components/SettingsPanel').then((m) => ({ default: m.SettingsPanel })),
);
const LazySettingsDialog = lazy(() =>
  import('./components/SettingsDialog').then((m) => ({ default: m.SettingsDialog })),
);
const LazyImageStudio = lazy(() =>
  import('./components/ImageStudio').then((m) => ({ default: m.ImageStudio })),
);
const LazyDashboardView = lazy(() =>
  import('./components/DashboardView').then((m) => ({ default: m.DashboardView })),
);
const LazyHistoryView = lazy(() =>
  import('./components/HistoryView').then((m) => ({ default: m.HistoryView })),
);
const LazyImageHistoryView = lazy(() =>
  import('./components/ImageHistoryView').then((m) => ({ default: m.ImageHistoryView })),
);
const LazyGallery = lazy(() =>
  import('./components/Gallery').then((m) => ({ default: m.Gallery })),
);
const LazyExplore = lazy(() =>
  import('./components/Explore').then((m) => ({ default: m.Explore })),
);
const LazyProjectTreePanel = lazy(() =>
  import('./components/ProjectTreePanel').then((m) => ({ default: m.ProjectTreePanel })),
);
const LazyAddonPanel = lazy(() =>
  import('./components/AddonPanel').then((m) => ({ default: m.AddonPanel })),
);
const LazyDiffPanel = lazy(() =>
  import('./components/DiffPanel').then((m) => ({ default: m.DiffPanel })),
);

/**
 * Drag-to-resize handle between two layout columns. A 6px hit zone (1px
 * visible line, wider on hover) — pointer events with setPointerCapture so a
 * drag that leaves the strip keeps tracking. Widths persist to the device
 * ui-state on release. Double-click resets to the default.
 */
function ResizeHandle({
  side,
  value,
  min,
  max,
  defaultValue,
  onResize,
  onCommit,
}: {
  /** Which edge the panel is on: the handle math flips per side. */
  side: 'left' | 'right';
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  /** Live updates during the drag (store-only — cheap, every pointermove). */
  onResize: (width: number) => void;
  /** Persisted ONCE on release (and on double-click reset) — never per move. */
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ startClientX: number; startWidth: number } | null>(null);
  const latest = useRef(value);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { startClientX: event.clientX, startWidth: value };
    latest.current = value;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = event.clientX - drag.current.startClientX;
    const next = side === 'left' ? drag.current.startWidth + delta : drag.current.startWidth - delta;
    const clamped = Math.max(min, Math.min(max, Math.round(next)));
    latest.current = clamped;
    onResize(clamped);
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit(latest.current);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} panel`}
      className={cx(
        'group relative z-10 hidden w-1.5 shrink-0 cursor-col-resize md:block',
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => {
        onResize(defaultValue);
        onCommit(defaultValue);
      }}
    />
  );
}

/**
 * Application shell.
 *
 * Layout is a three-column desktop workspace (rail, workspace, run settings).
 * Below `md` the rail becomes a left drawer and below `lg` the settings panel
 * becomes a right drawer, so both stay reachable on phones instead of being
 * hidden with the thread left squeezed.
 */
export default function App() {
  const loadProviders = useStore((state) => state.loadProviders);
  const view = useStore((state) => state.view);
  const theme = useStore((state) => state.theme);
  const settingsOpen = useStore((state) => state.settingsOpen);
  const toggleSettings = useStore((state) => state.toggleSettings);
  /** 6B: what the right dock shows — Configuration or the docked Tree. */
  const rightPanelMode = useStore((state) => state.rightPanelMode);
  const [settingsEverOpened, setSettingsEverOpened] = useState(false);
  const [settingsPanelReady, setSettingsPanelReady] = useState(false);
  useEffect(() => {
    if (!settingsOpen) return;
    setSettingsEverOpened(true);
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setSettingsPanelReady(true));
    });
    return () => cancelAnimationFrame(raf);
  }, [settingsOpen]);
  const sidebarCollapsed = useStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useStore((state) => state.toggleSidebar);
  const sidebarWidth = useStore((state) => state.sidebarWidth);
  const setSidebarWidth = useStore((state) => state.setSidebarWidth);
  const settingsWidth = useStore((state) => state.settingsWidth);
  const setSettingsWidth = useStore((state) => state.setSettingsWidth);
  const diffDockWidth = useStore((state) => state.diffDockWidth);
  const setDiffDockWidth = useStore((state) => state.setDiffDockWidth);
  // DIFF DOCK: the split view auto-widens the dock (transient width — closing
  // the panel or switching tabs returns the dock to its normal width).
  const dockWidth = rightPanelMode === 'diff' ? diffDockWidth : settingsWidth;
  const fontScale = useStore((state) => state.fontScale);
  const contextScale = useStore((state) => state.contextScale);

  const dismissSettings = useCallback(() => {
    if (window.matchMedia('(min-width: 1024px)').matches) return;
    if (useStore.getState().settingsOpen) toggleSettings();
  }, [toggleSettings]);

  useEffect(() => {
    if (!settingsOpen) return;
    if (window.matchMedia('(min-width: 1024px)').matches) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissSettings();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [settingsOpen, dismissSettings]);
  const activeConversation = useStore((state) => state.activeConversation());
  const activeConversationId = activeConversation?.id ?? null;
  const providerId = useStore((state) => state.providerId);
  const model = useStore((state) => state.model);
  const providers = useStore((state) => state.providers);
  const showNotice = useStore((state) => state.showNotice);
  const activeAgentWorkspaceId = useStore((state) => state.activeAgentWorkspaceId);
  const loadTreeView = useStore((state) => state.loadTreeView);
  useEffect(() => {
    void loadTreeView(activeAgentWorkspaceId);
  }, [loadTreeView, activeAgentWorkspaceId]);

  useEffect(() => {
    // P5 BUGFIX: model metadata (models.dev, 261 KB) was moved off the boot
    void useStore.getState().ensureModelMeta();
  }, []);

  const { send, stop, regenerate, regenerateFrom, compactNow } = useChatController();
  const handleEditTurn = useCallback((turnId: string, content: string) => {
    const conversation = useStore.getState().activeConversation();
    if (conversation) useStore.getState().updateTurn(conversation.id, turnId, { content });
  }, []);
  const handleBranchTurn = useCallback((turnId: string) => {
    const conversation = useStore.getState().activeConversation();
    if (conversation) useStore.getState().branchFromTurn(conversation.id, turnId);
  }, []);
  const handleDeleteTurn = useCallback((turnId: string) => {
    const conversation = useStore.getState().activeConversation();
    if (conversation) useStore.getState().deleteTurn(conversation.id, turnId);
  }, []);
  const genRunning = useStore((state) => state.genRunning);
  const streaming = Boolean(activeConversation && genRunning[activeConversation.id]);
  const anyGenerating = Object.keys(genRunning).length > 0;

  const [draft, setDraft] = useState('');
  const [providersOpen, setProvidersOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);

  /** TURN NAVIGATION — the composer band's arrows call INTO the thread's
   *  pin/glide owner (via onNavigationReady) instead of scrolling raw DOM. */
  const [turnNavigation, setTurnNavigation] = useState<ThreadNavigation | null>(null);
  const handleNavigationReady = useCallback((navigation: ThreadNavigation | null) => {
    setTurnNavigation(navigation);
  }, []);

  /** TURN CHECKPOINT RAIL — the ACTUAL turn numbers mounted in the scroller
   *  (windowing means they do not start at 1), read raf-throttled. State lives
   *  here because the rail overlays the scroller from outside it. */
  const [turnNumbers, setTurnNumbers] = useState<number[]>([]);
  const [activeTurn, setActiveTurn] = useState(1);
  const threadScrollerRef = useRef<HTMLDivElement>(null);
  /** Native scrollbar width (px) of the thread scroller (measured, not assumed). */
  const [scrollbarWidth, setScrollbarWidth] = useState(0);

  /**
   * NATIVE workspace pick: clicking the composer's folder button opens the
   * DEVICE'S OWN dialog (Windows Explorer via the local proxy's PowerShell)
   * and registers the selected folder as the active agent workspace. The
   * in-app explorer was removed — the native dialog is the only path.
   */
  const addAgentWorkspace = useStore((state) => state.addAgentWorkspace);
  const setActiveAgentWorkspace = useStore((state) => state.setActiveAgentWorkspace);
  const activeIdForPick = useStore((state) => state.activeId);
  const handlePickWorkspace = useCallback(async () => {
    try {
      const path = await pickNativeWorkspace();
      if (!path) return;
      const workspace = await addAgentWorkspace(path, undefined, activeIdForPick ?? undefined);
      await setActiveAgentWorkspace(workspace.id, activeIdForPick ?? undefined);
      showNotice('workspace.bound', { label: workspace.label });
    } catch (cause) {
      showNotice('workspace.pickFailed', undefined, cause instanceof Error ? { detail: cause.message } : undefined);
    }
  }, [addAgentWorkspace, setActiveAgentWorkspace, activeIdForPick, showNotice]);



  useEffect(() => {
    const timers: number[] = [];
    const defer = (fn: () => void, ms: number) => {
      timers.push(window.setTimeout(fn, ms));
    };
    void loadProviders();
    defer(() => void bootConversationSync(), 0);
    defer(() => {
      const state = useStore.getState();
      const activeId = state.activeId;
      if (!activeId) return;
      const conversation = state.conversations.find((entry) => entry.id === activeId);
      if (conversation?.turnsLoaded !== false) return;
      void state.hydrateConversation(activeId);
    }, 32);
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [loadProviders]);

  const activeConversationForBody = useStore((state) => state.activeConversation());
  const activeBodyLoaded = activeConversationForBody?.turnsLoaded !== false;
  useEffect(() => {
    if (!activeConversationId || activeBodyLoaded) return;
    void useStore.getState().hydrateConversation(activeConversationId);
  }, [activeConversationId, activeBodyLoaded]);

  const loadAgentWorkspaces = useStore((state) => state.loadAgentWorkspaces);
  useEffect(() => {
    void loadAgentWorkspaces(activeConversationId ?? undefined);
  }, [loadAgentWorkspaces, activeConversationId]);

  const loadGallery = useStore((state) => state.loadGallery);
  useEffect(() => {
    void loadGallery();
  }, [loadGallery]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar]);

  useEffect(() => {
    if (!navOpen && !settingsOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNavOpen(false);
        dismissSettings();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [navOpen, settingsOpen, dismissSettings]);

  useEffect(() => {
    const root = document.documentElement;
    const dark = theme !== 'light';
    root.classList.toggle('dark', dark);
    root.classList.toggle('mocha', theme === 'mocha');
    root.style.colorScheme = dark ? 'dark' : 'light';
  }, [theme]);

  const fontFamily = useStore((state) => state.fontFamily);
  useEffect(() => {
    document.documentElement.dataset.font = fontFamily;
  }, [fontFamily]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--app-zoom', String(fontScale));
    root.style.setProperty('--ctx-scale', String(contextScale));
  }, [fontScale, contextScale]);

  useEffect(() => {
    if (!anyGenerating) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [anyGenerating]);

  const provider = providers.find((entry) => entry.id === providerId);
  const configured = isProviderConfigured(provider);

  const blockedReason = !provider
    ? 'No provider selected — open Configuration to choose one.'
    : !configured
      ? `${provider.label} needs an API key. Add it in Configuration.`
      : !model
        ? 'No model selected — open Configuration to choose one.'
        : undefined;

  const handleSend = useCallback(
    (text: string, attachments?: TurnAttachment[]) => {
      const role = useStore.getState().composerRole ?? 'user';
      setDraft('');
      // SLASH COMMAND: /compact [focus] condenses now instead of sending.
      const slash = /^\/compact\b/i.exec(text.trim());
      if (slash && (!attachments || attachments.length === 0)) {
        const focus = text.trim().slice(slash[0].length).trim();
        void compactNow(focus || undefined);
        return;
      }
      void send(text, undefined, attachments, { role });
    },
    [send, compactNow],
  );

  /**
   * STEER: while a generation runs, the composer's button becomes Steer and
   * hands the draft to the LIVE stream's context instead of opening a new
   * turn. `false` means the run ended in the gap between typing and pressing
   * — the Composer keeps the text and the user is told, so nothing is lost.
   */
  const handleSteer = useCallback(
    (text: string, attachments?: TurnAttachment[]) => {
      // SLASH COMMAND mid-run: /compact schedules the compaction instead of
      // steering. The synthetic id only tells the Composer the draft was taken.
      const slash = /^\/compact\b/i.exec(text.trim());
      if (slash && (!attachments || attachments.length === 0)) {
        const focus = text.trim().slice(slash[0].length).trim();
        void compactNow(focus || undefined);
        return Promise.resolve({ id: 'compact' });
      }
      if (!activeConversation) return Promise.resolve({ id: null });
      const conversationId = activeConversation.id;
      // DSH-STYLE: the steer carries the same parts a normal send would —
      // text plus image/file attachments (attachments ride their stored ref
      // when one exists, otherwise the inline data URL).
      const parts: import('./lib/api').SteerClientPart[] = [];
      if (text.trim()) parts.push({ type: 'text', text: text.trim() });
      for (const attachment of attachments ?? []) {
        if (attachment.mime.startsWith('image/')) {
          const url = attachment.dataRef
            ? attachmentRefWireUrl(attachment.dataRef.hash, attachment.dataRef.mime)
            : attachment.dataUrl;
          if (url) parts.push({ type: 'image_url', image_url: { url } });
        } else {
          const data = attachment.dataRef
            ? attachmentRefWireUrl(attachment.dataRef.hash, attachment.dataRef.mime)
            : attachment.dataUrl;
          if (data) parts.push({ type: 'file', file: { filename: attachment.name, file_data: data } });
        }
      }
      if (parts.length === 0) return Promise.resolve({ id: null });
      return steerWithParts(conversationId, parts).then((result) => {
        if (result.id) {
          useStore.getState().addPendingSteerParts(conversationId, result.id, parts);
        }
        return result;
      });
    },
    [activeConversation],
  );

  /**
   * SEND REMINDER — the manual counterpart of the automatic e2e classifier:
   * one click pushes the server-owned Writing-Rules reminder into the running
   * generation's context. The bubble shows a fixed label, not the full text.
   */
  const handleSendReminder = useCallback((): Promise<
    { id: string | null } | import('./lib/api').SteerFailure
  > => {
    if (!activeConversation) return Promise.resolve({ id: null, reason: 'not_streaming' });
    const conversationId = activeConversation.id;
    return sendReminderPreset(conversationId, 'writingRules').then(
      (result): { id: string | null } | import('./lib/api').SteerFailure => {
        if (result.id) {
          useStore.getState().addPendingSteer(
            conversationId,
            result.id,
            'SYSTEM REMINDER — Writing Rules (manual reminder from the user).',
          );
          useStore.getState().showNotice('run.reminderQueued');
        } else if ('reason' in result && result.reason === 'not_streaming') {
          useStore.getState().showNotice('run.steeredAsNew');
        } else {
          // A real failure (old server without preset support, network drop, …)
          // must not be dressed up as "the run just finished".
          useStore.getState().showNotice('run.steerFailed', undefined, {
            detail: ('detail' in result && result.detail) || 'HTTP error',
          });
        }
        return result;
      },
    );
  }, [activeConversation]);

  const turns = activeConversation?.turns ?? [];
  const hasThread = turns.length > 0;

  /** Checkpoint rail: pin it at the native scrollbar's left edge. Measuring
   *  (offsetWidth - clientWidth) keeps the overlay exact across browsers/zoom. */
  useEffect(() => {
    const el = threadScrollerRef.current;
    if (!el) return;
    const sync = () => setScrollbarWidth(el.offsetWidth - el.clientWidth);
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [view, hasThread]);

  /** Rail measurement: read the turn rows straight off the thread scroller
   *  (raf-throttled) so markers and arrows share one source of truth. */
  useEffect(() => {
    const scroller = threadScrollerRef.current;
    if (!scroller || !hasThread) {
      setTurnNumbers([]);
      return;
    }
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      scrollTimer = null;
      const rows = scroller.querySelectorAll<HTMLElement>('[data-turn]');
      if (rows.length === 0) {
        setTurnNumbers((previous) => (previous.length === 0 ? previous : []));
        return;
      }
      // Build turn-number list from attributes only — no layout reads
      const numbers: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        const value = Number(rows[i].dataset.turn);
        if (Number.isFinite(value)) numbers.push(value);
      }
      setTurnNumbers((previous) =>
        previous.length === numbers.length && previous.every((value, index) => value === numbers[index])
          ? previous
          : numbers,
      );
      // Binary search: find last row whose top ≤ pivot — O(log n) layout reads
      const scrollerTop = scroller.getBoundingClientRect().top;
      const pivot = scrollerTop + scroller.clientHeight * 0.35;
      let low = 0, high = rows.length, current = numbers[0] ?? 1;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (rows[mid].getBoundingClientRect().top > pivot) high = mid;
        else {
          const value = Number(rows[mid].dataset.turn);
          if (Number.isFinite(value)) current = value;
          low = mid + 1;
        }
      }
      setActiveTurn((previous) => (previous === current ? previous : current));
    };
    const onScroll = () => {
      if (scrollTimer === null) scrollTimer = setTimeout(measure, 500);
    };
    const onScrollEnd = () => {
      if (scrollTimer !== null) { clearTimeout(scrollTimer); scrollTimer = null; }
      measure();
    };
    measure();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('scrollend', onScrollEnd, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    const inner = scroller.firstElementChild;
    if (inner) observer.observe(inner);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('scrollend', onScrollEnd);
      observer.disconnect();
      if (scrollTimer !== null) clearTimeout(scrollTimer);
    };
  }, [hasThread, activeConversation?.id, turns.length, settingsOpen]);

  const turnCount = turnNumbers.length;

  const THREAD_BOTTOM_PAD = 16;

  const title =
    view === 'history'
      ? 'History'
      : view === 'imagehistory'
        ? 'Image History'
        : view === 'dashboard'
        ? 'Dashboard'
        : view === 'gallery'
          ? 'Gallery'
          : view === 'imagestudio'
            ? 'Image Studio'
            : activeConversation
              ? activeConversation.title
              : 'Playground';

  return (
    <div className="flex h-full w-full overflow-hidden bg-canvas">
      {}
      <a
        href="#workspace"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-elevated focus:px-3 focus:py-2 focus:text-sm focus:text-ink"
      >
        Skip to content
      </a>

      {}
      <div className="hidden md:flex">
        <div
          className={`fold${sidebarCollapsed ? '' : ' fold-open'}`}
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
          aria-hidden={sidebarCollapsed}
        >
          <Sidebar
            width={sidebarWidth}
            onOpenProviders={() => setProvidersOpen(true)}
            onOpenSettings={() => setPrefsOpen(true)}
          />
        </div>
        {!sidebarCollapsed ? (
          <ResizeHandle
            side="left"
            value={sidebarWidth}
            min={200}
            max={420}
            defaultValue={248}
            onResize={setSidebarWidth}
            onCommit={useStore.getState().commitSidebarWidth}
          />
        ) : null}
      </div>

      {}
      {navOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="animate-fade-in absolute inset-0 bg-black/60"
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
          <div className="drawer-slide-left absolute inset-y-0 left-0 w-[248px] shadow-popover">
            <Sidebar
              onOpenProviders={() => setProvidersOpen(true)}
              onOpenSettings={() => setPrefsOpen(true)}
              onNavigate={() => setNavOpen(false)}
            />
          </div>
        </div>
      ) : null}

      {}
      {settingsOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="animate-fade-in absolute inset-0 bg-black/60"
            onClick={dismissSettings}
            aria-hidden="true"
          />
          <div className="drawer-slide-right absolute inset-y-0 right-0 w-[min(320px,88vw)] shadow-popover">
            <Suspense fallback={null}>
              {/* key → remount on mode switch, replaying the dock-panel-in
                  transition (slide+fade) between Config / Tree / Addons. */}
              <div key={rightPanelMode} className="dock-panel-in h-full">
                {rightPanelMode === 'tree' ? (
                  <LazyProjectTreePanel />
                ) : rightPanelMode === 'addons' ? (
                  <LazyAddonPanel />
                ) : rightPanelMode === 'diff' ? (
                  <LazyDiffPanel />
                ) : (
                  <LazySettingsPanel
                    onOpenProviders={() => setProvidersOpen(true)}
                    onNavigate={dismissSettings}
                    onClose={dismissSettings}
                  />
                )}
              </div>
            </Suspense>
          </div>
        </div>
      ) : null}

      {}
      <main
        id="workspace"
        className="my-5 ml-4 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hairline bg-elevated shadow-workspace"
      >
        <TopBar
          title={title}
          onOpenNav={() => setNavOpen(true)}
          onShare={() => {
            if (!activeConversation) {
              showNotice('share.nothing');
              return;
            }
            void navigator.clipboard
              ?.writeText(`${window.location.origin}/?chat=${activeConversation.id}`)
              .then(() => showNotice('share.copied'))
              .catch(() => showNotice('share.clipboardFailed'));
          }}
        />

        {}
        {view === 'imagestudio' ? (
          <Suspense fallback={<LazyViewFallback label="Image Studio" />}>
            <LazyImageStudio />
          </Suspense>
        ) : (
          <>
            {view === 'playground' && hasThread ? (
              <div className="ctx-zoom flex min-h-0 flex-1 flex-col">
                {}
                {/* Thread column + TURN CHECKPOINT RAIL. The rail is an ABSOLUTE
                    overlay pinned at right = measured scrollbar width, so it
                    sits BETWEEN the conversation and the scrollbar while the
                    thread column keeps its full width — nothing is pushed or
                    shifted. pointer-events-none on the rail (auto on each
                    marker) keeps the content underneath clickable. */}
                <div className="relative flex min-h-0 flex-1">
                  <div
                    ref={threadScrollerRef}
                    className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable]"
                  >
                  {/* NOTE: deliberately NO key on Thread. A key by conversation
                      id forced Thread to UNMOUNT-REMMOUNT mid-reload — activeId
                      starts undefined and resolves once boot reconcile lands,
                      so the resume replay (which refills the trailing turn)
                      lost continuity and the thread froze mid-generation. The
                      stale-switch problem this key "fixed" was really main-
                      thread starvation from the dead `conversations`
                      subscription in useChatController, which is now gone, so
                      useDeferredValue's switch render lands within a frame or
                      two without any remount. */}
                  <Thread
                    turns={turns}
                    streaming={streaming}
                    compaction={activeConversation?.compaction}
                    bottomPad={THREAD_BOTTOM_PAD}
                    onRegenerate={regenerate}
                    onEditTurn={handleEditTurn}
                    onRegenerateFrom={regenerateFrom}
                    onBranchTurn={handleBranchTurn}
                    onDeleteTurn={handleDeleteTurn}
                    onNavigationReady={handleNavigationReady}
                  />
                  </div>
                  {turnCount > 0 && (
                    <CheckpointRail
                      turnNumbers={turnNumbers}
                      activeTurn={activeTurn}
                      onJumpToTurn={(turn) => turnNavigation?.toTurn(turn)}
                      rightOffset={scrollbarWidth}
                    />
                  )}
                </div>
                <div className="shrink-0">
                  {/* FASE 5 — addon render site: composer-band widgets above the composer */}
                  <AddonWidgetHost site="composer-band" streaming={streaming} />
                  <Composer
                    draft={draft}
                    onDraftChange={setDraft}
                    onSend={handleSend}
                    onStop={stop}
                    streaming={streaming}
                    blockedReason={blockedReason}
                    onPickWorkspace={handlePickWorkspace}
                    onToggleGoals={() => setGoalsOpen((value) => !value)}
                    goalsOpen={goalsOpen}
                    onSteer={handleSteer}
                    onSendReminder={handleSendReminder}
                    onNavigateFirstTurn={() => turnNavigation?.toFirstTurn()}
                    onNavigateLatest={() => turnNavigation?.toLatest()}
                  />
                </div>
              </div>
            ) : (
              <>
                {}
                <div className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable]">
                  {view === 'history' ? (
                    <LazyViewBoundary label="History">
                      <Suspense fallback={<LazyViewFallback label="History" />}>
                        <LazyHistoryView />
                      </Suspense>
                    </LazyViewBoundary>
                  ) : view === 'dashboard' ? (
                    <LazyViewBoundary label="Dashboard">
                      <Suspense fallback={<LazyViewFallback label="Dashboard" />}>
                        <LazyDashboardView onOpenProviders={() => setProvidersOpen(true)} />
                      </Suspense>
                    </LazyViewBoundary>
                  ) : view === 'gallery' ? (
                    <LazyViewBoundary label="Gallery">
                      <Suspense fallback={<LazyViewFallback label="Gallery" />}>
                        <LazyGallery />
                      </Suspense>
                    </LazyViewBoundary>
                  ) : view === 'imagehistory' ? (
                    <LazyViewBoundary label="Image History">
                      <Suspense fallback={<LazyViewFallback label="Image History" />}>
                        <LazyImageHistoryView />
                      </Suspense>
                    </LazyViewBoundary>
                  ) : hasThread ? (
                    <div className="ctx-zoom">
                      <Thread
                        turns={turns}
                        streaming={streaming}
                        compaction={activeConversation?.compaction}
                        bottomPad={THREAD_BOTTOM_PAD}
                        onRegenerate={regenerate}
                        onEditTurn={handleEditTurn}
                        onRegenerateFrom={regenerateFrom}
                        onBranchTurn={handleBranchTurn}
                        onDeleteTurn={handleDeleteTurn}
                      />
                    </div>
                  ) : (
                    <div className="ctx-zoom">
                      <Suspense fallback={null}>
                        <LazyExplore>
                          <Composer
                          draft={draft}
                          onDraftChange={setDraft}
                          onSend={handleSend}
                          onStop={stop}
                          streaming={streaming}
                          blockedReason={blockedReason}
                          variant="centered"
                          onPickWorkspace={handlePickWorkspace}
                          onToggleGoals={() => setGoalsOpen((value) => !value)}
                          goalsOpen={goalsOpen}
                          onSteer={handleSteer}
                          onSendReminder={handleSendReminder}
                        />
                        </LazyExplore>
                      </Suspense>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </main>


      {}
      {settingsEverOpened ? (
        <div className="hidden lg:flex">
          {settingsOpen && settingsPanelReady ? (
            <ResizeHandle
              side="right"
              value={dockWidth}
              min={rightPanelMode === 'diff' ? 560 : 260}
              max={rightPanelMode === 'diff' ? 1600 : 480}
              defaultValue={rightPanelMode === 'diff' ? 760 : 300}
              onResize={rightPanelMode === 'diff' ? setDiffDockWidth : setSettingsWidth}
              onCommit={
                rightPanelMode === 'diff'
                  ? // G3: persisted on release — refresh keeps the dragged width.
                    useStore.getState().commitDiffDockWidth
                  : useStore.getState().commitSettingsWidth
              }
            />
          ) : null}
          <div
            className={`fold${settingsOpen && settingsPanelReady ? ' fold-open' : ''}`}
            style={{ width: settingsOpen && settingsPanelReady ? dockWidth + 16 : 0 }}
            aria-hidden={!settingsOpen}
          >
            <Suspense fallback={null}>
              {/* key → remount on mode switch, replaying the dock-panel-in
                  transition (slide+fade) between Config / Tree / Addons / Diff.
                  h-full: the panel's own height is calc(100%-2.5rem), which
                  collapses without a definite-height ancestor — and with it,
                  the panel's internal scroll chain. */}
              <div key={rightPanelMode} className="dock-panel-in h-full">
                {rightPanelMode === 'tree' ? (
                  <LazyProjectTreePanel width={dockWidth} />
                ) : rightPanelMode === 'addons' ? (
                  <LazyAddonPanel width={dockWidth} />
                ) : rightPanelMode === 'diff' ? (
                  <LazyDiffPanel width={dockWidth} />
                ) : (
                  <LazySettingsPanel
                    width={dockWidth}
                    onOpenProviders={() => setProvidersOpen(true)}
                  />
                )}
              </div>
            </Suspense>
          </div>
        </div>
      ) : null}
      {}
      {providersOpen ? (
        <Suspense fallback={null}>
          <LazyProvidersDialog open onClose={() => setProvidersOpen(false)} />
        </Suspense>
      ) : null}
      {prefsOpen ? (
        <Suspense fallback={null}>
          <LazyViewBoundary label="Settings">
            <LazySettingsDialog open onClose={() => setPrefsOpen(false)} />
          </LazyViewBoundary>
        </Suspense>
      ) : null}
      {goalsOpen ? (
        <Suspense fallback={null}>
          <GoalsPanel open onClose={() => setGoalsOpen(false)} />
        </Suspense>
      ) : null}
      <AgentPermissionDialog />
      <AgentAskUserDialog />
      {/* FASE 5 — addon render site: floating overlay widgets (tetris, etc.) */}
      <AddonWidgetHost site="floating" streaming={streaming} />
    </div>
  );
}
