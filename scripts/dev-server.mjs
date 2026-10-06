/**
 * MORIKO SERVER SUPERVISOR — the resilience layer between `pnpm dev` and the
 * model proxy.
 *
 * Why this exists: the server IS the thing the agent edits. Under plain
 * `tsx watch`, every edited server file restarted the proxy instantly and
 * tore apart any SSE stream mid-generation — the agent killed its own
 * conversation by working on the harness.
 *
 * Contract with the server:
 *   - exit code 75  → graceful reload (harness-reload gate passed, streams
 *     drained) → restart IMMEDIATELY.
 *   - any other exit → crash → restart with backoff (1s → 10s), reset after
 *     30s of healthy uptime.
 *
 * File changes deliberately do NOT restart the server anymore. The agent (or
 * a human via POST /api/agent/harness-reload) decides when changes go live.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELOAD_EXIT_CODE = 75;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const require = createRequire(import.meta.url);
let tsxCli;
try {
  tsxCli = require.resolve('tsx/cli');
} catch {
  tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
}

// Per-side esbuild binary (see setup-esbuild.mjs): tsx pins its own esbuild
// version, so use the staged binary for THIS side — never a foreign one.
if (process.env.MORIKO_ESBUILD_SERVER) {
  process.env.ESBUILD_BINARY_PATH = process.env.MORIKO_ESBUILD_SERVER;
}

let child = null;
let stopping = false;
let backoffMs = 1000;
let lastStartAt = 0;

function start() {
  lastStartAt = Date.now();
  child = spawn(process.execPath, [tsxCli, 'server/index.ts'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  console.log(`[moriko-supervisor] server started (pid ${child.pid})`);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    if (code === RELOAD_EXIT_CODE) {
      backoffMs = 1000;
      console.log('[moriko-supervisor] graceful reload — restarting now');
      start();
      return;
    }
    const uptimeMs = Date.now() - lastStartAt;
    if (uptimeMs > 30_000) backoffMs = 1000;
    console.log(
      `[moriko-supervisor] server exited (code=${code} signal=${signal}) — restarting in ${backoffMs}ms`,
    );
    setTimeout(start, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 10_000);
  });
}

function shutdown() {
  stopping = true;
  if (child) child.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
