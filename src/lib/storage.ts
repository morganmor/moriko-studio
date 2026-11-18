import type {
  Accent,
  ChatSettings,
  Conversation,
  Density,
  FontFamily,
  ImageSizeMode,
  ProviderDraft,
  SavedPrompt,
  ThemeMode,
  ViewId,
} from '../types';


export interface SidebarSections {
  chat?: boolean;
  image?: boolean;
  workspace?: boolean;
  recent?: boolean;
  
  expanded?: string | null;
}


export interface ViewAnchor {
  turnId: string;
  
  offset: number;
  savedAt: number;
}


const VIEW_IDS: readonly ViewId[] = ['playground', 'history', 'imagehistory', 'gallery', 'dashboard', 'imagestudio', 'addons'];

function isValidViewId(value: string): value is ViewId {
  return VIEW_IDS.includes(value as ViewId) || /^addon:[a-z0-9][a-z0-9-]*\/[\w.-]+$/.test(value);
}




const DEVICE_KEYS = {
  activeId: 'activeId',
  theme: 'theme',
  
  accent: 'accent',
  density: 'density',
  ambient: 'ambient',
  reduceMotion: 'reduceMotion',
  confirmDel: 'confirmDel',
  sidebar: 'sidebarCollapsed',
  
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
  
  rightPanelMode: 'rightPanelMode',
  
  visualGeometry: 'visualGeometry',
  
  dashboardUsageWindow: 'dashboardUsageWindow',
  dashboardUsageProviders: 'dashboardUsageProviders',
  
  sidebarSections: 'sidebarSections',
  
  settingsOpen: 'settingsOpen',
  view: 'view',
  diffDockWidth: 'diffDockWidth',
  diffPanelTurnId: 'diffPanelTurnId',
  
  viewAnchors: 'viewAnchors',
  pendingSettings: 'pendingSettings',
} as const;


const SESSION_KEYS = {
  genRunning: 'nova.genRunning.v1',
  genStartedAt: 'nova.genStartedAt.v1',
  streamIds: 'nova.streamIds.v1',
  contextIds: 'nova.contextIds.v1',
} as const;


const BROWSER_CACHE_KEYS = {
  conversations: 'nova.conversations.v1',
} as const;


const DEVICE_ENDPOINT = '/api/ui-state';

const PUT_DEBOUNCE_MS = 400;

const PUT_MAX_WAIT_MS = 2_000;

let deviceState: Record<string, unknown> = {};

const dirtyKeys = new Set<string>();
let putTimer: number | null = null;

let putBurstStartedAt = 0;
let deviceReachable = true;


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


export function uiStateReachable(): boolean {
  return deviceReachable;
}


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


const LEGACY_PROVIDER_KEYS = 'nova.providerKeys.v1';


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


function clearLegacyBrowserKeys(): void {
  if (typeof window === 'undefined') return;
  for (const [legacyKey] of LEGACY_BROWSER_KEYS) {
    try {
      localStorage.removeItem(legacyKey);
    } catch {
    }
  }
}


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

function writeImmediate(key: string, value: unknown): void {
  deviceState[key] = value;
  dirtyKeys.add(key);
  if (putTimer !== null) {
    window.clearTimeout(putTimer);
    putTimer = null;
  }
  putBurstStartedAt = 0;
  void flushUiState();
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


export async function flushUiState(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (dirtyKeys.size === 0) return;
  const patch: Record<string, unknown> = {};
  for (const key of dirtyKeys) patch[key] = deviceState[key] ?? null;
  try {
    const response = await fetch(DEVICE_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    for (const [key, sentValue] of Object.entries(patch)) {
      const currentValue = deviceState[key] ?? null;
      if (Object.is(currentValue, sentValue)) dirtyKeys.delete(key);
    }
    deviceReachable = true;
    clearLegacyBrowserKeys();
    if (dirtyKeys.size > 0) void flushUiState();
  } catch {
    deviceReachable = false;
  }
}


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



export function readLegacyConversations(): Conversation[] {
  if (typeof window === 'undefined') return [];
  return readBrowserCache<Conversation[]>(BROWSER_CACHE_KEYS.conversations, []).map(
    normalizeStoredConversation,
  );
}


export function clearLegacyConversations(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(BROWSER_CACHE_KEYS.conversations);
  } catch {
  }
}


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
        agentWorkflow: conversation.settings?.agentWorkflow ?? '',
        terminalMode: conversation.settings?.terminalMode ?? 'auto',
        confirmDeletes: conversation.settings?.confirmDeletes ?? true,
        maxContextTokens: conversation.settings?.maxContextTokens ?? null,
        autoCompact: conversation.settings?.autoCompact ?? true,
        compactThresholdTokens: conversation.settings?.compactThresholdTokens ?? null,
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
  saveActiveId: (id: string | null): void => writeImmediate(DEVICE_KEYS.activeId, id),

  loadTheme: (): ThemeMode => {
    const value = read<string>(DEVICE_KEYS.theme, 'dark');
    return value === 'light' || value === 'mocha' || value === 'system' ? value : 'dark';
  },
  saveTheme: (theme: ThemeMode): void => write(DEVICE_KEYS.theme, theme),

  
  loadAccent: (): Accent => {
    const value = read<string>(DEVICE_KEYS.accent, 'ember');
    return value === 'sakura' || value === 'matcha' || value === 'ocean' || value === 'violet'
      ? value
      : 'ember';
  },
  saveAccent: (accent: Accent): void => write(DEVICE_KEYS.accent, accent),

  
  loadDensity: (): Density =>
    read<string>(DEVICE_KEYS.density, 'comfy') === 'compact' ? 'compact' : 'comfy',
  saveDensity: (density: Density): void => write(DEVICE_KEYS.density, density),

  
  loadAmbient: (): boolean => read<unknown>(DEVICE_KEYS.ambient, true) !== false,
  saveAmbient: (ambient: boolean): void => write(DEVICE_KEYS.ambient, ambient),

  
  loadReduceMotion: (): boolean | null => {
    const value = read<unknown>(DEVICE_KEYS.reduceMotion, null);
    return typeof value === 'boolean' ? value : null;
  },
  saveReduceMotion: (reduceMotion: boolean | null): void =>
    write(DEVICE_KEYS.reduceMotion, reduceMotion),

  
  loadConfirmDel: (): boolean => read<unknown>(DEVICE_KEYS.confirmDel, false) === true,
  saveConfirmDel: (confirmDel: boolean): void => write(DEVICE_KEYS.confirmDel, confirmDel),

  loadSidebarCollapsed: (): boolean => read<boolean>(DEVICE_KEYS.sidebar, false),
  saveSidebarCollapsed: (collapsed: boolean): void => write(DEVICE_KEYS.sidebar, collapsed),

  
  loadSidebarWidth: (): number => Math.max(260, read<number>(DEVICE_KEYS.sidebarWidth, 260)),
  saveSidebarWidth: (width: number): void => write(DEVICE_KEYS.sidebarWidth, width),
  loadSettingsWidth: (): number => read<number>(DEVICE_KEYS.settingsWidth, 340),
  saveSettingsWidth: (width: number): void => write(DEVICE_KEYS.settingsWidth, width),

  loadDefaults: (): Partial<ProviderDraft> => read<Partial<ProviderDraft>>(DEVICE_KEYS.defaults, {}),
  saveDefaults: (defaults: Partial<ProviderDraft>): void => write(DEVICE_KEYS.defaults, defaults),

  
  loadSavedPrompts: (): SavedPrompt[] => read<SavedPrompt[]>(DEVICE_KEYS.savedPrompts, []),
  saveSavedPrompts: (prompts: SavedPrompt[]): void => write(DEVICE_KEYS.savedPrompts, prompts),

  
  loadDashboardUsageWindow: (): string => read<string>(DEVICE_KEYS.dashboardUsageWindow, '30d'),
  saveDashboardUsageWindow: (value: string): void => write(DEVICE_KEYS.dashboardUsageWindow, value),
  loadDashboardUsageProviders: (): string[] =>
    read<string[]>(DEVICE_KEYS.dashboardUsageProviders, []),
  saveDashboardUsageProviders: (ids: string[]): void =>
    write(DEVICE_KEYS.dashboardUsageProviders, ids),

  
  loadSidebarSections: (): SidebarSections =>
    read<SidebarSections>(DEVICE_KEYS.sidebarSections, {}),
  saveSidebarSections: (sections: SidebarSections): void =>
    write(DEVICE_KEYS.sidebarSections, sections),

  
  loadSettingsOpen: (): boolean | null => read<boolean | null>(DEVICE_KEYS.settingsOpen, null),
  saveSettingsOpen: (open: boolean): void => write(DEVICE_KEYS.settingsOpen, open),

  
  loadView: (): ViewId => {
    const value = read<string>(DEVICE_KEYS.view, 'playground');
    return isValidViewId(value) ? (value as ViewId) : 'playground';
  },
  saveView: (view: ViewId): void => write(DEVICE_KEYS.view, view),

  
  loadDiffDockWidth: (): number => read<number>(DEVICE_KEYS.diffDockWidth, 760),
  saveDiffDockWidth: (width: number): void => write(DEVICE_KEYS.diffDockWidth, width),
  loadDiffPanelTurnId: (): string | null => read<string | null>(DEVICE_KEYS.diffPanelTurnId, null),
  saveDiffPanelTurnId: (turnId: string | null): void => write(DEVICE_KEYS.diffPanelTurnId, turnId),

  
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

  
  loadFontScale: (): number => read<number>(DEVICE_KEYS.fontScale, 0.9),
  saveFontScale: (scale: number): void => write(DEVICE_KEYS.fontScale, scale),

  loadContextScale: (): number => read<number>(DEVICE_KEYS.contextScale, 0.85),
  saveContextScale: (scale: number): void => write(DEVICE_KEYS.contextScale, scale),

  
  loadProviderId: (): string => read<string>(DEVICE_KEYS.providerId, ''),
  saveProviderId: (id: string): void => writeImmediate(DEVICE_KEYS.providerId, id),
  loadModel: (): string => read<string>(DEVICE_KEYS.model, ''),
  saveModel: (model: string): void => writeImmediate(DEVICE_KEYS.model, model),

  loadPendingSettings: (): Partial<ChatSettings> | null =>
    read<Partial<ChatSettings> | null>(DEVICE_KEYS.pendingSettings, null),
  savePendingSettings: (settings: ChatSettings): void =>
    writeImmediate(DEVICE_KEYS.pendingSettings, settings),

  
  loadGenRunning: (): Record<string, boolean> =>
    readSession<Record<string, boolean>>(SESSION_KEYS.genRunning, {}),
  saveGenRunning: (running: Record<string, boolean>): void =>
    writeSession(SESSION_KEYS.genRunning, running),

  
  loadGenStartedAt: (): Record<string, number> =>
    readSession<Record<string, number>>(SESSION_KEYS.genStartedAt, {}),
  saveGenStartedAt: (started: Record<string, number>): void =>
    writeSession(SESSION_KEYS.genStartedAt, started),

  
  loadContextIds: (): Record<string, string> =>
    readSession<Record<string, string>>(SESSION_KEYS.contextIds, {}),
  saveContextId: (conversationId: string, id: string): void => {
    const map = readSession<Record<string, string>>(SESSION_KEYS.contextIds, {});
    map[conversationId] = id;
    writeSession(SESSION_KEYS.contextIds, map);
  },

  
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

  
  loadFontFamily: (): FontFamily => {
    const value = read<FontFamily>(DEVICE_KEYS.fontFamily, 'inter');
    return value === 'mono' || value === 'system' ? value : 'inter';
  },
  saveFontFamily: (family: FontFamily): void => write(DEVICE_KEYS.fontFamily, family),
  
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
    const map = read<Record<string, { width: number | null; height: number; autoFit: boolean }> | undefined>(
      DEVICE_KEYS.visualGeometry,
      undefined,
    );
    const next = { ...(map ?? {}), [visualId]: geometry };
    const trimmed = Object.fromEntries(Object.entries(next).slice(-40));
    write(DEVICE_KEYS.visualGeometry, trimmed);
  },
};


export interface StreamResumeRecord {
  streamId: string;
  providerId: string;
  model: string;
  
  at: number;
}


export interface JobRunRecord {
  
  runId: string;
  status: 'running' | 'completed' | 'errored' | 'aborted' | 'crashed';
  
  at: number;
}


export function uid(prefix = 'id'): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}


export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'New chat';
  return cleaned.length > 52 ? `${cleaned.slice(0, 52).trimEnd()}…` : cleaned;
}
