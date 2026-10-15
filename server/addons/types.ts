/**
 * Addon system types — manifest, event system, API surface, render sites.
 *
 * Redesain berdasarkan Claude Code Mods (register/on/middleware) dan
 * Deepseek Harness (ctx.tools.register/defineTool/pipeline hooks).
 */

import type { HarnessToolResult } from '../agents/tools/shared.js';
import type { Disposable } from './disposables.js';


export interface AddonManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  enabled?: boolean;
  /** Custom icon asset relative to the addon root (resources/icon.svg). */
  icon?: string;
}

export interface LoadedAddon {
  manifest: AddonManifest;
  dir: string;
  enabled: boolean;
  loadError: string | null;
  /** v2 lifecycle status (A2); legacy addons report 'active' when enabled. */
  status?: AddonStatus;
  /** '2' → v2 module (activate/deactivate); missing → v1 shim. */
  apiVersion?: '1' | '2';
}

export type AddonStatus =
  | 'installed'
  | 'invalid'
  | 'blocked'
  | 'needs-consent'
  | 'active'
  | 'error'
  | 'disabled';


export type AddonEvent =
  | 'tool.call'
  | 'tool.result'
  | 'turn.start'
  | 'turn.end'
  | 'session.open'
  | 'command.run'
  | 'ui.render';

/** A message on the cross-session bus (addon→addon, addon→browsers). */
export interface AddonBusPayload {
  /** v2 (A7): monotonic frame id — SSE `id:` line + reconnect replay key. */
  id?: number;
  topic: string;
  payload: Record<string, unknown>;
  addonId: string;
  ts: number;
}

/** One addon-contributed block in the system prompt of every session. */
export interface AddonContextProvider {
  addonId: string;
  title: string;
  lines: string[];
}

export interface AddonMatcher {
  tool?: string | string[] | RegExp;
  command?: string;
  site?: string;
}

export interface ToolCallEvent {
  tool: string;
  args: Record<string, unknown>;
  sessionId?: string;
  conversationId?: string;
}

export interface ToolResultEvent {
  tool: string;
  args: Record<string, unknown>;
  result: HarnessToolResult;
  sessionId?: string;
  conversationId?: string;
}

export interface TurnEvent {
  sessionId?: string;
  conversationId?: string;
}

export interface SessionEvent {
  conversationId: string;
  workspacePath: string;
}

export interface CommandRunEvent {
  command: string;
  args: string;
}

export interface UiRenderEvent {
  site: string;
  conversationId?: string;
}

export type AddonEventPayload =
  | ToolCallEvent
  | ToolResultEvent
  | TurnEvent
  | SessionEvent
  | CommandRunEvent
  | UiRenderEvent;

export interface AddonEventResult {
  deny?: string;
  text?: string;
  element?: AddonElement;
  result?: HarnessToolResult;
}

export type AddonNext = (e: AddonEventPayload) => Promise<AddonEventResult>;

export interface AddonHook {
  ($: AddonApi, e: AddonEventPayload, next: AddonNext): Promise<AddonEventResult>;
}

export interface AddonRegistration {
  catch(handler: (error: Error) => void): void;
  /** v2: remove the hook from the chain (auto-disposed with the addon). */
  dispose(): void;
}

export type AddonEventRegistrar = (
  event: AddonEvent,
  matcherOrHandler: AddonMatcher | AddonHook,
  handler?: AddonHook,
) => AddonRegistration & Disposable;


export interface AddonToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** v1: (args). v2: (args, ctx) — ctx carries sessionId/conversationId/
   *  signal/workspace/model so the tool knows WHO called it (A-01). */
  execute: (args: Record<string, unknown>, ctx?: AddonToolCtx) => Promise<HarnessToolResult>;
  /** v2: safe to run in parallel in the loop (feeds isParallelSafe). */
  readOnly?: boolean;
}

export interface AddonCommandRegistration {
  name: string;
  description: string;
  argumentHint?: string;
  immediate?: boolean;
  /** v2: direct run handler; when absent the addon is expected to answer the
   *  command.run hook chain (v1 behavior). Result may open a view. */
  run?: (args: string, ctx: AddonToolCtx) => (Promise<{ text: string; openView?: string }> | { text: string; openView?: string });
}

export interface AddonApi {
  tool: {
    register(def: AddonToolRegistration): void;
    call(wireName: string, args: Record<string, unknown>): Promise<HarnessToolResult>;
  };
  command: {
    register(def: AddonCommandRegistration): void;
    run(name: string, args: string): Promise<string>;
  };
  ui: {
    draw(site: string, element: AddonElement): void;
    invalidate(site?: string): void;
    log(text: string): void;
    toast(text: string, kind?: 'info' | 'warn' | 'error'): void;
    /** v2 (R6): rich notification frame (achievement toasts, openView). */
    notify(notification: { kind: 'info' | 'warn' | 'error' | 'achievement'; title: string; subtitle?: string; icon?: string; openView?: string; ttlMs?: number }): void;
  };
  store: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    delete(key: string): void;
  };
  http: {
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; text: string }>;
  };
  fs: {
    read(path: string): string;
    write(path: string, content: string): void;
    list(dir: string): string[];
  };
  /** Read/write access to a WORKSPACE (v2 resolves the session's workspace,
   *  not the harness cwd — A-12; writes are vault-snapshotted + audited).
   *  write resolves when the bytes are on disk (v2). */
  workspace: {
    root(): string | null;
    read(path: string): string;
    write(path: string, content: string): Promise<void>;
    list(dir: string): string[];
    exists(path: string): boolean;
    /** v2: resolve for a specific session's workspace (falls back to active). */
    forSession(sessionId?: string): {
      root(): string | null;
      read(path: string): string;
      write(path: string, content: string): Promise<void>;
      list(dir: string): string[];
      exists(path: string): boolean;
    };
  };
  /** Cross-session pub/sub + client push. publish() reaches every other
   *  addon's subscriber AND every connected browser via SSE. */
  bus: {
    publish(topic: string, payload: Record<string, unknown>): Promise<void>;
    subscribe(topic: string, handler: (message: AddonBusPayload) => void | Promise<void>): () => void;
  };
  /** Harness events: persist an addon event as a dedicated per-conversation
   *  turn (kind 'harness-event') + live bus frame. Never a user message. */
  events: {
    emit(conversationId: string, msg: { text: string; level?: 'info' | 'warn' | 'block'; key?: string }): { ok: boolean; error?: string };
  };
  /** Contribute context to the SYSTEM PROMPT of every session (agent mode).
   *  Used by RS-PRD to tell other agents "Achievement 003 is claimed by A". */
  context: {
    provide(title: string, lines: string[]): void;
    revoke(title: string): void;
  };
  /** v2 note: per-session prompt fragments are the context provider successor
   *  (registered from activate() via ctx.prompt.fragment — A3/A4). */
  clock: {
    every(ms: number, fn: () => void): () => void;
    after(ms: number, fn: () => void): () => void;
    sleep(ms: number): Promise<void>;
  };
  session: {
    conversationId: string;
    workspacePath: string;
  };
  /** v2 (A3): active agent sessions + injection. */
  sessions: {
    list(): Array<{ sessionId: string; conversationId?: string; workspacePath?: string; model?: string; startedAt: number; lastActive: number }>;
    get(sessionId: string): { sessionId: string; lastActive: number } | null;
    inject(target: string | string[] | 'all-active', msg: { text: string; level?: 'info' | 'warn' | 'block'; key?: string; ttlMs?: number }): { delivered: number; queued: number; sessions: string[] };
    /** Abort a running generation by conversationId (or raw stream id). */
    abort(target: string): boolean;
    /** Live streams: conversationId, streamId, timing. Read-only. */
    live(): Array<{ id: string; conversationId: string | null; startedAt: number; lastFrameAt: number }>;
    /** Start a generation for a conversation server-side (council wake). */
    startRun(conversationId: string, text: string, opts?: { providerId?: string; model?: string }): Promise<{ started: boolean; error?: string }>;
    /** Server-side conversation summaries (read-only; council membership fallback). */
    listConversations(): Array<{ id: string; title: string; councilId?: string; councilRole?: string; councilAgentId?: string; providerId?: string; model?: string }>;
    onChange(fn: (change: { kind: string; sessionId?: string }) => void): () => void;
  };
  /** v2 (A3): fs.change observation. */
  fsWatch: {
    onChange(fn: (event: Record<string, unknown>) => void): () => void;
  };
  /** v2 (A3): touched-path extraction (the guard's official helper). */
  harness: {
    touchedPaths(tool: string, args: Record<string, unknown>): Array<{ path?: string; from?: string; to?: string; unknown: boolean }>;
  };
  /** v2 (A4): per-session prompt fragments (budgeted, ordered). */
  prompt: {
    fragment(def: {
      id: string;
      order?: number;
      budgetChars?: number;
      when?: (ctx: { sessionId?: string; workspacePath?: string }) => boolean;
      build: (ctx: { sessionId?: string; workspacePath?: string }) => string[] | Promise<string[]>;
    }): () => void;
  };
  /** v2 (A4): schema-validated settings (user | workspace scope). */
  settings: {
    get<T>(key: string): T;
    set(key: string, value: unknown): void;
    onChange(fn: (key: string, value: unknown) => void): () => void;
  };
  /** v2 (A4): HTTP RPC handlers for the addon's own UI (actor = user). */
  rpc: {
    handle(name: string, handler: (body: Record<string, unknown>, ctx: { actor: { kind: 'user' } }) => unknown | Promise<unknown>): () => void;
  };
  /** v2 (A4): sidebar/status live items. */
  status: {
    set(patch: { id: string; text?: string; tone?: 'ok' | 'warn' | 'danger' | 'info' | 'muted'; progress?: number; badge?: number; pulse?: boolean }): void;
  };
  /** v2 (A4): scoped persistent KV (global + per-workspace). */
  storage: {
    global: { get(key: string): string | null; set(key: string, value: string): void; delete(key: string): void };
    workspace(sessionId?: string): { get(key: string): string | null; set(key: string, value: string): void; delete(key: string): void };
  };
  /** v2 (A4): mod-to-mod surface. */
  api: {
    expose(name: string, impl: object): () => void;
    use<T>(ownerAddonId: string): T | null;
  };
}


export type RenderSite = 'thread-sidebar' | 'composer-band' | 'right-dock' | 'floating' | 'tool-row' | 'spinner';

export interface AddonStyle {
  padding?: string;
  margin?: string;
  bg?: string;
  color?: string;
  border?: string;
  rounded?: string;
  width?: string;
}

export type AddonElement =
  | { type: 'widget'; component: string }
  | { type: 'text'; text: string; style?: AddonStyle }
  | { type: 'box'; children: AddonElement[]; style?: AddonStyle }
  | { type: 'button'; label: string; onClick: () => void; style?: AddonStyle }
  | { type: 'markdown'; text: string }
  | null;


export interface AddonClientEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  enabled: boolean;
  /** Non-null when register.ts failed to load or had no register export. */
  loadError: string | null;
  /** v2 lifecycle status (A2). */
  status?: import('./types.js').AddonStatus;
  apiVersion?: '1' | '2';
  shortName?: string;
  kind?: string;
  /** Manifest icon: asset path relative to the addon root (resources/icon.svg). */
  icon?: string;
  /** Permissions declared in the manifest (v2). */
  permissions?: string[];
  /** True when the addon is a builtin authored in addons-src/. */
  builtin?: boolean;
  /** Consent state (v2): granted/denied lists + trust. */
  permRecord?: { granted: string[]; denied: string[]; trust?: string };
  hasTools: boolean;
  hasWidgets: boolean;
  widgets: Array<{ site: RenderSite; component: string; label?: string }>;
  commands: Array<{ name: string; description: string; argumentHint?: string }>;
}


export type AddonRegisterFn = (
  on: AddonEventRegistrar,
  api: AddonApi,
) => void | Promise<void>;


/** Context every v2 tool execute() receives (A-01 fix). */
export interface AddonToolCtx {
  sessionId?: string;
  conversationId?: string;
  workspacePath?: string;
  signal?: AbortSignal;
  modelId?: string;
  /** Who invoked the tool: an agent session, or the user via an HTTP route. */
  actor: AddonActor;
}

export interface AddonActor {
  kind: 'user' | 'agent' | 'operator' | 'system';
  name?: string;
  sessionId?: string;
  model?: string;
}


export type AddonToolHandler = (
  args: Record<string, unknown>,
  ctx: { signal?: AbortSignal; workspacePath?: string; sessionId?: string; actor?: AddonActor },
) => Promise<HarnessToolResult>;
