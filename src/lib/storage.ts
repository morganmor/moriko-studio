import type { Conversation, FontFamily, ImageSizeMode, ProviderDraft, SavedPrompt, ViewId } from '../types';

/** Left-sidebar collapsible sections — last user condition, device-persisted. */
export interface SidebarSections {
  chat?: boolean;
  image?: boolean;
  workspace?: boolean;
  recent?: boolean;
  /** Which workspace row is expanded (id), or null when all are collapsed. */
  expanded?: string | null;
}

/** G5: a conversation's scroll anchor — the topmost visible turn + its offset. */
export interface ViewAnchor {
  turnId: string;
  /** Row top relative to the scroller's viewport top (px, may be negative). */
  offset: number;
  savedAt: number;
}

/** Valid ViewId members — loadView rejects anything else from a stale file. */
const VIEW_IDS: readonly ViewId[] = ['playground', 'history', 'imagehistory', 'gallery', 'dashboard', 'imagestudio'];

/**
 * DEVICE STATE — THE BROWSER STORES NOTHING.
 *
 * Everything this module keeps used to live in localStorage: theme, zoom, font,
 * sidebar, saved prompts, the last provider/model, the active conversation and
 * Image Studio session, the client's run journal. That made every browser — and
 * every profile, and every incognito window — a separate universe: the same
 * account showed 2 chats in one browser and 7 in another, and some of that data
 * existed in exactly ONE place, the browser that typed it.
 *
 * The device (`~/.moriko`, see server/paths.ts) is now the only store. This
 * module is an in-memory VIEW of it:
 *
 *   bootUiState()  — ONE fetch at boot, before the first render, fills the view.
 *   read()         — synchronous read from that view (call sites unchanged).
 *   write()        — updates the view, marks the key dirty, schedules a patch.
 *   flushUiState() — sends ONLY the dirty keys (per-key merge, see uiState.ts),
 *                    so two tabs changing different preferences can never
 *                    revert each other.
 *
 * WHY IN-MEMORY + PATCH, not "read the file every time": every existing caller
 * reads synchronously during render (the store's initial state, the theme
 * effect, the composer). Keeping those call sites intact is what makes this
 * migration safe; the network work happens once at boot and once per quiet
 * window after a change.
 *
 * WHAT IS *NOT* HERE, DELIBERATELY:
 *  - sessionStorage (genRunning / streamIds): transient CONNECTION state, not
 *    user data. It describes what THIS TAB is attached to, dies with the tab,
 *    and is useless on disk. It is the one thing a browser is the right home
 *    for.
 *  - Conversations: also on the device, but they cannot ride this patch
 *    mechanism — a boot must not pull every multi-megabyte thread. They live in
 *    the store as summary shells with lazy bodies (see Conversation.turnsLoaded
 *    and `hydrateConversation`). What remains in this file is MIGRATION ONLY:
 *    `readLegacyConversations` / `clearLegacyConversations` hand a pre-existing
 *    browser cache to the device once, and erase it only after the device has
 *    acknowledged every record.
 */

/** Device keys — must match the allowlist in server/uiState.ts. */
const DEVICE_KEYS = {
  activeId: 'activeId',
  theme: 'theme',
  sidebar: 'sidebarCollapsed',
  /** Resizable panel widths (px) — device-persisted like the collapse flags. */
  sidebarWidth: 'sidebarWidth',
  settingsWidth: 'settingsWidth',
  defaults: 'defaults',
  savedPrompts: 'savedPrompts',
  fontScale: 'fontScale',
  contextScale: 'contextScale',
  providerId: 'providerId',
  model: 'model',
  fontFamily: 'fontFamily',
  imageStudio: 'imageStudio',
  imageSession: 'imageSessionId',
  jobRuns: 'jobRuns',
  treePanelOpen: 'treePanelOpen',
  treePanelGeometry: 'treePanelGeometry',
  /** 6B: which panel lives in the right dock — Configuration or Tree. */
  rightPanelMode: 'rightPanelMode',
  /** Fase D: per-visual manual sizing map (keyed by visual id). */
  visualGeometry: 'visualGeometry',
  /** Dashboard usage preferences (aggregation window + folded providers). */
  dashboardUsageWindow: 'dashboardUsageWindow',
  dashboardUsageProviders: 'dashboardUsageProviders',
  /** Left-sidebar dropdown states — the user's last condition across reloads. */
  sidebarSections: 'sidebarSections',
  /** G1–G4: right-dock open flag, active view, diff dock width, diff turn scope. */
  settingsOpen: 'settingsOpen',
  view: 'view',
  diffDockWidth: 'diffDockWidth',
  diffPanelTurnId: 'diffPanelTurnId',
  /** G5: per-conversation scroll anchor — refresh reopens at the same turn. */
  viewAnchors: 'viewAnchors',
} as const;

/**
 * sessionStorage keys. The ONLY browser storage left, on purpose: a generation
 * in flight is SESSION state. It must survive a reload (so the badge keeps
 * showing and the client can re-attach the SSE) but it must NOT survive a full
 * close — a stream nobody reconnects to is already gone server-side.
 */
const SESSION_KEYS = {
  genRunning: 'nova.genRunning.v1',
  genStartedAt: 'nova.genStartedAt.v1',
  streamIds: 'nova.streamIds.v1',
  contextIds: 'nova.contextIds.v1',
} as const;

/**
 * THE LAST BROWSER KEY — read once, to hand to the device, then erased (see
 * readLegacyConversations / clearLegacyConversations). Nothing writes it any
 * more. Kept named so that any lingering browser storage stays greppable.
 */
const BROWSER_CACHE_KEYS = {
  conversations: 'nova.conversations.v1',
} as const;


const DEVICE_ENDPOINT = '/api/ui-state';
/** Coalesce a burst of preference changes into one patch. */
const PUT_DEBOUNCE_MS = 400;
/** P3: sustained writes still flush at least this often (max-wait cap). */
const PUT_MAX_WAIT_MS = 2_000;

let deviceState: Record<string, unknown> = {};
/** Keys changed since the last successful patch — the only thing we send. */
const dirtyKeys = new Set<string>();
let putTimer: number | null = null;
/** When the CURRENT burst began (trailing-debounce max-wait bookkeeping). */
let putBurstStartedAt = 0;
let deviceReachable = true;

/**
 * Load the device's client state. Called ONCE from main.tsx, awaited before the
 * first render, so the first paint already carries the real theme/zoom instead
 * of flashing the defaults.
 *
 * A failure is NOT fatal and NOT silent: the session runs on in-memory defaults
 * and `uiStateReachable()` stays false so the UI can say so. There is no
 * browser copy to fall back to by design — pretending otherwise is how a user
 * ends up "saving" preferences that go nowhere.
 */
export async function bootUiState(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const response = await fetch(DEVICE_ENDPOINT, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { state?: unknown };
    if (payload.state && typeof payload.state === 'object' && !Array.isArray(payload.state)) {
      deviceState = { ...(payload.state as Record<string, unknown>) };
    }
    deviceReachable = true;
  } catch {
    deviceReachable = false;
  }
}

/** False when boot could not reach the device (no fallback copy exists). */
export function uiStateReachable(): boolean {
  return deviceReachable;
}

/**
 * The browser keys a previous version wrote, and where each one now lives on
 * the device. Kept as one list so adoption and cleanup can never disagree.
 */
const LEGACY_BROWSER_KEYS: Array<[legacy: string, device: string]> = [
  ['nova.activeConversation.v1', DEVICE_KEYS.activeId],
  ['nova.theme.v1', DEVICE_KEYS.theme],
  ['nova.sidebarCollapsed.v1', DEVICE_KEYS.sidebar],
  ['nova.defaults.v1', DEVICE_KEYS.defaults],
  ['nova.savedPrompts.v1', DEVICE_KEYS.savedPrompts],
  ['nova.fontScale.v1', DEVICE_KEYS.fontScale],
  ['nova.contextScale.v1', DEVICE_KEYS.contextScale],
  ['nova.providerId.v1', DEVICE_KEYS.providerId],
  ['nova.model.v1', DEVICE_KEYS.model],
  ['nova.fontFamily.v1', DEVICE_KEYS.fontFamily],
  ['nova.imageStudio.v1', DEVICE_KEYS.imageStudio],
  ['nova.imageSession.v1', DEVICE_KEYS.imageSession],
  ['nova.jobRuns.v1', DEVICE_KEYS.jobRuns],
  ['dashboard.usage.providers', DEVICE_KEYS.dashboardUsageProviders],
  ['dashboard.usage.window', DEVICE_KEYS.dashboardUsageWindow],
];

/** The legacy key map, for the provider-key migration (see lib/providerKeys). */
const LEGACY_PROVIDER_KEYS = 'nova.providerKeys.v1';

/**
 * One-shot migration: adopt values a previous version left in localStorage.
 * Runs AFTER bootUiState, so a value the device already holds always wins and
 * this can only fill gaps. The browser keys are NOT deleted here — that waits
 * for the patch to be acknowledged (see flushUiState), because deleting first
 * would lose the value if the device were unreachable.
 */
export function adoptLegacyBrowserState(): void {
  if (typeof window === 'undefined') return;
  let adopted = 0;
  for (const [legacyKey, deviceKey] of LEGACY_BROWSER_KEYS) {
    if (deviceState[deviceKey] !== undefined) continue;
    try {
      const raw = localStorage.getItem(legacyKey);
      if (raw === null) continue;
      deviceState[deviceKey] = JSON.parse(raw) as unknown;
      dirtyKeys.add(deviceKey);
      adopted += 1;
    } catch {
    }
  }
  if (adopted > 0) scheduleFlush();
}

/** Drop the adopted browser keys. Only ever called once they are on the device. */
function clearLegacyBrowserKeys(): void {
  if (typeof window === 'undefined') return;
  for (const [legacyKey] of LEGACY_BROWSER_KEYS) {
    try {
      localStorage.removeItem(legacyKey);
    } catch {
    }
  }
}

/**
 * The provider keys a previous version kept in the browser. READ ONLY — the
 * erase is a separate step (clearLegacyProviderKeys) because a key must never
 * be dropped from the only place that holds it before the device vault has
 * accepted it. A secret is the one thing here that cannot be re-derived.
 */
export function readLegacyProviderKeys(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LEGACY_PROVIDER_KEYS);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const keys: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) keys[id] = value.trim();
    }
    return keys;
  } catch {
    return {};
  }
}

/** Erase the legacy browser key map. Only ever called once it is in the vault. */
export function clearLegacyProviderKeys(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(LEGACY_PROVIDER_KEYS);
  } catch {
  }
}

function read<T>(key: string, fallback: T): T {
  const value = deviceState[key];
  return value === undefined ? fallback : (value as T);
}

function write(key: string, value: unknown): void {
  deviceState[key] = value;
  dirtyKeys.add(key);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (putBurstStartedAt === 0 || now - putBurstStartedAt >= PUT_MAX_WAIT_MS) {
    putBurstStartedAt = now;
  }
  if (putTimer !== null) window.clearTimeout(putTimer);
  const wait = Math.max(0, Math.min(PUT_DEBOUNCE_MS, PUT_MAX_WAIT_MS - (now - putBurstStartedAt)));
  putTimer = window.setTimeout(() => {
    putTimer = null;
    putBurstStartedAt = 0;
    void flushUiState();
  }, wait);
}

/**
 * Send the pending keys to the device. The patch carries ONLY what changed, so
 * a stale tab can never revert a preference another tab just set.
 */
export async function flushUiState(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (dirtyKeys.size === 0) return;
  const patch: Record<string, unknown> = {};
  for (const key of dirtyKeys) patch[key] = deviceState[key] ?? null;
  const sent = [...dirtyKeys];
  try {
    const response = await fetch(DEVICE_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    for (const key of sent) dirtyKeys.delete(key);
    deviceReachable = true;
    clearLegacyBrowserKeys();
  } catch {
    deviceReachable = false;
  }
}

/**
 * UNLOAD-SAFE flush — `navigator.sendBeacon` survives the page teardown that
 * cancels a `fetch` fired from pagehide. Exit-moment saves (the scroll anchor)
 * MUST use this: a plain flushUiState() at unload can silently drop the write.
 */
export function flushUiStateBeacon(): void {
  if (typeof window === 'undefined') return;
  if (dirtyKeys.size === 0) return;
  const patch: Record<string, unknown> = {};
  for (const key of dirtyKeys) patch[key] = deviceState[key] ?? null;
  try {
    const ok = navigator.sendBeacon(
      DEVICE_ENDPOINT,
      new Blob([JSON.stringify({ patch })], { type: 'application/json' }),
    );
    // Keep the keys dirty when the beacon was rejected (quota) — a later
    // flush can still retry.
    if (ok) dirtyKeys.clear();
  } catch {
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    flushUiStateBeacon();
  });
}


function readSession<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeSession(key: string, value: unknown): void {
  try {
    if (value && typeof value === 'object' && Object.keys(value).length > 0) {
      sessionStorage.setItem(key, JSON.stringify(value));
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {
  }
}


function readBrowserCache<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}


/**
 * The browser's conversation cache from before the device became the only
 * store. READ ONLY, and only until the migration has pushed it up: this was
 * the sole copy of those chats for any browser that had not synced them, so
 * dropping it before the device acknowledges them would lose them for good.
 */
export function readLegacyConversations(): Conversation[] {
  if (typeof window === 'undefined') return [];
  return readBrowserCache<Conversation[]>(BROWSER_CACHE_KEYS.conversations, []).map(
    normalizeStoredConversation,
  );
}

/** Erase the legacy cache. Only ever called once the device holds the records. */
export function clearLegacyConversations(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(BROWSER_CACHE_KEYS.conversations);
  } catch {
  }
}

/**
 * Bring a record persisted by an older version up to the current settings
 * shape. Applied to the legacy browser cache on its way to the device, so a
 * thread written before (say) probation existed does not arrive with a hole
 * where the wire expects a value.
 */
function normalizeStoredConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    settings: {
      ...conversation.settings,
        fetchWeb:
          conversation.settings?.fetchWeb ??
          typeof (conversation.settings as { urlContext?: unknown } | undefined)?.urlContext === 'string',
        webAccess: conversation.settings?.webAccess === true,
        useMcp:
          conversation.settings?.useMcp ??
          (conversation.settings as { functionCalling?: unknown } | undefined)?.functionCalling === true,
        agentMode: conversation.settings?.agentMode ?? false,
        terminalMode: conversation.settings?.terminalMode ?? 'auto',
        confirmDeletes: conversation.settings?.confirmDeletes ?? false,
        maxContextTokens: conversation.settings?.maxContextTokens ?? null,
        autoCompact: conversation.settings?.autoCompact ?? true,
        compactThresholdTokens: conversation.settings?.compactThresholdTokens ?? null,
        compactKeepRecentTurns: conversation.settings?.compactKeepRecentTurns ?? 2,
        enforcement:
          conversation.settings?.enforcement ?? {
            level: conversation.settings?.lockdown?.active ? 4 : 0,
            mode: 'manual',
            message: conversation.settings?.lockdown?.message ?? '',
          },
        lockdown:
          conversation.settings?.lockdown ?? {
            active: (conversation.settings?.enforcement?.level ?? 0) >= 4,
            message: conversation.settings?.enforcement?.message ?? '',
          },
        probation: conversation.settings?.probation ?? { enabled: false },
      },
  };
}

export const storage = {
  loadActiveId: (): string | null => read<string | null>(DEVICE_KEYS.activeId, null),
  saveActiveId: (id: string | null): void => write(DEVICE_KEYS.activeId, id),

  loadTheme: (): 'dark' | 'light' | 'mocha' =>
    read<'dark' | 'light' | 'mocha'>(DEVICE_KEYS.theme, 'dark') || 'dark',
  saveTheme: (theme: 'dark' | 'light' | 'mocha'): void => write(DEVICE_KEYS.theme, theme),

  loadSidebarCollapsed: (): boolean => read<boolean>(DEVICE_KEYS.sidebar, false),
  saveSidebarCollapsed: (collapsed: boolean): void => write(DEVICE_KEYS.sidebar, collapsed),

  /** Resizable panel widths — clamped on write; drag handlers re-clamp too. */
  loadSidebarWidth: (): number => read<number>(DEVICE_KEYS.sidebarWidth, 248),
  saveSidebarWidth: (width: number): void => write(DEVICE_KEYS.sidebarWidth, width),
  loadSettingsWidth: (): number => read<number>(DEVICE_KEYS.settingsWidth, 300),
  saveSettingsWidth: (width: number): void => write(DEVICE_KEYS.settingsWidth, width),

  loadDefaults: (): Partial<ProviderDraft> => read<Partial<ProviderDraft>>(DEVICE_KEYS.defaults, {}),
  saveDefaults: (defaults: Partial<ProviderDraft>): void => write(DEVICE_KEYS.defaults, defaults),

  /** User-saved system prompts, applied from the Configuration panel. */
  loadSavedPrompts: (): SavedPrompt[] => read<SavedPrompt[]>(DEVICE_KEYS.savedPrompts, []),
  saveSavedPrompts: (prompts: SavedPrompt[]): void => write(DEVICE_KEYS.savedPrompts, prompts),

  /** Dashboard usage preferences — device, never localStorage (privacy 2026-10). */
  loadDashboardUsageWindow: (): string => read<string>(DEVICE_KEYS.dashboardUsageWindow, '30d'),
  saveDashboardUsageWindow: (value: string): void => write(DEVICE_KEYS.dashboardUsageWindow, value),
  loadDashboardUsageProviders: (): string[] =>
    read<string[]>(DEVICE_KEYS.dashboardUsageProviders, []),
  saveDashboardUsageProviders: (ids: string[]): void =>
    write(DEVICE_KEYS.dashboardUsageProviders, ids),

  /** Left-sidebar dropdowns — remember open/closed exactly as the user left it. */
  loadSidebarSections: (): SidebarSections =>
    read<SidebarSections>(DEVICE_KEYS.sidebarSections, {}),
  saveSidebarSections: (sections: SidebarSections): void =>
    write(DEVICE_KEYS.sidebarSections, sections),

  /** G1: right-dock open flag — TRI-STATE: null = never saved → the caller's
   *  first-run default (matchMedia) applies; false/true = the user's last
   *  actual condition, restored verbatim. */
  loadSettingsOpen: (): boolean | null => read<boolean | null>(DEVICE_KEYS.settingsOpen, null),
  saveSettingsOpen: (open: boolean): void => write(DEVICE_KEYS.settingsOpen, open),

  /** G2: active top-level view — validated against the ViewId allowlist. */
  loadView: (): ViewId => {
    const value = read<string>(DEVICE_KEYS.view, 'playground');
    return VIEW_IDS.includes(value as ViewId) ? (value as ViewId) : 'playground';
  },
  saveView: (view: ViewId): void => write(DEVICE_KEYS.view, view),

  /** G3/G4: diff dock width (px) + turn scope (null = all turns). */
  loadDiffDockWidth: (): number => read<number>(DEVICE_KEYS.diffDockWidth, 760),
  saveDiffDockWidth: (width: number): void => write(DEVICE_KEYS.diffDockWidth, width),
  loadDiffPanelTurnId: (): string | null => read<string | null>(DEVICE_KEYS.diffPanelTurnId, null),
  saveDiffPanelTurnId: (turnId: string | null): void => write(DEVICE_KEYS.diffPanelTurnId, turnId),

  /** G5: scroll anchors per conversation — refresh reopens where you left.
   *  Capped LRU-style (50) so the map cannot grow forever. */
  loadViewAnchor: (conversationId: string): ViewAnchor | null =>
    read<Record<string, ViewAnchor>>(DEVICE_KEYS.viewAnchors, {})[conversationId] ?? null,
  saveViewAnchor: (conversationId: string, anchor: ViewAnchor): void => {
    const all = read<Record<string, ViewAnchor>>(DEVICE_KEYS.viewAnchors, {});
    all[conversationId] = anchor;
    const ids = Object.keys(all);
    if (ids.length > 50) {
      ids.sort((a, b) => (all[b].savedAt ?? 0) - (all[a].savedAt ?? 0))
        .slice(50)
        .forEach((id) => { delete all[id]; });
    }
    write(DEVICE_KEYS.viewAnchors, all);
  },

  /** UI zoom applied to the workspace content (1 = default size). */
  loadFontScale: (): number => read<number>(DEVICE_KEYS.fontScale, 0.9),
  saveFontScale: (scale: number): void => write(DEVICE_KEYS.fontScale, scale),

  loadContextScale: (): number => read<number>(DEVICE_KEYS.contextScale, 0.85),
  saveContextScale: (scale: number): void => write(DEVICE_KEYS.contextScale, scale),

  /** The provider/model the user picked — kept across reloads, on the device. */
  loadProviderId: (): string => read<string>(DEVICE_KEYS.providerId, ''),
  saveProviderId: (id: string): void => write(DEVICE_KEYS.providerId, id),
  loadModel: (): string => read<string>(DEVICE_KEYS.model, ''),
  saveModel: (model: string): void => write(DEVICE_KEYS.model, model),

  /**
   * Conversations that had a generation in flight when the tab reloaded.
   * With the server-side stream registry a reload does NOT kill the run —
   * these entries tell the boot reconcile which conversations to re-attach
   * (see useChatController). Entries must still be re-validated against
   * live stream ids: a proxy restart really does drop the run.
   */
  loadGenRunning: (): Record<string, boolean> =>
    readSession<Record<string, boolean>>(SESSION_KEYS.genRunning, {}),
  saveGenRunning: (running: Record<string, boolean>): void =>
    writeSession(SESSION_KEYS.genRunning, running),

  /**
   * Run start epoch per conversation — the response timer's live clock reads
   * `Date.now() - start`. Session-persisted alongside genRunning so a browser
   * reload continues the SAME elapsed time instead of restarting at 00.00.00.
   */
  loadGenStartedAt: (): Record<string, number> =>
    readSession<Record<string, number>>(SESSION_KEYS.genStartedAt, {}),
  saveGenStartedAt: (started: Record<string, number>): void =>
    writeSession(SESSION_KEYS.genStartedAt, started),

  /**
   * Counterpart of streamIds — see there for the lifecycle rationale. The
   * CONTEXT ID keys the read-before-edit policy: it survives a reload (the
   * conversation keeps its read receipts) and dies with the tab, after
   * which the next send mints a fresh id and the server voids old receipts
   * (a re-opened chat must re-read before editing).
   */
  loadContextIds: (): Record<string, string> =>
    readSession<Record<string, string>>(SESSION_KEYS.contextIds, {}),
  saveContextId: (conversationId: string, id: string): void => {
    const map = readSession<Record<string, string>>(SESSION_KEYS.contextIds, {});
    map[conversationId] = id;
    writeSession(SESSION_KEYS.contextIds, map);
  },

  /**
   * RESUME handles: the `stream_id` frame each running generation echoes,
   * keyed by conversation. sessionStorage on purpose — it survives a reload
   * (the exact case resume exists for) and dies with the tab, after which
   * nobody would re-attach anyway.
   */
  loadStreamIds: (): Record<string, StreamResumeRecord> =>
    readSession<Record<string, StreamResumeRecord>>(SESSION_KEYS.streamIds, {}),
  saveStreamId: (conversationId: string, record: StreamResumeRecord): void => {
    const map = readSession<Record<string, StreamResumeRecord>>(SESSION_KEYS.streamIds, {});
    map[conversationId] = record;
    writeSession(SESSION_KEYS.streamIds, map);
  },
  clearStreamId: (conversationId: string): void => {
    const map = readSession<Record<string, StreamResumeRecord>>(SESSION_KEYS.streamIds, {});
    if (map[conversationId]) {
      delete map[conversationId];
      writeSession(SESSION_KEYS.streamIds, map);
    }
  },

  /**
   * DURABLE RUNS — the client half of the job journal (see
   * docs/ARCHITECTURE.md). Now on the DEVICE: an interrupted run must
   * survive a tab close or a browser restart, and the browser is no longer a
   * place where anything survives. Keyed by conversation, since that is what
   * the UI surfaces.
   */
  loadJobRuns: (): Record<string, JobRunRecord> => read<Record<string, JobRunRecord>>(DEVICE_KEYS.jobRuns, {}),
  saveJobRun: (conversationId: string, record: JobRunRecord): void => {
    const map = read<Record<string, JobRunRecord>>(DEVICE_KEYS.jobRuns, {});
    map[conversationId] = record;
    write(DEVICE_KEYS.jobRuns, map);
  },
  clearJobRun: (conversationId: string): void => {
    const map = read<Record<string, JobRunRecord>>(DEVICE_KEYS.jobRuns, {});
    if (map[conversationId]) {
      delete map[conversationId];
      write(DEVICE_KEYS.jobRuns, map);
    }
  },

  /** Workspace font style chosen in Settings → Appearance. */
  loadFontFamily: (): FontFamily => {
    const value = read<FontFamily>(DEVICE_KEYS.fontFamily, 'inter');
    return value === 'mono' || value === 'system' ? value : 'inter';
  },
  saveFontFamily: (family: FontFamily): void => write(DEVICE_KEYS.fontFamily, family),
  /**
   * Image Studio's own provider/model choice plus the output-size test
   * settings, separate from the chat ones.
   */
  loadImageStudioModel: (): {
    providerId: string;
    model: string;
    sizeMode: ImageSizeMode;
    aspectRatio: string;
    pixelWidth: string;
    pixelHeight: string;
  } => {
    const raw = read<
      Partial<{
        providerId: string;
        model: string;
        sizeMode: ImageSizeMode;
        aspectRatio: string;
        pixelWidth: string;
        pixelHeight: string;
      }>
    >(DEVICE_KEYS.imageStudio, {});
    return {
      providerId: raw.providerId ?? '',
      model: raw.model ?? '',
      sizeMode: raw.sizeMode ?? 'off',
      aspectRatio: raw.aspectRatio ?? '1:1',
      pixelWidth: raw.pixelWidth ?? '1024',
      pixelHeight: raw.pixelHeight ?? '1024',
    };
  },
  saveImageStudioModel: (value: {
    providerId: string;
    model: string;
    sizeMode: ImageSizeMode;
    aspectRatio: string;
    pixelWidth: string;
    pixelHeight: string;
  }): void => write(DEVICE_KEYS.imageStudio, value),

  /** The Image Studio session the user is currently working in. */
  loadActiveImageSessionId: (): string | null => read<string | null>(DEVICE_KEYS.imageSession, null),
  saveActiveImageSessionId: (id: string | null): void => write(DEVICE_KEYS.imageSession, id),


  loadTreePanelOpen: (): boolean => read<boolean>(DEVICE_KEYS.treePanelOpen, false),
  saveTreePanelOpen: (open: boolean): void => write(DEVICE_KEYS.treePanelOpen, open),

  loadTreePanelGeometry: (): { x: number; y: number; w: number; h: number } | null =>
    read<{ x: number; y: number; w: number; h: number } | null>(DEVICE_KEYS.treePanelGeometry, null),
  saveTreePanelGeometry: (geometry: { x: number; y: number; w: number; h: number }): void =>
    write(DEVICE_KEYS.treePanelGeometry, geometry),

  loadRightPanelMode: (): 'config' | 'tree' | 'addons' | 'diff' =>
    read<'config' | 'tree' | 'addons' | 'diff'>(DEVICE_KEYS.rightPanelMode, 'config'),
  saveRightPanelMode: (mode: 'config' | 'tree' | 'addons' | 'diff'): void =>
    write(DEVICE_KEYS.rightPanelMode, mode),


  /** One visual's manual sizing state. `autoFit` distinguishes "the user took
   *  control" (persisted height) from "content-driven" (no entry needed). */
  loadVisualGeometry: (
    visualId: string,
  ): { width: number | null; height: number; autoFit: boolean } | null => {
    const map = read<Record<string, { width: number | null; height: number; autoFit: boolean }> | undefined>(
      DEVICE_KEYS.visualGeometry,
      undefined,
    );
    return map?.[visualId] ?? null;
  },
  saveVisualGeometry: (
    visualId: string,
    geometry: { width: number | null; height: number; autoFit: boolean },
  ): void => {
    // VISUAL v2: an edit-in-place/re-pick replaces the id's key in place (the
    // spread keeps the NEWEST geometry; Object.entries would keep the OLD).
    const map = read<Record<string, { width: number | null; height: number; autoFit: boolean }> | undefined>(
      DEVICE_KEYS.visualGeometry,
      undefined,
    );
    const next = { ...(map ?? {}), [visualId]: geometry };
    const trimmed = Object.fromEntries(Object.entries(next).slice(-40));
    write(DEVICE_KEYS.visualGeometry, trimmed);
  },
};

/** One live generation's resume handle, keyed by conversation in sessionStorage. */
export interface StreamResumeRecord {
  streamId: string;
  providerId: string;
  model: string;
  /** Date.now() at the moment the id was captured — boot staleness guard. */
  at: number;
}

/**
 * The client's mirror of the durable job journal: the interrupted runs this
 * client knows about, keyed by conversation id. Device-backed because it must
 * outlive the tab it started in.
 */
export interface JobRunRecord {
  /** The journal run id — == the stream id the run carried. */
  runId: string;
  status: 'running' | 'completed' | 'errored' | 'aborted' | 'crashed';
  /** Date.now() when the client learned of this run (the stream_id frame). */
  at: number;
}

/** Creates a reasonably unique id without pulling in a dependency. */
export function uid(prefix = 'id'): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/** Derives a short, human-readable conversation title from its first message. */
export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'New chat';
  return cleaned.length > 52 ? `${cleaned.slice(0, 52).trimEnd()}…` : cleaned;
}
