/**
 * Addon ring-buffer logs (Addon v2, A1) — the per-addon console the Addon Hub
 * "Logs" tab reads. Bounded (500 entries), never written to disk.
 */

export type AddonLogLevel = 'info' | 'warn' | 'error';

export interface AddonLogEntry {
  at: number;
  level: AddonLogLevel;
  text: string;
}

const MAX = 500;
const logs = new Map<string, AddonLogEntry[]>();

function entries(addonId: string): AddonLogEntry[] {
  let list = logs.get(addonId);
  if (!list) {
    list = [];
    logs.set(addonId, list);
  }
  return list;
}

export function addonLog(addonId: string, level: AddonLogLevel, text: string): void {
  const list = entries(addonId);
  list.push({ at: Date.now(), level, text });
  if (list.length > MAX) list.splice(0, list.length - MAX);
  const prefix = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  (console[prefix as 'log'] as (...args: unknown[]) => void)(`[addon:${addonId}] ${text}`);
}

export function tailAddonLogs(addonId: string, limit = 200): AddonLogEntry[] {
  return entries(addonId).slice(-limit).reverse();
}

export function clearAddonLogs(addonId: string): void {
  logs.delete(addonId);
}
