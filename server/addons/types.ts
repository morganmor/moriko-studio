/**
 * Addon system types — manifest, event system, API surface, render sites.
 *
 * Redesain berdasarkan Claude Code Mods (register/on/middleware) dan
 * Deepseek Harness (ctx.tools.register/defineTool/pipeline hooks).
 */

import type { HarnessToolResult } from '../agents/tools/shared.js';


export interface AddonManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  enabled?: boolean;
}

export interface LoadedAddon {
  manifest: AddonManifest;
  dir: string;
  enabled: boolean;
  loadError: string | null;
}


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
}

export interface ToolResultEvent {
  tool: string;
  result: HarnessToolResult;
  sessionId?: string;
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
}

export type AddonEventRegistrar = (
  event: AddonEvent,
  matcherOrHandler: AddonMatcher | AddonHook,
  handler?: AddonHook,
) => AddonRegistration;


export interface AddonToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<HarnessToolResult>;
}

export interface AddonCommandRegistration {
  name: string;
  description: string;
  argumentHint?: string;
  immediate?: boolean;
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
  /** Read/write access to the ACTIVE workspace root (not the addon root) —
   *  the "core PR" capability RS-PRD needs: PRD.json lives in the project. */
  workspace: {
    root(): string | null;
    read(path: string): string;
    write(path: string, content: string): void;
    list(dir: string): string[];
    exists(path: string): boolean;
  };
  /** Cross-session pub/sub + client push. publish() reaches every other
   *  addon's subscriber AND every connected browser via SSE. */
  bus: {
    publish(topic: string, payload: Record<string, unknown>): Promise<void>;
    subscribe(topic: string, handler: (message: AddonBusPayload) => void | Promise<void>): () => void;
  };
  /** Contribute context to the SYSTEM PROMPT of every session (agent mode).
   *  Used by RS-PRD to tell other agents "Achievement 003 is claimed by A". */
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
  enabled: boolean;
  /** Non-null when register.ts failed to load or had no register export. */
  loadError: string | null;
  hasTools: boolean;
  hasWidgets: boolean;
  widgets: Array<{ site: RenderSite; component: string; label?: string }>;
  commands: Array<{ name: string; description: string; argumentHint?: string }>;
}


export type AddonRegisterFn = (
  on: AddonEventRegistrar,
  api: AddonApi,
) => void | Promise<void>;


export type AddonToolHandler = (
  args: Record<string, unknown>,
  ctx: { signal?: AbortSignal; workspacePath?: string },
) => Promise<HarnessToolResult>;
