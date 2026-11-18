import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../atomicWrite.js';
import { jobsDir } from '../paths.js';
import type { ToolImage } from './tools/index.js';



const JOBS_DIR = jobsDir;

const MAX_RUNS_PER_SESSION = 10;

const MAX_TOTAL_RUNS = 500;

const MAX_STORED_TEXT_CHARS = 64_000;

export type RunStatus = 'running' | 'completed' | 'errored' | 'aborted' | 'crashed';

export interface CallRecord {
  
  callId: string;
  wireName: string;
  
  argsKey: string;
  status: 'executed' | 'replayed';
  ok: boolean;
  
  text: string;
  diff?: string;
  
  images?: ToolImage[];
  durationMs: number;
}

export interface JobRecord {
  
  id: string;
  
  sessionId: string | undefined;
  providerId: string;
  model: string;
  
  agentMode: boolean;
  
  webAccess: boolean;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  calls: CallRecord[];
  replaySeq: number;
}


export interface RunSummary {
  id: string;
  sessionId: string | undefined;
  providerId: string;
  model: string;
  agentMode: boolean;
  webAccess: boolean;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  callCount: number;
}

function isRecord(value: unknown): value is JobRecord {
  const record = value as JobRecord;
  return (
    typeof record?.id === 'string' &&
    typeof record?.providerId === 'string' &&
    typeof record?.model === 'string' &&
    typeof record?.agentMode === 'boolean' &&
    (record?.webAccess === undefined || typeof record?.webAccess === 'boolean') &&
    (record?.status === 'running' ||
      record?.status === 'completed' ||
      record?.status === 'errored' ||
      record?.status === 'aborted' ||
      record?.status === 'crashed') &&
    typeof record?.startedAt === 'number' &&
    Array.isArray(record?.calls)
  );
}

function recordFile(runId: string): string {
  return path.join(JOBS_DIR, `${runId}.json`);
}


export function idempotencyKey(runId: string, wireName: string, argsKey: string): string {
  return `${runId}|${wireName}|${argsKey}`;
}


export function normalizeArgsKey(rawArgs: string): string {
  let normalized = rawArgs.trim();
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (parsed && typeof parsed === 'object') {
      normalized = JSON.stringify(parsed, Object.keys(parsed as Record<string, unknown>).sort());
    }
  } catch {
    normalized = normalized.slice(0, 300);
  }
  return normalized;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}


const runContext = new AsyncLocalStorage<RunContext>();


interface RunContext {
  
  record: JobRecord | null;
  
  replay: Map<string, CallRecord> | null;
  replayRunId: string | null;
}


export function withRun<T>(
  runId: string,
  resumeFrom: string | undefined,
  work: () => T,
): T {
  const record = store.load(runId);
  let replay: Map<string, CallRecord> | null = null;
  let replayRunId: string | null = null;
  if (resumeFrom) {
    const predecessor = store.load(resumeFrom);
    if (predecessor && predecessor.calls.length > 0) {
      replay = new Map();
      for (const call of predecessor.calls) {
        replay.set(hashKey(idempotencyKey(predecessor.id, call.wireName, call.argsKey)), call);
      }
      replayRunId = predecessor.id;
    }
  }
  return runContext.run({ record, replay, replayRunId }, work);
}


function currentRun(): RunContext | null {
  return runContext.getStore() ?? null;
}

class JobStore {
  
  private readonly records = new Map<string, JobRecord>();


  private persist(record: JobRecord): void {
    try {
      atomicWriteJson(recordFile(record.id), record);
    } catch (error) {
      console.error('[journal] persist failed:', error);
    }
  }

  
  load(runId: string): JobRecord | null {
    const cached = this.records.get(runId);
    if (cached) return cached;
    try {
      const file = recordFile(runId);
      if (!existsSync(file)) return null;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!isRecord(parsed)) return null;
      this.records.set(runId, parsed);
      return parsed;
    } catch {
      return null;
    }
  }


  
  start(input: {
    runId: string;
    sessionId: string | undefined;
    providerId: string;
    model: string;
    agentMode: boolean;
    webAccess?: boolean;
  }): void {
    if (!input.agentMode) return;
    const record: JobRecord = {
      id: input.runId,
      sessionId: input.sessionId,
      providerId: input.providerId,
      model: input.model,
      agentMode: true,
      webAccess: input.webAccess === true,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      calls: [],
      replaySeq: 0,
    };
    this.records.set(runIdSafe(input.runId), record);
    this.persist(record);
    this.sweep(input.sessionId);
  }

  
  end(runId: string, outcome: 'completed' | 'error' | 'aborted'): void {
    const record = this.records.get(runIdSafe(runId));
    if (!record) return;
    record.status = outcome === 'error' ? 'errored' : outcome;
    record.endedAt = Date.now();
    this.persist(record);
    this.records.delete(record.id);
  }


  
  lookupReplay(wireName: string, argsKey: string): CallRecord | null {
    const ctx = currentRun();
    if (!ctx || !ctx.replay || !ctx.replayRunId) return null;
    if (!wireName.startsWith('agent__')) return null;
    return ctx.replay.get(hashKey(idempotencyKey(ctx.replayRunId, wireName, argsKey))) ?? null;
  }
  
  recordCall(call: {
    callId: string | undefined;
    wireName: string;
    rawArgs: string;
    ok: boolean;
    text: string;
    diff?: string;
    images?: ToolImage[];
    durationMs: number;
  }): string {
    const ctx = currentRun();
    if (!ctx || !ctx.record) return call.callId || `replay:nominal:${nextSeq()}`;
    const record = ctx.record;
    const stored: CallRecord = {
      callId: call.callId || `replay:${record.id}:${(record.replaySeq += 1)}`,
      wireName: call.wireName,
      argsKey: normalizeArgsKey(call.rawArgs),
      status: 'executed',
      ok: call.ok,
      text: call.text.length > MAX_STORED_TEXT_CHARS ? call.text.slice(0, MAX_STORED_TEXT_CHARS) : call.text,
      ...(call.diff ? { diff: call.diff } : {}),
      ...(call.images?.length ? { images: call.images } : {}),
      durationMs: call.durationMs,
    };
    record.calls.push(stored);
    this.persist(record);
    return stored.callId;
  }


  
  sweepCrashed(): RunSummary[] {
    const crashed: RunSummary[] = [];
    try {
      mkdirSync(JOBS_DIR, { recursive: true });
      for (const file of readdirSync(JOBS_DIR)) {
        if (!file.endsWith('.json')) continue;
        const id = file.slice(0, -'.json'.length);
        const record = this.load(id);
        if (!record || record.status !== 'running') continue;
        record.status = 'crashed';
        record.endedAt = Date.now();
        this.persist(record);
        crashed.push(toSummary(record));
        this.records.delete(record.id);
      }
    } catch (error) {
      console.error('[journal] boot sweep failed:', error);
    }
    return crashed;
  }

  
  listBySession(sessionId: string | undefined, limit = 50): RunSummary[] {
    const runs: RunSummary[] = [];
    try {
      if (!existsSync(JOBS_DIR)) return [];
      for (const file of readdirSync(JOBS_DIR)) {
        if (!file.endsWith('.json')) continue;
        const record = this.load(file.slice(0, -'.json'.length));
        if (!record) continue;
        if (sessionId !== undefined && record.sessionId !== sessionId) continue;
        runs.push(toSummary(record));
      }
    } catch {
      return [];
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  
  getRun(runId: string): JobRecord | null {
    return this.load(runId);
  }

  
  private sweep(sessionId: string | undefined): void {
    try {
      const all = this.listAllRaw();
      if (all.length <= MAX_RUNS_PER_SESSION && all.length <= MAX_TOTAL_RUNS) return;
      all.sort((a, b) => b.startedAt - a.startedAt);
      const bySession = new Map<string, number>();
      let kept = 0;
      for (const record of all) {
        const terminal = record.status !== 'running';
        if (!terminal) {
          kept += 1;
          continue;
        }
        const key = record.sessionId ?? '_none';
        const count = (bySession.get(key) ?? 0) + 1;
        if (kept >= MAX_TOTAL_RUNS || (sessionId !== undefined && key === sessionId && count > MAX_RUNS_PER_SESSION)) {
          this.deleteRecord(record.id);
          continue;
        }
        bySession.set(key, count);
        kept += 1;
      }
    } catch (error) {
      console.error('[journal] sweep failed:', error);
    }
  }

  
  private listAllRaw(): JobRecord[] {
    const records: JobRecord[] = [];
    try {
      if (!existsSync(JOBS_DIR)) return records;
      for (const file of readdirSync(JOBS_DIR)) {
        if (!file.endsWith('.json')) continue;
        const record = this.load(file.slice(0, -'.json'.length));
        if (record) records.push(record);
      }
    } catch {
    }
    return records;
  }

  private deleteRecord(runId: string): void {
    try {
      unlinkSync(recordFile(runId));
    } catch {
    }
  }
}

function runIdSafe(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function nextSeq(): number {
  return Date.now();
}

function toSummary(record: JobRecord): RunSummary {
  return {
    id: record.id,
    sessionId: record.sessionId,
    providerId: record.providerId,
    model: record.model,
    agentMode: record.agentMode,
    webAccess: record.webAccess === true,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    callCount: record.calls.length,
  };
}


const store = new JobStore();
export const jobStore = store;

export function startRun(input: {
  runId: string;
  sessionId: string | undefined;
  providerId: string;
  model: string;
  agentMode: boolean;
  webAccess?: boolean;
}): void {
  store.start(input);
}

export function listRuns(sessionId: string | undefined, limit?: number): RunSummary[] {
  return store.listBySession(sessionId, limit);
}

export function readRun(runId: string): JobRecord | null {
  return store.getRun(runId);
}

export function sweepCrashedRuns(): RunSummary[] {
  return store.sweepCrashed();
}


export function endRun(runId: string, outcome: 'completed' | 'error' | 'aborted'): void {
  store.end(runId, outcome);
}
