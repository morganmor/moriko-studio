

import type { AddonBusPayload } from './types.js';

interface BusListener {
  addonId: string;
  topic: string;
  handler: (payload: AddonBusPayload) => void | Promise<void>;
}

interface SseClient {
  id: number;
  write: (payload: unknown) => void;
  
  topics: Set<string> | null;
  
  scope: 'any' | 'others';
}

const listeners: BusListener[] = [];
const sseClients = new Map<number, SseClient>();
let nextClientId = 1;


let frameSeq = 0;
const REPLAY_LIMIT = 500;
const replayRing: AddonBusPayload[] = [];

export interface PublishOptions {
  
  excludePublisher?: boolean;
}


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
