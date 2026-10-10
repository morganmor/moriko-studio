/**
 * AddonApi factory — creates the `$` context each addon receives in register().
 *
 * The API surface mirrors Claude Code Mods ($ namespace) and Deepseek Harness
 * (ctx.tools.register). Each addon gets its own scoped instance.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  registerAddonTool,
  registerAddonCommand,
  registerAddonWidget,
  getAddonStore,
  getAddonToolHandler,
  listAddonCommands,
  addContextProvider,
  removeContextProvider,
} from './registry.js';
import { publishBusEvent, subscribeBusTopic } from './bus.js';
import { getActiveWorkspace } from '../agents/workspace.js';
import type { AddonApi, AddonToolRegistration, AddonCommandRegistration } from './types.js';
import type { HarnessToolResult } from '../agents/tools/shared.js';

export function createAddonApi(addonId: string, workspacePath: string): AddonApi {
  return {
    tool: {
      register(def: AddonToolRegistration) {
        registerAddonTool(addonId, def.name, def.description, def.inputSchema, async (args) => {
          return def.execute(args);
        });
      },
      async call(wireName: string, args: Record<string, unknown>): Promise<HarnessToolResult> {
        const handler = getAddonToolHandler(wireName);
        if (!handler) return { ok: false, isError: true, text: `Tool ${wireName} not found` };
        return handler(args, { workspacePath });
      },
    },
    command: {
      register(def: AddonCommandRegistration) {
        registerAddonCommand(addonId, def);
      },
      async run(name: string, args: string): Promise<string> {
        const cmd = listAddonCommands().find((c) => c.name === name);
        if (!cmd) return `Command ${name} not found`;
        return `Command ${name} executed with args: ${args}`;
      },
    },
    ui: {
      draw(site: string, element: import('./types.js').AddonElement) {
        if (element && element.type === 'widget') {
          registerAddonWidget(addonId, site as import('./types.js').RenderSite, element.component);
        }
      },
      invalidate() {  },
      log(text: string) {
        try { console.log(`[addon:${addonId}] ${text}`); } catch {  }
      },
      toast(text: string, kind?: 'info' | 'warn' | 'error') {
        try { console.log(`[addon:${addonId}] toast ${kind ?? 'info'}: ${text}`); } catch {  }
      },
    },
    store: {
      get(key: string): string | null {
        const store = getAddonStore(addonId);
        return store.get(key) ?? null;
      },
      set(key: string, value: string) {
        getAddonStore(addonId).set(key, value);
      },
      delete(key: string) {
        getAddonStore(addonId).delete(key);
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
        try { return readFileSync(path.resolve(workspacePath, filePath), 'utf-8'); }
        catch { return ''; }
      },
      write(filePath: string, content: string): void {
        try { writeFileSync(path.resolve(workspacePath, filePath), content, 'utf-8'); }
        catch {  }
      },
      list(dir: string): string[] {
        try { return readdirSync(path.resolve(workspacePath, dir)); }
        catch { return []; }
      },
    },
    workspace: {
      root(): string | null {
        try {
          const workspace = getActiveWorkspace();
          return workspace?.path ?? null;
        } catch {
          return null;
        }
      },
      read(filePath: string): string {
        try {
          const root = getActiveWorkspace()?.path;
          if (!root) return '';
          const abs = path.resolve(root, filePath);
          if (!abs.startsWith(path.resolve(root))) return '';
          return readFileSync(abs, 'utf-8');
        } catch { return ''; }
      },
      write(filePath: string, content: string): void {
        try {
          const root = getActiveWorkspace()?.path;
          if (!root) return;
          const abs = path.resolve(root, filePath);
          if (!abs.startsWith(path.resolve(root))) return;
          writeFileSync(abs, content, 'utf-8');
        } catch {  }
      },
      list(dir: string): string[] {
        try {
          const root = getActiveWorkspace()?.path;
          if (!root) return [];
          const abs = path.resolve(root, dir);
          if (!abs.startsWith(path.resolve(root))) return [];
          return readdirSync(abs);
        } catch { return []; }
      },
      exists(filePath: string): boolean {
        try {
          const root = getActiveWorkspace()?.path;
          if (!root) return false;
          const abs = path.resolve(root, filePath);
          return abs.startsWith(path.resolve(root)) && existsSync(abs);
        } catch { return false; }
      },
    },
    bus: {
      async publish(topic: string, payload: Record<string, unknown>): Promise<void> {
        await publishBusEvent(topic, payload, addonId);
      },
      subscribe(topic: string, handler: (message: import('./types.js').AddonBusPayload) => void | Promise<void>): () => void {
        return subscribeBusTopic(addonId, topic, handler);
      },
    },
    context: {
      provide(title: string, lines: string[]): void {
        addContextProvider({ addonId, title, lines });
      },
      revoke(title: string): void {
        removeContextProvider(title);
      },
    },
    clock: {
      every(ms: number, fn: () => void): () => void {
        const id = setInterval(() => { try { fn(); } catch {  } }, ms);
        return () => clearInterval(id);
      },
      after(ms: number, fn: () => void): () => void {
        const id = setTimeout(() => { try { fn(); } catch {  } }, ms);
        return () => clearTimeout(id);
      },
      async sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
    },
    session: {
      conversationId: '',
      workspacePath,
    },
  };
}
