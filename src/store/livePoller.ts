

import { fetchLiveStreams, type LiveStreamInfo } from '../lib/api';


export interface LiveStreamSnapshot {
  
  byConversation: Map<string, string>;
  
  streams: LiveStreamInfo[];
}

type LivePollSubscriber = (snapshot: LiveStreamSnapshot) => boolean | void;

const subscribers = new Set<LivePollSubscriber>();


let lastSnapshot: LiveStreamSnapshot = { byConversation: new Map(), streams: [] };

let timer: number | undefined;
let inFlight = false;
let resting = false;

let lastLiveAt = 0;


const ACTIVE_MS = 2_000;

const COOLDOWN_MS = 4_000;

const REST_AFTER_MS = 30_000;

let visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';

function armNext(delayMs?: number): void {
  if (timer !== undefined || !visible) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    void tick();
  }, delayMs ?? ACTIVE_MS);
}

function enterRest(): void {
  if (resting) return;
  resting = true;
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
}

function leaveRest(): void {
  if (!resting) return;
  resting = false;
  void tick();
}

async function tick(): Promise<void> {
  if (inFlight) {
    armNext();
    return;
  }
  inFlight = true;
  try {
    const streams = await fetchLiveStreams();
    if (!visible) {
      enterRest();
      return;
    }
    if (streams === null) {
      if (Date.now() - lastLiveAt < REST_AFTER_MS) armNext(COOLDOWN_MS);
      else enterRest();
      return;
    }
    const byConversation = new Map<string, string>();
    for (const stream of streams) {
      if (stream.conversationId) byConversation.set(stream.conversationId, stream.id);
    }
    if (streams.length > 0) lastLiveAt = Date.now();
    lastSnapshot = { byConversation, streams };
    for (const subscriber of [...subscribers]) {
      if (subscriber(lastSnapshot) === false) subscribers.delete(subscriber);
    }
    if (streams.length > 0) {
      armNext(ACTIVE_MS);
    } else if (Date.now() - lastLiveAt < REST_AFTER_MS) {
      armNext(COOLDOWN_MS);
    } else {
      enterRest();
    }
  } finally {
    inFlight = false;
  }
}


export function subscribeLivePolls(subscriber: LivePollSubscriber): () => void {
  subscribers.add(subscriber);
  subscriber(lastSnapshot);
  if (subscribers.size === 1) {
    if (resting) leaveRest();
    else if (timer === undefined && !inFlight) void tick();
  }
  return () => subscribers.delete(subscriber);
}


export function refreshLiveStreamsNow(): void {
  leaveRest();
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  void tick();
}


export function ensureLivePolling(): void {
  if (!resting) return;
  leaveRest();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    visible = document.visibilityState !== 'hidden';
    if (visible) {
      if (resting) leaveRest();
      else refreshLiveStreamsNow();
    } else {
      enterRest();
    }
  });
}