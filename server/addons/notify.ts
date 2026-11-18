

import { publishBusEvent } from './bus.js';

export type AddonNotifyKind = 'info' | 'warn' | 'error' | 'achievement';

export interface AddonNotification {
  kind: AddonNotifyKind;
  title: string;
  subtitle?: string;
  
  icon?: string;
  
  openView?: string;
  
  ttlMs?: number;
}

export function notifyAddon(addonId: string, notification: AddonNotification): void {
  try {
    void publishBusEvent('addon.notify', { addonId, notification }, addonId);
  } catch (error) {
    console.error(`[addon:${addonId}] notify failed:`, error);
  }
}


export function toastAddon(addonId: string, text: string, kind: 'info' | 'warn' | 'error'): void {
  notifyAddon(addonId, { kind, title: text });
}


export function invalidateAddonView(addonId: string, viewId?: string): void {
  try {
    void publishBusEvent('addon.view.invalidate', { addonId, viewId: viewId ?? null }, addonId);
  } catch {
  }
}
