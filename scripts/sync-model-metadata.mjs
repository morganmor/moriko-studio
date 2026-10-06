/**
 * Build-time sync of model capability metadata from models.dev.
 *
 * Downloads the full catalog and writes `server/modelMetadata.snapshot.json`,
 * which the server serves to the client (`GET /api/model-metadata`) and
 * consults itself. Only the CAPABILITY fields the app actually reads are
 * written (see the mapper below) — the descriptive/bookkeeping models.dev
 * fields (description, family, knowledge, releaseDate, lastUpdated,
 * openWeights, structuredOutput, reasoningOptions) were ~2.4 MB / 44% of the
 * snapshot while NO code path read them. Add a field to the mapper when a
 * feature starts needing one.
 *
 * Run via `pnpm sync:models`, or automatically (when stale) through the
 * `sync-if-stale.mjs` gate that `pnpm dev` calls before starting the servers.
 *
 * Trimmed shape per model key ("{provider}/{model}"):
 *   name / description / family   — catalog identity
 *   reasoning                     — supports a thinking mode
 *   efforts                       — reasoning-effort ladder (the "effort"
 *                                   option's values), or null
 *   reasoningOptions              — the FULL reasoning_options array
 *                                   (toggle / budget_tokens / effort)
 *   tools                         — tool/function calling
 *   structuredOutput              — JSON-schema structured output
 *   temperature                   — sampling temperature is supported
 *   attachment                    — accepts file attachments
 *   openWeights                   — weights are open
 *   knowledge                     — knowledge cutoff
 *   releaseDate / lastUpdated     — catalog timestamps
 *   textIn/imageIn/videoIn/audioIn/pdfIn — modalities.input membership
 *   textOut/imageOut/audioOut     — modalities.output membership
 *   context                       — context window (tokens)
 *   inputLimit                    — per-request input ceiling (limit.input)
 *   maxOut                        — max output tokens (limit.output)
 *   cost                          — { input, output, cacheRead } per million
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_URL = 'https://models.dev/api.json';
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../server/modelMetadata.snapshot.json',
);

const response = await fetch(API_URL);
if (!response.ok) {
  console.error(`models.dev returned HTTP ${response.status}`);
  process.exit(1);
}
/** @type {Record<string, { models?: Record<string, RawModel> }>} */
const catalog = await response.json();

/**
 * @typedef {object} RawModel
 * @property {string} [name]
 * @property {string} [description]
 * @property {string} [family]
 * @property {boolean} [reasoning]
 * @property {Array<{ type: string, values?: string[] }>} [reasoning_options]
 * @property {boolean} [tool_call]
 * @property {boolean} [structured_output]
 * @property {boolean} [temperature]
 * @property {boolean} [attachment]
 * @property {boolean} [open_weights]
 * @property {string} [knowledge]
 * @property {string} [release_date]
 * @property {string} [last_updated]
 * @property {{ input?: string[], output?: string[] }} [modalities]
 * @property {{ context?: number, input?: number, output?: number }} [limit]
 * @property {{ input?: number, output?: number, cache_read?: number }} [cost]
 */

const hasModality = (arr, modality) => Array.isArray(arr) && arr.includes(modality);

/** @type {Record<string, unknown>} */
const out = {};
let count = 0;

for (const [providerId, provider] of Object.entries(catalog)) {
  for (const [modelId, model] of Object.entries(provider.models ?? {})) {
    const options = model.reasoning_options ?? [];
    const efforts = options.find((option) => option.type === 'effort')?.values ?? null;
    // CAPABILITY-ONLY rows: fields nothing reads are deliberately not written.
    out[`${providerId}/${modelId}`] = {
      name: model.name ?? null,
      reasoning: Boolean(model.reasoning),
      efforts,
      tools: Boolean(model.tool_call),
      attachment: Boolean(model.attachment),
      imageIn: hasModality(model.modalities?.input, 'image'),
      videoIn: hasModality(model.modalities?.input, 'video'),
      audioIn: hasModality(model.modalities?.input, 'audio'),
      pdfIn: hasModality(model.modalities?.input, 'pdf'),
      imageOut: hasModality(model.modalities?.output, 'image'),
      context: model.limit?.context ?? null,
      maxOut: model.limit?.output ?? null,
    };
    count += 1;
  }
}

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(out)}\n`, 'utf8');
console.log(`Wrote ${count} models from ${Object.keys(catalog).length} providers → ${OUT}`);
