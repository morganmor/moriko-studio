/**
 * THE 3-LAYER CAPABILITY CASCADE — the single authority the runtime and the UI
 * both consult. Nothing else may decide what a model accepts.
 *
 *   LAYER 1  ProviderModelConfig  (the user's own table in the Providers dialog)
 *            ABSOLUTE. A pinned field is what the model does, full stop — even
 *            when models.dev contradicts it, even when the model is not in the
 *            catalogue at all. This layer is the reason the cascade exists.
 *
 *   LAYER 2  ProviderModelHint    (introspected from the provider's /models)
 *            Used for any field Layer 1 did not pin. Sparse by nature: a
 *            gateway that publishes `{id}` alone contributes nothing, which is
 *            an answer, not a failure.
 *
 *   LAYER 3  models.dev snapshot  (server/modelMetadata.ts)
 *            A HINT. It pre-fills Layer 2's gaps and supplies the UI badge. It
 *            never vetoes a user value and never truncates a context window.
 *
 * PER-FIELD RESOLUTION, never per-row: the layers are consulted independently
 * for each capability bit and for the context window, because real endpoints
 * are wildly uneven — OpenRouter publishes modalities but no tool flag, vLLM
 * publishes a context length and nothing else. A per-row "which layer wins"
 * rule would throw away the fields a lower layer actually knows.
 */

import type {
  ModelCapabilityFlags,
  ModelCapabilitySource,
  ProviderModelConfig,
  ProviderModelHint,
} from './contracts.js';
import { MODEL_CAPABILITY_FLAGS } from './contracts.js';
import { lookupModelMetadata, type ModelMeta } from './modelMetadata.js';

/**
 * The fully resolved view of one model. Every field carries its own
 * provenance so no consumer has to guess (or lie) about where a value came
 * from — the vision gate reads `imageIn`, the composer reads `contextSource`.
 */
export interface ResolvedModelCapability extends ModelCapabilityFlags {
  id: string;
  context: number | null;
  maxOut: number | null;
  /** Per-field provenance, keyed by the same names as the flags. */
  sources: Record<keyof ModelCapabilityFlags | 'context', ModelCapabilitySource>;
  /** The strongest layer that answered anything (the row badge). */
  source: ModelCapabilitySource;
  /** Set when a models.dev entry exists — the UI's tooltip hint. */
  hint: ModelMeta | undefined;
}

/**
 * FACTS ABOUT AN UNKNOWN MODEL, stated once. These are not guesses dressed as
 * knowledge: they are the behaviour a text-only endpoint exhibits, and every
 * one of them is overridable by a single checkbox in Layer 1.
 *
 * `tools: true` / `reasoning: false` deserve a note. An unknown model is
 * offered tools because the tool catalogue is only ever sent when the request
 * carries it — a model that rejects tools errors visibly and recoverably,
 * while a model wrongly denied tools silently loses the entire agent harness.
 * Reasoning defaults off because sending an unsupported thinking parameter is
 * a hard 400 on strict gateways.
 */
const UNKNOWN_MODEL_DEFAULTS: ModelCapabilityFlags = {
  imageIn: false,
  audioIn: false,
  videoIn: false,
  pdfIn: false,
  tools: true,
  reasoning: false,
  imageOut: false,
};

/** What Layer 3 says for one flag, or undefined when the catalogue is silent. */
function fromCatalog(
  meta: ModelMeta | undefined,
  key: keyof ModelCapabilityFlags,
): boolean | undefined {
  if (!meta) return undefined;
  const value = meta[key];
  // Older snapshot rows genuinely lack videoIn/audioIn/pdfIn — an absent key
  // is "unknown", not false, or every legacy entry would read as text-only.
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Resolves ONE model through the cascade.
 *
 * `config` is the user's Layer-1 row (may be absent), `hint` the Layer-2 row
 * captured at fetch time. Both are looked up by the caller because the caller
 * already holds the provider record — this function stays pure, so the same
 * code serves the chat route, the adapters, the agent tools and the UI.
 */
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
      // An UNPINNED Layer-1 value is a cached resolution from an earlier
      // session. It beats the documented default but loses to live evidence.
      flags[key] = layer1;
      sources[key] = config?.source ?? 'user';
    } else {
      flags[key] = UNKNOWN_MODEL_DEFAULTS[key];
      sources[key] = 'default';
    }
  }

  // CONTEXT gets its own ladder, and it is SHORTER than the flag ladder:
  // Layer 1 (user table) then Layer 2 (provider introspection). That is all.
  //
  // models.dev is DELIBERATELY ABSENT. A catalogue row is not a measurement of
  // the endpoint in front of us — it is a third-party guess that lags providers
  // and, for a self-hosted or gateway model, describes a different deployment
  // entirely. Using it here capped a 1M-context model at 256K and killed live
  // runs at ~90% of a number the user never declared.
  //
  // When neither layer knows the window the answer is `null` (guard off), which
  // is honest. "Guard off" costs a late provider error at worst; a wrong number
  // truncates real work in the middle of a task.
  let context: number | null;
  if (pinned.has('context') && typeof config?.context === 'number' && config.context > 0) {
    context = config.context;
    sources.context = 'user';
  } else if (typeof hint?.context === 'number' && hint.context > 0) {
    context = hint.context;
    sources.context = 'provider';
  } else if (
    typeof config?.context === 'number' &&
    config.context > 0 &&
    // A cached row whose provenance is the CATALOGUE is a catalogue echo, not
    // a user decision. Reusing it here would smuggle models.dev back in as the
    // runtime limit through the side door — exactly the cap being removed.
    config.source !== 'models.dev'
  ) {
    context = config.context;
    sources.context = config.source;
  } else {
    context = null;
    sources.context = 'default';
  }

  // maxOut follows the same order; models.dev is the only layer that usually
  // carries it, so it is the one field where Layer 3 legitimately leads.
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

/** Rank so the row badge reports the most authoritative contributor. */
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

/**
 * Convenience for callers that only have a model id (agent tools, the vision
 * policy): Layer 1/2 are unavailable there, so this is catalog + defaults.
 * Exported so no call site invents its own two-line version of the cascade.
 */
export function resolveWithoutProvider(id: string): ResolvedModelCapability {
  return resolveModelCapability(id, null, null, lookupModelMetadata(id));
}

/**
 * Builds a fresh Layer-1 row for a model the user just added or fetched.
 *
 * `pinned` starts EMPTY: a pre-filled row is a suggestion the layers below may
 * still refine, not a user decision. Only an explicit edit pins a field.
 */
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

/**
 * Re-resolves every row of a provider's table against fresh Layer-2 evidence,
 * PRESERVING pinned fields. Used after "Fetch from provider" so a re-fetch can
 * improve rows the user never touched without ever undoing their edits.
 */
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
