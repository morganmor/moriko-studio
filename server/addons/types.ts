

import type { HarnessToolResult } from '../agents/tools/shared.js';
import type { Disposable } from './disposables.js';


export interface AddonManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  enabled?: boolean;
  
  icon?: string;
}

export interface LoadedAddon {
  manifest: AddonManifest;
  dir: string;
  enabled: boolean;
  loadError: string | null;
  
  status?: AddonStatus;
  
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


export interface AddonBusPayload {
  
  id?: number;
  topic: string;
  payload: Record<string, unknown>;
  addonId: string;
  ts: number;
}


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
  
  execute: (args: Record<string, unknown>, ctx?: AddonToolCtx) => Promise<HarnessToolResult>;
  
  readOnly?: boolean;
}

export interface AddonCommandRegistration {
  name: string;
  description: string;
  argumentHint?: string;
  immediate?: boolean;
  
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
  
  workspace: {
    root(): string | null;
    read(path: string): string;
    write(path: string, content: string): Promise<void>;
    list(dir: string): string[];
    exists(path: string): boolean;
    
    forSession(sessionId?: string): {
      root(): string | null;
      read(path: string): string;
      write(path: string, content: string): Promise<void>;
      list(dir: string): string[];
      exists(path: string): boolean;
    };
  };
  
  bus: {
    publish(topic: string, payload: Record<string, unknown>): Promise<void>;
    subscribe(topic: string, handler: (message: AddonBusPayload) => void | Promise<void>): () => void;
  };
  
  events: {
    emit(conversationId: string, msg: { text: string; level?: 'info' | 'warn' | 'block'; key?: string }): { ok: boolean; error?: string };
  };
  
  context: {
    provide(title: string, lines: string[]): void;
    revoke(title: string): void;
  };
  
  clock: {
    every(ms: number, fn: () => void): () => void;
    after(ms: number, fn: () => void): () => void;
    sleep(ms: number): Promise<void>;
  };
  session: {
    conversationId: string;
    workspacePath: string;
  };
  
  sessions: {
    list(): Array<{ sessionId: string; conversationId?: string; workspacePath?: string; model?: string; startedAt: number; lastActive: number }>;
    get(sessionId: string): { sessionId: string; lastActive: number } | null;
    inject(target: string | string[] | 'all-active', msg: { text: string; level?: 'info' | 'warn' | 'block'; key?: string; ttlMs?: number }): { delivered: number; queued: number; sessions: string[] };
    
    abort(target: string): boolean;
    
    live(): Array<{ id: string; conversationId: string | null; startedAt: number; lastFrameAt: number }>;
    
    startRun(conversationId: string, text: string, opts?: { providerId?: string; model?: string }): Promise<{ started: boolean; error?: string }>;
    
    listConversations(): Array<{ id: string; title: string; councilId?: string; councilRole?: string; councilAgentId?: string; providerId?: string; model?: string }>;
    onChange(fn: (change: { kind: string; sessionId?: string }) => void): () => void;
  };
  
  fsWatch: {
    onChange(fn: (event: Record<string, unknown>) => void): () => void;
  };
  
  harness: {
    touchedPaths(tool: string, args: Record<string, unknown>): Array<{ path?: string; from?: string; to?: string; unknown: boolean }>;
    
    measureHtml(html: string, viewports: Array<{ name: string; width: number; height: number }>): Promise<unknown>;
  };
  
  prompt: {
    fragment(def: {
      id: string;
      order?: number;
      budgetChars?: number;
      when?: (ctx: { sessionId?: string; workspacePath?: string }) => boolean;
      build: (ctx: { sessionId?: string; workspacePath?: string }) => string[] | Promise<string[]>;
    }): () => void;
  };
  
  settings: {
    get<T>(key: string): T;
    set(key: string, value: unknown): void;
    onChange(fn: (key: string, value: unknown) => void): () => void;
  };
  
  rpc: {
    handle(name: string, handler: (body: Record<string, unknown>, ctx: { actor: { kind: 'user' } }) => unknown | Promise<unknown>): () => void;
  };
  
  status: {
    set(patch: { id: string; text?: string; tone?: 'ok' | 'warn' | 'danger' | 'info' | 'muted'; progress?: number; badge?: number; pulse?: boolean }): void;
  };
  
  storage: {
    global: { get(key: string): string | null; set(key: string, value: string): void; delete(key: string): void };
    workspace(sessionId?: string): { get(key: string): string | null; set(key: string, value: string): void; delete(key: string): void };
  };
  
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
  
  loadError: string | null;
  
  status?: import('./types.js').AddonStatus;
  apiVersion?: '1' | '2';
  shortName?: string;
  kind?: string;
  
  icon?: string;
  
  permissions?: string[];
  
  builtin?: boolean;
  
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



export interface AddonToolCtx {
  sessionId?: string;
  conversationId?: string;
  workspacePath?: string;
  signal?: AbortSignal;
  modelId?: string;
  
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
