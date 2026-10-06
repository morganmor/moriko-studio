// Clears Vite's dep pre-bundle cache before a dev start.
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const viteCache = resolve(root, 'node_modules', '.vite');

if (!existsSync(viteCache)) {
  console.log('[clean-vite-cache] node_modules/.vite not found — nothing to clean.');
  process.exit(0);
}

try {
  rmSync(viteCache, { recursive: true, force: true });
  console.log('[clean-vite-cache] Cleared node_modules/.vite.');
} catch (error) {
  console.warn(`[clean-vite-cache] Could not fully remove node_modules/.vite: ${error.message}`);
}

process.exit(0);
