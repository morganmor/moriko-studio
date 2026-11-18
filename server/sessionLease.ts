

import { abortStream, listLiveStreams } from './streamRegistry.js';


export const SESSION_TTL_MS = 3 * 60 * 60 * 1000;

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;


const lastActivity = new Map<string, number>();


export function touchSession(sessionId: string, at: number = Date.now()): void {
  lastActivity.set(sessionId, at);
}


export function isSessionStale(sessionId: string, now: number = Date.now()): boolean {
  const at = lastActivity.get(sessionId);
  return at !== undefined && now - at > SESSION_TTL_MS;
}


export function dropSession(sessionId: string): void {
  lastActivity.delete(sessionId);
}


export function sweepStaleSessions(now: number = Date.now()): string[] {
  const evicted: string[] = [];
  for (const [sessionId, at] of lastActivity) {
    if (now - at <= SESSION_TTL_MS) continue;
    for (const stream of listLiveStreams()) {
      if (stream.conversationId === sessionId) {
        try {
          abortStream(stream.id);
        } catch {
        }
      }
    }
    lastActivity.delete(sessionId);
    evicted.push(sessionId);
  }
  return evicted;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;


export function startSweepTimer(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const evicted = sweepStaleSessions();
    if (evicted.length > 0) {
      console.log(`[session] Evicted ${evicted.length} stale session(s): ${evicted.join(', ')}`);
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}


export function stopSweepTimer(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}


export function _resetForTests(): void {
  lastActivity.clear();
}