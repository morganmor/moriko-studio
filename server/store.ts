import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProviderKind } from './contracts.js';
import { apiKeysFile, morikoHome, providersFile } from './paths.js';

export interface StoredProvider {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  models: string[];
  /** Optional image-generation routing (see server/adapters/images). */
  imageAdapter?: string;
  imageConfig?: Record<string, unknown>;
  createdAt: string;
}

/**
 * ONE key vault entry. Every provider credential — CUSTOM and BUILT-IN —
 * lives here, together with the endpoint (baseUrl) it belongs to, so the
 * vault file alone tells the whole "which key reaches which API" story.
 */
export interface StoredKey {
  apiKey: string;
  /** The provider endpoint this key is used against (informational/synced). */
  baseUrl?: string;
}

interface ProvidersFile {
  version: 1;
  /** Definitions ONLY — credentials never ride here (see api-keys.json). */
  providers: StoredProvider[];
  /**
   * User-added model ids for BUILT-IN providers (e.g. a Civitai checkpoint
   * found on its model page, or a specific Civitai checkpoint). Merged after
   * the definition's curated list — never replacing it.
   */
  builtInModels?: Record<string, string[]>;
  /**
   * LIVE model lists fetched from a provider's own API (e.g. OpenAI
   * /models). When present for a built-in, it REPLACES the definition's
   * curated defaults — the catalogue always reflects the provider today.
   */
  builtInLiveModels?: Record<string, string[]>;
}

interface ApiKeysFile {
  version: 1;
  keys: Record<string, StoredKey>;
}

const EMPTY_PROVIDERS: ProvidersFile = { version: 1, providers: [], builtInModels: {} };
const EMPTY_KEYS: ApiKeysFile = { version: 1, keys: {} };

/**
 * Tiny JSON-file store for user-defined providers.
 *
 * Deliberately boring: two small files under `~/.moriko/` — provider
 * DEFINITIONS (`providers.json`) and the API-KEY VAULT (`api-keys.json`,
 * every custom + built-in key beside its endpoint) — written atomically-ish,
 * no schema migration beyond a version field. The boot migration
 * (paths.ts) folds any historical shape into these two.
 */
export class ProviderStore {
  private readonly providersPath: string;
  private readonly keysPath: string;
  private providersCache: ProvidersFile | null = null;
  private keysCache: ApiKeysFile | null = null;

  constructor(dataDir: string = morikoHome) {
    this.providersPath = path.resolve(dataDir, path.basename(providersFile));
    this.keysPath = path.resolve(dataDir, path.basename(apiKeysFile));
  }

  private async load(): Promise<ProvidersFile> {
    if (this.providersCache) return this.providersCache;
    try {
      const raw = await readFile(this.providersPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ProvidersFile>;
      this.providersCache = {
        version: 1,
        providers: Array.isArray(parsed.providers) ? parsed.providers : [],
        builtInModels:
          parsed.builtInModels && typeof parsed.builtInModels === 'object'
            ? parsed.builtInModels
            : {},
        builtInLiveModels:
          parsed.builtInLiveModels && typeof parsed.builtInLiveModels === 'object'
            ? parsed.builtInLiveModels
            : {},
      };
    } catch {
      this.providersCache = structuredClone(EMPTY_PROVIDERS);
    }
    return this.providersCache;
  }

  /** Accepts the current shape AND every historical one (raw id→string maps). */
  private async loadKeys(): Promise<ApiKeysFile> {
    if (this.keysCache) return this.keysCache;
    try {
      const raw = await readFile(this.keysPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const source =
        parsed && typeof parsed === 'object' && 'keys' in (parsed as Record<string, unknown>)
          ? (parsed as { keys: unknown }).keys
          : parsed;
      const keys: Record<string, StoredKey> = {};
      if (source && typeof source === 'object') {
        for (const [id, value] of Object.entries(source as Record<string, unknown>)) {
          if (typeof value === 'string' && value) keys[id] = { apiKey: value };
          else if (value && typeof value === 'object') {
            const entry = value as { apiKey?: unknown; baseUrl?: unknown };
            if (typeof entry.apiKey === 'string' && entry.apiKey) {
              keys[id] = {
                apiKey: entry.apiKey,
                ...(typeof entry.baseUrl === 'string' && entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
              };
            }
          }
        }
      }
      this.keysCache = { version: 1, keys };
    } catch {
      this.keysCache = structuredClone(EMPTY_KEYS);
    }
    return this.keysCache;
  }

  private async persistProviders(next: ProvidersFile): Promise<void> {
    this.providersCache = next;
    await mkdir(path.dirname(this.providersPath), { recursive: true });
    await writeFile(this.providersPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }

  private async persistKeys(next: ApiKeysFile): Promise<void> {
    this.keysCache = next;
    await mkdir(path.dirname(this.keysPath), { recursive: true });
    await writeFile(this.keysPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }

  async list(): Promise<StoredProvider[]> {
    const store = await this.load();
    return store.providers;
  }

  async get(id: string): Promise<StoredProvider | undefined> {
    const store = await this.load();
    return store.providers.find((provider) => provider.id === id);
  }

  /**
   * Upserts the DEFINITION. The key rides a side-channel: an OMITTED
   * `apiKey` keeps the stored credential (renaming a provider or editing its
   * model list must never silently drop a saved key); an empty string is the
   * explicit clear signal; a non-empty string writes the vault entry together
   * with the provider's endpoint. An existing entry's endpoint is kept in
   * sync when the definition's baseUrl changes.
   */
  async upsert(
    input: Omit<StoredProvider, 'createdAt'> & { apiKey?: string; createdAt?: string },
  ): Promise<StoredProvider> {
    const store = await this.load();
    const existingIndex = store.providers.findIndex((provider) => provider.id === input.id);
    const existing = existingIndex >= 0 ? store.providers[existingIndex] : undefined;
    const record: StoredProvider = {
      id: input.id || randomUUID(),
      label: input.label,
      kind: input.kind,
      baseUrl: input.baseUrl,
      models: input.models,
      imageAdapter: input.imageAdapter,
      imageConfig: input.imageConfig,
      createdAt: input.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
    };

    const providers = [...store.providers];
    if (existingIndex >= 0) providers[existingIndex] = record;
    else providers.push(record);
    await this.persistProviders({
      version: 1,
      providers,
      builtInModels: store.builtInModels ?? {},
      builtInLiveModels: store.builtInLiveModels ?? {},
    });

    const currentKey = (await this.loadKeys()).keys[record.id];
    if (input.apiKey !== undefined) {
      if (input.apiKey) await this.setKey(record.id, input.apiKey, record.baseUrl);
      else await this.clearKey(record.id);
    } else if (currentKey && currentKey.baseUrl !== record.baseUrl) {
      await this.setKey(record.id, currentKey.apiKey, record.baseUrl);
    }
    return record;
  }

  /** Removes the definition AND its vault entry. */
  async remove(id: string): Promise<boolean> {
    const store = await this.load();
    const providers = store.providers.filter((provider) => provider.id !== id);
    if (providers.length === store.providers.length) return false;
    await this.persistProviders({
      version: 1,
      providers,
      builtInModels: store.builtInModels ?? {},
      builtInLiveModels: store.builtInLiveModels ?? {},
    });
    await this.clearKey(id);
    return true;
  }

  /** The vault entry for a provider id, if any. */
  async getKey(id: string): Promise<StoredKey | undefined> {
    const keys = await this.loadKeys();
    const entry = keys.keys[id];
    return entry && entry.apiKey ? entry : undefined;
  }

  /** Stores (or clears, with an empty string) a key together with its endpoint. */
  async setKey(id: string, apiKey: string, baseUrl?: string): Promise<void> {
    if (!apiKey) {
      await this.clearKey(id);
      return;
    }
    const keys = await this.loadKeys();
    const next = { ...keys.keys };
    next[id] = {
      apiKey,
      ...(baseUrl ? { baseUrl } : currentBaseUrlFallback(next[id])),
    };
    await this.persistKeys({ version: 1, keys: next });
  }

  private async clearKey(id: string): Promise<void> {
    const keys = await this.loadKeys();
    if (!(id in keys.keys)) return;
    const next = { ...keys.keys };
    delete next[id];
    await this.persistKeys({ version: 1, keys: next });
  }

  /** The stored UI-supplied key for a built-in provider, if any. */
  async getBuiltInKey(id: string): Promise<string | undefined> {
    return (await this.getKey(id))?.apiKey;
  }

  /** Stores or clears the UI-supplied key for a built-in provider. */
  async setBuiltInKey(id: string, apiKey: string, baseUrl?: string): Promise<void> {
    await this.setKey(id, apiKey, baseUrl);
  }

  /** The user-added model ids for a built-in provider. */
  async getBuiltInModels(id: string): Promise<string[]> {
    const store = await this.load();
    return store.builtInModels?.[id] ?? [];
  }

  /** Replaces the user-added model list for a built-in provider. */
  async setBuiltInModels(id: string, models: string[]): Promise<void> {
    const store = await this.load();
    const builtInModels = { ...(store.builtInModels ?? {}) };
    const clean = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
    if (clean.length > 0) builtInModels[id] = clean;
    else delete builtInModels[id];
    await this.persistProviders({
      version: 1,
      providers: store.providers,
      builtInModels,
      builtInLiveModels: store.builtInLiveModels ?? {},
    });
  }

  /** The live-fetched model list for a built-in provider, if any. */
  async getBuiltInLiveModels(id: string): Promise<string[]> {
    const store = await this.load();
    return store.builtInLiveModels?.[id] ?? [];
  }

  /** Replaces the live-fetched model list (empty clears → curated defaults). */
  async setBuiltInLiveModels(id: string, models: string[]): Promise<void> {
    const store = await this.load();
    const builtInLiveModels = { ...(store.builtInLiveModels ?? {}) };
    const clean = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
    if (clean.length > 0) builtInLiveModels[id] = clean;
    else delete builtInLiveModels[id];
    await this.persistProviders({
      version: 1,
      providers: store.providers,
      builtInModels: store.builtInModels ?? {},
      builtInLiveModels,
    });
  }
}

/** Keeps an existing endpoint when a new one isn't supplied. */
function currentBaseUrlFallback(existing: StoredKey | undefined): { baseUrl?: string } {
  return existing?.baseUrl ? { baseUrl: existing.baseUrl } : {};
}

/**
 * Process-wide singleton. `server/index.ts` and the agent tools share ONE
 * instance (the vision tool resolves credentials through it) — constructing a
 * second would double the file cache and race the writes.
 */
export const providerStore = new ProviderStore();
