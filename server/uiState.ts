

import { readFileSync } from 'node:fs';

import { atomicWriteJson } from './atomicWrite.js';
import { uiStateFile } from './paths.js';


export const UI_STATE_KEYS = [
  
  'theme',
  
  'accent',
  
  'density',
  
  'ambient',
  
  'reduceMotion',
  
  'confirmDel',
  
  'fontScale',
  
  'contextScale',
  
  'fontFamily',
  
  'sidebarCollapsed',
  
  'sidebarWidth',
  'settingsWidth',
  
  'activeId',
  
  'providerId',
  'model',
  
  'defaults',
  
  'savedPrompts',
  
  'imageStudio',
  
  'imageSessionId',
  
  'jobRuns',
  
  'treePanelOpen',
  'treePanelGeometry',
  
  'visualGeometry',
  
  'dashboardUsageWindow',
  'dashboardUsageProviders',
  
  'sidebarSections',
  
  'settingsOpen',
  
  'view',
  
  'diffDockWidth',
  'diffPanelTurnId',
  
  'viewAnchors',
  'pendingSettings',
] as const;

export type UiStateKey = (typeof UI_STATE_KEYS)[number];
export type UiState = Partial<Record<UiStateKey, unknown>>;

const ALLOWED = new Set<string>(UI_STATE_KEYS);


let cache: UiState | null = null;

function load(): UiState {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(readFileSync(uiStateFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const source = parsed as Record<string, unknown>;
      const kept: UiState = {};
      for (const key of UI_STATE_KEYS) {
        if (source[key] !== undefined) kept[key] = source[key];
      }
      cache = kept;
      return cache;
    }
  } catch {
  }
  cache = {};
  return cache;
}


export function getUiState(): UiState {
  return { ...load() };
}


export function patchUiState(patch: unknown): UiState {
  const state = load();
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (!ALLOWED.has(key)) continue;
      if (value === null || value === undefined) delete state[key as UiStateKey];
      else state[key as UiStateKey] = value;
    }
    atomicWriteJson(uiStateFile, state);
  }
  return { ...state };
}
