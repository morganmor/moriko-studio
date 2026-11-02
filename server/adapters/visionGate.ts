import type { ChatMessage } from '../contracts.js';
import { lookupModelMetadata } from '../modelMetadata.js';
import { resolveModelCapability } from '../modelCapability.js';
import { providerStore } from '../store.js';
import { findBuiltIn } from '../providers.js';

/**
 * VISION GATE for the provider adapters — model capability decides whether
 * image parts may ride the wire AT ALL.
 *
 * A text-only model's provider hard-rejects the ENTIRE request when any
 * message carries an image part (observed live: Mistral/OpenAI-compatible,
 * "Image input is not enabled for this model", code 3051, HTTP 400). The
 * harness therefore strips images for every model that is not `imageIn` and
 * replaces them with an honest omission note — the model knows a picture
 * existed and that vision is gated away from it, instead of the whole
 * generation dying.
 *
 * AUTHORITY: the answer comes from the 3-layer cascade, so a user who ticks
 * Vision in the Providers table gets image parts through for ANY model —
 * catalogued, uncatalogued, or catalogued differently by models.dev. The
 * catalogue is the LAST word here, not the first.
 */

/** The text that replaces stripped image parts. */
export const IMAGE_OMITTED_NOTE = '[inline image omitted — this model has no image input.]';

/** The text that replaces stripped video parts. */
export const VIDEO_OMITTED_NOTE =
  '[inline video omitted — this model has no video input. The video was NOT converted to a file path; tell the user to switch to a video-capable model.]';

/**
 * Whether this model accepts image parts, resolved through the cascade.
 *
 * ASYNC ON PURPOSE: Layer 1 lives in the provider store, and a synchronous
 * cache of it would go stale the moment the user saves the table — the silent
 * capability downgrade this whole change removes. The store is already an
 * in-memory cache, so the await costs a promise hop, not a disk read.
 *
 * When `capability` is supplied (the route resolved it once for the whole run)
 * it is used verbatim: every consumer inside one request must agree.
 */
export async function imageCapableFor(
  modelId: string,
  providerId?: string,
  capability?: { imageIn: boolean },
): Promise<boolean> {
  if (capability) return capability.imageIn;

  const catalogEntry = lookupModelMetadata(modelId);
  if (!providerId) return catalogEntry?.imageIn === true;

  if (findBuiltIn(providerId)) {
    const [configs, hints] = await Promise.all([
      providerStore.getBuiltInModelConfigs(providerId),
      providerStore.getBuiltInModelHints(providerId),
    ]);
    return resolveModelCapability(modelId, configs[modelId], hints[modelId], catalogEntry).imageIn;
  }

  const custom = await providerStore.get(providerId);
  return resolveModelCapability(
    modelId,
    custom?.modelConfigs?.[modelId],
    custom?.modelHints?.[modelId],
    catalogEntry,
  ).imageIn;
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

/**
 * Splits video parts (`type: 'video_url'`) out of a multipart content array.
 *
 * WHY A SEPARATE GATE: a text-only model that receives a `video_url` part either
 * hard-rejects the whole request or — worse — gets handed the file PATH by the
 * prompt and reaches for read_file/ffmpeg on a binary. Video input is its own
 * capability (`videoIn`), so it gets its own gate: capable models keep the part,
 * everyone else gets an honest omission note and no path to chase.
 */
export function separateVideoParts(content: ChatMessage['content']): {
  kept: ContentPart[];
  dropped: number;
} {
  const kept: ContentPart[] = [];
  let dropped = 0;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'video_url') {
        dropped += 1;
        continue;
      }
      kept.push(part);
    }
  }
  return { kept, dropped };
}
