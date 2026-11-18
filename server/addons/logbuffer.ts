

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { morikoHome } from '../paths.js';

export type AddonLogLevel = 'info' | 'warn' | 'error';
export type AddonLogSource = 'system' | 'addon';

export interface AddonLogEntry {
  at: number;
  level: AddonLogLevel;
  text: string;
  
  source: AddonLogSource;
  
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


function mirror(addonId: string, list: AddonLogEntry[]): void {
  try {
    if (!existsSync(logDir())) mkdirSync(logDir(), { recursive: true });
    const slice = list.slice(-MIRROR_LINES);
    writeFileSync(logFile(addonId), slice.map((e) => JSON.stringify(e)).join('\n'), 'utf-8');
  } catch {  }
}


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


export function addonLifecycleLog(addonId: string, text: string, durationMs?: number, level: AddonLogLevel = 'info'): void {
  addonLog(addonId, level, text, 'system', durationMs);
}


export function addonSessionMark(addonId: string, note: string): void {
  addonLifecycleLog(addonId, `──── ${note} ────`);
}

export function tailAddonLogs(addonId: string, limit = 200): AddonLogEntry[] {
  return entries(addonId).slice(-limit).reverse();
}

export function clearAddonLogs(addonId: string): void {
  logs.delete(addonId);
}
