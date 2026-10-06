// Per-host esbuild binary staging for `pnpm dev` (Windows).
//
// WHY: the dev chain runs TWO esbuild hosts — tsx (server transpile) and vite
// (web) — pinned to DIFFERENT esbuild versions by their dependency ranges.
// ESBUILD_BINARY_PATH is a single global switch: pointing it at one binary
// breaks the other host ("Host version X does not match binary version Y").
// So each host gets its OWN staged copy, and dev.mjs injects the right one
// per side (MORIKO_ESBUILD_SERVER / MORIKO_ESBUILD_WEB).
//
// The source binary is always matched to the host's EXACT esbuild version —
// never the hidden-hoist copy (version-ambiguous when several esbuilds
// coexist; that was the crash).
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const destDir = join(root, '.esbuild');

/** esbuild JS version + package dir as seen FROM one host (tsx / vite). */
function hostEsbuild(host) {
  const rootRequire = createRequire(join(root, 'package.json'));
  const hostPkg = rootRequire.resolve(`${host}/package.json`);
  const esbuildPkg = createRequire(hostPkg).resolve('esbuild/package.json');
  return {
    version: JSON.parse(readFileSync(esbuildPkg, 'utf8')).version,
    esbuildPkg,
  };
}

/** The platform binary for ONE exact esbuild version (never another's). */
function binaryForVersion(esbuildPkg, version) {
  // 1) the version-matched optional dep, resolved from the host's own esbuild.
  try {
    const exe = createRequire(esbuildPkg).resolve('@esbuild/win32-x64/esbuild.exe');
    if (existsSync(exe)) return exe;
  } catch { /* fall through */ }
  // 2) pnpm virtual store by exact version tag.
  const storeExe = join(
    root, 'node_modules', '.pnpm',
    `@esbuild+win32-x64@${version}`, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe',
  );
  return existsSync(storeExe) ? storeExe : null;
}

/** Stages one binary per side; exe is null when native resolution is fine. */
export function ensureEsbuildCopies() {
  const out = { server: null, web: null };
  if (platform() !== 'win32') {
    console.log('[setup-esbuild] Non-Windows — nothing to do.');
    return out;
  }
  for (const [side, host] of [['server', 'tsx'], ['web', 'vite']]) {
    let es;
    try {
      es = hostEsbuild(host);
    } catch {
      console.warn(`[setup-esbuild] ${host} not installed — skipping.`);
      continue;
    }
    const src = binaryForVersion(es.esbuildPkg, es.version);
    if (!src) {
      console.warn(`[setup-esbuild] ${host}: no binary for esbuild ${es.version} — native resolution will be used.`);
      continue;
    }
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, `esbuild-${es.version}.exe`);
    copyFileSync(src, dest);
    out[side] = { version: es.version, exe: dest };
    console.log(`[setup-esbuild] ${side} (${host}, esbuild ${es.version}) -> ${dest}`);
  }
  // Legacy single-copy artifact — version-ambiguous once two esbuilds coexist.
  const legacy = join(destDir, 'esbuild.exe');
  if (existsSync(legacy)) {
    try {
      unlinkSync(legacy);
      console.log('[setup-esbuild] removed stale .esbuild/esbuild.exe (version-ambiguous).');
    } catch { /* best effort */ }
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const staged = ensureEsbuildCopies();
  for (const [side, entry] of Object.entries(staged)) {
    if (entry) console.log(`[setup-esbuild] ${side}: ESBUILD_BINARY_PATH=${entry.exe} (esbuild ${entry.version})`);
  }
}
