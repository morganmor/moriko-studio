/**
 * Addon lifecycle + console log buffer (Addon v2) — the per-addon journal the
 * Addon Hub's terminal-style Logs tab reads.
 *
 * Two streams per addon:
 *   • LIFECYCLE — structured harness events: load/reload/unload/enable/disable/
 *     seed/consent/block, with durationMs and outcome. `source: 'system'`.
 *   • CONSOLE — what the addon prints via `$.ui.log` / `$.ui.toast` (and any
 *     addon errors caught by the harness). `source: 'addon'`.
 *
 * Bounded (500 entries per addon). A JSONL MIRROR of the latest lines is
 * persisted per addon under `~/.moriko-studio/addon-logs/<id>.log` so startup
 * logs survive a restart — the newest lines are re-hydrated into the buffer at
 * module init and a boot separator line marks the fresh session.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { morikoHome } from '../paths.js';

export type AddonLogLevel = 'info' | 'warn' | 'error';
export type AddonLogSource = 'system' | 'addon';

export interface AddonLogEntry {
  at: number;
  level: AddonLogLevel;
  text: string;
  /** Harness lifecycle event vs the addon's own console output. */
  source: AddonLogSource;
  /** Optional load duration for lifecycle lines (ms). */
  durationMs?: number;
}

const MAX = 500;
const MIRROR_LINES = 200;
const logs = new Map<string, AddonLogEntry[]>();

function logDir(): string {
  return path.join(morikoHome, 'addon-logs');
}

function logFile(addonId: string): string {
  return path.join(logDir(), `${path.basename(addonId)}.log`);
}

/** Persist the newest slice so startup logs survive restarts (best-effort). */
function mirror(addonId: string, list: AddonLogEntry[]): void {
  try {
    if (!existsSync(logDir())) mkdirSync(logDir(), { recursive: true });
    const slice = list.slice(-MIRROR_LINES);
    writeFileSync(logFile(addonId), slice.map((e) => JSON.stringify(e)).join('\n'), 'utf-8');
  } catch { /* logging must never break the harness */ }
}

/** Re-hydrate the previous session's tail so the terminal shows history. */
function hydrate(addonId: string): AddonLogEntry[] {
  try {
    const raw = readFileSync(logFile(addonId), 'utf-8');
    const parsed = raw.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) as AddonLogEntry; } catch { return null; }
    }).filter((e): e is AddonLogEntry => e !== null && typeof e.text === 'string');
    return parsed.slice(-MIRROR_LINES);
  } catch {
    return [];
  }
}

function entries(addonId: string): AddonLogEntry[] {
  let list = logs.get(addonId);
  if (!list) {
    list = hydrate(addonId);
    logs.set(addonId, list);
  }
  return list;
}

export function addonLog(
  addonId: string,
  level: AddonLogLevel,
  text: string,
  source: AddonLogSource = 'addon',
  durationMs?: number,
): void {
  const list = entries(addonId);
  list.push({ at: Date.now(), level, text, source, ...(durationMs !== undefined ? { durationMs } : {}) });
  if (list.length > MAX) list.splice(0, list.length - MAX);
  mirror(addonId, list);
  const prefix = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  (console[prefix as 'log'] as (...args: unknown[]) => void)(`[addon:${addonId}] ${text}`);
}

/** Harness lifecycle event (load/reload/unload/enable/disable/seed/…). */
export function addonLifecycleLog(addonId: string, text: string, durationMs?: number, level: AddonLogLevel = 'info'): void {
  addonLog(addonId, level, text, 'system', durationMs);
}

/** A visible divider marking a fresh harness session for this addon. */
export function addonSessionMark(addonId: string, note: string): void {
  addonLifecycleLog(addonId, `──── ${note} ────`);
}

export function tailAddonLogs(addonId: string, limit = 200): AddonLogEntry[] {
  return entries(addonId).slice(-limit).reverse();
}

export function clearAddonLogs(addonId: string): void {
  // Keep the on-disk mirror; only the in-memory buffer resets. The terminal
  // panel keeps its history across reloads — a fresh line marks the reload.
  logs.delete(addonId);
}
