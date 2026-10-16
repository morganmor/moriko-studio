import type {
  AgentPermissionRequest,
  AskAnswer,
  AskUserRequest,
  AgentWorkspaceInfo,
  ChatMessage,
  ChatSettings,
  Conversation,
  ConversationSummary,
  Goal,
  ImageSession,
  ImageSessionItem,
  ImageSettings,
  ProviderKind,
  ProviderPublic,
  Reminder,
  StreamEvent,
  Todo,
  TreeDelta,
  TreeIgnoreRules,
  TreeViewInfo,
  TurnInjection,
  TurnPatch,
} from '../types';

/**
 * Mirrors the server's `coerceText` — the client-side last ditch. A text or
 * reasoning frame carrying anything but a string is re-shaped here before it
 * can stamp "[object Object]" into the UI transcript or the device archive.
 */
export function coerceDelta(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const part of value) {
      const nested = coerceDelta(part);
      if (nested) parts.push(nested);
    }
    return parts.length > 0 ? parts.join('') : null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fromText = coerceDelta(record.text);
    if (fromText) return fromText;
    const fromContent = coerceDelta(record.content);
    if (fromContent) return fromContent;
  }
  return null;
}


/** One directory registered for the agent harness (server-persisted). */
export type { AgentWorkspaceInfo };

/** Sandbox gate: the agent wants to touch paths outside the workspace. */
export type { AgentPermissionRequest };

// Goals / plans / todos (Context Injection)

/** Goals of one conversation session (the agent manages them via tools). */
export type { Goal };

export async function fetchGoals(sessionId: string): Promise<Goal[]> {
  const response = await fetch(`/api/goals?session=${encodeURIComponent(sessionId)}`);
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { goals?: Goal[] };
  return payload.goals ?? [];
}

export async function patchGoal(
  sessionId: string,
  goalId: string,
  patch: {
    title?: string;
    plan?: string;
    status?: Goal['status'];
    todos?: Array<{ id: string; done: boolean }>;
    addSubtask?: { todoId: string; text: string };
    setSubtask?: Array<{ id: string; done: boolean }>;
  },
): Promise<Goal> {
  const response = await fetch(`/api/goals/${encodeURIComponent(goalId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId, ...patch }),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { goal: Goal };
  return payload.goal;
}

/** Scheduled reminders of one conversation session. */
export async function fetchReminders(sessionId: string): Promise<Reminder[]> {
  const response = await fetch(`/api/reminders?session=${encodeURIComponent(sessionId)}`);
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { reminders?: Reminder[] };
  return payload.reminders ?? [];
}

// Standalone todos (not tied to a goal — see server/todos/store.ts)

export async function fetchTodos(sessionId: string): Promise<Todo[]> {
  const response = await fetch(`/api/todos?session=${encodeURIComponent(sessionId)}`);
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { todos?: Todo[] };
  return payload.todos ?? [];
}

export async function createTodoApi(
  sessionId: string,
  input: { text: string; priority?: Todo['priority']; notes?: string },
): Promise<Todo> {
  const response = await fetch('/api/todos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId, ...input }),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { todo: Todo };
  return payload.todo;
}

export async function patchTodoApi(
  sessionId: string,
  todoId: string,
  patch: { text?: string; done?: boolean; priority?: Todo['priority']; notes?: string },
): Promise<Todo> {
  const response = await fetch(`/api/todos/${encodeURIComponent(todoId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId, ...patch }),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { todo: Todo };
  return payload.todo;
}

export async function deleteTodoApi(sessionId: string, todoId: string): Promise<void> {
  const response = await fetch(
    `/api/todos/${encodeURIComponent(todoId)}?session=${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) await parseError(response);
}

export async function cancelReminderApi(sessionId: string, reminderId: string): Promise<void> {
  const response = await fetch(
    `/api/reminders/${encodeURIComponent(reminderId)}?session=${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) await parseError(response);
}


export interface VaultSnapshotMeta {
  id: string;
  originalPath: string;
  storedPath: string;
  /** "edit_file" | "delete" | "pre-restore" | … */
  operation: string;
  size: number;
  createdAt: number;
}

export interface VaultRestoreOutcome {
  target: string;
  entry: VaultSnapshotMeta;
  /** Unified diff of current → restored content (text files only). */
  diff?: string;
  diffstat?: { added: number; removed: number };
  /** Pre-restore snapshot of the overwritten file — makes the restore undoable. */
  previousEntryId?: string;
}

/** File-vault snapshots of one session (optional path-substring filter). */
export async function fetchVaultSnapshots(
  sessionId: string,
  query?: string,
): Promise<VaultSnapshotMeta[]> {
  const params = new URLSearchParams({ session: sessionId });
  if (query) params.set('q', query);
  const response = await fetch(`/api/agent/vault?${params.toString()}`);
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { snapshots?: VaultSnapshotMeta[] };
  return payload.snapshots ?? [];
}

/** Dry-run preview of a restore — READ-ONLY (the vault_restore tool's dryRun). */
export async function previewVaultRestore(
  sessionId: string,
  snapshotId: string,
): Promise<{ ok: boolean; text: string; diff?: string; diffstat?: { added: number; removed: number } }> {
  const response = await fetch('/api/agent/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'agent__vault_restore', args: { snapshotId, dryRun: true }, sessionId }),
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as {
    ok: boolean;
    text: string;
    diff?: string;
    diffstat?: { added: number; removed: number };
  };
}

/** Applies a vault restore (writes the file back; pre-restore snapshot first). */
export async function restoreVaultSnapshot(
  sessionId: string,
  snapshotId: string,
): Promise<VaultRestoreOutcome> {
  const response = await fetch('/api/agent/vault/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId, snapshotId }),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { result: VaultRestoreOutcome };
  return payload.result;
}

/** Deletes a file the AGENT created (no pre-agent state) — a pre-delete
 *  snapshot is taken first, so the marker's restore brings it back. */
export async function removeCreatedFile(
  sessionId: string,
  filePath: string,
): Promise<{ snapshotId?: string; diff?: string; diffstat?: { added: number; removed: number } }> {
  const response = await fetch('/api/agent/vault/remove-created', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId, path: filePath }),
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as {
    snapshotId?: string;
    diff?: string;
    diffstat?: { added: number; removed: number };
  };
}

/** Folders the agent may access OUTSIDE the workspace without prompts. */
export async function fetchAllowlist(): Promise<string[]> {
  const response = await fetch('/api/agent/allowlist');
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { dirs?: string[] };
  return payload.dirs ?? [];
}

export async function allowlistAdd(path: string): Promise<string[]> {
  const response = await fetch('/api/agent/allowlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { dirs?: string[] };
  return payload.dirs ?? [];
}

export async function allowlistRemove(path: string): Promise<string[]> {
  const response = await fetch(`/api/agent/allowlist?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { dirs?: string[] };
  return payload.dirs ?? [];
}

export async function deleteGoalApi(sessionId: string, goalId: string): Promise<void> {
  const response = await fetch(
    `/api/goals/${encodeURIComponent(goalId)}?session=${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) await parseError(response);
}

/** One row of the workspace picker's Explorer-style listing. */
export interface AgentBrowseEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'drive';
  mtimeMs?: number;
  size?: number | null;
}

export interface AgentBrowseResult {
  /** Current directory (null at the roots level). */
  path: string | null;
  /** Parent directory, null when there is none (drive root). */
  parent: string | null;
  /** Folders and files of the current directory (drives at the roots level). */
  entries: AgentBrowseEntry[];
}

export async function fetchAgentWorkspaces(sessionId?: string): Promise<{
  workspaces: AgentWorkspaceInfo[];
  activeId: string | null;
}> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const response = await fetch(`/api/agent/workspaces${query}`);
  if (!response.ok) await parseError(response);
  return (await response.json()) as { workspaces: AgentWorkspaceInfo[]; activeId: string | null };
}


/**
 * The named window target for the browser panel — a CONSTANT so every open
 * site (auto-open, tool-card button, future affordances) shares ONE tab.
 */
const BROWSER_PANEL_TARGET = 'moriko-browser-panel';

/**
 * Server-side source of truth for the panel URL (GET /api/agent/browser/panel-url).
 * The panel path is static today, but the route keeps one place to change it.
 */
export async function getBrowserPanelUrl(sessionId?: string): Promise<string> {
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  const response = await fetch(`/api/agent/browser/panel-url${query}`);
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { panelUrl: string };
  return payload.panelUrl;
}

/**
 * Opens the live browser panel as a near-fullscreen, centered window (the
 * panel is a workspace, not a dialog — the 16:9 stream fills it). Returns
 * the window handle, or null when popup-blocked (the caller falls back to a
 * visible button the user can click).
 */
export function openBrowserPanel(panelUrl: string): Window | null {
  const width = Math.min(1680, Math.floor(window.screen.availWidth * 0.96));
  const height = Math.floor(window.screen.availHeight * 0.94);
  const left = Math.max(0, Math.floor((window.screen.availWidth - width) / 2));
  const top = Math.max(0, Math.floor((window.screen.availHeight - height) / 2));
  return window.open(panelUrl, BROWSER_PANEL_TARGET, `width=${width},height=${height},left=${left},top=${top}`);
}

/** Module-level handle: the named target reuses the tab, this guards refocus churn. */
let panelWindow: Window | null = null;

/**
 * WEB ACCESS KILL-SWITCH — tells the server the toggle's new value. `on: false`
 * broadcasts shutdown to every open panel (each closes its own window) and
 * tears the shared Edge context down. Never throws — a failed call only means
 * the server-side sweep lags one round (the WS gate is the hard backstop).
 */
export async function setWebAccessRemote(on: boolean): Promise<void> {
  try {
    await fetch('/api/agent/browser/web-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    if (on === false && panelWindow && !panelWindow.closed) {
      panelWindow.close();
    }
  } catch {
  }
}

/**
 * Opens the panel once per SPA load: an existing live tab is refocused
 * instead of duplicated, and a blocked/null open leaves the caller's button
 * as the fallback. Never throws — popup blockers are a normal browser state.
 */
export function openBrowserPanelOnce(panelUrl?: string): void {
  const url = panelUrl ?? '/browser-view.html';
  try {
    if (panelWindow && !panelWindow.closed) {
      panelWindow.focus();
      return;
    }
    panelWindow = openBrowserPanel(url);
  } catch {
  }
}



export function fetchTreeSnapshot(workspaceId: string): Promise<TreeViewInfo> {
  const inFlight = treeSnapshotInFlight.get(workspaceId);
  if (inFlight) return inFlight;
  const request = (async () => {
    try {
      const response = await fetch(`/api/agent/tree?workspaceId=${encodeURIComponent(workspaceId)}`);
      if (!response.ok) await parseError(response);
      return (await response.json()) as TreeViewInfo;
    } finally {
      treeSnapshotInFlight.delete(workspaceId);
    }
  })();
  treeSnapshotInFlight.set(workspaceId, request);
  return request;
}

const treeSnapshotInFlight = new Map<string, Promise<TreeViewInfo>>();

export async function refreshWorkspaceTree(workspaceId: string): Promise<TreeViewInfo> {
  const response = await fetch(`/api/agent/tree/${encodeURIComponent(workspaceId)}/refresh`, { method: 'POST' });
  if (!response.ok) await parseError(response);
  return (await response.json()) as TreeViewInfo;
}

export async function fetchTreeRules(workspaceId: string): Promise<TreeIgnoreRules> {
  const response = await fetch(`/api/agent/tree/${encodeURIComponent(workspaceId)}/rules`);
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { rules: TreeIgnoreRules };
  return payload.rules;
}

export async function saveTreeRules(workspaceId: string, rules: TreeIgnoreRules): Promise<TreeIgnoreRules> {
  const response = await fetch(`/api/agent/tree/${encodeURIComponent(workspaceId)}/rules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { rules: TreeIgnoreRules };
  return payload.rules;
}

/**
 * The idle-time tree channel: an SSE generator of tree deltas (+ a periodic
 * hello that carries the current version, so the panel can detect drift and
 * re-fetch the full tree). Callers break the loop via `return` — the browser
 * then closes the socket and the server unsubscribes on `close`.
 */
export async function* streamTreeEvents(workspaceId: string): AsyncGenerator<
  { type: 'tree_hello'; workspaceId: string; version: number } | TreeDelta & { type: 'tree_delta' }
> {
  const response = await fetch(`/api/agent/tree/events?workspaceId=${encodeURIComponent(workspaceId)}`);
  if (!response.ok || !response.body) await parseError(response);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const raw = buffer.slice(0, sep).trim();
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf('\n\n');
        if (!raw.startsWith('data:')) continue;
        try {
          yield JSON.parse(raw.slice(5).trim());
        } catch {
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Registers a directory and (server-side) nothing else; activation is separate. */
export async function addAgentWorkspace(path: string, label?: string): Promise<AgentWorkspaceInfo> {
  const response = await fetch('/api/agent/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, label }),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { workspace: AgentWorkspaceInfo };
  return payload.workspace;
}

/** Removes a workspace from the registry — the disk is never touched. */
export async function deleteAgentWorkspace(id: string): Promise<void> {
  const response = await fetch(`/api/agent/workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!response.ok) await parseError(response);
}

/**
 * Activates a workspace. With `sessionId` the switch is SCOPED to that
 * conversation (per-session binding server-side); without it the selection is
 * global (kept for scripts/debugging only — the UI always passes a session).
 */
export async function setActiveAgentWorkspace(id: string, sessionId?: string): Promise<void> {
  const response = await fetch('/api/agent/workspaces/active', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, sessionId }),
  });
  if (!response.ok) await parseError(response);
}

/** Read-only directory listing that powers the file-explorer picker. */
export async function browseAgentDir(path?: string): Promise<AgentBrowseResult> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const response = await fetch(`/api/agent/browse${query}`);
  if (!response.ok) await parseError(response);
  return (await response.json()) as AgentBrowseResult;
}

/**
 * NATIVE device folder picker (Windows FolderBrowserDialog, driven by the
 * local proxy's PowerShell). Resolves the absolute path, or null when the
 * user cancels / the platform has no native dialog.
 */
export async function pickNativeWorkspace(): Promise<string | null> {
  const response = await fetch('/api/agent/native-pick', { method: 'POST' });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { path?: string | null };
  return payload.path ?? null;
}

/** Currently undecided outside-workspace permission requests (reconnect path). */
export async function fetchPendingAgentPermissions(): Promise<AgentPermissionRequest[]> {
  const response = await fetch('/api/agent/permissions');
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { requests?: AgentPermissionRequest[] };
  return payload.requests ?? [];
}

/** Currently pending agent__ask_user question batches (polling / reconnects). */
export async function fetchPendingAskUser(): Promise<AskUserRequest[]> {
  const response = await fetch('/api/agent/ask-user');
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { requests?: AskUserRequest[] };
  return payload.requests ?? [];
}

/**
 * Delivers the user's answers (or skips) for one agent__ask_user batch — the
 * paused tool call on the server resumes with them.
 */
export async function answerAgentQuestions(
  id: string,
  answers: AskAnswer[],
): Promise<void> {
  const response = await fetch(`/api/agent/ask-user/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  });
  if (!response.ok) await parseError(response);
}

/**
 * C3 keepalive — pushes one pending batch's auto-skip deadline forward while
 * the tab is hidden (the server cannot see browser visibility itself). A
 * settled batch answers { ok: false }; harmless.
 */
export async function extendAgentQuestion(id: string, ms: number): Promise<void> {
  const response = await fetch(`/api/agent/ask-user/${encodeURIComponent(id)}/extend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ms }),
  });
  if (!response.ok) await parseError(response);
}

/**
 * Delivers the user's sandbox decision. `remember` keeps the exact paths
 * approved for this server session (memory only, cleared on restart).
 */
export async function decideAgentPermission(
  id: string,
  approve: boolean,
  remember: boolean,
): Promise<void> {
  const response = await fetch(`/api/agent/permissions/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve, remember }),
  });
  if (!response.ok) await parseError(response);
}


export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Tool names the user switched OFF for this server. */
  disabledTools?: string[];
  createdAt: string;
}

/** One tool of a server, as rendered by the settings tools panel. */
export interface McpServerTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  disabled: boolean;
}

export async function listMcpServers(): Promise<{ servers: McpServerConfig[] }> {
  const response = await fetch('/api/mcp/servers');
  if (!response.ok) await parseError(response);
  return (await response.json()) as { servers: McpServerConfig[] };
}

export async function addMcpServer(input: {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}): Promise<void> {
  const response = await fetch('/api/mcp/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) await parseError(response);
}

export async function updateMcpServer(
  id: string,
  patch: { enabled?: boolean; name?: string; disabledTools?: string[] },
): Promise<void> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) await parseError(response);
}

/** Connects (if needed) and lists one server's tools with disabled flags. */
export async function listServerTools(id: string): Promise<McpServerTool[]> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}/tools`);
  if (!response.ok) await parseError(response);
  const body = (await response.json()) as { tools?: McpServerTool[] };
  return body.tools ?? [];
}

export async function deleteMcpServer(id: string): Promise<void> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) await parseError(response);
}

export async function testMcpServer(
  id: string,
): Promise<{ ok: boolean; toolCount: number; error?: string }> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}/test`, { method: 'POST' });
  if (!response.ok) await parseError(response);
  return (await response.json()) as { ok: boolean; toolCount: number; error?: string };
}

/** Error carrying a user-facing message, so the UI never renders a raw stack. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function parseError(response: Response): Promise<never> {
  let message = `Request failed with HTTP ${response.status}.`;
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) message = payload.error;
  } catch {
  }
  throw new ApiError(message, response.status);
}

export async function fetchProviders(): Promise<ProviderPublic[]> {
  const response = await fetch('/api/providers');
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { providers: ProviderPublic[] };
  return payload.providers;
}


/**
 * Asks the server whether a stream is still resumable.
 *
 * `live: true` — the run is still going (or its finished buffer is still
 * retained): re-attach with resumeChat() and the replay rebuilds from frame
 * one. `live: false` — the server knows the id but can no longer replay it.
 * A NETWORK failure THROWS (fetch rejects): a dead proxy must never be
 * mistaken for a dead stream — the caller's catch classifies it as a
 * connection loss and the reconnect path owns it from there.
 */
export async function probeResume(streamId: string): Promise<{ ok: boolean; live: boolean }> {
  const response = await fetch(`/api/chat/resume/${encodeURIComponent(streamId)}`, {
    method: 'HEAD',
  });
  if (response.status === 200) return { ok: true, live: true };
  if (response.status === 204) return { ok: true, live: false };
  return { ok: false, live: false };
}

/**
 * Re-attaches to a resumable stream as an SSE read. Yields the buffered
 * events the client missed during the gap, then continues live. Throws when
 * the id is unknown/gone — the caller falls back to a plain Continue.
 */
export async function* resumeChat(streamId: string): AsyncGenerator<StreamEvent> {
  const response = await fetch(`/api/chat/resume/${encodeURIComponent(streamId)}`);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(payload?.error ?? 'The stream is no longer resumable.', response.status);
  }
  if (!response.body) throw new ApiError('The proxy returned an empty resume stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            yield JSON.parse(payload) as StreamEvent;
          } catch {
          }
        }

        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}


/** One run as the proxy's journal holds it. */
export interface JobRunSummary {
  id: string;
  sessionId: string | undefined;
  providerId: string;
  model: string;
  agentMode: boolean;
  status: 'running' | 'completed' | 'errored' | 'aborted' | 'crashed';
  startedAt: number;
  endedAt: number | null;
  callCount: number;
}

/**
 * Reads ONE durable run record. Used at boot to learn whether a run the
 * client remembers reached a terminal state or died mid-flight (`crashed`).
 * Unknown/absent (expired record, one-shot caller) resolves to null — the
 * caller treats that as "nothing to surface".
 */
export async function fetchJobRun(runId: string): Promise<JobRunSummary | null> {
  try {
    const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}`);
    if (!response.ok) return null;
    const payload = (await response.json()) as { run?: unknown };
    const run = payload.run as Partial<JobRunSummary> | undefined;
    if (!run || typeof run.id !== 'string' || typeof run.status !== 'string') return null;
    return {
      id: run.id,
      sessionId: run.sessionId,
      providerId: run.providerId ?? '',
      model: run.model ?? '',
      agentMode: run.agentMode === true,
      status: run.status as JobRunSummary['status'],
      startedAt: typeof run.startedAt === 'number' ? run.startedAt : 0,
      endedAt: typeof run.endedAt === 'number' ? run.endedAt : null,
      callCount: typeof run.callCount === 'number' ? run.callCount : 0,
    };
  } catch {
    return null;
  }
}

export interface VisionConfig {
  providerId: string;
  model: string;
  baseUrl?: string;
}

export async function fetchVisionConfig(): Promise<VisionConfig> {
  try {
    const response = await fetch('/api/vision/config');
    if (!response.ok) return { providerId: '', model: '' };
    const payload = (await response.json()) as Partial<VisionConfig>;
    return {
      providerId: typeof payload.providerId === 'string' ? payload.providerId : '',
      model: typeof payload.model === 'string' ? payload.model : '',
      baseUrl: typeof payload.baseUrl === 'string' && payload.baseUrl.trim() ? payload.baseUrl : undefined,
    };
  } catch {
    return { providerId: '', model: '' };
  }
}

export async function saveVisionConfig(config: VisionConfig): Promise<void> {
  const response = await fetch('/api/vision/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) await parseError(response);
}

/** Per-model capability metadata (models.dev snapshot served by the proxy). */
export async function fetchModelMetadata(): Promise<Record<string, unknown>> {
  if (!modelMetadataInFlight) {
    modelMetadataInFlight = (async () => {
      try {
        const response = await fetch('/api/model-metadata');
        if (!response.ok) return {};
        return (await response.json()) as Record<string, unknown>;
      } finally {
        modelMetadataInFlight = null;
      }
    })();
  }
  return modelMetadataInFlight;
}

let modelMetadataInFlight: Promise<Record<string, unknown>> | null = null;

export async function createProvider(input: {
  id?: string;
  label: string;
  kind: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  imageAdapter?: string;
  imageConfig?: Record<string, unknown>;
}): Promise<ProviderPublic> {
  const response = await fetch('/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { provider: ProviderPublic };
  return payload.provider;
}

export async function deleteProvider(id: string): Promise<void> {
  const response = await fetch(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 204) await parseError(response);
}

/**
 * Updates a BUILT-IN provider's user-managed slots: the API key (saved with
 * a string, cleared with an empty string) and/or its added model ids.
 * The definition itself is fixed server-side.
 */
export async function updateBuiltInProvider(
  providerId: string,
  patch: { apiKey?: string; addModels?: string[]; removeModels?: string[]; setModels?: string[] },
): Promise<{ hasServerKey: boolean; userSuppliedKey: boolean; models: string[] }> {
  const response = await fetch(
    `/api/providers/builtins/${encodeURIComponent(providerId)}/key`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
  if (!response.ok) await parseError(response);
  return (await response.json()) as {
    hasServerKey: boolean;
    userSuppliedKey: boolean;
    models: string[];
  };
}

export async function fetchRemoteModels(providerId: string, apiKey?: string): Promise<string[]> {
  const query = apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : '';
  const response = await fetch(`/api/providers/${encodeURIComponent(providerId)}/models${query}`);
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { models: string[] };
  return payload.models;
}

/** Draft probe: lists models from an UNSAVED provider (baseUrl + apiKey in the body). */
export async function probeRemoteModels(input: {
  baseUrl: string;
  apiKey?: string;
  kind?: ProviderKind;
}): Promise<string[]> {
  const response = await fetch('/api/providers/probe-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey ?? '',
      kind: input.kind,
    }),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { models: string[] };
  return payload.models;
}


/** Submits an async generation task and returns the provider's task id. */
export async function submitImageTask(input: {
  providerId: string;
  model: string;
  prompt: string;
  apiKey?: string;
  /** Testing overrides, forwarded to the provider untouched. */
  aspectRatio?: string;
  width?: number;
  height?: number;
  /** Reference images (data URLs) — forwarded as-is; the endpoint's own
      capacity (not any model tag) decides whether they can be sent. */
  images?: string[];
}): Promise<string> {
  const response = await fetch('/api/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { taskId?: string };
  if (!payload.taskId) throw new ApiError('The proxy did not return a task id.');
  return payload.taskId;
}

/** One poll of a submitted task. Terminal statuses come back as SUCCEED/FAILED.
 * `note` carries a non-fatal caveat for successful generations (e.g. a size
 * request the provider rejected was dropped in a retry). */
export async function pollImageTask(
  taskId: string,
): Promise<{ status: string; images: string[]; error?: string; note?: string }> {
  const response = await fetch(`/api/images/tasks/${encodeURIComponent(taskId)}`);
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as {
    status?: string;
    images?: string[];
    error?: string;
    note?: string;
  };
  return {
    status: payload.status ?? 'UNKNOWN',
    images: payload.images ?? [],
    error: payload.error,
    note: payload.note,
  };
}

/** Every image the server has saved locally, newest first. */
export async function fetchLocalImages(): Promise<string[]> {
  const response = await fetch('/api/images/local-list');
  if (!response.ok) return [];
  const payload = (await response.json()) as { images?: string[] };
  return payload.images ?? [];
}

/** The user's persisted, ordered Gallery collection. */
export async function fetchGallery(): Promise<string[]> {
  const response = await fetch('/api/gallery', { cache: 'no-store' });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { images?: string[] };
  return payload.images ?? [];
}

/** Replaces the whole Gallery collection (add, remove, and reorder in one call). */
export async function saveGallery(images: string[]): Promise<void> {
  const response = await fetch('/api/gallery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images }),
  });
  if (!response.ok) await parseError(response);
}

/** Local proxy URL that downloads a generated image as a file. */
export function imageFileUrl(url: string): string {
  return `/api/images/file?url=${encodeURIComponent(url)}`;
}


/** All generation sessions, newest activity first. */
export async function fetchImageSessions(): Promise<ImageSession[]> {
  const response = await fetch('/api/images/sessions');
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { sessions?: ImageSession[] };
  return payload.sessions ?? [];
}

/** Creates an empty session; label defaults to a dated one on the server. */
export async function createImageSession(label?: string): Promise<ImageSession> {
  const response = await fetch('/api/images/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { session: ImageSession };
  return payload.session;
}

export async function deleteImageSession(id: string): Promise<void> {
  const response = await fetch(`/api/images/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 204) await parseError(response);
}

/** Renames a session inline (sidebar context menu). */
export async function renameImageSession(id: string, label: string): Promise<ImageSession> {
  const response = await fetch(`/api/images/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { session: ImageSession };
  return payload.session;
}

/** Appends finished generations to a session, newest last. */
export async function appendImageSessionItems(
  id: string,
  items: ImageSessionItem[],
): Promise<ImageSession> {
  const response = await fetch(`/api/images/sessions/${encodeURIComponent(id)}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { session: ImageSession };
  return payload.session;
}

/**
 * Removes temporary generated images. Gallery-referenced files are protected
 * server-side and returned as `skipped`.
 */
export async function cleanupImages(options: {
  all?: boolean;
  urls?: string[];
}): Promise<{ removed: number; skipped: number }> {
  const response = await fetch('/api/images/cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as { removed: number; skipped: number };
}

export async function fetchImageSettings(): Promise<ImageSettings> {
  const response = await fetch('/api/settings');
  if (!response.ok) await parseError(response);
  return (await response.json()) as ImageSettings;
}

export async function saveImageSettings(settings: ImageSettings): Promise<ImageSettings> {
  const response = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as ImageSettings;
}

export interface ChatStreamOptions {
  providerId: string;
  model: string;
  messages: ChatMessage[];
  settings: ChatSettings;
  /**
   * Marks THIS REQUEST as a compaction summarization (never persisted on the
   * conversation): the server's enforcement ladder keeps the compaction
   * system prompt intact at L4+ instead of wiping `systemInstruction` — a
   * compaction without its section skeleton degrades into transcript mimicry.
   */
  compaction?: boolean;
  /** PROBATION ladder state (conversation-level, client-owned). */
  trust?: { level: 1 | 2 | 3 | 4 | 5; outputFrozen: boolean; evadeAt?: number };
  /**
   * OPERATOR RELAY: the operator's message, sent so the harness can deliver
   * it as its own system-prompt authority. Set when the composer role is
   * Operator; the route turns it into the `operator-directive` injection.
   */
  operatorDirective?: string;
  /** Only sent for providers whose key the user entered in the UI. */
  apiKey?: string;
  /** Optional: one-shot helpers (auto-titling) may omit it. */
  signal?: AbortSignal;
  /**
   * Attachment paths persisted under `.attachments/` for THIS message (the
   * Composer uploads each file the moment it is picked). The harness injects
   * them into the system prompt so the model can point its file tools at the
   * files by stable path.
   */
  attachmentPaths?: string[];
  /**
   * Harness context plumbing: the persisted injections ride along so every
   * request keeps the same context; `refresh` rebuilds them (conversation
   * start, model switch, after compaction). `sessionId` keys goals state.
   */
harness?: {
     persisted?: TurnInjection[];
     refresh?: boolean;
     sessionId?: string;
     /**
      * Per-conversation CONTEXT ID for the read-before-edit policy. Changes
      * on regenerate/model switch/compaction/tab close; the server voids old
      * read receipts on change (multi-session enforcement).
      */
     contextId?: string;
   };
  /**
   * RESUME: when set, this send re-attaches to the conversation's live
   * server-side stream (page reloaded mid-generation) instead of starting a
   * fresh request — see the probe at the top of `streamChat`.
   */
  streamId?: string;
  /**
   * With `streamId`: if the probe says the run is gone, FAIL LOUDLY instead
   * of falling through to a fresh POST — a resume caller does not want to
   * accidentally double-generate the last message.
   */
  resumeOnly?: boolean;
  /**
   * RESUME OF A CRASHED RUN: the durable job journal's run id. The server
   * loads that run's executed tool calls as an idempotency map, so re-sent
   * history does not re-execute mutating tools. Absent on ordinary sends.
   */
  resumeFrom?: string;
  /**
   * Which conversation this run belongs to — the server tags the stream with
   * it so ANY browser/tab can see "this chat is generating right now" via
   * GET /api/chat/live (the sidebar's live badge). One-shot helpers
   * (auto-titling) omit it.
   */
  conversationId?: string;
  /**
   * TURN ID OWNERSHIP: this run's assistant turn id, minted by the caller
   * BEFORE the POST. The server adopts it (echoing it on the stream_id frame)
   * so every consumer of the run — this tab, a reload, a second browser —
   * writes patches under the SAME turn id. Without it each consumer minted
   * its own and the shared record grew duplicate assistant turns.
   */
  assistantTurnId?: string;
}

/** Response of POST /api/attachments/upload. */
interface UploadResult {
  ok: boolean;
  path?: string;
  filename?: string;
  size?: number;
  mime?: string;
  error?: string;
}

/**
 * Persists ONE picked file to the attachment directory under the active
 * workspace, the moment the user selects it. Returns the workspace-rooted
 * path the model's file tools accept, or null when there is no workspace / the
 * server rejected the file — the caller then simply keeps the in-memory data
 * URL and everything still works.
 *
 * `chatId` puts the file into the CONVERSATION'S OWN subfolder
 * (`.attachments/<chatId>/…`), so attachments from different chats never
 * mingle in one shared directory.
 */
export async function uploadAttachment(file: File, chatId?: string): Promise<string | null> {
  const params = new URLSearchParams({ name: file.name });
  if (chatId) params.set('chatId', chatId);
  try {
    const response = await fetch(`/api/attachments/upload?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as UploadResult;
    return typeof payload.path === 'string' && payload.path ? payload.path : null;
  } catch {
    return null;
  }
}


/**
 * The browser-cacheable URL for a stored payload: content-addressed and
 * immutable, so the thread's <img> and VisualCard fetch-on-mount read through
 * here and repeat renders never re-download.
 */
export function attachmentRefUrl(hash: string, mime?: string): string {
  return `/api/attachments/ref/${encodeURIComponent(hash)}${mime ? `?mime=${encodeURIComponent(mime)}` : ''}`;
}

/**
 * VISUAL v2 PICK — records the user's choice of one frontend-preview
 * candidate. The server broadcasts it to every other browser and returns the
 * tool_result-shaped sentence the caller turns into a steer so the running
 * model learns the pick. Null = network/shape failure (caller keeps the UI
 * consistent locally anyway).
 */
export async function pickVisualVariant(input: {
  visualId: string;
  variantId: string;
  variantIndex?: number;
  title?: string;
}): Promise<string | null> {
  try {
    const response = await fetch('/api/agent/visual/pick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { steerText?: unknown };
    return typeof payload.steerText === 'string' && payload.steerText ? payload.steerText : null;
  } catch {
    return null;
  }
}

/**
 * Turns a wire URL into a browser-renderable URL: `moriko-ref://<mime>/<hash>`
 * (the wire/persistence form) becomes the byte-store HTTP route. Inline data
 * URLs and plain http(s) URLs pass through untouched. Used by the steer
 * bubbles, whose parts carry wire-form URLs.
 */
export function renderableRefUrl(url: string): string {
  if (!url.startsWith('moriko-ref://')) return url;
  const rest = url.slice('moriko-ref://'.length);
  const slash = rest.lastIndexOf('/');
  if (slash <= 0) return url;
  const mime = rest.slice(0, slash);
  const hash = rest.slice(slash + 1);
  return attachmentRefUrl(hash, mime);
}

/**
 * The server-resolvable wire URL for a stored payload. POST /api/chat swaps
 * it back for the real bytes at the provider boundary — the record itself
 * never carries the base64 again.
 */
export function attachmentRefWireUrl(hash: string, mime: string): string {
  return `moriko-ref://${mime}/${hash}`;
}

/**
 * Pushes bytes into the server's byte store BEFORE the send, so the
 * conversation record can reference the payload by hash instead of carrying
 * its base64. Returns the ref object, or null when unreachable (the caller
 * then keeps the inline data URL — small payloads ride fine).
 */
export async function storeBytesRef(bytes: ArrayBuffer, mime: string): Promise<{ hash: string; mime: string; byteSize: number } | null> {
  try {
    const response = await fetch(`/api/attachments/store?mime=${encodeURIComponent(mime)}`, {
      method: 'POST',
      headers: { 'Content-Type': mime || 'application/octet-stream' },
      body: bytes,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { ok?: boolean; hash?: unknown; mime?: unknown };
    if (payload.ok !== true || typeof payload.hash !== 'string' || !payload.hash) return null;
    return { hash: payload.hash, mime: typeof payload.mime === 'string' ? payload.mime : mime, byteSize: bytes.byteLength };
  } catch {
    return null;
  }
}


/** hash → dataUrl memo: one fetch per unique byte-store entry per session. */
const refDataUrlCache = new Map<string, Promise<string | null>>();
/** hash → text memo (visual html payloads). */
const refTextCache = new Map<string, Promise<string | null>>();

function fetchRefAsDataUrl(hash: string, mime: string): Promise<string | null> {
  const cached = refDataUrlCache.get(hash);
  if (cached) return cached;
  const promise = fetch(attachmentRefUrl(hash, mime))
    .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`payload ${response.status}`))))
    .then(
      (blob) =>
        new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        }),
    )
    .catch(() => null);
  refDataUrlCache.set(hash, promise);
  return promise;
}

function fetchRefAsText(hash: string): Promise<string | null> {
  const cached = refTextCache.get(hash);
  if (cached) return cached;
  const promise = fetch(attachmentRefUrl(hash, 'text/html'))
    .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`payload ${response.status}`))))
    .catch(() => null);
  refTextCache.set(hash, promise);
  return promise;
}

/**
 * Deep-walks conversations and re-inlines every byte-store ref as REAL bytes
 * (attachments/tool images → data URLs, visuals → html text) IN PLACE.
 *
 * Called on the export paths (single chat + full bundle): a portable export
 * must not depend on THIS device's byte store — a bundle that only carries
 * `dataRef` hashes is useless on another machine. Deduped by hash, so a
 * hundred references to the same image cost one fetch. A payload that cannot
 * resolve (byte store gone) keeps its ref — import still works on the
 * exporting device and the render degrades to the attachment label.
 */
export async function hydrateConversationPayloads(conversations: unknown[]): Promise<void> {
  const jobs: Promise<void>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const typed = value as Record<string, unknown>;

    const dataRef = typed.dataRef as { hash?: unknown; mime?: unknown } | undefined;
    if (dataRef && typeof dataRef.hash === 'string' && dataRef.hash && !typed.dataUrl) {
      const hash = dataRef.hash;
      const mime = typeof dataRef.mime === 'string' && dataRef.mime ? dataRef.mime : 'application/octet-stream';
      jobs.push(
        fetchRefAsDataUrl(hash, mime).then((dataUrl) => {
          if (dataUrl) typed.dataUrl = dataUrl;
        }),
      );
    }
    const htmlRef = typed.htmlRef as { hash?: unknown } | undefined;
    if (htmlRef && typeof htmlRef.hash === 'string' && htmlRef.hash && !typed.html) {
      const hash = htmlRef.hash;
      jobs.push(
        fetchRefAsText(hash).then((html) => {
          if (html !== null) typed.html = html;
        }),
      );
    }
    Object.values(typed).forEach(visit);
  };
  conversations.forEach(visit);
  await Promise.all(jobs);
}


/**
 * The server's authoritative chat SUMMARIES, or null when unreachable.
 *
 * The list endpoints ship a compact projection (a few hundred bytes per
 * chat) instead of the whole multi-megabyte store; full bodies load on
 * demand via fetchConversationDetail.
 */
export async function fetchConversationSummaries(): Promise<ConversationSummary[] | null> {
  try {
    const response = await fetch('/api/conversations');
    if (!response.ok) return null;
    const payload = (await response.json()) as { conversations?: unknown };
    return Array.isArray(payload.conversations) ? (payload.conversations as ConversationSummary[]) : null;
  } catch {
    return null;
  }
}

/** One full conversation record by id — the thread loads a chat on demand.
 *  P3: SINGLE-FLIGHT per id — the audit caught the SAME body GET ×2 at boot
 *  (the boot list and the fold racing the same id); a second caller now
 *  awaits the first request instead of doubling the download. */
const conversationDetailInFlight = new Map<string, Promise<Conversation | null>>();

export function fetchConversationDetail(id: string): Promise<Conversation | null> {
  const inFlight = conversationDetailInFlight.get(id);
  if (inFlight) return inFlight;
  const request = (async () => {
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
      if (!response.ok) return null;
      const payload = (await response.json()) as { conversation?: unknown };
      const conversation = (payload.conversation as Conversation) ?? null;
      if (!conversation) return null;
      if (!conversation.settings.enforcement) {
        conversation.settings.enforcement = {
          level: conversation.settings.lockdown?.active ? 4 : 0,
          mode: 'manual',
          message: conversation.settings.lockdown?.message ?? '',
        };
      }
      if (!conversation.settings.lockdown) {
        conversation.settings.lockdown = { active: conversation.settings.enforcement?.level >= 4, message: conversation.settings.enforcement?.message ?? '' };
      }
      if (!conversation.settings.probation) {
        conversation.settings.probation = { enabled: false };
      }
      return conversation;
    } catch {
      return null;
    } finally {
      conversationDetailInFlight.delete(id);
    }
  })();
  conversationDetailInFlight.set(id, request);
  return request;
}

/** One entry of GET /api/chat/live — a run still streaming server-side. */
export interface LiveStreamInfo {
  id: string;
  /** null for one-shot helpers (auto-titling) — no badge for those. */
  conversationId: string | null;
  startedAt: number;
  /**
   * The last moment this run published a frame. A live-listed stream whose
   * lastFrameAt is minutes old is WEDGED, not working — the UI can show the
   * difference instead of spinning a badge over a frozen thread.
   */
  lastFrameAt: number;
}

/**
 * Which runs are STILL streaming, straight from the server's registry — the
 * shared truth behind the sidebar's live badge. Null on any failure (server
 * restarting, offline): the badge simply falls back to this tab's local
 * genRunning state until the next poll succeeds.
 */
export async function fetchLiveStreams(): Promise<LiveStreamInfo[] | null> {
  try {
    const response = await fetch('/api/chat/live');
    if (!response.ok) return null;
    const payload = (await response.json()) as { streams?: unknown };
    return Array.isArray(payload.streams) ? (payload.streams as LiveStreamInfo[]) : null;
  } catch {
    return null;
  }
}

/**
 * Pushes changed/deleted conversations and resolves with the post-merge
 * SUMMARY list the server holds (including other browsers' edits), or null
 * on failure — the caller keeps its copy dirty and retries on the next
 * persist. Merging happens by conversation id, never whole-array.
 *
 * The response is a summary delta, not a full echo: the fold fetches only
 * the bodies the server holds NEWER than the local copies, so a sync no
 * longer downloads the whole store on every debounce.
 *
 * RELOAD-WINDOW RETRY: the graceful reload (exit 75 → supervisor respawn →
 * tsx boot) leaves a few seconds where the proxy refuses connections and the
 * vite proxy answers /api/conversations/sync with a 500 — that is the
 * ECONNREFUSED noise in the dev log. P3: network failures and 5xx retry on an
 * EXPONENTIAL BACKOFF with jitter (1.5s → 3s → 6s → capped 12s, ±20% jitter);
 * CONSECUTIVE 5xx responses (3 in a row) arm a circuit breaker that FAILS
 * FAST for a minute — a restarting proxy is answered with silence, not a
 * thundering herd of retries. 4xx validation failures are NOT retried (they
 * would fail again). The unload beacon does not go through here — sendBeacon
 * has no response to read, and boot reconcile covers its gap.
 */
const SYNC_RETRY_DELAYS_MS = [1_500, 3_000, 6_000, 12_000];
/** Consecutive 5xx before the circuit opens (the reload window fires 1–2). */
const SYNC_5XX_BREAKER_THRESHOLD = 3;
/** How long the open circuit fails fast (a restart takes seconds, not minutes). */
const SYNC_5XX_BREAKER_MS = 60_000;

let syncFailureStreak = 0;
let syncCircuitOpenUntil = 0;

/** Exponential backoff + ±20% jitter: never a synchronized retry stampede. */
function syncRetryDelayMs(): number {
  const base = SYNC_RETRY_DELAYS_MS[Math.min(syncFailureStreak, SYNC_RETRY_DELAYS_MS.length - 1)];
  const jitter = base * (0.8 + Math.random() * 0.4);
  return Math.round(jitter);
}

function noteSyncFailure(status: number | null): void {
  if (status !== null && status >= 500) {
    syncFailureStreak += 1;
    if (syncFailureStreak >= SYNC_5XX_BREAKER_THRESHOLD) {
      syncCircuitOpenUntil = Date.now() + SYNC_5XX_BREAKER_MS;
    }
  } else {
    syncFailureStreak += 1;
  }
}

function noteSyncSuccess(): void {
  syncFailureStreak = 0;
  syncCircuitOpenUntil = 0;
}

async function postSyncOnce(
  upsert: Conversation[],
  removeIds: string[],
  turnPatches: TurnPatch[],
): Promise<Response | null> {
  if (Date.now() < syncCircuitOpenUntil) return null;
  try {
    const response = await fetch('/api/conversations/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upsert, removeIds, turnPatches }),
    });
    if (response.status >= 500) {
      noteSyncFailure(response.status);
    } else {
      noteSyncSuccess();
    }
    return response;
  } catch {
    noteSyncFailure(null);
    return null;
  }
}

export async function syncConversations(
  upsert: Conversation[],
  removeIds: string[],
  turnPatches: TurnPatch[] = [],
): Promise<ConversationSummary[] | null> {
  for (let attempt = 0; attempt <= SYNC_RETRY_DELAYS_MS.length; attempt += 1) {
    const response = await postSyncOnce(upsert, removeIds, turnPatches);
    if (response && response.ok && response.status < 500) {
      const payload = (await response.json()) as { conversations?: unknown };
      return Array.isArray(payload.conversations) ? (payload.conversations as ConversationSummary[]) : null;
    }
    if (response && response.status < 500) return null;
    if (attempt === SYNC_RETRY_DELAYS_MS.length) break;
    await new Promise((resolve) => setTimeout(resolve, syncRetryDelayMs()));
  }
  return null;
}

/**
 * Best-effort final push while the page goes away: sendBeacon survives the
 * unload, an ordinary fetch might not. No response is read — the next boot
 * reconciles from the server anyway.
 */
export function beaconSyncConversations(
  upsert: Conversation[],
  removeIds: string[],
  turnPatches: TurnPatch[] = [],
): void {
  try {
    const blob = new Blob([JSON.stringify({ upsert, removeIds, turnPatches })], {
      type: 'application/json',
    });
    navigator.sendBeacon('/api/conversations/sync', blob);
  } catch {
  }
}

/**
 * Streams a completion.
 *
 * The proxy emits `text/event-stream` frames that are each a JSON `StreamEvent`.
 * We parse them by hand rather than using `EventSource`, because `EventSource`
 * cannot send a POST body or carry an abort signal.
 */
export async function* streamChat(options: ChatStreamOptions): AsyncGenerator<StreamEvent> {
  if (options.streamId) {
    const probe = await probeResume(options.streamId);
    if (probe.live) {
      yield* resumeChat(options.streamId);
      return;
    }
    if (options.resumeOnly) {
      throw new ApiError('The interrupted stream is no longer live on the server.', 410);
    }
  }

  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        providerId: options.providerId,
        model: options.model,
        messages: options.messages,
        settings: options.settings,
        trust: options.trust,
        operatorDirective: options.operatorDirective,
        apiKey: options.apiKey,
        attachmentPaths: options.attachmentPaths,
        harness: options.harness,
        resumeFrom: options.resumeFrom,
        conversationId: options.conversationId,
        assistantTurnId: options.assistantTurnId,
        compaction: options.compaction === true,
      }),
    });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error;
    }
    throw new ApiError(
      'Cannot reach the local Moriko proxy (port 8791). Start the server — `npm start` — and try again.',
      503,
    );
  }

  if (!response.ok) await parseError(response);
  if (!response.body) throw new ApiError('The proxy returned an empty stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const event = JSON.parse(payload) as StreamEvent;
            if (event.type === 'text' || event.type === 'reasoning') {
              const coerced = coerceDelta(event.delta);
              if (coerced === null || coerced === '') continue;
              yield { ...event, delta: coerced };
            } else {
              yield event;
            }
          } catch {
          }
        }

        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * STEER: push mid-run text into a live generation's context.
 *
 * The proxy buffers it server-side and the running adapter drains it between
 * tool rounds. Returns the server-assigned steer id (the `steer` stream event
 * echoes the SAME id when the text is actually delivered — the optimistic
 * bubble is matched on it), or null when the run already ended (409) or the
 * network dropped — a normal race, not an error.
 */
export async function steerChat(
  sessionId: string,
  text: string,
): Promise<{ id: string | null; parts?: SteerClientPart[] }> {
  return steerWithParts(sessionId, [{ type: 'text', text }]);
}

/**
 * VISUAL v2 PICK STEER — announces the user's frontend-preview pick to the
 * RUNNING model through the same mid-run steer channel. The sentence comes
 * from /api/agent/visual/pick (tool_result-shaped, model-legible). Returns
 * the steer echo; the card already painted the choice locally regardless.
 */
export async function steerVisualPick(sessionId: string, steerText: string): Promise<void> {
  await steerChat(sessionId, steerText);
}

/**
 * Manual SYSTEM-RULES REMINDER ("Send Reminder" button): pushes a server-owned
 * preset reminder into the running generation — same steer channel, no text to
 * type. `preset` must match a key of the server's SYSTEM_RULES_PRESETS.
 */
export type SteerFailure = { id: null; reason: 'not_streaming' | 'error'; detail?: string };

/** Wire part a steer carries — same shape as the message wire parts. */
export type SteerClientPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

/**
 * STEER (DSH parity): sends a real user message (text and/or image/file parts)
 * into the running generation. Image URLs may be a data URL or a
 * `moriko-ref://` wire URL — resolved at the provider boundary like any other
 * attachment. The failure variant carries the real reason so the notice never
 * lies with "the run just finished".
 */
export async function steerWithParts(
  sessionId: string,
  parts: SteerClientPart[],
): Promise<{ id: string | null } | SteerFailure> {
  try {
    const response = await fetch('/api/chat/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, parts }),
    });
    if (!response.ok) {
      if (response.status === 409) return { id: null, reason: 'not_streaming' };
      let detail: string | undefined;
      try {
        detail = ((await response.json()) as { error?: string }).error;
      } catch {
      }
      return { id: null, reason: 'error', detail };
    }
    const payload = (await response.json()) as SteerEcho;
    return { id: typeof payload.id === 'string' ? payload.id : null };
  } catch (cause) {
    return { id: null, reason: 'error', detail: cause instanceof Error ? cause.message : undefined };
  }
}

export async function sendReminderPreset(
  sessionId: string,
  preset: string,
): Promise<{ id: string | null } | SteerFailure> {
  try {
    const response = await fetch('/api/chat/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, preset }),
    });
    if (!response.ok) {
      if (response.status === 409) return { id: null, reason: 'not_streaming' };
      // the user hunting the wrong bug. Surface the real reason.
      let detail: string | undefined;
      try {
        detail = ((await response.json()) as { error?: string }).error;
      } catch {
      }
      return { id: null, reason: 'error', detail };
    }
    const payload = (await response.json()) as SteerEcho;
    return { id: typeof payload.id === 'string' ? payload.id : null };
  } catch (cause) {
    return { id: null, reason: 'error', detail: cause instanceof Error ? cause.message : undefined };
  }
}

export interface SteerEcho {
  /** Server-assigned steer id — returned by the 202 and echoed in the event. */
  id?: string;
  ok?: boolean;
}

/**
 * Whether a provider has a usable key.
 *
 * `hasServerKey` is the whole answer now: the server computes it from the
 * device vault (`~/.moriko/api-keys.json`) plus the environment, and the
 * browser holds no key material at all. The old fallback — "or a key pasted in
 * this browser" — is gone with the browser store it read from.
 */
export function providerHasKey(provider: ProviderPublic | undefined): boolean {
  return Boolean(provider?.hasServerKey);
}

export interface ExportBundle {
  kind: 'moriko-export';
  version: 1;
  exportedAt: string;
  conversations: unknown[];
  providerKeys?: Record<string, string>;
}

export function buildExportBundle(
  conversations: unknown[],
  providerKeys: Record<string, string>,
): ExportBundle {
  return {
    kind: 'moriko-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    conversations,
    providerKeys,
  };
}

/** Single-conversation export: one thread, no provider keys. */
export interface ConversationExport {
  kind: 'moriko-conversation-export';
  version: 1;
  exportedAt: string;
  conversation: unknown;
}

export function buildConversationExport(conversation: unknown): ConversationExport {
  return {
    kind: 'moriko-conversation-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    conversation,
  };
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}


export interface StorageLocationView {
  current: string;
  pending: string | null;
  default: string;
  isDefault: boolean;
  needsReload?: boolean;
  report?: string[];
}

export async function fetchStorageLocation(): Promise<StorageLocationView> {
  const res = await fetch('/api/storage/location');
  if (!res.ok) throw new Error(`storage location fetch failed (${res.status})`);
  return (await res.json()) as StorageLocationView;
}

export async function saveStorageLocation(value: string): Promise<StorageLocationView> {
  const res = await fetch('/api/storage/location', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: value }),
  });
  const body = (await res.json()) as StorageLocationView & { error?: string };
  if (!res.ok) throw new Error(body.error || `storage location save failed (${res.status})`);
  return body;
}

/**
 * HARNESS RELOAD (user-facing): trigger the graceful restart, then wait for
 * the fresh server to answer before reloading the page — a blind reload can
 * hit the dying process and lose the moment. The typecheck gate inside
 * harness-reload may take a while; the poll absorbs that.
 */
export async function reloadHarness(): Promise<void> {
  const res = await fetch('/api/agent/harness-reload', { method: 'POST' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `harness reload failed (${res.status})`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const deadline = Date.now() + 120_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const probe = await fetch('/api/ui-state', { cache: 'no-store' });
      if (probe.ok) {
        window.location.reload();
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `harness did not come back within 2 minutes${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
  );
}


/** AGENT WORKFLOWS — merged catalog (built-ins + the user's own). */
export interface AgentWorkflowDTO {
  id: string;
  label: string;
  hint: string;
  content: string;
  builtin: boolean;
  modified: boolean;
}

export async function fetchWorkflows(): Promise<AgentWorkflowDTO[]> {
  try {
    const response = await fetch('/api/workflows', { cache: 'no-store' });
    if (!response.ok) return [];
    const payload = (await response.json()) as { workflows?: AgentWorkflowDTO[] };
    return Array.isArray(payload.workflows) ? payload.workflows : [];
  } catch {
    return [];
  }
}

export async function saveWorkflow(input: {
  id?: string;
  label: string;
  hint: string;
  content: string;
}): Promise<AgentWorkflowDTO> {
  const response = await fetch('/api/workflows', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `workflow save failed (${response.status})`);
  }
  const payload = (await response.json()) as { workflow?: AgentWorkflowDTO };
  if (!payload.workflow) throw new Error('workflow save returned no workflow');
  return payload.workflow;
}

export async function deleteWorkflow(id: string): Promise<void> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `workflow delete failed (${response.status})`);
  }
}
