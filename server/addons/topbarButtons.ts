/**
 * Topbar addon buttons — a tiny user-editable whitelist deciding which addons
 * get a launch button in the harness TopBar (replaces the old hardcoded RSAT
 * gem button).
 *
 * The list lives in `~/.moriko-studio/topbar-addons.json`:
 *   { "addons": ["rsat", "moco-canvas"] }
 * A user or an agent can edit the file directly; the client also patches it
 * through POST /api/addons/topbar-buttons. Buttons render only for addons in
 * the list that are enabled and healthy — the list is the anti-crowding gate,
 * so not every installed addon floods the topbar.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../atomicWrite.js';
import { morikoHome } from '../paths.js';

/** Shipped defaults — used until the user creates/edits the file. */
const DEFAULTS = ['rsat', 'moco-canvas'];

function file(): string {
  return path.join(morikoHome, 'topbar-addons.json');
}

/** Addon ids only — basename-safe, trimmed, deduped, order preserved. */
function sanitize(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || /[/\\]/.test(id) || id.startsWith('.') || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function listTopbarAddons(): string[] {
  try {
    if (!existsSync(file())) return [...DEFAULTS];
    const parsed: unknown = JSON.parse(readFileSync(file(), 'utf8'));
    return sanitize((parsed as { addons?: unknown })?.addons);
  } catch {
    return [...DEFAULTS];
  }
}

/** Overwrite the whitelist; returns the sanitized list that was persisted. */
export function setTopbarAddons(ids: unknown): string[] {
  const addons = sanitize(ids);
  atomicWriteJson(file(), { addons });
  return addons;
}
