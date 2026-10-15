/**
 * ADDON v2 HOST GLOBAL (A5) — `window.__MORIKO_HOST__`.
 *
 * ONE React instance: addon client modules are transpiled server-side and
 * their bare imports ('react', 'react/jsx-runtime', '@moriko/host') are
 * rewritten to /api/addons/host-shim/* — tiny ES modules that re-export from
 * THIS object. Two React copies break hooks; this guarantees there is one.
 *
 * Installs react + react-dom + jsx-runtime + a host hook set:
 *  - useAddonState / useBus / useSettings — live SSE-backed state
 *  - invoke(addonId, name, body) — POST /api/addons/:id/rpc/:name (user actor)
 *  - notify / t — the notification + i18n channels
 *  - Icon/Card/Pill/Button/Modal/Tabs/ProgressBar — themed UI kit wrappers
 */

import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';

import { DIcon } from '../components/designIcons';
import { Modal } from '../components/ui';
import { useStore } from '../store/useStore';
import type { AddonBusPayload } from '../types/addonBus';
import { bumpAddonClientVersion } from './clientVersion';

const busListeners = new Set<(frame: AddonBusPayload) => void>();

export interface AddonHostSurface {
  modules: {
    react: unknown;
    reactDom: unknown;
    reactDomClient: unknown;
    jsxRuntime: unknown;
  };
  host: Record<string, unknown>;
}

/** Subscribe to addon SSE frames (same channel the visual re-bind uses). */
export function onAddonBusFrame(listener: (frame: AddonBusPayload) => void): () => void {
  busListeners.add(listener);
  return () => busListeners.delete(listener);
}

/** Called by the boot SSE subscriber (main.tsx) for every frame. */
export function dispatchAddonBusFrame(frame: AddonBusPayload): void {
  // Registry change → invalidate cached addon client modules so lazy imports
  // pick up fresh code without a page refresh.
  if (frame.topic === 'addons.registry') bumpAddonClientVersion();
  for (const listener of [...busListeners]) {
    try {
      listener(frame);
    } catch (error) {
      console.error('[addons] bus frame listener error:', error);
    }
  }
}

/** useAddonBus — re-render on every matching SSE frame. */
function useAddonBus(topic: string | null): AddonBusPayload | null {
  const last = useStore((state) => state.addonEvent);
  const [frame, setFrame] = React.useState<AddonBusPayload | null>(null);
  React.useEffect(() => {
    return onAddonBusFrame((incoming) => {
      if (topic === null || incoming.topic === topic) setFrame(incoming);
    });
  }, [topic]);
  return frame ?? (last && (topic === null || last.topic === topic) ? last : null);
}

/** useAddonState — fetch once, then keep in step with SSE invalidations. */
function useAddonState<T>(addonId: string, initial: T, derive: (frame: AddonBusPayload | null) => T | null): T {
  const [state, setState] = React.useState<T>(initial);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    void fetch(`/api/addons/${addonId}/state`)
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((payload) => { if (payload) setState(payload as T); })
      .catch(() => { /* offline addon = keep initial */ });
  }, [addonId, tick]);
  React.useEffect(() => {
    return onAddonBusFrame((frame) => {
      if (frame.topic === 'addon.view.invalidate' || frame.topic === 'addon.status') {
        if (frame.addonId === addonId) setTick((n) => n + 1);
      }
      const next = derive(frame);
      if (next !== null) setState(next);
    });
  }, [addonId, derive]);
  return state;
}

/** useSettings — schema-validated addon settings, live. */
function useAddonSettings(addonId: string): { settings: Record<string, unknown> | null; set: (key: string, value: unknown) => void } {
  const [settings, setSettings] = React.useState<Record<string, unknown> | null>(null);
  const reload = React.useCallback(() => {
    void fetch(`/api/addons/${addonId}/settings`)
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((payload) => { if (payload?.settings) setSettings(payload.settings); })
      .catch(() => { /* keep last */ });
  }, [addonId]);
  React.useEffect(() => reload(), [reload]);
  React.useEffect(() => {
    return onAddonBusFrame((frame) => {
      if (frame.topic === 'addon.settings' && frame.addonId === addonId) reload();
    });
  }, [addonId, reload]);
  const set = React.useCallback((key: string, value: unknown) => {
    void fetch(`/api/addons/${addonId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    }).catch(() => { /* surfaced by the Hub on next load */ });
    setSettings((current) => ({ ...(current ?? {}), [key]: value }));
  }, [addonId]);
  return { settings, set };
}

/** useSession — the active conversation's harness session id (live). */
function useSession(): { conversationId: string | null; running: boolean } {
  const activeId = useStore((state) => state.activeId);
  const genRunning = useStore((state) => state.genRunning);
  return { conversationId: activeId, running: Boolean(activeId && genRunning[activeId]) };
}

/** invoke — the addon's own RPC endpoint (server enforces actor = user).
 *  sessionId percakapan aktif ikut dikirim supaya RPC yang butuh konteks
 *  workspace (mis. RSA/T) me-resolve workspace CHAT ini, bukan global. */
async function invoke<T = unknown>(addonId: string, name: string, body: Record<string, unknown> = {}): Promise<T> {
  const sessionId = useStore.getState().activeId ?? undefined;
  const resp = await fetch(`/api/addons/${addonId}/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, sessionId }),
  });
  const payload = (await resp.json().catch(() => null)) as { result?: T; error?: string } | null;
  if (!resp.ok || !payload) throw new Error(payload?.error ?? `RPC "${name}" failed (${resp.status})`);
  return payload.result as T;
}

/** i18n — key passthrough; bundles are resolved per-addon (A6 R6 wires ids). */
function t(addonId: string, key: string, vars?: Record<string, string>): string {
  void addonId;
  let out = key;
  if (vars) for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, value);
  return out;
}

/** showNotice mirror for addon UIs (themed toasts, no browser alert). */
function notify(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  useStore.getState().showNotice(kind === 'error' ? 'addon.notifyError' : 'addon.notify', undefined, { detail: text });
}

/** Appearance bridge — addon pages (RSA/T topbar) can flip the app theme/accent. */
function setTheme(mode: 'light' | 'dark' | 'mocha' | 'system', ev?: { clientX: number; clientY: number }): void {
  useStore.getState().setTheme(mode, ev);
}
function setAccent(name: 'ember' | 'sakura' | 'matcha' | 'ocean' | 'violet'): void {
  useStore.getState().setAccent(name);
}
function getAppearance(): { theme: string; accent: string } {
  const s = useStore.getState();
  return { theme: s.theme, accent: s.accent };
}

/** Navigate the SPA (addon topbar back button → chat). */
function navigate(view: string): void {
  useStore.getState().setView(view as never);
}

/** Providers for addon UIs (RSAT Create Agent): id, label, models — NO keys.
 *  Hanya provider yang punya server key (usable untuk dispatch agent). */
function getProviders(): Array<{ id: string; label: string; models: string[] }> {
  return useStore
    .getState()
    .providers.filter((p) => p.hasServerKey && p.models.length > 0)
    .map((p) => ({ id: p.id, label: p.label, models: [...p.models] }));
}

/**
 * RSA/T dispatch: ask the host to spawn a NEW conversation bound to a named
 * agent and auto-send the task prompt. The event is handled in App.tsx where
 * newConversation + the chat controller's send live. detail carries NO
 * secrets — provider/model labels only; API keys stay host-side by design.
 */
function dispatchAgent(detail: {
  providerId: string;
  model: string;
  agentId: string;
  agentName: string;
  questId: string;
  questTitle: string;
  /** Reasoning effort pilihan user untuk agent ini ('' = ikut percakapan). */
  thinkingLevel?: string;
  prompt: string;
}): void {
  window.dispatchEvent(new CustomEvent('moriko:dispatch-agent', { detail }));
}

/** Toggle the HOST left rail (Moriko sidebar) from an addon page. */
function toggleSidebar(): void {
  useStore.getState().toggleSidebar();
}

/**
 * COUNCIL (Council Agent addon) — the grouping read by the TopBar switcher.
 * Returns null when the active conversation is not part of a council.
 */
function useCouncil(): {
  councilId: string | null;
  main: { id: string; title: string; agentId?: string } | null;
  subs: Array<{ id: string; title: string; agentId?: string }>;
  activeId: string | null;
} {
  const activeId = useStore((state) => state.activeId);
  const conversations = useStore((state) => state.conversations);
  const active = conversations.find((entry) => entry.id === activeId);
  const councilId = active?.councilId ?? null;
  const main = councilId
    ? conversations.find((entry) => entry.councilId === councilId && entry.councilRole === 'main')
    : null;
  const subs = councilId
    ? conversations
      .filter((entry) => entry.councilId === councilId && entry.councilRole === 'sub')
      .map((entry) => ({ id: entry.id, title: entry.title, agentId: entry.councilAgentId }))
    : [];
  return {
    councilId,
    main: main ? { id: main.id, title: main.title, agentId: main.councilAgentId ?? '' } : null,
    subs,
    activeId,
  };
}

/** Select an existing conversation (the switcher jumps between council members). */
function openConversation(conversationId: string): void {
  useStore.getState().selectConversation(conversationId);
}

/**
 * Delete one sub session. The panel shows its own inline themed confirm, so
 * this takes the direct delete path (bypassing the host's confirmDel parking,
 * whose dialog lives in sidebar flows the sub session never renders in).
 */
function deleteSubSession(conversationId: string): void {
  useStore.getState().executeDeleteConversation(conversationId);
}

/** Create a council: turns the ACTIVE conversation into its Main Session. */
function createCouncil(): string | null {
  const store = useStore.getState();
  const active = store.activeConversation();
  if (!active || active.councilId) return active?.councilId ?? null;
  const councilId = `CL-${Math.random().toString(36).slice(2, 8)}`;
  store.patchConversation(active.id, { councilId, councilRole: 'main' });
  return councilId;
}

/** Create an empty sub session inside the ACTIVE conversation's council. */
function createSubSession(options?: { agentId?: string; title?: string }): string | null {
  const store = useStore.getState();
  const active = store.activeConversation();
  const councilId = active?.councilId ?? null;
  if (!councilId || !active) return null;
  const subId = store.newConversation({
    providerId: active.providerId || undefined,
    model: active.model || undefined,
    workspaceId: active.workspaceId,
    councilId,
    councilRole: 'sub',
    councilAgentId: options?.agentId,
  });
  if (options?.title) store.patchConversation(subId, { title: options.title });
  return subId;
}

/** Themed UI kit re-exports for addon client components. */
const hostSurface: Record<string, unknown> = {
  useAddonBus,
  useAddonState,
  useAddonSettings,
  useSession,
  invoke,
  notify,
  t,
  setTheme,
  setAccent,
  getAppearance,
  navigate,
  toggleSidebar,
  getProviders,
  dispatchAgent,
  useCouncil,
  openConversation,
  createCouncil,
  createSubSession,
  deleteSubSession,
  Icon: DIcon,
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { className: `card addon-card ${className ?? ''}` }, children),
  Pill: ({ children, tone }: { children: React.ReactNode; tone?: string }) =>
    React.createElement('span', { className: `addon-pill ${tone ?? ''}` }, children),
  Button: ({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) =>
    React.createElement('button', { type: 'button', onClick, className: `btn xs ${className ?? ''}` }, children),
  Modal,
  Tabs: ({ tabs, active, onChange }: { tabs: Array<{ id: string; label: string }>; active: string; onChange: (id: string) => void }) =>
    React.createElement(
      'div',
      { className: 'addon-tabs' },
      tabs.map((tab) =>
        React.createElement('button', {
          key: tab.id,
          type: 'button',
          className: `addon-tab ${active === tab.id ? 'on' : ''}`,
          onClick: () => onChange(tab.id),
        }, tab.label),
      ),
    ),
  ProgressBar: ({ value }: { value: number }) =>
    React.createElement('div', { className: 'addon-progress' },
      React.createElement('div', { className: 'addon-progress-fill', style: { width: `${Math.max(0, Math.min(1, value)) * 100}%` } })),
};

/** Install once at boot — addon shim modules resolve everything from here. */
export function installAddonHost(): void {
  const w = window as unknown as { __MORIKO_HOST__?: AddonHostSurface };
  if (w.__MORIKO_HOST__) return;
  w.__MORIKO_HOST__ = {
    modules: {
      react: React,
      reactDom: ReactDOM,
      reactDomClient: ReactDomClient,
      jsxRuntime,
    },
    host: hostSurface,
  };
}
