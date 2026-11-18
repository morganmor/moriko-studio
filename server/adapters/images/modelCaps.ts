

import { lookupDiffusionMeta } from '../../diffusionMetadata.js';

export type ImageModelMode = 'text-to-image' | 'edit';

export interface ImageModelCaps {
  modes: ImageModelMode[];
  
  maxReferences: number;
  
  label?: string;
}


const EDIT_PATTERNS: Array<{ test: RegExp; maxReferences: number }> = [
  { test: /image[_-]?edit/i, maxReferences: 3 },
  { test: /flux[\.-]2-klein/i, maxReferences: 4 },
  { test: /flux[\.-]2-(dev|pro|max)/i, maxReferences: 8 },
  { test: /seedream[_-]?edit|seededit/i, maxReferences: 3 },
];


const UNIFIED_PATTERNS: Array<{ test: RegExp; maxReferences: number }> = [
  { test: /gemini-[\d.]+-(?:flash|pro)-image|gemini-2\.5-flash-image/i, maxReferences: 8 },
  { test: /flux[\.-]2-klein/i, maxReferences: 4 },
  { test: /flux[\.-]2-(dev|pro|max)/i, maxReferences: 8 },
  { test: /qwen[\s._-]*image[\s._-]*2[\s._-]?1(?![\s\S]*-t2i\b)/i, maxReferences: 1 },
];


function unifiedFor(model: string): number | null {
  for (const entry of UNIFIED_PATTERNS) {
    if (entry.test.test(model)) return entry.maxReferences;
  }
  return null;
}


const T2I_PATTERN =
  /image|flux|seedream|krea|z-image|diffusion|sd3|sdxl|stable-diffusion|dall|hidream|ideogram|imagen|recraft|playground|juggernaut|sdxl|pony|cyberrealistic|dreamshaper|photon|nova|cascade|wuerstchen|kolors|pixart|aura|lumina|hidream/i;


const NON_IMAGE_PATTERN = /deepseek|qwen\d|glm|kimi|nex-|bge|reranker|embed|qvq|ocr|whisper|tts|guard|omni|vl\b/i;

function maxReferencesFor(model: string): number {
  for (const edit of EDIT_PATTERNS) {
    if (edit.test.test(model)) return edit.maxReferences;
  }
  return 3;
}


export function classifyImageModel(model: string): ImageModelCaps | null {
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

  for (const edit of EDIT_PATTERNS) {
    if (edit.test.test(model)) return { modes: ['edit'], maxReferences: edit.maxReferences };
  }
  if (unified !== null) return { modes: ['text-to-image', 'edit'], maxReferences: unified };
  if (T2I_PATTERN.test(model)) return { modes: ['text-to-image'], maxReferences: 0 };
  if (NON_IMAGE_PATTERN.test(model)) return null;
  return null;
}


export function classifyImageModels(models: string[]): Record<string, ImageModelCaps> {
  const map: Record<string, ImageModelCaps> = {};
  for (const model of models) {
    const caps = classifyImageModel(model);
    if (caps) map[model] = caps;
  }
  return map;
}
