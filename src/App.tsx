import { useCallback, useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from 'react';
import { AgentPermissionDialog } from './components/AgentPermissionDialog';
import { AgentAskUserDialog } from './components/AgentAskUserDialog';
import { AgentOperatorGateDialog } from './components/AgentOperatorGateDialog';
import { CheckpointRail } from './components/CheckpointRail';
import { Composer } from './components/Composer';
import { AddonWidgetHost } from './components/AddonWidgetHost';
import { AddonNotificationHost } from './components/AddonNotificationHost';
import { GoalsPanel } from './components/GoalsPanel';
import { TodoPanel } from './components/TodoPanel';
import { Sidebar } from './components/Sidebar';
import { Thread } from './components/Thread';
import type { ThreadNavigation } from './components/Thread';
import { TopBar } from './components/TopBar';
import { attachmentRefWireUrl, pickNativeWorkspace, sendReminderPreset, steerWithParts } from './lib/api';
import { useChatController } from './hooks/useChatController';
import { isProviderConfigured } from './lib/providerStatus';
import { brandCatHeadSvgUrl } from './lib/brandAssets';
import { applyAppearance, isMotionReduced } from './lib/appearance';
import { bootConversationSync, useEffectiveSettings, useStore } from './store/useStore';
import { LazyViewBoundary, LazyViewFallback, Modal } from './components/ui';
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
const LazyDiffPanel = lazy(() =>
  import('./components/DiffPanel').then((m) => ({ default: m.DiffPanel })),
);
const LazyAddonViewHost = lazy(() =>
  import('./components/AddonViewHost').then((m) => ({ default: m.AddonViewHost })),
);
const LazyAddonHub = lazy(() =>
  import('./components/AddonHub').then((m) => ({ default: m.AddonHub })),
);
const LazyAddonDockShortcut = lazy(() =>
  import('./components/AddonDockPanel').then((m) => ({ default: m.AddonDockPanel })),
);


function ResizeHandle({
  side,
  value,
  min,
  max,
  defaultValue,
  onResize,
  onCommit,
}: {
  side: 'left' | 'right';
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ startClientX: number; startWidth: number } | null>(null);
  const latest = useRef(value);

  useEffect(() => () => document.body.classList.remove('resizing'), []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { startClientX: event.clientX, startWidth: value };
    latest.current = value;
    document.body.classList.add('resizing');
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
    document.body.classList.remove('resizing');
    event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit(latest.current);
  };
  const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('resizing');
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} panel`}
      className="resizer"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
        if (!step && event.key !== 'Home') return;
        event.preventDefault();
        const next =
          event.key === 'Home'
            ? defaultValue
            : Math.max(min, Math.min(max, latest.current + (side === 'left' ? step : -step)));
        latest.current = next;
        onResize(next);
        onCommit(next);
      }}
      onDoubleClick={() => {
        onResize(defaultValue);
        onCommit(defaultValue);
      }}
    />
  );
}


export default function App() {
  const loadProviders = useStore((state) => state.loadProviders);
  const view = useStore((state) => state.view);
  const theme = useStore((state) => state.theme);
  const accent = useStore((state) => state.accent);
  const density = useStore((state) => state.density);
  const ambient = useStore((state) => state.ambient);
  const reduceMotion = useStore((state) => state.reduceMotion);
  const fontFamily = useStore((state) => state.fontFamily);
  const pendingConfirmDelete = useStore((state) => state.pendingConfirmDelete);
  const confirmPendingDelete = useStore((state) => state.confirmPendingDelete);
  const cancelPendingDelete = useStore((state) => state.cancelPendingDelete);
  const pendingDeleteTitle = useStore(
    (state) =>
      state.conversations.find((entry) => entry.id === state.pendingConfirmDelete)?.title ??
      'this chat',
  );
  const settingsOpen = useStore((state) => state.settingsOpen);
  const toggleSettings = useStore((state) => state.toggleSettings);
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
  const chatSettings = useEffectiveSettings();
  const sidebarWidth = useStore((state) => state.sidebarWidth);
  const setSidebarWidth = useStore((state) => state.setSidebarWidth);
  const settingsWidth = useStore((state) => state.settingsWidth);
  const setSettingsWidth = useStore((state) => state.setSettingsWidth);
  const diffDockWidth = useStore((state) => state.diffDockWidth);
  const setDiffDockWidth = useStore((state) => state.setDiffDockWidth);
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
  const agentWorkspaces = useStore((state) => state.agentWorkspaces);
  const workspaceTargetId = activeConversation?.workspaceId ?? (activeConversation ? null : activeAgentWorkspaceId);
  const workspaceLabel = workspaceTargetId
    ? agentWorkspaces.find((workspace) => workspace.id === workspaceTargetId)?.label
    : undefined;
  const loadTreeView = useStore((state) => state.loadTreeView);
  useEffect(() => {
    void loadTreeView(activeAgentWorkspaceId);
  }, [loadTreeView, activeAgentWorkspaceId]);

  useEffect(() => {
    void useStore.getState().ensureModelMeta();
  }, []);

  const { send, stop, stopRun, regenerate, regenerateFrom, compactNow } = useChatController();

  
  useEffect(() => {
    const onDispatchAgent = async (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        providerId: string; model: string; agentId: string; agentName: string;
        questId: string; questTitle: string; prompt: string; thinkingLevel?: string;
      };
      const store = useStore.getState();
      const host = store.activeConversation();
      const workspaceId = host?.workspaceId ?? undefined;

      const conversationId = host?.councilId
        ? ensureCouncilSubSession(detail)
        : (() => {
            const id = store.newConversation({
              providerId: detail.providerId,
              model: detail.model,
              ...(workspaceId ? { workspaceId } : {}),
            });
            store.patchConversation(id, { title: `${detail.agentName} · ${detail.questId}` });
            return id;
          })();
      if (!conversationId) return;
      applyAgentSessionSettings(conversationId, detail.thinkingLevel);
      await bindAgentSessionRpc(detail.agentId, conversationId, detail.questId);
      void send(detail.prompt, conversationId);
    };
    window.addEventListener('moriko:dispatch-agent', onDispatchAgent as EventListener);
    return () => window.removeEventListener('moriko:dispatch-agent', onDispatchAgent as EventListener);
  }, [send]);

  
  function ensureCouncilSubSession(agent: {
    agentId: string; agentName: string; providerId: string; model: string; questId?: string;
  }): string | null {
    const store = useStore.getState();
    const host = store.activeConversation();
    const councilId = host?.councilId;
    if (!councilId || !host) return null;
    const existing = store.conversations.find(
      (entry) => entry.councilId === councilId && entry.councilRole === 'sub' && entry.councilAgentId === agent.agentId,
    );
    if (existing) return existing.id;
    const subId = store.newConversation({
      providerId: agent.providerId || undefined,
      model: agent.model || undefined,
      workspaceId: host.workspaceId,
      councilId,
      councilRole: 'sub',
      councilAgentId: agent.agentId,
    });
    store.patchConversation(subId, { title: agent.questId ? `${agent.agentName} · ${agent.questId}` : `${agent.agentName} · council` });
    return subId;
  }

  
  function applyAgentSessionSettings(conversationId: string, thinkingLevel?: string): void {
    const fresh = useStore.getState().conversations.find((entry) => entry.id === conversationId);
    if (!fresh) return;
    useStore.getState().patchConversation(conversationId, {
      settings: {
        ...fresh.settings,
        agentMode: true,
        ...(thinkingLevel ? { thinkingLevel: thinkingLevel as typeof fresh.settings.thinkingLevel } : {}),
      },
    });
  }

  
  async function bindAgentSessionRpc(agentId: string, sessionId: string, questId: string): Promise<void> {
    try {
      const res = await fetch('/api/addons/rsat/rpc/bindAgentSession', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, sessionId, questId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[rsat] agent bind failed (${res.status}) for ${agentId}:`, text.slice(0, 200));
      }
    } catch (error) {
      console.warn('[rsat] agent bind request failed:', error);
    }
  }
  
  useEffect(() => {
    const onCreateCouncil = () => {
      const store = useStore.getState();
      const active = store.activeConversation();
      if (!active || active.councilId) return;
      const councilId = `CL-${Math.random().toString(36).slice(2, 8)}`;
      store.patchConversation(active.id, { councilId, councilRole: 'main' });
    };
    const onCreateSubSession = (event: Event) => {
      const detail = (event as CustomEvent).detail as { title?: string; agentId?: string } | undefined;
      const store = useStore.getState();
      const active = store.activeConversation();
      const councilId = active?.councilId;
      if (!active || !councilId) return;
      const subId = store.newConversation({
        providerId: active.providerId || undefined,
        model: active.model || undefined,
        workspaceId: active.workspaceId,
        councilId,
        councilRole: 'sub',
        councilAgentId: detail?.agentId,
      });
      if (detail?.title) store.patchConversation(subId, { title: detail.title });
      store.selectConversation(subId);
    };
    const onDeleteSubSession = (event: Event) => {
      const detail = (event as CustomEvent).detail as { id?: string } | undefined;
      if (!detail?.id) return;
      useStore.getState().executeDeleteConversation(detail.id);
    };
    const onCouncilDispatch = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        providerId: string; model: string; agentId: string; agentName: string;
        thinkingLevel?: string; directive?: string;
      } | undefined;
      if (!detail) return;
      void (async () => {
        const subId = ensureCouncilSubSession(detail);
        if (!subId) return;
        applyAgentSessionSettings(subId, detail.thinkingLevel);
        await bindAgentSessionRpc(detail.agentId, subId, 'council');
        const sub = useStore.getState().conversations.find((entry) => entry.id === subId);
        try {
          await fetch('/api/addons/council/rpc/dispatch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: subId,
              councilId: sub?.councilId,
              agentName: detail.agentName,
              text: detail.directive ||
                `You were dispatched into this council as ${detail.agentName}. Your identity, fellow members and the shared brief are already in your context: run council_status, absorb the brief, then ack with council_ack and await the operator's task.`,
            }),
          });
        } catch {  }
        useStore.getState().selectConversation(subId);
      })();
    };
    
    const onSetOrchestrator = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        agentId: string; agentName: string; providerId: string; model: string;
        thinkingLevel?: string;
      } | undefined;
      if (!detail) return;
      const store = useStore.getState();
      const active = store.activeConversation();
      if (!active || !active.councilId) return;
      store.patchConversation(active.id, {
        providerId: detail.providerId || active.providerId,
        model: detail.model || active.model,
        councilAgentId: detail.agentId,
        settings: {
          ...active.settings,
          agentMode: true,
          ...(detail.thinkingLevel ? { thinkingLevel: detail.thinkingLevel as typeof active.settings.thinkingLevel } : {}),
        },
      });
      void bindAgentSessionRpc(detail.agentId, active.id, 'council');
      void fetch('/api/addons/council/rpc/setOrchestrator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: active.id, councilId: active.councilId, orchestratorAgentId: detail.agentId }),
      }).catch(() => undefined);
    };
    
    const onCouncilStop = (event: Event) => {
      const detail = (event as CustomEvent).detail as { id?: string } | undefined;
      if (!detail?.id) return;
      stopRun(detail.id);
    };
    window.addEventListener('moriko:council-create', onCreateCouncil as EventListener);
    window.addEventListener('moriko:council-sub-create', onCreateSubSession as EventListener);
    window.addEventListener('moriko:council-sub-delete', onDeleteSubSession as EventListener);
    window.addEventListener('moriko:council-dispatch', onCouncilDispatch as EventListener);
    window.addEventListener('moriko:set-orchestrator', onSetOrchestrator as EventListener);
    window.addEventListener('moriko:council-stop', onCouncilStop as EventListener);
    return () => {
      window.removeEventListener('moriko:council-create', onCreateCouncil as EventListener);
      window.removeEventListener('moriko:council-sub-create', onCreateSubSession as EventListener);
      window.removeEventListener('moriko:council-sub-delete', onDeleteSubSession as EventListener);
      window.removeEventListener('moriko:council-dispatch', onCouncilDispatch as EventListener);
      window.removeEventListener('moriko:set-orchestrator', onSetOrchestrator as EventListener);
      window.removeEventListener('moriko:council-stop', onCouncilStop as EventListener);
    };
  }, [stopRun]);

  
  useEffect(() => {
    const onStop = (frame: { id?: number; payload?: Record<string, unknown> }) => {
      const seen = (window as unknown as { __councilSeenStop?: number }).__councilSeenStop ?? 0;
      if ((frame.id ?? 0) <= seen) return;
      (window as unknown as { __councilSeenStop?: number }).__councilSeenStop = frame.id ?? 0;
      const payload = frame.payload as { conversationId?: string } | null;
      if (!payload?.conversationId) return;
      window.dispatchEvent(new CustomEvent('moriko:council-stop', { detail: { id: payload.conversationId } }));
    };
    const onWake = (frame: { id?: number; payload?: Record<string, unknown> }) => {
      const seen = (window as unknown as { __councilSeenWake?: number }).__councilSeenWake ?? 0;
      if ((frame.id ?? 0) <= seen) return;
      (window as unknown as { __councilSeenWake?: number }).__councilSeenWake = frame.id ?? 0;
      const payload = frame.payload as { items?: Array<{ sessionId?: string; text?: string }> } | null;
      const items = Array.isArray(payload?.items) ? payload.items : [];
      for (const item of items) {
        if (!item?.sessionId || !item?.text) continue;
        const exists = useStore.getState().conversations.some((entry) => entry.id === item.sessionId);
        if (!exists) continue;
        void send(item.text, item.sessionId);
      }
    };
    const onHarnessEvent = (frame: { id?: number; payload?: Record<string, unknown> }) => {
      const seen = (window as unknown as { __seenHarnessEvent?: number }).__seenHarnessEvent ?? 0;
      if ((frame.id ?? 0) <= seen) return;
      (window as unknown as { __seenHarnessEvent?: number }).__seenHarnessEvent = frame.id ?? 0;
      const payload = frame.payload as {
        conversationId?: string;
        event?: { id?: string; addonId?: string; level?: string; text?: string; at?: number };
      } | null;
      if (!payload?.conversationId || !payload.event?.id || !payload.event.text) return;
      const known = useStore.getState().conversations.some((entry) => entry.id === payload.conversationId);
      if (!known) return;
      useStore.getState().upsertHarnessEvent(payload.conversationId, {
        id: payload.event.id,
        role: 'user',
        kind: 'harness-event',
        content: `[${payload.event.addonId ?? 'addon'}] [${payload.event.level ?? 'info'}] ${payload.event.text}`,
        createdAt: payload.event.at ?? Date.now(),
        eventAddon: payload.event.addonId ?? 'addon',
        eventLevel: (payload.event.level ?? 'info') as 'info' | 'warn' | 'block',
      } as import('./types').Turn);
    };
    let unsubscribe: (() => void) | undefined;
    void import('./addons/host').then(({ onAddonBusFrame }) => {
      unsubscribe = onAddonBusFrame((frame) => {
        if (frame.topic === 'council:stopped') onStop(frame);
        else if (frame.topic === 'council:wake') onWake(frame);
        else if (frame.topic === 'harness:event') onHarnessEvent(frame);
      });
    });
    return () => { unsubscribe?.(); };
  }, [send]);

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
  const [todosOpen, setTodosOpen] = useState(false);

  
  const [turnNavigation, setTurnNavigation] = useState<ThreadNavigation | null>(null);
  const handleNavigationReady = useCallback((navigation: ThreadNavigation | null) => {
    setTurnNavigation(navigation);
  }, []);

  
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

  const handleBindWorkspace = useCallback(async () => {
    await handlePickWorkspace();
  }, [handlePickWorkspace]);




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

  
  const addonEvent = useStore((state) => state.addonEvent);
  useEffect(() => {
    if (addonEvent?.topic === 'moriko:gallery-added') void loadGallery();
  }, [addonEvent, loadGallery]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleSidebar();
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === 'n' || event.key === 'N')
      ) {
        event.preventDefault();
        useStore.getState().setView('playground');
        useStore.getState().newConversation();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === '.') {
        event.preventDefault();
        toggleSettings();
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault();
        useStore.getState().updateSettings({ agentMode: !chatSettings.agentMode });
      }
      if (event.key === 'F2') {
        const target = event.target instanceof Element ? event.target : null;
        const typing =
          target !== null &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as HTMLElement).isContentEditable);
        if (!typing && useStore.getState().view === 'playground') {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent('moriko:retitle'));
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar, toggleSettings, chatSettings.agentMode]);

  useEffect(() => {
    const onPopoverKeys = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const popover = target?.closest('.pop');
      if (!popover || target?.closest('.seg')) return;
      const items = Array.from(popover.querySelectorAll<HTMLElement>('.mi,.mo,.es,.sw,.pi')).filter(
        (item) => item.offsetParent !== null && !(item as HTMLButtonElement).disabled,
      );
      if (items.length === 0) return;
      event.preventDefault();
      let index = items.indexOf(document.activeElement as HTMLElement);
      index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : event.key === 'ArrowDown'
              ? (index + 1) % items.length
              : index <= 0
                ? items.length - 1
                : index - 1;
      items[index]?.focus();
    };
    window.addEventListener('keydown', onPopoverKeys);
    return () => window.removeEventListener('keydown', onPopoverKeys);
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    const onResize = () => {
      if (window.matchMedia('(min-width: 768px)').matches) setNavOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [navOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onResize = () => {
      if (window.matchMedia('(min-width: 1024px)').matches) dismissSettings();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [settingsOpen, dismissSettings]);

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
    const apply = () =>
      applyAppearance({ theme, accent, density, ambient, fontFamily, reduceMotion });
    apply();
    const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
    const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    darkMq.addEventListener('change', apply);
    motionMq.addEventListener('change', apply);
    return () => {
      darkMq.removeEventListener('change', apply);
      motionMq.removeEventListener('change', apply);
    };
  }, [theme, accent, density, ambient, reduceMotion, fontFamily]);

  useEffect(() => {
    document.documentElement.style.setProperty('--img-cat', `url(${brandCatHeadSvgUrl})`);
  }, []);

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

  
  const handleSteer = useCallback(
    (text: string, attachments?: TurnAttachment[]) => {
      const slash = /^\/compact\b/i.exec(text.trim());
      if (slash && (!attachments || attachments.length === 0)) {
        const focus = text.trim().slice(slash[0].length).trim();
        void compactNow(focus || undefined);
        return Promise.resolve({ id: 'compact' });
      }
      if (!activeConversation) return Promise.resolve({ id: null });
      const conversationId = activeConversation.id;
      const parts: import('./lib/api').SteerClientPart[] = [];
      if (text.trim()) parts.push({ type: 'text', text: text.trim() });
      for (const attachment of attachments ?? []) {
        if (attachment.mime.startsWith('image/')) {
          const url = attachment.dataRef
            ? attachmentRefWireUrl(attachment.dataRef.hash, attachment.dataRef.mime)
            : attachment.dataUrl;
          if (url) parts.push({ type: 'image_url', image_url: { url } });
        } else if (attachment.mime.startsWith('video/')) {
          const url = attachment.dataRef
            ? attachmentRefWireUrl(attachment.dataRef.hash, attachment.dataRef.mime)
            : attachment.dataUrl;
          if (url) parts.push({ type: 'video_url', video_url: { url } });
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

  
  const composerSlotRef = useRef<HTMLDivElement | null>(null);
  const slotRectRef = useRef<DOMRect | null>(null);
  const slotRef = useCallback((node: HTMLDivElement | null) => {
    composerSlotRef.current = node;
  }, []);

  useLayoutEffect(() => {
    const slot = composerSlotRef.current;
    if (!slot || hasThread) return;
    slotRectRef.current = slot.getBoundingClientRect();
  });

  useLayoutEffect(() => {
    const from = slotRectRef.current;
    if (!hasThread || !from) return;
    slotRectRef.current = null;
    const slot = composerSlotRef.current;
    if (!slot || isMotionReduced(useStore.getState().reduceMotion)) return;
    const to = slot.getBoundingClientRect();
    const dy = Math.round(from.top - to.top);
    if (Math.abs(dy) < 4) return;
    slot.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0px)' }],
      { duration: 480, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [hasThread]);

  
  const threadScrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const [turnNumbers, setTurnNumbers] = useState<number[]>([]);
  const [activeTurn, setActiveTurn] = useState(1);

  
  useEffect(() => {
    const el = threadScrollerRef.current;
    if (!el) return;
    const sync = () => setScrollbarWidth(el.offsetWidth - el.clientWidth);
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [view, hasThread]);

  
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

  const THREAD_BOTTOM_PAD = 24;

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
    <div className="app">
      {}
      <div className="ambient" aria-hidden="true"><span></span><span></span><span></span></div>
      {}
      <a
        href="#workspace"
        className="skip-link"
      >
        Skip to content
      </a>

      {}
      <div className="show-md" style={{ position: 'relative', zIndex: 1 }}>
        <div
          data-demo-rail="true"
          className="fold fold-open"
          style={{ width: sidebarCollapsed ? 64 : sidebarWidth }}
        >
          <Sidebar
            width={sidebarWidth}
            onOpenProviders={() => setProvidersOpen(true)}
            onOpenSettings={() => setPrefsOpen(true)}
            onBindWorkspace={handleBindWorkspace}
          />
        </div>
        {!sidebarCollapsed ? (
          <ResizeHandle
            side="left"
            value={sidebarWidth}
            min={260}
            max={420}
            defaultValue={260}
            onResize={setSidebarWidth}
            onCommit={useStore.getState().commitSidebarWidth}
          />
        ) : null}
      </div>

      {}
      {navOpen ? (
        <div className="hide-md nav-open" style={{ position: 'fixed', inset: 0, zIndex: 40 }}>
          <div
            style={{ position: 'absolute', inset: 0, background: 'rgb(var(--c-shadow) / 0.45)', backdropFilter: 'blur(2px)' }}
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
          {}
          <div className="drawer-slide-left" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: 248, boxShadow: 'var(--sh2)' }}>
            <Sidebar
              onOpenProviders={() => setProvidersOpen(true)}
              onOpenSettings={() => setPrefsOpen(true)}
              onNavigate={() => setNavOpen(false)}
              onBindWorkspace={handleBindWorkspace}
            />
          </div>
        </div>
      ) : null}

      {}
      {settingsOpen ? (
        <div className="hide-lg" style={{ position: 'fixed', inset: 0, zIndex: 40 }}>
          <div
            style={{ position: 'absolute', inset: 0, background: 'rgb(var(--c-shadow) / 0.45)', backdropFilter: 'blur(2px)' }}
            onClick={dismissSettings}
            aria-hidden="true"
          />
          <div
            className="drawer-slide-right"
            style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: 'min(320px, 88vw)', overflow: 'hidden', background: 'rgb(var(--c-canvas))', boxShadow: 'var(--sh2)' }}
          >
            <Suspense fallback={null}>
              {}
              <div key={rightPanelMode} className="dock-panel-in" style={{ height: '100%' }}>
                {rightPanelMode === 'tree' ? (
                  <LazyProjectTreePanel />
                ) : rightPanelMode === 'addons' ? (
                  <LazyAddonDockShortcut />
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
        className="work"
      >
        {}
        {typeof view === 'string' && view.startsWith('addon:') ? null : (
          <TopBar
            title={title}
            onPickWorkspace={handlePickWorkspace}
            workspaceLabel={workspaceLabel}
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
        )}

        {}
        {view === 'imagestudio' ? (
          <Suspense fallback={<LazyViewFallback label="Image Studio" />}>
            <LazyImageStudio />
          </Suspense>
        ) : view === 'playground' ? (
          <div
            className={`ctx-zoom view-enter${!hasThread ? ' chat-v empty' : ''}`}
            style={{
              display: 'flex',
              minHeight: 0,
              flex: 1,
              flexDirection: 'column',
              justifyContent: hasThread ? undefined : 'center',
			  paddingBottom: hasThread ? undefined : 110,
              overflowY: hasThread ? undefined : 'auto',
              overflowAnchor: 'none',
            }}
          >
            {hasThread ? (
              <div style={{ position: 'relative', display: 'flex', minHeight: 0, flex: 1 }}>
                <div
                  ref={threadScrollerRef}
                  className="chat-scroll"
                  style={{ minHeight: 0, flex: 1, overflowY: 'auto', overflowAnchor: 'none', scrollbarGutter: 'stable' }}
                >
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
            ) : (
              <Suspense fallback={null}>
                <LazyExplore />
              </Suspense>
            )}
            {}
            <div ref={slotRef} style={{ flexShrink: 0, width: '100%' }}>
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
                onToggleTodos={() => setTodosOpen((value) => !value)}
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
            <div style={{ minHeight: 0, flex: 1, overflowY: 'auto', overflowAnchor: 'none', scrollbarGutter: 'stable' }}>
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
              ) : view === 'addons' ? (
                <LazyViewBoundary label="Addon Hub">
                  <Suspense fallback={<LazyViewFallback label="Addon Hub" />}>
                    <LazyAddonHub />
                  </Suspense>
                </LazyViewBoundary>
              ) : typeof view === 'string' && view.startsWith('addon:') ? (
                <LazyViewBoundary label={view}>
                  <Suspense fallback={<LazyViewFallback label="Addon view" />}>
                    <LazyAddonViewHost viewKey={view} />
                  </Suspense>
                </LazyViewBoundary>
              ) : null}
            </div>
          </>
        )}
      </main>


      {}
      {settingsEverOpened ? (
        <div className="show-lg" style={{ position: 'relative', zIndex: 1 }}>
          {settingsOpen && settingsPanelReady ? (
            <ResizeHandle
              side="right"
              value={dockWidth}
              min={rightPanelMode === 'diff' ? 560 : 300}
              max={rightPanelMode === 'diff' ? 1600 : 520}
              defaultValue={rightPanelMode === 'diff' ? 760 : 340}
              onResize={rightPanelMode === 'diff' ? setDiffDockWidth : setSettingsWidth}
              onCommit={
                rightPanelMode === 'diff'
                  ?
                    useStore.getState().commitDiffDockWidth
                  : useStore.getState().commitSettingsWidth
              }
            />
          ) : null}
          <div
            className={`fold${settingsOpen && settingsPanelReady ? ' fold-open' : ''}`}
            style={{ width: settingsOpen && settingsPanelReady ? dockWidth + 4 : 0 }}
            aria-hidden={!settingsOpen}
            data-demo-dock="true"
          >
            <Suspense fallback={null}>
              {}
              <div key={rightPanelMode} className="dock-panel-in" style={{ height: '100%' }}>
                {rightPanelMode === 'tree' ? (
                  <LazyProjectTreePanel width={dockWidth} />
                ) : rightPanelMode === 'addons' ? (
                  <LazyAddonDockShortcut />
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
      {todosOpen ? (
        <Suspense fallback={null}>
          <TodoPanel open onClose={() => setTodosOpen(false)} />
        </Suspense>
      ) : null}
      {pendingConfirmDelete ? (
        <Modal
          open
          onClose={cancelPendingDelete}
          title="Delete chat?"
          description="This removes the conversation from this device."
          size="sm"
        >
          <p style={{ margin: 0, fontSize: 13.5, color: 'rgb(var(--c-ink))' }}>{pendingDeleteTitle}</p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button type="button" className="btn ghost sm" onClick={cancelPendingDelete}>
              Cancel
            </button>
            <button
              type="button"
              className="btn sm"
              style={{ background: 'rgb(var(--c-danger))', borderColor: 'transparent', color: '#fff' }}
              onClick={confirmPendingDelete}
            >
              Delete
            </button>
          </div>
        </Modal>
      ) : null}
      <AgentPermissionDialog />
      <AgentAskUserDialog />
      <AgentOperatorGateDialog />
      <AddonNotificationHost />
      {}
      <AddonWidgetHost site="floating" streaming={streaming} />
    </div>
  );
}
