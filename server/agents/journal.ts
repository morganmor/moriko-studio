import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from '../atomicWrite.js';
import { jobsDir } from '../paths.js';
import type { ToolImage } from './tools/index.js';

/**
 * JOB JOURNAL — Tier 1 durable agent runs (see docs/ARCHITECTURE.md).
 *
 * An agent run used to live inside one HTTP request in process memory. The
 * stream registry separated the SOCKET from the STREAM (a reload replays the
 * buffer); this separates the STREAM from the RUN. One JSON record per run,
 * under `~/.moriko/jobs/<runId>.json`, holding every tool call that already
 * executed plus its result.
 *
 * The payoff is IDEMPOTENT REPLAY: when a crashed run is resumed by re-sending
 * its conversation, a mutating tool call with the same (run, tool, args) key
 * returns its stored result instead of touching the filesystem again. No
 * double edit_file, no double delete, no second process spawn. The model
 * never re-derives a branch it cannot see — the user pressing Resume is the
 * supervisor.
 *
 * Trust boundary: the journal lives under `~/.moriko/`, which the read-policy
 * self-host guard already forbids the agent from reading or writing. A model
 * cannot tamper with its own replay log.
 *
 * Concurrency: Moriko streams MANY conversations at once — the stream registry
 * is a Map and the reload slot a counter, not a flag. A module-global run id
 * or a singleton replay map would clobber one run's tool calls onto another's
 * record mid-flight, or let run B's resume disarm run A's guard exactly while
 * A still needs it. Both the run id and the replay map therefore ride
 * AsyncLocalStorage, pinned to ONE request's async chain (see withRun).
 *
 * Best-effort throughout: a journal failure must never break a generation.
 * The run still works; only replay protection is lost.
 */

const JOBS_DIR = jobsDir;
/** Keep this many runs per session; oldest beyond it are swept. */
const MAX_RUNS_PER_SESSION = 10;
/** Global backstop for a user with very many conversations. */
const MAX_TOTAL_RUNS = 500;
/** Cap a stored tool output — matches the stream registry's frame cap order. */
const MAX_STORED_TEXT_CHARS = 64_000;

export type RunStatus = 'running' | 'completed' | 'errored' | 'aborted' | 'crashed';

export interface CallRecord {
  /** Provider call id, or a synthesized stable id when the provider gave none. */
  callId: string;
  wireName: string;
  /** Normalized args (key-sorted) — half of the idempotency key. */
  argsKey: string;
  status: 'executed' | 'replayed';
  ok: boolean;
  /** Pruned output exactly as the model saw it (stored == wire). */
  text: string;
  diff?: string;
  /**
   * Inline images the result carried (read_file on an image). Persisted so a
   * REPLAYED call re-attaches the same picture instead of degrading to text.
   * Bounded by the wire policy — only read_file produces them.
   */
  images?: ToolImage[];
  durationMs: number;
}

export interface JobRecord {
  /** == streamId, so a crashed run is findable from the conversation alone. */
  id: string;
  /** Conversation id — the harness session key (goals, vault, read-state). */
  sessionId: string | undefined;
  providerId: string;
  model: string;
  /** True only when agent tools rode this run's catalogue. */
  agentMode: boolean;
  /** Web access kill-switch state at run start (settings.webAccess). */
  webAccess: boolean;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  calls: CallRecord[];
  replaySeq: number;
}

/** Public list view: everything except the call log. */
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

/**
 * THE IDEMPOTENCY KEY. Same normalization the stall guard uses
 * (toolCallSignature in the tool loop) so "the same call" means the same
 * thing in both places — a stall and a replay cannot disagree.
 */
export function idempotencyKey(runId: string, wireName: string, argsKey: string): string {
  return `${runId}|${wireName}|${argsKey}`;
}

/**
 * Normalizes raw tool arguments into a stable comparison key: parse, sort the
 * object keys, re-serialize. Truncated/unparseable args keep a bounded raw
 * form (two identical truncations still match).
 */
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

/**
 * AsyncLocalStorage is exactly what the async-chain property needs — it
 * survives `await` and every callback the adapters spin up, without threading
 * a parameter through three provider signatures. Run A's tool round cannot
 * observe run B's id even when both spin concurrently in one event loop.
 */
const runContext = new AsyncLocalStorage<RunContext>();

/** One request's pinned journal context. */
interface RunContext {
  /** The record this request's tool calls are appended to. Null for a run
   * that never opened a journal (plain chat): the guards in recordCall keep
   * the call ids stable without persisting anything. */
  record: JobRecord | null;
  /** The run being REPLAYED (the crashed predecessor), else this run itself. */
  replay: Map<string, CallRecord> | null;
  replayRunId: string | null;
}

/**
 * The chat route wraps its whole generation in this. Every `await`, every
 * callback, every tool round inside stays inside its OWN context: parallel
 * agent runs can never write to or read from each other's journal state.
 *
 * `resumeFrom` is the crashed predecessor's id: its executed calls are loaded
 * as THIS request's idempotency map before the first tool round. Absent or
 * gone — the map is simply empty and the request runs like today.
 */
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

/** The current request's journal context, or null outside a generation. */
function currentRun(): RunContext | null {
  return runContext.getStore() ?? null;
}

class JobStore {
  /** runId -> record (loaded lazily; runs that never crash are never read). */
  private readonly records = new Map<string, JobRecord>();


  private persist(record: JobRecord): void {
    try {
      atomicWriteJson(recordFile(record.id), record);
    } catch (error) {
      console.error('[journal] persist failed:', error);
    }
  }

  /** Loads one record from disk (no cache — resumed runs are rare). */
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


  /**
   * Called by the chat route when a run starts. Writes nothing when the run
   * has no agent tools — plain chat never touches the journal.
   */
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

  /** Terminal transition; `error` maps to `errored`, an abort to `aborted`. */
  end(runId: string, outcome: 'completed' | 'error' | 'aborted'): void {
    const record = this.records.get(runIdSafe(runId));
    if (!record) return;
    record.status = outcome === 'error' ? 'errored' : outcome;
    record.endedAt = Date.now();
    this.persist(record);
    this.records.delete(record.id);
  }


  /**
   * The idempotency guard for the CURRENT request. Returns the stored result
   * when this exact call already executed under THIS run's replay map, else
   * null. Only agent tools are guarded — MCP servers are external processes
   * whose effects the harness cannot inspect, and pretending otherwise would
   * be a false promise.
   *
   * Read from AsyncLocalStorage, never a module field: run B's guard must not
   * see run A's map when both are live.
   */
  lookupReplay(wireName: string, argsKey: string): CallRecord | null {
    const ctx = currentRun();
    if (!ctx || !ctx.replay || !ctx.replayRunId) return null;
    if (!wireName.startsWith('agent__')) return null;
    return ctx.replay.get(hashKey(idempotencyKey(ctx.replayRunId, wireName, argsKey))) ?? null;
  }
  /**
   * Records one executed call against THIS request's record. `text` is the
   * pruned output the model saw; `callId` falls back to a synthesized stable
   * id so the follow-up pairing survives a provider that emitted none.
   *
   * The record is looked up by CONTEXT, not by a passed-in id — the caller
   * never has the chance to hand over the wrong one.
   */
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


  /**
   * BOOT RECOVERY. A record still `running` when the process comes up died
   * mid-run: mark it `crashed` so the client can surface a decision. Runs
   * that ended cleanly are left as they were. Idempotent — safe to call more
   * than once (tests, double boot).
   */
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

  /** Runs for one session, newest first. */
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

  /** One record's full detail, or null when unknown/corrupt. */
  getRun(runId: string): JobRecord | null {
    return this.load(runId);
  }

  /**
   * Retention: per session keep the newest MAX_RUNS_PER_SESSION, and a global
   * backstop. Terminal records only — a running run is never swept out from
   * under itself.
   */
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

  /** Loads every record on disk — the sweep and boot scan use it. */
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

/**
 * Process-wide singleton, like the provider store — but with NO request state
 * on it. The run id and the replay map both ride AsyncLocalStorage (withRun),
 * so parallel runs each carry their own. Nothing here can be clobbered.
 *
 * Exported for the two consumers that are ALWAYS inside a request's own
 * context: the chat route (start/end/sweep) and the tool loop (the
 * context-scoped lookupReplay/recordCall). Neither can reach another run's
 * state — the context, not an argument, decides whose record is touched.
 */
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

/**
 * Terminal transition. Called from INSIDE the request's own context (the
 * chat route's finally), so the record is the one this chain owns — never
 * another live run's. `error` maps to `errored`, an abort to `aborted`.
 */
export function endRun(runId: string, outcome: 'completed' | 'error' | 'aborted'): void {
  store.end(runId, outcome);
}
