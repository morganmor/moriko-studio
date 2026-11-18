import { createRequire } from 'node:module';
import path from 'node:path';

import { runProcess } from './exec.js';


function resolveTsc(): string {
  try {
    return createRequire(path.join(process.cwd(), 'package.json')).resolve('typescript/bin/tsc');
  } catch {
    return path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  }
}




const RELOAD_EXIT_CODE = 75;

let pending = false;
let exitTimer: NodeJS.Timeout | null = null;
let activeStreams = 0;

let pauseDepth = 0;


export function beginStream(): void {
  activeStreams += 1;
}

export function endStream(): void {
  activeStreams = Math.max(0, activeStreams - 1);
  if (pending && activeStreams === 0) armExit();
}


export function pauseStreamSlot(): void {
  if (pauseDepth > 0) {
    pauseDepth += 1;
    return;
  }
  pauseDepth = 1;
  activeStreams = Math.max(0, activeStreams - 1);
  if (pending && activeStreams === 0) armExit();
}


export function resumeStreamSlot(): void {
  if (pauseDepth === 0) return;
  pauseDepth -= 1;
  if (pauseDepth > 0) return;
  activeStreams += 1;
  if (exitTimer && activeStreams > 0) {
    clearTimeout(exitTimer);
    exitTimer = null;
  }
}

export function isReloadPending(): boolean {
  return pending;
}

function armExit(): void {
  if (exitTimer) return;
  exitTimer = setTimeout(() => {
    console.log('[harness-reload] idle — restarting now');
    process.exit(RELOAD_EXIT_CODE);
  }, 600);
  exitTimer.unref?.();
}


export async function harnessReloadNow(): Promise<{ ok: boolean; text: string }> {
  const started = Date.now();
  const outcome = await runProcess(
    'node',
    [resolveTsc(), '-b', 'tsconfig.app.json', 'tsconfig.node.json'],
    { cwd: process.cwd(), timeoutMs: 300_000 },
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      text:
        `Typecheck FAILED (${seconds}s) — reload REFUSED, the running harness is untouched. ` +
        'Fix the errors and reload again.\n\n' +
        outcome.output,
    };
  }
  pending = true;
  if (activeStreams === 0) armExit();
  return {
    ok: true,
    text:
      `Typecheck passed (${seconds}s). Graceful reload scheduled: the server restarts as soon as ` +
      'no stream is active — running replies finish untouched. Tell the user the harness is reloading.',
  };
}
