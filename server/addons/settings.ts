/**
 * Addon v2 settings (A4) — schema-validated values with user/workspace scope.
 *
 * user scope:      ~/.moriko-studio/addon-data/<id>/settings.json
 * workspace scope: <workspace>/.moriko/addons/<id>/settings.json
 *
 * The Hub renders an automatic form from `contributes.settings`; changes fire
 * settings.onChange hooks and an SSE frame.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../atomicWrite.js';
import { morikoHome } from '../paths.js';
import type { AddonSettingsSchema, AddonSettingProperty } from './manifest.js';
import { publishBusEvent } from './bus.js';

type Listener = (key: string, value: unknown, addonId: string) => void;
const listeners = new Set<Listener>();
const schemaCache = new Map<string, AddonSettingsSchema>();

function fileFor(addonId: string, scope: 'user' | 'workspace', workspaceRoot?: string): string | null {
  if (scope === 'workspace') {
    return workspaceRoot ? path.join(workspaceRoot, '.moriko', 'addons', addonId, 'settings.json') : null;
  }
  return path.join(morikoHome, 'addon-data', addonId, 'settings.json');
}

function readAll(addonId: string, workspaceRoot?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const userFile = fileFor(addonId, 'user')!;
    if (existsSync(userFile)) Object.assign(out, JSON.parse(readFileSync(userFile, 'utf-8')));
  } catch { /* empty */ }
  if (workspaceRoot) {
    try {
      const wsFile = fileFor(addonId, 'workspace', workspaceRoot)!;
      if (existsSync(wsFile)) Object.assign(out, JSON.parse(readFileSync(wsFile, 'utf-8')));
    } catch { /* empty */ }
  }
  return out;
}

export function registerSettingsSchema(addonId: string, schema: AddonSettingsSchema | undefined): void {
  if (schema) schemaCache.set(addonId, schema);
  else schemaCache.delete(addonId);
}

export function getSettingsSchema(addonId: string): AddonSettingsSchema | undefined {
  return schemaCache.get(addonId);
}

function propFor(addonId: string, key: string): AddonSettingProperty | undefined {
  return schemaCache.get(addonId)?.properties[key];
}

/** Validate a value against the schema property; returns error text or null. */
export function validateSetting(addonId: string, key: string, value: unknown): string | null {
  const prop = propFor(addonId, key);
  if (!prop) return `Unknown setting "${key}" for addon "${addonId}"`;
  if (prop.type === 'string') {
    if (typeof value !== 'string') return `"${key}" must be a string`;
    if (prop.enum && !prop.enum.includes(value)) return `"${key}" must be one of: ${prop.enum.join(', ')}`;
  } else if (prop.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `"${key}" must be a number`;
    if (prop.minimum !== undefined && value < prop.minimum) return `"${key}" must be >= ${prop.minimum}`;
    if (prop.maximum !== undefined && value > prop.maximum) return `"${key}" must be <= ${prop.maximum}`;
  } else if (prop.type === 'boolean') {
    if (typeof value !== 'boolean') return `"${key}" must be a boolean`;
  }
  return null;
}

export function getSetting(addonId: string, key: string, workspaceRoot?: string): unknown {
  const values = readAll(addonId, workspaceRoot);
  if (key in values) return values[key];
  return propFor(addonId, key)?.default;
}

export function getAllSettings(addonId: string, workspaceRoot?: string): Record<string, unknown> {
  const values = readAll(addonId, workspaceRoot);
  const schema = schemaCache.get(addonId);
  if (!schema) return values;
  // Fill defaults so the Hub form always shows a complete value set.
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    out[key] = values[key] !== undefined ? values[key] : prop.default;
  }
  for (const [key, value] of Object.entries(values)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

export function setSetting(addonId: string, key: string, value: unknown, workspaceRoot?: string): void {
  const error = validateSetting(addonId, key, value);
  if (error) throw new Error(error);
  const prop = propFor(addonId, key);
  const scope = prop?.scope ?? 'user';
  const file = fileFor(addonId, scope, workspaceRoot);
  if (!file) throw new Error('No active workspace for workspace-scoped settings');
  let data: Record<string, unknown> = {};
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch { /* start fresh */ }
  data[key] = value;
  atomicWriteJson(file, data);
  try {
    void publishBusEvent('addon.settings', { addonId, key, value }, addonId);
  } catch { /* best-effort */ }
  for (const listener of [...listeners]) {
    try {
      listener(key, value, addonId);
    } catch (error2) {
      console.error('[addons] settings listener error:', error2);
    }
  }
}

export function onSettingsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
