import { create } from 'zustand';

import { makeNotice, reduceNotices, type MessageId, type MessageTone, type NoticeEntry } from '../lib/messageCatalog';
import type {
  AgentPermissionRequest,
  AskAnswer,
  AskUserRequest,
  OperatorGateRequest,
  AgentWorkspaceInfo,
  Accent,
  ChatSettings,
  Conversation,
  ConversationCompaction,
  ConversationSummary,
  Density,
  FontFamily,
  Goal,
  ImageSession,
  ImageSessionItem,
  ImageSizeMode,
  LiveContextTelemetry,
  ModelMeta,
  ProviderPublic,
  Todo,
  TreeDelta,
  TreeIgnoreRules,
  TreeNodeInfo,
  TreeViewInfo,
  ThemeMode,
  Turn,
  TurnPatch,
  ViewId,
} from '../types';
import { transitionAppearance } from '../lib/appearance';
import { clearLegacyConversations, readLegacyConversations, storage, uid } from '../lib/storage';
import { abortCompaction, stripReasoning } from '../lib/compaction';
import { lookupModelMeta } from '../lib/modelMeta';
import { resolveForProvider, type ResolvedModelCapability } from '../lib/modelCapability';
import { setWebAccessRemote } from '../lib/api';
import { isGhostTurn, withSegmentIds } from '../lib/turns';
import {
  beaconSyncConversations,
  fetchConversationDetail,
  fetchConversationSummaries,
  patchConversationConfig,
  syncConversations,
  type ConversationConfigPatchPayload,
} from '../lib/api';

export const DEFAULT_SETTINGS: ChatSettings = {
  systemInstruction: '',
  thinkingLevel: 'medium',
  temperature: 1,
  
  maxOutputTokens: null,
  topP: 0.95,
  structuredOutputs: false,
  useMcp: false,
  agentMode: false,
  agentWorkflow: '',
  terminalMode: 'auto',
  confirmDeletes: true,
  fetchWeb: false,
  
  webAccess: false,
  maxContextTokens: null,
  autoCompact: true,
  compactThresholdTokens: null,
  compactThresholdRatio: 0.95,
  summarizerEnabled: false,
  summarizerProviderId: null,
  summarizerModel: null,
  enforcement: { level: 0, mode: 'manual', message: '' },
  probation: { enabled: false },
};

interface AppState {
  providers: ProviderPublic[];
  providersLoading: boolean;
  providersError: string | null;
  providerId: string;
  model: string;
  
  imageProviderId: string;
  imageModel: string;
  
  imageSizeMode: ImageSizeMode;
  imageAspectRatio: string;
  imagePixelWidth: string;
  imagePixelHeight: string;
  
  galleryImages: string[];

  
  imageSessions: ImageSession[];
  
  activeImageSessionId: string | null;
  
  imageRetentionDays: number | null;

  
  imageGen: {
    phase: 'idle' | 'submitting' | 'generating';
    error: string | null;
    errorAt: number | null;
    elapsed: number;
    sessionId: string | null;
  };
  startImageGeneration: (input: {
    providerId: string;
    model: string;
    prompt: string;
    apiKey?: string;
    aspectRatio?: string;
    width?: number;
    height?: number;
    
    images?: string[];
  }) => Promise<void>;
  cancelImageGeneration: () => void;
  clearImageGenError: () => void;

  
  imageReferences: string[];
  
  addImageReferences: (entries: string[]) => void;
  removeImageReference: (index: number) => void;
  replaceImageReference: (index: number, entry: string) => void;
  clearImageReferences: () => void;

  conversations: Conversation[];
  activeId: string | null;

  
  agentWorkspaces: AgentWorkspaceInfo[];
  
  activeAgentWorkspaceId: string | null;
  
  pendingPermissions: AgentPermissionRequest[];
  pushPermissionRequest: (request: AgentPermissionRequest) => void;
  removePermissionRequest: (id: string) => void;
  resolvePermissionRequest: (id: string, approve: boolean, remember: boolean, reason?: string) => Promise<void>;

  
  pendingAskUser: AskUserRequest[];
  pushAskUserRequest: (request: AskUserRequest) => void;
  removeAskUserRequest: (id: string) => void;
  
  setPendingAskUser: (requests: AskUserRequest[]) => void;
  submitAskUserAnswers: (id: string, answers: AskAnswer[]) => Promise<void>;

  
  pendingOperatorGates: OperatorGateRequest[];
  pushOperatorGate: (request: OperatorGateRequest) => void;
  removeOperatorGate: (id: string) => void;
  setPendingOperatorGates: (requests: OperatorGateRequest[]) => void;
  resolveOperatorGate: (id: string, verdict: 'accept' | 'reject', reason: string) => Promise<void>;

  
  importConversation: (conversation: Conversation) => string;

  view: ViewId;
  sidebarCollapsed: boolean;
  
  reasoningOpen: Record<string, boolean>;
  setReasoningOpen: (key: string, open: boolean) => void;
  
  sidebarWidth: number;
  
  settingsWidth: number;
  settingsOpen: boolean;
  
  rightPanelMode: 'config' | 'tree' | 'addons' | 'diff';
  
  diffPanelTurnId: string | null;
  
  diffDockWidth: number;
  theme: ThemeMode;
  
  accent: Accent;
  density: Density;
  
  ambient: boolean;
  
  reduceMotion: boolean | null;
  
  confirmDel: boolean;
  
  pendingConfirmDelete: string | null;
  
  fontScale: number;
  
  contextScale: number;
  
  fontFamily: FontFamily;
  
  modelMeta: Record<string, ModelMeta>;
  
  searchQuery: string;
  
  notices: NoticeEntry[];
  
  noticeHistory: NoticeEntry[];
  noticeHistoryExpanded: boolean;
  
  genRunning: Record<string, boolean>;
  
  compactingId: string | null;
  
  liveContext: Record<string, LiveContextTelemetry>;
  
  stoppedRuns: Record<string, true>;
  markRunStopped: (id: string) => void;
  clearRunStopped: (id: string) => void;
  
  pendingSteers: Record<string, Array<{ id: string; text: string; parts?: import('../types').TurnSteerPart[] }>>;
  
  addPendingSteer: (conversationId: string, id: string, text: string) => void;
  
  addPendingSteerParts: (conversationId: string, id: string, parts: import('../types').TurnSteerPart[]) => void;
  
  removePendingSteer: (conversationId: string, id: string) => void;
  
  clearPendingSteers: (conversationId: string) => void;
  
  crashedRuns: Record<string, { runId: string; callCount: number }>;
  
  pendingSettings: ChatSettings;

  
  addonEvent: import('../types/addonBus').AddonBusPayload | null;
  
  pushAddonEvent: (event: import('../types/addonBus').AddonBusPayload) => void;

  
  composerRole: 'user' | 'operator' | 'admin';
  
  composerQueuedFiles: File[];

  loadProviders: () => Promise<void>;
  
  ensureModelMeta: () => Promise<void>;
  setProvider: (providerId: string, model?: string) => void;
  setModel: (model: string) => void;
  setImageStudioModel: (providerId: string, model: string) => void;
  setImageStudioOutput: (patch: {
    sizeMode?: ImageSizeMode;
    aspectRatio?: string;
    pixelWidth?: string;
    pixelHeight?: string;
  }) => void;
  loadGallery: () => Promise<void>;
  
  pushGalleryUrls: (urls: string[]) => void;
  addToGallery: (urls: string[]) => Promise<void>;
  removeFromGallery: (url: string) => Promise<void>;
  moveGalleryImage: (url: string, direction: -1 | 1) => Promise<void>;
  
  reorderGalleryImages: (from: number, to: number) => Promise<void>;

  loadImageSessions: () => Promise<void>;
  createImageSession: (label?: string) => Promise<string>;
  selectImageSession: (id: string | null) => void;
  deleteImageSession: (id: string) => Promise<void>;
  
  renameImageSession: (id: string, label: string) => Promise<void>;
  
  addItemsToSession: (
    items: Array<Omit<ImageSessionItem, 'savedAt'>>,
    targetSessionId?: string,
  ) => Promise<void>;
  loadImageSettings: () => Promise<void>;
  setImageRetentionDays: (days: number) => Promise<void>;
  loadAgentWorkspaces: (sessionId?: string) => Promise<void>;
  
  addAgentWorkspace: (path: string, label?: string, sessionId?: string) => Promise<AgentWorkspaceInfo>;
  removeAgentWorkspace: (id: string) => Promise<void>;
  
  setActiveAgentWorkspace: (id: string, sessionId?: string) => Promise<void>;

  
  treeView: TreeViewInfo | null;
  treeRules: TreeIgnoreRules | null;
  
  treePanelOpen: boolean;
  treePanelCollapsed: boolean;
  treePanelGeometry: { x: number; y: number; w: number; h: number } | null;
  loadTreeView: (
    workspaceId: string | null | undefined,
    options?: { force?: boolean },
  ) => Promise<void>;
  applyTreeDelta: (workspaceId: string, delta: TreeDelta) => void;
  refreshTreeView: (workspaceId: string) => Promise<void>;
  loadTreeRules: (workspaceId: string) => Promise<void>;
  saveTreeRules: (workspaceId: string, rules: TreeIgnoreRules) => Promise<void>;
  setTreePanelOpen: (open: boolean) => void;
  setTreePanelCollapsed: (collapsed: boolean) => void;
  setTreePanelGeometry: (geometry: { x: number; y: number; w: number; h: number }) => void;
  newConversation: (options?: {
    providerId?: string;
    model?: string;
    categoryId?: string;
    
    workspaceId?: string;
    
    councilId?: string;
    councilRole?: 'main' | 'sub';
    councilAgentId?: string;
  }) => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  
  executeDeleteConversation: (id: string) => void;
  confirmPendingDelete: () => void;
  cancelPendingDelete: () => void;
  renameConversation: (id: string, title: string) => void;
  
  setCompaction: (id: string, compaction: ConversationCompaction | undefined) => void;
  
  deleteTurn: (conversationId: string, turnId: string) => void;
  
  dropTurns: (conversationId: string, turnIds: string[]) => void;
  
  branchFromTurn: (conversationId: string, turnId: string) => void;
  clearAllConversations: () => void;
  replaceConversations: (conversations: Conversation[]) => void;  
  hydrateConversation: (id: string) => Promise<void>;
  
  adoptFetchedBody: (fetched: Conversation) => void;

  appendTurn: (conversationId: string, turn: Turn) => void;
  
  upsertHarnessEvent: (conversationId: string, turn: Turn) => void;
  updateTurn: (conversationId: string, turnId: string, patch: Partial<Turn>) => void;
  
  trimReasoning: (conversationId: string) => number;
  
  patchConversation: (conversationId: string, patch: Partial<Conversation>) => void;
  
  setConversationGoals: (conversationId: string, goals: Goal[]) => void;
  
  setConversationTodos: (conversationId: string, todos: Todo[]) => void;
  
  updateSettings: (patch: Partial<ChatSettings>, conversationId?: string) => void;

  setView: (view: ViewId) => void;
  toggleSidebar: () => void;
  
  setSidebarWidth: (width: number) => void;
  setSettingsWidth: (width: number) => void;
  
  commitSidebarWidth: () => void;
  commitSettingsWidth: () => void;
  commitDiffDockWidth: () => void;
  toggleSettings: () => void;
  setRightPanelMode: (mode: 'config' | 'tree' | 'addons' | 'diff') => void;
  
  imagePickerWanted: boolean;
  requestImagePicker: () => void;
  consumeImagePickerRequest: () => void;
  
  imageStudioPromptWanted: string | null;
  requestImageStudioPrompt: (prompt: string) => void;
  consumeImageStudioPromptRequest: () => void;
  
  openDiffPanel: (turnId: string | null) => void;
  setDiffPanelTurnId: (turnId: string | null) => void;
  setDiffDockWidth: (width: number) => void;
  setTheme: (theme: ThemeMode, ev?: { clientX: number; clientY: number }) => void;
  setAccent: (accent: Accent) => void;
  setDensity: (density: Density) => void;
  setAmbient: (ambient: boolean) => void;
  
  setReduceMotion: (reduceMotion: boolean | null) => void;
  
  setConfirmDel: (confirmDel: boolean) => void;
  setFontScale: (scale: number) => void;
  setContextScale: (scale: number) => void;
  setFontFamily: (family: FontFamily) => void;
  setSearchQuery: (query: string) => void;
  setComposerRole: (role: 'user' | 'operator' | 'admin') => void;
  queueComposerFiles: (files: File[]) => void;
  clearComposerQueuedFiles: () => void;
  
  showNotice: (
    id: MessageId,
    params?: Record<string, string | number>,
    opts?: { detail?: string; tone?: MessageTone },
  ) => void;
  dismissNotice: (key: string) => void;
  toggleNoticeHistory: () => void;
  clearNoticeHistory: () => void;
  setGenRunning: (id: string, running: boolean) => void;
  
  genStartedAt: Record<string, number>;
  
  setCompacting: (id: string | null) => void;
  
  setLiveContext: (conversationId: string, telemetry: LiveContextTelemetry | null) => void;
  
  settleLiveContext: (conversationId: string, tokens?: number) => void;
  
  setCrashedRun: (
    id: string,
    run: { runId: string; callCount: number } | null,
  ) => void;

  activeConversation: () => Conversation | undefined;
  activeProvider: () => ProviderPublic | undefined;
  activeAgentWorkspace: () => AgentWorkspaceInfo | undefined;
}


const FROZEN_PROGRESS_RE = /Waiting for the provider…\s*\d+s\s*\((?:PENDING|RUNNING|QUEUED)\)/;

function healFrozenImageSegments(turns: Turn[]): Turn[] {
  let changed = false;
  const healed = turns.map((turn) => {
    if (!turn.segments?.some((segment) => segment.type === 'tool' && segment.summary !== undefined && FROZEN_PROGRESS_RE.test(segment.summary))) {
      return turn;
    }
    changed = true;
    return {
      ...turn,
      segments: turn.segments.map((segment) => {
        if (segment.type !== 'tool' || segment.summary === undefined || !FROZEN_PROGRESS_RE.test(segment.summary)) {
          return segment;
        }
        const { summary: _frozen, ...rest } = segment;
        return rest as typeof segment;
      }),
    };
  });
  return changed ? healed : turns;
}


function dedupeTurns(turns: Turn[]): Turn[] {
  turns = healFrozenImageSegments(turns).map(withSegmentIds);
  const seen = new Set<string>();
  let dirty = false;
  for (const turn of turns) {
    if (seen.has(turn.id)) {
      dirty = true;
      continue;
    }
    seen.add(turn.id);
  }
  if (!dirty) return turns;
  return turns.filter((turn) => {
    if (!seen.has(turn.id)) return false;
    seen.delete(turn.id);
    return true;
  });
}

function makeConversation(options?: {
  providerId?: string;
  model?: string;
  categoryId?: string;
  workspaceId?: string;
  councilId?: string;
  councilRole?: 'main' | 'sub';
  councilAgentId?: string;
}): Conversation {
  const now = Date.now();
  return {
    id: uid('chat'),
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    providerId: options?.providerId ?? '',
    model: options?.model ?? '',
    settings: {
      ...DEFAULT_SETTINGS,
      enforcement: { ...DEFAULT_SETTINGS.enforcement },
      probation: { ...DEFAULT_SETTINGS.probation },
    },
    turns: [],
    categoryId: options?.categoryId,
    ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options?.councilId ? { councilId: options.councilId } : {}),
    ...(options?.councilRole ? { councilRole: options.councilRole } : {}),
    ...(options?.councilAgentId ? { councilAgentId: options.councilAgentId } : {}),
  };
}


export function isPhantomConversation(conversation: Conversation): boolean {
  return conversation.turns.length === 0 && conversation.title === 'New chat';
}


export function isSubSession(conversation: Conversation): boolean {
  return conversation.councilRole === 'sub' && Boolean(conversation.councilId);
}


function newestConversationId(conversations: Conversation[]): string | null {
  let best: Conversation | null = null;
  for (const conversation of conversations) {
    if (!best) {
      best = conversation;
      continue;
    }
    if (conversation.updatedAt > best.updatedAt) best = conversation;
    else if (conversation.updatedAt === best.updatedAt && conversation.createdAt > best.createdAt) {
      best = conversation;
    }
  }
  return best?.id ?? null;
}

function persist(conversations: Conversation[]): void {
  pendingConversations = conversations.filter(
    (entry) =>
      !isPhantomConversation(entry) ||
      serverKnownIds.has(entry.id) ||
      configuredConversationIds.has(entry.id),
  );
  queueServerSync(pendingConversations);
}

let pendingConversations: Conversation[] | null = null;

function flushPersist(): void {
  if (pendingConversations === null) return;
  const snapshot = pendingConversations;
  pendingConversations = null;
  queueServerSync(snapshot);
}


function withLoadedBody(id: string, mutate: () => void): void {
  const entry = useStore.getState().conversations.find((conversation) => conversation.id === id);
  if (!entry || entry.turnsLoaded !== false) {
    mutate();
    return;
  }
  void useStore.getState().hydrateConversation(id).then(() => {
    if (useStore.getState().conversations.some((conversation) => conversation.id === id)) mutate();
  });
}



const syncedJson = new Map<string, string>();


const settingsDirtyIds = new Set<string>();
const configuredConversationIds = new Set<string>();
const configSyncInFlight = new Map<string, Promise<void>>();
const configEpoch = new Map<string, number>();

function commitConfigToServer(
  conversationId: string,
  payload: ConversationConfigPatchPayload,
): Promise<void> {
  const nextEpoch = (configEpoch.get(conversationId) ?? 0) + 1;
  configEpoch.set(conversationId, nextEpoch);
  configuredConversationIds.add(conversationId);
  const prev = configSyncInFlight.get(conversationId) ?? Promise.resolve();
  const task = prev
    .catch(() => undefined)
    .then(async () => {
      const snapshot = !serverKnownIds.has(conversationId)
        ? useStore
            .getState()
            .conversations.find((entry) => entry.id === conversationId)
        : undefined;
      const summary = await patchConversationConfig(
        conversationId,
        snapshot && !payload.initialConversation
          ? { ...payload, initialConversation: snapshot }
          : payload,
      );
      if (!summary) return;
      serverKnownIds.add(summary.id);
      syncedTurnCount.set(summary.id, summary.turnCount);
      if (configEpoch.get(conversationId) === nextEpoch) {
        settingsDirtyIds.delete(conversationId);
        const current = useStore
          .getState()
          .conversations.find((entry) => entry.id === conversationId);
        if (current) {
          syncedJson.set(conversationId, JSON.stringify(current));
        }
      }
    })
    .finally(() => {
      if (configSyncInFlight.get(conversationId) === task) {
        configSyncInFlight.delete(conversationId);
      }
    });
  configSyncInFlight.set(conversationId, task);
  return task;
}

export function awaitConfigSync(conversationId: string): Promise<void> {
  return configSyncInFlight.get(conversationId) ?? Promise.resolve();
}

function mergeServerSettings(raw?: ChatSettings | null): ChatSettings {
  if (!raw) {
    return {
      ...DEFAULT_SETTINGS,
      enforcement: { ...DEFAULT_SETTINGS.enforcement },
      probation: { ...DEFAULT_SETTINGS.probation },
    };
  }
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    enforcement: { ...DEFAULT_SETTINGS.enforcement, ...raw.enforcement },
    probation: { ...DEFAULT_SETTINGS.probation, ...raw.probation },
  };
}

function pickNewerLiveContext(
  first: LiveContextTelemetry | undefined,
  second: LiveContextTelemetry | undefined,
): LiveContextTelemetry | undefined {
  if (!first) return second;
  if (!second) return first;
  if (second.at !== first.at) return second.at > first.at ? second : first;
  if (Boolean(second.buckets) !== Boolean(first.buckets)) {
    return second.buckets ? second : first;
  }
  return second.liveContextTokens >= first.liveContextTokens ? second : first;
}

function mergeLiveContextFromConversations(
  current: Record<string, LiveContextTelemetry>,
  conversations: Conversation[],
): Record<string, LiveContextTelemetry> {
  let changed = false;
  const next = { ...current };
  for (const convo of conversations) {
    const serverLive = convo.liveContext;
    if (!serverLive) continue;
    const merged = pickNewerLiveContext(next[convo.id], serverLive);
    if (merged && merged !== next[convo.id]) {
      next[convo.id] = merged;
      changed = true;
    }
  }
  return changed ? next : current;
}

let syncTimer: number | null = null;
let syncInFlight: Promise<void> = Promise.resolve();
let syncDirty = false;

let syncReady = false;
let lastSyncSnapshot: Conversation[] | null = null;


const pendingDeletions = new Set<string>();


const TURN_TOMBSTONES = new Map<string, number>();
const TURN_TOMBSTONE_TTL_MS = 10_000;

function markTurnsTombstone(turnIds: string[]): void {
  const now = Date.now();
  for (const id of turnIds) TURN_TOMBSTONES.set(id, now);
  for (const [id, markedAt] of TURN_TOMBSTONES) {
    if (now - markedAt > TURN_TOMBSTONE_TTL_MS) TURN_TOMBSTONES.delete(id);
  }
}

function isTurnTombstoned(turnId: string): boolean {
  const markedAt = TURN_TOMBSTONES.get(turnId);
  if (markedAt === undefined) return false;
  if (Date.now() - markedAt > TURN_TOMBSTONE_TTL_MS) {
    TURN_TOMBSTONES.delete(turnId);
    return false;
  }
  return true;
}


const SYNC_DEBOUNCE_MS = 1500;

const SYNC_STEADY_CAP_MS = 5_000;

let syncCycleStreak = 0;

function nextSyncDelayMs(): number {
  const expo = Math.min(SYNC_STEADY_CAP_MS, SYNC_DEBOUNCE_MS * 1.5 ** Math.min(syncCycleStreak, 4));
  return Math.round(expo * (0.8 + Math.random() * 0.4));
}


function generatingConversationIds(): Set<string> {
  return new Set(Object.keys(useStore.getState().genRunning));
}


const serverKnownIds = new Set<string>();


const syncedTurnCount = new Map<string, number>();


function yieldToMain(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  const scheduler = (window as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function queueServerSync(snapshot: Conversation[]): void {
  if (!syncReady) return;
  lastSyncSnapshot = snapshot;
  syncDirty = true;
  if (syncTimer === null) {
    syncTimer = window.setTimeout(() => {
      void runServerSync();
    }, nextSyncDelayMs());
  }
}

function runServerSync(): Promise<void> {
  if (syncTimer !== null) {
    window.clearTimeout(syncTimer);
    syncTimer = null;
  }
  if (!syncDirty) return Promise.resolve();
  syncInFlight = syncInFlight.then(doServerSync).catch(() => undefined);
  return syncInFlight;
}



const pendingTurnDeletions = new Map<string, Set<string>>();

function rememberTurnDeletion(conversationId: string, turnIds: string[]): void {
  let set = pendingTurnDeletions.get(conversationId);
  if (!set) {
    set = new Set();
    pendingTurnDeletions.set(conversationId, set);
  }
  for (const id of turnIds) set.add(id);
}

function consumeTurnDeletions(conversationId: string, turnIds: string[]): void {
  const set = pendingTurnDeletions.get(conversationId);
  if (!set) return;
  for (const id of turnIds) set.delete(id);
  if (set.size === 0) pendingTurnDeletions.delete(conversationId);
}

function computeSyncBatch(snapshot: Conversation[]): {
  upsert: Conversation[];
  removeIds: string[];
  turnPatches: TurnPatch[];
  
  turnDeletions: Array<{ conversationId: string; turnId: string }>;
} | null {
  const generating = generatingConversationIds();
  const upsert: Conversation[] = [];
  const turnPatches: TurnPatch[] = [];
  const turnDeletions: Array<{ conversationId: string; turnId: string }> = [];

  for (const [conversationId, ids] of pendingTurnDeletions) {
    if (!snapshot.some((entry) => entry.id === conversationId)) continue;
    for (const turnId of ids) {
      turnPatches.push({ conversationId, turnId, turn: null });
      turnDeletions.push({ conversationId, turnId });
    }
  }

  for (const conversation of snapshot) {
    if (conversation.turnsLoaded === false) continue;
    if (!generating.has(conversation.id)) {
      if (syncedJson.get(conversation.id) !== JSON.stringify(conversation)) {
        upsert.push(conversation);
      }
      continue;
    }
    if (settingsDirtyIds.has(conversation.id)) {
      upsert.push(conversation);
      continue;
    }
    if (!serverKnownIds.has(conversation.id)) {
      upsert.push(conversation);
      continue;
    }
    const known = syncedTurnCount.get(conversation.id) ?? 0;
    const pending = conversation.turns.slice(Math.max(0, known));
    const trailing = conversation.turns[conversation.turns.length - 1];
    if (trailing && !pending.includes(trailing)) pending.push(trailing);
    for (const turn of pending) {
      turnPatches.push({
        conversationId: conversation.id,
        turnId: turn.id,
        turn,
      });
    }
  }
  const alive = new Set(snapshot.map((entry) => entry.id));
  const removeIds = [...pendingDeletions].filter((id) => !alive.has(id));
  if (upsert.length === 0 && removeIds.length === 0 && turnPatches.length === 0) return null;
  return { upsert, removeIds, turnPatches, turnDeletions };
}

async function doServerSync(): Promise<void> {
  if (!syncDirty) return;
  const snapshot = lastSyncSnapshot;
  if (!snapshot) {
    syncDirty = false;
    return;
  }
  const batch = computeSyncBatch(snapshot);
  if (!batch) {
    syncDirty = false;
    syncCycleStreak = 0;
    return;
  }
  const summaries = await syncConversations(batch.upsert, batch.removeIds, batch.turnPatches);
  if (!summaries) {
    syncCycleStreak += 1;
    return;
  }
  syncCycleStreak += 1;
  syncDirty = false;
  for (const { conversationId, turnId } of batch.turnDeletions) {
    consumeTurnDeletions(conversationId, [turnId]);
  }
  for (const id of batch.removeIds) {
    syncedJson.delete(id);
    serverKnownIds.delete(id);
    syncedTurnCount.delete(id);
    pendingDeletions.delete(id);
  }
  serverKnownIds.clear();
  for (const summary of summaries) serverKnownIds.add(summary.id);
  for (const id of batch.upsert) settingsDirtyIds.delete(id.id);
  await foldServerSummaries(summaries, batch.upsert, snapshot);
}


function localMatchesSummary(local: Conversation, summary: ConversationSummary): boolean {
  if ((local.rev ?? null) !== (summary.rev ?? null)) return false;
  if (local.updatedAt !== summary.updatedAt) return false;
  return local.turns.length === summary.turnCount;
}


function localIsNewer(local: Conversation, summary: ConversationSummary): boolean {
  if (local.updatedAt > summary.updatedAt) return true;
  if (local.updatedAt < summary.updatedAt) return false;
  const localRev = local.rev ?? null;
  const serverRev = summary.rev ?? null;
  if (localRev !== null && serverRev !== null) return localRev > serverRev;
  if (localRev !== null) return true;
  if (serverRev !== null) return false;
  return false;
}


function keepLocalBody(local: Conversation, summary: ConversationSummary): boolean {
  return localMatchesSummary(local, summary) || localIsNewer(local, summary);
}


function keepLocalFullBody(local: Conversation, fetched: Conversation): boolean {
  if (local.updatedAt > fetched.updatedAt) return true;
  if (local.updatedAt < fetched.updatedAt) return false;
  const localRev = local.rev ?? null;
  const fetchedRev = fetched.rev ?? null;
  if (localRev !== null && fetchedRev !== null && localRev !== fetchedRev) return localRev > fetchedRev;
  if (local.turns.length !== fetched.turns.length) return local.turns.length > fetched.turns.length;
  return JSON.stringify(local) === JSON.stringify(fetched);
}


function assembleMerged(
  summaries: ConversationSummary[],
  resolved: Map<string, Conversation>,
  local: Conversation[],
): Conversation[] {
  const serverIds = new Set(summaries.map((entry) => entry.id));
  return [
    ...summaries
      .map((entry) => resolved.get(entry.id))
      .filter((entry): entry is Conversation => entry !== undefined),
    ...local.filter((entry) => !serverIds.has(entry.id)),
  ];
}


async function foldServerSummaries(
  summaries: ConversationSummary[],
  sent: Conversation[],
  snapshot: Conversation[],
): Promise<void> {
  const local = snapshot;
  const sentJson = new Map(sent.map((entry) => [entry.id, JSON.stringify(entry)]));
  const live = generatingConversationIds();
  const resolved = new Map<string, Conversation>();
  const toFetch: string[] = [];
  for (const summary of summaries) {
    syncedTurnCount.set(summary.id, summary.turnCount);
    const localEntry = local.find((entry) => entry.id === summary.id);
    if (localEntry?.turnsLoaded === false) {
      const keepLocal = settingsDirtyIds.has(summary.id) || configSyncInFlight.has(summary.id);
      resolved.set(summary.id, {
        ...localEntry,
        title: summary.title,
        updatedAt: summary.updatedAt,
        rev: summary.rev,
        providerId: keepLocal ? localEntry.providerId : (summary.providerId ?? localEntry.providerId),
        model: keepLocal ? localEntry.model : (summary.model ?? localEntry.model),
        settings: !keepLocal && summary.settings ? mergeServerSettings(summary.settings) : localEntry.settings,
        ...( !keepLocal && summary.compaction !== undefined
          ? { compaction: summary.compaction }
          : {}),
        ...(summary.liveContext !== undefined ? { liveContext: summary.liveContext } : {}),
      });
      continue;
    }
    if (!localEntry) {
      toFetch.push(summary.id);
      continue;
    }
    const editedAfterSend =
      sentJson.has(summary.id) && JSON.stringify(localEntry) !== sentJson.get(summary.id);
    if (editedAfterSend || keepLocalBody(localEntry, summary)) {
      const mergedLive = pickNewerLiveContext(
        localEntry.liveContext,
        summary.liveContext as LiveContextTelemetry | undefined,
      );
      const entryWithLive =
        mergedLive && mergedLive !== localEntry.liveContext
          ? { ...localEntry, liveContext: mergedLive }
          : localEntry;
      resolved.set(summary.id, entryWithLive);
      if (!editedAfterSend && !live.has(summary.id) && localMatchesSummary(localEntry, summary)) {
        syncedJson.set(summary.id, JSON.stringify(entryWithLive));
      }
      continue;
    }
    toFetch.push(summary.id);
  }
  if (toFetch.length > 0) {
    const summaryById = new Map(summaries.map((s) => [s.id, s]));
    const localById = new Map(local.map((c) => [c.id, c]));
    const fetched = await Promise.all(toFetch.map((id) => fetchConversationDetail(id)));
    for (let idx = 0; idx < toFetch.length; idx += 1) {
      const targetId = toFetch[idx];
      const convo = fetched[idx];
      const localEntry = localById.get(targetId);
      const summary = summaryById.get(targetId);
      if (!convo) {
        if (localEntry) resolved.set(localEntry.id, localEntry);
        continue;
      }
      const serverLive = pickNewerLiveContext(
        convo.liveContext,
        summary?.liveContext as LiveContextTelemetry | undefined,
      );
      const mergedLive = pickNewerLiveContext(localEntry?.liveContext, serverLive);
      const clean: Conversation = {
        ...convo,
        turns: dedupeTurns(convo.turns),
        ...(mergedLive !== undefined ? { liveContext: mergedLive } : {}),
      };
      resolved.set(clean.id, clean);
      syncedJson.set(clean.id, JSON.stringify(clean));
    }
  }
  const next = assembleMerged(summaries, resolved, local);
  const livePhantoms = useStore
    .getState()
    .conversations.filter(
      (entry) => isPhantomConversation(entry) && !next.some((row) => row.id === entry.id),
    );
  const merged = livePhantoms.length > 0 ? [...livePhantoms, ...next] : next;
  const changed =
    merged.length !== local.length || merged.some((entry, index) => entry !== local[index]);
  if (changed) useStore.getState().replaceConversations(merged);
}


function shellForSummary(summary: ConversationSummary): Conversation {
  return {
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    providerId: summary.providerId ?? '',
    model: summary.model ?? '',
    workspaceId: summary.workspaceId,
    councilId: summary.councilId,
    councilRole: summary.councilRole,
    councilAgentId: summary.councilAgentId,
    rev: summary.rev,
    settings: mergeServerSettings(summary.settings),
    ...(summary.compaction !== undefined ? { compaction: summary.compaction } : {}),
    ...(summary.liveContext !== undefined ? { liveContext: summary.liveContext } : {}),
    turns: [],
    turnsLoaded: false,
  };
}


const hydrating = new Map<string, Promise<void>>();


async function initConversationSync(): Promise<void> {
  if (syncReady || typeof window === 'undefined') return;

  const legacy = readLegacyConversations().filter((entry) => !isPhantomConversation(entry));
  if (legacy.length > 0) {
    const acked = await syncConversations(legacy, []);
    if (acked) {
      clearLegacyConversations();
      const ackedIds = new Set(acked.map((entry) => entry.id));
      for (const entry of legacy) {
        if (!ackedIds.has(entry.id)) continue;
        syncedJson.set(entry.id, JSON.stringify(entry));
        serverKnownIds.add(entry.id);
        syncedTurnCount.set(entry.id, entry.turns.length);
      }
    } else {
      useStore
        .getState()
        .showNotice('device.unreachableCache');
    }
  }

  await yieldToMain();
  const summaries = await fetchConversationSummaries();
  if (!summaries) {
    useStore
      .getState()
      .showNotice('device.unreachableLoad');
    syncReady = true;
    return;
  }

  const wantBodies = new Set<string>(generatingConversationIds());
  const openAtBoot = useStore.getState().activeId;
  if (openAtBoot) wantBodies.add(openAtBoot);

  const resolved = new Map<string, Conversation>();
  const toFetch: string[] = [];
  for (const summary of summaries) {
    serverKnownIds.add(summary.id);
    syncedTurnCount.set(summary.id, summary.turnCount);
    if (wantBodies.has(summary.id)) {
      toFetch.push(summary.id);
      continue;
    }
    resolved.set(summary.id, shellForSummary(summary));
  }
  if (toFetch.length > 0) {
    const fetched = await Promise.all(toFetch.map((id) => fetchConversationDetail(id)));
    for (const convo of fetched) {
      if (!convo) continue;
      const clean = { ...convo, turns: dedupeTurns(convo.turns) };
      resolved.set(clean.id, clean);
      syncedJson.set(clean.id, JSON.stringify(clean));
    }
    for (const id of toFetch) {
      if (resolved.has(id)) continue;
      const summary = summaries.find((entry) => entry.id === id);
      if (summary) resolved.set(id, shellForSummary(summary));
    }
  }
  await yieldToMain();
  const merged = assembleMerged(summaries, resolved, []);
  useStore.getState().replaceConversations(merged);
  lastSyncSnapshot = merged;
  syncReady = true;
}

let markConversationsReady: () => void = () => undefined;

export const conversationsReady = new Promise<void>((resolve) => {
  markConversationsReady = resolve;
});

let markProvidersReady: () => void = () => undefined;

export const providersReady = new Promise<void>((resolve) => {
  markProvidersReady = resolve;
});


let providersLoadInFlight: Promise<void> | null = null;

let modelMetaInFlight: Promise<void> | null = null;

let treeLoadInFlight: { workspaceId: string; promise: Promise<void> } | null = null;
let treeLoadedAt = 0;

const TREE_LOAD_MIN_GAP_MS = 4_000;


export function bootConversationSync(): Promise<void> {
  return initConversationSync().finally(() => markConversationsReady());
}


export async function refreshConversationList(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const resp = await fetch('/api/conversations');
    if (!resp.ok) return;
    const summaries = ((await resp.json()) as { conversations: ConversationSummary[] }).conversations;
    const state = useStore.getState();
    const known = new Set(state.conversations.map((entry) => entry.id));
    const fresh = summaries.filter((entry) => !known.has(entry.id)).map(shellForSummary);
    if (fresh.length > 0) {
      useStore.getState().replaceConversations([...state.conversations, ...fresh]);
    }
  } catch {
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    flushPersist();
    if (syncReady && syncDirty && lastSyncSnapshot) {
      const batch = computeSyncBatch(lastSyncSnapshot);
      if (batch) {
        beaconSyncConversations(batch.upsert, batch.removeIds, batch.turnPatches);
        for (const { conversationId, turnId } of batch.turnDeletions) {
          consumeTurnDeletions(conversationId, [turnId]);
        }
        for (const conversation of batch.upsert) {
          syncedJson.set(conversation.id, JSON.stringify(conversation));
        }
        for (const id of batch.removeIds) {
          syncedJson.delete(id);
        }
      }
    }
  });
}

const savedImageStudio = storage.loadImageStudioModel();


let genTick: number | null = null;
let genPoll: number | null = null;

let genToken = 0;

function stopGenTimers(): void {
  if (genTick !== null) window.clearInterval(genTick);
  if (genPoll !== null) window.clearTimeout(genPoll);
  genTick = null;
  genPoll = null;
}

const IMAGE_GEN_POLL_MS = 4000;
const IMAGE_GEN_FIRST_POLL_MS = 2500;

export const useStore = create<AppState>((set, get) => ({
  providers: [],
  providersLoading: false,
  providersError: null,
  providerId: storage.loadProviderId(),
  model: storage.loadModel(),
  imageProviderId: savedImageStudio.providerId,
  imageModel: savedImageStudio.model,
  imageSizeMode: savedImageStudio.sizeMode,
  imageAspectRatio: savedImageStudio.aspectRatio,
  imagePixelWidth: savedImageStudio.pixelWidth,
  imagePixelHeight: savedImageStudio.pixelHeight,
  galleryImages: [],

  imageSessions: [],
  activeImageSessionId: storage.loadActiveImageSessionId(),
  imageRetentionDays: null,

  imageGen: { phase: 'idle', error: null, errorAt: null, elapsed: 0, sessionId: null },
  imageReferences: [],

  conversations: [],
  activeId: storage.loadActiveId() ?? '',

  agentWorkspaces: [],
  activeAgentWorkspaceId: null,
  pendingPermissions: [],
  pendingAskUser: [],
  pendingOperatorGates: [],

  view: storage.loadView(),
  sidebarCollapsed: storage.loadSidebarCollapsed(),
  reasoningOpen: {},
  sidebarWidth: storage.loadSidebarWidth(),
  settingsWidth: storage.loadSettingsWidth(),
  settingsOpen:
    storage.loadSettingsOpen() ??
    (typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches),
  rightPanelMode: storage.loadRightPanelMode(),
  imagePickerWanted: false,
  imageStudioPromptWanted: null,
  diffPanelTurnId: storage.loadDiffPanelTurnId(),
  diffDockWidth: storage.loadDiffDockWidth(),
  theme: storage.loadTheme(),
  accent: storage.loadAccent(),
  density: storage.loadDensity(),
  ambient: storage.loadAmbient(),
  reduceMotion: storage.loadReduceMotion(),
  confirmDel: storage.loadConfirmDel(),
  pendingConfirmDelete: null,
  fontScale: storage.loadFontScale(),
  contextScale: storage.loadContextScale(),
  fontFamily: storage.loadFontFamily(),
  modelMeta: {},
  searchQuery: '',
  notices: [],
  noticeHistory: [],
  noticeHistoryExpanded: false,
  composerRole: 'user',
  composerQueuedFiles: [],
  genRunning: storage.loadGenRunning(),
  genStartedAt: storage.loadGenStartedAt(),
  compactingId: null,
  liveContext: {},
  stoppedRuns: {},
  pendingSteers: {},
  crashedRuns: {},
  pendingSettings: {
    ...DEFAULT_SETTINGS,
    ...(storage.loadPendingSettings() ?? {}),
    enforcement: { ...DEFAULT_SETTINGS.enforcement },
    probation: { ...DEFAULT_SETTINGS.probation },
  },
  addonEvent: null,
  pushAddonEvent: (event) => set({ addonEvent: event }),

  loadProviders: async () => {
    if (providersLoadInFlight) return providersLoadInFlight;
    providersLoadInFlight = (async () => {
      set({ providersLoading: true, providersError: null });
      try {
        const { fetchProviders } = await import('../lib/api');
        const providers = await fetchProviders();
        const current = get().providerId;

        const stillValid = providers.some((provider) => provider.id === current);
        const usable = providers.filter((provider) => provider.hasServerKey || !provider.builtIn);
        const fallback = usable[0] ?? providers[0];
        const providerId = stillValid ? current : (fallback?.id ?? '');

        const provider = providers.find((entry) => entry.id === providerId);
        const model = (stillValid ? get().model : '') || provider?.models[0] || '';
        storage.saveProviderId(providerId);
        storage.saveModel(model);

        const { imageProviderId, imageModel } = get();
        const imageValid = providers.some((entry) => entry.id === imageProviderId);

        set({ providers, providerId, model, providersLoading: false });
        if (Object.keys(get().modelMeta).length === 0) {
          void get().ensureModelMeta();
        }
        if (!imageValid && (imageProviderId || imageModel)) {
          get().setImageStudioModel('', '');
        }
      } catch (error) {
        set({
          providersLoading: false,
          providersError:
            error instanceof Error
              ? error.message
              : 'Could not reach the local proxy. Is `npm run dev` running?',
        });
      } finally {
        providersLoadInFlight = null;
        markProvidersReady();
      }
    })();
    return providersLoadInFlight;
  },

  ensureModelMeta: async () => {
    if (Object.keys(get().modelMeta).length > 0 || modelMetaInFlight) {
      if (modelMetaInFlight) await modelMetaInFlight;
      return;
    }
    modelMetaInFlight = (async () => {
      try {
        const { fetchModelMetadata } = await import('../lib/api');
        const modelMeta = (await fetchModelMetadata()) as Record<string, ModelMeta>;
        set({ modelMeta });
      } catch {
      } finally {
        modelMetaInFlight = null;
      }
    })();
    await modelMetaInFlight;
  },

  setProvider: (providerId, model) => {
    const provider = get().providers.find((entry) => entry.id === providerId);
    const nextModel = model ?? provider?.models[0] ?? '';
    set({ providerId, model: nextModel });
    storage.saveProviderId(providerId);
    storage.saveModel(nextModel);
    const conversation = get().activeConversation();
    if (conversation) {
      const next = get().conversations.map((entry) =>
        entry.id === conversation.id
          ? { ...entry, providerId, model: nextModel, rev: (entry.rev ?? 0) + 1 }
          : entry,
      );
      settingsDirtyIds.add(conversation.id);
      set({ conversations: next });
      persist(next);
      void commitConfigToServer(conversation.id, { providerId, model: nextModel });
    }
  },

  setImageStudioModel: (providerId, model) => {
    set({ imageProviderId: providerId, imageModel: model });
    storage.saveImageStudioModel({
      providerId,
      model,
      sizeMode: get().imageSizeMode,
      aspectRatio: get().imageAspectRatio,
      pixelWidth: get().imagePixelWidth,
      pixelHeight: get().imagePixelHeight,
    });
  },

  setImageStudioOutput: (patch) => {
    const next = {
      providerId: get().imageProviderId,
      model: get().imageModel,
      sizeMode: patch.sizeMode ?? get().imageSizeMode,
      aspectRatio: patch.aspectRatio ?? get().imageAspectRatio,
      pixelWidth: patch.pixelWidth ?? get().imagePixelWidth,
      pixelHeight: patch.pixelHeight ?? get().imagePixelHeight,
    };
    set({
      imageSizeMode: next.sizeMode,
      imageAspectRatio: next.aspectRatio,
      imagePixelWidth: next.pixelWidth,
      imagePixelHeight: next.pixelHeight,
    });
    storage.saveImageStudioModel(next);
  },

  loadGallery: async () => {
    try {
      const { fetchGallery } = await import('../lib/api');
      set({ galleryImages: await fetchGallery() });
    } catch {
    }
  },

  
  pushGalleryUrls: (urls) => {
    if (urls.length === 0) return;
    const current = get().galleryImages;
    const next = [...current, ...urls.filter((url) => !current.includes(url))];
    set({ galleryImages: next });
  },

  addToGallery: async (urls) => {
    const current = get().galleryImages;
    const next = [...current, ...urls.filter((url) => !current.includes(url))];
    set({ galleryImages: next });
    try {
      const { saveGallery } = await import('../lib/api');
      await saveGallery(next);
      if (urls.length === 1) get().showNotice('gallery.savedOne');
      else get().showNotice('gallery.savedMany', { count: urls.length });
    } catch {
      get().showNotice('gallery.saveFailed');
    }
  },

  removeFromGallery: async (url) => {
    const next = get().galleryImages.filter((entry) => entry !== url);
    set({ galleryImages: next });
    try {
      const { saveGallery } = await import('../lib/api');
      await saveGallery(next);
    } catch {
      get().showNotice('gallery.updateFailed');
    }
  },

  moveGalleryImage: async (url, direction) => {
    const current = [...get().galleryImages];
    const index = current.indexOf(url);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= current.length) return;
    [current[index], current[target]] = [current[target], current[index]];
    set({ galleryImages: current });
    try {
      const { saveGallery } = await import('../lib/api');
      await saveGallery(current);
    } catch {
      get().showNotice('gallery.reorderFailed');
    }
  },

  reorderGalleryImages: async (from, to) => {
    const current = [...get().galleryImages];
    if (from < 0 || to < 0 || from >= current.length || to >= current.length || from === to) return;
    const [moved] = current.splice(from, 1);
    current.splice(to, 0, moved);
    set({ galleryImages: current });
    try {
      const { saveGallery } = await import('../lib/api');
      await saveGallery(current);
    } catch {
      get().showNotice('gallery.reorderFailed');
    }
  },

  loadImageSessions: async () => {
    try {
      const { fetchImageSessions } = await import('../lib/api');
      const sessions = await fetchImageSessions();
      const active = get().activeImageSessionId;
      set({
        imageSessions: sessions,
        activeImageSessionId: active && sessions.some((s) => s.id === active) ? active : null,
      });
      if (active && !sessions.some((s) => s.id === active)) {
        storage.saveActiveImageSessionId(null);
      }
    } catch {
    }
  },

  createImageSession: async (label) => {
    const { createImageSession } = await import('../lib/api');
    const session = await createImageSession(label);
    set({
      imageSessions: [session, ...get().imageSessions],
      activeImageSessionId: session.id,
    });
    storage.saveActiveImageSessionId(session.id);
    return session.id;
  },

  selectImageSession: (id) => {
    set({ activeImageSessionId: id });
    storage.saveActiveImageSessionId(id);
  },

  deleteImageSession: async (id) => {
    try {
      const { deleteImageSession: deleteSession } = await import('../lib/api');
      await deleteSession(id);
      const next = get().imageSessions.filter((session) => session.id !== id);
      const activeCleared = get().activeImageSessionId === id;
      set({
        imageSessions: next,
        ...(activeCleared ? { activeImageSessionId: null } : {}),
      });
      if (activeCleared) storage.saveActiveImageSessionId(null);
      get().showNotice('imageSession.deleted');
    } catch (error) {
      get().showNotice('imageSession.deleteFailed', undefined, {
        detail: error instanceof Error ? error.message : undefined,
      });
    }
  },

  renameImageSession: async (id, label) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    const { renameImageSession: renameSession } = await import('../lib/api');
    const previous = get().imageSessions.find((session) => session.id === id);
    set({
      imageSessions: get().imageSessions.map((session) =>
        session.id === id ? { ...session, label: trimmed } : session,
      ),
    });
    try {
      await renameSession(id, trimmed);
    } catch (error) {
      if (previous) {
        set({
          imageSessions: get().imageSessions.map((session) =>
            session.id === id ? previous : session,
          ),
        });
      }
      get().showNotice('imageSession.renameFailed', undefined, {
        detail: error instanceof Error ? error.message : undefined,
      });
    }
  },

  addItemsToSession: async (items, targetSessionId) => {
    const { appendImageSessionItems } = await import('../lib/api');
    let sessionId: string | null = targetSessionId ?? null;
    if (!sessionId || !get().imageSessions.some((s) => s.id === sessionId)) {
      sessionId = get().activeImageSessionId;
    }
    try {
      if (!sessionId || !get().imageSessions.some((s) => s.id === sessionId)) {
        const firstPrompt = items[0]?.prompt ?? '';
        const label = firstPrompt
          ? firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 40)
          : undefined;
        sessionId = await get().createImageSession(label);
      }
      const saved = items.map((item) => ({ ...item, savedAt: new Date().toISOString() }));
      const session = await appendImageSessionItems(sessionId, saved);
      set({
        imageSessions: get()
          .imageSessions.map((entry) => (entry.id === sessionId ? session : entry))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      });
    } catch (error) {
      get().showNotice('imageSession.recordFailed', undefined, {
        detail: error instanceof Error ? error.message : undefined,
      });
    }
  },

  startImageGeneration: async (input) => {
    if (get().imageGen.phase !== 'idle') return;
    let sessionId = get().activeImageSessionId;
    if (!sessionId || !get().imageSessions.some((s) => s.id === sessionId)) {
      sessionId = await get().createImageSession();
    }
    const token = ++genToken;
    set({ imageGen: { phase: 'submitting', error: null, errorAt: null, elapsed: 0, sessionId } });

    const { submitImageTask, pollImageTask } = await import('../lib/api');
    try {
      const taskId = await submitImageTask(input);
      if (token !== genToken) return;
      set({ imageGen: { ...get().imageGen, phase: 'generating' } });
      genTick = window.setInterval(() => {
        const gen = get().imageGen;
        if (gen.phase === 'generating') {
          set({ imageGen: { ...gen, elapsed: gen.elapsed + 1 } });
        }
      }, 1000);

      const poll = async (): Promise<void> => {
        if (token !== genToken) return;
        try {
          const result = await pollImageTask(taskId);
          if (token !== genToken) return;
          if (result.status === 'SUCCEED') {
            stopGenTimers();
            if (result.images.length > 0) {
              await get().addItemsToSession(
                result.images.map((url) => ({
                  url,
                  taskId,
                  prompt: input.prompt,
                  model: input.model,
                  provider:
                    get().providers.find((entry) => entry.id === input.providerId)?.label ?? '',
                })),
                sessionId,
              );
            }
            const hadError = get().imageGen.error;
            set({
              imageGen: { phase: 'idle', error: null, errorAt: null, elapsed: 0, sessionId: null },
            });
            if (!hadError) {
              get().showNotice('image.savedToSession', undefined, result.note ? { detail: result.note } : undefined);
            }
          } else if (result.status === 'FAILED') {
            stopGenTimers();
            set({
              imageGen: {
                phase: 'idle',
                error: result.error ?? 'The provider reported that generation failed.',
                errorAt: Date.now(),
                elapsed: 0,
                sessionId,
              },
            });
          } else {
            genPoll = window.setTimeout(() => void poll(), IMAGE_GEN_POLL_MS);
          }
        } catch (cause) {
          stopGenTimers();
          set({
            imageGen: {
              phase: 'idle',
              error: cause instanceof Error ? cause.message : 'Polling the task failed.',
              errorAt: Date.now(),
              elapsed: 0,
              sessionId,
            },
          });
        }
      };
      genPoll = window.setTimeout(() => void poll(), IMAGE_GEN_FIRST_POLL_MS);
    } catch (cause) {
      stopGenTimers();
      set({
        imageGen: {
          phase: 'idle',
          error: cause instanceof Error ? cause.message : 'Could not start the generation.',
          errorAt: Date.now(),
          elapsed: 0,
          sessionId,
        },
      });
    }
  },

  cancelImageGeneration: () => {
    genToken += 1;
    stopGenTimers();
    set({ imageGen: { phase: 'idle', error: null, errorAt: null, elapsed: 0, sessionId: null } });
  },

  clearImageGenError: () => {
    set({ imageGen: { ...get().imageGen, error: null, errorAt: null } });
  },

  addImageReferences: (entries) => {
    if (entries.length === 0) return;
    set({ imageReferences: [...get().imageReferences, ...entries] });
  },

  removeImageReference: (index) => {
    set({ imageReferences: get().imageReferences.filter((_, i) => i !== index) });
  },

  replaceImageReference: (index, entry) => {
    set({ imageReferences: get().imageReferences.map((value, i) => (i === index ? entry : value)) });
  },

  clearImageReferences: () => {
    set({ imageReferences: [] });
  },

  loadImageSettings: async () => {
    try {
      const { fetchImageSettings } = await import('../lib/api');
      const settings = await fetchImageSettings();
      set({ imageRetentionDays: settings.imageRetentionDays });
    } catch {
    }
  },

  setImageRetentionDays: async (days) => {
    const previous = get().imageRetentionDays;
    set({ imageRetentionDays: days });
    try {
      const { saveImageSettings } = await import('../lib/api');
      await saveImageSettings({ imageRetentionDays: days });
    } catch {
      set({ imageRetentionDays: previous });
      get().showNotice('settings.retentionSaveFailed');
    }
  },

  loadAgentWorkspaces: async (sessionId) => {
    try {
      const { fetchAgentWorkspaces } = await import('../lib/api');
      const { workspaces, activeId } = await fetchAgentWorkspaces(sessionId);
      set({ agentWorkspaces: workspaces, activeAgentWorkspaceId: activeId });
    } catch {
    }
  },

  addAgentWorkspace: async (path, label, sessionId) => {
    const { addAgentWorkspace: addWorkspace, setActiveAgentWorkspace: setActive } =
      await import('../lib/api');
    const workspace = await addWorkspace(path, label);
    await setActive(workspace.id, sessionId);
    set({
      agentWorkspaces: [
        ...get().agentWorkspaces.filter((entry) => entry.id !== workspace.id),
        workspace,
      ],
      activeAgentWorkspaceId: workspace.id,
    });
    return workspace;
  },

  removeAgentWorkspace: async (id) => {
    const { deleteAgentWorkspace } = await import('../lib/api');
    await deleteAgentWorkspace(id);
    const cleared = get().activeAgentWorkspaceId === id;
    set({
      agentWorkspaces: get().agentWorkspaces.filter((entry) => entry.id !== id),
      ...(cleared ? { activeAgentWorkspaceId: null } : {}),
    });
  },

  setActiveAgentWorkspace: async (id, sessionId) => {
    const { setActiveAgentWorkspace: setActive } = await import('../lib/api');
    await setActive(id, sessionId);
    set({ activeAgentWorkspaceId: id });
    if (sessionId) {
      const conversation = get().conversations.find((entry) => entry.id === sessionId);
      if (conversation && conversation.workspaceId !== id) {
        get().patchConversation(sessionId, { workspaceId: id });
      }
    }
  },


  treeView: null,
  treeRules: null,
  treePanelOpen: storage.loadTreePanelOpen(),
  treePanelCollapsed: false,
  treePanelGeometry: storage.loadTreePanelGeometry(),

  loadTreeView: async (workspaceId, options) => {
    if (!workspaceId) {
      set({ treeView: null, treeRules: null });
      return;
    }
    if (treeLoadInFlight && treeLoadInFlight.workspaceId === workspaceId) {
      return treeLoadInFlight.promise;
    }
    const view = get().treeView;
    if (
      options?.force !== true &&
      view?.workspaceId === workspaceId &&
      Date.now() - treeLoadedAt < TREE_LOAD_MIN_GAP_MS
    ) {
      return;
    }
    const load = (async () => {
      try {
        const { fetchTreeSnapshot, fetchTreeRules } = await import('../lib/api');
        const [nextView, rules] = await Promise.all([
          fetchTreeSnapshot(workspaceId),
          fetchTreeRules(workspaceId),
        ]);
        set({ treeView: nextView, treeRules: rules });
        treeLoadedAt = Date.now();
      } catch {
        set({ treeView: null, treeRules: null });
      }
    })();
    treeLoadInFlight = { workspaceId, promise: load };
    try {
      await load;
    } finally {
      if (treeLoadInFlight?.promise === load) treeLoadInFlight = null;
    }
  },

  applyTreeDelta: (workspaceId, delta) => {
    const view = get().treeView;
    if (!view || view.workspaceId !== workspaceId) return;

    if (
      delta.op === 'rebuild' ||
      delta.version < view.version ||
      delta.version > view.version + 1
    ) {
      void get().loadTreeView(workspaceId, { force: true });
      return;
    }

    
    const next = structuredClone(view);
    const parts = delta.relPath.split('/').filter(Boolean);
    const parentParts = parts.slice(0, -1);
    let parent = next.root;
    let valid = true;
    for (const part of parentParts) {
      const found = parent.children.find((child) => child.name === part && child.kind === 'dir');
      if (!found) {
        valid = false;
        break;
      }
      parent = found;
    }
    if (!valid) {
      void get().loadTreeView(workspaceId);
      return;
    }

    const name = parts[parts.length - 1];
    const index = parent.children.findIndex((child) => child.name === name);

    if (delta.op === 'remove') {
      if (index !== -1) parent.children.splice(index, 1);
    } else if (delta.node) {
      const node = delta.node;
      if (index === -1) {
        const insertAt = parent.children.findIndex(
          (child) => child.kind === 'file' || child.name.localeCompare(name) > 0,
        );
        if (insertAt === -1) parent.children.push(node);
        else parent.children.splice(insertAt, 0, node);
      } else {
        parent.children[index] = node;
      }
    } else if (index === -1) {
      const node: TreeNodeInfo = {
        name,
        relPath: delta.relPath,
        kind: delta.kind,
        children: [],
        size: 0,
        mtimeMs: Date.now(),
      };
      const insertAt = parent.children.findIndex(
        (child) => child.kind === 'file' || child.name.localeCompare(name) > 0,
      );
      if (insertAt === -1) parent.children.push(node);
      else parent.children.splice(insertAt, 0, node);
    }

    next.version = delta.version;
    set({ treeView: next });
  },

  refreshTreeView: async (workspaceId) => {
    try {
      const { refreshWorkspaceTree } = await import('../lib/api');
      const view = await refreshWorkspaceTree(workspaceId);
      set({ treeView: view });
    } catch {
      get().showNotice('tree.refreshFailed');
    }
  },

  loadTreeRules: async (workspaceId) => {
    try {
      const { fetchTreeRules } = await import('../lib/api');
      set({ treeRules: await fetchTreeRules(workspaceId) });
    } catch {
    }
  },

  saveTreeRules: async (workspaceId, rules) => {
    try {
      const { saveTreeRules } = await import('../lib/api');
      const applied = await saveTreeRules(workspaceId, rules);
      set({ treeRules: applied });
      get().showNotice('tree.rulesSaved');
      void get().refreshTreeView(workspaceId);
    } catch (error) {
      get().showNotice('tree.rulesSaveFailed', undefined, {
        detail: error instanceof Error ? error.message : undefined,
      });
    }
  },

  setTreePanelOpen: (open) => {
    set({ treePanelOpen: open });
    storage.saveTreePanelOpen(open);
  },

  setTreePanelCollapsed: (collapsed) => {
    set({ treePanelCollapsed: collapsed });
  },

  setTreePanelGeometry: (geometry) => {
    set({ treePanelGeometry: geometry });
    storage.saveTreePanelGeometry(geometry);
  },

  pushPermissionRequest: (request) => {
    if (!request.id) return;
    if (get().pendingPermissions.some((entry) => entry.id === request.id)) return;
    set({ pendingPermissions: [...get().pendingPermissions, request] });
  },

  removePermissionRequest: (id) => {
    set({ pendingPermissions: get().pendingPermissions.filter((entry) => entry.id !== id) });
  },

  resolvePermissionRequest: async (id, approve, remember, reason) => {
    const { decideAgentPermission } = await import('../lib/api');
    try {
      await decideAgentPermission(id, approve, remember, reason);
    } catch (error) {
      get().showNotice('permission.decideFailed', undefined, {
        detail: error instanceof Error ? error.message : undefined,
      });
    }
    get().removePermissionRequest(id);
  },

  pushAskUserRequest: (request) => {
    if (!request.id) return;
    if (get().pendingAskUser.some((entry) => entry.id === request.id)) return;
    set({ pendingAskUser: [...get().pendingAskUser, request] });
  },

  removeAskUserRequest: (id) => {
    set({ pendingAskUser: get().pendingAskUser.filter((entry) => entry.id !== id) });
  },

  setPendingAskUser: (requests) => {
    set({ pendingAskUser: requests });
  },

  submitAskUserAnswers: async (id, answers) => {
    const { answerAgentQuestions } = await import('../lib/api');
    try {
      await answerAgentQuestions(id, answers);
    } catch (error) {
      get().showNotice('ask.deliverFailed', undefined, {
        detail: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    get().removeAskUserRequest(id);
  },

  pushOperatorGate: (request) => {
    if (!request.id) return;
    if (get().pendingOperatorGates.some((entry) => entry.id === request.id)) return;
    set({ pendingOperatorGates: [...get().pendingOperatorGates, request] });
  },

  removeOperatorGate: (id) => {
    set({ pendingOperatorGates: get().pendingOperatorGates.filter((entry) => entry.id !== id) });
  },

  setPendingOperatorGates: (requests) => {
    set({ pendingOperatorGates: requests });
  },

  resolveOperatorGate: async (id, verdict, reason) => {
    const { decideOperatorGate } = await import('../lib/api');
    try {
      await decideOperatorGate(id, verdict, reason);
    } catch (error) {
      get().showNotice('gate.decideFailed', undefined, {
        detail: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    get().removeOperatorGate(id);
  },

  setModel: (model) => {
    set({ model });
    storage.saveModel(model);
    const conversation = get().activeConversation();
    if (conversation) {
      const next = get().conversations.map((entry) =>
        entry.id === conversation.id
          ? { ...entry, model, rev: (entry.rev ?? 0) + 1 }
          : entry,
      );
      settingsDirtyIds.add(conversation.id);
      set({ conversations: next });
      persist(next);
      void commitConfigToServer(conversation.id, { model });
    }
  },

  newConversation: (options) => {
    const { providerId, model, pendingSettings } = get();
    const conversation = makeConversation({
      providerId: options?.providerId ?? providerId,
      model: options?.model ?? model,
      categoryId: options?.categoryId,
      workspaceId: options?.workspaceId,
      councilId: options?.councilId,
      councilRole: options?.councilRole,
      councilAgentId: options?.councilAgentId,
    });
    conversation.settings = {
      ...pendingSettings,
      enforcement: { ...DEFAULT_SETTINGS.enforcement },
      probation: { ...DEFAULT_SETTINGS.probation },
    };
    const next = [conversation, ...get().conversations];
    set({ conversations: next, activeId: conversation.id, view: 'playground' });
    persist(next);
    storage.saveActiveId(conversation.id);
    storage.saveView('playground');
    // 2026-10 BUGFIX: the '+' picker set only conversation.workspaceId — the
    if (options?.workspaceId) {
      void get().setActiveAgentWorkspace(options.workspaceId, conversation.id);
    }
    return conversation.id;
  },

  selectConversation: (id) => {
    const conversation = get().conversations.find((entry) => entry.id === id);
    const patch: Partial<AppState> = { activeId: id, view: 'playground' as ViewId };
    if (conversation) {
      if (conversation.providerId) {
        patch.providerId = conversation.providerId;
        storage.saveProviderId(conversation.providerId);
      }
      if (conversation.model) {
        patch.model = conversation.model;
        storage.saveModel(conversation.model);
      }
    }
    set(patch);
    storage.saveActiveId(id);
    storage.saveView('playground');
  },

  deleteConversation: (id) => {
    if (get().confirmDel) {
      set({ pendingConfirmDelete: id });
      return;
    }
    get().executeDeleteConversation(id);
  },
  executeDeleteConversation: (id) => {
    if (get().compactingId === id) {
      abortCompaction(id);
      set({ compactingId: null });
    }
    pendingDeletions.add(id);
    const deleted = get().conversations.find((conversation) => conversation.id === id);
    const councilId = deleted?.councilId;
    const councilSubs = (councilId && deleted?.councilRole === 'main')
      ? get().conversations.filter(
          (conversation) => conversation.councilId === councilId && conversation.councilRole === 'sub',
        )
      : [];
    const dropped = councilSubs.map((conversation) => conversation.id);
    for (const subId of dropped) {
      pendingDeletions.add(subId);
      configuredConversationIds.delete(subId);
      settingsDirtyIds.delete(subId);
    }
    configuredConversationIds.delete(id);
    settingsDirtyIds.delete(id);
    const next = get().conversations.filter((conversation) => !pendingDeletions.has(conversation.id));
    const currentActiveId = get().activeId ?? '';
    const activeId = (currentActiveId === id || dropped.includes(currentActiveId))
      ? newestConversationId(next)
      : get().activeId;
    set({ conversations: next, activeId });
    persist(next);
    storage.saveActiveId(activeId);
  },
  confirmPendingDelete: () => {
    const id = get().pendingConfirmDelete;
    if (!id) return;
    set({ pendingConfirmDelete: null });
    get().executeDeleteConversation(id);
  },
  cancelPendingDelete: () => set({ pendingConfirmDelete: null }),

  renameConversation: (id, title) => {
    withLoadedBody(id, () => {
      const next = get().conversations.map((conversation) =>
        conversation.id === id
          ? {
              ...conversation,
              title: title.trim() || 'New chat',
              // (the reported "sesi dinamai acak" bug). The bump also moves
              updatedAt: Date.now(),
              rev: (conversation.rev ?? 0) + 1,
            }
          : conversation,
      );
      set({ conversations: next });
      persist(next);
    });
  },

  setCompaction: (id, compaction) => {
    const next = get().conversations.map((conversation) =>
      conversation.id === id
        ? { ...conversation, compaction, rev: (conversation.rev ?? 0) + 1 }
        : conversation,
    );
    settingsDirtyIds.add(id);
    set({ conversations: next });
    persist(next);
    void commitConfigToServer(id, { compaction: compaction ?? null });
  },

  deleteTurn: (conversationId, turnId) => {
    const conversation = get().conversations.find((entry) => entry.id === conversationId);
    const index = conversation?.turns.findIndex((turn) => turn.id === turnId) ?? -1;
    if (!conversation || index < 0) return;
    const removed = conversation.turns[index];
    const drop = new Set<string>([turnId]);
    if (removed.role === 'user') {
      for (let i = index + 1; i < conversation.turns.length; i += 1) {
        const turn = conversation.turns[i];
        if (isGhostTurn(turn)) {
          drop.add(turn.id);
          continue;
        }
        if (turn.role === 'assistant') drop.add(turn.id);
        break;
      }
    }
    get().dropTurns(conversationId, [...drop]);
  },

  dropTurns: (conversationId, turnIds) => {
    if (turnIds.length === 0) return;
    const conversation = get().conversations.find((entry) => entry.id === conversationId);
    if (!conversation) return;
    const drop = new Set(turnIds);
    const droppingLiveCompaction =
      get().compactingId === conversationId &&
      conversation.turns.some((turn) => drop.has(turn.id) && turn.kind === 'compaction');
    if (droppingLiveCompaction) {
      abortCompaction(conversationId);
      set({ compactingId: null });
    }
    const turns = conversation.turns.filter((turn) => !drop.has(turn.id));
    if (turns.length === conversation.turns.length) return;
    markTurnsTombstone([...drop]);
    // regenerate→second-tab→two-replies bug). The sync batch turns these into
    rememberTurnDeletion(conversationId, [...drop]);
    // on every sync (the reported hapus→muncul-lagi bug).
    const next = get().conversations.map((entry) =>
      entry.id === conversationId
        ? { ...entry, turns, rev: (entry.rev ?? 0) + 1 }
        : entry,
    );
    set({ conversations: next });
    persist(next);
    // regenerate bug). syncedJson is cleared so the FIRST non-generating
    syncedTurnCount.set(conversationId, turns.length);
    syncedJson.delete(conversationId);
    get().setLiveContext(conversationId, null);
    if (serverKnownIds.has(conversationId)) {
      void patchConversationConfig(conversationId, { liveContext: null });
    }
  },

  branchFromTurn: (conversationId, turnId) => {
    const source = get().conversations.find((conversation) => conversation.id === conversationId);
    if (!source) return;
    const index = source.turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) return;

    const selected = source.turns[index];
    const keep = selected.role === 'assistant' &&
            !selected.content &&
            !selected.reasoning &&
            !selected.segments?.length
      ? source.turns.slice(0, index)
      : source.turns.slice(0, index + 1);

    const now = Date.now();
    const branch: Conversation = {
      ...source,
      id: uid('chat'),
      title: `${source.title} · branch`,
      createdAt: now,
      updatedAt: now,
      turns: keep.map((turn) => ({ ...turn })),
      compaction: undefined,
    };
    const next = [branch, ...get().conversations];
    set({ conversations: next, activeId: branch.id, view: 'playground' });
    persist(next);
    storage.saveActiveId(branch.id);
    storage.saveView('playground');
  },

  clearAllConversations: () => {
    const compacting = get().compactingId;
    if (compacting) {
      abortCompaction(compacting);
      set({ compactingId: null });
    }
    for (const conversation of get().conversations) pendingDeletions.add(conversation.id);
    set({ conversations: [], activeId: null });
    persist([]);
    storage.saveActiveId(null);
  },

  replaceConversations: (conversations) => {
    // "open a new chat, get thrown into the oldest one" bug: the phantom
    const current = get().activeId;
    const activeId =
      current && conversations.some((entry) => entry.id === current)
        ? current
        : newestConversationId(conversations);
    const nextLive = mergeLiveContextFromConversations(get().liveContext, conversations);
    set({
      conversations,
      activeId,
      ...(nextLive !== get().liveContext ? { liveContext: nextLive } : {}),
    });
    persist(conversations);
    storage.saveActiveId(activeId);
  },

  hydrateConversation: (id) => {
    const entry = get().conversations.find((conversation) => conversation.id === id);
    if (!entry || entry.turnsLoaded !== false) return Promise.resolve();
    const inFlight = hydrating.get(id);
    if (inFlight) return inFlight;

    const load = (async () => {
      const fullRaw = await fetchConversationDetail(id);
      const current = get().conversations.find((conversation) => conversation.id === id);
      if (!fullRaw || !current) return;
      if (current.turnsLoaded !== false) return;
      // never enter the render path (the stale-DOM ghosts bug).
      const preserveLocalConfig = settingsDirtyIds.has(id) || configSyncInFlight.has(id);
      const mergedLive = pickNewerLiveContext(current.liveContext, fullRaw.liveContext);
      const full: Conversation = {
        ...fullRaw,
        turns: dedupeTurns(fullRaw.turns),
        ...(mergedLive ? { liveContext: mergedLive } : {}),
        ...(preserveLocalConfig
          ? {
              settings: current.settings,
              providerId: current.providerId,
              model: current.model,
              ...(current.compaction !== undefined ? { compaction: current.compaction } : {}),
            }
          : {}),
      };
      const next = get().conversations.map((conversation) =>
        conversation.id === id ? full : conversation,
      );
      const nextLive = mergeLiveContextFromConversations(get().liveContext, [full]);
      set({
        conversations: next,
        ...(nextLive !== get().liveContext ? { liveContext: nextLive } : {}),
      });
      if (!preserveLocalConfig) {
        syncedJson.set(id, JSON.stringify(full));
      }
      syncedTurnCount.set(id, full.turns.length);
      lastSyncSnapshot = next;
    })()
      .catch(() => {
      })
      .finally(() => {
        hydrating.delete(id);
      });
    hydrating.set(id, load);
    return load;
  },

  adoptFetchedBody: (fetchedRaw) => {
    const fetchedClean = { ...fetchedRaw, turns: dedupeTurns(fetchedRaw.turns) };
    const current = get().conversations.find((conversation) => conversation.id === fetchedClean.id);
    if (!current) return;
    if (keepLocalFullBody(current, fetchedClean)) return;
    const preserveLocalConfig =
      settingsDirtyIds.has(fetchedClean.id) || configSyncInFlight.has(fetchedClean.id);
    const mergedLive = pickNewerLiveContext(current.liveContext, fetchedClean.liveContext);
    const fetched: Conversation = preserveLocalConfig
      ? {
          ...fetchedClean,
          settings: current.settings,
          providerId: current.providerId,
          model: current.model,
          ...(mergedLive ? { liveContext: mergedLive } : {}),
          ...(current.compaction !== undefined ? { compaction: current.compaction } : {}),
        }
      : {
          ...fetchedClean,
          ...(mergedLive ? { liveContext: mergedLive } : {}),
        };
    const next = get().conversations.map((conversation) =>
      conversation.id === fetched.id ? fetched : conversation,
    );
    const nextLive = mergeLiveContextFromConversations(get().liveContext, [fetched]);
    set({
      conversations: next,
      ...(nextLive !== get().liveContext ? { liveContext: nextLive } : {}),
    });
    if (!preserveLocalConfig) {
      syncedJson.set(fetched.id, JSON.stringify(fetched));
    }
    syncedTurnCount.set(fetched.id, fetched.turns.length);
    lastSyncSnapshot = next;
  },

  importConversation: (conversation) => {
    const id = get().conversations.some((entry) => entry.id === conversation.id)
      ? uid('chat')
      : conversation.id;
    const imported: Conversation = { ...conversation, id };
    const next = [imported, ...get().conversations];
    set({ conversations: next, activeId: imported.id, view: 'playground' });
    persist(next);
    storage.saveActiveId(imported.id);
    storage.saveView('playground');
    return imported.id;
  },

  appendTurn: (conversationId, turn) => {
    const safeTurn: Turn = { ...turn, content: typeof turn.content === 'string' ? turn.content : '' };
    const next = get().conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      if (conversation.turns.some((entry) => entry.id === safeTurn.id)) {
        return {
          ...conversation,
          turns: conversation.turns.map((entry) => (entry.id === safeTurn.id ? safeTurn : entry)),
          updatedAt: Date.now(),
        };
      }
      return {
        ...conversation,
        turns: [...conversation.turns, safeTurn],
        updatedAt: Date.now(),
        title:
          conversation.turns.length === 0 &&
          turn.role === 'user' &&
          conversation.title === 'New chat'
            ? turn.content.replace(/\s+/g, ' ').trim().slice(0, 52) || 'New chat'
            : conversation.title,
      };
    });
    set({ conversations: next });
    persist(next);
  },

  upsertHarnessEvent: (conversationId, turn) => {
    const safeTurn: Turn = { ...turn, content: typeof turn.content === 'string' ? turn.content : '' };
    const next = get().conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      const exists = conversation.turns.some((entry) => entry.id === safeTurn.id);
      return {
        ...conversation,
        turns: exists
          ? conversation.turns.map((entry) => (entry.id === safeTurn.id ? safeTurn : entry))
          : [...conversation.turns, safeTurn],
        updatedAt: Date.now(),
      };
    });
    set({ conversations: next });
    persist(next);
  },

  updateTurn: (conversationId, turnId, patch) => {
    // dead turn (second half of the hapus→muncul-lagi bug).
    if (isTurnTombstoned(turnId)) return;
    const next = get().conversations.map((conversation) =>
      conversation.id === conversationId
        ? {
            ...conversation,
            // NOTE: `updatedAt` is intentionally NOT touched here. This fires
            rev: (conversation.rev ?? 0) + 1,
            turns: conversation.turns.map((turn) =>
              turn.id === turnId ? { ...turn, ...patch } : turn,
            ),
          }
        : conversation,
    );
    set({ conversations: next });
    persist(next);
  },

  trimReasoning: (conversationId) => {
    const conversation = get().conversations.find((entry) => entry.id === conversationId);
    if (!conversation) return 0;
    const { turns, trimmed } = stripReasoning(conversation.turns);
    if (trimmed === 0) return 0;
    const existingLive = get().liveContext[conversationId] ?? conversation.liveContext;
    const adjustedLive: LiveContextTelemetry | undefined =
      existingLive && existingLive.buckets && existingLive.buckets.reasoningTokens > 0
        ? (() => {
            const removed = existingLive.buckets!.reasoningTokens;
            const nextTotal = Math.max(0, existingLive.liveContextTokens - removed);
            return {
              ...existingLive,
              liveContextTokens: nextTotal,
              ratio: existingLive.contextLimit ? Math.min(1, nextTotal / existingLive.contextLimit) : existingLive.ratio,
              buckets: {
                ...existingLive.buckets!,
                reasoningTokens: 0,
                totalTokens: nextTotal,
              },
              at: Date.now(),
            };
          })()
        : existingLive;
    const next = get().conversations.map((entry) =>
      entry.id === conversationId
        ? {
            ...entry,
            rev: (entry.rev ?? 0) + 1,
            turns,
            ...(adjustedLive ? { liveContext: adjustedLive } : {}),
          }
        : entry,
    );
    const nextLiveMap =
      adjustedLive && adjustedLive !== existingLive
        ? { ...get().liveContext, [conversationId]: adjustedLive }
        : get().liveContext;
    set({
      conversations: next,
      ...(nextLiveMap !== get().liveContext ? { liveContext: nextLiveMap } : {}),
    });
    persist(next);
    if (adjustedLive && adjustedLive !== existingLive && serverKnownIds.has(conversationId)) {
      void patchConversationConfig(conversationId, { liveContext: adjustedLive });
    }
    return trimmed;
  },

  patchConversation: (conversationId, patch) => {
    const next = get().conversations.map((conversation) =>
      conversation.id === conversationId
        ? { ...conversation, ...patch, rev: (conversation.rev ?? 0) + 1 }
        : conversation,
    );
    set({ conversations: next });
    persist(next);
    // 2026-10 BUGFIX: "Move to workspace" dari pill TopBar dulu hanya mem-
    if (patch.workspaceId) {
      void get().setActiveAgentWorkspace(patch.workspaceId, conversationId).catch(() => {});
    }
  },

  setConversationGoals: (conversationId, goals) => {
    get().patchConversation(conversationId, { goals });
  },

  setConversationTodos: (conversationId, todos) => {
    get().patchConversation(conversationId, { todos });
  },

  updateSettings: (patch, conversationId) => {
    const conversation = conversationId
      ? get().conversations.find((entry) => entry.id === conversationId)
      : get().activeConversation();

    // session — the "lockdown terbawa" bug. They are written to the target
    const staged = { ...patch };
    delete staged.enforcement;
    delete staged.probation;
    delete staged.lockdown;

    const nextPending: ChatSettings = {
      ...get().pendingSettings,
      ...staged,
    };
    storage.savePendingSettings(nextPending);

    if (!conversation) {
      set({ pendingSettings: nextPending });
      if ('webAccess' in patch) {
        void setWebAccessRemote(patch.webAccess === true, conversationId ?? get().activeId ?? undefined);
      }
      return;
    }

    const nextSettings: ChatSettings = { ...conversation.settings, ...patch };
    const next = get().conversations.map((entry) =>
      entry.id === conversation.id
        ? { ...entry, settings: nextSettings, rev: (entry.rev ?? 0) + 1 }
        : entry,
    );
    settingsDirtyIds.add(conversation.id);
    set({
      conversations: next,
      pendingSettings: nextPending,
    });
    persist(next);
    void commitConfigToServer(conversation.id, {
      settings: nextSettings,
      providerId: conversation.providerId,
      model: conversation.model,
    });

    if ('webAccess' in patch) {
      void setWebAccessRemote(patch.webAccess === true, conversation.id);
    }
  },

  setView: (view) => {
    set({ view });
    storage.saveView(view);
  },
  toggleSidebar: () => {
    const sidebarCollapsed = !get().sidebarCollapsed;
    set({ sidebarCollapsed });
    storage.saveSidebarCollapsed(sidebarCollapsed);
  },
  setReasoningOpen: (key, open) =>
    set((state) => ({ reasoningOpen: { ...state.reasoningOpen, [key]: open } })),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setSettingsWidth: (width) => set({ settingsWidth: width }),
  
  commitSidebarWidth: () => storage.saveSidebarWidth(get().sidebarWidth),
  commitSettingsWidth: () => storage.saveSettingsWidth(get().settingsWidth),
  commitDiffDockWidth: () => storage.saveDiffDockWidth(get().diffDockWidth),
  toggleSettings: () => {
    const settingsOpen = !get().settingsOpen;
    set({ settingsOpen });
    storage.saveSettingsOpen(settingsOpen);
  },
  setRightPanelMode: (mode) => {
    set({ rightPanelMode: mode });
    storage.saveRightPanelMode(mode);
  },
  requestImagePicker: () => {
    set({ settingsOpen: true, rightPanelMode: 'config', imagePickerWanted: true });
    storage.saveSettingsOpen(true);
    storage.saveRightPanelMode('config');
  },
  consumeImagePickerRequest: () => {
    if (get().imagePickerWanted) set({ imagePickerWanted: false });
  },
  requestImageStudioPrompt: (prompt) => set({ imageStudioPromptWanted: prompt }),
  consumeImageStudioPromptRequest: () => {
    if (get().imageStudioPromptWanted !== null) set({ imageStudioPromptWanted: null });
  },
  openDiffPanel: (turnId) => {
    set({
      diffPanelTurnId: turnId,
      rightPanelMode: 'diff',
      settingsOpen: true,
    });
    storage.saveRightPanelMode('diff');
    storage.saveSettingsOpen(true);
    storage.saveDiffPanelTurnId(turnId);
  },
  setDiffPanelTurnId: (turnId) => {
    set({ diffPanelTurnId: turnId });
    storage.saveDiffPanelTurnId(turnId);
  },
  setDiffDockWidth: (width) => set({ diffDockWidth: width }),
  setTheme: (theme, ev) => {
    if (get().theme === theme) return;
    const state = get();
    transitionAppearance(
      {
        theme,
        accent: state.accent,
        density: state.density,
        ambient: state.ambient,
        fontFamily: state.fontFamily,
        reduceMotion: state.reduceMotion,
      },
      () => {
        set({ theme });
        storage.saveTheme(theme);
      },
      ev,
    );
  },
  setAccent: (accent) => {
    set({ accent });
    storage.saveAccent(accent);
  },
  setDensity: (density) => {
    set({ density });
    storage.saveDensity(density);
  },
  setAmbient: (ambient) => {
    set({ ambient });
    storage.saveAmbient(ambient);
  },
  setReduceMotion: (reduceMotion) => {
    set({ reduceMotion });
    storage.saveReduceMotion(reduceMotion);
  },
  setConfirmDel: (confirmDel) => {
    set({ confirmDel });
    storage.saveConfirmDel(confirmDel);
  },
  setFontScale: (fontScale) => {
    const safe = Math.min(1.4, Math.max(0.8, fontScale));
    set({ fontScale: safe });
    storage.saveFontScale(safe);
  },
  setContextScale: (contextScale) => {
    const safe = Math.min(1.4, Math.max(0.8, contextScale));
    set({ contextScale: safe });
    storage.saveContextScale(safe);
  },
  setFontFamily: (fontFamily) => {
    set({ fontFamily });
    storage.saveFontFamily(fontFamily);
  },
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setComposerRole: (composerRole) => set({ composerRole }),
  queueComposerFiles: (files) =>
    set((state) => ({ composerQueuedFiles: [...state.composerQueuedFiles, ...files] })),
  clearComposerQueuedFiles: () => set({ composerQueuedFiles: [] }),

  markRunStopped: (id) =>
    set((state) => ({ stoppedRuns: { ...state.stoppedRuns, [id]: true } })),
  clearRunStopped: (id) =>
    set((state) => {
      if (!state.stoppedRuns[id]) return state;
      const next = { ...state.stoppedRuns };
      delete next[id];
      return { stoppedRuns: next };
    }),

  showNotice: (id, params, opts) => {
    const entry = makeNotice(id, params, opts);
    if (!entry) return;
    set((state) => {
      const next = reduceNotices({ notices: state.notices, history: state.noticeHistory }, entry);
      return { notices: next.notices, noticeHistory: next.history };
    });
  },
  dismissNotice: (key) =>
    set((state) => ({ notices: state.notices.filter((notice) => notice.key !== key) })),
  toggleNoticeHistory: () =>
    set((state) => ({ noticeHistoryExpanded: !state.noticeHistoryExpanded })),
  clearNoticeHistory: () => set({ noticeHistory: [], noticeHistoryExpanded: false }),
  setCompacting: (id) => set({ compactingId: id }),
  setLiveContext: (conversationId, telemetry) =>
    set((state) => {
      const conv = state.conversations.find((entry) => entry.id === conversationId);
      const currentLive = state.liveContext[conversationId] ?? conv?.liveContext;
      const nextLiveMap = { ...state.liveContext };
      let resolved: LiveContextTelemetry | undefined;
      if (telemetry) {
        resolved = pickNewerLiveContext(currentLive, telemetry) ?? telemetry;
        nextLiveMap[conversationId] = resolved;
      } else {
        delete nextLiveMap[conversationId];
      }
      const nextConversations = state.conversations.map((entry) => {
        if (entry.id !== conversationId) return entry;
        if (resolved) return { ...entry, liveContext: resolved };
        const rest = { ...entry };
        delete rest.liveContext;
        return rest;
      });
      return { liveContext: nextLiveMap, conversations: nextConversations };
    }),
  settleLiveContext: (conversationId, tokens) => {
    let settledConversations: Conversation[] | null = null;
    set((state) => {
      const conv = state.conversations.find((entry) => entry.id === conversationId);
      const current = state.liveContext[conversationId] ?? conv?.liveContext;
      if (!current) return {};
      const fallbackTotal =
        current.promptTokens + current.completionTokens > 0
          ? current.promptTokens + current.completionTokens
          : (current.buckets?.totalTokens ?? 0) > 0
            ? current.buckets!.totalTokens
            : current.liveContextTokens;
      const settled =
        typeof tokens === 'number' ? Math.max(0, tokens) : Math.max(0, fallbackTotal);
      const nextTelemetry: LiveContextTelemetry = {
        ...current,
        addedTokens: 0,
        liveContextTokens: settled,
        ratio: current.contextLimit ? Math.min(1, settled / current.contextLimit) : current.ratio,
        at: Date.now(),
      };
      settledConversations = state.conversations.map((entry) =>
        entry.id === conversationId ? { ...entry, liveContext: nextTelemetry } : entry,
      );
      return {
        liveContext: {
          ...state.liveContext,
          [conversationId]: nextTelemetry,
        },
        conversations: settledConversations,
      };
    });
    if (settledConversations) persist(settledConversations);
  },
  setGenRunning: (id, running) => {
    const next = { ...useStore.getState().genRunning };
    if (running) {
      next[id] = true;
    } else {
      delete next[id];
    }
    const started = { ...useStore.getState().genStartedAt };
    if (running && started[id] === undefined) started[id] = Date.now();
    if (!running) delete started[id];
    storage.saveGenStartedAt(started);
    storage.saveGenRunning(next);
    set({ genRunning: next, genStartedAt: started });
    if (running) return;
    flushPersist();
    void runServerSync();
  },
  addPendingSteer: (conversationId, id, text) =>
    set((state) => ({
      pendingSteers: { ...state.pendingSteers, [conversationId]: [...(state.pendingSteers[conversationId] ?? []), { id, text }] },
    })),
  addPendingSteerParts: (conversationId, id, parts) =>
    set((state) => ({
      pendingSteers: {
        ...state.pendingSteers,
        [conversationId]: [
          ...(state.pendingSteers[conversationId] ?? []),
          {
            id,
            text: parts
              .map((part) =>
                part.type === 'text'
                  ? part.text
                  : part.type === 'image_url'
                    ? '[image attached]'
                    : part.type === 'video_url'
                      ? '[video attached]'
                      : `[file attached: ${part.file.filename}]`,
              )
              .filter((line) => line.trim().length > 0)
              .join('\n\n'),
            parts,
          },
        ],
      },
    })),
  removePendingSteer: (conversationId, id) =>
    set((state) => ({
      pendingSteers: { ...state.pendingSteers, [conversationId]: (state.pendingSteers[conversationId] ?? []).filter((entry) => entry.id !== id) },
    })),
  clearPendingSteers: (conversationId) =>
    set((state) => ({
      pendingSteers: { ...state.pendingSteers, [conversationId]: [] },
    })),

  setCrashedRun: (id, run) =>
    set((state) => {
      const crashedRuns = { ...state.crashedRuns };
      if (run) crashedRuns[id] = run;
      else delete crashedRuns[id];
      return { crashedRuns };
    }),

  activeConversation: () => {
    const { conversations, activeId } = get();
    return conversations.find((conversation) => conversation.id === activeId);
  },

  activeProvider: () => {
    const { providers, providerId } = get();
    return providers.find((provider) => provider.id === providerId);
  },

  activeAgentWorkspace: () => {
    const { agentWorkspaces, activeAgentWorkspaceId } = get();
    return agentWorkspaces.find((workspace) => workspace.id === activeAgentWorkspaceId);
  },
}));


export function resolveCapability(
  providerId: string | undefined,
  modelId: string | undefined,
): ResolvedModelCapability | undefined {
  if (!modelId) return undefined;
  const state = useStore.getState();
  const catalogEntry =
    Object.keys(state.modelMeta).length > 0
      ? lookupModelMeta(state.modelMeta, modelId)
      : undefined;
  return resolveForProvider(
    state.providers,
    providerId || state.providerId,
    modelId,
    catalogEntry,
  );
}



export function useEffectiveSettings(): ChatSettings {
  const conversation = useStore((state) => state.conversations.find((c) => c.id === state.activeId));
  const pending = useStore((state) => state.pendingSettings);
  return conversation?.settings ?? pending;
}
