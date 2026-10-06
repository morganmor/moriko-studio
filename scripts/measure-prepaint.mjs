/**
 * P4 MEASUREMENT — the pre-paint JS payload: whatever dist/index.html pulls
 * at boot (module scripts + modulepreload links), sized from the build output.
 * Run after `pnpm exec vite build`:
 *
 *   node scripts/measure-prepaint.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'dist/index.html'), 'utf8');
const scriptPaths = [...html.matchAll(/src="(\/?assets\/[^"\s]+\.js)"/g)].map((m) => m[1]);
const preloadPaths = [...html.matchAll(/href="(\/?assets\/[^"\s]+\.js)"/g)].map((m) => m[1]);
const all = [...new Set([...scriptPaths, ...preloadPaths])];

let total = 0;
for (const file of all) {
  const size = fs.statSync(path.join(process.cwd(), 'dist', file.replace(/^\//, ''))).size;
  total += size;
  console.log(`  ${(size / 1024).toFixed(1).padStart(8)} KB  ${file}`);
}
console.log(`pre-paint JS total: ${(total / 1024).toFixed(1)} KB across ${all.length} file(s)`);
