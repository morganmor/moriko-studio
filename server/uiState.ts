/**
 * UI STATE STORE — the device's copy of the client's small state.
 *
 * The browser used to keep this in localStorage: theme, zoom, font family,
 * sidebar, saved prompts, the last provider/model, the active conversation and
 * Image Studio session, the client's run journal. That made every browser (and
 * every profile, and incognito) a separate universe, and it made the browser —
 * not the device — the only place some of it existed. All of it lives here now
 * (`~/.moriko/ui-state.json`, see paths.ts) and the browser keeps nothing.
 *
 * WHY ONE FILE, AND WHY A PATCH:
 *  - Every value is small and read at boot, so one atomic write beats N files.
 *  - The API is a per-KEY merge patch, not a whole-document replace. Two tabs
 *    (or a tab plus the Image Studio) change different preferences constantly;
 *    a document replace would have each one silently reverting the other's
 *    theme, zoom, or last-used model. A patch can only touch what its sender
 *    actually changed.
 *  - Only keys on the allowlist are accepted: this is a client-owned shape, and
 *    without the list a typo would quietly accumulate junk forever.
 *
 * Values are stored opaquely (the client owns their shape, exactly like the
 * conversation store treats records); the server only decides which KEYS may
 * exist. `undefined`/`null` in a patch deletes the key, which is how a client
 * clears a value without inventing a sentinel.
 */

import { readFileSync } from 'node:fs';

import { atomicWriteJson } from './atomicWrite.js';
import { uiStateFile } from './paths.js';

/**
 * Every key a client may store. Adding a preference means adding it here —
 * deliberately, so the device file stays a known, inspectable shape.
 */
export const UI_STATE_KEYS = [
  /** 'dark' | 'light' | 'mocha' | 'system' (theme mechanism). */
  'theme',
  /** Accent swatch: 'ember' | 'sakura' | 'matcha' | 'ocean' | 'violet'. */
  'accent',
  /** Row density: 'comfy' | 'compact'. */
  'density',
  /** Ambient glow behind the app (default on). */
  'ambient',
  /** Reduce-motion override: true/false; absent = follow the OS. */
  'reduceMotion',
  /** Confirm before deleting a chat (design's confirmDel). */
  'confirmDel',
  /** Workspace zoom (0.8–1.4). */
  'fontScale',
  /** Context-panel zoom (0.8–1.4). */
  'contextScale',
  /** 'inter' | 'mono' | 'system' */
  'fontFamily',
  /** Sidebar collapsed flag. */
  'sidebarCollapsed',
  /** Resizable panel widths in px (client-clamped, server re-validated as numbers). */
  'sidebarWidth',
  'settingsWidth',
  /** The conversation the user had open. */
  'activeId',
  /** Last picked chat provider + model. */
  'providerId',
  'model',
  /** New-chat defaults (client-owned shape). */
  'defaults',
  /** User-saved system prompts. */
  'savedPrompts',
  /** Image Studio's provider/model + size settings. */
  'imageStudio',
  /** The Image Studio session the user is working in. */
  'imageSessionId',
  /** The client's mirror of the job journal (crashed/interrupted runs). */
  'jobRuns',
  /** REALTIME PROJECT STRUCTURE (Fase B): panel open flag + last geometry. */
  'treePanelOpen',
  'treePanelGeometry',
  /** Fase D: per-visual manual sizing (width/height/auto-fit), keyed by
   *  visual id — a map so one key carries every card's geometry. */
  'visualGeometry',
  /** Dashboard usage preferences (window + folded provider ids). */
  'dashboardUsageWindow',
  'dashboardUsageProviders',
  /** Left-sidebar dropdown open/closed states (user's last condition). */
  'sidebarSections',
  /** G1: right dock open/closed (tri-state handled client-side). */
  'settingsOpen',
  /** G2: active top-level view. */
  'view',
  /** G3/G4: diff dock width (px) + turn scope (null = all). */
  'diffDockWidth',
  'diffPanelTurnId',
  /** G5: per-conversation scroll anchor (topmost visible turn + offset). */
  'viewAnchors',
] as const;

export type UiStateKey = (typeof UI_STATE_KEYS)[number];
export type UiState = Partial<Record<UiStateKey, unknown>>;

const ALLOWED = new Set<string>(UI_STATE_KEYS);

/** In-process cache: the file is read once, then kept in step with writes. */
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

/** The device's current client state (always a fresh copy). */
export function getUiState(): UiState {
  return { ...load() };
}

/**
 * Merge a per-key patch and persist it. Returns the state AFTER the merge so
 * the sender converges with whatever else wrote in between.
 *
 * `null`/`undefined` deletes a key; unknown keys are ignored (see the allowlist
 * note above) rather than rejected — a newer client shipping a new preference
 * to an older server should degrade to "that one preference does not stick",
 * never to a failed request that loses the whole batch with it.
 */
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
