import type { ServerResponse } from 'node:http';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { runsDir as RUNS_DIR } from './paths.js';

/**
 * STREAM REGISTRY — a generation survives a browser reload.
 *
 * Before this module, the chat run's life was tied to its socket: the tab
 * reloads, `res` closes, the upstream aborts, tokens stop being earned and
 * the half-built reply evaporates. The client had the resume plumbing
 * (`probeResume`/`resumeChat` in api.ts + the `stream_id` contract) but the
 * server half never landed. This is that half:
 *
 *  - every frame the run emits is BUFFERED (and fanned out to whoever is
 *    attached — the original POST, then re-attachers after a reload);
 *  - when the last subscriber hangs up the run is NOT killed immediately —
 *    a GRACE window keeps it running into the buffer, so the reload can
 *    replay from frame one and continue live;
 *  - a finished run keeps its buffer for a short RETENTION window, so a
 *    reload racing the last token still gets the complete story;
 *  - an explicit STOP (`abortStream`) kills it at once — grace is for
 *    reconnects, not for burning tokens the user just cancelled;
 *  - a run whose buffer outgrows the cap is marked unresumable: the bytes
 *    are dropped, the run continues for whoever is attached, and probes
 *    answer honestly (the client falls back to its normal paths).
 *
 * PHASE 2 — the buffer is also JOURNALED to `~/.moriko/runs/<id>.jsonl` as
 * it is published, so a PROXY CRASH no longer loses the run. The in-memory
 * buffer dies with the process; the journal does not. At boot, a journal
 * whose run never wrote its terminal marker is a run that died mid-flight —
 * it is resurrected as an ENDED, replayable corpse: a reload replays its
 * frames exactly like a finished run's buffer would have, so the user's
 * partial reply is rebuilt instead of evaporating. The 60 s retention / 8 MB
 * cap remain the in-memory bounds; the journal is the durable safety net
 * beneath them.
 */

/** Keep a subscriber-less run alive this long, waiting for a reload. */
const GRACE_MS = 180_000;
/** Keep a finished run's buffer this long (reload racing the final token). */
const RETENTION_MS = 60_000;
/** Hard cap on one stream's buffered frames — big runs degrade, never OOM. */
const MAX_BUFFER_BYTES = 8_000_000;

/**
 * One line of the run journal. The raw SSE frame carries its own `\n\n`, so
 * it rides JSON-encoded — one record per line, always.
 */
type JournalLine =
  | { kind: 'meta'; conversationId: string | null; startedAt: number }
  | { kind: 'frame'; frame: string }
  | { kind: 'end' }
  | { kind: 'overflow' };

function runFile(id: string): string {
  return path.join(RUNS_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
}

interface LiveStream {
  id: string;
  /** Serialized SSE frames (`data: {...}\n\n`) in emit order. */
  frames: string[];
  bytes: number;
  /** False once the buffer overflowed (or was dropped) — replay is then impossible. */
  resumable: boolean;
  ended: boolean;
  subscribers: Set<ServerResponse>;
  abortUpstream: () => void;
  onEnded: () => void;
  graceTimer: NodeJS.Timeout | null;
  purgeTimer: NodeJS.Timeout | null;
  /** Which conversation this run belongs to — drives the sidebar's live badge. */
  conversationId: string | null;
  /** Wall-clock start, so the UI can show "how long" if it ever wants. */
  startedAt: number;
  /**
   * The last moment this run PRODUCED anything (a frame was published). The
   * stall sweeper reads it: a run whose upstream stopped moving is not "live",
   * it is wedged — left alone it holds its provider slot, keeps the sidebar
   * badge spinning for hours, and its record freezes mid-word (the reported
   * "badge jalan, model beku" bug).
   */
  lastFrameAt: number;
  /** The journal file's fd while the run is appending; null when not journaling. */
  journalFd: number | null;
}

const streams = new Map<string, LiveStream>();

/** Best-effort journal append: a disk failure must never break a generation. */
function journalWrite(stream: LiveStream, line: JournalLine): void {
  if (stream.journalFd === null) return;
  try {
    appendFileSync(stream.journalFd, `${JSON.stringify(line)}\n`);
  } catch {
  }
}

/** Closes the journal and deletes the file — the replay is gone either way. */
function journalDrop(stream: LiveStream): void {
  if (stream.journalFd === null) return;
  try {
    closeSync(stream.journalFd);
  } catch {
  }
  stream.journalFd = null;
  try {
    unlinkSync(runFile(stream.id));
  } catch {
  }
}

/**
 * A run with no published frame for this long is WEDGED, not working. It must
 * clear GRACE_MS (a reload legitimately leaves the run subscriber-less for up
 * to three minutes — frames keep flowing into the buffer during grace, so a
 * healthy grace run is never idle this long) plus a margin, before the sweep
 * kills it. Tool rounds that are genuinely slow still publish progress/steer
 * frames; nothing healthy sits silent for four minutes.
 */
export const STALL_TIMEOUT_MS = 240_000;
/** How often the stall sweep evaluates every live run. */
const STALL_SWEEP_MS = 30_000;

let stallSweepTimer: ReturnType<typeof setInterval> | null = null;

/** Periodic liveness sweep: abort runs whose last frame is beyond the stall cap. */
function sweepStalledStreams(): void {
  const now = Date.now();
  for (const stream of streams.values()) {
    if (stream.ended) continue;
    if (now - stream.lastFrameAt <= STALL_TIMEOUT_MS) continue;
    try {
      stream.abortUpstream();
    } catch {
    }
  }
}

/** Start the stall sweep. Call once at boot. */
export function startStallSweeper(): void {
  if (stallSweepTimer) return;
  stallSweepTimer = setInterval(sweepStalledStreams, STALL_SWEEP_MS);
  stallSweepTimer.unref?.();
}

/** Stop the stall sweep (tests). */
export function stopStallSweeper(): void {
  if (stallSweepTimer) {
    clearInterval(stallSweepTimer);
    stallSweepTimer = null;
  }
}

/** Test seam — drops every stream and its timers between suites. */
export function _resetForTests(): void {
  for (const stream of streams.values()) {
    if (stream.graceTimer) clearTimeout(stream.graceTimer);
    if (stream.purgeTimer) clearTimeout(stream.purgeTimer);
  }
  streams.clear();
  if (stallSweepTimer) {
    clearInterval(stallSweepTimer);
    stallSweepTimer = null;
  }
}

export function createStream(
  id: string,
  hooks: { abortUpstream: () => void; onEnded: () => void },
  meta: { conversationId?: string | null } = {},
): void {
  const conversationId = meta.conversationId ?? null;
  let journalFd: number | null = null;
  try {
    mkdirSync(RUNS_DIR, { recursive: true });
    journalFd = openSync(runFile(id), 'w');
  } catch {
  }
  streams.set(id, {
    id,
    frames: [],
    bytes: 0,
    resumable: true,
    ended: false,
    subscribers: new Set(),
    abortUpstream: hooks.abortUpstream,
    onEnded: hooks.onEnded,
    graceTimer: null,
    purgeTimer: null,
    conversationId,
    startedAt: Date.now(),
    lastFrameAt: Date.now(),
    journalFd,
  });
  if (journalFd !== null) {
    journalWrite(streams.get(id)!, { kind: 'meta', conversationId, startedAt: Date.now() });
  }
}

/**
 * Every run that is STILL streaming — the shared truth the sidebar's live
 * badge polls. `conversationId` is null for one-shot helpers (auto-titling)
 * that never told the server which chat they belong to. `lastFrameAt` lets a
 * client distinguish "working" from "wedged" without another endpoint.
 */
export function listLiveStreams(): Array<{ id: string; conversationId: string | null; startedAt: number; lastFrameAt: number }> {
  const live: Array<{ id: string; conversationId: string | null; startedAt: number; lastFrameAt: number }> = [];
  for (const stream of streams.values()) {
    if (!stream.ended) {
      live.push({
        id: stream.id,
        conversationId: stream.conversationId,
        startedAt: stream.startedAt,
        lastFrameAt: stream.lastFrameAt,
      });
    }
  }
  return live;
}

/** Publish one serialized frame: buffer it (while resumable) and fan it out. */
export function publishFrame(id: string, frame: string): void {
  const stream = streams.get(id);
  if (!stream || stream.ended) return;
  stream.lastFrameAt = Date.now();
  if (stream.resumable) {
    if (stream.bytes + frame.length > MAX_BUFFER_BYTES) {
      stream.resumable = false;
      stream.frames = [];
      stream.bytes = 0;
      journalWrite(stream, { kind: 'overflow' });
      journalDrop(stream);
    } else {
      stream.frames.push(frame);
      stream.bytes += frame.length;
      journalWrite(stream, { kind: 'frame', frame });
    }
  }
  for (const res of stream.subscribers) {
    if (!res.writableEnded) res.write(frame);
  }
}

/** The original POST socket attaches as the first subscriber. */
export function attachStream(id: string, res: ServerResponse): void {
  const stream = streams.get(id);
  if (!stream) return;
  stream.subscribers.add(res);
}

/** A socket went away: if it was the last one and the run is live, arm grace. */
export function detachStream(id: string, res: ServerResponse): void {
  const stream = streams.get(id);
  if (!stream) return;
  stream.subscribers.delete(res);
  if (stream.subscribers.size === 0 && !stream.ended) {
    disarmGrace(stream);
    stream.graceTimer = setTimeout(() => {
      stream.graceTimer = null;
      if (stream.subscribers.size === 0 && !stream.ended) stream.abortUpstream();
    }, GRACE_MS);
  }
}

function disarmGrace(stream: LiveStream): void {
  if (stream.graceTimer) {
    clearTimeout(stream.graceTimer);
    stream.graceTimer = null;
  }
}

/** The run is over: stop buffering, close everyone, keep the buffer briefly. */
export function finishStream(id: string): void {
  const stream = streams.get(id);
  if (!stream || stream.ended) return;
  stream.ended = true;
  disarmGrace(stream);
  for (const res of stream.subscribers) {
    if (!res.writableEnded) res.end();
  }
  stream.subscribers.clear();
  journalWrite(stream, { kind: 'end' });
  stream.purgeTimer = setTimeout(() => {
    const current = streams.get(id);
    if (current === stream) streams.delete(id);
    journalDrop(stream);
  }, RETENTION_MS);
  stream.onEnded();
}

/** Explicit Stop: kill the upstream now (its route finally finishes the stream). */
export function abortStream(id: string): boolean {
  const stream = streams.get(id);
  if (!stream || stream.ended) return false;
  disarmGrace(stream);
  stream.abortUpstream();
  return true;
}

export type StreamProbe = 'live' | 'done' | 'unresumable' | 'unknown';

export function probeStream(id: string): StreamProbe {
  const stream = streams.get(id);
  if (!stream) return 'unknown';
  if (!stream.resumable) return 'unresumable';
  return stream.ended ? 'done' : 'live';
}

/**
 * Attach a re-loader: replay the whole buffer into `res`, then either end
 * (the run finished while the page was gone) or tail it live. The caller
 * must have written the SSE headers first — and only after a `probeStream`
 * came back 'live'/'done', which this call repeats synchronously.
 */
export function resumeStream(id: string, res: ServerResponse): 'tailing' | 'replayed-done' | 'unknown' | 'unresumable' {
  const stream = streams.get(id);
  if (!stream) return 'unknown';
  if (!stream.resumable) return 'unresumable';
  for (const frame of stream.frames) {
    if (!res.writableEnded) res.write(frame);
  }
  if (stream.ended) {
    if (!res.writableEnded) res.end();
    return 'replayed-done';
  }
  disarmGrace(stream);
  stream.subscribers.add(res);
  res.on('close', () => detachStream(id, res));
  return 'tailing';
}


/**
 * Reads one journal file into frames + flags. Returns null when the file is
 * absent or unreadable (a deleted/purged run, or a rival writer's leftover).
 */
function readJournal(file: string): {
  frames: string[];
  resumable: boolean;
  terminated: boolean;
  conversationId: string | null;
  startedAt: number;
} | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const frames: string[] = [];
  let resumable = true;
  let terminated = false;
  let conversationId: string | null = null;
  let startedAt = Date.now();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: JournalLine;
    try {
      parsed = JSON.parse(trimmed) as JournalLine;
    } catch {
      continue;
    }
    switch (parsed.kind) {
      case 'meta':
        conversationId = parsed.conversationId;
        startedAt = parsed.startedAt;
        break;
      case 'frame':
        frames.push(parsed.frame);
        break;
      case 'end':
        terminated = true;
        break;
      case 'overflow':
        resumable = false;
        break;
    }
  }
  return { frames, resumable, terminated, conversationId, startedAt };
}

/**
 * BOOT RECOVERY. A journal whose run never wrote `end` is a run that died
 * mid-flight (the process was killed, or crashed between frames). It is
 * resurrected as an ENDED, replayable corpse: probes answer `done` and a
 * reload replays its frames exactly like a finished run's retained buffer.
 *
 * A journal that IS terminated belongs to a run that completed — its frames
 * live on in the conversation store, so the file is simply dropped. An
 * overflowed journal is not replayable and is dropped too.
 *
 * Idempotent: a journal already resurrected into the registry (same id, same
 * process) is left alone.
 */
export function rehydrateRuns(): string[] {
  const resurrected: string[] = [];
  try {
    if (!existsSync(RUNS_DIR)) return resurrected;
    for (const file of readdirSync(RUNS_DIR)) {
      if (!file.endsWith('.jsonl')) continue;
      const id = file.slice(0, -'.jsonl'.length);
      if (streams.has(id)) continue;
      const parsed = readJournal(path.join(RUNS_DIR, file));
      if (!parsed) continue;
      if (parsed.terminated || !parsed.resumable) {
        try {
          unlinkSync(path.join(RUNS_DIR, file));
        } catch {
        }
        continue;
      }
      streams.set(id, {
        id,
        frames: parsed.frames,
        bytes: parsed.frames.reduce((sum, frame) => sum + frame.length, 0),
        resumable: true,
        ended: true,
        subscribers: new Set(),
        lastFrameAt: parsed.startedAt,
        abortUpstream: () => undefined,
        onEnded: () => undefined,
        graceTimer: null,
        purgeTimer: setTimeout(() => {
          const current = streams.get(id);
          if (current) {
            streams.delete(id);
            journalDrop(current);
          }
        }, RETENTION_MS),
        conversationId: parsed.conversationId,
        startedAt: parsed.startedAt,
        journalFd: null,
      });
      try {
        unlinkSync(path.join(RUNS_DIR, file));
      } catch {
      }
      resurrected.push(id);
    }
  } catch (error) {
    console.error('[streams] run-journal rehydration failed:', error);
  }
  return resurrected;
}
