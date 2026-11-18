

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../atomicWrite.js';
import { morikoHome } from '../paths.js';


const DEFAULTS = ['rsat', 'moco-canvas'];

function file(): string {
  return path.join(morikoHome, 'topbar-addons.json');
}


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


export function setTopbarAddons(ids: unknown): string[] {
  const addons = sanitize(ids);
  atomicWriteJson(file(), { addons });
  return addons;
}
