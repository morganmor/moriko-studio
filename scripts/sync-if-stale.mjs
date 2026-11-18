

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.MORIKO_NO_SYNC === '1') {
  console.log('[sync-if-stale] MORIKO_NO_SYNC=1 — skipping metadata sync.');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxAgeHours = Number(process.env.MORIKO_SYNC_MAX_AGE_HOURS);
const maxAgeMs = (Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : 24) * 3_600_000;


const targets = [
  ['server/modelMetadata.snapshot.json', 'scripts/sync-model-metadata.mjs'],
  ['server/diffusionMetadata.snapshot.json', 'scripts/sync-diffusion-metadata.mjs'],
];

for (const [snapshot, script] of targets) {
  let ageMs = Infinity;
  try {
    ageMs = Date.now() - statSync(path.join(root, snapshot)).mtimeMs;
  } catch {
  }
  if (ageMs < maxAgeMs) continue;

  console.log(`[sync-if-stale] ${path.basename(snapshot)} is stale — running ${path.basename(script)}`);
  const result = spawnSync(process.execPath, [path.join(root, script)], {
    cwd: root,
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    console.warn(
      `[sync-if-stale] ${path.basename(script)} failed` +
        `${result.signal ? ` (${result.signal})` : ''} — keeping the previous snapshot. Dev continues.`,
    );
  }
}

process.exit(0);
