

import { createProvider, fetchProviders, updateBuiltInProvider } from './api';
import { clearLegacyProviderKeys, readLegacyProviderKeys } from './storage';

export interface ProviderKeyMigration {
  
  moved: number;
  
  failed: string[];
}


export async function adoptProviderKeys(keys: Record<string, string>): Promise<ProviderKeyMigration> {
  const ids = Object.keys(keys).filter((id) => keys[id]?.trim());
  if (ids.length === 0) return { moved: 0, failed: [] };

  let providers: Awaited<ReturnType<typeof fetchProviders>>;
  try {
    providers = await fetchProviders();
  } catch {
    return { moved: 0, failed: ids };
  }

  let moved = 0;
  const failed: string[] = [];
  for (const id of ids) {
    const apiKey = keys[id].trim();
    const known = providers.find((provider) => provider.id === id);
    if (!known) continue;
    try {
      if (known.builtIn) {
        await updateBuiltInProvider(id, { apiKey });
      } else {
        await createProvider({
          id,
          label: known.label,
          kind: known.kind,
          baseUrl: known.baseUrl,
          apiKey,
          models: known.models,
          imageAdapter: known.imageAdapter,
        });
      }
      moved += 1;
    } catch {
      failed.push(id);
    }
  }
  return { moved, failed };
}


export async function adoptLegacyProviderKeys(): Promise<number> {
  const legacy = readLegacyProviderKeys();
  if (Object.keys(legacy).length === 0) return 0;
  const { moved, failed } = await adoptProviderKeys(legacy);
  if (failed.length === 0) clearLegacyProviderKeys();
  return moved;
}
