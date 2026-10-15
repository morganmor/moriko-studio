/**
 * Addon bus v2 (A7) — cross-session pub/sub + client push fanout.
 *
 * Enables addons like Realtime-Shared-PRD: an event published in session A
 * (claim "Achievement 003") reaches (a) every other addon's hooks via the
 * global bus and (b) every connected browser via SSE, so widget panels update
 * in realtime without polling.
 *
 * v2 upgrades:
 *  - Monotonic frame `id` + `data: id:` SSE lines → the browser's EventSource
 *    sends Last-Event-ID on reconnect and the server replays missed frames.
 *  - Bounded replay ring (default 500) — a short offline blip no longer
 *    silently drops events for the other browsers.
 *  - Topic filter: SSE clients pass ?topics=a,b (or *) — RSAT's activity
 *    panel subscribes to its own topics only, cutting cross-addon noise.
 *  - Subscriber scope: 'any' (all clients incl. publisher's own) or
 *    'others' (v1 semantics — the publisher's browser is skipped).
 */

import type { AddonBusPayload } from './types.js';

interface BusListener {
  addonId: string;
  topic: string;
  handler: (payload: AddonBusPayload) => void | Promise<void>;
}

interface SseClient {
  id: number;
  write: (payload: unknown) => void;
  /** Parsed topic filter (null = everything, matches v1 clients). */
  topics: Set<string> | null;
  /** 'any' → also receive frames the client itself published (v2 default). */
  scope: 'any' | 'others';
}

const listeners: BusListener[] = [];
const sseClients = new Map<number, SseClient>();
let nextClientId = 1;

/** Monotonic frame sequence for SSE `id:` + reconnect replay. */
let frameSeq = 0;
const REPLAY_LIMIT = 500;
const replayRing: AddonBusPayload[] = [];

export interface PublishOptions {
  /** Skip the PUBLISHING client's own browser (v1 semantics). Default false. */
  excludePublisher?: boolean;
}

/** Publish to the bus: all addon listeners + every connected browser. */
export async function publishBusEvent(
  topic: string,
  payload: Record<string, unknown>,
  fromAddon: string,
  opts: PublishOptions = {},
): Promise<void> {
  const message: AddonBusPayload = {
    id: ++frameSeq,
    topic,
    payload,
    addonId: fromAddon,
    ts: Date.now(),
  };
  replayRing.push(message);
  if (replayRing.length > REPLAY_LIMIT) replayRing.shift();

  for (const listener of [...listeners]) {
    if (listener.addonId === fromAddon && listener.topic === topic) continue;
    if (listener.topic !== topic) continue;
    try {
      await listener.handler(message);
    } catch {
    }
  }
  for (const client of sseClients.values()) {
    if (opts.excludePublisher && client.scope === 'others') continue;
    if (client.topics && !client.topics.has(topic)) continue;
    try {
      client.write(message);
    } catch {
      sseClients.delete(client.id);
    }
  }
}

/** Addon subscribes to a topic. Returns an unsubscribe function. */
export function subscribeBusTopic(
  addonId: string,
  topic: string,
  handler: (payload: AddonBusPayload) => void | Promise<void>,
): () => void {
  const listener: BusListener = { addonId, topic, handler };
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}

/** Client (browser) subscribes to the SSE stream. Returns an unsubscribe. */
export function addSseClient(
  write: (payload: unknown) => void,
  opts: { topics?: string[] | null; scope?: 'any' | 'others' } = {},
): () => void {
  const id = nextClientId++;
  const topics = opts.topics && opts.topics.length > 0 && !opts.topics.includes('*')
    ? new Set(opts.topics)
    : null;
  sseClients.set(id, { id, write, topics, scope: opts.scope ?? 'any' });
  return () => sseClients.delete(id);
}

/** Frames after `lastId` (reconnect replay) — oldest first, bounded by the ring. */
export function replaySince(lastId: number): AddonBusPayload[] {
  if (!Number.isFinite(lastId) || lastId <= 0) return [];
  return replayRing.filter((frame) => (frame.id ?? 0) > lastId);
}

export function sseClientCount(): number {
  return sseClients.size;
}

export function busFrameSeq(): number {
  return frameSeq;
}
