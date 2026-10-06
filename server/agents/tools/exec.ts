/**
 * agent__exec — the tool-call ORCHESTRATOR (layer 2).
 *
 * The model emits ONE JavaScript program; a Node `vm` sandbox runs it with a
 * `tools.*` proxy that dispatches nested `agent__*` calls through the SAME
 * pipeline every top-level call uses (schema validation → audit → spatial
 * gate → handler → transform → postExecute). Only the accumulated `text()`
 * output re-enters the model context — the intermediate tool results do NOT.
 *
 * This kills 3-15× model round-trips for non-visual work: parallel reads
 * (Promise.allSettled), conditional follow-ups (if/else on a parsed JSON
 * field), retry loops, paging — all expressed in one program, one model turn,
 * wall-clock ≈ max(tool latency) instead of sum + N×decode.
 *
 * The visual loop (screenshot → judge → click) CANNOT be folded — the isolate
 * has no eyes. `image()` / `view_image` only ferry pixels back to the model.
 * The vision gate is the exit: the orchestrator runs the deterministic prefix,
 * yields a screenshot, and the model decides the next step.
 *
 * Safety posture:
 *  - The sandbox context has NO `require`, `process`, `fs`, `child_process`,
 *    `global`, `Buffer`, or `fetch`. It has only: `tools`, `text`, `store`,
 *    `load`, `notify`, `setTimeout`, `clearTimeout`, `exit`, `console` (noop),
 *    `JSON`, `Math`, `Date`, `RegExp`, `Promise`, `Array`, `Object`, `String`,
 *    `Number`, `Boolean`, `Error`, `Set`, `Map`, `Symbol`, `isFinite`,
 *    `isNaN`, `parseInt`, `parseFloat`, and top-level `await`.
 *  - `tools.*` is a Proxy: every property access returns an async dispatcher
 *    that calls `callAgentTool('agent__' + name, args, ctx)`. Nested calls
 *    re-enter the FULL pipeline, so the `agent__run` approval gate, the
 *    workspace jail, and the spatial gate all still apply. The orchestrator
 *    CANNOT bypass them — it can only call what the model could call directly.
 *  - Global timeout (Promise.race, default 30s), max nested calls (200), max
 *    output chars (MAX_OUTPUT_CHARS). When the script ends, unawaited
 *    promises are discarded — same semantics as the Astra isolate.
 *
 * State:
 *  - `store(key, value)` / `load(key)` — a session-scoped Map keyed by
 *    `ctx.sessionId`. Persists across exec calls in the same conversation,
 *    dies with the session. Values must be JSON-serializable.
 *
 * v1 scope (deliberately minimal):
 *  - `image()` and `yield_control()` are NOT implemented — they need a richer
 *    result channel (ToolImage + streaming) that v1's `text`-only return
 *    cannot carry. Add when the browser feature needs the vision gate.
 */
import vm from 'node:vm';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput, requireWorkspace } from './shared.js';
import { callAgentTool } from './dispatcher.js';


const sessionStores = new Map<string, Map<string, unknown>>();

function getStore(sessionId: string | undefined): Map<string, unknown> {
  const key = sessionId ?? '__default__';
  let store = sessionStores.get(key);
  if (!store) {
    store = new Map();
    sessionStores.set(key, store);
  }
  return store;
}


const MAX_NESTED_CALLS = 200;
const DEFAULT_TIMEOUT_MS = 30_000;


/**
 * Builds the sandbox globals for one exec call. The `tools` Proxy is the
 * heart: every `tools.foo(args)` dispatches back through the full pipeline.
 */
function buildSandbox(ctx: AgentToolContext, state: {
  output: string[];
  nestedCalls: number;
  timedOut: boolean;
  exited: boolean;
}) {
  const store = getStore(ctx.sessionId);

  const tools = new Proxy({} as Record<string, (args: Record<string, unknown>) => Promise<HarnessToolResult>>, {
    get(_target, prop: string) {
      if (state.exited || state.timedOut) {
        return async () => ({ ok: false, isError: true, text: 'exec has exited or timed out — no further tool calls are accepted.' });
      }
      if (state.nestedCalls >= MAX_NESTED_CALLS) {
        return async () => ({
          ok: false,
          isError: true,
          text: `Nested tool call limit reached (${MAX_NESTED_CALLS}). The orchestrator loop is likely stuck — split the work or add a break condition.`,
        });
      }
      state.nestedCalls += 1;
      const wireName = `agent__${prop}`;
      return async (args: Record<string, unknown>) => {
        const result = await callAgentTool(wireName, args ?? {}, ctx);
        return result;
      };
    },
  });

  const text = (value: unknown): void => {
    if (state.exited || state.timedOut) return;
    if (value === undefined || value === null) return;
    const s = typeof value === 'string' ? value : safeStringify(value);
    state.output.push(s);
  };

  const storeFn = (key: string, value: unknown): void => {
    store.set(key, value);
  };
  const loadFn = (key: string): unknown => store.get(key);

  const notify = (value: unknown): void => {
    if (ctx.onProgress) {
      const s = typeof value === 'string' ? value : safeStringify(value);
      ctx.onProgress(s);
    }
  };

  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextTimerId = 1;
  const setTimeoutFn = (callback: () => void, delayMs?: number): number => {
    const id = nextTimerId++;
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      try { callback(); } catch {  }
    }, Math.min(Math.max(delayMs ?? 0, 0), 60_000)));
    return id;
  };
  const clearTimeoutFn = (id?: number): void => {
    if (id !== undefined && timers.has(id)) {
      clearTimeout(timers.get(id));
      timers.delete(id);
    }
  };

  const exit = (): void => {
    state.exited = true;
  };

  return {
    tools,
    text,
    store: storeFn,
    load: loadFn,
    notify,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    exit,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
  };
}

/** JSON.stringify that never throws on circular structures. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 0);
  } catch {
    return String(value);
  }
}

/** Wraps user code in an async IIFE so top-level `await` works. */
function wrapUserCode(code: string): string {
  return `(async () => {\n${code}\n})();`;
}

/**
 * Runs the user's JS in a vm sandbox with the orchestrator globals.
 * Returns the accumulated `text()` output.
 */
async function runOrchestrator(
  code: string,
  ctx: AgentToolContext,
  timeoutMs: number,
): Promise<{ text: string; nestedCalls: number; timedOut: boolean; error: string | null }> {
  requireWorkspace(ctx);

  const state = {
    output: [] as string[],
    nestedCalls: 0,
    timedOut: false,
    exited: false,
  };

  const sandbox = buildSandbox(ctx, state);

  const contextObj = {
    tools: sandbox.tools,
    text: sandbox.text,
    store: sandbox.store,
    load: sandbox.load,
    notify: sandbox.notify,
    setTimeout: sandbox.setTimeout,
    clearTimeout: sandbox.clearTimeout,
    exit: sandbox.exit,
    console: sandbox.console,
    JSON,
    Math,
    Date,
    RegExp,
    Promise,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Error,
    Set,
    Map,
    Symbol,
    isFinite,
    isNaN,
    parseInt,
    parseFloat,
  };

  const vmContext = vm.createContext(contextObj);
  const wrapped = wrapUserCode(code);

  let pending: Promise<unknown>;
  try {
    const result = vm.runInContext(wrapped, vmContext, { timeout: timeoutMs });
    pending = (result ?? Promise.resolve()) as Promise<unknown>;
  } catch (error) {
    return {
      text: '',
      nestedCalls: 0,
      timedOut: false,
      error: `Syntax error in exec script: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      state.timedOut = true;
      reject(new Error(`exec timed out after ${timeoutMs}ms — the script did not finish. Pending tool calls were aborted.`));
    }, timeoutMs);
  });

  let error: string | null = null;
  try {
    await Promise.race([pending, timeoutPromise]);
  } catch (err) {
    if (state.timedOut) {
      error = `exec timed out after ${timeoutMs}ms — the script did not finish. Check for infinite loops or missing await on long operations.`;
    } else {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const output = state.output.join('\n');
  return {
    text: output,
    nestedCalls: state.nestedCalls,
    timedOut: state.timedOut,
    error,
  };
}


export async function execTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const code = str(args, 'code');
  if (!code.trim()) {
    return { ok: false, isError: true, text: 'exec needs a "code" string — the JavaScript program to run.' };
  }

  const timeoutMs = Math.min(Math.max(num(args, 'timeoutMs') ?? DEFAULT_TIMEOUT_MS, 1_000), 120_000);

  const result = await runOrchestrator(code, ctx, timeoutMs);

  const parts: string[] = [];
  if (result.text) {
    parts.push(result.text);
  }
  const footer = `\n── exec · ${result.nestedCalls} nested call(s)${result.timedOut ? ' · TIMED OUT' : ''}${result.error ? ' · error' : ''}`;
  parts.push(footer);

  if (result.error && !result.text) {
    return {
      ok: false,
      isError: true,
      text: truncateOutput(result.error),
    };
  }

  if (result.error && result.text) {
    parts.push(`\n${result.error}`);
  }

  return {
    ok: !result.timedOut && !result.error,
    isError: result.timedOut || !!result.error,
    text: truncateOutput(parts.join('\n')),
  };
}
