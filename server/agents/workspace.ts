import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { atomicWriteJson } from '../atomicWrite.js';
import { agentsFile, conversationDir, morikoHome } from '../paths.js';



const CONFIG_FILE = agentsFile;


export function addonsSrcRoot(): string | null {
  try {
    const dir = path.resolve(process.cwd(), 'addons-src');
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

export interface AgentWorkspace {
  id: string;
  
  label: string;
  
  path: string;
  createdAt: string;
  
  selfHosted?: boolean;
}

interface AgentsFile {
  version: 1;
  workspaces: AgentWorkspace[];
  activeId: string | null;
  
  sessionWorkspaces?: Record<string, string>;
  
  allowedDirs?: string[];
}

const EMPTY: AgentsFile = { version: 1, workspaces: [], activeId: null };

let cache: AgentsFile | null = null;

function load(): AgentsFile {
  if (cache) return cache;
  try {
    if (existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as AgentsFile;
      cache = {
        version: 1,
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
        activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
        sessionWorkspaces:
          parsed.sessionWorkspaces && typeof parsed.sessionWorkspaces === 'object'
            ? parsed.sessionWorkspaces
            : {},
        allowedDirs: Array.isArray(parsed.allowedDirs) ? parsed.allowedDirs : [],
      };
      return cache;
    }
  } catch {
  }
  cache = { ...EMPTY };
  return cache;
}

function persist(next: AgentsFile): void {
  cache = next;
  atomicWriteJson(CONFIG_FILE, next);
}

export function listWorkspaces(): AgentWorkspace[] {
  return load().workspaces;
}

export function getActiveWorkspace(sessionId?: string): AgentWorkspace | undefined {
  const store = load();
  if (sessionId) {
    const perSession = store.sessionWorkspaces?.[sessionId];
    if (!perSession) return undefined;
    return store.workspaces.find((workspace) => workspace.id === perSession);
  }
  // No session context (scripts / debug routes): the global selection.
  if (!store.activeId) return undefined;
  return store.workspaces.find((workspace) => workspace.id === store.activeId);
}


function normalizeDirectory(inputPath: string): string {
  const resolved = path.resolve(inputPath.trim());
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(`"${resolved}" does not exist on this machine.`);
  }
  if (!stats.isDirectory()) throw new Error(`"${resolved}" is a file, not a directory.`);
  return resolved;
}


export function addWorkspace(inputPath: string, label?: string): AgentWorkspace {
  const normalized = normalizeDirectory(inputPath);
  const store = load();
  const existing = store.workspaces.find(
    (workspace) => pathsEqual(workspace.path, normalized),
  );
  if (existing) {
    if (label && label.trim() && label.trim() !== existing.label) {
      const updated = { ...existing, label: label.trim() };
      persist({
        ...store,
        workspaces: store.workspaces.map((entry) => (entry.id === existing.id ? updated : entry)),
      });
      return updated;
    }
    return existing;
  }
  const workspace: AgentWorkspace = {
    id: randomUUID(),
    label: label?.trim() || path.basename(normalized) || normalized,
    path: normalized,
    createdAt: new Date().toISOString(),
    selfHosted: detectSelfHost(normalized),
  };
  persist({ ...store, workspaces: [...store.workspaces, workspace] });
  try {
    const { emitPointAsync } = require('../addons/points.js') as typeof import('../addons/points.js');
    emitPointAsync('workspace.bind', { workspaceId: workspace.id, path: workspace.path });
  } catch {  }
  return workspace;
}

export function removeWorkspace(id: string): boolean {
  const store = load();
  const workspaces = store.workspaces.filter((workspace) => workspace.id !== id);
  if (workspaces.length === store.workspaces.length) return false;
  const sessionWorkspaces: Record<string, string> = {};
  for (const [session, workspaceId] of Object.entries(store.sessionWorkspaces ?? {})) {
    if (workspaceId !== id) sessionWorkspaces[session] = workspaceId;
  }
  persist({
    version: 1,
    workspaces,
    activeId: store.activeId === id ? null : store.activeId,
    sessionWorkspaces,
  });
  return true;
}


export function setActiveWorkspace(id: string, sessionId?: string): AgentWorkspace {
  const store = load();
  const workspace = store.workspaces.find((entry) => entry.id === id);
  if (!workspace) throw new Error(`Unknown workspace "${id}".`);
  if (sessionId) {
    persist({
      ...store,
      sessionWorkspaces: { ...(store.sessionWorkspaces ?? {}), [sessionId]: id },
    });
  } else {
    persist({ ...store, activeId: id });
  }
  try {
    const { emitPointAsync } = require('../addons/points.js') as typeof import('../addons/points.js');
    emitPointAsync('workspace.active', { workspaceId: workspace.id, path: workspace.path, sessionId });
  } catch {  }
  return workspace;
}


export function getSessionWorkspaceId(sessionId: string): string | null {
  return load().sessionWorkspaces?.[sessionId] ?? null;
}


function pathsEqual(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}


export function isInsideRoot(absolute: string, root: string): boolean {
  return (
    pathsEqual(absolute, root) ||
    (process.platform === 'win32'
      ? absolute.toLowerCase().startsWith(root.toLowerCase() + path.sep)
      : absolute.startsWith(root + path.sep))
  );
}


function detectSelfHost(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
    return pkg?.name === 'moriko-studio';
  } catch {
    return false;
  }
}

const selfHostCache = new Map<string, boolean>();


export function isSelfHostedWorkspace(workspace: AgentWorkspace | undefined): boolean {
  if (!workspace) return false;
  if (workspace.selfHosted === true) return true;
  if (workspace.selfHosted === false) return false;
  const key = process.platform === 'win32' ? workspace.path.toLowerCase() : workspace.path;
  let detected = selfHostCache.get(key);
  if (detected === undefined) {
    detected = detectSelfHost(workspace.path);
    selfHostCache.set(key, detected);
  }
  return detected;
}

export type ProtectedLevel = 'no-access' | 'no-write';


export function protectedPathLevel(relative: string): ProtectedLevel | null {
  const rel = relative.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!rel || rel === '.') return null;
  if (rel === '.env' || rel.startsWith('.env/')) return 'no-access';
  if (rel.startsWith('.env.')) return 'no-access';
  if (rel === '.data' || rel.startsWith('.data/')) return 'no-access';
  if (rel === 'node_modules' || rel.startsWith('node_modules/')) return 'no-write';
  if (rel === '.git' || rel.startsWith('.git/')) return 'no-write';
  return null;
}


function isInsideMorikoHome(absolute: string): boolean {
  const normalized = path.resolve(absolute);
  const root = path.resolve(morikoHome);
  return normalized === root || normalized.startsWith(root + path.sep);
}


export function assertSelfHostAccess(absolute: string, intent: 'read' | 'write'): void {
  if (isInsideMorikoHome(absolute)) {
    throw new Error(
      `Self-host guard: "${absolute}" is inside ~/.moriko — the app's own stores ` +
      '(API keys, conversation archive, harness journals) are never read or written by the harness.',
    );
  }
  for (const workspace of listWorkspaces()) {
    if (!isSelfHostedWorkspace(workspace)) continue;
    if (!isInsideRoot(absolute, workspace.path)) continue;
    const level = protectedPathLevel(path.relative(workspace.path, absolute));
    if (!level) return;
    if (level === 'no-access') {
      throw new Error(
        `Self-host guard: this path is protected in the Moriko workspace (secrets and app state are ` +
        `never read or written by the harness) — "${absolute}". Inspect it manually if needed.`,
      );
    }
    if (intent === 'write') {
      throw new Error(
        `Self-host guard: "${absolute}" is write-protected (dependencies / VCS internals). ` +
        'Use the run or git tools for package and version-control operations instead.',
      );
    }
    return;
  }
}


export function listAllowedDirs(): string[] {
  return [...(load().allowedDirs ?? [])];
}

export function addAllowedDir(inputPath: string): string[] {
  const normalized = normalizeDirectory(inputPath);
  const store = load();
  const dirs = store.allowedDirs ?? [];
  if (dirs.some((dir) => pathsEqual(dir, normalized))) return dirs;
  const next = [...dirs, normalized];
  persist({ ...store, allowedDirs: next });
  return next;
}

export function removeAllowedDir(inputPath: string): string[] {
  const store = load();
  const dirs = store.allowedDirs ?? [];
  const next = dirs.filter((dir) => !pathsEqual(dir, path.resolve(inputPath.trim())));
  persist({ ...store, allowedDirs: next });
  return next;
}


export function isInsideAllowedDir(absolute: string): boolean {
  return listAllowedDirs().some((dir) => isInsideRoot(absolute, dir));
}


export function isAttachmentPath(absolute: string): boolean {
  const rel = path.relative(conversationDir, absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  return parts.length >= 3 && parts[0].startsWith('chat-') && parts[1] === 'attachment';
}


export function resolveInWorkspace(inputPath: string): { absolute: string; relative: string } {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    throw new Error('No active agent workspace. Pick one in the workspace picker first.');
  }
  const root = workspace.path;
  const absolute = path.resolve(root, inputPath.trim());
  if (!isInsideRoot(absolute, root)) {
    throw new Error(
      `Path "${inputPath}" escapes the active workspace. Every agent tool is restricted to the workspace root (${root}).`,
    );
  }
  return { absolute, relative: path.relative(root, absolute) || '.' };
}


