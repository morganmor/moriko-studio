/**
 * Addon v2 permissions (A2) — the consent fence.
 *
 * Trust model (honest): addons are code from the user's disk running IN the
 * server process. Permissions are a fence + consent UX, NOT a security
 * sandbox (until worker isolation exists). Grants persist in
 * ~/.moriko-studio/addons-state.json; builtin addons (addons-src/) are
 * pre-granted with trust "builtin".
 */

import { readFileSync } from 'node:fs';

import { atomicWriteJson } from '../atomicWrite.js';
import { morikoHome } from '../paths.js';
import path from 'node:path';

export type PermissionLevel = 'normal' | 'sensitive' | 'dangerous';

interface PermissionSpec {
  level: PermissionLevel;
  description: string;
}

/** Known permission catalog. Unknown permissions = sensitive (require consent). */
const PERMISSIONS: Record<string, PermissionSpec> = {
  'tools.register': { level: 'normal', description: 'Register agent tools' },
  'commands': { level: 'normal', description: 'Register slash commands' },
  'settings': { level: 'normal', description: 'Contribute settings' },
  'store': { level: 'normal', description: 'Persistent key-value store' },
  'bus': { level: 'normal', description: 'Cross-session pub/sub' },
  'clock': { level: 'normal', description: 'Timers (auto-disposed)' },
  'ui.view': { level: 'normal', description: 'Contribute views/widgets' },
  'ui.notify': { level: 'normal', description: 'Show notifications/toasts' },
  'session.observe': { level: 'normal', description: 'Observe active sessions' },
  'fs.observe': { level: 'normal', description: 'Observe file changes in workspaces' },
  'tools.intercept': { level: 'sensitive', description: 'Deny/rewrite tool calls and results' },
  'prompt.inject': { level: 'sensitive', description: 'Inject prompt fragments per session' },
  'session.inject': { level: 'sensitive', description: 'Inject messages into running sessions' },
  'net.fetch': { level: 'sensitive', description: 'Outbound HTTP requests' },
  'process.spawn': { level: 'dangerous', description: 'Run child processes' },
  'prompt.rewrite': { level: 'dangerous', description: 'Rewrite the whole system prompt' },
  'tools.catalogue.mutate': { level: 'dangerous', description: 'Hide or alter the tool catalogue' },
};

/** workspace.read[:glob] / workspace.write[:glob] — sensitive, glob-scoped. */
const GLOB_PERMISSIONS = ['workspace.read', 'workspace.write'];

export function permissionLevel(perm: string): PermissionSpec {
  const base = perm.split(':', 1)[0];
  if (PERMISSIONS[perm]) return PERMISSIONS[perm];
  if (GLOB_PERMISSIONS.includes(base)) {
    return {
      level: 'sensitive',
      description: `${base === 'workspace.read' ? 'Read' : 'Write'} workspace files${perm.includes(':') ? ` (limited to ${perm.slice(base.length + 1)})` : ''}`,
    };
  }
  if (base.startsWith('net.fetch:')) {
    return { level: 'sensitive', description: `HTTP requests to ${base.slice('net.fetch:'.length) || 'any host'}` };
  }
  return { level: 'sensitive', description: `Unknown permission "${perm}"` };
}

export function isNormal(perm: string): boolean {
  return permissionLevel(perm).level === 'normal';
}

/** Which permissions need explicit consent for this addon. */
export function consentNeeded(perms: string[]): string[] {
  return perms.filter((p) => !isNormal(p));
}

// ---------------------------------------------------------------------------
// Persistent grant store
// ---------------------------------------------------------------------------

export interface AddonPermRecord {
  granted: string[];
  denied: string[];
  enabled: boolean;
  /** Hash of the manifest at consent time — a manifest that ADDS permissions
   *  re-asks for consent. */
  manifestHash?: string;
  trust?: 'builtin' | 'user';
}

type PermState = Record<string, AddonPermRecord>;

const STATE_FILE = path.join(morikoHome, 'addons-state.json');
let state: PermState | null = null;

function load(): PermState {
  if (state) return state;
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as PermState;
    state = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    state = {};
  }
  return state;
}

function persist(): void {
  try {
    atomicWriteJson(STATE_FILE, load());
  } catch (error) {
    console.error('[addons] failed to persist permission state:', error);
  }
}

export function getPermRecord(addonId: string): AddonPermRecord {
  const s = load();
  return s[addonId] ?? { granted: [], denied: [], enabled: true };
}

export function grantPermissions(addonId: string, perms: string[], manifestHash?: string): void {
  const s = load();
  const rec = s[addonId] ?? { granted: [], denied: [], enabled: true };
  for (const p of perms) {
    if (!rec.granted.includes(p)) rec.granted.push(p);
    rec.denied = rec.denied.filter((d) => d !== p);
  }
  if (manifestHash) rec.manifestHash = manifestHash;
  s[addonId] = rec;
  persist();
}

export function revokePermission(addonId: string, perm: string): void {
  const s = load();
  const rec = s[addonId] ?? { granted: [], denied: [], enabled: true };
  rec.granted = rec.granted.filter((p) => p !== perm);
  if (!rec.denied.includes(perm)) rec.denied.push(perm);
  s[addonId] = rec;
  persist();
}

export function markBuiltin(addonId: string, perms: string[]): void {
  const s = load();
  s[addonId] = { granted: perms, denied: [], enabled: true, trust: 'builtin' };
  persist();
}

export function isBuiltin(addonId: string): boolean {
  return getPermRecord(addonId).trust === 'builtin';
}

/** True when the addon may activate: every consent-needed permission granted.
 *  Builtin addons are pre-granted (markBuiltin seeds them at install time). */
export function consentSatisfied(addonId: string, perms: string[]): boolean {
  const needed = consentNeeded(perms);
  if (needed.length === 0) return true;
  const rec = getPermRecord(addonId);
  return needed.every((p) => rec.granted.includes(p));
}

/** The permission gate the $ facade calls. Throws PermissionError with a
 *  readable message (recorded in the addon log), never fails silently. */
export class PermissionError extends Error {
  constructor(addonId: string, perm: string) {
    super(`Addon "${addonId}" lacks permission "${perm}"${permissionLevel(perm).description ? ` — ${permissionLevel(perm).description}` : ''}. Grant it in the Addon Hub → Permissions.`);
    this.name = 'PermissionError';
  }
}

export function assertPermission(addonId: string, perm: string): void {
  const rec = getPermRecord(addonId);
  if (isNormal(perm)) return;
  if (rec.trust === 'builtin') return;
  if (!rec.granted.includes(perm)) throw new PermissionError(addonId, perm);
}
