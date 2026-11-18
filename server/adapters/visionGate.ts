import type { ChatMessage } from '../contracts.js';
import { lookupModelMetadata } from '../modelMetadata.js';
import { resolveModelCapability } from '../modelCapability.js';
import { providerStore } from '../store.js';
import { findBuiltIn } from '../providers.js';




export const IMAGE_OMITTED_NOTE = '[inline image omitted — this model has no image input.]';


export const VIDEO_OMITTED_NOTE =
  '[inline video omitted — this model has no video input. The video was NOT converted to a file path; tell the user to switch to a video-capable model.]';


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


export function gateToolImages<T extends object>(
  images: readonly T[] | undefined,
  imageCapable: boolean,
): { images: readonly T[] | undefined; omitted: number } {
  if (!images?.length) return { images: undefined, omitted: 0 };
  if (imageCapable) return { images, omitted: 0 };
  return { images: undefined, omitted: images.length };
}


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
