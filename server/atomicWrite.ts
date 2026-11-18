

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';


function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}


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
