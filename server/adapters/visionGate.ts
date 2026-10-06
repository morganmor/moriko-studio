import type { ChatMessage } from '../contracts.js';
import { lookupModelMetadata } from '../modelMetadata.js';

/**
 * VISION GATE for the provider adapters — model capability decides whether
 * image parts may ride the wire AT ALL.
 *
 * A text-only model's provider hard-rejects the ENTIRE request when any
 * message carries an image part (observed live: Mistral/OpenAI-compatible,
 * "Image input is not enabled for this model", code 3051, HTTP 400). The
 * harness therefore strips images for every model that is not `imageIn`
 * (models.dev metadata; LOCAL_OVERRIDES covers unlisted models) and replaces
 * them with an honest omission note — the model knows a picture existed and
 * that vision is gated away from it, instead of the whole generation dying.
 *
 * SAFE DEFAULT: a model with NO metadata counts as NOT image-capable — an
 * unknown model must never 400 the whole conversation; known multimodal
 * models are in the catalog (or LOCAL_OVERRIDES).
 */

/** The text that replaces stripped image parts. */
export const IMAGE_OMITTED_NOTE = '[inline image omitted — this model has no image input.]';

/** Whether this model id accepts image parts per the metadata catalog. */
export function imageCapableFor(modelId: string): boolean {
  return lookupModelMetadata(modelId)?.imageIn === true;
}

type ContentPart = NonNullable<Exclude<ChatMessage['content'], string | null>>[number];

/**
 * Splits image parts (`type: 'image_url'`) out of a multipart content array.
 * Pure — each adapter decides what note to append where.
 */
export function separateImageParts(content: ChatMessage['content']): {
  kept: ContentPart[];
  dropped: number;
} {
  const kept: ContentPart[] = [];
  let dropped = 0;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'image_url') {
        dropped += 1;
        continue;
      }
      kept.push(part);
    }
  }
  return { kept, dropped };
}

/** Gates a tool output's image list for the wire: pass-through for capable
 *  models; stripped (with the count for the omission note) otherwise. The
 *  image shape is structural — adapters pass whatever their metadata type
 *  carries (full `{mime,dataUrl}` or a `{mime}` count-only list). */
export function gateToolImages<T extends object>(
  images: readonly T[] | undefined,
  imageCapable: boolean,
): { images: readonly T[] | undefined; omitted: number } {
  if (!images?.length) return { images: undefined, omitted: 0 };
  if (imageCapable) return { images, omitted: 0 };
  return { images: undefined, omitted: images.length };
}
