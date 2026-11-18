

import type { ImageAdapter, ImageCredentials } from './types.js';
import { createDeclarativeAdapter, type DeclarativeImageConfig } from './declarative.js';
import { comfyuiAdapter } from './comfyui.js';
import { geminiImageAdapter } from './gemini.js';
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
registerImageAdapter(geminiImageAdapter);
registerImageAdapter(modelscopeAdapter);
registerImageAdapter(openaiSyncAdapter);


export interface ImageProviderSelection {
  imageAdapter?: string;
  imageConfig?: Record<string, unknown>;
}


export function defaultAdapterIdFor(baseUrl: string): string {
  if (/modelscope/i.test(baseUrl)) return 'modelscope-async';
  if (/comfyui/i.test(baseUrl)) return 'comfyui-local';
  if (/^https?:\/\/(127\.0\.0\.1|localhost):8188/i.test(baseUrl)) return 'comfyui-local';
  if (/generativelanguage\.googleapis\.com/i.test(baseUrl)) return 'gemini-native';
  return 'openai-sync';
}


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


export function resolveImageAdapterForCredentials(credentials: ImageCredentials): ImageAdapter {
  return resolveImageAdapter(undefined, credentials.baseUrl);
}
