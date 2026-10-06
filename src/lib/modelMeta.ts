import type { ModelMeta, ThinkingLevel } from '../types';

/**
 * Canonical order, weakest → strongest. Mirrors `LADDER` in
 * server/reasoning.ts — the two must agree or the UI would offer a level the
 * server cannot place on the scale.
 */
const CANONICAL_LADDER: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** models.dev's effort spelling → canonical level (`none` is the catalog's "off"). */
const FROM_MODELS_DEV: Record<string, ThinkingLevel> = {
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/**
 * Shown when models.dev records no effort vocabulary for a model: the set
 * every reasoning-capable endpoint in practice understands. Hiding is only
 * honest when there is data to hide BY — with none, hiding would be a guess
 * dressed up as a fact.
 */
const PORTABLE_LADDER: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

/**
 * 4B ESCAPE HATCH: an UNCATALOGUED provider serving an UNKNOWN model id gets
 * the FULL ladder — a gateway that names its models uniquely cannot be
 * profiled, and the wire already maps unknown hints to the nearest accepted
 * level (nearestThinkingLevel / server `nearest`), so offering everything and
 * letting the server clamp is more honest than guessing a 4-step subset.
 */
const FULL_LADDER: readonly ThinkingLevel[] = [...CANONICAL_LADDER];

/**
 * The levels a single catalog entry lists — EMPTY when it lists none, so
 * callers can tell "this entry has no effort vocabulary" from "use the
 * fallback". Kept separate from `thinkingLevelsFor`, which owns the fallback
 * policy for a lone entry.
 */
function effortLevelsFromMeta(meta: ModelMeta | undefined): ThinkingLevel[] {
  const mapped = new Set<ThinkingLevel>();
  for (const value of meta?.efforts ?? []) {
    const level = FROM_MODELS_DEV[String(value).trim().toLowerCase()];
    if (level) mapped.add(level);
  }
  return CANONICAL_LADDER.filter((level) => mapped.has(level));
}

/**
 * The thinking levels worth offering for a model, per models.dev.
 *
 * This exists because the ladder is a PER-MODEL fact, not a per-app setting:
 * the same `deepseek-v4.1-flash` id is catalogued as `[high, xhigh]` on one
 * gateway, `[none, high]` on another and `[low, medium, high]` on a third.
 * Offering every level everywhere meant the UI advertised choices the model
 * does not have (and the server quietly rewrote them to a different level).
 *
 *  - no catalog entry  → the portable ladder (nothing to hide by)
 *  - not a reasoning model → Off only; every other level is a lie
 *  - effort values recorded → exactly those, in canonical order
 *  - reasoning, but no effort vocabulary (toggle/budget-only) → portable
 */
export function thinkingLevelsFor(meta: ModelMeta | undefined): ThinkingLevel[] {
  if (!meta) return [...PORTABLE_LADDER];
  if (meta.reasoning !== true) return ['off'];
  const mapped = effortLevelsFromMeta(meta);
  return mapped.length > 0 ? mapped : [...PORTABLE_LADDER];
}

/** Where an offered ladder came from — the UI says so rather than implying certainty. */
export type ThinkingLadderSource = 'provider' | 'model' | 'portable' | 'none';

export interface ThinkingLadder {
  levels: ThinkingLevel[];
  source: ThinkingLadderSource;
}

/**
 * Per-map index. The catalog is a flat `provider/model` → meta record and both
 * questions asked of it here (is this provider catalogued? what does this
 * model support?) are answered by ONE pass, so the pass is cached by map
 * identity — the store hands out the same object for the life of the page.
 */
interface CatalogIndex {
  providers: Set<string>;
  byBareModel: Map<string, ModelMeta[]>;
  /** Full catalog key, lowercased + variant-stripped → its entry (first wins). */
  byExactKey: Map<string, ModelMeta>;
}

const indexes = new WeakMap<Record<string, ModelMeta>, CatalogIndex>();

function indexOf(map: Record<string, ModelMeta>): CatalogIndex {
  const cached = indexes.get(map);
  if (cached) return cached;
  const index: CatalogIndex = { providers: new Set(), byBareModel: new Map(), byExactKey: new Map() };
  for (const [key, meta] of Object.entries(map)) {
    const slash = key.indexOf('/');
    if (slash > 0) index.providers.add(key.slice(0, slash).toLowerCase());
    const exactKey = stripVariantSuffix(key.toLowerCase());
    if (!index.byExactKey.has(exactKey)) index.byExactKey.set(exactKey, meta);
    const bare = bareModelPart(key.toLowerCase());
    const list = index.byBareModel.get(bare);
    if (list) list.push(meta);
    else index.byBareModel.set(bare, [meta]);
  }
  indexes.set(map, index);
  return index;
}

/**
 * The ladder to offer for a provider+model, resolved in two tiers.
 *
 *  1. THE PROVIDER IS CATALOGUED → its own entry wins, restrictions included.
 *     Gateways genuinely narrow a model (`vercel/deepseek/deepseek-v4.1-flash`
 *     lists only [high, xhigh]), and the gateway is the one that will reject
 *     what it does not accept.
 *
 *  2. THE PROVIDER IS NOT CATALOGUED → fall back to the MODEL's own
 *     capability: every level any catalogued deployment of this model id
 *     accepts, unioned. A custom gateway (a UUID id and a hand-typed base
 *     URL) cannot tell us its ladder, and gateways only ever expose a SUBSET
 *     of what the model can do — so the union is the honest ceiling, and the
 *     UI labels it as such instead of pretending to know the gateway.
 *
 * With nothing catalogued at all, the portable ladder stands in.
 */
export function thinkingLadderFor(
  map: Record<string, ModelMeta>,
  providerId: string,
  model: string,
): ThinkingLadder {
  const trimmed = model.trim();
  if (!trimmed) return { levels: [...PORTABLE_LADDER], source: 'portable' };

  const index = indexOf(map);
  const wantedProvider = providerId.trim().toLowerCase();
  const wantedModel = trimmed.toLowerCase();
  const cataloguedProvider = wantedProvider !== '' && index.providers.has(wantedProvider);
  const exact = cataloguedProvider
    ? index.byExactKey.get(stripVariantSuffix(`${wantedProvider}/${wantedModel}`))
    : undefined;

  if (exact) {
    if (exact.reasoning !== true) return { levels: ['off'], source: 'none' };
    const mapped = effortLevelsFromMeta(exact);
    if (mapped.length > 0) return { levels: mapped, source: 'provider' };
  }

  const entries = index.byBareModel.get(bareModelPart(wantedModel)) ?? [];
  const union = new Set<ThinkingLevel>();
  for (const meta of entries) {
    if (meta.reasoning !== true) continue;
    for (const level of effortLevelsFromMeta(meta)) union.add(level);
  }
  if (union.size > 0) {
    return { levels: CANONICAL_LADDER.filter((level) => union.has(level)), source: 'model' };
  }
  if (entries.length > 0) return { levels: ['off'], source: 'none' };
  // 4B: unknown model on an uncatalogued provider — offer the FULL ladder; the
  // wire's nearest-level mapping clamps whatever the endpoint refuses.
  return { levels: [...FULL_LADDER], source: 'portable' };
}

/**
 * The level actually sent, when the stored choice is not one this model
 * offers. Ties resolve DOWNWARD, matching `nearest` in server/reasoning.ts —
 * the hint shown to the user must describe what really goes on the wire.
 */
export function nearestThinkingLevel(
  options: readonly ThinkingLevel[],
  level: ThinkingLevel,
): ThinkingLevel {
  if (options.length === 0) return level;
  if (options.includes(level)) return level;
  const target = CANONICAL_LADDER.indexOf(level);
  return options.reduce((best, candidate) => {
    const d = Math.abs(CANONICAL_LADDER.indexOf(candidate) - target);
    const bestD = Math.abs(CANONICAL_LADDER.indexOf(best) - target);
    return d < bestD ? candidate : best;
  });
}

/**
 * Resolves metadata for a model id from any provider. Matching is
 * provider-tolerant and variant-tolerant: exact "provider/model" key first
 * (an OpenRouter-style ":variant" suffix is stripped from EITHER side, so
 * "bothub/…/gemma-4-31b-it:free" and "mimo-v2.6-flash:free" both resolve to
 * their base model), then the bare model part (last "/" segment) against the
 * whole map. Mirrors the server-side lookup (server/modelMetadata.ts) — keep
 * the two in sync.
 */
export function lookupModelMeta(
  map: Record<string, ModelMeta>,
  modelId: string,
): ModelMeta | undefined {
  const wanted = modelId.trim().toLowerCase();
  if (!wanted) return undefined;
  if (map[wanted]) return map[wanted];

  // RESOLVED-LOOKUP CACHE (the trace's #1 hot spot): the naive scan below
  // iterates EVERY catalog entry with toLowerCase + variant-strip per call —
  // and high-cadence callers (the mid-run pressure sampler, per-keystroke
  // composer renders) made it 67s of self-time in a 213s CPU profile. The
  // index is cached by map identity (same WeakMap the ladder uses), so a
  // repeated lookup is one Map.get.
  const index = indexOf(map);
  const wantExact = stripVariantSuffix(wanted);
  const exact = index.byExactKey.get(wantExact);
  if (exact) return exact;
  return index.byBareModel.get(bareModelPart(wanted))?.[0];
}

/** "provider/…/model:variant" → "provider/…/model" — see the server-side twin. */
function stripVariantSuffix(id: string): string {
  const slash = id.lastIndexOf('/');
  if (slash < 0) return id;
  const colon = id.indexOf(':', slash);
  return colon >= 0 ? id.slice(0, colon) : id;
}

/** "nano-gpt/xiaomi/mimo-v2.6-flash:free" → "mimo-v2.6-flash". */
function bareModelPart(id: string): string {
  const model = id.slice(id.lastIndexOf('/') + 1);
  const colon = model.indexOf(':');
  return colon >= 0 ? model.slice(0, colon) : model;
}
