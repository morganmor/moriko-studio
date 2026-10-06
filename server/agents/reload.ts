import { createRequire } from 'node:module';
import path from 'node:path';

import { runProcess } from './exec.js';

/**
 * Resolve the repo-local TypeScript compiler. The gate spawns `tsc` DIRECTLY
 * (via node) instead of `pnpm typecheck`: a package-manager wrapper carries
 * pre-run hooks (dependency verification, installs) that turn a plain
 * compile into an environment-sensitive side effect. `node` is on the exec
 * allowlist, so the gate needs no extra permissions.
 */
function resolveTsc(): string {
  try {
    return createRequire(path.join(process.cwd(), 'package.json')).resolve('typescript/bin/tsc');
  } catch {
    return path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  }
}

/**
 * GRACEFUL HARNESS RELOAD — the mechanism that lets the agent edit the
 * harness (its own running server) without killing its own stream.
 *
 * The server runs under a supervisor (scripts/dev-server.mjs). Editing files
 * no longer restarts anything by itself: after a batch of edits the agent
 * calls agent__harness_reload (or POST /api/agent/harness-reload), which
 *
 *   1. runs `pnpm typecheck` as the APPLY GATE — broken code never goes
 *      live (refusal returns the compiler output to the model instead),
 *   2. marks a reload pending and exits with code 75 ONLY when no chat
 *      stream is active — running replies finish untouched,
 *   3. the supervisor sees exit 75 and respawns immediately.
 *
 * Clients never observe a torn stream: the reply the model was writing
 * completes first, and the next request hits the fresh server.
 */

/** Exit code the supervisor understands as "clean reload, restart now". */
const RELOAD_EXIT_CODE = 75;

let pending = false;
let exitTimer: NodeJS.Timeout | null = null;
let activeStreams = 0;
/** Refcount of concurrent tool calls holding a paused slot. A boolean would
 *  under-count when several read-only tools run in parallel (executeCalls):
 *  4 pauses then 4 resumes must net zero, not -3 then +4. */
let pauseDepth = 0;

/**
 * Every streaming chat request holds one slot for its whole lifetime — UNLESS
 * it is in the middle of a TOOL CALL. Tool execution (agent harness or MCP)
 * is safe to interrupt mid-flight: the follow-up round starts fresh anyway,
 * and a pending reload would otherwise wait forever while the model keeps
 * calling tools round after round.
 *
 * The tool loop pauses its slot before dispatch and resumes it after, so a
 * pending reload can slip out during long tool work without tearing a
 * streaming reply in half.
 */
export function beginStream(): void {
  activeStreams += 1;
}

export function endStream(): void {
  activeStreams = Math.max(0, activeStreams - 1);
  if (pending && activeStreams === 0) armExit();
}

/**
 * Temporarily releases the caller's stream slot (tool execution). REFCOUNTED:
 * parallel tool execution can pause N slots at once; the reload fires only
 * when the last one resumes. Idempotent per active pause.
 */
export function pauseStreamSlot(): void {
  if (pauseDepth > 0) {
    pauseDepth += 1;
    return;
  }
  pauseDepth = 1;
  activeStreams = Math.max(0, activeStreams - 1);
  if (pending && activeStreams === 0) armExit();
}

/**
 * Re-acquires one slot released by pauseStreamSlot(). A reload that fired
 * during the pause is invisible to this stream: the process is already gone,
 * so the resume is a no-op there.
 */
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

/**
 * The apply gate + schedule. Slow (a full typecheck), so it runs inside a
 * tool call / route handler and returns a report instead of throwing.
 */
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
