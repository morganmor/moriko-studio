/**
 * SESSION LEASE — the harness's ONLY session-lifetime bookkeeping.
 *
 * The harness enforces NO concurrency limit: providers own their limits, and
 * when a provider's limit is hit the bridge surfaces the error honestly (see
 * the 429/concurrency fallback in the /api/chat catch block). A limit that
 * exists must live at the provider — this module deliberately does not gate
 * requests.
 *
 * What the harness DOES own is its own garbage. A session (conversation id)
 * holds a LEASE renewed by every new input. Three hours without input means
 * the session is officially stale for the provider agentic: the eviction
 * sweep aborts any zombie stream still living in the stream registry and
 * drops the lease, so an abandoned session stops squatting on the provider's
 * concurrency slots that other sessions need.
 */

import { abortStream, listLiveStreams } from './streamRegistry.js';

/** 3 hours idle → the session is stale and up for eviction. */
export const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
/** How often the eviction sweep runs. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** sessionId → last input timestamp */
const lastActivity = new Map<string, number>();

/** Every new input renews the lease (call per /api/chat request). */
export function touchSession(sessionId: string, at: number = Date.now()): void {
  lastActivity.set(sessionId, at);
}

/** True when the session's most recent input is older than the TTL. */
export function isSessionStale(sessionId: string, now: number = Date.now()): boolean {
  const at = lastActivity.get(sessionId);
  return at !== undefined && now - at > SESSION_TTL_MS;
}

/** Drop the lease entirely (a deleted conversation holds nothing). */
export function dropSession(sessionId: string): void {
  lastActivity.delete(sessionId);
}

/**
 * Evict sessions idle beyond the TTL. For each evicted session any zombie
 * stream still living in the stream registry is aborted — the provider-side
 * slot only frees when the upstream actually dies, so the abort is the whole
 * point of the eviction. Returns the evicted session ids.
 */
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

/** Start the periodic eviction sweep. Call once at boot. */
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

/** Stop the sweep (shutdown, tests). */
export function stopSweepTimer(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Test helper — clear all leases between test cases. */
export function _resetForTests(): void {
  lastActivity.clear();
}