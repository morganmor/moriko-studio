// Web side of `pnpm dev`: runs vite with the staged esbuild binary matching
// VITE's own esbuild version (tsx pins a different one — see setup-esbuild.mjs).
// The binary is injected via env, so no shell quoting is involved.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

if (process.env.MORIKO_ESBUILD_WEB) {
  process.env.ESBUILD_BINARY_PATH = process.env.MORIKO_ESBUILD_WEB;
}

const require = createRequire(import.meta.url);
let viteBin;
try {
  viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
} catch {
  viteBin = resolve(import.meta.dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js');
}

const child = spawn(process.execPath, [viteBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  cwd: resolve(import.meta.dirname, '..'),
});
child.on('exit', (code) => process.exit(code ?? 0));
