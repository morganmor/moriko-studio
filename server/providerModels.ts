/**
 * LAYER 2 — what a provider's OWN model-list endpoint publishes, extracted
 * without loss.
 *
 * The old code did `(payload.data ?? []).map(m => m.id)` — it read the id and
 * threw the rest of the JSON away, which is why every capability decision had
 * to fall back to models.dev. This module keeps what the endpoint actually
 * said, per endpoint family, and reports NOTHING when an endpoint says nothing
 * (bare `{ id }` payloads are the common case and stay hint-free on purpose).
 *
 * Every extractor is field-optional: a missing field means "this endpoint is
 * silent about it", never "false". That distinction is what lets Layer 3 act
 * as a hint rather than a verdict.
 */

import type { ProviderModelEntry, ProviderModelHint } from './contracts.js';

const TIMEOUT_MS = 12_000;

/** A provider's model list plus the endpoint family that answered. */
export interface ProviderModelListing {
  entries: ProviderModelEntry[];
  /** Which extractor produced the hints (also recorded per entry). */
  family: NonNullable<ProviderModelHint['from']>;
}

/** Loose JSON object reader — every provider payload is untrusted. */
type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Positive finite number, or null. Guards against strings, NaN, 0, negatives. */
function asCount(value: unknown): number | null {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Reads a dotted path ("top_provider.context_length") out of a payload. */
function pick(source: Json | null, path: string): unknown {
  if (!source) return undefined;
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    const object = asObject(cursor);
    if (!object) return undefined;
    cursor = object[segment];
  }
  return cursor;
}

/**
 * Maps an `architecture.input_modalities` list (OpenRouter) to capability
 * bits. The vocabulary is small and documented: text, image, audio, video,
 * file. `file` is what OpenRouter calls a document/PDF part.
 */
function fromModalities(values: readonly string[]): ProviderModelHint {
  const set = new Set(values.map((value) => value.trim().toLowerCase()));
  const hint: ProviderModelHint = {};
  if (set.size === 0) return hint;
  // A list that arrived means the endpoint DID speak: record every bit,
  // including the negatives, because absence from the list is authoritative.
  hint.imageIn = set.has('image');
  hint.audioIn = set.has('audio');
  hint.videoIn = set.has('video');
  hint.pdfIn = set.has('file') || set.has('pdf');
  return hint;
}

/**
 * Reads `supported_parameters`-style capability lists (OpenRouter ships
 * `["tools","reasoning","include_reasoning",…]`). Returns undefined for a
 * missing list so "no list" never becomes "no tools".
 */
function fromSupportedParameters(values: unknown): ProviderModelHint {
  const list = asArray(values).map((value) => asString(value)).filter((v): v is string => !!v);
  if (list.length === 0) return {};
  const set = new Set(list.map((value) => value.toLowerCase()));
  return {
    tools: set.has('tools') || set.has('tool_choice') || set.has('function_calling'),
    reasoning:
      set.has('reasoning') ||
      set.has('include_reasoning') ||
      set.has('reasoning_effort') ||
      set.has('thinking'),
  };
}

/**
 * OPENROUTER / GATEWAY-COMPATIBLE `/v1/models`.
 *
 * Reads `context_length`, `top_provider.context_length`,
 * `architecture.input_modalities`, `architecture.output_modalities` and
 * `supported_parameters` — the fields that make OpenRouter's list far richer
 * than a bare id, and the reason routing it through models.dev was redundant.
 */
export function readOpenRouterEntry(raw: unknown): ProviderModelEntry | null {
  const entry = asObject(raw);
  const id = asString(entry?.id) ?? asString(entry?.name);
  if (!id || !entry) return null;

  const hint: ProviderModelHint = { from: 'openrouter' };

  const context =
    asCount(entry.context_length) ?? asCount(pick(entry, 'top_provider.context_length'));
  if (context) hint.context = context;

  const maxOut =
    asCount(entry.max_completion_tokens) ??
    asCount(pick(entry, 'top_provider.max_completion_tokens')) ??
    asCount(pick(entry, 'per_request_limits.max_completion_tokens'));
  if (maxOut) hint.maxOut = maxOut;

  const inputModalities = asArray(pick(entry, 'architecture.input_modalities'))
    .map((value) => asString(value))
    .filter((v): v is string => !!v);
  Object.assign(hint, fromModalities(inputModalities));

  const outputModalities = asArray(pick(entry, 'architecture.output_modalities'))
    .map((value) => asString(value))
    .filter((v): v is string => !!v);
  if (outputModalities.length > 0) {
    hint.imageOut = outputModalities.some((value) => value.toLowerCase() === 'image');
  }

  Object.assign(hint, fromSupportedParameters(entry.supported_parameters));

  const name = asString(entry.name);
  if (name) hint.label = name;

  return { id, hint: prune(hint) };
}

/**
 * LM STUDIO `/api/v0/models` — the richest local endpoint: `max_context_length`
 * (the model's ceiling), `loaded_context_length` (what is loaded NOW, which is
 * the honest number to respect), `type === 'vlm'` for vision, plus tool and
 * reasoning flags.
 */
export function readLmStudioEntry(raw: unknown): ProviderModelEntry | null {
  const entry = asObject(raw);
  const id = asString(entry?.id) ?? asString(entry?.model_key);
  if (!entry || !id) return null;

  const hint: ProviderModelHint = { from: 'lmstudio' };
  // `loaded_context_length` wins when present: it is the window the server will
  // actually serve, which is smaller than the model's theoretical maximum.
  const context = asCount(entry.loaded_context_length) ?? asCount(entry.max_context_length);
  if (context) hint.context = context;

  const type = asString(entry.type)?.toLowerCase();
  if (type) hint.imageIn = type === 'vlm' || type === 'multimodal';

  const tools = asBoolean(entry.trained_for_tool_use);
  if (tools !== undefined) hint.tools = tools;
  const reasoning = asBoolean(entry.reasoning);
  if (reasoning !== undefined) hint.reasoning = reasoning;

  const publisher = asString(entry.publisher);
  if (publisher) hint.label = `${publisher}/${id}`;

  return { id, hint: prune(hint) };
}

/**
 * vLLM `/v1/models` — publishes `max_model_len` (the served window) and, on
 * newer builds, `capabilities` / modality hints. Everything else is bare.
 */
export function readVllmEntry(raw: unknown): ProviderModelEntry | null {
  const entry = asObject(raw);
  const id = asString(entry?.id);
  if (!entry || !id) return null;

  const hint: ProviderModelHint = { from: 'vllm' };
  const context = asCount(entry.max_model_len);
  if (context) hint.context = context;

  const modalities = asArray(entry.modalities).map((value) => asString(value)).filter((v): v is string => !!v);
  Object.assign(hint, fromModalities(modalities));

  return { id, hint: prune(hint) };
}

/** GOOGLE GEMINI `/v1beta/models` — `inputTokenLimit` / `outputTokenLimit`. */
export function readGeminiEntry(raw: unknown): ProviderModelEntry | null {
  const entry = asObject(raw);
  const id = asString(entry?.name)?.replace(/^models\//, '');
  if (!entry || !id) return null;

  const hint: ProviderModelHint = { from: 'gemini' };
  const context = asCount(entry.inputTokenLimit);
  if (context) hint.context = context;
  const maxOut = asCount(entry.outputTokenLimit);
  if (maxOut) hint.maxOut = maxOut;

  const methods = asArray(entry.supportedGenerationMethods)
    .map((value) => asString(value))
    .filter((v): v is string => !!v);
  if (methods.length > 0 && !methods.includes('generateContent')) return null;

  const displayName = asString(entry.displayName);
  if (displayName) hint.label = displayName;

  // Gemini's multimodal flags are not published per model on this endpoint;
  // only the output modality for image models is stated.
  if (asArray(entry.outputModalities).length > 0) {
    const output = asArray(entry.outputModalities)
      .map((value) => asString(value))
      .filter((v): v is string => !!v)
      .map((value) => value.toLowerCase());
    hint.imageOut = output.includes('image');
  }

  return { id, hint: prune(hint) };
}

/** ANTHROPIC `/v1/models` — id, display_name, created_at. No capability data. */
export function readAnthropicEntry(raw: unknown): ProviderModelEntry | null {
  const entry = asObject(raw);
  const id = asString(entry?.id);
  if (!entry || !id) return null;
  const hint: ProviderModelHint = { from: 'anthropic' };
  const label = asString(entry.display_name);
  if (label) hint.label = label;
  return { id, hint };
}

/** Whether a `/v1/models` row carries Mistral's `capabilities` object. */
function isMistralModelObject(entry: Json): boolean {
  const caps = asObject(entry.capabilities);
  return caps !== null && ('completion_chat' in caps || 'function_calling' in caps);
}

/**
 * MISTRAL `/v1/models` — publishes `max_context_length` and `capabilities`
 * (`completion_chat`, `function_calling`, `vision`, `audio_transcription`).
 * Rows that explicitly set `completion_chat: false` or `archived: true` are
 * non-chat models (embeddings, OCR, moderation) and are filtered out.
 */
export function readMistralEntry(raw: unknown): ProviderModelEntry | null {
  const entry = asObject(raw);
  const id = asString(entry?.id);
  if (!entry || !id) return null;
  if (asBoolean(entry.archived) === true) return null;

  const caps = asObject(entry.capabilities);
  if (caps && asBoolean(caps.completion_chat) === false) return null;

  const hint: ProviderModelHint = { from: 'mistral' };
  const context = asCount(entry.max_context_length) ?? asCount(entry.context_length);
  if (context) hint.context = context;
  const maxOut = asCount(entry.max_completion_tokens) ?? asCount(entry.max_output_tokens);
  if (maxOut) hint.maxOut = maxOut;

  if (caps) {
    const tools = asBoolean(caps.function_calling);
    if (tools !== undefined) hint.tools = tools;
    const vision = asBoolean(caps.vision);
    if (vision !== undefined) hint.imageIn = vision;
    const audio = asBoolean(caps.audio_transcription) ?? asBoolean(caps.audio);
    if (audio !== undefined) hint.audioIn = audio;
    const reasoning = asBoolean(caps.reasoning);
    if (reasoning !== undefined) hint.reasoning = reasoning;
  }

  const label = asString(entry.name);
  if (label && label !== id) hint.label = label;

  return { id, hint: prune(hint) };
}

/**
 * llama.cpp `/props` describes ONE loaded model, not a list — used to fill the
 * `n_ctx` (served context) and modality flags of whatever ids the server
 * reports. Returned separately from the listing because it is server-wide.
 */
export function readLlamaCppProps(raw: unknown): ProviderModelHint {
  const props = asObject(raw);
  if (!props) return {};
  const hint: ProviderModelHint = { from: 'llamacpp' };
  const defaultGen = asObject(props.default_generation_settings);
  const context = asCount(defaultGen?.n_ctx) ?? asCount(props.n_ctx);
  if (context) hint.context = context;
  if (asBoolean(props.multimodal) === true || asBoolean(props.mmproj_loaded) === true) {
    hint.imageIn = true;
  }
  return prune(hint);
}

/** OLLAMA `/api/tags` + `/api/show` — family-level modality and context. */
export function readOllamaEntry(raw: unknown): ProviderModelEntry | null {
  const entry = asObject(raw);
  const id = asString(entry?.name) ?? asString(entry?.model);
  if (!entry || !id) return null;

  const hint: ProviderModelHint = { from: 'ollama' };
  const details = asObject(entry.details);
  const families = asArray(details?.families)
    .map((value) => asString(value))
    .filter((v): v is string => !!v)
    .map((value) => value.toLowerCase());
  if (families.length > 0) {
    hint.imageIn = families.includes('clip') || families.includes('vision') || families.includes('mllama');
  }

  const context = asCount(entry.context_length);
  if (context) hint.context = context;

  return { id, hint: prune(hint) };
}

/**
 * OLLAMA `/api/show` payload for ONE model — `model_info` carries the real
 * context length under an architecture-prefixed key.
 */
export function readOllamaShow(raw: unknown): ProviderModelHint {
  const show = asObject(raw);
  if (!show) return {};
  const info = asObject(show.model_info);
  const hint: ProviderModelHint = { from: 'ollama' };

  let context: number | null = null;
  for (const [key, value] of Object.entries(info ?? {})) {
    if (!key.endsWith('.context_length')) continue;
    context = asCount(value);
    if (context) break;
  }
  if (context) hint.context = context;

  const families = asArray(info?.['general.architecture'])
    .map((value) => asString(value))
    .filter((v): v is string => !!v);
  if (families.some((value) => /vl|vision|mllama|clip/i.test(value))) hint.imageIn = true;

  return prune(hint);
}

/**
 * FALLBACK for an unknown OpenAI-compatible payload: walk `data[]`, keep the
 * ids, and harvest any of the well-known field names that happen to be there.
 * This is how a vendor we have never profiled still contributes when it
 * chooses to publish something.
 */
export function readOpaqueEntry(raw: unknown): ProviderModelEntry | null {
  const entry = asObject(raw);
  const id = asString(entry?.id) ?? asString(entry?.name) ?? asString(entry?.model);
  if (!entry || !id) return null;

  const hint: ProviderModelHint = { from: 'opaque' };
  const context =
    asCount(entry.context_length) ??
    asCount(entry.max_context_length) ??
    asCount(entry.max_model_len) ??
    asCount(entry.context_window) ??
    asCount(pick(entry, 'top_provider.context_length'));
  if (context) hint.context = context;

  const maxOut = asCount(entry.max_completion_tokens) ?? asCount(entry.max_output_tokens);
  if (maxOut) hint.maxOut = maxOut;

  const modalities = asArray(entry.input_modalities ?? pick(entry, 'architecture.input_modalities'))
    .map((value) => asString(value))
    .filter((v): v is string => !!v);
  Object.assign(hint, fromModalities(modalities));
  Object.assign(hint, fromSupportedParameters(entry.supported_parameters));

  return { id, hint: prune(hint) };
}

/** Drops undefined/empty so a hint object only ever carries real claims. */
function prune(hint: ProviderModelHint): ProviderModelHint {
  const out: ProviderModelHint = {};
  for (const [key, value] of Object.entries(hint)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Normalizes ONE raw list entry, trying the richest extractor the payload
 * shape allows and falling back outward. Order matters: an LM Studio payload
 * also has `id`, so the fields are checked before the bare-opaque branch.
 */
export function readModelEntry(raw: unknown): ProviderModelEntry | null {
  const entry = asObject(raw);
  if (!entry) return null;

  if (isMistralModelObject(entry)) return readMistralEntry(entry);

  const isLmStudio = 'max_context_length' in entry || 'trained_for_tool_use' in entry || 'type' in entry;
  const isVllm = 'max_model_len' in entry;
  const isOpenRouter = 'supported_parameters' in entry || 'architecture' in entry || 'top_provider' in entry;

  if (isLmStudio) return readLmStudioEntry(entry);
  if (isOpenRouter) return readOpenRouterEntry(entry);
  if (isVllm) return readVllmEntry(entry);
  return readOpaqueEntry(entry);
}

/**
 * Builds a listing from an already-parsed `/models` payload plus the endpoint
 * family hint. Used by the route once it knows which URL answered.
 */
export function listingFromPayload(
  payload: unknown,
  family: ProviderModelListing['family'],
): ProviderModelListing {
  const root = asObject(payload);
  const rows = asArray(root?.data ?? root?.models ?? root?.results ?? payload);

  const seen = new Set<string>();
  const entries: ProviderModelEntry[] = [];
  for (const row of rows) {
    const parsed =
      family === 'gemini'
        ? readGeminiEntry(row)
        : family === 'anthropic'
          ? readAnthropicEntry(row)
          : family === 'mistral'
            ? readMistralEntry(row)
            : family === 'lmstudio'
              ? readLmStudioEntry(row)
              : family === 'vllm'
                ? readVllmEntry(row)
                : family === 'ollama'
                  ? readOllamaEntry(row)
                  : family === 'openrouter'
                    ? readOpenRouterEntry(row)
                    : readModelEntry(row);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    entries.push(parsed);
  }
  return { entries, family };
}

/**
 * Merges a server-wide hint (llama.cpp `/props`) into every entry that did not
 * state its own context. Per-entry evidence always wins over the server-wide
 * default, because a proxy can serve several windows at once.
 */
export function applyServerWideHint(
  listing: ProviderModelListing,
  hint: ProviderModelHint,
): ProviderModelListing {
  if (Object.keys(hint).length === 0) return listing;
  return {
    ...listing,
    entries: listing.entries.map((entry) => ({
      id: entry.id,
      hint: { ...hint, ...entry.hint, from: entry.hint.from ?? hint.from },
    })),
  };
}

/** GET helper with a bounded timeout; the caller turns !ok into an HttpError. */
export async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const status: number = response.status;
  if (!response.ok) return { ok: false, status, payload: null };
  try {
    return { ok: true, status, payload: (await response.json()) as unknown };
  } catch {
    return { ok: true, status, payload: null };
  }
}

/** Turns a listing into the sparse map the store persists (Layer 2 table). */
export function hintsFromListing(
  listing: ProviderModelListing,
): Record<string, ProviderModelHint> {
  const out: Record<string, ProviderModelHint> = {};
  for (const entry of listing.entries) {
    // A family-only hint ("from: opaque") carries no claim — storing it would
    // make the UI badge claim provider provenance for zero information.
    if (Object.keys(entry.hint).every((key) => key === 'from')) continue;
    out[entry.id] = entry.hint;
  }
  return out;
}

/** Which family answered — decides headers, paths and the extractor. */
export type ProbeKind = 'openai' | 'gemini' | 'anthropic' | 'mistral';

export interface ProbeTarget {
  baseUrl: string;
  apiKey?: string;
  kind: ProbeKind;
}

export interface ProbeResult extends ProviderModelListing {
  /** Opaque ids from `${base}/image-models` (image-only gateways). */
  imageModels: string[];
  /** True when the endpoint answered, false when it rejected (for the Test button). */
  answered: boolean;
}

/** Rejects the promise on a non-2xx so callers keep their HttpError surface. */
export class ProbeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProbeError';
    this.status = status;
  }
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Reads the provider's OWN model list, keeping the metadata it publishes
 * (Layer 2). This is the single implementation behind both "Fetch from
 * provider" entry points — the saved-provider route and the draft probe.
 *
 * Local runtimes are detected by the payload shape rather than a hardcoded
 * vendor list, so LM Studio / vLLM / llama.cpp / Ollama all work on a plain
 * `kind: 'openai'` provider without the user picking a family.
 */
export async function probeProviderModels(target: ProbeTarget): Promise<ProbeResult> {
  const base = trimBase(target.baseUrl);

  if (target.kind === 'gemini') {
    const { ok, status, payload } = await fetchJson(
      `${base}/models?pageSize=200`,
      target.apiKey ? { 'x-goog-api-key': target.apiKey } : {},
    );
    if (!ok) throw new ProbeError('Gemini rejected the model list request.', status);
    const listing = listingFromPayload(payload, 'gemini');
    return { ...listing, imageModels: [], answered: true };
  }

  if (target.kind === 'anthropic') {
    const { ok, status, payload } = await fetchJson(`${base}/models`, {
      ...(target.apiKey ? { 'x-api-key': target.apiKey } : {}),
      'anthropic-version': '2023-06-01',
    });
    if (!ok) throw new ProbeError('Anthropic rejected the model list request.', status);
    const listing = listingFromPayload(payload, 'anthropic');
    return { ...listing, imageModels: [], answered: true };
  }

  if (target.kind === 'mistral') {
    const { ok, status, payload } = await fetchJson(
      `${base}/models`,
      target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {},
    );
    if (!ok) throw new ProbeError('Mistral rejected the model list request.', status);
    const listing = listingFromPayload(payload, 'mistral');
    return { ...listing, imageModels: [], answered: true };
  }

  const headers: Record<string, string> = target.apiKey
    ? { Authorization: `Bearer ${target.apiKey}` }
    : {};

  const main = await fetchJson(`${base}/models`, headers);
  if (!main.ok) throw new ProbeError('The provider rejected the model list request.', main.status);

  let listing = listingFromPayload(main.payload, detectFamily(main.payload));

  // llama.cpp publishes its served window once, server-wide, at /props.
  if (listing.family === 'llamacpp') {
    const props = await fetchJson(`${base}/props`, headers);
    if (props.ok && props.payload) {
      listing = applyServerWideHint(listing, readLlamaCppProps(props.payload));
    }
  }

  // Ollama's /api/tags carries no context window, and /api/show requires the
  // model name in a POST body — so the list alone is what we get here. The
  // names it publishes still resolve through Layer 3 as hints.

  const imageModels = await probeImageModels(base, headers);
  return { ...listing, imageModels, answered: true };
}

/**
 * Decides which extractor fits a `/v1/models` payload by inspecting the FIRST
 * entry. Shape sniffing beats a vendor table: a gateway we have never seen gets
 * its context length picked up if it publishes one in a known field name.
 */
export function detectFamily(payload: unknown): NonNullable<ProviderModelHint['from']> {
  const root = asObject(payload);
  const rows = asArray(root?.data ?? root?.models ?? root?.results ?? payload);
  const first = asObject(rows[0]);
  if (!first) return 'opaque';

  if (isMistralModelObject(first)) return 'mistral';

  if ('max_context_length' in first || 'trained_for_tool_use' in first || 'loaded_context_length' in first) {
    return 'lmstudio';
  }
  if ('max_model_len' in first) return 'vllm';
  // llama.cpp older builds answer /props with `default_generation_settings`.
  if ('default_generation_settings' in first) return 'llamacpp';
  if ('supported_parameters' in first || 'architecture' in first) return 'openrouter';
  if ('details' in first && 'digest' in first) return 'ollama';
  return 'opaque';
}

/** Image-only model ids some gateways expose on a sibling route. */
async function probeImageModels(
  base: string,
  headers: Record<string, string>,
): Promise<string[]> {
  try {
    const { ok, payload } = await fetchJson(`${base}/image-models`, headers);
    if (!ok) return [];
    const root = asObject(payload);
    return asArray(root?.data ?? payload)
      .map((row) => asString(asObject(row)?.id))
      .filter((id): id is string => !!id);
  } catch {
    return [];
  }
}
