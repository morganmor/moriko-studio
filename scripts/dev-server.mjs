

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

if (process.env.MORIKO_ESBUILD_SERVER) {
  process.env.ESBUILD_BINARY_PATH = process.env.MORIKO_ESBUILD_SERVER;
}

let child = null;
let stopping = false;
let backoffMs = 1000;
let lastStartAt = 0;

function start() {
  lastStartAt = Date.now();
  const heapMb = Number(process.env.MORIKO_MAX_OLD_SPACE ?? 4096);
  const heapArg = Number.isFinite(heapMb) && heapMb > 0 ? `--max-old-space-size=${Math.round(heapMb)}` : null;
  const nodeArgs = heapArg ? [heapArg, tsxCli, 'server/index.ts'] : [tsxCli, 'server/index.ts'];
  child = spawn(process.execPath, nodeArgs, {
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
