import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { atomicWriteJson } from '../atomicWrite.js';
import { agentsFile, conversationDir, morikoHome } from '../paths.js';

/**
 * Registry of AGENT WORKSPACES: directories on this machine the user has
 * explicitly granted to the built-in agent harness (grep / read_file /
 * edit_file). Everything the harness touches is resolved against the ACTIVE
 * workspace root and rejected when it would escape that root — a workspace
 * is an allowlist entry, not a suggestion.
 *
 * Persisted to `~/.moriko/agents.json` (machine-level config; same
 * defensive-read pattern as every other store — see paths.ts).
 */

const CONFIG_FILE = agentsFile;

export interface AgentWorkspace {
  id: string;
  /** Human label shown by the picker; defaults to the folder name. */
  label: string;
  /** Absolute, normalized root path on this machine. */
  path: string;
  createdAt: string;
  /**
   * True when the workspace IS this app (Moriko Studio's own source). The
   * harness then refuses to touch secrets (.env*), app state (.data/) and
   * dependency/VCS internals (node_modules/, .git/) — see assertSelfHostAccess.
   * Auto-detected from package.json at registration; legacy entries without
   * the flag are detected lazily on first use.
   */
  selfHosted?: boolean;
}

interface AgentsFile {
  version: 1;
  workspaces: AgentWorkspace[];
  activeId: string | null;
  /**
   * PER-SESSION workspace override: chat id → workspace id. The browser
   * passes `?sessionId=<conversationId>` on every workspace API call, so two
   * conversations can hold different folders at the same time (and switching
   * chats never drags the other chat's folder along). A session without an
   * entry falls back to the global `activeId`.
   */
  sessionWorkspaces?: Record<string, string>;
  /** Folders the user whitelisted for friction-free access OUTSIDE the active workspace. */
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

/** Validates a user-supplied path: must exist and be a directory. Returns it absolute + normalized. */
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

/** Registers (or re-returns) a workspace directory. Same path → same entry. */
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

/**
 * Activates a workspace — globally when no `sessionId` is given, or as a
 * PER-SESSION binding when one is. The browser always passes the active chat's
 * id, so every workspace switch is scoped to the conversation the user is
 * looking at and never leaks into other sessions.
 */
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
  return workspace;
}

/** The session-bound workspace id (null when the session has no override). */
export function getSessionWorkspaceId(sessionId: string): string | null {
  return load().sessionWorkspaces?.[sessionId] ?? null;
}

/**
 * Case-tolerant path equality for Windows (`c:\a` and `C:\A` are the same
 * directory); exact comparison elsewhere.
 */
function pathsEqual(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * True when `absolute` lives inside `root` — case-tolerant on Windows
 * (`c:\a` and `C:\A` are the same directory); exact prefix elsewhere.
 */
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

/** True when this workspace holds Moriko Studio's own source. */
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

/**
 * Classifies a workspace-relative path inside a self-hosted workspace:
 *   - 'no-access' — .env* (API keys), .data/ and ~/.moriko (app state and
 *     stores): blocked for READS too, because file content leaks into the
 *     model.
 *   - 'no-write'  — node_modules/ and .git/: reads are fine, mutations must
 *     go through the run/git tools instead of the file tools.
 */
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

/** True when the absolute path lands inside the app's own `~/.moriko` state. */
function isInsideMorikoHome(absolute: string): boolean {
  const normalized = path.resolve(absolute);
  const root = path.resolve(morikoHome);
  return normalized === root || normalized.startsWith(root + path.sep);
}

/**
 * Throws when `absolute` lands on a protected path of ANY registered
 * self-hosted workspace — or on the app's own `~/.moriko` state, which sits
 * OUTSIDE every workspace and must never be reachable through the harness
 * (it holds API keys, conversation metadata and the harness's own journals).
 * Called by every harness tool before touching disk.
 */
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

/** True when the path lives inside (or equals) one of the whitelisted folders. */
export function isInsideAllowedDir(absolute: string): boolean {
  return listAllowedDirs().some((dir) => isInsideRoot(absolute, dir));
}

/**
 * CONVERSATION-ATTACHMENT EXEMPTION (v2 layout): uploads live under the app's
 * conversation store — `conversation/chat-XXX/attachment/attachment-NNN.ext`
 * — which sits OUTSIDE every workspace. Attachments belong to the
 * conversation, not to a workspace: READING them is always allowed without
 * approval (writes/edits/deletes stay refused — only the user may touch the
 * app's own store, matching the self-host guard's spirit).
 */
export function isAttachmentPath(absolute: string): boolean {
  const rel = path.relative(conversationDir, absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  // conversation/<chat-folder>/attachment/<file>
  const parts = rel.split(path.sep);
  return parts.length >= 3 && parts[0].startsWith('chat-') && parts[1] === 'attachment';
}

/**
 * Resolves a harness-tool path against the ACTIVE workspace root and refuses
 * anything outside it. Accepts relative paths (the normal case) and absolute
 * paths that live inside the root.
 */
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


