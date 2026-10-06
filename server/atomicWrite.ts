/**
 * ATOMIC JSON WRITE — one shared, EPERM-resilient implementation for every
 * tmp+rename persist site in the server.
 *
 * Why it exists: Windows refuses `rename` (EPERM) while another handle holds
 * the DESTINATION — the indexer, a virus scanner, or the tail end of a server
 * restart re-reading the file. Seven modules used to hand-roll tmp+rename
 * with a single attempt and a best-effort catch: the persist silently failed
 * exactly around restarts, when durability matters most.
 *
 * The ladder, in order:
 *   1. write tmp + rename  (atomic — the normal path)
 *   2. retry the rename    (3×, backoff ~50/150/400 ms — a scanner releases
 *                           the handle within milliseconds)
 *   3. fall back to a DIRECT write (atomicity lost, data kept — a torn file
 *      on a power cut is better than NO file)
 * The tmp file is always cleaned up best-effort.
 *
 * Synchronous on purpose: every call site is a sync persist() inside a
 * best-effort try/catch; making this async would ripple through all of them.
 * The sync sleep is `Atomics.wait` — legal on Node's main thread.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Sync sleep via Atomics.wait — blocks this thread, nothing else. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Injectable filesystem operations — the test seam for simulated EPERM. */
export interface AtomicWriteOps {
  mkdir: typeof mkdirSync;
  write: typeof writeFileSync;
  rename: typeof renameSync;
  unlink: typeof unlinkSync;
  sleep: (ms: number) => void;
}

const defaultOps: AtomicWriteOps = {
  mkdir: mkdirSync,
  write: writeFileSync,
  rename: renameSync,
  unlink: unlinkSync,
  sleep: sleepSync,
};

const DEFAULT_BACKOFF_MS = [50, 150, 400];

export function atomicWriteJson(
  file: string,
  payload: unknown,
  opts: { ops?: Partial<AtomicWriteOps>; backoffMs?: number[] } = {},
): void {
  const ops: AtomicWriteOps = { ...defaultOps, ...opts.ops };
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const data = `${JSON.stringify(payload, null, 2)}\n`;
  ops.mkdir(path.dirname(file), { recursive: true });

  const tmp = `${file}.tmp`;
  let lastError: unknown;
  let renameWorked = false;
  try {
    ops.write(tmp, data);
    for (const waitMs of backoff) {
      try {
        ops.rename(tmp, file);
        renameWorked = true;
        break;
      } catch (error) {
        lastError = error;
        ops.sleep(waitMs);
      }
    }
  } catch (error) {
    lastError = error;
  }

  if (!renameWorked) {
    try {
      ops.write(file, data);
    } catch {
      throw lastError ?? new Error(`atomicWriteJson failed for ${file}`);
    }
  }

  try {
    ops.unlink(tmp);
  } catch {
  }
}
