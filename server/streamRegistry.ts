import type { ServerResponse } from 'node:http';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { runsDir as RUNS_DIR } from './paths.js';




const GRACE_MS = 180_000;

const RETENTION_MS = 60_000;

const MAX_BUFFER_BYTES = 8_000_000;


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
  
  frames: string[];
  bytes: number;
  
  resumable: boolean;
  ended: boolean;
  subscribers: Set<ServerResponse>;
  abortUpstream: () => void;
  onEnded: () => void;
  graceTimer: NodeJS.Timeout | null;
  purgeTimer: NodeJS.Timeout | null;
  
  conversationId: string | null;
  
  startedAt: number;
  
  lastFrameAt: number;
  
  journalFd: number | null;
}

const streams = new Map<string, LiveStream>();


function journalWrite(stream: LiveStream, line: JournalLine): void {
  if (stream.journalFd === null) return;
  try {
    appendFileSync(stream.journalFd, `${JSON.stringify(line)}\n`);
  } catch {
  }
}


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


export const STALL_TIMEOUT_MS = 240_000;

const STALL_SWEEP_MS = 30_000;

let stallSweepTimer: ReturnType<typeof setInterval> | null = null;


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


export function startStallSweeper(): void {
  if (stallSweepTimer) return;
  stallSweepTimer = setInterval(sweepStalledStreams, STALL_SWEEP_MS);
  stallSweepTimer.unref?.();
}


export function stopStallSweeper(): void {
  if (stallSweepTimer) {
    clearInterval(stallSweepTimer);
    stallSweepTimer = null;
  }
}


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


export function attachStream(id: string, res: ServerResponse): void {
  const stream = streams.get(id);
  if (!stream) return;
  stream.subscribers.add(res);
}


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
