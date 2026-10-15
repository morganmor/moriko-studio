/**
 * Active session registry (Addon v2, A3) — which agent sessions are RUNNING
 * right now, with workspace + model. The piece multi-agent coordination
 * (RSA/T) needs: sessions.list(), presence heartbeats, and message injection.
 *
 * This sits BESIDE agents/reload.ts's activeStreams counter — that stays the
 * source for "is any stream live"; this adds identity and detail.
 */

export interface SessionInfo {
  sessionId: string;
  conversationId?: string;
  workspaceId?: string;
  workspacePath?: string;
  model?: string;
  startedAt: number;
  lastActive: number;
}

export type SessionChange =
  | { kind: 'open'; session: SessionInfo }
  | { kind: 'close'; sessionId: string }
  | { kind: 'heartbeat'; sessionId: string; at: number };

type Listener = (change: SessionChange) => void;

const sessions = new Map<string, SessionInfo>();
const listeners = new Set<Listener>();

function notify(change: SessionChange): void {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch (error) {
      console.error('[sessionRegistry] listener error:', error);
    }
  }
}

export function markSessionOpen(info: {
  sessionId: string;
  conversationId?: string;
  workspaceId?: string;
  workspacePath?: string;
  model?: string;
}): SessionInfo {
  const session: SessionInfo = {
    sessionId: info.sessionId,
    conversationId: info.conversationId,
    workspaceId: info.workspaceId,
    workspacePath: info.workspacePath,
    model: info.model,
    startedAt: Date.now(),
    lastActive: Date.now(),
  };
  sessions.set(info.sessionId, session);
  notify({ kind: 'open', session });
  return session;
}

export function markSessionClose(sessionId: string): void {
  if (!sessions.has(sessionId)) return;
  sessions.delete(sessionId);
  notify({ kind: 'close', sessionId });
}

export function markSessionHeartbeat(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.lastActive = Date.now();
  notify({ kind: 'heartbeat', sessionId, at: session.lastActive });
}

export function listSessions(): SessionInfo[] {
  return [...sessions.values()];
}

export function getSession(sessionId: string): SessionInfo | null {
  return sessions.get(sessionId) ?? null;
}

export function isSessionRunning(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
