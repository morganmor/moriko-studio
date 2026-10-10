/**
 * Addon bus — cross-session pub/sub + client push fanout.
 *
 * Enables addons like Realtime-Shared-PRD: an event published in session A
 * (claim "Achievement 003") reaches (a) every other addon's hooks via the
 * global bus and (b) every connected browser via SSE, so widget panels update
 * in realtime without polling.
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
}

const listeners: BusListener[] = [];
const sseClients = new Map<number, SseClient>();
let nextClientId = 1;

/** Publish to the bus: all addon listeners + every connected browser. */
export async function publishBusEvent(topic: string, payload: Record<string, unknown>, fromAddon: string): Promise<void> {
  const message: AddonBusPayload = {
    topic,
    payload,
    addonId: fromAddon,
    ts: Date.now(),
  };
  for (const listener of [...listeners]) {
    if (listener.addonId === fromAddon && listener.topic === topic) continue;
    if (listener.topic !== topic) continue;
    try {
      await listener.handler(message);
    } catch {
    }
  }
  for (const client of sseClients.values()) {
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
export function addSseClient(write: (payload: unknown) => void): () => void {
  const id = nextClientId++;
  sseClients.set(id, { id, write });
  return () => sseClients.delete(id);
}

export function sseClientCount(): number {
  return sseClients.size;
}
