/**
 * Per-model image capability classification — a HINT for the UI (picker
 * filtering, badges, non-blocking warnings).
 *
 * Two layers, most authoritative first:
 *  1. Hugging Face Hub catalog (synced by `sync:diffusion`) — its
 *     `pipeline_tag` is a curated capability signal (text-to-image vs
 *     image-to-image vs inpainting). It can be WRONG (unified models, LoRAs,
 *     provider-side endpoints), so it never gates transmission.
 *  2. Declarative pattern matching — the offline fallback for models HF
 *     does not know (and the source of per-family reference limits).
 *
 * Transmission authority lives elsewhere: whether reference images actually
 * leave the server is decided by the provider's adapter capacity
 * (`ImageCapabilities.maxReferences`), and providers reject what they can't
 * take with a real, surfaced error.
 */

import { lookupDiffusionMeta } from '../../diffusionMetadata.js';

export type ImageModelMode = 'text-to-image' | 'edit';

export interface ImageModelCaps {
  modes: ImageModelMode[];
  /** How many reference images an edit request may carry (0 = none). */
  maxReferences: number;
  /** Optional friendly name shown by the picker (catalog-synced models). */
  label?: string;
}

/** Edit-capable families, most specific first. Counts follow vendor docs. */
const EDIT_PATTERNS: Array<{ test: RegExp; maxReferences: number }> = [
  { test: /image[_-]?edit/i, maxReferences: 3 },
  { test: /flux[\.-]2-klein/i, maxReferences: 4 },
  { test: /flux[\.-]2-(dev|pro|max)/i, maxReferences: 8 },
  { test: /seedream[_-]?edit|seededit/i, maxReferences: 3 },
];

/**
 * Unified families: they generate from plain text AND accept reference
 * images, even when the HF `pipeline_tag` (or the id itself) only says
 * "text-to-image". Used ONLY for labels and non-blocking warnings — this
 * module never decides whether a request is sent; that is the provider's
 * adapter (see `capabilities.maxReferences`).
 */
const UNIFIED_PATTERNS: Array<{ test: RegExp; maxReferences: number }> = [
  { test: /flux[\.-]2-klein/i, maxReferences: 4 },
  { test: /flux[\.-]2-(dev|pro|max)/i, maxReferences: 8 },
  { test: /qwen[\s._-]*image[\s._-]*2[\s._-]?1(?![\s\S]*-t2i\b)/i, maxReferences: 1 },
];

/** Returns the unified reference cap for this id, or null when not unified. */
function unifiedFor(model: string): number | null {
  for (const entry of UNIFIED_PATTERNS) {
    if (entry.test.test(model)) return entry.maxReferences;
  }
  return null;
}

/** Families that generate images but take no reference input. */
const T2I_PATTERN =
  /image|flux|seedream|krea|z-image|diffusion|sd3|sdxl|stable-diffusion|dall|hidream|ideogram|imagen|recraft|playground|juggernaut|sdxl|pony|cyberrealistic|dreamshaper|photon|nova|cascade|wuerstchen|kolors|pixart|aura|lumina|hidream/i;

/** Everything else on a provider's model list (chat, rerankers, embeddings). */
const NON_IMAGE_PATTERN = /deepseek|qwen\d|glm|kimi|nex-|bge|reranker|embed|qvq|ocr|whisper|tts|guard|omni|vl\b/i;

function maxReferencesFor(model: string): number {
  for (const edit of EDIT_PATTERNS) {
    if (edit.test.test(model)) return edit.maxReferences;
  }
  return 3;
}

/**
 * Classifies one model id. `null` means "not an image model at all" — the
 * image-model picker hides it and image requests to it are a user error.
 */
export function classifyImageModel(model: string): ImageModelCaps | null {
  // ComfyUI tagged models — all support t2i and i2i (edit) with 1 reference
  if (/^(ckpt|diff|unet):/i.test(model)) {
    return { modes: ['text-to-image', 'edit'], maxReferences: 1 };
  }

  const hf = lookupDiffusionMeta(model);
  const unified = unifiedFor(model);
  if (hf) {
    if (hf.tag === 'edit' || hf.tag === 'inpaint') {
      const modes: ImageModelMode[] = unified !== null ? ['text-to-image', 'edit'] : ['edit'];
      return { modes, maxReferences: unified ?? maxReferencesFor(model) };
    }
    if (unified !== null) return { modes: ['text-to-image', 'edit'], maxReferences: unified };
    return { modes: ['text-to-image'], maxReferences: 0 };
  }

  // Check T2I_PATTERN BEFORE NON_IMAGE_PATTERN — a model like
  // "qwen2vl/image" or "glm-image" is an image model even though it
  // contains a keyword that also appears in NON_IMAGE_PATTERN.
  for (const edit of EDIT_PATTERNS) {
    if (edit.test.test(model)) return { modes: ['edit'], maxReferences: edit.maxReferences };
  }
  if (unified !== null) return { modes: ['text-to-image', 'edit'], maxReferences: unified };
  if (T2I_PATTERN.test(model)) return { modes: ['text-to-image'], maxReferences: 0 };
  if (NON_IMAGE_PATTERN.test(model)) return null;
  return null;
}

/** One entry per image-capable model; non-image models are omitted. */
export function classifyImageModels(models: string[]): Record<string, ImageModelCaps> {
  const map: Record<string, ImageModelCaps> = {};
  for (const model of models) {
    const caps = classifyImageModel(model);
    if (caps) map[model] = caps;
  }
  return map;
}
