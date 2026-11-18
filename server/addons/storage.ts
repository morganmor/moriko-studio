

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../atomicWrite.js';
import { morikoHome } from '../paths.js';

const DEBOUNCE_MS = 200;

interface StoreState {
  data: Record<string, string>;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const stores = new Map<string, StoreState>();

function keyFor(addonId: string, scope: 'global' | 'workspace', workspaceRoot?: string): string | null {
  if (scope === 'workspace') {
    if (!workspaceRoot) return null;
    return path.join(workspaceRoot, '.moriko', 'addons', addonId, 'store.json');
  }
  return path.join(morikoHome, 'addon-data', addonId, 'store.json');
}

function load(key: string): StoreState {
  let state = stores.get(key);
  if (state) return state;
  let data: Record<string, string> = {};
  try {
    if (existsSync(key)) {
      const parsed = JSON.parse(readFileSync(key, 'utf-8')) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') data[k] = v;
        }
      }
    }
  } catch {
  }
  state = { data, dirty: false, timer: null };
  stores.set(key, state);
  return state;
}

function flush(key: string, state: StoreState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (!state.dirty) return;
  state.dirty = false;
  try {
    mkdirSync(path.dirname(key), { recursive: true });
    atomicWriteJson(key, state.data);
  } catch (error) {
    state.dirty = true;
    console.error(`[addons] store flush failed for ${key}:`, error);
  }
}

function schedule(key: string, state: StoreState): void {
  state.dirty = true;
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    flush(key, state);
  }, DEBOUNCE_MS);
  state.timer.unref?.();
}

export function storeGet(addonId: string, key: string, scope: 'global' | 'workspace', workspaceRoot?: string): string | null {
  const file = keyFor(addonId, scope, workspaceRoot);
  if (!file) return null;
  return load(file).data[key] ?? null;
}

export function storeSet(addonId: string, key: string, value: string, scope: 'global' | 'workspace', workspaceRoot?: string): void {
  const file = keyFor(addonId, scope, workspaceRoot);
  if (!file) throw new Error('No active workspace for workspace-scoped storage');
  const state = load(file);
  state.data[key] = value;
  schedule(file, state);
}

export function storeDelete(addonId: string, key: string, scope: 'global' | 'workspace', workspaceRoot?: string): void {
  const file = keyFor(addonId, scope, workspaceRoot);
  if (!file) return;
  const state = load(file);
  if (!(key in state.data)) return;
  delete state.data[key];
  schedule(file, state);
}


export function flushAddonStores(addonId: string): void {
  for (const [file, state] of stores) {
    if (file.includes(`addon-data${path.sep}${addonId}${path.sep}`) || file.includes(`.moriko${path.sep}addons${path.sep}${addonId}${path.sep}`)) {
      flush(file, state);
    }
  }
}


export function flushAllStores(): void {
  for (const [file, state] of stores) flush(file, state);
}
