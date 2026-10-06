/**
 * Syncs the Civitai checkpoint catalog into `server/civitaiModels.snapshot.json`.
 *
 * Uses the PUBLIC Civitai Site API (no key needed): top checkpoints per
 * ecosystem, sorted by downloads. Each entry becomes a model id that the
 * `civitai-orchestration` adapter translates into an AIR URN for the
 * Orchestration API, plus a friendly label the model picker displays.
 *
 * Capability data only (a checkpoint's type, ecosystem and what its version
 * can do). Popularity stats — downloadCount, thumbsUpCount, tippedAmount —
 * are deliberately NOT written: they bloat the snapshot and go stale hourly
 * without saying anything about what the model can do.
 *
 * Run: node scripts/sync-civitai-models.mjs   (or: pnpm sync)
 * @type {{
 *   syncedAt: string,
 *   models: Array<{
 *     id: string,
 *     label: string,
 *     baseModel: string,
 *     type: string | null,
 *     supportsGeneration: boolean,
 *     nsfw: boolean,
 *   }>
 * }}
 */
const OUT = new URL('../server/civitaiModels.snapshot.json', import.meta.url);

/** Ecosystems worth surfacing; keys match the Orchestration AIR ecosystem. */
const ECOSYSTEMS = [
  { baseModels: 'SDXL 1.0', ecosystem: 'sdxl', limit: 24 },
  { baseModels: 'Flux.1 D', ecosystem: 'flux1', limit: 16 },
];

function urn(ecosystem, modelId, versionId) {
  return `urn:air:${ecosystem}:checkpoint:civitai:${modelId}@${versionId}`;
}

/**
 * @typedef {object} CivitaiItem
 * @property {number} [id]
 * @property {string} [name]
 * @property {string} [type]
 * @property {boolean} [nsfw]
 * @property {boolean} [supportsGeneration]
 * @property {Array<{ baseModel?: string, id?: number }>} [modelVersions]
 */

/** @type {Array<{ id: string, label: string, baseModel: string, type: string|null, supportsGeneration: boolean, nsfw: boolean }>} */
const models = [];
const seen = new Set();

for (const eco of ECOSYSTEMS) {
  const url =
    `https://api.civitai.com/api/v1/models?limit=${eco.limit}` +
    `&sort=Most%20Downloaded&types=Checkpoint&baseModels=${encodeURIComponent(eco.baseModels)}&nsfw=false`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[civitai] ${eco.baseModels}: HTTP ${res.status} — keeping previous snapshot.`);
    process.exit(0);
  }
  const data = await res.json();
  for (const item of /** @type {{ items?: CivitaiItem[] }} */ (data).items ?? []) {
    const version = item.modelVersions?.find((v) => v.baseModel === eco.baseModels) ?? item.modelVersions?.[0];
    if (!item.id || !version?.id) continue;
    const id = urn(eco.ecosystem, item.id, version.id);
    if (seen.has(id)) continue;
    seen.add(id);
    // CAPABILITY-ONLY rows: only id + label are read (providers.ts picker
    // lists) — baseModel/type/supportsGeneration/nsfw were never consumed.
    models.push({
      id,
      label: item.name ?? id,
    });
  }
}

const payload = { syncedAt: new Date().toISOString(), models };
await import('node:fs').then((fs) =>
  fs.promises.writeFile(OUT, `${JSON.stringify(payload)}\n`, 'utf8'),
);
console.log(`[civitai] synced ${models.length} checkpoints → server/civitaiModels.snapshot.json`);
