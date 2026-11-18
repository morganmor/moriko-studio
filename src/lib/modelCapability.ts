

import type {
  ModelCapabilityFlags,
  ModelCapabilitySource,
  ModelMeta,
  ProviderModelConfig,
  ProviderModelHint,
} from '../types';
import { MODEL_CAPABILITY_FLAGS } from '../types';

export interface ResolvedModelCapability extends ModelCapabilityFlags {
  id: string;
  context: number | null;
  maxOut: number | null;
  sources: Record<keyof ModelCapabilityFlags | 'context', ModelCapabilitySource>;
  source: ModelCapabilitySource;
  hint: ModelMeta | undefined;
}


const UNKNOWN_MODEL_DEFAULTS: ModelCapabilityFlags = {
  imageIn: false,
  audioIn: false,
  videoIn: false,
  pdfIn: false,
  tools: true,
  reasoning: false,
  imageOut: false,
};

const SOURCE_RANK: Record<ModelCapabilitySource, number> = {
  user: 3,
  provider: 2,
  'models.dev': 1,
  default: 0,
};


export function resolveModelCapability(
  id: string,
  config?: ProviderModelConfig | null,
  hint?: ProviderModelHint | null,
  catalogEntry?: ModelMeta | undefined,
): ResolvedModelCapability {
  const meta = catalogEntry;
  const pinned = new Set<string>(config?.pinned ?? []);
  const sources = {} as Record<keyof ModelCapabilityFlags | 'context', ModelCapabilitySource>;
  const flags = {} as ModelCapabilityFlags;

  for (const key of MODEL_CAPABILITY_FLAGS) {
    const isPinned = pinned.has(key);
    const layer1 = config ? config[key] : undefined;
    const layer2 = hint ? hint[key] : undefined;
    const layer3 = meta && typeof meta[key] === 'boolean' ? (meta[key] as boolean) : undefined;

    if (isPinned && typeof layer1 === 'boolean') {
      flags[key] = layer1;
      sources[key] = 'user';
    } else if (typeof layer2 === 'boolean') {
      flags[key] = layer2;
      sources[key] = 'provider';
    } else if (typeof layer3 === 'boolean') {
      flags[key] = layer3;
      sources[key] = 'models.dev';
    } else if (typeof layer1 === 'boolean') {
      flags[key] = layer1;
      sources[key] = config?.source ?? 'user';
    } else {
      flags[key] = UNKNOWN_MODEL_DEFAULTS[key];
      sources[key] = 'default';
    }
  }

  let context: number | null;
  if (pinned.has('context') && typeof config?.context === 'number' && config.context > 0) {
    context = config.context;
    sources.context = 'user';
  } else if (typeof hint?.context === 'number' && hint.context > 0) {
    context = hint.context;
    sources.context = 'provider';
  } else if (typeof meta?.context === 'number' && meta.context > 0) {
    context = meta.context;
    sources.context = 'models.dev';
  } else if (typeof config?.context === 'number' && config.context > 0) {
    context = config.context;
    sources.context = config.source;
  } else {
    context = null;
    sources.context = 'default';
  }

  const maxOut =
    (typeof config?.maxOut === 'number' && config.maxOut > 0 ? config.maxOut : null) ??
    (typeof hint?.maxOut === 'number' && hint.maxOut > 0 ? hint.maxOut : null) ??
    (typeof meta?.maxOut === 'number' && meta.maxOut > 0 ? meta.maxOut : null);

  let strongest: ModelCapabilitySource = 'default';
  for (const value of Object.values(sources)) {
    if (SOURCE_RANK[value] > SOURCE_RANK[strongest]) strongest = value;
  }

  return {
    id,
    ...flags,
    context,
    maxOut,
    sources,
    source: strongest,
    hint: meta,
  };
}


export function resolveForProvider(
  providers: readonly { id: string; modelConfigs?: Record<string, ProviderModelConfig>; modelHints?: Record<string, ProviderModelHint> }[],
  providerId: string,
  modelId: string,
  catalogEntry?: ModelMeta | undefined,
): ResolvedModelCapability {
  const provider = providers.find((entry) => entry.id === providerId);
  return resolveModelCapability(
    modelId,
    provider?.modelConfigs?.[modelId],
    provider?.modelHints?.[modelId],
    catalogEntry,
  );
}


export function formatContextSize(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return '—';
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : Number(millions.toFixed(2))}M`;
  }
  if (tokens >= 1000) {
    const thousands = tokens / 1000;
    return `${Number.isInteger(thousands) ? thousands : Number(thousands.toFixed(1))}K`;
  }
  return String(tokens);
}


export function parseContextSize(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (text === '') return null;

  const match = text.match(/^([0-9]+(?:[.,][0-9]+)*)([km]?)$/);
  if (!match) return null;

  const [, digits, suffix] = match;
  const normalized = suffix
    ? digits.replace(',', '.')
    : digits.replace(/[.,](?=[0-9]{3}(?:[.,]|$))/g, '').replace(',', '.');

  let amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (suffix === 'k') amount *= 1000;
  if (suffix === 'm') amount *= 1_000_000;

  const tokens = Math.round(amount);
  if (tokens < 256) return null;
  return Math.min(100_000_000, tokens);
}


export function sourceLabel(source: ModelCapabilitySource): string {
  switch (source) {
    case 'user': return 'Manual';
    case 'provider': return 'Provider';
    case 'models.dev': return 'models.dev';
    default: return 'Default';
  }
}


export function buildModelConfig(
  id: string,
  hint: ProviderModelHint | null | undefined,
  catalogEntry: ModelMeta | undefined,
): ProviderModelConfig {
  const resolved = resolveModelCapability(id, null, hint, catalogEntry);
  return {
    id,
    imageIn: resolved.imageIn,
    audioIn: resolved.audioIn,
    videoIn: resolved.videoIn,
    pdfIn: resolved.pdfIn,
    tools: resolved.tools,
    reasoning: resolved.reasoning,
    imageOut: resolved.imageOut,
    context: resolved.context,
    maxOut: resolved.maxOut,
    source: resolved.source,
    pinned: [],
  };
}
