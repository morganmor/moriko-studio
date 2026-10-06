/**
 * THE LIVE PRESENCE POLLER — one shared, adaptive poller at store level.
 *
 * The performance audit measured TWO INDEPENDENT POLLERS hammering
 * `/api/chat/live` every ~3s (Sidebar's self-contained chain) and every ~4s
 * (useChatController's honesty/re-attach loop) — ~25 chat/live requests in
 * 44s on a fresh boot. Both consumed the SAME registry with the SAME shape,
 * so they now consume ONE poller instead of each owning one.
 *
 * Cadence is ADAPTIVE and the acceptances demand REST:
 *
 *   - ≥1 live stream anywhere    → 2s tick  (a run the user is watching)
 *   - nothing live, but <30s ago → 4s tick  (cool-down after runs)
 *   - nothing live for ≥30s      → REST     (zero periodic requests — the
 *     "idle 30 detik = 0 periodik" acceptance is a HARD REST, not a slow
 *     poll; a new send/attach re-arms the loop explicitly)
 *
 * The tab being HIDDEN pauses the loop entirely; returning fires one
 * catch-up tick immediately. A failed poll backs off one step (server
 * restarting must not tighten the hammering) and keeps the last map —
 * a restarting proxy must not flicker every badge off.
 *
 * API:
 *   subscribeLivePolls(cb)     — cb(snapshot) every tick; return false to
 *                                unsubscribe lazily. The CURRENT snapshot is
 *                                delivered synchronously on subscribe (before
 *                                any network work) so a fresh consumer paints
 *                                from known truth at once.
 *   refreshLiveStreamsNow()    — force one immediate tick (Stop/attach);
 *                                idempotent, re-arms the SAME chain.
 *   ensureLivePolling()        — re-arm the loop after REST (send/attach paths
 *                                call this; an armed loop is a no-op).
 *
 * Singletons at module scope survive HMR remounts.
 */

import { fetchLiveStreams, type LiveStreamInfo } from '../lib/api';

/** The shape every consumer receives each tick. */
export interface LiveStreamSnapshot {
  /** conversationId → stream id (one-shot helpers carry no conversationId). */
  byConversation: Map<string, string>;
  /** Raw registry rows, pass-through. */
  streams: LiveStreamInfo[];
}

type LivePollSubscriber = (snapshot: LiveStreamSnapshot) => boolean | void;

const subscribers = new Set<LivePollSubscriber>();

/** The freshest snapshot — a new subscriber receives it synchronously. */
let lastSnapshot: LiveStreamSnapshot = { byConversation: new Map(), streams: [] };

let timer: number | undefined;
let inFlight = false;
let resting = false;
/** The last tick that saw a live stream — drives the cool-down → REST ladder. */
let lastLiveAt = 0;

/** Cadence while something is live anywhere (a watched run). */
const ACTIVE_MS = 2_000;
/** Cadence right after the last run ended (catch stragglers/relaunches). */
const COOLDOWN_MS = 4_000;
/** Rest after this long with nothing live: zero periodic requests. */
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

/** Subscribe; return false from the callback to unsubscribe lazily. */
export function subscribeLivePolls(subscriber: LivePollSubscriber): () => void {
  subscribers.add(subscriber);
  subscriber(lastSnapshot);
  if (subscribers.size === 1) {
    if (resting) leaveRest();
    else if (timer === undefined && !inFlight) void tick();
  }
  return () => subscribers.delete(subscriber);
}

/** Forces one immediate poll (idempotent — re-arms the SAME chain). */
export function refreshLiveStreamsNow(): void {
  leaveRest();
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  void tick();
}

/** Re-arms the loop after REST (send/attach paths call this on activity). */
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