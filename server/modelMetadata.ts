/**
 * Model capability metadata from models.dev, synced at build time by
 * `scripts/sync-model-metadata.mjs` into `modelMetadata.snapshot.json`.
 *
 * The server serves the whole map to the client (`GET /api/model-metadata`)
 * and can consult it itself (e.g. gating reasoning parameters later). The
 * file is regenerated via `pnpm sync:models` and also auto-refreshed by the
 * `sync-if-stale.mjs` gate that `pnpm dev` calls before starting the servers
 * — so a missing or stale snapshot degrades to "no metadata" without
 * breaking anything, and a fresh one is pulled at most once per freshness
 * window (default 24 h).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ModelMeta {
  reasoning: boolean;
  /** Accepted reasoning-effort ladder per models.dev, or null when unknown. */
  efforts: string[] | null;
  tools: boolean;
  attachment: boolean;
  /** Catalog display name. */
  name?: string | null;
  imageIn: boolean;
  imageOut: boolean;
  /** Accepts video input (models.dev modalities.input). Absent in older snapshots → falsy. */
  videoIn?: boolean;
  /** Accepts audio input (models.dev modalities.input). Absent in older snapshots → falsy. */
  audioIn?: boolean;
  /** Accepts PDF input (models.dev modalities.input). Absent in older snapshots → falsy. */
  pdfIn?: boolean;
  context: number | null;
  maxOut: number | null;
}

type MetadataMap = Record<string, ModelMeta>;

let cache: MetadataMap | null = null;

function load(): MetadataMap {
  if (cache) return cache;
  cache = {};
  try {
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'modelMetadata.snapshot.json',
    );
    cache = JSON.parse(readFileSync(file, 'utf8')) as MetadataMap;
  } catch {
  }
  return cache ?? {};
}

const memo = new Map<string, ModelMeta | undefined>();

/**
 * Resolves metadata for a model id from any provider. Matching is
 * provider-tolerant and variant-tolerant, in specificity order:
 *
 * 1. Exact "provider/model" key — nested provider slugs ("qiniu-ai/xiaomi/
 *    mimo-v2-flash") are catalogued as-is.
 * 2. The same key with an OpenRouter-style ":variant" suffix stripped from
 *    EITHER side — the request's "openrouter/mimo-v2.6-flash:free" and the
 *    catalog's own "nano-gpt/…/mimo-v2.5:thinking" both resolve to their
 *    base model.
 * 3. The bare model part (last "/" segment, variant stripped) against any
 *    provider's entry — a custom "Bitdeer" provider with
 *    "deepseek-ai/DeepSeek-V4.1-Flash" still finds the entry recorded under
 *    a different provider id.
 *
 * Providers absent from models.dev (Atria) are covered by LOCAL_OVERRIDES
 * below, so the context-budget stop and the UI capability flags work there
 * too instead of silently degrading to "unknown".
 */
export function lookupModelMetadata(modelId: string): ModelMeta | undefined {
  const wanted = modelId.trim().toLowerCase();
  if (!wanted) return undefined;
  if (memo.has(wanted)) return memo.get(wanted);

  const map = load();
  let result: ModelMeta | undefined = map[wanted] ?? matchCatalogEntry(Object.entries(map), wanted);

  if (!result) {
    for (const [key, meta] of Object.entries(LOCAL_OVERRIDES)) {
      if (wanted === key || wanted.endsWith(`/${key}`)) {
        result = meta;
        break;
      }
    }
  }

  memo.set(wanted, result);
  return result;
}

/**
 * The catalog entry for ONE exact provider+model pair (variant suffix
 * stripped), with NO bare-name fallback.
 *
 * Tier-1 ladder resolution has to know whether the GATEWAY published an entry
 * for this model: the tolerant lookup would answer "yes" using a different
 * gateway's row, which is exactly the guess this whole resolution exists to
 * stop making.
 */
export function lookupExactProviderModel(
  providerId: string,
  modelId: string,
): ModelMeta | undefined {
  const map = load();
  const wanted = `${providerId.trim()}/${modelId.trim()}`.toLowerCase();
  if (!wanted || wanted === '/') return undefined;
  const direct = map[wanted];
  if (direct) return direct;
  const wantExact = stripVariantSuffix(wanted);
  for (const [key, meta] of Object.entries(map)) {
    if (stripVariantSuffix(key.toLowerCase()) === wantExact) return meta;
  }
  return undefined;
}

/**
 * Provider ids models.dev catalogues. The snapshot is flat, keyed
 * `provider/model`, and the provider id is the FIRST segment — model ids may
 * themselves contain slashes (`nano-gpt/deepseek/deepseek-v4.1-flash`).
 *
 * This is what separates "the gateway told us its ladder" from "we only know
 * the model" — a custom provider (a UUID the user typed a base URL for) is
 * never catalogued, so its ladder has to come from the model itself.
 */
let cataloguedProviders: Set<string> | null = null;

export function isCataloguedProvider(providerId: string): boolean {
  const wanted = providerId.trim().toLowerCase();
  if (!wanted) return false;
  if (!cataloguedProviders) {
    cataloguedProviders = new Set<string>();
    for (const key of Object.keys(load())) {
      const slash = key.indexOf('/');
      if (slash > 0) cataloguedProviders.add(key.slice(0, slash).toLowerCase());
    }
  }
  return cataloguedProviders.has(wanted);
}

/**
 * EVERY deployment's effort vocabulary for one model id, unioned.
 *
 * An uncatalogued provider cannot tell us what it accepts, so the honest
 * ceiling is what the model itself is known to support: gateways only ever
 * expose a SUBSET of a model's ladder (`deepseek-v4.1-flash` is catalogued as
 * [high, xhigh] on one, [none, high] on another, all seven on a third), so the
 * union is the model's capability as the catalog evidences it. Memoized — the
 * scan is over the whole snapshot and runs per provider/model pair.
 */
const wideEfforts = new Map<string, string[] | null>();

export function modelWideEfforts(modelId: string): string[] | null {
  const wanted = bareModelPart(modelId.trim().toLowerCase());
  if (!wanted) return null;
  const cached = wideEfforts.get(wanted);
  if (cached !== undefined) return cached;

  const union = new Set<string>();
  for (const [key, meta] of Object.entries(load())) {
    if (bareModelPart(key.toLowerCase()) !== wanted) continue;
    if (meta.reasoning !== true) continue;
    for (const value of meta.efforts ?? []) union.add(String(value).trim().toLowerCase());
  }
  const result = union.size > 0 ? [...union] : null;
  wideEfforts.set(wanted, result);
  return result;
}

/**
 * One tolerant pass over the whole catalog. Priority is specificity: a hit
 * on the FULL provider/model key (steps 1–2) returns immediately, while a
 * bare-model consensus hit (step 3) only counts once the whole map has been
 * scanned for an exact key. Exported for tests (tests/model-lookup.test.ts)
 * so matching rules never depend on the live snapshot's contents.
 */
export function matchCatalogEntry(
  entries: Array<[string, ModelMeta]>,
  wanted: string,
): ModelMeta | undefined {
  const wantExact = stripVariantSuffix(wanted);
  const wantBare = bareModelPart(wanted);
  let bareResult: ModelMeta | undefined;

  for (const [key, meta] of entries) {
    const lowerKey = key.toLowerCase();
    if (stripVariantSuffix(lowerKey) === wantExact) return meta;
    if (!bareResult && bareModelPart(lowerKey) === wantBare) bareResult = meta;
  }

  return bareResult;
}

/**
 * "provider/…/model:variant" → "provider/…/model". OpenRouter and friends
 * publish variant aliases (":free", ":thinking", ":sd"…) as a colon suffix
 * on the model name; the base model carries the real metadata. The colon is
 * only honoured AFTER the last "/", so colons inside provider slugs are left
 * alone.
 */
function stripVariantSuffix(id: string): string {
  const slash = id.lastIndexOf('/');
  if (slash < 0) return id;
  const colon = id.indexOf(':', slash);
  return colon >= 0 ? id.slice(0, colon) : id;
}

/** "provider/xiaomi/mimo-v2.6-flash:free" → "mimo-v2.6-flash" (last segment, variant stripped). */
function bareModelPart(id: string): string {
  const model = id.slice(id.lastIndexOf('/') + 1);
  const colon = model.indexOf(':');
  return colon >= 0 ? model.slice(0, colon) : model;
}

/**
 * Hand-maintained entries for providers models.dev does not list yet.
 * Keyed by the bare model id (lowercase); lookupModelMetadata matches it
 * against any provider/model combination.
 */
const LOCAL_OVERRIDES: MetadataMap = {
  // Atria Dawn Preview: research/coding/agent model, 256K context, 65,536
  'atria-dawn-preview': {
    reasoning: true,
    efforts: ['low', 'medium', 'high'],
    tools: true,
    attachment: true,
    imageIn: false,
    imageOut: false,
    videoIn: false,
    audioIn: false,
    pdfIn: false,
    context: 256_000,
    maxOut: 65_536,
  },
};

export function allModelMetadata(): MetadataMap {
  return load();
}

/**
 * The EFFECTIVE context limit: the model's built-in capacity is the ceiling;
 * a manual cap can only lower it (cost control), never exceed what the model
 * accepts. Mirrors the client-side `effectiveContextLimit` in src/lib/compaction.
 */
export function minLimit(
  modelContext: number | null,
  manualCap: number | null,
): number | null {
  if (modelContext && manualCap) return Math.min(modelContext, manualCap);
  return modelContext ?? manualCap;
}
