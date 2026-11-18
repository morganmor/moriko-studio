

import type {
  ModelCapabilityFlags,
  ModelCapabilitySource,
  ProviderModelConfig,
  ProviderModelHint,
} from './contracts.js';
import { MODEL_CAPABILITY_FLAGS } from './contracts.js';
import { lookupModelMetadata, type ModelMeta } from './modelMetadata.js';


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


function fromCatalog(
  meta: ModelMeta | undefined,
  key: keyof ModelCapabilityFlags,
): boolean | undefined {
  if (!meta) return undefined;
  const value = meta[key];
  return typeof value === 'boolean' ? value : undefined;
}


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
    const layer3 = fromCatalog(meta, key);

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

  return {
    id,
    ...flags,
    context,
    maxOut,
    sources,
    source: strongestSource(sources),
    hint: meta,
  };
}


const SOURCE_RANK: Record<ModelCapabilitySource, number> = {
  user: 3,
  provider: 2,
  'models.dev': 1,
  default: 0,
};

function strongestSource(
  sources: Record<keyof ModelCapabilityFlags | 'context', ModelCapabilitySource>,
): ModelCapabilitySource {
  let best: ModelCapabilitySource = 'default';
  for (const value of Object.values(sources)) {
    if (SOURCE_RANK[value] > SOURCE_RANK[best]) best = value;
  }
  return best;
}


export function resolveWithoutProvider(id: string): ResolvedModelCapability {
  return resolveModelCapability(id, null, null, lookupModelMetadata(id));
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


export function refreshModelConfigs(
  ids: readonly string[],
  existing: Record<string, ProviderModelConfig> | undefined,
  hints: Record<string, ProviderModelHint> | undefined,
  catalogFor: (id: string) => ModelMeta | undefined,
): Record<string, ProviderModelConfig> {
  const next: Record<string, ProviderModelConfig> = {};
  for (const id of ids) {
    const config = existing?.[id];
    const hint = hints?.[id];
    const resolved = resolveModelCapability(id, config, hint, catalogFor(id));
    next[id] = {
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
      pinned: config?.pinned ?? [],
    };
  }
  return next;
}
