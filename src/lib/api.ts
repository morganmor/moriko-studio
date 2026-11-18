import type {
  AgentPermissionRequest,
  AskAnswer,
  AskUserRequest,
  OperatorGateRequest,
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
  ProviderModelConfig,
  ProviderModelEntry,
  ProviderModelHint,
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



export type { AgentWorkspaceInfo };


export type { AgentPermissionRequest };


export type { OperatorGateRequest };

// Goals / plans / todos (Context Injection)


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


export async function sweepTodosApi(sessionId: string): Promise<Todo[]> {
  const response = await fetch('/api/todos/sweep', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId }),
  });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { todos?: Todo[] };
  return payload.todos ?? [];
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
  
  operation: string;
  size: number;
  createdAt: number;
}

export interface VaultRestoreOutcome {
  target: string;
  entry: VaultSnapshotMeta;
  
  diff?: string;
  diffstat?: { added: number; removed: number };
  
  previousEntryId?: string;
}


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


export interface AgentBrowseEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'drive';
  mtimeMs?: number;
  size?: number | null;
}

export interface AgentBrowseResult {
  
  path: string | null;
  
  parent: string | null;
  
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



const panelWindows = new Map<string, Window>();


function extractSessionKey(panelUrl?: string, explicitSessionId?: string): string {
  if (explicitSessionId && explicitSessionId.trim()) return explicitSessionId.trim();
  if (panelUrl) {
    try {
      const parsed = new URL(panelUrl, window.location.origin);
      const s = parsed.searchParams.get('session');
      if (s && s.trim()) return s.trim();
    } catch {
    }
  }
  return 'default';
}


export async function getBrowserPanelUrl(sessionId?: string): Promise<string> {
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  const response = await fetch(`/api/agent/browser/panel-url${query}`);
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { panelUrl: string };
  return payload.panelUrl;
}


export function openBrowserPanel(panelUrl: string, sessionId?: string): Window | null {
  const width = Math.min(1680, Math.floor(window.screen.availWidth * 0.96));
  const height = Math.floor(window.screen.availHeight * 0.94);
  const left = Math.max(0, Math.floor((window.screen.availWidth - width) / 2));
  const top = Math.max(0, Math.floor((window.screen.availHeight - height) / 2));
  const sid = extractSessionKey(panelUrl, sessionId);
  const target = `moriko-browser-panel-${sid.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const win = window.open(panelUrl, target, `width=${width},height=${height},left=${left},top=${top}`);
  if (win) panelWindows.set(sid, win);
  return win;
}


export async function pushCompactionConfig(
  conversationId: string,
  config: {
    autoCompact: boolean;
    compactThresholdTokens: number | null;
    compactThresholdRatio: number | null;
    maxContextTokens: number | null;
  },
): Promise<void> {
  const response = await fetch('/api/compaction/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, config }),
  });
  if (!response.ok) await parseError(response);
}


export async function setWebAccessRemote(on: boolean, sessionId?: string): Promise<void> {
  try {
    await fetch('/api/agent/browser/web-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on, ...(sessionId ? { sessionId } : {}) }),
    });
    if (on === false) {
      if (sessionId) {
        const win = panelWindows.get(sessionId);
        if (win && !win.closed) win.close();
        panelWindows.delete(sessionId);
      } else {
        for (const [sid, win] of panelWindows) {
          if (win && !win.closed) win.close();
          panelWindows.delete(sid);
        }
      }
    }
  } catch {
  }
}


export function openBrowserPanelOnce(panelUrl?: string, sessionId?: string): void {
  const sid = extractSessionKey(panelUrl, sessionId);
  const defaultUrl =
    sid !== 'default' ? `/browser-view.html?session=${encodeURIComponent(sid)}` : '/browser-view.html';
  const url = panelUrl ?? defaultUrl;
  try {
    const existing = panelWindows.get(sid);
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }
    const opened = openBrowserPanel(url, sid);
    if (opened) panelWindows.set(sid, opened);
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


export async function deleteAgentWorkspace(id: string): Promise<void> {
  const response = await fetch(`/api/agent/workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!response.ok) await parseError(response);
}


export async function setActiveAgentWorkspace(id: string, sessionId?: string): Promise<void> {
  const response = await fetch('/api/agent/workspaces/active', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, sessionId }),
  });
  if (!response.ok) await parseError(response);
}


export async function browseAgentDir(path?: string): Promise<AgentBrowseResult> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const response = await fetch(`/api/agent/browse${query}`);
  if (!response.ok) await parseError(response);
  return (await response.json()) as AgentBrowseResult;
}


export async function pickNativeWorkspace(): Promise<string | null> {
  const response = await fetch('/api/agent/native-pick', { method: 'POST' });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { path?: string | null };
  return payload.path ?? null;
}


export async function fetchPendingAgentPermissions(): Promise<AgentPermissionRequest[]> {
  const response = await fetch('/api/agent/permissions');
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { requests?: AgentPermissionRequest[] };
  return payload.requests ?? [];
}


export async function fetchPendingAskUser(): Promise<AskUserRequest[]> {
  const response = await fetch('/api/agent/ask-user');
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { requests?: AskUserRequest[] };
  return payload.requests ?? [];
}


export async function fetchPendingOperatorGates(): Promise<OperatorGateRequest[]> {
  const response = await fetch('/api/agent/gates');
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { requests?: OperatorGateRequest[] };
  return payload.requests ?? [];
}


export async function decideOperatorGate(
  id: string,
  verdict: 'accept' | 'reject',
  reason: string,
): Promise<void> {
  const response = await fetch(`/api/agent/gates/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verdict, reason }),
  });
  if (!response.ok) await parseError(response);
}


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


export async function extendAgentQuestion(id: string, ms: number): Promise<void> {
  const response = await fetch(`/api/agent/ask-user/${encodeURIComponent(id)}/extend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ms }),
  });
  if (!response.ok) await parseError(response);
}


export async function decideAgentPermission(
  id: string,
  approve: boolean,
  remember: boolean,
  reason?: string,
): Promise<void> {
  const response = await fetch(`/api/agent/permissions/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve, remember, reason }),
  });
  if (!response.ok) await parseError(response);
}


export interface AgentTaskDto {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  endedBy?: string;
  startedAt: number;
  elapsedSec: number;
  
  tail: string;
  outputBytes: number;
}


export async function fetchAgentTasks(sessionId?: string): Promise<AgentTaskDto[]> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const response = await fetch(`/api/agent/tasks${query}`);
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { tasks?: AgentTaskDto[] };
  return payload.tasks ?? [];
}


export async function stopAgentTask(id: string, sessionId?: string): Promise<void> {
  const response = await fetch(`/api/agent/tasks/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
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
  
  auth?: 'figma';
  
  disabledTools?: string[];
  createdAt: string;
}


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
  auth?: 'figma';
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


export interface FigmaAuthStatus {
  connected: boolean;
  scope?: string;
  obtainedAt?: string;
}

export async function getFigmaAuth(): Promise<FigmaAuthStatus> {
  const response = await fetch('/api/mcp/figma/auth');
  if (!response.ok) await parseError(response);
  return (await response.json()) as FigmaAuthStatus;
}


export async function connectFigma(): Promise<void> {
  const response = await fetch('/api/mcp/figma/auth', { method: 'POST' });
  if (!response.ok) await parseError(response);
}

export async function disconnectFigma(): Promise<void> {
  const response = await fetch('/api/mcp/figma/auth', { method: 'DELETE' });
  if (!response.ok) await parseError(response);
}


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



export async function probeResume(streamId: string): Promise<{ ok: boolean; live: boolean }> {
  const response = await fetch(`/api/chat/resume/${encodeURIComponent(streamId)}`, {
    method: 'HEAD',
  });
  if (response.status === 200) return { ok: true, live: true };
  if (response.status === 204) return { ok: true, live: false };
  return { ok: false, live: false };
}


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
  
  modelConfigs?: Record<string, ProviderModelConfig>;
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


export async function updateBuiltInProvider(
  providerId: string,
  patch: {
    apiKey?: string;
    addModels?: string[];
    removeModels?: string[];
    setModels?: string[];
    
    modelHints?: Record<string, ProviderModelHint>;
  },
): Promise<{
  hasServerKey: boolean;
  userSuppliedKey: boolean;
  models: string[];
  modelHints?: Record<string, ProviderModelHint>;
}> {
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
    modelHints?: Record<string, ProviderModelHint>;
  };
}


export interface RemoteModelList {
  models: string[];
  entries: ProviderModelEntry[];
  hints: Record<string, ProviderModelHint>;
  
  family?: string;
}

export async function fetchRemoteModels(
  providerId: string,
  apiKey?: string,
): Promise<RemoteModelList> {
  const query = apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : '';
  const response = await fetch(`/api/providers/${encodeURIComponent(providerId)}/models${query}`);
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as Partial<RemoteModelList>;
  return {
    models: payload.models ?? [],
    entries: payload.entries ?? [],
    hints: payload.hints ?? {},
    family: payload.family,
  };
}


export async function probeRemoteModels(input: {
  baseUrl: string;
  apiKey?: string;
  kind?: ProviderKind;
}): Promise<RemoteModelList> {
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
  const payload = (await response.json()) as Partial<RemoteModelList>;
  return {
    models: payload.models ?? [],
    entries: payload.entries ?? [],
    hints: payload.hints ?? {},
    family: payload.family,
  };
}


export async function saveModelConfigs(
  providerId: string,
  configs: Record<string, ProviderModelConfig>,
): Promise<Record<string, ProviderModelConfig>> {
  const response = await fetch(
    `/api/providers/${encodeURIComponent(providerId)}/model-configs`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configs }),
    },
  );
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { modelConfigs?: Record<string, ProviderModelConfig> };
  return payload.modelConfigs ?? {};
}



export async function submitImageTask(input: {
  providerId: string;
  model: string;
  prompt: string;
  apiKey?: string;
  
  aspectRatio?: string;
  width?: number;
  height?: number;
  
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


export async function fetchLocalImages(): Promise<string[]> {
  const response = await fetch('/api/images/local-list');
  if (!response.ok) return [];
  const payload = (await response.json()) as { images?: string[] };
  return payload.images ?? [];
}


export async function fetchGallery(): Promise<string[]> {
  const response = await fetch('/api/gallery', { cache: 'no-store' });
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { images?: string[] };
  return payload.images ?? [];
}


export async function saveGallery(images: string[]): Promise<void> {
  const response = await fetch('/api/gallery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images }),
  });
  if (!response.ok) await parseError(response);
}


export function imageFileUrl(url: string): string {
  return `/api/images/file?url=${encodeURIComponent(url)}`;
}



export async function fetchImageSessions(): Promise<ImageSession[]> {
  const response = await fetch('/api/images/sessions');
  if (!response.ok) await parseError(response);
  const payload = (await response.json()) as { sessions?: ImageSession[] };
  return payload.sessions ?? [];
}


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
  
  compaction?: boolean;
  
  trust?: {
    level: 1 | 2 | 3 | 4 | 5;
    outputFrozen: boolean;
    evadeAt?: number;
    continueCount?: number;
    continueSeized?: boolean;
  };
  
  operatorDirective?: string;
  
  apiKey?: string;
  
  signal?: AbortSignal;
  
  attachmentPaths?: string[];
  
harness?: {
     persisted?: TurnInjection[];
     refresh?: boolean;
     sessionId?: string;
     
     contextId?: string;
   };
  
  streamId?: string;
  
  resumeOnly?: boolean;
  
  resumeFrom?: string;
  
  conversationId?: string;
  
  assistantTurnId?: string;
}


interface UploadResult {
  ok: boolean;
  path?: string;
  filename?: string;
  size?: number;
  mime?: string;
  error?: string;
}


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



export function attachmentRefUrl(hash: string, mime?: string): string {
  return `/api/attachments/ref/${encodeURIComponent(hash)}${mime ? `?mime=${encodeURIComponent(mime)}` : ''}`;
}


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


export function renderableRefUrl(url: string): string {
  if (!url.startsWith('moriko-ref://')) return url;
  const rest = url.slice('moriko-ref://'.length);
  const slash = rest.lastIndexOf('/');
  if (slash <= 0) return url;
  const mime = rest.slice(0, slash);
  const hash = rest.slice(slash + 1);
  return attachmentRefUrl(hash, mime);
}


export function attachmentRefWireUrl(hash: string, mime: string): string {
  return `moriko-ref://${mime}/${hash}`;
}


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



const refDataUrlCache = new Map<string, Promise<string | null>>();

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


export interface LiveStreamInfo {
  id: string;
  
  conversationId: string | null;
  startedAt: number;
  
  lastFrameAt: number;
}


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


const SYNC_RETRY_DELAYS_MS = [1_500, 3_000, 6_000, 12_000];

const SYNC_5XX_BREAKER_THRESHOLD = 3;

const SYNC_5XX_BREAKER_MS = 60_000;

let syncFailureStreak = 0;
let syncCircuitOpenUntil = 0;


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

export interface ConversationConfigPatchPayload {
  settings?: Partial<import('../types').ChatSettings>;
  compaction?: import('../types').ConversationCompaction | null;
  hasCompaction?: boolean;
  providerId?: string;
  model?: string;
  liveContext?: import('../types').LiveContextTelemetry | null;
  initialConversation?: Conversation;
}

export async function patchConversationConfig(
  conversationId: string,
  payload: ConversationConfigPatchPayload,
): Promise<ConversationSummary | null> {
  try {
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/config`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { summary?: ConversationSummary };
    return data.summary ?? null;
  } catch {
    return null;
  }
}


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


export async function steerChat(
  sessionId: string,
  text: string,
): Promise<{ id: string | null; parts?: SteerClientPart[] }> {
  return steerWithParts(sessionId, [{ type: 'text', text }]);
}


export async function steerVisualPick(sessionId: string, steerText: string): Promise<void> {
  await steerChat(sessionId, steerText);
}


export type SteerFailure = { id: null; reason: 'not_streaming' | 'error'; detail?: string };


export type SteerClientPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };


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
  
  id?: string;
  ok?: boolean;
}


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
