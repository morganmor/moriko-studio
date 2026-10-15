/**
 * Session message injection (Addon v2, A3, Q2 = system-injection block).
 *
 * sessions.inject(target, msg) queues a short notice for one, many, or all
 * active sessions. Delivery for a RUNNING session happens at the next round
 * boundary — the adapter's steer seam (between executeCalls and the next
 * model fetch) drains the queue as an ordinary user-role message block, the
 * same channel steers use. For an IDLE session the message is delivered at
 * the next turn start.
 *
 * Idempotency: `msg.key` prevents duplicate delivery. Rate limit: 20
 * injections/minute/addon.
 */

import { listSessions, isSessionRunning } from '../agents/sessionRegistry.js';
import { applyTurnPatches } from '../conversationStore.js';
import { publishBusEvent } from './bus.js';

export type InjectLevel = 'info' | 'warn' | 'block' | 'event';

export interface InjectMessage {
  text: string;
  level?: InjectLevel;
  /** Idempotency key — a message with the same key is delivered once. */
  key?: string;
  /** Which addon is speaking (shown to the user). */
  addonId: string;
  /** ms; queued-not-running messages expire (default 10 min). */
  ttlMs?: number;
}

interface QueueEntry extends InjectMessage {
  id: number;
  at: number;
  delivered?: boolean;
}

const queues = new Map<string, QueueEntry[]>();
const deliveredKeys = new Map<string, number>(); // key → deliveredAt (dedupe window)
const rateWindow = new Map<string, number[]>(); // addonId → timestamps
let nextId = 1;

const RATE_PER_MIN = 20;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

function rateLimited(addonId: string): boolean {
  const now = Date.now();
  const list = (rateWindow.get(addonId) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= RATE_PER_MIN) {
    rateWindow.set(addonId, list);
    return true;
  }
  list.push(now);
  rateWindow.set(addonId, list);
  return false;
}

export interface InjectReport {
  delivered: number;
  queued: number;
  sessions: string[];
}

export function injectMessage(
  target: string | string[] | 'all-active',
  msg: InjectMessage,
): InjectReport {
  if (rateLimited(msg.addonId)) {
    throw new Error('Injection rate limit exceeded (20/min) — the addon is too chatty.');
  }
  let targets: string[];
  if (target === 'all-active') {
    targets = listSessions().map((s) => s.sessionId);
  } else if (Array.isArray(target)) {
    targets = target.filter((t) => typeof t === 'string');
  } else {
    targets = [target];
  }

  const now = Date.now();
  let queued = 0;
  for (const sessionId of targets) {
    // Idempotency: one delivery per key per window.
    if (msg.key) {
      const globalKey = `${sessionId}\u0000${msg.key}`;
      const at = deliveredKeys.get(globalKey);
      if (at !== undefined && now - at < DEDUPE_WINDOW_MS) continue;
      deliveredKeys.set(globalKey, now);
    }
    const list = queues.get(sessionId) ?? [];
    list.push({ ...msg, id: nextId++, at: now });
    queues.set(sessionId, list);
    queued += 1;
  }
  return { delivered: 0, queued, sessions: targets };
}

/** The adapter seam: drain everything queued for a session. Returns entries
 *  in order; expired entries (TTL, session not running) are dropped. */
export function drainInjections(sessionId: string | undefined): QueueEntry[] {
  if (!sessionId) return [];
  const list = queues.get(sessionId);
  if (!list || list.length === 0) return [];
  const now = Date.now();
  const keep: QueueEntry[] = [];
  const out: QueueEntry[] = [];
  for (const entry of list) {
    const ttl = entry.ttlMs ?? 10 * 60 * 1000;
    if (entry.delivered || now - entry.at > ttl) continue;
    entry.delivered = true;
    out.push(entry);
  }
  if (keep.length === 0 && queues.get(sessionId)?.every((e) => e.delivered)) {
    queues.delete(sessionId);
  } else {
    queues.set(sessionId, keep);
  }
  return out;
}

/** Turn-start delivery for idle sessions (called at stream start). */
export function pendingInjections(sessionId: string | undefined): QueueEntry[] {
  return drainInjections(sessionId);
}

export function isInjectedSessionRunning(sessionId: string): boolean {
  return isSessionRunning(sessionId);
}

/** Render one entry as the user-visible injection block text. */
export function injectionText(entry: QueueEntry): string {
  const level = entry.level ?? 'info';
  const tag = level === 'warn' ? '[warn]' : level === 'block' ? '[block]' : level === 'event' ? '[event]' : '[info]';
  return `${tag} ${entry.text}`;
}

/**
 * HARNESS-EVENT emitter (per-session, additive over the queue system).
 *
 * Unlike ordinary injections (which imitate a user turn), an EVENT is its own
 * first-class channel: it is persisted as a `kind: 'harness-event'` turn in
 * THE TARGET CONVERSATION ONLY (never broadcast — events belong to the session
 * that triggered them), and announced live via the bus topic 'harness:event'
 * so an open client appends it immediately, even while the session is idle.
 * The context build (compaction wire rebuild) maps event turns to labeled
 * user-role blocks, so the model sees them on the next round without them
 * polluting the visible user message stream.
 */
export function emitHarnessEvent(
  conversationId: string,
  msg: { text: string; level?: Exclude<InjectLevel, 'event'>; key?: string; addonId: string },
): { ok: boolean; error?: string } {
  if (!conversationId || !msg.text?.trim()) return { ok: false, error: 'conversationId and text are required.' };
  if (rateLimited(msg.addonId)) return { ok: false, error: 'rate limit exceeded (20/min)' };
  const now = Date.now();
  if (msg.key) {
    const globalKey = `${conversationId}\u0000${msg.key}`;
    const at = deliveredKeys.get(globalKey);
    if (at !== undefined && now - at < DEDUPE_WINDOW_MS) return { ok: true };
    deliveredKeys.set(globalKey, now);
  }
  const id = `hev_${now.toString(36)}_${(nextId++).toString(36)}`;
  const level = msg.level ?? 'info';
  const text = `[${msg.addonId}] [${level}] ${msg.text.trim()}`;
  // Persist into the conversation store so the event survives reloads and is
  // visible while the session is idle (server-side truth, single session).
  try {
    applyTurnPatches([{ conversationId, turnId: id, turn: { id, role: 'user', kind: 'harness-event', content: text, createdAt: now, eventAddon: msg.addonId, eventLevel: level } }]);
  } catch {
    // Store unavailable (conversation never synced) — live frame still fires.
  }
  try {
    void publishBusEvent('harness:event', { conversationId, event: { id, addonId: msg.addonId, level, text, at: now } }, `addon:${msg.addonId}`);
  } catch { /* bus is best-effort */ }
  return { ok: true };
}
