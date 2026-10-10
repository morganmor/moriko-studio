/**
 * Adapter registry + per-provider adapter resolution.
 *
 * Selection order for a provider:
 *   1. explicit `imageAdapter` on the stored provider record
 *      ('declarative' additionally requires `imageConfig` — see phase 4)
 *   2. a host-based rule that protects existing ModelScope providers
 *   3. the most common default for new gateways
 */

import type { ImageAdapter, ImageCredentials } from './types.js';
import { createDeclarativeAdapter, type DeclarativeImageConfig } from './declarative.js';
import { comfyuiAdapter } from './comfyui.js';
import { modelscopeAdapter } from './modelscope.js';
import { openaiSyncAdapter } from './openaiSync.js';

const registry = new Map<string, ImageAdapter>();

export function registerImageAdapter(adapter: ImageAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getImageAdapter(id: string): ImageAdapter | undefined {
  return registry.get(id);
}

export function listImageAdapterIds(): string[] {
  return [...registry.keys()];
}

registerImageAdapter(comfyuiAdapter);
registerImageAdapter(modelscopeAdapter);
registerImageAdapter(openaiSyncAdapter);

/** Optional image-routing fields on a stored provider record. */
export interface ImageProviderSelection {
  imageAdapter?: string;
  imageConfig?: Record<string, unknown>;
}

/**
 * The default when a provider says nothing about images. ModelScope keeps its
 * async-task flow; every other gateway is assumed OpenAI-shaped (sync).
 */
export function defaultAdapterIdFor(baseUrl: string): string {
  if (/modelscope/i.test(baseUrl)) return 'modelscope-async';
  // ComfyUI: localhost/127.0.0.1 on port 8188, or has "comfyui" in URL
  if (/comfyui/i.test(baseUrl)) return 'comfyui-local';
  if (/^https?:\/\/(127\.0\.0\.1|localhost):8188/i.test(baseUrl)) return 'comfyui-local';
  return 'openai-sync';
}

/**
 * Resolves the adapter for one provider. Throws a plain Error for
 * configuration mistakes (unknown adapter id, malformed declarative config) —
 * those are 500s, not upstream rejections.
 */
export function resolveImageAdapter(
  selection: ImageProviderSelection | undefined,
  baseUrl: string,
): ImageAdapter {
  const explicit = selection?.imageAdapter?.trim();
  if (explicit) {
    if (explicit === 'declarative') {
      return createDeclarativeAdapter(
        (selection?.imageConfig ?? {}) as unknown as DeclarativeImageConfig,
      );
    }
    const adapter = registry.get(explicit);
    if (!adapter) {
      throw new Error(
        `Unknown image adapter "${explicit}". Available: ${listImageAdapterIds().join(', ')}.`,
      );
    }
    return adapter;
  }
  return registry.get(defaultAdapterIdFor(baseUrl)) ?? modelscopeAdapter;
}

/** Convenience for callers that only have credentials in hand. */
export function resolveImageAdapterForCredentials(credentials: ImageCredentials): ImageAdapter {
  return resolveImageAdapter(undefined, credentials.baseUrl);
}
