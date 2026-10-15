/**
 * Addon loader — scans `~/.moriko-studio/addons/`, parses manifests,
 * dynamically imports the entry, and watches for hot-reload WITHOUT restart.
 *
 * ADDON v2 (A1):
 *  - Per-addon reload: the watcher maps the changed file to ONE addon id and
 *    reloads only that addon — other addons' tools/hooks/stores are untouched
 *    (closes A-06). `loadAllAddons` remains for boot / explicit "Reload all".
 *  - ESM cache-bust: entry imports carry `?v=<mtimeMs>` so edits actually run
 *    (spike A0-1: same-URL imports stay cached forever; closes A-07 for the
 *    entry file — relative imports inside the entry keep their old cache, a
 *    known limitation documented in the plan).
 *  - createAddonApi binds the addon's OWN dir ($ fs jail) and identity (A-03).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AddonManifest,
  LoadedAddon,
  AddonEvent,
  AddonMatcher,
  AddonHook,
  AddonRegistration,
  AddonRegisterFn,
} from './types.js';
import type { Disposable } from './disposables.js';
import {
  registerAddon,
  unregisterAddon,
  registerAddonHook,
  clearAllAddons,
} from './registry.js';
import { createAddonApi } from './api.js';
import { validateManifest } from './manifest.js';
import { consentSatisfied } from './permissions.js';
import { resolveGraph } from './graph.js';
import { registerContributions, unregisterContributions } from './contributions.js';
import { registerSettingsSchema } from './settings.js';
import { morikoHome } from '../paths.js';

const ADDONS_DIR = () => path.join(morikoHome, 'addons');

let watcher: ReturnType<typeof watch> | null = null;
let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
/** Pending addon ids from the watcher debounce window. */
const pendingReload = new Set<string>();

function parseManifest(dir: string): AddonManifest | null {
  const manifestPath = path.join(dir, 'addon.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as AddonManifest;
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Build the `on` registrar bound to one addon id. */
function createEventRegistrar(addonId: string) {
  return (
    event: AddonEvent,
    matcherOrHandler: AddonMatcher | AddonHook,
    handler?: AddonHook,
  ): AddonRegistration & Disposable => {
    const matcher = typeof matcherOrHandler === 'function' ? null : matcherOrHandler;
    const fn = typeof matcherOrHandler === 'function' ? matcherOrHandler : handler;
    if (!fn) return { catch() {}, dispose() {} };
    return registerAddonHook(addonId, event, matcher, fn);
  };
}

/** Map a changed file path back to its addon id (top-level folder name). */
function addonIdForPath(changed: string): string | null {
  const root = ADDONS_DIR();
  const abs = path.resolve(root, changed);
  if (!abs.startsWith(root + path.sep)) return null;
  const id = abs.slice(root.length + 1).split(path.sep)[0] ?? null;
  // Same rule as the scan: dot-dirs and seed backups are never addons.
  if (id && (id.startsWith('.') || id.includes('.bak'))) return null;
  return id;
}

/** v2 activation context — the successor of register(on, $). */
export interface AddonModuleV2 {
  activate(ctx: import('./types.js').AddonToolCtx & { api: import('./api.js').AddonApiOptions & Record<string, unknown> }): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

interface ActiveModule {
  addonId: string;
  module: Partial<AddonModuleV2>;
}

/** Loaded v2 activate()/deactivate() handles, keyed by addon id. */
const activeModules = new Map<string, ActiveModule>();

/** v2: call the module's deactivate() (best-effort, 3s budget is enforced by
 *  the caller) and forget it. */
export async function deactivateAddonModule(id: string): Promise<void> {
  const entry = activeModules.get(id);
  activeModules.delete(id);
  if (entry?.module.deactivate) {
    try {
      await entry.module.deactivate();
    } catch (error) {
      console.error(`[addons] deactivate() of "${id}" failed:`, error);
    }
  }
}

async function loadOneAddon(dir: string): Promise<LoadedAddon | null> {
  const rawManifest = parseManifest(dir);
  if (!rawManifest) return null;
  // v2 (A2): validate the manifest; invalid addons surface in the Hub with
  // per-field errors and never load.
  const validation = validateManifest(rawManifest);
  const manifest: AddonManifest = rawManifest;
  const loaded: LoadedAddon = {
    manifest,
    dir,
    enabled: manifest.enabled !== false,
    loadError: validation.ok ? null : validation.errors.join('; '),
    status: manifest.enabled !== false ? 'active' : 'disabled',
    apiVersion: validation.apiVersion ?? undefined,
  };
  if (!validation.ok) {
    loaded.status = 'invalid';
    return loaded;
  }
  if (!loaded.enabled) {
    loaded.status = 'disabled';
    return loaded;
  }

  // v2 permission consent (A2): an addon needing ungranted consent stays
  // "needs-consent" — code never runs until the user approves it.
  if (validation.apiVersion === '2') {
    const extra = manifest as unknown as Record<string, unknown>;
    const perms = Array.isArray(extra.permissions) ? extra.permissions as string[] : [];
    if (!consentSatisfied(manifest.id, perms)) {
      loaded.status = 'needs-consent';
      return loaded;
    }
  }

  // Entry resolution: v2 declares `main`; legacy falls back to register.ts|js.
  const mainRel = (manifest as unknown as Record<string, unknown>).main;
  const registerPath = path.join(dir, 'register.ts');
  const registerJsPath = path.join(dir, 'register.js');
  const mainPath = typeof mainRel === 'string' ? path.resolve(dir, mainRel) : null;
  const entryPath = mainPath && existsSync(mainPath)
    ? mainPath
    : existsSync(registerPath) ? registerPath : existsSync(registerJsPath) ? registerJsPath : null;
  if (entryPath) {
    try {
      // Cache-bust by mtime: without the query, Node caches the module URL
      // forever and edits would never run (spike A0-1).
      const url = pathToFileURL(entryPath).href + `?v=${statSync(entryPath).mtimeMs}`;
      const mod = await import(url) as Record<string, unknown>;
      const pick = (v: unknown): AddonRegisterFn | undefined =>
        typeof v === 'function' ? (v as AddonRegisterFn) : undefined;
      const fromObj = (obj: unknown): AddonRegisterFn | undefined => {
        if (!obj || typeof obj !== 'object') return undefined;
        const o = obj as Record<string, unknown>;
        return pick(o.register) ?? pick(o.default);
      };
      // v2 module: activate(ctx) — ctx carries the addon identity, the $
      // api surface (spread), the hook registrar `on`, and subscriptions.
      const v2Activate = typeof (mod as { activate?: unknown }).activate === 'function'
        ? (mod as { activate: (ctx: unknown) => unknown }).activate
        : undefined;
      if (validation.apiVersion === '2' && v2Activate) {
        const api = createAddonApi(manifest.id, { addonDir: dir });
        const on = createEventRegistrar(manifest.id);
        await v2Activate({ id: manifest.id, on, ...api, api });
        activeModules.set(manifest.id, { addonId: manifest.id, module: mod as Partial<AddonModuleV2> });
      } else {
        const registerFn: AddonRegisterFn | undefined =
          pick(mod.register) ??
          pick(mod.default) ??
          fromObj(mod.default) ??
          fromObj(mod.default && (mod.default as Record<string, unknown>).default);
        if (registerFn) {
          // v1 shim: same register(on, $) contract on top of the v2 facades.
          const api = createAddonApi(manifest.id, { addonDir: dir });
          const on = createEventRegistrar(manifest.id);
          await registerFn(on, api);
        }
      }
      // v2 (A4): static contributions + settings schema from the manifest.
      if (validation.apiVersion === '2') {
        const m2 = manifest as unknown as { contributes?: import('./manifest.js').AddonContributes };
        registerContributions(manifest.id, m2.contributes);
        registerSettingsSchema(manifest.id, m2.contributes?.settings);
      }
    } catch (error) {
      loaded.loadError = error instanceof Error ? error.message : 'Failed to load addon entry';
      loaded.status = 'error';
    }
  }
  return loaded;
}

export async function loadAllAddons(): Promise<void> {
  const addonsDir = ADDONS_DIR();
  if (!existsSync(addonsDir)) {
    mkdirSync(addonsDir, { recursive: true });
    return;
  }
  clearAllAddons();
  const entries = readdirSync(addonsDir);
  // Pass 1: parse every manifest (no code runs yet).
  const staged: LoadedAddon[] = [];
  for (const entry of entries) {
    // Skip dot-dirs and seed backups (rsat.bak-…) — a backup manifest would
    // otherwise load as a second copy of the same addon id.
    if (entry.startsWith('.') || entry.includes('.bak')) continue;
    const dir = path.join(addonsDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const raw = parseManifest(dir);
    if (!raw) continue;
    staged.push({
      manifest: raw,
      dir,
      enabled: raw.enabled !== false,
      loadError: null,
      status: raw.enabled !== false ? 'active' : 'disabled',
    });
  }
  // Pass 2 (A2): dependency graph → activation order + blocked reasons.
  const graph = resolveGraph(
    staged.map((a) => ({
      id: a.manifest.id,
      version: a.manifest.version,
      dependencies: (a.manifest as unknown as Record<string, unknown>).dependencies as Record<string, string> ?? {},
      conflicts: (a.manifest as unknown as Record<string, unknown>).conflicts as string[] ?? [],
    })),
  );
  // Pass 3: load + register in topological order.
  for (const addon of staged) {
    const blockedReason = graph.blocked[addon.manifest.id];
    if (blockedReason) {
      registerAddon(addon.manifest.id, { ...addon, status: 'blocked', loadError: blockedReason });
      continue;
    }
    const loaded = await loadOneAddon(addon.dir);
    if (loaded) registerAddon(loaded.manifest.id, loaded);
  }
}

/** The addons directory on disk — shared with the addon_manage agent tool. */
export const ADDONS_ROOT = ADDONS_DIR;

export async function reloadAddon(id: string, enabledOverride?: boolean): Promise<boolean> {
  if (id.startsWith('.') || id.includes('.bak')) return false;
  const dir = path.join(ADDONS_DIR(), id);
  if (!existsSync(dir)) return false;
  unregisterAddon(id);
  unregisterContributions(id);
  const addon = await loadOneAddon(dir);
  if (!addon) return false;
  if (enabledOverride !== undefined) addon.enabled = enabledOverride;
  registerAddon(addon.manifest.id, addon);
  return true;
}

export function startAddonWatcher(onChange: (reloaded: string[]) => void): void {
  const dir = ADDONS_DIR();
  if (!existsSync(dir)) return;
  if (watcher) return;
  try {
    watcher = watch(dir, { recursive: true }, (_event, filename) => {
      const rel = typeof filename === 'string' ? filename : '';
      const id = rel ? addonIdForPath(rel) : null;
      if (id) pendingReload.add(id);
      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(() => {
        const ids = [...pendingReload];
        pendingReload.clear();
        // Reload ONLY the addons whose files changed (A-06).
        void Promise.all(ids.map((addonId) => reloadAddon(addonId)))
          .then(() => onChange(ids))
          .catch(() => onChange(ids));
      }, 300);
    });
  } catch {
  }
}

export function stopAddonWatcher(): void {
  if (watcher) { watcher.close(); watcher = null; }
}
