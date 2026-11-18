import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { morikoHome } from '../paths.js';
import { atomicWriteJson } from '../atomicWrite.js';
import { isInsideRoot } from './workspace.js';



const PERMISSION_TIMEOUT_MS = 120_000;


export interface SkillLoadInfo {
  name: string;
  description: string;
  scope: 'global' | 'workspace' | 'compat';
  
  dir: string;
}

export interface AgentPermissionRequest {
  id: string;
  
  tool: string;
  
  paths: string[];
  
  root: string;

  intent?: 'read' | 'write' | 'exec';
  
  command?: string;
  
  skill?: SkillLoadInfo;
}


export interface PermissionDecision {
  granted: boolean;
  
  reason?: string;
}

interface PendingPermission {
  request: AgentPermissionRequest;
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

const pending = new Map<string, PendingPermission>();


const grantsFile = path.join(morikoHome, 'permission-grants.json');

interface PathGrantEntry {
  p: string;
  at: number;
  intent?: 'read' | 'write' | 'exec';
}

interface StoredGrant {
  version: 1;
  
  paths: PathGrantEntry[];
  
  commands: Array<{ c: string; at: number }>;
}


function loadGrants(): StoredGrant {
  try {
    if (existsSync(grantsFile)) {
      const parsed = JSON.parse(readFileSync(grantsFile, 'utf8')) as StoredGrant;
      if (parsed?.version === 1) return parsed;
    }
  } catch {
  }
  return { version: 1, paths: [], commands: [] };
}

let grants = loadGrants();
const GRANT_TTL_MS = 8 * 60 * 60 * 1000;

function persistGrants(): void {
  try {
    atomicWriteJson(grantsFile, grants);
  } catch {
  }
}


function pathGrantMatchesIntent(
  entryIntent: PathGrantEntry['intent'],
  requested: AgentPermissionRequest['intent'],
): boolean {
  if (requested === 'write') return entryIntent === 'write';
  if (requested === 'exec') return entryIntent === 'exec';
  return entryIntent === undefined || entryIntent === 'read' || entryIntent === 'write';
}

export function isSessionGranted(
  paths: string[],
  command?: string,
  intent?: AgentPermissionRequest['intent'],
): boolean {
  if (command !== undefined) {
    const key = normalizeCommand(command);
    const now = Date.now();
    return grants.commands.some((g) => g.c === key && now - g.at < GRANT_TTL_MS);
  }
  if (paths.length === 0) return false;
  const now = Date.now();
  return paths.every((target) =>
    grants.paths.some(
      (g) => isInsideRoot(target, g.p) && pathGrantMatchesIntent(g.intent, intent) && now - g.at < GRANT_TTL_MS,
    ),
  );
}


function normalizeCommand(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  tokens[0] = tokens[0].toLowerCase();
  return tokens.join('|');
}

function grantSession(request: Pick<AgentPermissionRequest, 'paths' | 'command' | 'intent'>): void {
  const now = Date.now();
  if (request.command !== undefined) {
    const key = normalizeCommand(request.command);
    if (!grants.commands.some((g) => g.c === key)) {
      grants.commands.push({ c: key, at: now });
      persistGrants();
    }
    return;
  }
  const intent = request.intent ?? 'read';
  for (const target of request.paths) {
    if (grants.paths.some((g) => isInsideRoot(target, g.p) && (g.intent ?? 'read') === intent)) continue;
    grants.paths.push({ p: target, at: now, intent });
  }
  persistGrants();
}


export function revokeAllGrants(): void {
  grants = { version: 1, paths: [], commands: [] };
  persistGrants();
}


const AUTO_DENY: PermissionDecision = { granted: false };


export async function requestApproval(
  request: Omit<AgentPermissionRequest, 'id'>,
  ctx: {
    signal?: AbortSignal;
    
    onRequest?: (request: AgentPermissionRequest) => void;
    
    onResolved?: (id: string, decision: PermissionDecision) => void;
  } = {},
): Promise<PermissionDecision> {
  if (isSessionGranted(request.paths, request.command, request.intent)) return { granted: true };

  const id = randomUUID();
  const full: AgentPermissionRequest = { ...request, id };

  return new Promise<PermissionDecision>((resolve) => {
    let settled = false;
    const entry: PendingPermission = {
      request: full,
      timer: setTimeout(() => settle(AUTO_DENY), PERMISSION_TIMEOUT_MS),
      resolve: () => undefined,
    };

    const settle = (decision: PermissionDecision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(entry.timer);
      if (entry.onAbort && ctx.signal) {
        ctx.signal.removeEventListener('abort', entry.onAbort);
      }
      pending.delete(id);
      ctx.onResolved?.(id, decision);
      resolve(decision);
    };

    entry.resolve = settle;
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        settle(AUTO_DENY);
        return;
      }
      entry.onAbort = () => settle(AUTO_DENY);
      ctx.signal.addEventListener('abort', entry.onAbort, { once: true });
    }

    pending.set(id, entry);
    ctx.onRequest?.(full);
  });
}


export function decidePermission(id: string, approve: boolean, remember: boolean, reason?: string): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  if (approve && remember) grantSession(entry.request);
  entry.resolve(approve ? { granted: true } : { granted: false, reason: reason?.trim() || undefined });
  return true;
}


export function listPendingPermissions(): AgentPermissionRequest[] {
  return [...pending.values()].map((entry) => entry.request);
}
