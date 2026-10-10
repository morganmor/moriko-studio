/**
 * Addon loader — scans `~/.moriko-studio/addons/`, parses manifests,
 * dynamically imports `register.ts`, calls `register(on, $)`, and
 * watches for hot-reload WITHOUT server restart.
 *
 * Pattern diadopsi dari Claude Code Mods:
 * - Addon mengekspor `register(on, api)` entry point
 * - `on(event, matcher?, handler)` mendaftarkan event hook
 * - File watcher → unload → reload → register() runs again
 * - Server tetap berjalan; tool/widget baru langsung tersedia
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
import {
  registerAddon,
  unregisterAddon,
  registerAddonHook,
  clearAllAddons,
} from './registry.js';
import { createAddonApi } from './api.js';
import { morikoHome } from '../paths.js';

const ADDONS_DIR = () => path.join(morikoHome, 'addons');
const WORKSPACE_PATH = process.cwd();

let watcher: ReturnType<typeof watch> | null = null;
let reloadDebounce: ReturnType<typeof setTimeout> | null = null;

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
  ): AddonRegistration => {
    const matcher = typeof matcherOrHandler === 'function' ? null : matcherOrHandler;
    const fn = typeof matcherOrHandler === 'function' ? matcherOrHandler : handler;
    if (!fn) return { catch() {} };
    return registerAddonHook(addonId, event, matcher, fn);
  };
}

async function loadOneAddon(dir: string): Promise<LoadedAddon | null> {
  const manifest = parseManifest(dir);
  if (!manifest) return null;
  const loaded: LoadedAddon = {
    manifest,
    dir,
    enabled: manifest.enabled !== false,
    loadError: null,
  };
  if (!loaded.enabled) return loaded;

  const registerPath = path.join(dir, 'register.ts');
  const registerJsPath = path.join(dir, 'register.js');
  const entryPath = existsSync(registerPath) ? registerPath : existsSync(registerJsPath) ? registerJsPath : null;
  if (entryPath) {
    try {
      const url = pathToFileURL(entryPath).href;
      const mod = await import(url) as Record<string, unknown>;
      const pick = (v: unknown): AddonRegisterFn | undefined =>
        typeof v === 'function' ? (v as AddonRegisterFn) : undefined;
      const fromObj = (obj: unknown): AddonRegisterFn | undefined => {
        if (!obj || typeof obj !== 'object') return undefined;
        const o = obj as Record<string, unknown>;
        return pick(o.register) ?? pick(o.default);
      };
      const registerFn: AddonRegisterFn | undefined =
        pick(mod.register) ??
        pick(mod.default) ??
        fromObj(mod.default) ??
        fromObj(mod.default && (mod.default as Record<string, unknown>).default);
      if (registerFn) {
        const api = createAddonApi(manifest.id, WORKSPACE_PATH);
        const on = createEventRegistrar(manifest.id);
        await registerFn(on, api);
      }
    } catch (error) {
      loaded.loadError = error instanceof Error ? error.message : 'Failed to load register.ts';
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
  for (const entry of entries) {
    const dir = path.join(addonsDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const addon = await loadOneAddon(dir);
    if (addon) registerAddon(addon.manifest.id, addon);
  }
}

/** The addons directory on disk — shared with the addon_manage agent tool. */
export const ADDONS_ROOT = ADDONS_DIR;

export async function reloadAddon(id: string, enabledOverride?: boolean): Promise<boolean> {
  const dir = path.join(ADDONS_DIR(), id);
  if (!existsSync(dir)) return false;
  unregisterAddon(id);
  const addon = await loadOneAddon(dir);
  if (!addon) return false;
  if (enabledOverride !== undefined) addon.enabled = enabledOverride;
  registerAddon(addon.manifest.id, addon);
  return true;
}

export function startAddonWatcher(onChange: () => void): void {
  const dir = ADDONS_DIR();
  if (!existsSync(dir)) return;
  if (watcher) return;
  try {
    watcher = watch(dir, { recursive: true }, () => {
      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(() => {
        void loadAllAddons().then(() => onChange());
      }, 500);
    });
  } catch {
  }
}

export function stopAddonWatcher(): void {
  if (watcher) { watcher.close(); watcher = null; }
}
