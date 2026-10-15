/**
 * Addon registry — loaded addons + their tools, commands, event hooks,
 * widgets and context providers.
 *
 * listAgentToolDefs() in catalogue.ts merges builtin + addon defs.
 * callAgentTool in dispatcher.ts checks here after its switch default.
 * The event bus walks registered hooks for each event.
 *
 * ADDON v2 (A1): every register* returns a Disposable tracked in the addon's
 * Scope (auto-disposed on unregister); the persistent store lives in
 * storage.ts (A-05); context providers are keyed (addonId, title) (A-09).
 */

import type { AgentToolDef } from '../agents/tools/shared.js';
import type { Disposable } from './disposables.js';
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
import { getAddonScope, disposeAddonScope } from './disposables.js';
import { flushAddonStores, flushAllStores } from './storage.js';
import { clearAddonLogs } from './logbuffer.js';
import { unregisterContributions } from './contributions.js';

interface RegisteredTool {
  addonId: string;
  wireName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: AddonToolHandler;
  /** v2 parallel-safety (feeds the loop's isParallelSafe). */
  readOnly?: boolean;
}

interface RegisteredCommand {
  addonId: string;
  name: string;
  description: string;
  argumentHint?: string;
  immediate?: boolean;
  run?: AddonCommandRegistration['run'];
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


export function registerAddon(id: string, addon: LoadedAddon): void {
  addons.set(id, addon);
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
  // v2: dispose scoped hooks/timers/listeners (A-08). The PERSISTENT store
  // survives reloads (A-05) — only flush pending writes.
  disposeAddonScope(id);
  try { flushAddonStores(id); } catch { /* best-effort */ }
  clearAddonLogs(id);
  addons.delete(id);
  try { unregisterContributions(id); } catch { /* best-effort */ }
}

export function getAddon(id: string): LoadedAddon | undefined { return addons.get(id); }

/** Deterministic order (by id) — a toggle unregister/re-register must never
 *  reshuffle the list the user sees. */
export function listAddons(): LoadedAddon[] {
  return [...addons.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}


export function registerAddonTool(
  addonId: string,
  wireName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: AddonToolHandler,
  readOnly?: boolean,
): Disposable {
  const full = wireName.startsWith('agent__') ? wireName : `agent__${addonId}_${wireName}`;
  tools.set(full, { addonId, wireName: full, description: `[${addonId}] ${description}`, inputSchema, handler, readOnly });
  return getAddonScope(addonId).add(() => tools.delete(full));
}

export function listAddonToolDefs(): AgentToolDef[] {
  return [...tools.values()].map(({ wireName, description, inputSchema }) => ({
    wireName, description, inputSchema,
  }));
}

export function getAddonToolHandler(wireName: string): AddonToolHandler | undefined {
  return tools.get(wireName)?.handler;
}

/** v2: parallel-safety flag for an addon tool (undefined = not an addon tool). */
export function addonToolReadOnly(wireName: string): boolean | undefined {
  return tools.get(wireName)?.readOnly;
}

/** Which addon owns this wireName (v2 — replaces the fragile `includes` test, A-20). */
export function addonIdOfTool(wireName: string): string | undefined {
  return tools.get(wireName)?.addonId;
}

export function isAddonTool(wireName: string): boolean { return tools.has(wireName); }


export function registerAddonCommand(addonId: string, def: AddonCommandRegistration): Disposable {
  if (commands.has(def.name)) {
    throw new Error(`Addon command "/${def.name}" is already registered`);
  }
  commands.set(def.name, { addonId, ...def });
  return getAddonScope(addonId).add(() => commands.delete(def.name));
}

export function listAddonCommands(): RegisteredCommand[] { return [...commands.values()]; }

export function getAddonCommand(name: string): RegisteredCommand | undefined { return commands.get(name); }


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
  const dispose = getAddonScope(addonId).add(() => {
    const index = hooks.indexOf(entry);
    if (index >= 0) hooks.splice(index, 1);
  });
  return {
    catch(errorHandler: (error: Error) => void) {
      entry.errorHandler = errorHandler;
    },
    dispose() {
      dispose.dispose();
    },
  };
}

/** How many hooks are registered (for emit disarm decisions + diagnostics). */
export function addonHookCount(): number {
  return hooks.length;
}

/** Walk hooks for an event in order — middleware chain with next().
 *  v2 (A-03): each hook receives an API facade bound to ITS OWN addon, so
 *  store/bus/context writes are attributed to the hook's owner, not the
 *  harness. Facades are cached per addon id. */
export async function emitAddonEvent(
  event: AddonEvent,
  payload: unknown,
  api: AddonApi,
): Promise<{ deny?: string; text?: string; element?: AddonElement; result?: unknown }> {
  const matching = hooks.filter((h) => h.event === event && matchEvent(h.matcher, event, payload));
  if (matching.length === 0) return {};

  const { createAddonApi } = await import('./api.js');
  const apiFor = new Map<string, AddonApi>();
  const facadeFor = (addonId: string): AddonApi => {
    if (addonId === '__harness__') return api;
    let facade = apiFor.get(addonId);
    if (!facade) {
      const addon = addons.get(addonId);
      facade = createAddonApi(addonId, { addonDir: addon?.dir });
      apiFor.set(addonId, facade);
    }
    return facade;
  };

  let chainIndex = 0;
  const next = async (e: unknown): Promise<{ deny?: string; text?: string; element?: AddonElement; result?: unknown }> => {
    if (chainIndex >= matching.length) return {};
    const hook = matching[chainIndex++];
    try {
      return await hook.handler(facadeFor(hook.addonId), e as never, next as never);
    } catch (error) {
      if (hook.errorHandler) {
        try { hook.errorHandler(error as Error); } catch {  }
      }
      return {};
    }
  };
  return next(payload);
}


export function registerAddonWidget(addonId: string, site: RenderSite, component: string, label?: string): Disposable {
  if (!widgets.has(addonId)) widgets.set(addonId, []);
  const entry: RegisteredWidget = { addonId, site, component, label };
  widgets.get(addonId)!.push(entry);
  return getAddonScope(addonId).add(() => {
    const list = widgets.get(addonId);
    if (!list) return;
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  });
}

export function listAddonWidgets(site?: RenderSite): RegisteredWidget[] {
  const all = [...widgets.values()].flat();
  return site ? all.filter((w) => w.site === site) : all;
}


const contextProviders = new Map<string, AddonContextProvider>();

/** Register a context provider. v2 (A-09): keyed (addonId, title) so two addons
 *  with the same title never clobber each other; disposal is automatic. */
export function addContextProvider(provider: AddonContextProvider): Disposable {
  const key = `${provider.addonId}\u0000${provider.title}`;
  contextProviders.set(key, provider);
  return getAddonScope(provider.addonId).add(() => contextProviders.delete(key));
}

export function removeContextProvider(title: string): void {
  // Legacy surface: v1 addons/revoke call sites had no addon identity — remove
  // by title across owners ONLY for providers they own; the per-addon facade
  // (api.ts) never calls this anymore.
  for (const key of [...contextProviders.keys()]) {
    if (key.endsWith(`\u0000${title}`) || key === title) contextProviders.delete(key);
  }
}

export function listContextProviders(): AddonContextProvider[] {
  return [...contextProviders.values()];
}


export function clearAllAddons(): void {
  for (const id of [...addons.keys()]) disposeAddonScope(id);
  try { flushAllStores(); } catch { /* best-effort */ }
  tools.clear();
  commands.clear();
  hooks.length = 0;
  widgets.clear();
  contextProviders.clear();
  addons.clear();
}
