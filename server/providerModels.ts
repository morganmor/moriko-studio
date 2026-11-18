

import type { ProviderModelEntry, ProviderModelHint } from './contracts.js';

const TIMEOUT_MS = 12_000;


export interface ProviderModelListing {
  entries: ProviderModelEntry[];
  
  family: NonNullable<ProviderModelHint['from']>;
}


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


function asCount(value: unknown): number | null {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}


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


function fromModalities(values: readonly string[]): ProviderModelHint {
  const set = new Set(values.map((value) => value.trim().toLowerCase()));
  const hint: ProviderModelHint = {};
  if (set.size === 0) return hint;
  hint.imageIn = set.has('image');
  hint.audioIn = set.has('audio');
  hint.videoIn = set.has('video');
  hint.pdfIn = set.has('file') || set.has('pdf');
  return hint;
}


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


export function readLmStudioEntry(raw: unknown): ProviderModelEntry | null {
  const entry = asObject(raw);
  const id = asString(entry?.id) ?? asString(entry?.model_key);
  if (!entry || !id) return null;

  const hint: ProviderModelHint = { from: 'lmstudio' };
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

  if (asArray(entry.outputModalities).length > 0) {
    const output = asArray(entry.outputModalities)
      .map((value) => asString(value))
      .filter((v): v is string => !!v)
      .map((value) => value.toLowerCase());
    hint.imageOut = output.includes('image');
  }

  return { id, hint: prune(hint) };
}


export function readAnthropicEntry(raw: unknown): ProviderModelEntry | null {
  const entry = asObject(raw);
  const id = asString(entry?.id);
  if (!entry || !id) return null;
  const hint: ProviderModelHint = { from: 'anthropic' };
  const label = asString(entry.display_name);
  if (label) hint.label = label;
  return { id, hint };
}


function isMistralModelObject(entry: Json): boolean {
  const caps = asObject(entry.capabilities);
  return caps !== null && ('completion_chat' in caps || 'function_calling' in caps);
}


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


function prune(hint: ProviderModelHint): ProviderModelHint {
  const out: ProviderModelHint = {};
  for (const [key, value] of Object.entries(hint)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}


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


export function hintsFromListing(
  listing: ProviderModelListing,
): Record<string, ProviderModelHint> {
  const out: Record<string, ProviderModelHint> = {};
  for (const entry of listing.entries) {
    if (Object.keys(entry.hint).every((key) => key === 'from')) continue;
    out[entry.id] = entry.hint;
  }
  return out;
}


export type ProbeKind = 'openai' | 'gemini' | 'anthropic' | 'mistral';

export interface ProbeTarget {
  baseUrl: string;
  apiKey?: string;
  kind: ProbeKind;
}

export interface ProbeResult extends ProviderModelListing {
  
  imageModels: string[];
  
  answered: boolean;
}


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

  if (listing.family === 'llamacpp') {
    const props = await fetchJson(`${base}/props`, headers);
    if (props.ok && props.payload) {
      listing = applyServerWideHint(listing, readLlamaCppProps(props.payload));
    }
  }


  const imageModels = await probeImageModels(base, headers);
  return { ...listing, imageModels, answered: true };
}


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
  if ('default_generation_settings' in first) return 'llamacpp';
  if ('supported_parameters' in first || 'architecture' in first) return 'openrouter';
  if ('details' in first && 'digest' in first) return 'ollama';
  return 'opaque';
}


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
