/**
 * Diffusion-model metadata from the Hugging Face Hub API, synced at build
 * time by `scripts/sync-diffusion-metadata.mjs` into
 * `diffusionMetadata.snapshot.json`.
 *
 * CAPABILITY ONLY. The HF `pipeline_tag` is the primary capability signal:
 * text-to-image (t2i), image-to-image (edit), inpainting. The raw `tags`
 * array carries capability keywords the pipeline tag cannot express
 * ("image-editing", "rgba", "controlnet", …), and `library` distinguishes a
 * diffusers checkpoint from a GGUF/ONNX quant of the same model. Popularity
 * fields (downloads, likes) are excluded on purpose. Mirrors modelMetadata.ts:
 * regenerated via `pnpm sync:diffusion` (also auto-triggered by `pnpm dev`
 * when the snapshot is stale); a missing file degrades silently to the
 * pattern classifier.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DiffusionTag = 't2i' | 'edit' | 'inpaint';

export interface DiffusionMeta {
  tag: DiffusionTag;
}

type DiffusionMap = Record<string, DiffusionMeta>;

let cache: DiffusionMap | null = null;

function load(): DiffusionMap {
  if (cache) return cache;
  cache = {};
  try {
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'diffusionMetadata.snapshot.json',
    );
    cache = JSON.parse(readFileSync(file, 'utf8')) as DiffusionMap;
  } catch {
  }
  return cache ?? {};
}

const memo = new Map<string, DiffusionMeta | undefined>();

/**
 * Resolves HF catalog data for a model id. Matching is namespace-tolerant:
 * exact lowercased id first, then the bare model part (a ModelScope /
 * Bitdeer model id like "Tongyi-MAI/Z-Image-Turbo" matches the HF record
 * "tongyi-mai/z-image-turbo" or a same-named model under another org).
 */
export function lookupDiffusionMeta(modelId: string): DiffusionMeta | undefined {
  const wanted = modelId.trim().toLowerCase();
  if (!wanted) return undefined;
  if (memo.has(wanted)) return memo.get(wanted);

  const map = load();
  let result: DiffusionMeta | undefined;

  if (map[wanted]) {
    result = map[wanted];
  } else {
    for (const [key, meta] of Object.entries(map)) {
      const modelPart = key.slice(key.indexOf('/') + 1);
      if (modelPart === wanted) {
        result = meta;
        break;
      }
    }
    if (!result) {
      for (const [key, meta] of Object.entries(map)) {
        const modelPart = key.slice(key.indexOf('/') + 1);
        if (wanted.endsWith(`/${modelPart}`) || modelPart.endsWith(`/${wanted}`)) {
          result = meta;
          break;
        }
      }
    }
  }

  memo.set(wanted, result);
  return result;
}
