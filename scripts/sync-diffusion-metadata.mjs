/**
 * Build-time sync of diffusion-model metadata from the Hugging Face Hub API.
 *
 * CAPABILITY ONLY — this snapshot answers "what can this model do?", never
 * "how popular is it?". Download counts, likes and trending scores are
 * deliberately NOT written: they bloat the snapshot and go stale hourly while
 * saying nothing about capabilities.
 *
 * HF's `pipeline_tag` IS the primary capability signal:
 *   text-to-image  → t2i
 *   image-to-image → edit (reference-based editing)
 *   inpainting     → edit (mask-optional variants included)
 * The raw `tags` array rides along too: it carries capability keywords the
 * pipeline tag cannot express (e.g. "image-editing", "rgba", "controlnet"),
 * and `library_name` distinguishes a diffusers checkpoint from a GGUF/ONNX
 * quant of the same model.
 *
 * Writes `server/diffusionMetadata.snapshot.json`, keyed by lowercased HF
 * model id ("qwen/qwen-image-edit-2511"). Run via `pnpm sync:diffusion`.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../server/diffusionMetadata.snapshot.json',
);

const QUERIES = [
  ['text-to-image', 't2i'],
  ['image-to-image', 'edit'],
  ['inpainting', 'inpaint'],
];

/** @type {Record<string, unknown>} */
const out = {};
let count = 0;

for (const [pipelineTag, tag] of QUERIES) {
  const url =
    'https://huggingface.co/api/models?pipeline_tag=' + pipelineTag +
    '&library=diffusers&sort=downloads&limit=300';
  const response = await fetch(url, { headers: { 'User-Agent': 'moriko-studio-sync' } });
  if (!response.ok) {
    console.error(`HF Hub returned HTTP ${response.status} for ${pipelineTag}`);
    process.exit(1);
  }
  /**
   * Only the capability field the app reads is kept (`tag`). The HF `tags`
   * array and `library_name` were written here as capability signals but
   * NOTHING reads them (modelCaps.ts only branches on `hf.tag`) — they were
   * ~90% of the snapshot. Drop them; re-add when a feature needs them.
   * downloads/likes/trendingScore/popularity are NOT capability data.
   * @type {Array<{ id: string, tags?: string[], library_name?: string }>}
   */
  const models = await response.json();
  for (const model of models) {
    if (!model.id) continue;
    out[model.id.toLowerCase()] = { tag };
    count += 1;
  }
}

await writeFile(OUT, `${JSON.stringify(out)}\n`, 'utf8');
console.log(`Wrote ${count} diffusion models → ${OUT}`);
