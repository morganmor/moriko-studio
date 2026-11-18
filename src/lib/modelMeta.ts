import type { ModelMeta, ThinkingLevel } from '../types';


const CANONICAL_LADDER: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];


const FROM_MODELS_DEV: Record<string, ThinkingLevel> = {
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};


const PORTABLE_LADDER: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high'];


const FULL_LADDER: readonly ThinkingLevel[] = [...CANONICAL_LADDER];


function effortLevelsFromMeta(meta: ModelMeta | undefined): ThinkingLevel[] {
  const mapped = new Set<ThinkingLevel>();
  for (const value of meta?.efforts ?? []) {
    const level = FROM_MODELS_DEV[String(value).trim().toLowerCase()];
    if (level) mapped.add(level);
  }
  return CANONICAL_LADDER.filter((level) => mapped.has(level));
}


export function thinkingLevelsFor(meta: ModelMeta | undefined): ThinkingLevel[] {
  if (!meta) return [...PORTABLE_LADDER];
  if (meta.reasoning !== true) return ['off'];
  const mapped = effortLevelsFromMeta(meta);
  return mapped.length > 0 ? mapped : [...PORTABLE_LADDER];
}


export type ThinkingLadderSource = 'provider' | 'model' | 'portable' | 'none';

export interface ThinkingLadder {
  levels: ThinkingLevel[];
  source: ThinkingLadderSource;
}


interface CatalogIndex {
  providers: Set<string>;
  byBareModel: Map<string, ModelMeta[]>;
  
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


const CAPABILITY_TOKENS = new Set([
  'vl', 'vision', 'image', 'omni', 'multimodal',
  'audio', 'video', 'pdf', 'tts', 'transcribe',
  'base', 'it', 'latest',
]);


const MIN_CORE_TOKENS = 2;


function modelTokens(id: string): string[] {
  return id
    .split(/[^a-z0-9.]+/i)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}


function coreModelName(bare: string, known: (name: string) => boolean): string {
  if (known(bare)) return bare;
  const tokens = modelTokens(bare);
  for (let size = tokens.length - 1; size >= MIN_CORE_TOKENS; size -= 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      const dropped = tokens.filter((_, index) => index < start || index >= start + size);
      if (dropped.some((token) => CAPABILITY_TOKENS.has(token))) continue;
      const candidate = tokens.slice(start, start + size).join('-');
      if (known(candidate)) return candidate;
    }
  }
  return bare;
}


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

  const entries = index.byBareModel.get(coreModelName(bareModelPart(wantedModel), (name) => index.byBareModel.has(name))) ?? [];
  const union = new Set<ThinkingLevel>();
  for (const meta of entries) {
    if (meta.reasoning !== true) continue;
    for (const level of effortLevelsFromMeta(meta)) union.add(level);
  }
  if (union.size > 0) {
    return { levels: CANONICAL_LADDER.filter((level) => union.has(level)), source: 'model' };
  }
  if (entries.length > 0) return { levels: ['off'], source: 'none' };
  return { levels: [...FULL_LADDER], source: 'portable' };
}


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


export function lookupModelMeta(
  map: Record<string, ModelMeta>,
  modelId: string,
): ModelMeta | undefined {
  const wanted = modelId.trim().toLowerCase();
  if (!wanted) return undefined;
  if (map[wanted]) return map[wanted];

  const index = indexOf(map);
  const wantExact = stripVariantSuffix(wanted);
  const exact = index.byExactKey.get(wantExact);
  if (exact) return exact;

  const bare = bareModelPart(wanted);
  const direct = index.byBareModel.get(bare)?.[0];
  if (direct) return direct;
  return index.byBareModel.get(coreModelName(bare, (name) => index.byBareModel.has(name)))?.[0];
}


function stripVariantSuffix(id: string): string {
  const slash = id.lastIndexOf('/');
  if (slash < 0) return id;
  const colon = id.indexOf(':', slash);
  return colon >= 0 ? id.slice(0, colon) : id;
}


function bareModelPart(id: string): string {
  const model = id.slice(id.lastIndexOf('/') + 1);
  const colon = model.indexOf(':');
  return colon >= 0 ? model.slice(0, colon) : model;
}
