


export const STREAM_IDLE_MS = 600_000;


const MAX_TIMER_MS = 2_147_483_647;


function formatDuration(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}


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


export function isAbortLike(value: unknown): boolean {
  if (value instanceof LivenessTimeout) return true;
  return value instanceof Error && (value.name === 'AbortError' || value.name === 'TimeoutError');
}


export function isLivenessTimeout(value: unknown, code?: string): value is LivenessTimeout {
  return value instanceof LivenessTimeout && (code === undefined || value.code === code);
}

export interface Deadline {
  
  readonly signal: AbortSignal;
  readonly code: string;
  
  readonly timeoutMs: number;
  
  readonly expired: boolean;
  
  clear(): void;
}

function assertBudget(ms: number, code: string): void {
  if (!Number.isFinite(ms) || ms > MAX_TIMER_MS) {
    throw new RangeError(`liveness: ${code} budget must be a finite number of ms <= ${MAX_TIMER_MS} (got ${ms}).`);
  }
}


function detachedSignal(): AbortSignal {
  return new AbortController().signal;
}


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
  
  reset(): void;
}


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


export { detachedSignal };
