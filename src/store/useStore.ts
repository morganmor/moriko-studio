import { create } from 'zustand';

import { makeNotice, reduceNotices, type MessageId, type MessageTone, type NoticeEntry } from '../lib/messageCatalog';
import type {
  AgentPermissionRequest,
  AskAnswer,
  AskUserRequest,
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
import { stripReasoning } from '../lib/compaction';
import { setWebAccessRemote } from '../lib/api';
import { isGhostTurn } from '../lib/turns';
import {
  beaconSyncConversations,
  fetchConversationDetail,
  fetchConversationSummaries,
  syncConversations,
} from '../lib/api';

export const DEFAULT_SETTINGS: ChatSettings = {
  systemInstruction: '',
  thinkingLevel: 'medium',
  temperature: 1,
  /** `null` = Max: no client cap, the provider applies its own ceiling. */
  maxOutputTokens: null,
  topP: 0.95,
  structuredOutputs: false,
  useMcp: false,
  agentMode: false,
  agentWorkflow: '',
  terminalMode: 'auto',
  confirmDeletes: false,
  fetchWeb: false,
  /** Web access kill-switch — OFF by default (opt-in per conversation). */
  webAccess: false,
  maxContextTokens: null,
  autoCompact: true,
  compactThresholdTokens: null,
  compactThresholdRatio: 0.95,
  summarizerEnabled: false,
  summarizerProviderId: null,
  summarizerModel: null,
  imageOffload: true,
  enforcement: { level: 0, mode: 'manual', message: '' },
  probation: { enabled: false },
};

interface AppState {
  providers: ProviderPublic[];
  providersLoading: boolean;
  providersError: string | null;
  providerId: string;
  model: string;
  /** Image Studio's own provider/model choice, independent from the chat one. */
  imageProviderId: string;
  imageModel: string;
  /** Output-size test controls, forwarded to the provider as-is. */
  imageSizeMode: ImageSizeMode;
  imageAspectRatio: string;
  imagePixelWidth: string;
  imagePixelHeight: string;
  /** Persisted, user-ordered Gallery collection of image URLs. */
  galleryImages: string[];

  /** All generation sessions, newest activity first (server-persisted). */
  imageSessions: ImageSession[];
  /** The session the user is generating into; null until one is picked/created. */
  activeImageSessionId: string | null;
  /** Server retention window for temporary images; null until fetched. */
  imageRetentionDays: number | null;

  /**
   * The submit/poll lifecycle lives HERE, not in the component: navigating
   * away from Image Studio used to unmount the poller and silently abandon
   * in-flight generations. `sessionId` pins where the result will land.
   */
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
    /** Reference images (data URLs) — forwarded as-is; the endpoint's own
        capacity (not any model tag) decides whether they can be sent. */
    images?: string[];
  }) => Promise<void>;
  cancelImageGeneration: () => void;
  clearImageGenError: () => void;

  /**
   * Image Studio reference tray (data URLs), shared by the composer, the
   * client-side editor and "use as reference" actions. In-memory only —
   * images never touch browser storage (privacy rule).
   */
  imageReferences: string[];
  /** Appends references; the caller enforces the per-model cap. */
  addImageReferences: (entries: string[]) => void;
  removeImageReference: (index: number) => void;
  replaceImageReference: (index: number, entry: string) => void;
  clearImageReferences: () => void;

  conversations: Conversation[];
  activeId: string | null;

  /** Directories registered on the server for the agent tools. */
  agentWorkspaces: AgentWorkspaceInfo[];
  /** The workspace the harness tools operate on; null = none picked yet. */
  activeAgentWorkspaceId: string | null;
  /**
   * Sandbox gate queue: the agent wants to operate OUTSIDE the workspace and
   * needs the user's decision. The tool call on the server is paused until
   * this is answered (auto-denied after 2 minutes).
   */
  pendingPermissions: AgentPermissionRequest[];
  pushPermissionRequest: (request: AgentPermissionRequest) => void;
  removePermissionRequest: (id: string) => void;
  resolvePermissionRequest: (id: string, approve: boolean, remember: boolean) => Promise<void>;

  /**
   * Ask-user queue: the agent asked the user 1..N questions via agent__ask_user
   * and its tool call is PAUSED until this is answered (auto-skipped after the
   * wait window). Mirrors the sandbox permission queue above.
   */
  pendingAskUser: AskUserRequest[];
  pushAskUserRequest: (request: AskUserRequest) => void;
  removeAskUserRequest: (id: string) => void;
  /** C3: reconcile with the SERVER's pending list (visibility/reconnect sync). */
  setPendingAskUser: (requests: AskUserRequest[]) => void;
  submitAskUserAnswers: (id: string, answers: AskAnswer[]) => Promise<void>;

  /**
   * Import a sanitized conversation (from an export file) into the list:
   * id collisions get a fresh id, the import is selected, and everything
   * persists like any other thread. Returns the id it landed under.
   */
  importConversation: (conversation: Conversation) => string;

  view: ViewId;
  sidebarCollapsed: boolean;
  /** Left rail width in px (drag-resizable, device-persisted). */
  sidebarWidth: number;
  /** Right configuration panel width in px (drag-resizable, device-persisted). */
  settingsWidth: number;
  settingsOpen: boolean;
  /** 6B: what lives in the right dock — the Configuration panel or the
      docked project Tree. New exclusive panels slot in as a new mode. */
  rightPanelMode: 'config' | 'tree' | 'addons' | 'diff';
  /** DIFF PANEL: which turn's changes the panel is scoped to (null = all). */
  diffPanelTurnId: string | null;
  /**
   * DIFF PANEL dock width — SEPARATE from settingsWidth on purpose: the split
   * view needs a wider dock (default 760, drag-resizable), and closing the
   * panel must return the dock to its normal width untouched (the spec:
   * "split melebar otomatis khusus diff, saat panel ditutup semua kembali
   * normal"). Transient — not device-persisted.
   */
  diffDockWidth: number;
  theme: ThemeMode;
  /** Theme mechanism (design theme-mechanism): accent swatch, row density. */
  accent: Accent;
  density: Density;
  /** Ambient glow behind the app (design's .no-amb gate). */
  ambient: boolean;
  /** Tri-state like the design: null = follow prefers-reduced-motion. */
  reduceMotion: boolean | null;
  /** Panel-settings: gate chat deletion behind a confirm dialog. */
  confirmDel: boolean;
  /** Chat id waiting on that confirm dialog (null = none). */
  pendingConfirmDelete: string | null;
  /** App chrome zoom: everything except the chat context. 1 = default. */
  fontScale: number;
  /** Chat-context zoom: the thread and composer only. 1 = default. */
  contextScale: number;
  /** Workspace font style, applied on <html> as data-font (see index.css). */
  fontFamily: FontFamily;
  /** Per-model capability metadata (models.dev snapshot), loaded once. */
  modelMeta: Record<string, ModelMeta>;
  /** Which rail section is expanded in the sidebar. */
  searchQuery: string;
  /**
   * HARNESS POP: the banner that pops below the session name for harness
   * events (evasion reminders, escalations). One at a time — a newer event
   * replaces the older one. Lifetime controls how long it holds before its
   * pop-out animation runs.
   *
   * REMOVED (Fase A): merged into the catalog-backed Notice Center. Harness
   * events now flow through showNotice like every other message — same spot
   * under the session title, but opaque, stacked, deduped, with a history
   * trail instead of a single self-replacing banner.
   */
  notices: NoticeEntry[];
  /** Session trail of every notice shown — the pop never loses what it
   *  replaced; the bell under the session title expands it. */
  noticeHistory: NoticeEntry[];
  noticeHistoryExpanded: boolean;
  /** Conversation ids with a generation in flight — parallel across chats. */
  genRunning: Record<string, boolean>;
  /**
   * The conversation a COMPACTION is running for right now, or null — ONE at a
   * time, everywhere. The "Compact now" button reads this for its busy
   * indicator and every compaction entry point guards on it, so repeated
   * clicks (or an auto trigger landing mid-compaction) can never stack a
   * second summarization request on top of the first — a real thread once
   * accumulated four checkpoint cards from one button. Transient, never
   * persisted: a reload forgets it the way it forgets a live socket.
   */
  compactingId: string | null;
  /**
   * Runs the user STOPPED in this tab, until the server confirms they are
   * gone. The sidebar badge is the union of `genRunning` and the registry's
   * live list, and the registry deliberately keeps an aborted run inside its
   * grace window — so without this the row kept spinning for a run the user
   * had already ended. Suppressing it here (rather than only clearing
   * `genRunning`) is what makes a Stop look like a Stop.
   */
  stoppedRuns: Record<string, true>;
  markRunStopped: (id: string) => void;
  clearRunStopped: (id: string) => void;
  /**
   * OPTIMISTIC STEER BUBBLES: steers the user SENT but the stream has not yet
   * echoed back (the `steer` event fires only when the adapter drains the
   * buffer between tool rounds — potentially minutes later). Rendered as
   * pending bubbles so the user gets immediate visual confirmation; removed
   * when the echo (same id) lands, or when the run ends without one.
   */
  pendingSteers: Record<string, Array<{ id: string; text: string; parts?: import('../types').TurnSteerPart[] }>>;
  /** Queue an optimistic steer bubble for a conversation (id from the 202). */
  addPendingSteer: (conversationId: string, id: string, text: string) => void;
  /** DSH-style: optimistic bubble with the steer's full content parts. */
  addPendingSteerParts: (conversationId: string, id: string, parts: import('../types').TurnSteerPart[]) => void;
  /** Remove the matching optimistic bubble (echo landed or run ended). */
  removePendingSteer: (conversationId: string, id: string) => void;
  /** Clear ALL pending steers for a conversation (run finished/failed). */
  clearPendingSteers: (conversationId: string) => void;
  /**
   * Conversation ids whose last AGENT run was interrupted (the process died
   * mid-run). The job journal marked the record `crashed` at boot; the thread
   * header shows a banner with a Resume action (see docs/ARCHITECTURE.md).
   * Cleared when the user resumes or dismisses.
   */
  crashedRuns: Record<string, { runId: string; callCount: number }>;
  /**
   * Settings edited before any thread exists. They seed the next conversation
   * so the Configuration panel is never inert on a fresh install.
   */
  pendingSettings: ChatSettings;

  /**
   * VISUAL v2 LIVE BUS — the newest addon-bus SSE frame (/api/addons/events).
   * VisualCard reads this to re-bind cards whose id was touched by an
   * edit-in-place render or a frontend-preview pick from ANOTHER browser.
   * Single-slot (last event wins) — the card compares the payload's visualId.
   */
  addonEvent: import('../types/addonBus').AddonBusPayload | null;
  /** Fused by the boot SSE subscriber — one set() per frame, cheap. */
  pushAddonEvent: (event: import('../types/addonBus').AddonBusPayload) => void;

  /**
   * COMPOSER ROLE — the Grok "Slot" the user is sending from. `user` is the
   * default plain chat. `operator` (Slot 2) appends an operator-context
   * sidecar to the message (the model is told the speaker is the session
   * operator — facts about harness state are not bluffs). `admin` (Slot 3)
   * is a wire label only: sending as admin NEVER mutates the enforcement
   * ladder — the stepper in Configuration owns that, and only the user
   * moves it. This is a per-message selector, not a persisted setting.
   */
  composerRole: 'user' | 'operator' | 'admin';
  /**
   * TREE ATTACH (right-dock design): files picked from the project tree ride
   * this transient queue into the composer's normal attachment pipeline
   * (caps, upload, dataRefs). Never persisted — File handles die with the
   * tab, exactly like the composer's own local attachment state.
   */
  composerQueuedFiles: File[];

  loadProviders: () => Promise<void>;
  /**
   * P3 LAZY METADATA: the 261 KB models.dev snapshot loads on FIRST NEED —
   * the model picker opening, or the first send (context limits/reasoning
   * hints). Single-flight: concurrent first-need callers share one download,
   * and loadProviders no longer bundles it into boot.
   */
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
  /** Optimistic local append (agent__image results) — no server round-trip. */
  pushGalleryUrls: (urls: string[]) => void;
  addToGallery: (urls: string[]) => Promise<void>;
  removeFromGallery: (url: string) => Promise<void>;
  moveGalleryImage: (url: string, direction: -1 | 1) => Promise<void>;
  /** Gallery drag & drop: move the image at `from` to index `to` (design drop-handler). */
  reorderGalleryImages: (from: number, to: number) => Promise<void>;

  loadImageSessions: () => Promise<void>;
  createImageSession: (label?: string) => Promise<string>;
  selectImageSession: (id: string | null) => void;
  deleteImageSession: (id: string) => Promise<void>;
  /** Inline rename (sidebar context menu); optimistically relabels locally. */
  renameImageSession: (id: string, label: string) => Promise<void>;
  /** Records finished generations into a session (defaults to the active one). */
  addItemsToSession: (
    items: Array<Omit<ImageSessionItem, 'savedAt'>>,
    targetSessionId?: string,
  ) => Promise<void>;
  loadImageSettings: () => Promise<void>;
  setImageRetentionDays: (days: number) => Promise<void>;
  loadAgentWorkspaces: (sessionId?: string) => Promise<void>;
  /** Registers a directory and makes it the active workspace. */
  addAgentWorkspace: (path: string, label?: string, sessionId?: string) => Promise<AgentWorkspaceInfo>;
  removeAgentWorkspace: (id: string) => Promise<void>;
  /** Activates a workspace for the given session (the active chat's id). */
  setActiveAgentWorkspace: (id: string, sessionId?: string) => Promise<void>;

  /** The panel's data — one workspace at a time (the session-bound one). */
  treeView: TreeViewInfo | null;
  treeRules: TreeIgnoreRules | null;
  /** Panel chrome: open/collapsed-pill/closed + device-persisted geometry. */
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
    /** Binds the new chat to this workspace immediately (the '+' picker). */
    workspaceId?: string;
    /** COUNCIL: stamp the new chat as a council container or a sub session of one. */
    councilId?: string;
    councilRole?: 'main' | 'sub';
    councilAgentId?: string;
  }) => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  /** Internal: performs the actual deletion (deleteConversation may gate on confirmDel). */
  executeDeleteConversation: (id: string) => void;
  confirmPendingDelete: () => void;
  cancelPendingDelete: () => void;
  renameConversation: (id: string, title: string) => void;
  /** Stores (or clears) the conversation's compaction summary. */
  setCompaction: (id: string, compaction: ConversationCompaction | undefined) => void;
  /** Removes one turn; a user turn takes its assistant reply with it. */
  deleteTurn: (conversationId: string, turnId: string) => void;
  /**
   * Drops a set of turns by id with the FULL deletion discipline (tombstones,
   * rev bump, sync-baseline reset). deleteTurn is the single-turn convenience
   * wrapper over this; multi-turn removals (regenerate's trim, ghost
   * cleanups) must go through here too — a turn removal without the rev bump
   * loses the server merge and RESURRECTS the dropped turns.
   */
  dropTurns: (conversationId: string, turnIds: string[]) => void;
  /**
   * Creates a new conversation duplicating the source thread's turns up to
   * and including `turnId`, then selects it. A trailing error-only assistant
   * turn is dropped — it carries nothing worth keeping in the branch.
   */
  branchFromTurn: (conversationId: string, turnId: string) => void;
  clearAllConversations: () => void;
  replaceConversations: (conversations: Conversation[]) => void;  /**
   * Load one conversation's BODY from the device.
   *
   * The list arrives as summary shells (see `Conversation.turnsLoaded`), so
   * anything that needs real turns — rendering the thread, sending, the context
   * meter — calls this first. A no-op when the body is already loaded, and
   * de-duplicated while a load is in flight, so callers can be liberal about
   * calling it.
   */
  hydrateConversation: (id: string) => Promise<void>;
  /**
   * LIVE-FOLLOW: adopt a freshly fetched body for a conversation whose run is
   * driven by ANOTHER tab (or whose stream this tab stopped consuming). The
   * gate is keepLocalFullBody — identical-or-newer — so a body this tab
   * legitimately edited in the meantime is never clobbered by an in-flight
   * response, and a run this tab already streamed (attached) is never
   * replaced mid-paint. No-op when the conversation vanished.
   */
  adoptFetchedBody: (fetched: Conversation) => void;

  appendTurn: (conversationId: string, turn: Turn) => void;
  /** HARNESS-EVENT: insert/replace a kind:'harness-event' turn by id (dedupe
   *  for bus replays; never retitles the conversation). */
  upsertHarnessEvent: (conversationId: string, turn: Turn) => void;
  updateTurn: (conversationId: string, turnId: string, patch: Partial<Turn>) => void;
  /**
   * THE USER'S OWN PRUNER — the only thing that ever removes reasoning.
   *
   * The harness no longer drops reasoning on its own: not between tool rounds,
   * not when a new user message arrives, not inside the compaction transcript
   * (see compaction.ts). Reasoning therefore ACCUMULATES, and this action is
   * the deliberate counterweight: an explicit act the user takes when the
   * context is getting heavy, instead of an automatic trim nobody asked for.
   *
   * Strips both the legacy `reasoning` field and every reasoning segment across
   * the whole conversation in ONE write. Returns how many turns carried
   * reasoning (0 = nothing to trim).
   */
  trimReasoning: (conversationId: string) => number;
  /** Shallow patch of a conversation (harness context, goals, …). */
  patchConversation: (conversationId: string, patch: Partial<Conversation>) => void;
  /** Replaces the goal list of one conversation (goals_state pushes / panel). */
  setConversationGoals: (conversationId: string, goals: Goal[]) => void;
  /** Replaces the standalone todo list of one conversation (todos_state pushes / panel). */
  setConversationTodos: (conversationId: string, todos: Todo[]) => void;
  /**
   * Patch settings. Without `conversationId` the ACTIVE conversation is
   * targeted; callers that know which session they are editing (the
   * enforcement ladder) pass the id explicitly so a change can never land
   * on a different chat. Enforcement/probation are NEVER staged into
   * `pendingSettings` — a new chat must start clean.
   */
  updateSettings: (patch: Partial<ChatSettings>, conversationId?: string) => void;

  setView: (view: ViewId) => void;
  toggleSidebar: () => void;
  /** Drag-resize setters — clamped in the drag handler, persisted on release. */
  setSidebarWidth: (width: number) => void;
  setSettingsWidth: (width: number) => void;
  /** Persists the current widths to the device (on drag release). */
  commitSidebarWidth: () => void;
  commitSettingsWidth: () => void;
  commitDiffDockWidth: () => void;
  toggleSettings: () => void;
  setRightPanelMode: (mode: 'config' | 'tree' | 'addons' | 'diff') => void;
  /**
   * IMAGE STUDIO: one-shot request that the Configuration dock opens its
   * image-model picker (set by the composer's "switch to edit model" chip;
   * SettingsPanel consumes it and renders the picker modal).
   */
  imagePickerWanted: boolean;
  requestImagePicker: () => void;
  consumeImagePickerRequest: () => void;
  /** Prompt pre-fill for the /image slash command — ImageStudio consumes it on
   *  mount, so the draft survives the view switch without a new store slice. */
  imageStudioPromptWanted: string | null;
  requestImageStudioPrompt: (prompt: string) => void;
  consumeImageStudioPromptRequest: () => void;
  /** Opens the Diff Panel on the given turn (tab + dock + scope in one call). */
  openDiffPanel: (turnId: string | null) => void;
  setDiffPanelTurnId: (turnId: string | null) => void;
  setDiffDockWidth: (width: number) => void;
  setTheme: (theme: ThemeMode, ev?: { clientX: number; clientY: number }) => void;
  setAccent: (accent: Accent) => void;
  setDensity: (density: Density) => void;
  setAmbient: (ambient: boolean) => void;
  /** null = follow prefers-reduced-motion. */
  setReduceMotion: (reduceMotion: boolean | null) => void;
  /** Panel-settings: confirm-before-delete toggle. */
  setConfirmDel: (confirmDel: boolean) => void;
  setFontScale: (scale: number) => void;
  setContextScale: (scale: number) => void;
  setFontFamily: (family: FontFamily) => void;
  setSearchQuery: (query: string) => void;
  setComposerRole: (role: 'user' | 'operator' | 'admin') => void;
  queueComposerFiles: (files: File[]) => void;
  clearComposerQueuedFiles: () => void;
  /** THE ONLY door to the Notice Center. `id` must be a registered catalog
   *  key — a raw string is a type error (Fase A #4.2 enforcement). */
  showNotice: (
    id: MessageId,
    params?: Record<string, string | number>,
    opts?: { detail?: string; tone?: MessageTone },
  ) => void;
  dismissNotice: (key: string) => void;
  toggleNoticeHistory: () => void;
  clearNoticeHistory: () => void;
  setGenRunning: (id: string, running: boolean) => void;
  /** Response timer: run start epoch per conversation (the live clock reads
   *  Date.now() - genStartedAt[id]; no per-second state writes). */
  genStartedAt: Record<string, number>;
  /** Marks the start/end of a compaction — see `compactingId`. */
  setCompacting: (id: string | null) => void;
  /**
   * Records (or clears) an interrupted agent run for a conversation — the
   * thread header shows a Resume banner while one is set.
   */
  setCrashedRun: (
    id: string,
    run: { runId: string; callCount: number } | null,
  ) => void;

  activeConversation: () => Conversation | undefined;
  activeProvider: () => ProviderPublic | undefined;
  activeAgentWorkspace: () => AgentWorkspaceInfo | undefined;
}

/**
 * ONE-TIME HEAL for records written by the frozen-progress bug: a tool segment
 * whose summary is a live progress line ("Waiting for the provider… Ns …") and
 * which never received its real tool_result. Clearing the fake summary lets
 * the card render as still-running instead of a frozen terminal state, and the
 * next detail fetch (or an agent retry) can finally pair the real result.
 */
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

/**
 * THE DUPLICATE-TURN GUARD — the reported "sampah/bekas turn" bug.
 *
 * A replay racing a body-adopt once appended the SAME run's turn twice (two
 * paint passes under different turns arrays), and a duplicate id in a
 * rendered list is React poison: the keyed diff mis-pairs children and the
 * commit LEAVES STALE DOM ROWS BEHIND ("children may be duplicated and/or
 * omitted") — the ghost turns that survived even a reload of the store.
 * Every door a turn can enter through runs through here: the LAST occurrence
 * wins (patches/upserts carry the newest paint), order is preserved.
 */
function dedupeTurns(turns: Turn[]): Turn[] {
  turns = healFrozenImageSegments(turns);
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

/**
 * A conversation that exists only in memory: spawned by "New chat" but never
 * used (no turns, default title). Phantoms are excluded from persistence and
 * from every list, so pressing New Chat repeatedly never piles up entries.
 */
export function isPhantomConversation(conversation: Conversation): boolean {
  return conversation.turns.length === 0 && conversation.title === 'New chat';
}

/**
 * COUNCIL (Council Agent addon): a sub session lives INSIDE a council container.
 * It is a real conversation (own turns/context) but must never appear as its own
 * row in the sidebar, the workspace groups or the history — the council's Main
 * Session is the single visible row, and switching between members happens
 * through the TopBar council switcher.
 */
export function isSubSession(conversation: Conversation): boolean {
  return conversation.councilRole === 'sub' && Boolean(conversation.councilId);
}

/**
 * The NEWEST conversation id (by updatedAt, tie-break createdAt) — the
 * sidebar's own sort order. Used as the FALLBACK selection when the current
 * one vanished: the merged list is in server manifest order (oldest first),
 * so "head of list" meant "the oldest chat", which is how a New-Chat
 * phantom (not persisted — see isPhantomConversation) that was dropped by a
 * sync fold threw the user into the oldest session.
 */
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
  pendingConversations = conversations.filter((entry) => !isPhantomConversation(entry));
  queueServerSync(pendingConversations);
}

let pendingConversations: Conversation[] | null = null;

function flushPersist(): void {
  if (pendingConversations === null) return;
  const snapshot = pendingConversations;
  pendingConversations = null;
  queueServerSync(snapshot);
}

/**
 * Apply a METADATA edit (title, settings, provider/model) to a conversation,
 * loading its body first when it is still a summary shell.
 *
 * A shell is deliberately never pushed by the sync — an upsert carrying
 * `turns: []` reads to the merge as "every turn was deleted" and WINS, which
 * would wipe the record on the device. So an edit applied to a shell would be
 * applied to a record that can never be sent: the sidebar shows the new title,
 * the device keeps the old one, and the rename silently vanishes on the next
 * load. Loading the body first is what makes the edit real.
 */
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


/** id → JSON of the last state acknowledged as on the server (diff base). */
const syncedJson = new Map<string, string>();

/**
 * SETTINGS-DURING-RUN persistence: a conversation that is LIVE (generating)
 * syncs incrementally — turn patches only — so a settings change made MID-RUN
 * (lower context limit, compact threshold) never reached the server and was
 * silently reset to defaults on the next reload. updateSettings flags the
 * conversation here; the next sync batch then ships the FULL record once,
 * and the flag clears when the server acknowledges it.
 */
const settingsDirtyIds = new Set<string>();
let syncTimer: number | null = null;
let syncInFlight: Promise<void> = Promise.resolve();
let syncDirty = false;
/** True once boot reconcile finished (queues before it are no-ops). */
let syncReady = false;
let lastSyncSnapshot: Conversation[] | null = null;

/**
 * CONVERSATIONS THE USER EXPLICITLY DELETED, waiting to be acknowledged.
 *
 * This is the ONLY source of `removeIds`. The old rule was "anything the server
 * holds that I do not hold is a deletion", which turned a boot whose body
 * fetches failed into a server-side wipe: `serverKnownIds` was filled from the
 * summaries BEFORE the bodies were confirmed, `assembleMerged` dropped whatever
 * failed to load, and the next batch told the server to delete exactly those.
 * That is how an archive can shrink from ~123 chats to 2 with no error anywhere
 * (the manifest's `nextSeq` only ever climbs — it read 124 while 2 folders were
 * left on disk, with no backup to restore from).
 *
 * "I do not have it" is not evidence that it should not exist: that is the
 * normal state of a second browser, of a reload that raced the proxy, and of a
 * chat created elsewhere. Only the user's own delete lands here.
 */
const pendingDeletions = new Set<string>();

/**
 * TOMBSTONES for deleted turns. A running stream paints through a throttled
 * updateTurn (~50 ms) and a finalizer flush fires on abort — when the user
 * deletes a message MID-STREAM, one of those late writes used to land after
 * the deletion and resurrect the dead turn in place. deleteTurn now records
 * the deleted turn ids here; updateTurn refuses to write to a tombstoned id
 * (appendTurn-style resurrections are covered because the fold + rev guard
 * keep the deleted copy out of the shared store). TTL keeps the map bounded —
 * a write arriving later than this is a genuinely new turn with a recycled
 * id (uid() collision is impossible in practice, not worth guarding).
 */
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

/** Slightly wider than the local write: streaming needs no chat-server POST per token. */
const SYNC_DEBOUNCE_MS = 1500;
/** P3: the live-patch channel's STEADY-STATE cadence cap. */
const SYNC_STEADY_CAP_MS = 5_000;
/**
 * P3 SYNC CADENCE — consecutive cycles that carried a batch stretch the next
 * debounce (1.5s → 2.2s → 3.4s → 5s cap, ±20% jitter). A long streaming run
 * used to sync at a flat 1.5s forever (the audit's ~19× sync in 44s); the
 * patches still keep the server's record current for other tabs, just at an
 * honest pace. An idle cycle (nothing to send) resets the ladder so the user's
 * next action is snappy again.
 */
let syncCycleStreak = 0;

function nextSyncDelayMs(): number {
  const expo = Math.min(SYNC_STEADY_CAP_MS, SYNC_DEBOUNCE_MS * 1.5 ** Math.min(syncCycleStreak, 4));
  return Math.round(expo * (0.8 + Math.random() * 0.4));
}

/**
 * Conversations THIS tab is actively streaming into. Their full-record upsert
 * is pure bandwidth; their trailing turn reaches the server as an INCREMENTAL
 * PATCH instead (see computeSyncBatch), and their local copy must survive the
 * post-sync fold (see foldServerSummaries).
 */
function generatingConversationIds(): Set<string> {
  return new Set(Object.keys(useStore.getState().genRunning));
}

/**
 * Conversations the server has a RECORD for — the authoritative existence
 * set, refreshed from every sync response and at boot. A LIVE chat the
 * server has never seen is upserted IN FULL once (the patches then have a
 * record to land in); afterwards only its turns ride the wire.
 */
const serverKnownIds = new Set<string>();

/**
 * Per-conversation turn count the server's record last acknowledged. The
 * live-sync baseline: a generating chat patches every turn from this index
 * onward (the trailing turn always included — streaming MUTATES it in
 * place, so its patch rides every cycle).
 */
const syncedTurnCount = new Map<string, number>();

/**
 * P4 BOOT FOLD: yields to the main thread between boot phases, so the boot
 * reconcile (legacy migration → list walk → body fetches → merge) never
 * stacks into one unbroken long task. scheduler.yield() when the platform
 * provides it, a macrotask break otherwise — both let the browser paint and
 * process input between chunks instead of locking up for the whole boot.
 */
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

/**
 * Diff the snapshot against the acknowledged state; null when in sync.
 *
 * LIVE (generating) chats sync INCREMENTALLY: the server already holds the
 * record, so only the turns it has not acknowledged are pushed — the
 * trailing turn every cycle, since streaming mutates it in place. This keeps
 * the server's record CURRENT during a run (a reload anywhere, or a second
 * browser, reads the live partial straight from the store) without the
 * multi-megabyte full-record upload on every debounce that the old stream
 * SUPPRESSION avoided by simply skipping those chats and leaving the server
 * arbitrarily behind.
 */
/**
 * TURN DELETIONS waiting to reach the server. dropTurns records the dropped
 * ids here; computeSyncBatch ships them as `turn: null` patches — INCLUDING
 * while the conversation is generating (the turn-patch-only sync path that
 * made a mid-run regenerate leave the old turn on the server, so a second
 * browser saw two assistant replies). Cleared once a sync acknowledges them.
 */
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
  /** The turn deletions this batch carries — clear them on ack. */
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

/**
 * Fingerprint equality: the local record is KNOWN-identical to the server's
 * (monotonic rev + timestamp + turn count). Streaming grows a turn without
 * touching rev/updatedAt, which is why the count is part of the fingerprint —
 * it is the one signal that distinguishes a mid-stream local copy from the
 * last-accepted server record.
 */
function localMatchesSummary(local: Conversation, summary: ConversationSummary): boolean {
  if ((local.rev ?? null) !== (summary.rev ?? null)) return false;
  if (local.updatedAt !== summary.updatedAt) return false;
  return local.turns.length === summary.turnCount;
}

/**
 * The local record is strictly NEWER than the server's. THE GATE IS THE
 * SERVER'S OWN MERGE ORDER, not a rev-first shortcut: timestamps decide
 * first, rev only breaks a tie — because rev is a per-client monotonic
 * counter: tab A's rev 500 (every streamed token bumps it, see updateTurn)
 * and tab B's rev 11 (one rename) are unrelated counters. Comparing them
 * cross-tab let the streaming tab's STALE title win over another tab's
 * explicit rename forever (the reported "sesi dinamai acak" bug). A rename
 * now bumps updatedAt, so the timestamp gate reads it as strictly newer and
 * every fold pulls it in.
 */
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

/**
 * Keep the local body when it is known-identical to the server's record or
 * strictly newer than it. Only a genuinely stale local copy (or a record this
 * browser never held) makes the body cross the wire.
 */
function keepLocalBody(local: Conversation, summary: ConversationSummary): boolean {
  return localMatchesSummary(local, summary) || localIsNewer(local, summary);
}

/**
 * Identical-or-newer decision for the LIVE-FOLLOW path: a follow fetches a
 * FULL body (not a summary), so the comparison runs record-to-record with the
 * same gate the fold uses — timestamps first, rev at ties, turn count last.
 * The server's turn mirror and patch channel keep the device record current,
 * so a body the fetch brings back is the server's truth for a run this tab is
 * not consuming; the local copy only survives when it is the same state (or
 * a strictly newer edit this tab made in the meantime).
 */
function keepLocalFullBody(local: Conversation, fetched: Conversation): boolean {
  if (local.updatedAt > fetched.updatedAt) return true;
  if (local.updatedAt < fetched.updatedAt) return false;
  const localRev = local.rev ?? null;
  const fetchedRev = fetched.rev ?? null;
  if (localRev !== null && fetchedRev !== null && localRev !== fetchedRev) return localRev > fetchedRev;
  if (local.turns.length !== fetched.turns.length) return local.turns.length > fetched.turns.length;
  return JSON.stringify(local) === JSON.stringify(fetched);
}

/**
 * Assemble the merged list in the server's order, then the local-only rows.
 * The store's conversations array keeps its full-body shape — the views and
 * the wire builder are untouched.
 */
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

/**
 * Fold the server's post-merge SUMMARY list into the live store. A chat this
 * tab edited after the batch it just pushed keeps its LOCAL body (it resyncs
 * on the next persist); a record the server holds NEWER than the local copy
 * is fetched in full — only that one body crosses the wire, never the whole
 * list. A LIVE chat no longer needs a special case: the server's record is
 * kept current by the turn patches, and the local copy of the streaming tab
 * is still ahead on `rev`, so `keepLocalBody` keeps it without a fetch.
 */
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
      resolved.set(summary.id, {
        ...localEntry,
        title: summary.title,
        updatedAt: summary.updatedAt,
        rev: summary.rev,
        providerId: summary.providerId ?? localEntry.providerId,
        model: summary.model ?? localEntry.model,
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
      resolved.set(summary.id, localEntry);
      if (!editedAfterSend && !live.has(summary.id) && localMatchesSummary(localEntry, summary)) {
        syncedJson.set(summary.id, JSON.stringify(localEntry));
      }
      continue;
    }
    toFetch.push(summary.id);
  }
  if (toFetch.length > 0) {
    const fetched = await Promise.all(toFetch.map((id) => fetchConversationDetail(id)));
    for (const convo of fetched) {
      if (!convo) continue;
      const clean = { ...convo, turns: dedupeTurns(convo.turns) };
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

/**
 * A list row for a chat whose body has not been downloaded.
 *
 * Enough for the sidebar, History, search and the sync bookkeeping — and not
 * enough to send or render, which is what `turnsLoaded: false` says. Settings
 * are the staged defaults: they are never sent from a shell (the sync skips
 * it) and hydration replaces them with the record's own.
 */
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
    settings: {
      ...DEFAULT_SETTINGS,
      enforcement: { ...DEFAULT_SETTINGS.enforcement },
      probation: { ...DEFAULT_SETTINGS.probation },
    },
    turns: [],
    turnsLoaded: false,
  };
}

/** In-flight body loads, so two callers never fetch the same chat twice. */
const hydrating = new Map<string, Promise<void>>();

/**
 * Boot reconcile, started once from App via `bootConversationSync`.
 *
 * THE DEVICE IS THE STORE, so this is the whole list — and it is deliberately
 * CHEAP: the server's summaries become the rows, and bodies are fetched only
 * for the chats this tab needs NOW (the ones it is streaming into, and the one
 * the user had open). Everything else stays a shell until it is opened.
 *
 * That is not an optimisation, it is the only workable shape: two chats here
 * already weigh 2.3 MB, and the archive once held ~123 — a boot that fetched
 * every body would move ~150 MB before the first paint.
 */
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
/**
 * Resolves once the boot conversation sync has SETTLED (success, migration,
 * or proxy failure). Anything that must not act on a half-loaded conversation
 * list — like the reload-resume reconcile in useChatController — awaits this.
 */
export const conversationsReady = new Promise<void>((resolve) => {
  markConversationsReady = resolve;
});

let markProvidersReady: () => void = () => undefined;
/** Resolves when the boot provider list settles — see loadProviders. */
export const providersReady = new Promise<void>((resolve) => {
  markProvidersReady = resolve;
});

/** The in-flight boot load — second callers await it instead of re-fetching. */
let providersLoadInFlight: Promise<void> | null = null;
/** The in-flight lazy metadata download — shared by every first-need caller. */
let modelMetaInFlight: Promise<void> | null = null;
/** P3 TREE SINGLE-OWNER: the in-flight tree load + its freshness stamp. */
let treeLoadInFlight: { workspaceId: string; promise: Promise<void> } | null = null;
let treeLoadedAt = 0;
/** Minimum gap between tree fetches for the same workspace (single owner). */
const TREE_LOAD_MIN_GAP_MS = 4_000;

/** Kick off the one-time boot sync of the shared conversation store. */
export function bootConversationSync(): Promise<void> {
  return initConversationSync().finally(() => markConversationsReady());
}

/** Re-pulls the shared list — after a trash RESTORE the server holds a chat
 *  this browser has never seen. New ids merge as summary shells (hydration
 *  fetches the body on demand); rows this browser already has are untouched. */
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
/** Bumped to invalidate any running poll loop (Stop, or a newer generation). */
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

  view: storage.loadView(),
  sidebarCollapsed: storage.loadSidebarCollapsed(),
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
  stoppedRuns: {},
  pendingSteers: {},
  crashedRuns: {},
  pendingSettings: {
    ...DEFAULT_SETTINGS,
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

        set({ providers, providerId, model, providersLoading: false, modelMeta: {} });
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
      withLoadedBody(conversation.id, () => {
        const next = get().conversations.map((entry) =>
          entry.id === conversation.id
            ? { ...entry, providerId, model: nextModel }
            : entry,
        );
        set({ conversations: next });
        persist(next);
      });
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

  /** Optimistic local append — the browser that generated sees the new image
   *  instantly, without waiting for the SSE bus round-trip. */
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

    /** Deep-clones the path to `relPath`'s parent, applying `mutate`. */
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

  resolvePermissionRequest: async (id, approve, remember) => {
    const { decideAgentPermission } = await import('../lib/api');
    try {
      await decideAgentPermission(id, approve, remember);
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

  setModel: (model) => {
    set({ model });
    storage.saveModel(model);
    const conversation = get().activeConversation();
    if (conversation) {
      withLoadedBody(conversation.id, () => {
        const next = get().conversations.map((entry) =>
          entry.id === conversation.id ? { ...entry, model } : entry,
        );
        set({ conversations: next });
        persist(next);
      });
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
    pendingDeletions.add(id);
    const deleted = get().conversations.find((conversation) => conversation.id === id);
    const councilId = deleted?.councilId;
    const councilSubs = (councilId && deleted?.councilRole === 'main')
      ? get().conversations.filter(
          (conversation) => conversation.councilId === councilId && conversation.councilRole === 'sub',
        )
      : [];
    const dropped = councilSubs.map((conversation) => conversation.id);
    for (const subId of dropped) pendingDeletions.add(subId);
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
    set({ conversations: next });
    persist(next);
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
    set({ conversations, activeId });
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
      const full = { ...fullRaw, turns: dedupeTurns(fullRaw.turns) };
      const next = get().conversations.map((conversation) =>
        conversation.id === id ? full : conversation,
      );
      set({ conversations: next });
      syncedJson.set(id, JSON.stringify(full));
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
    const fetched = { ...fetchedRaw, turns: dedupeTurns(fetchedRaw.turns) };
    const current = get().conversations.find((conversation) => conversation.id === fetched.id);
    if (!current) return;
    if (keepLocalFullBody(current, fetched)) return;
    const next = get().conversations.map((conversation) =>
      conversation.id === fetched.id ? fetched : conversation,
    );
    set({ conversations: next });
    syncedJson.set(fetched.id, JSON.stringify(fetched));
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
    const next = get().conversations.map((entry) =>
      entry.id === conversationId ? { ...entry, rev: (entry.rev ?? 0) + 1, turns } : entry,
    );
    set({ conversations: next });
    persist(next);
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

    if (!conversation) {
      set({ pendingSettings: { ...get().pendingSettings, ...staged } });
      return;
    }

    if (conversation.turnsLoaded === false) {
      void useStore.getState().hydrateConversation(conversation.id).then(() => {
        useStore.getState().updateSettings(patch, conversation.id);
      });
      return;
    }

    const next = get().conversations.map((entry) =>
      entry.id === conversation.id
        ? { ...entry, settings: { ...entry.settings, ...patch }, rev: (entry.rev ?? 0) + 1 }
        : entry,
    );
    settingsDirtyIds.add(conversation.id);
    set({
      conversations: next,
      pendingSettings: { ...get().pendingSettings, ...staged },
    });
    persist(next);

    if ('webAccess' in patch) {
      void setWebAccessRemote(patch.webAccess === true);
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
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setSettingsWidth: (width) => set({ settingsWidth: width }),
  /** Drag-release persistence: the store set is cheap per-move; the DEVICE
   *  write happens once, here. */
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
              .map((part) => (part.type === 'text' ? part.text : part.type === 'image_url' ? '[image attached]' : `[file attached: ${part.file.filename}]`))
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

/**
 * Settings for the composer.
 *
 * Falls back to the staged defaults when no conversation exists yet, so the
 * right-hand panel is never empty on a fresh install.
 */
export function useEffectiveSettings(): ChatSettings {
  const conversation = useStore((state) => state.conversations.find((c) => c.id === state.activeId));
  const pending = useStore((state) => state.pendingSettings);
  return conversation?.settings ?? pending;
}
