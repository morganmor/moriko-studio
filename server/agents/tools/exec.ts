
import vm from 'node:vm';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput, requireWorkspace } from './shared.js';
import { callAgentTool } from './dispatcher.js';
import { requestApproval } from '../permissions.js';


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



function buildSandbox(ctx: AgentToolContext, state: {
  output: string[];
  nestedCalls: number;
  timedOut: boolean;
  exited: boolean;
  
  diffs: string[];
  diffstat: { added: number; removed: number };
  files: string[];
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
        if (result.ok && result.diff) {
          state.diffs.push(result.diff);
          if (result.diffstat) {
            state.diffstat.added += result.diffstat.added;
            state.diffstat.removed += result.diffstat.removed;
          }
          const path = typeof (args as { path?: unknown }).path === 'string'
            ? (args as { path: string }).path
            : null;
          if (path && !state.files.includes(path)) state.files.push(path);
        }
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


function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 0);
  } catch {
    return String(value);
  }
}


function wrapUserCode(code: string): string {
  return `(async () => {\n${code}\n})();`;
}


async function runOrchestrator(
  code: string,
  ctx: AgentToolContext,
  timeoutMs: number,
): Promise<{
  text: string;
  nestedCalls: number;
  timedOut: boolean;
  error: string | null;
  diff: string | null;
  diffstat: { added: number; removed: number } | undefined;
}> {
  requireWorkspace(ctx);

  const state = {
    output: [] as string[],
    nestedCalls: 0,
    timedOut: false,
    exited: false,
    diffs: [] as string[],
    diffstat: { added: 0, removed: 0 },
    files: [] as string[],
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
      diff: null,
      diffstat: undefined,
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
  const mutationNote =
    state.files.length > 0
      ? `\n── mutated ${state.files.length} file(s): ${state.files.join(', ')}`
      : '';
  return {
    text: output + mutationNote,
    nestedCalls: state.nestedCalls,
    timedOut: state.timedOut,
    error,
    diff: state.diffs.length > 0 ? state.diffs.join('\n') : null,
    diffstat:
      state.diffstat.added > 0 || state.diffstat.removed > 0 ? state.diffstat : undefined,
  };
}


export async function execTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const mode = ctx.terminalMode ?? 'auto';
  if (mode === 'off') {
    return {
      ok: false,
      isError: true,
      text:
        'Execution tools are turned OFF in the harness settings. Ask the user to enable Terminal (Ask or Auto) if exec is needed.',
    };
  }

  const code = str(args, 'code');
  if (!code.trim()) {
    return { ok: false, isError: true, text: 'exec needs a "code" string — the JavaScript program to run.' };
  }

  if (mode === 'ask') {
    const { root } = requireWorkspace(ctx);
    const decision = await requestApproval(
      {
        tool: 'exec',
        paths: [root],
        root,
        intent: 'exec',
        command: `agent__exec script (${code.length} chars): ${code.trim().slice(0, 140)}`,
      },
      ctx,
    );
    if (!decision.granted) {
      return {
        ok: false,
        isError: true,
        errorCode: 'approval_denied',
        text: `The user did not approve running agent__exec.${decision.reason ? ` Reason: "${decision.reason}".` : ''}`,
      };
    }
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
    ...(result.diff ? { diff: result.diff } : {}),
    ...(result.diffstat ? { diffstat: result.diffstat } : {}),
  };
}
