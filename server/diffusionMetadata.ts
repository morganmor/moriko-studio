

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
