/**
 * Addon v2 contributions registry (A4) — views, status items and tool
 * renderers declared in `addon.json` (static) plus runtime status updates
 * pushed over SSE to the sidebar/Hub.
 */

import type { AddonContributes, AddonViewContribution } from './manifest.js';
import { publishBusEvent } from './bus.js';

export interface RegisteredView extends AddonViewContribution {
  addonId: string;
}

export interface StatusPatch {
  id: string;
  text?: string;
  tone?: 'ok' | 'warn' | 'danger' | 'info' | 'muted';
  progress?: number; // 0..1
  badge?: number;
  pulse?: boolean;
}

const views: RegisteredView[] = [];
const statusItems = new Map<string, StatusPatch & { addonId: string }>(); // key addonId\0id
const toolRenderers = new Map<string, { addonId: string; tool: string; component: string }>();

/** Register the STATIC contributions from a validated manifest (on load). */
export function registerContributions(addonId: string, contributes: AddonContributes | undefined): void {
  unregisterContributions(addonId);
  if (!contributes) return;
  for (const view of contributes.views ?? []) {
    views.push({ ...view, addonId });
  }
  for (const item of contributes.statusItems ?? []) {
    statusItems.set(`${addonId}\u0000${item.id}`, { id: item.id, addonId, text: '' });
  }
  for (const renderer of contributes.toolRenderers ?? []) {
    toolRenderers.set(renderer.tool, { addonId, ...renderer });
  }
}

export function unregisterContributions(addonId: string): void {
  for (let i = views.length - 1; i >= 0; i--) {
    if (views[i].addonId === addonId) views.splice(i, 1);
  }
  for (const key of [...statusItems.keys()]) {
    if (key.startsWith(`${addonId}\u0000`)) statusItems.delete(key);
  }
  for (const [tool, renderer] of [...toolRenderers.entries()]) {
    if (renderer.addonId === addonId) toolRenderers.delete(tool);
  }
}

export function listViews(location?: string): RegisteredView[] {
  return location ? views.filter((v) => v.location === location) : views;
}

export function listStatusItems(): Array<StatusPatch & { addonId: string; id: string }> {
  return [...statusItems.values()];
}

export function getToolRenderer(tool: string): { addonId: string; tool: string; component: string } | undefined {
  return toolRenderers.get(tool);
}

/** Runtime status update from an addon (`ui.status.set`) — pushed via SSE. */
export function setStatus(addonId: string, patch: StatusPatch): void {
  const key = `${addonId}\u0000${patch.id}`;
  const prev = statusItems.get(key);
  const next: StatusPatch & { addonId: string } = { ...prev, ...patch, addonId };
  statusItems.set(key, next);
  try {
    void publishBusEvent('addon.status', { addonId, status: { ...next } }, addonId);
  } catch { /* best-effort */ }
}
