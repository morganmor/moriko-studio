import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { morikoHome } from '../paths.js';
import { atomicWriteJson } from '../atomicWrite.js';
import { isInsideRoot } from './workspace.js';

/**
 * SANDBOX PERMISSION GATE for the agent harness.
 *
 * Every harness operation that resolves OUTSIDE the active workspace root
 * must be approved by the user before it executes. The tool call pauses
 * (awaits this promise) while the browser shows a dialog; the decision
 * arrives via `POST /api/agent/permissions/:id/decision`.
 *
 * Grants:
 *  - "Allow once"  → resolves this request only.
 *  - "Allow for this session" → the paths are remembered (PERSISTED to
 *    ~/.moriko/permission-grants.json, so a harness reload — which restarts
 *    the process — keeps them) and expire after 8 hours.
 *
 * Fails closed: no decision within the timeout, or the stream being
 * aborted, resolves as DENIED.
 */

const PERMISSION_TIMEOUT_MS = 120_000;

export interface AgentPermissionRequest {
  id: string;
  /** Harness tool that raised the request ("read_file", "move", "run", …). */
  tool: string;
  /** Absolute paths the operation would touch. */
  paths: string[];
  /** The active workspace root, for display context. */
  root: string;
  /** Exact command line for exec-type requests (agent__run / agent__git). */
  command?: string;
}

interface PendingPermission {
  request: AgentPermissionRequest;
  resolve: (granted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

const pending = new Map<string, PendingPermission>();

/**
 * PERSISTED SESSION GRANTS (fix: they used to be in-memory only, so every
 * harness reload — exit 75 → supervisor respawn — wiped them and the user got
 * re-prompted for the exact same paths they had just approved).
 */
const grantsFile = path.join(morikoHome, 'permission-grants.json');

interface StoredGrant {
  version: 1;
  /** Path grants: an approved prefix covers everything under it. */
  paths: Array<{ p: string; at: number }>;
  /** Command grants, normalized as `program|sorted args`. */
  commands: Array<{ c: string; at: number }>;
}

/** Grants live in ~/.moriko/permission-grants.json and survive reloads. */
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

/**
 * Exec-type requests (with a `command`) are satisfied ONLY by a matching
 * command grant — a path grant from a file operation must never silently
 * approve arbitrary process execution.
 */
export function isSessionGranted(paths: string[], command?: string): boolean {
  if (command !== undefined) {
    const key = normalizeCommand(command);
    const now = Date.now();
    return grants.commands.some((g) => g.c === key && now - g.at < GRANT_TTL_MS);
  }
  if (paths.length === 0) return false;
  const now = Date.now();
  return paths.every((target) =>
    grants.paths.some((g) => isInsideRoot(target, g.p) && now - g.at < GRANT_TTL_MS),
  );
}

/** Normalize a command into a stable key: `program|sorted args`. */
function normalizeCommand(command: string): string {
  const trimmed = command.trim();
  const space = trimmed.indexOf(' ');
  const program = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const args = space < 0 ? [] : trimmed.slice(space + 1).split(/\s+/).filter(Boolean).sort();
  return [program, ...args].join('|');
}

function grantSession(request: Pick<AgentPermissionRequest, 'paths' | 'command'>): void {
  const now = Date.now();
  if (request.command !== undefined) {
    const key = normalizeCommand(request.command);
    if (!grants.commands.some((g) => g.c === key)) {
      grants.commands.push({ c: key, at: now });
      persistGrants();
    }
    return;
  }
  for (const target of request.paths) {
    if (grants.paths.some((g) => isInsideRoot(target, g.p))) continue;
    grants.paths.push({ p: target, at: now });
  }
  persistGrants();
}

/** Forget every grant (used by the revoke API). */
export function revokeAllGrants(): void {
  grants = { version: 1, paths: [], commands: [] };
  persistGrants();
}

/**
 * Raises a permission request and waits for the user's decision. Resolves
 * `true` only on an explicit approval; timeout/abort/unknown resolve false.
 */
export async function requestApproval(
  request: Omit<AgentPermissionRequest, 'id'>,
  ctx: {
    signal?: AbortSignal;
    /** Notifies the UI (stream event) that a decision is needed. */
    onRequest?: (request: AgentPermissionRequest) => void;
    /** Reports the outcome back to the stream once decided. */
    onResolved?: (id: string, granted: boolean) => void;
  } = {},
): Promise<boolean> {
  if (isSessionGranted(request.paths, request.command)) return true;

  const id = randomUUID();
  const full: AgentPermissionRequest = { ...request, id };

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const entry: PendingPermission = {
      request: full,
      timer: setTimeout(() => settle(false), PERMISSION_TIMEOUT_MS),
      resolve: () => undefined,
    };

    const settle = (granted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(entry.timer);
      if (entry.onAbort && ctx.signal) {
        ctx.signal.removeEventListener('abort', entry.onAbort);
      }
      pending.delete(id);
      ctx.onResolved?.(id, granted);
      resolve(granted);
    };

    entry.resolve = settle;
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        settle(false);
        return;
      }
      entry.onAbort = () => settle(false);
      ctx.signal.addEventListener('abort', entry.onAbort, { once: true });
    }

    pending.set(id, entry);
    ctx.onRequest?.(full);
  });
}

/** Applies the user's decision; false when the id is unknown or already settled. */
export function decidePermission(id: string, approve: boolean, remember: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  if (approve && remember) grantSession(entry.request);
  entry.resolve(approve);
  return true;
}

/** Currently undecided requests (for UI reconnects / polling). */
export function listPendingPermissions(): AgentPermissionRequest[] {
  return [...pending.values()].map((entry) => entry.request);
}
