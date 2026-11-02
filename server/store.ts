import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProviderKind, ProviderModelConfig, ProviderModelHint } from './contracts.js';
import { PINNABLE_FIELDS } from './contracts.js';
import { apiKeysFile, morikoHome, providersFile } from './paths.js';

export interface StoredProvider {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  models: string[];
  /**
   * LAYER 1 CAPABILITY TABLE — the user's per-model authority grid, keyed by
   * model id. Sparse: a model with no row resolves through Layers 2/3. `models`
   * above stays the membership list, so a row can never resurrect a removed id.
   */
  modelConfigs?: Record<string, ProviderModelConfig>;
  /**
   * LAYER 2 HINTS — what the provider's own /models endpoint published, kept
   * separate from Layer 1 on purpose: re-fetching rewrites these without ever
   * touching a field the user pinned.
   */
  modelHints?: Record<string, ProviderModelHint>;
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
   * User-added model ids for BUILT-IN providers. Merged after
   * the definition's curated list — never replacing it.
   */
  builtInModels?: Record<string, string[]>;
  /**
   * LIVE model lists fetched from a provider's own API (e.g. OpenAI
   * /models). When present for a built-in, it REPLACES the definition's
   * curated defaults — the catalogue always reflects the provider today.
   */
  builtInLiveModels?: Record<string, string[]>;
  /**
   * LAYER 1 tables for BUILT-IN providers, keyed by provider id and then by
   * model id. Built-in definitions are immutable, but their capability grid is
   * entirely the user's to control — a preset model is still the user's model.
   */
  builtInModelConfigs?: Record<string, Record<string, ProviderModelConfig>>;
  /** LAYER 2 hints for BUILT-IN providers (see builtInModelConfigs). */
  builtInModelHints?: Record<string, Record<string, ProviderModelHint>>;
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
        // MIGRATION: a legacy record carries only `models: string[]`. Reading it
        // normalizes each model into a Layer-1-eligible row so the capability
        // table opens populated instead of blank — no separate migration pass,
        // no half-written state on disk until the next real write.
        providers: Array.isArray(parsed.providers)
          ? parsed.providers.map((provider) => normalizeStoredProvider(provider))
          : [],
        builtInModels:
          parsed.builtInModels && typeof parsed.builtInModels === 'object'
            ? parsed.builtInModels
            : {},
        builtInLiveModels:
          parsed.builtInLiveModels && typeof parsed.builtInLiveModels === 'object'
            ? parsed.builtInLiveModels
            : {},
        builtInModelConfigs: normalizeConfigMapOfMaps(parsed.builtInModelConfigs),
        builtInModelHints: normalizeHintMapOfMaps(parsed.builtInModelHints),
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
      // An OMITTED table keeps the stored one (a rename or key edit must never
      // wipe the capability grid); an explicit object replaces it wholesale.
      modelConfigs: input.modelConfigs ?? existing?.modelConfigs,
      modelHints: input.modelHints ?? existing?.modelHints,
      imageAdapter: input.imageAdapter,
      imageConfig: input.imageConfig,
      createdAt: input.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
    };

    const providers = [...store.providers];
    if (existingIndex >= 0) providers[existingIndex] = record;
    else providers.push(record);
    await this.persistProviders({ ...store, providers });

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
    await this.persistProviders({ ...store, providers });
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
    await this.persistProviders({ ...store, builtInModels });
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
    await this.persistProviders({ ...store, builtInLiveModels });
  }

  /**
   * LAYER 1 for a built-in provider. Built-ins have no StoredProvider record,
   * so their capability grid lives in its own map — but it is the SAME table
   * semantics: the user's pins win over everything below.
   */
  async getBuiltInModelConfigs(id: string): Promise<Record<string, ProviderModelConfig>> {
    const store = await this.load();
    return store.builtInModelConfigs?.[id] ?? {};
  }

  /** Replaces the Layer-1 grid for a built-in (an empty map clears it). */
  async setBuiltInModelConfigs(
    id: string,
    configs: Record<string, ProviderModelConfig>,
  ): Promise<void> {
    const store = await this.load();
    const builtInModelConfigs = { ...(store.builtInModelConfigs ?? {}) };
    if (Object.keys(configs).length > 0) builtInModelConfigs[id] = configs;
    else delete builtInModelConfigs[id];
    await this.persistProviders({ ...store, builtInModelConfigs });
  }

  /** LAYER 2 hints for a built-in provider. */
  async getBuiltInModelHints(id: string): Promise<Record<string, ProviderModelHint>> {
    const store = await this.load();
    return store.builtInModelHints?.[id] ?? {};
  }

  /** Merges fresh Layer-2 hints for a built-in (never removing older ones). */
  async mergeBuiltInModelHints(
    id: string,
    hints: Record<string, ProviderModelHint>,
  ): Promise<void> {
    const store = await this.load();
    const current = store.builtInModelHints?.[id] ?? {};
    const builtInModelHints = {
      ...(store.builtInModelHints ?? {}),
      [id]: { ...current, ...hints },
    };
    await this.persistProviders({ ...store, builtInModelHints });
  }

  /**
   * Writes ONE custom provider's Layer-1 grid, leaving every other record
   * untouched. Separate from `upsert` because saving the table must not
   * require echoing the whole definition back (a stale client copy would
   * otherwise overwrite a newer baseUrl or label).
   */
  async setModelConfigs(
    id: string,
    configs: Record<string, ProviderModelConfig>,
  ): Promise<StoredProvider | undefined> {
    const store = await this.load();
    const index = store.providers.findIndex((provider) => provider.id === id);
    if (index < 0) return undefined;
    const providers = [...store.providers];
    providers[index] = { ...providers[index], modelConfigs: configs };
    await this.persistProviders({ ...store, providers });
    return providers[index];
  }

  /** Merges fresh Layer-2 hints into ONE custom provider. */
  async mergeModelHints(
    id: string,
    hints: Record<string, ProviderModelHint>,
  ): Promise<StoredProvider | undefined> {
    const store = await this.load();
    const index = store.providers.findIndex((provider) => provider.id === id);
    if (index < 0) return undefined;
    const providers = [...store.providers];
    const merged = { ...(providers[index].modelHints ?? {}), ...hints };
    providers[index] = { ...providers[index], modelHints: merged };
    await this.persistProviders({ ...store, providers });
    return providers[index];
  }

}

/** Keeps an existing endpoint when a new one isn't supplied. */
function currentBaseUrlFallback(existing: StoredKey | undefined): { baseUrl?: string } {
  return existing?.baseUrl ? { baseUrl: existing.baseUrl } : {};
}

/**
 * LEGACY MIGRATION of one provider record. The historical shape carried only
 * `models: string[]`; this folds it into the capability-table world WITHOUT
 * inventing values.
 *
 * The migrated rows are built with `pinned: []` and `source: 'default'`,
 * meaning "no user opinion and no evidence yet" — so the cascade keeps
 * resolving them through Layer 2/3 at read time, and a later "Fetch from
 * provider" fills them in. Inventing `imageIn: false` here would be the exact
 * silent downgrade this whole change exists to remove.
 */
function normalizeStoredProvider(raw: StoredProvider): StoredProvider {
  const models = Array.isArray(raw.models)
    ? [...new Set(raw.models.map((id) => String(id).trim()).filter(Boolean))]
    : [];
  const configs = normalizeConfigMap(raw.modelConfigs);
  const hints = normalizeHintMap(raw.modelHints);
  return {
    ...raw,
    models,
    ...(Object.keys(configs).length > 0 ? { modelConfigs: configs } : {}),
    ...(Object.keys(hints).length > 0 ? { modelHints: hints } : {}),
  };
}

/** Drops rows for models that no longer exist and repairs truncated rows. */
function normalizeConfigMap(
  raw: Record<string, ProviderModelConfig> | undefined,
): Record<string, ProviderModelConfig> {
  const out: Record<string, ProviderModelConfig> = {};
  for (const [id, row] of Object.entries(raw ?? {})) {
    if (!row || typeof row !== 'object') continue;
    const pinned = Array.isArray(row.pinned) ? row.pinned.filter(isPinnableField) : [];
    out[id] = {
      id,
      imageIn: row.imageIn === true,
      audioIn: row.audioIn === true,
      videoIn: row.videoIn === true,
      pdfIn: row.pdfIn === true,
      tools: row.tools === true,
      reasoning: row.reasoning === true,
      imageOut: row.imageOut === true,
      context: typeof row.context === 'number' && row.context > 0 ? row.context : null,
      maxOut: typeof row.maxOut === 'number' && row.maxOut > 0 ? row.maxOut : null,
      source: isCapabilitySource(row.source) ? row.source : 'default',
      pinned,
    };
  }
  return out;
}

function normalizeHintMap(
  raw: Record<string, ProviderModelHint> | undefined,
): Record<string, ProviderModelHint> {
  const out: Record<string, ProviderModelHint> = {};
  for (const [id, hint] of Object.entries(raw ?? {})) {
    if (!hint || typeof hint !== 'object') continue;
    out[id] = hint;
  }
  return out;
}

function normalizeConfigMapOfMaps(
  raw: Record<string, Record<string, ProviderModelConfig>> | undefined,
): Record<string, Record<string, ProviderModelConfig>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, Record<string, ProviderModelConfig>> = {};
  for (const [providerId, map] of Object.entries(raw)) {
    const normalized = normalizeConfigMap(map);
    if (Object.keys(normalized).length > 0) out[providerId] = normalized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeHintMapOfMaps(
  raw: Record<string, Record<string, ProviderModelHint>> | undefined,
): Record<string, Record<string, ProviderModelHint>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, Record<string, ProviderModelHint>> = {};
  for (const [providerId, map] of Object.entries(raw)) {
    const normalized = normalizeHintMap(map);
    if (Object.keys(normalized).length > 0) out[providerId] = normalized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isPinnableField(value: unknown): value is keyof ProviderModelConfig & string {
  return typeof value === 'string' && PINNABLE_FIELDS.has(value);
}

const CAPABILITY_SOURCES = new Set<string>(['user', 'provider', 'models.dev', 'default']);

function isCapabilitySource(value: unknown): value is ProviderModelConfig['source'] {
  return typeof value === 'string' && CAPABILITY_SOURCES.has(value);
}

/**
 * Process-wide singleton. `server/index.ts` and the agent tools share ONE
 * instance (the vision tool resolves credentials through it) — constructing a
 * second would double the file cache and race the writes.
 */
export const providerStore = new ProviderStore();
