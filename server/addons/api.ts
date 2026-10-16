/**
 * AddonApi factory — the `$` context each addon receives in register()/activate().
 *
 * ADDON v2 (A1):
 *  - createAddonApi(addonId, opts) — the facade binds to the ADDON's identity,
 *    so store/bus/context writes made from ITS hooks are attributed to it (A-03).
 *  - tool.register passes the full ctx through to execute (A-01).
 *  - fs is jailed to the addon root (A-10); workspace uses the session's
 *    workspace + isInside checks (A-11) + vault/audit on write (A-12).
 *  - ui.toast/notify publish SSE frames; ui.invalidate is real (A-13).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  registerAddonTool,
  registerAddonCommand,
  registerAddonWidget,
  registerAddonHook,
  getAddonToolHandler,
  getAddonCommand,
  addContextProvider,
  listAddonToolDefs,
} from './registry.js';
import { storeGet, storeSet, storeDelete } from './storage.js';
import { addonLog, tailAddonLogs } from './logbuffer.js';
import { notifyAddon, invalidateAddonView } from './notify.js';
import { publishBusEvent, subscribeBusTopic } from './bus.js';
import { getActiveWorkspace, listWorkspaces } from '../agents/workspace.js';
import { listSessions, getSession, onSessionChange } from '../agents/sessionRegistry.js';
import { listLiveStreams, abortStream } from '../streamRegistry.js';
import { injectMessage, emitHarnessEvent } from './inject.js';
import { startServerRun } from '../serverRun.js';
import { listStoredConversationSummaries } from '../conversationStore.js';
import { touchedPaths } from '../agents/touchedPaths.js';
import { registerPromptFragment } from './promptFragments.js';
import { getSetting, setSetting, onSettingsChange } from './settings.js';
import { registerRpcHandler } from './rpc.js';
import { setStatus } from './contributions.js';
import { exposeModApi, useModApi } from './modapi.js';
import { getAddonScope } from './disposables.js';
import type { AddonApi, AddonToolRegistration, AddonCommandRegistration, AddonToolCtx, AddonActor } from './types.js';
import type { HarnessToolResult } from '../agents/tools/shared.js';

export interface AddonApiOptions {
  /** The addon root dir — `$.fs` is jailed to this (A-10). */
  addonDir?: string;
}

/** isInside: containment via path.relative, never startsWith (A-11). */
function isInside(root: string, abs: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function jailResolve(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  return isInside(root, abs) ? abs : null;
}

/** The actor bound into tool ctx when a session runs the tool. */
function actorFromCtx(ctx: { sessionId?: string; modelId?: string }): AddonActor {
  return { kind: 'agent', sessionId: ctx.sessionId, model: ctx.modelId };
}

export function createAddonApi(addonId: string, opts: AddonApiOptions | string = {}): AddonApi {
  const addonDir = typeof opts === 'string' ? opts : opts.addonDir;

  const workspaceOf = (sessionId?: string) => {
    try {
      return getActiveWorkspace(sessionId) ?? getActiveWorkspace();
    } catch {
      return undefined;
    }
  };

  const writeWorkspaceFile = async (abs: string, content: string): Promise<void> => {
    try {
      const { snapshotFile } = await import('../agents/vault.js');
      if (existsSync(abs)) snapshotFile(undefined, abs, `addon:${addonId}:write`);
    } catch {
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    try {
      const { recordAfterWrite } = await import('../agents/read-policy.js');
      recordAfterWrite(undefined, abs, content, statSync(abs).mtimeMs);
    } catch {
    }
  };

  const api: AddonApi = {
    tool: {
      register(def: AddonToolRegistration) {
        registerAddonTool(addonId, def.name, def.description, def.inputSchema, async (args, ctx) => {
          const callCtx: AddonToolCtx = {
            sessionId: ctx?.sessionId,
            conversationId: (ctx as { conversationId?: string } | undefined)?.conversationId,
            workspacePath: workspaceOf(ctx?.sessionId)?.path,
            signal: ctx?.signal,
            modelId: (ctx as { modelId?: string } | undefined)?.modelId,
            actor: actorFromCtx({ sessionId: ctx?.sessionId, modelId: (ctx as { modelId?: string } | undefined)?.modelId }),
          };
          return def.execute(args, callCtx);
        }, def.readOnly);
      },
      async call(wireName: string, args: Record<string, unknown>): Promise<HarnessToolResult> {
        const handler = getAddonToolHandler(wireName);
        if (!handler) return { ok: false, isError: true, text: `Tool ${wireName} not found` };
        return handler(args, { workspacePath: workspaceOf()?.path });
      },
    },
    command: {
      register(def: AddonCommandRegistration) {
        registerAddonCommand(addonId, def);
      },
      async run(name: string, args: string): Promise<string> {
        const cmd = getAddonCommand(name);
        if (!cmd) return `Command ${name} not found`;
        if (cmd.run) {
          const out = await cmd.run(args, { actor: { kind: 'system' } });
          return out.text;
        }
        return `/${name} executed.`;
      },
    },
    ui: {
      draw(site: string, element: import('./types.js').AddonElement) {
        if (element && element.type === 'widget') {
          registerAddonWidget(addonId, site as import('./types.js').RenderSite, element.component);
        }
      },
      invalidate(site?: string) {
        invalidateAddonView(addonId, site);
      },
      log(text: string) {
        addonLog(addonId, 'info', text);
      },
      toast(text: string, kind?: 'info' | 'warn' | 'error') {
        addonLog(addonId, kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info', text);
        notifyAddon(addonId, { kind: kind ?? 'info', title: text });
      },
      /** v2 (R6): rich notification — achievement toasts with openView. */
      /** v2 (R6): rich notification — achievement toasts with openView. */
      notify(notification: import('./notify.js').AddonNotification) {
        addonLog(addonId, notification.kind === 'error' ? 'error' : 'info', notification.title);
        notifyAddon(addonId, notification);
      },
    },

    store: {
      get(key: string): string | null {
        return storeGet(addonId, key, 'global');
      },
      set(key: string, value: string) {
        storeSet(addonId, key, value, 'global');
      },
      delete(key: string) {
        storeDelete(addonId, key, 'global');
      },
    },
    http: {
      async fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
        try {
          const resp = await fetch(url, {
            method: init?.method ?? 'GET',
            headers: init?.headers,
            body: init?.body,
          });
          const text = await resp.text();
          return { ok: resp.ok, status: resp.status, text };
        } catch (error) {
          return { ok: false, status: 0, text: error instanceof Error ? error.message : 'fetch failed' };
        }
      },
    },
    fs: {
      read(filePath: string): string {
        if (!addonDir) return '';
        const abs = jailResolve(addonDir, filePath);
        if (!abs) return '';
        try { return readFileSync(abs, 'utf-8'); } catch { return ''; }
      },
      write(filePath: string, content: string): void {
        if (!addonDir) return;
        const abs = jailResolve(addonDir, filePath);
        if (!abs) return;
        mkdirSync(path.dirname(abs), { recursive: true });
        try { writeFileSync(abs, content, 'utf-8'); } catch {  }
      },
      list(dir: string): string[] {
        if (!addonDir) return [];
        const abs = jailResolve(addonDir, dir);
        if (!abs) return [];
        try { return readdirSync(abs); } catch { return []; }
      },
    },
    workspace: (() => {
      const handleFor = (sessionId?: string) => ({
        root(): string | null {
          return workspaceOf(sessionId)?.path ?? null;
        },
        read(filePath: string): string {
          const root = workspaceOf(sessionId)?.path;
          if (!root) return '';
          const abs = jailResolve(root, filePath);
          if (!abs) return '';
          try { return readFileSync(abs, 'utf-8'); } catch { return ''; }
        },
        write(filePath: string, content: string): Promise<void> {
          const root = workspaceOf(sessionId)?.path;
          if (!root) return Promise.resolve();
          const abs = jailResolve(root, filePath);
          if (!abs) return Promise.resolve();
          return writeWorkspaceFile(abs, content).catch((error: unknown) => {
            addonLog(addonId, 'error', `workspace.write(${filePath}) failed: ${error instanceof Error ? error.message : 'fs error'}`);
          });
        },
        list(dir: string): string[] {
          const root = workspaceOf(sessionId)?.path;
          if (!root) return [];
          const abs = jailResolve(root, dir);
          if (!abs) return [];
          try { return readdirSync(abs); } catch { return []; }
        },
        exists(filePath: string): boolean {
          const root = workspaceOf(sessionId)?.path;
          if (!root) return false;
          const abs = jailResolve(root, filePath);
          return Boolean(abs && existsSync(abs));
        },
      });
      const base = handleFor(undefined);
      const handleForPath = (root: string | null) => ({
        root(): string | null {
          return root;
        },
        read(filePath: string): string {
          if (!root) return '';
          const abs = jailResolve(root, filePath);
          if (!abs) return '';
          try { return readFileSync(abs, 'utf-8'); } catch { return ''; }
        },
        write(filePath: string, content: string): Promise<void> {
          if (!root) return Promise.resolve();
          const abs = jailResolve(root, filePath);
          if (!abs) return Promise.resolve();
          return writeWorkspaceFile(abs, content).catch((error: unknown) => {
            addonLog(addonId, 'error', `workspace.write(${filePath}) failed: ${error instanceof Error ? error.message : 'fs error'}`);
          });
        },
        list(dir: string): string[] {
          if (!root) return [];
          const abs = jailResolve(root, dir);
          if (!abs) return [];
          try { return readdirSync(abs); } catch { return []; }
        },
        exists(filePath: string): boolean {
          if (!root) return false;
          const abs = jailResolve(root, filePath);
          return Boolean(abs && existsSync(abs));
        },
      });
      return {
        ...base,
        forSession(sessionId?: string) {
          return sessionId ? handleFor(sessionId) : base;
        },
        /** Registered workspaces (id + label + path) for addon-side pickers. */
        listRegistered(): Array<{ id: string; label: string; path: string }> {
          try {
            return listWorkspaces().map((w) => ({ id: w.id, label: w.label, path: w.path }));
          } catch {
            return [];
          }
        },
        /** Bind to one registered workspace (by id or exact path). */
        forWorkspace(idOrPath: string) {
          let found: { path: string } | undefined;
          try {
            found = listWorkspaces().find((w) => w.id === idOrPath || w.path === idOrPath);
          } catch {  }
          return handleForPath(found?.path ?? null);
        },
        forPath(root: string | null) {
          return handleForPath(root ?? null);
        },
      };
    })(),
    bus: {
      async publish(topic: string, payload: Record<string, unknown>): Promise<void> {
        await publishBusEvent(topic, payload, addonId);
      },
      subscribe(topic: string, handler: (message: import('./types.js').AddonBusPayload) => void | Promise<void>): () => void {
        return subscribeBusTopic(addonId, topic, handler);
      },
    },
    events: {
      /** HARNESS-EVENT: persist an addon event as a `kind: 'harness-event'`
       *  turn in THIS conversation only (never broadcast), plus a live bus
       *  frame ('harness:event') for open clients. Separate channel — not a
       *  user message, not a harness injection. */
      emit(conversationId: string, msg: { text: string; level?: 'info' | 'warn' | 'block'; key?: string }): { ok: boolean; error?: string } {
        return emitHarnessEvent(conversationId, { ...msg, addonId });
      },
    },
    context: {      provide(title: string, lines: string[]): void {
        addContextProvider({ addonId, title, lines });
      },
      revoke(_title: string): void {
        // as a global key, which is exactly the bug we remove).
      },
    },
    clock: {
      every(ms: number, fn: () => void): () => void {
        const id = setInterval(() => { try { fn(); } catch {  } }, ms);
        getAddonScope(addonId).add(() => clearInterval(id));
        return () => clearInterval(id);
      },
      after(ms: number, fn: () => void): () => void {
        const id = setTimeout(() => { try { fn(); } catch {  } }, ms);
        getAddonScope(addonId).add(() => clearTimeout(id));
        return () => clearTimeout(id);
      },
      async sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
    },
    session: {
      conversationId: '',
      workspacePath: workspaceOf()?.path ?? '',
    },
    sessions: {
      list() {
        try {
          return listSessions();
        } catch {
          return [];
        }
      },
      get(sessionId: string) {
        try {
          return getSession(sessionId);
        } catch {
          return null;
        }
      },
      inject(target, msg) {
        return injectMessage(target, { ...msg, addonId });
      },
      /** Abort a running generation for one conversation (or session id).
       * Resolves conversationId → live stream id via the stream registry; falls
       * back to treating target as a raw stream id. Returns false when no live
       * stream matched (nothing to stop). Used by the council orchestrator's
       * council_stop tool to halt a sub-agent mid-response. */
      abort(target: string): boolean {
        try {
          const live = listLiveStreams();
          const byConv = live.find((s) => s.conversationId === target);
          if (byConv) return abortStream(byConv.id);
          return abortStream(target);
        } catch {
          return false;
        }
      },
      /** Live streams (conversationId + streamId + timing) — read-only mirror
       * of the host stream registry; lets an orchestrator check what is running
       * before issuing a stop. */
      live(): Array<{ id: string; conversationId: string | null; startedAt: number; lastFrameAt: number }> {
        try {
          return listLiveStreams();
        } catch {
          return [];
        }
      },
      /** Start a generation for a conversation SERVER-SIDE (council wake).
       *  Builds the run from the stored conversation and self-POSTs to the
       *  chat engine — no bus/SSE/browser hop, nothing to drop. */
      async startRun(conversationId: string, text: string, opts?: { providerId?: string; model?: string }) {
        try {
          return await startServerRun(conversationId, text, opts ?? {});
        } catch (error: unknown) {
          return { started: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
      /** Server-side conversation summaries (read-only) — council membership
       *  fallback: conversations already carry councilId/role/agentId. */
      listConversations(): Array<{ id: string; title: string; councilId?: string; councilRole?: string; councilAgentId?: string; providerId?: string; model?: string }> {
        try {
          return listStoredConversationSummaries();
        } catch {
          return [];
        }
      },
      onChange(fn) {
        return onSessionChange(fn);
      },
    },
    fsWatch: {
      onChange(fn) {
        const reg = registerAddonHook(addonId, 'fs.change' as never, null, async (_api: unknown, event: unknown) => {
          fn(event as Record<string, unknown>);
          return {};
        });
        getAddonScope(addonId).track(reg);
        return () => reg.dispose();
      },
    },
    harness: {
      touchedPaths(tool: string, args: Record<string, unknown>) {
        return touchedPaths(tool, args);
      },
    },
    prompt: {
      fragment(def: { id: string; order?: number; budgetChars?: number; when?: (ctx: { sessionId?: string; workspacePath?: string }) => boolean; build: (ctx: { sessionId?: string; workspacePath?: string }) => string[] | Promise<string[]> }): () => void {
        return registerPromptFragment({
          addonId,
          id: def.id,
          order: def.order ?? 50,
          budgetChars: def.budgetChars ?? 1200,
          when: def.when,
          build: def.build,
        });
      },
    },
    settings: {
      get<T>(key: string): T {
        return getSetting(addonId, key, workspaceOf()?.path) as T;
      },
      set(key: string, value: unknown): void {
        setSetting(addonId, key, value, workspaceOf()?.path);
      },
      onChange(fn: (key: string, value: unknown) => void): () => void {
        return onSettingsChange((key, value, owner) => {
          if (owner === addonId) fn(key, value);
        });
      },
    },
    rpc: {
      handle(name: string, handler: (body: Record<string, unknown>, ctx: { actor: { kind: 'user' } }) => unknown | Promise<unknown>): () => void {
        return registerRpcHandler(addonId, name, handler);
      },
    },
    status: {
      set(patch: { id: string; text?: string; tone?: 'ok' | 'warn' | 'danger' | 'info' | 'muted'; progress?: number; badge?: number; pulse?: boolean }): void {
        setStatus(addonId, patch);
      },
    },
    storage: {
      global: {
        get(key: string): string | null { return storeGet(addonId, key, 'global'); },
        set(key: string, value: string): void { storeSet(addonId, key, value, 'global'); },
        delete(key: string): void { storeDelete(addonId, key, 'global'); },
      },
      workspace(sessionId?: string) {
        const root = workspaceOf(sessionId)?.path;
        return {
          get(key: string): string | null { return root ? storeGet(addonId, key, 'workspace', root) : null; },
          set(key: string, value: string): void {
            if (!root) throw new Error('No active workspace for workspace-scoped storage');
            storeSet(addonId, key, value, 'workspace', root);
          },
          delete(key: string): void { if (root) storeDelete(addonId, key, 'workspace', root); },
        };
      },
    },
    api: {
      expose(name: string, impl: object): () => void {
        return exposeModApi(addonId, name, impl);
      },
      use<T>(ownerAddonId: string): T | null {
        return useModApi(ownerAddonId) as T | null;
      },
    },
  };
  return api;
}

/** Harness-side helper list (used by routes/tooling, not by addons). */
export function addonToolCount(_addonId: string): number {
  return listAddonToolDefs().length;
}

export { tailAddonLogs };
