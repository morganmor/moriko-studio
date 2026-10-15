import { useCallback, useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from 'react';
import { AgentPermissionDialog } from './components/AgentPermissionDialog';
import { AgentAskUserDialog } from './components/AgentAskUserDialog';
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
// AddonPanel's dock tab is now the AddonDockShortcut → the Hub (A6).
// LazyAddonPanel intentionally removed; the full manager lives in AddonHub.
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
  import('./components/AddonHub').then((m) => ({ default: m.AddonDockShortcut })),
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

  /* `.resizing` kills the width transition on .rail/.dock/.fold while a drag is
     live — otherwise the fold eases 260ms behind the handle and the panel
     content (which resizes instantly) spills past its clipped edge. The
     unmount cleanup guards against a drag that outlives the handle. */
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
      /* capture may already be released by the browser */
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
        /* Reference design: the resizer is a focusable separator. Arrow keys
           nudge by 16px (direction matches which side the panel hugs), Home
           resets — each step persists immediately, like pointer release. */
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
  const accent = useStore((state) => state.accent);
  const density = useStore((state) => state.density);
  const ambient = useStore((state) => state.ambient);
  const reduceMotion = useStore((state) => state.reduceMotion);
  const fontFamily = useStore((state) => state.fontFamily);
  /** confirmDel (panel-settings): a chat id parked until the dialog answers. */
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
  /** Agent mode for the design's Alt A shortcut (reads the effective chat settings). */
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
  /* 2026-10 BUGFIX: pill TopBar dulu HANYA ikut activeAgentWorkspaceId, jadi
   * saat chat dipindah ke Owl (Move to workspace) pill tetap "No workspace"
   * padahal menu mencentang Owl. Sekarang pill mengikuti binding CHAT aktif;
   * fallback ke workspace global hanya saat tidak ada chat. */
  const workspaceTargetId = activeConversation?.workspaceId ?? (activeConversation ? null : activeAgentWorkspaceId);
  const workspaceLabel = workspaceTargetId
    ? agentWorkspaces.find((workspace) => workspace.id === workspaceTargetId)?.label
    : undefined;
  const loadTreeView = useStore((state) => state.loadTreeView);
  useEffect(() => {
    void loadTreeView(activeAgentWorkspaceId);
  }, [loadTreeView, activeAgentWorkspaceId]);

  useEffect(() => {
    // P5 BUGFIX: model metadata (models.dev, 261 KB) was moved off the boot
    void useStore.getState().ensureModelMeta();
  }, []);

  const { send, stop, stopRun, regenerate, regenerateFrom, compactNow } = useChatController();

  /**
   * RSA/T DISPATCH (agent identity feature): an addon panel asks the host to
   * spawn a NEW conversation bound to a named agent and auto-send the task.
   * Flow: newConversation(provider/model of the agent) → title → bind the
   * conversation to the agent's registry id (rpc bindAgentSession) → send the
   * prompt. The board then attributes that session's claims/guard/memory to
    * the agent identity — two sessions on the same model stay two agents.
    *
    * COUNCIL: when the ACTIVE conversation is a council, the dispatched agent
    * lands in a SUB SESSION of that council instead of a new top-level chat —
    * one RSAT project stays one sidebar row, each agent keeps its own context.
    * Re-dispatching an agent that already owns a sub session of this council
    * REUSES it (sends into the existing session) rather than opening another.
    */
  useEffect(() => {
    const onDispatchAgent = async (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        providerId: string; model: string; agentId: string; agentName: string;
        questId: string; questTitle: string; prompt: string; thinkingLevel?: string;
      };
      const store = useStore.getState();
      const host = store.activeConversation();
      const workspaceId = host?.workspaceId ?? undefined;

      // COUNCIL routing: reuse this agent's sub session when it already has one.
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
      // Bind SEBELUM send — dan TUNGGU hasilnya: prompt fragment identitas
      // dibangun di server saat request pertama, jadi bind yang masih
      // in-flight membuat turn pertama (dan klaim pertamanya) tanpa identitas.
      await bindAgentSessionRpc(detail.agentId, conversationId, detail.questId);
      void send(detail.prompt, conversationId);
    };
    window.addEventListener('moriko:dispatch-agent', onDispatchAgent as EventListener);
    return () => window.removeEventListener('moriko:dispatch-agent', onDispatchAgent as EventListener);
  }, [send]);

  /** COUNCIL: create (or reuse) this agent's sub session inside the ACTIVE council. */
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

  /** COUNCIL/RSAT: dispatched sessions run as agents with the agent's effort. */
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

  /** RSAT registry bind — await it: the identity fragment builds on first request. */
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
  /**
   * COUNCIL (Council Agent addon) — the panel asks the host to (a) turn the
   * ACTIVE conversation into a council container, (b) add a sub session to
   * the active conversation's council and switch to it, (c) delete a sub
   * session, or (d) DISPATCH an RSAT agent into a sub session as pure CONTEXT
   * injection: the directive is queued server-side (council rpc `dispatch`)
   * and rides the council prompt fragment at the sub session's first fetch —
   * no user message, no auto-started round. Creation/deletion stays host-owned:
   * only the store writes conversations; the addon owns membership/policy.
   */
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
        } catch { /* directive is best-effort; identity fragment still applies */ }
        useStore.getState().selectConversation(subId);
      })();
    };
    /**
     * ORCHESTRATOR (poin 1): user designates an RSAT agent as the orchestrator
     * of the active council. The main session is bound to that agent's identity
     * (provider/model/agentMode/thinkingLevel) so speaking to the main session =
     * speaking to the orchestrator. The council doc records orchestratorAgentId.
     */
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
        // sessionId WAJIB: without it the server resolves the wrong workspace
        // and the designation is written to a file the panel never reads.
        body: JSON.stringify({ sessionId: active.id, councilId: active.councilId, orchestratorAgentId: detail.agentId }),
      }).catch(() => undefined);
    };
    /**
     * COUNCIL STOP (poin 3): the orchestrator's council_stop tool (via bus →
     * panel → this event) asks the host to abort a sub-agent's running stream.
     * Server-side abort already happened via api.sessions.abort; this mirrors
     * the client-side cleanup that stop() does for the active conversation.
     */
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

  /**
   * COUNCIL BUS BRIDGE — the always-mounted host side of two orchestrator
   * powers that need a client-side run:
   *  · 'council:stopped' → mirror the client-side cleanup (abort stream).
   *  · 'council:wake'    → an IDLE sub-session has no running adapter to drain
   *    an injected message, so a message to it would sit queued forever (the
   *    "orchestrator message never arrives" bug). The council addon publishes
   *    the targets here; this bridge starts their run with the instruction.
   */
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
      // Bus frames replay on reconnect — a monotonic guard keeps each wake once.
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
    // HARNESS-EVENT bridge: an addon event for a conversation this tab knows
    // about lands as a dedicated event turn (own panel) — even while idle.
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
      if (!known) return; // per-session: never leak into other conversations
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

  /** TURN NAVIGATION — the composer band's arrows call INTO the thread's
   *  pin/glide owner (via onNavigationReady) instead of scrolling raw DOM. */
  const [turnNavigation, setTurnNavigation] = useState<ThreadNavigation | null>(null);
  const handleNavigationReady = useCallback((navigation: ThreadNavigation | null) => {
    setTurnNavigation(navigation);
  }, []);

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

  /** HANDLE BIND + ACTIVATE (2026-10 bugfix): pilihan dari SEMUA UI workspace
   *  (TopBar "Bind a folder...", composer folder button, dan kini sidebar)
   *  melewati sini — setelah folder dipilih, workspace langsung jadi AKTIF
   *  (server per-session + state) supaya pill TopBar dan tree ikut, bukan
   *  sekadar terdaftar. */
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

  /** agent__image appends results server-side and broadcasts on the bus.
   *  TWO refresh paths, because the SSE frame can race the tool_result that
   *  carries the images: the optimistic push (instant, local) and the bus
   *  refetch (authoritative, reaches every browser). */
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
      /* Reference design: Alt N spawns a fresh chat from anywhere. */
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
      /* Right-dock design: Ctrl . toggles the configuration panel. */
      if ((event.ctrlKey || event.metaKey) && event.key === '.') {
        event.preventDefault();
        toggleSettings();
      }
      /* Canvas-chat design: Alt A flips agent mode on/off. */
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault();
        useStore.getState().updateSettings({ agentMode: !chatSettings.agentMode });
      }
      /* Design More menu: F2 renames the active chat when focus is not typing. */
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

  /** Popovers design: Arrow/Home/End walk the focus through an open popover. */
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
    /* Reference design: growing back past the drawer breakpoint dismisses the
       mobile nav — the desktop rail is already visible, so the overlay would
       only sit duplicated on top of it. */
    const onResize = () => {
      if (window.matchMedia('(min-width: 768px)').matches) setNavOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [navOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    /* Same rule for the RIGHT drawer: at ≥lg the docked fold is already
       mounted, so the mobile overlay would only duplicate it. */
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

  // Theme mechanism (design/moriko-design-1-theme-mechanism.html): ONE effect
  // applies every appearance knob, and re-applies when the OS flips its own
  // system-theme or reduced-motion preference.
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

  // Design :root defines --img-cat (pixel cat for .logo/.av); point it at the bundled asset.
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

  /**
   * STEER: while a generation runs, the composer's button becomes Steer and
   * hands the draft to the LIVE stream's context instead of opening a new
   * turn. `false` means the run ended in the gap between typing and pressing
   * — the Composer keeps the text and the user is told, so nothing is lost.
   */
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
   * SEND REMINDER — the user manually pushes the server-owned Writing-Rules
   * reminder into the running generation's context. The bubble shows a fixed
   * label, not the full text.
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

  /** ONE COMPOSER — a single <Composer/> instance serves both states: the
   *  landing view (centered under the Explore hero) and the thread dock
   *  (bottom). It is mounted once in the playground column; the first send
   *  only re-flows it from center to dock, and FLIP animates that drop. */
  const composerSlotRef = useRef<HTMLDivElement | null>(null);
  const slotRectRef = useRef<DOMRect | null>(null);
  const slotRef = useCallback((node: HTMLDivElement | null) => {
    composerSlotRef.current = node;
  }, []);

  // While on the landing view, remember the slot's on-screen rect so the
  // first-send reflow can be FLIP-animated down to the dock.
  useLayoutEffect(() => {
    const slot = composerSlotRef.current;
    if (!slot || hasThread) return;
    slotRectRef.current = slot.getBoundingClientRect();
  });

  // First send: the slot re-flows from the landing cluster to the dock;
  // animate it from the last landing position down to rest.
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

  /** THREAD SCROLLER + TURN RAIL — ref scroller thread & state rail checkpoint:
   *  turnNumbers/activeTurn diukur dari baris turn di scroller ini. */
  const threadScrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const [turnNumbers, setTurnNumbers] = useState<number[]>([]);
  const [activeTurn, setActiveTurn] = useState(1);

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
          {/* .nav-open on this wrapper: at ≤768px Sidebar's .rail is fixed +
              translateX(-105%) and ONLY `.nav-open .rail` un-translates it —
              without the class the drawer's rail stays parked offscreen. */}
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
        {/* View addon = EKSKLUSIF: TopBar chat tidak dirender di atasnya. */}
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
                  <LazyAddonDockShortcut width={dockWidth} />
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
      <AddonNotificationHost />
      {}
      <AddonWidgetHost site="floating" streaming={streaming} />
    </div>
  );
}
