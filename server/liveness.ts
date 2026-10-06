/**
 * LIVENESS PRIMITIVES — the single owner of "how long is too long".
 *
 * Why this module exists (see docs/FREEZE-RESILIENCE.md):
 *
 * Before it, every bound in the server was a hand-rolled `new
 * AbortController()` + `setTimeout` + `clearTimeout`, written six different
 * ways in six files, each with its own idea of what to do when the clock ran
 * out. Two consequences showed up in production:
 *
 *  - a STALLED upstream could not be told apart from a SLOW one, because no
 *    bound distinguished "no bytes yet" from "no bytes for a while";
 *  - nothing carried a MACHINE-READABLE reason, so a killed request, a user
 *    abort, and a network error all arrived as the same shapeless Error.
 *
 * The two shapes a bound can take are genuinely different, so they are two
 * functions here rather than one with a flag:
 *
 *  - `deadline()` — a TOTAL budget. The work gets `ms`, no matter how healthy
 *    it looks.
 *  - `idle()`     — a SILENCE budget. The timer resets on every sign of life,
 *    so a long generation that keeps streaming is never killed while one that
 *    stopped talking is. This is the shape a model stream needs.
 *
 * Both compose with a PARENT signal (a user Stop) and keep the two causes
 * distinguishable: `signal.reason` is a `LivenessTimeout` when the clock ran
 * out, and the parent's own reason when the user aborted. That distinction is
 * what lets the watchdog report honestly instead of guessing.
 *
 * Contract: `ms <= 0` means "no timer" — the bound is disabled. This matches
 * the "empty = unlimited" convention the rest of the settings follow.
 */

/** Node clamps timers above 2^31-1 ms to 1 ms — refuse the value instead. */
const MAX_TIMER_MS = 2_147_483_647;

/** `30s` / `1500ms` — the message a human reads in a tool result. */
function formatDuration(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/** The clock ran out. Carries the code and the budget for logs and reports. */
export class LivenessTimeout extends Error {
  readonly code: string;
  readonly timeoutMs: number;

  constructor(code: string, timeoutMs: number) {
    super(`${code} after ${formatDuration(timeoutMs)}`);
    this.name = 'LivenessTimeout';
    this.code = code;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * True for our own `LivenessTimeout` AND for the platform's abort error.
 *
 * `fetch` rejects with `signal.reason` when one is set, but some runtimes and
 * some internal paths still surface a bare `AbortError`/`TimeoutError`
 * DOMException. Callers that want "was this a bound expiring?" should ask this
 * predicate rather than compare names themselves — that comparison is exactly
 * the duplicated knowledge this module exists to remove.
 */
export function isAbortLike(value: unknown): boolean {
  if (value instanceof LivenessTimeout) return true;
  return value instanceof Error && (value.name === 'AbortError' || value.name === 'TimeoutError');
}

/** True when this specific bound expired (code omitted = any bound). */
export function isLivenessTimeout(value: unknown, code?: string): value is LivenessTimeout {
  return value instanceof LivenessTimeout && (code === undefined || value.code === code);
}

export interface Deadline {
  /** Pass to the work being bounded. Aborts on timeout or on parent abort. */
  readonly signal: AbortSignal;
  readonly code: string;
  /** The budget that was requested (`<= 0` = no timer was armed). */
  readonly timeoutMs: number;
  /** True only when THIS bound's timer expired (not a parent abort). */
  readonly expired: boolean;
  /** Cancels the timer. Idempotent — call it when the work finished early. */
  clear(): void;
}

function assertBudget(ms: number, code: string): void {
  if (!Number.isFinite(ms) || ms > MAX_TIMER_MS) {
    throw new RangeError(`liveness: ${code} budget must be a finite number of ms <= ${MAX_TIMER_MS} (got ${ms}).`);
  }
}

/** A signal that never aborts, for bounds with no parent. */
function detachedSignal(): AbortSignal {
  return new AbortController().signal;
}

/**
 * A TOTAL budget: `ms` milliseconds from now, whatever happens in between.
 * Use for one-shot work (a request, an RPC, a page download).
 */
export function deadline(parent: AbortSignal | undefined, ms: number, code: string): Deadline {
  assertBudget(ms, code);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let expired = false;
  let cleared = false;

  const onParentAbort = (): void => {
    controller.abort(parent?.reason ?? undefined);
  };

  const clear = (): void => {
    if (cleared) return;
    cleared = true;
    if (timer) clearTimeout(timer);
    timer = null;
    parent?.removeEventListener('abort', onParentAbort);
  };

  if (parent?.aborted) {
    onParentAbort();
    return { signal: controller.signal, code, timeoutMs: ms, get expired() { return expired; }, clear };
  }
  parent?.addEventListener('abort', onParentAbort, { once: true });

  if (ms > 0) {
    timer = setTimeout(() => {
      timer = null;
      expired = true;
      controller.abort(new LivenessTimeout(code, ms));
    }, ms);
  }

  return {
    signal: controller.signal,
    code,
    timeoutMs: ms,
    get expired() {
      return expired;
    },
    clear,
  };
}

export interface IdleBound extends Deadline {
  /** Re-arms the timer. Call on every sign of life (each chunk received). */
  reset(): void;
}

/**
 * A SILENCE budget: `ms` of no activity. `reset()` on every chunk. Use for
 * streams, where a long transfer is healthy but a quiet one is not.
 */
export function idle(parent: AbortSignal | undefined, ms: number, code: string): IdleBound {
  assertBudget(ms, code);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let expired = false;
  let cleared = false;

  const onParentAbort = (): void => {
    controller.abort(parent?.reason ?? undefined);
  };

  const clear = (): void => {
    if (cleared) return;
    cleared = true;
    if (timer) clearTimeout(timer);
    timer = null;
    parent?.removeEventListener('abort', onParentAbort);
  };

  const reset = (): void => {
    if (cleared || expired) return;
    if (timer) clearTimeout(timer);
    if (ms <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      expired = true;
      controller.abort(new LivenessTimeout(code, ms));
    }, ms);
  };

  if (parent?.aborted) {
    onParentAbort();
    return { signal: controller.signal, code, timeoutMs: ms, get expired() { return expired; }, clear, reset };
  }
  parent?.addEventListener('abort', onParentAbort, { once: true });
  reset();

  return {
    signal: controller.signal,
    code,
    timeoutMs: ms,
    get expired() {
      return expired;
    },
    clear,
    reset,
  };
}

/**
 * Promise-shaped total budget: runs `work` with a bounded signal and rejects
 * with `LivenessTimeout` when the clock runs out first.
 *
 * The work's own settlement is never awaited after the bound expires — a
 * late rejection is absorbed, so a slow-then-failing operation cannot become
 * an unhandled rejection just because we stopped listening.
 */
export async function withDeadline<T>(
  ms: number,
  code: string,
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const bound = deadline(parent, ms, code);
  if (bound.timeoutMs <= 0) {
    try {
      return await work(bound.signal);
    } finally {
      bound.clear();
    }
  }
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(bound.signal.reason ?? new LivenessTimeout(code, ms));
      };
      if (bound.signal.aborted) {
        onAbort();
        return;
      }
      bound.signal.addEventListener('abort', onAbort, { once: true });
      work(bound.signal).then(
        (value) => {
          if (settled) return;
          settled = true;
          bound.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          bound.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  } finally {
    bound.clear();
  }
}

/** Re-exported so callers can build a parent-less signal without a controller. */
export { detachedSignal };
