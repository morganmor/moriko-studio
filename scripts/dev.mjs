import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { platform } from 'node:os';
import { ensureEsbuildCopies } from './setup-esbuild.mjs';

// Per-side binary injection: tsx and vite pin DIFFERENT esbuild versions, so
const staged = platform() === 'win32' ? ensureEsbuildCopies() : {};
if (staged.server) process.env.MORIKO_ESBUILD_SERVER = staged.server.exe;
if (staged.web) process.env.MORIKO_ESBUILD_WEB = staged.web.exe;
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
