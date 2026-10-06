// Dev entry: copies the esbuild binary to <repo>/.esbuild/esbuild.exe,
// sets ESBUILD_BINARY_PATH, then runs the normal dev chain.
// Flexible: resolves esbuild.exe dynamically from the repo's node_modules,
// so repo name / location changes do not break it.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { platform } from 'node:os';
import { ensureEsbuildCopies } from './setup-esbuild.mjs';

// Per-side binary injection: tsx and vite pin DIFFERENT esbuild versions, so
// one global ESBUILD_BINARY_PATH cannot serve both (it crashed the server
// with "host 0.28.2 does not match binary 0.25.12"). Each side reads its own
// var in its own launcher (dev-server.mjs / dev-web.mjs).
const staged = platform() === 'win32' ? ensureEsbuildCopies() : {};
if (staged.server) process.env.MORIKO_ESBUILD_SERVER = staged.server.exe;
if (staged.web) process.env.MORIKO_ESBUILD_WEB = staged.web.exe;
// Single-version case: keep the legacy global switch so any other esbuild
// consumer in the chain uses the staged binary too.
if (staged.server && staged.web && staged.server.version === staged.web.version) {
  process.env.ESBUILD_BINARY_PATH = staged.server.exe;
}

const chain =
  'node scripts/clean-vite-cache.mjs && node scripts/sync-if-stale.mjs && ' +
  'concurrently -n server,web -c magenta,cyan "npm:dev:server" "npm:dev:web"';

const child = spawn(chain, {
  stdio: 'inherit',
  shell: true,
  env: process.env,
  cwd: resolve(import.meta.dirname, '..'),
});
child.on('exit', (code) => process.exit(code ?? 0));
