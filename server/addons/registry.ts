/**
 * Addon registry — in-memory map of loaded addons, their tools, commands,
 * event hooks, and widgets.
 *
 * listAgentToolDefs() in catalogue.ts merges builtin + addon defs.
 * callAgentTool in dispatcher.ts checks here after its switch default.
 * The event bus walks registered hooks for each event.
 */

import type { AgentToolDef } from '../agents/tools/shared.js';
import type {
  LoadedAddon,
  AddonToolHandler,
  AddonEvent,
  AddonMatcher,
  AddonHook,
  AddonRegistration,
  AddonCommandRegistration,
  AddonElement,
  RenderSite,
  AddonApi,
  AddonContextProvider,
} from './types.js';

interface RegisteredTool {
  addonId: string;
  wireName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: AddonToolHandler;
}

interface RegisteredCommand {
  addonId: string;
  name: string;
  description: string;
  argumentHint?: string;
  immediate?: boolean;
}

interface RegisteredHook {
  addonId: string;
  event: AddonEvent;
  matcher: AddonMatcher | null;
  handler: AddonHook;
  errorHandler: ((error: Error) => void) | null;
}

interface RegisteredWidget {
  addonId: string;
  site: RenderSite;
  component: string;
  label?: string;
}

const tools = new Map<string, RegisteredTool>();
const commands = new Map<string, RegisteredCommand>();
const hooks: RegisteredHook[] = [];
const widgets = new Map<string, RegisteredWidget[]>();
const addons = new Map<string, LoadedAddon>();

// Per-addon KV store
const stores = new Map<string, Map<string, string>>();

// ─── Addon lifecycle ────────────────────────────────────────────────────────

export function registerAddon(id: string, addon: LoadedAddon): void {
  addons.set(id, addon);
  if (!stores.has(id)) stores.set(id, new Map());
}

export function unregisterAddon(id: string): void {
  for (const [wireName, entry] of tools) {
    if (entry.addonId === id) tools.delete(wireName);
  }
  for (const [name, cmd] of commands) {
    if (cmd.addonId === id) commands.delete(name);
  }
  for (let i = hooks.length - 1; i >= 0; i--) {
    if (hooks[i].addonId === id) hooks.splice(i, 1);
  }
  widgets.delete(id);
  stores.delete(id);
  addons.delete(id);
}

export function getAddon(id: string): LoadedAddon | undefined { return addons.get(id); }

/** Deterministic order (by id) — a toggle unregister/re-register must never
 *  reshuffle the list the user sees. */
export function listAddons(): LoadedAddon[] {
  return [...addons.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

// ─── Tool registration ───────────────────────────────────────────────────────

export function registerAddonTool(
  addonId: string,
  wireName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: AddonToolHandler,
): void {
  const full = wireName.startsWith('agent__') ? wireName : `agent__${addonId}_${wireName}`;
  tools.set(full, { addonId, wireName: full, description: `[${addonId}] ${description}`, inputSchema, handler });
}

export function listAddonToolDefs(): AgentToolDef[] {
  return [...tools.values()].map(({ wireName, description, inputSchema }) => ({
    wireName, description, inputSchema,
  }));
}

export function getAddonToolHandler(wireName: string): AddonToolHandler | undefined {
  return tools.get(wireName)?.handler;
}

export function isAddonTool(wireName: string): boolean { return tools.has(wireName); }

// ─── Command registration ─────────────────────────────────────────────────────

export function registerAddonCommand(addonId: string, def: AddonCommandRegistration): void {
  commands.set(def.name, { addonId, ...def });
}

export function listAddonCommands(): RegisteredCommand[] { return [...commands.values()]; }

// ─── Event hook registration ──────────────────────────────────────────────────

function matchEvent(matcher: AddonMatcher | null, _event: AddonEvent, payload: unknown): boolean {
  if (!matcher) return true;
  const p = payload as Record<string, unknown>;
  if (matcher.tool) {
    const tool = (p as { tool?: string }).tool;
    if (!tool) return false;
    if (typeof matcher.tool === 'string') return tool === matcher.tool;
    if (Array.isArray(matcher.tool)) return matcher.tool.includes(tool);
    if (matcher.tool instanceof RegExp) return matcher.tool.test(tool);
  }
  if (matcher.command) {
    return (p as { command?: string }).command === matcher.command;
  }
  if (matcher.site) {
    return (p as { site?: string }).site === matcher.site;
  }
  return true;
}

export function registerAddonHook(
  addonId: string,
  event: AddonEvent,
  matcher: AddonMatcher | null,
  handler: AddonHook,
): AddonRegistration {
  const entry: RegisteredHook = { addonId, event, matcher, handler, errorHandler: null };
  hooks.push(entry);
  return {
    catch(errorHandler: (error: Error) => void) {
      entry.errorHandler = errorHandler;
    },
  };
}

/** Walk hooks for an event in order — middleware chain with next(). */
export async function emitAddonEvent(
  event: AddonEvent,
  payload: unknown,
  api: AddonApi,
): Promise<{ deny?: string; text?: string; element?: AddonElement; result?: unknown }> {
  const matching = hooks.filter((h) => h.event === event && matchEvent(h.matcher, event, payload));
  if (matching.length === 0) return {};

  let chainIndex = 0;
  const next = async (e: unknown): Promise<{ deny?: string; text?: string; element?: AddonElement; result?: unknown }> => {
    if (chainIndex >= matching.length) return {};
    const hook = matching[chainIndex++];
    try {
      return await hook.handler(api, e as never, next as never);
    } catch (error) {
      if (hook.errorHandler) {
        try { hook.errorHandler(error as Error); } catch { /* fail-closed */ }
      }
      return {};
    }
  };
  return next(payload);
}

// ─── Widget registration ─────────────────────────────────────────────────────

export function registerAddonWidget(addonId: string, site: RenderSite, component: string, label?: string): void {
  if (!widgets.has(addonId)) widgets.set(addonId, []);
  widgets.get(addonId)!.push({ addonId, site, component, label });
}

export function listAddonWidgets(site?: RenderSite): RegisteredWidget[] {
  const all = [...widgets.values()].flat();
  return site ? all.filter((w) => w.site === site) : all;
}

// ─── KV store ────────────────────────────────────────────────────────────────

export function getAddonStore(addonId: string): Map<string, string> {
  if (!stores.has(addonId)) stores.set(addonId, new Map());
  return stores.get(addonId)!;
}

// ─── Context providers (system-prompt contribution per addon) ────────────────

const contextProviders = new Map<string, AddonContextProvider>();

export function addContextProvider(provider: AddonContextProvider): void {
  contextProviders.set(provider.title, provider);
}

export function removeContextProvider(title: string): void {
  contextProviders.delete(title);
}

export function listContextProviders(): AddonContextProvider[] {
  return [...contextProviders.values()];
}

// ─── Clear all ───────────────────────────────────────────────────────────────

export function clearAllAddons(): void {
  tools.clear();
  commands.clear();
  hooks.length = 0;
  widgets.clear();
  stores.clear();
  contextProviders.clear();
  addons.clear();
}
