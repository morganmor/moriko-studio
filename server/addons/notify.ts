/**
 * Addon client notifications (Addon v2, A1) — `ui.toast` used to be a bare
 * console.log; now it publishes on the SSE bus as `addon.notify` and the
 * client NotificationHost (A5) renders it. `ui.invalidate` similarly becomes
 * a real `addon.view.invalidate` frame. Closes audit A-13.
 */

import { publishBusEvent } from './bus.js';

export type AddonNotifyKind = 'info' | 'warn' | 'error' | 'achievement';

export interface AddonNotification {
  kind: AddonNotifyKind;
  title: string;
  subtitle?: string;
  /** Icon hint for achievement toasts: 'bronze' | 'silver' | 'gold' | 'diamond' | icon name. */
  icon?: string;
  /** ViewId to open on click, e.g. "addon:rsat/board". */
  openView?: string;
  /** Auto-dismiss override (ms); default 5000. */
  ttlMs?: number;
}

export function notifyAddon(addonId: string, notification: AddonNotification): void {
  try {
    void publishBusEvent('addon.notify', { addonId, notification }, addonId);
  } catch (error) {
    console.error(`[addon:${addonId}] notify failed:`, error);
  }
}

/** Legacy toast surface: text + severity → a notification frame. */
export function toastAddon(addonId: string, text: string, kind: 'info' | 'warn' | 'error'): void {
  notifyAddon(addonId, { kind, title: text });
}

/** Ask clients to refetch one addon view (or all views when id omitted). */
export function invalidateAddonView(addonId: string, viewId?: string): void {
  try {
    void publishBusEvent('addon.view.invalidate', { addonId, viewId: viewId ?? null }, addonId);
  } catch {
    // best-effort
  }
}
