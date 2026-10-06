/**
 * MOVING API KEYS OFF THE BROWSER.
 *
 * Keys used to live in two places at once: the device vault
 * (`~/.moriko/api-keys.json`, written by the provider panel) and a
 * browser-side mirror in localStorage that `keyForProvider` sent along with
 * every request as a fallback. The mirror is gone — the browser stores nothing
 * — so anything a previous version left behind has to be handed to the vault
 * before it becomes unreachable.
 *
 * The server resolves credentials as `.env` → vault → browser key
 * (server/credentials.ts), so once a key is in the vault the request path is
 * unchanged and no secret ever travels from the browser again.
 *
 * A KEY IS NEVER DROPPED FROM THE ONLY PLACE THAT HOLDS IT. The migration
 * reports which ids FAILED, and the browser copy is erased only when that list
 * is empty — an unreachable proxy means "try again next boot", never "the key
 * is gone".
 */

import { createProvider, fetchProviders, updateBuiltInProvider } from './api';
import { clearLegacyProviderKeys, readLegacyProviderKeys } from './storage';

export interface ProviderKeyMigration {
  /** Keys the vault accepted. */
  moved: number;
  /** Provider ids that could not be migrated — the caller keeps their copy. */
  failed: string[];
}

/**
 * Push a map of provider-id → key into the device vault.
 *
 * Built-ins go through their dedicated key slot; custom providers are saved
 * back with their EXISTING definition (never an invented one). A provider this
 * server no longer knows is DROPPED (not failed): there is nothing to attach
 * the key to, and keeping it in the browser forever would be the only
 * remaining secret on the device's behalf.
 */
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

/**
 * One-time boot migration: hand over any keys a previous version left in the
 * browser, then erase them — but only once every one of them landed. Returns
 * how many moved (0 when there was nothing to move, the normal case after the
 * first successful run).
 */
export async function adoptLegacyProviderKeys(): Promise<number> {
  const legacy = readLegacyProviderKeys();
  if (Object.keys(legacy).length === 0) return 0;
  const { moved, failed } = await adoptProviderKeys(legacy);
  if (failed.length === 0) clearLegacyProviderKeys();
  return moved;
}
