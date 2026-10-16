/**
 * IMAGE RUNTIME — the shared engine behind every image generation in Moriko.
 *
 * One module, two consumers:
 *  - the HTTP routes (POST /api/images/generations, GET /api/images/tasks/:id)
 *  - the agent tool `agent__image` (LLM-driven generation, PLAN-AGENT-DRIVEN-
 *    IMAGE-GENERATION.md)
 *
 * Everything that used to live inline in server/index.ts moved here so both
 * paths share ONE implementation: task bookkeeping (persist + restore across
 * restarts), the submit validation ladder, poll-with-local-save, the failure
 * journal, the Gallery collection, and the provider capability listing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../atomicWrite.js';
import { HttpError } from '../http.js';
import { resolveImageAdapter, type ImageProviderSelection } from '../adapters/images/registry.js';
import { classifyImageModels, type ImageModelCaps } from '../adapters/images/modelCaps.js';
import {
  ImageAdapterError,
  isTerminalImageStatus,
  type ImagePollResult,
  type ImageTaskRecord,
  type NormalizedImage,
} from '../adapters/images/types.js';
import { BUILT_IN_PROVIDERS, findBuiltIn } from '../providers.js';
import { providerStore } from '../store.js';
import { resolveCredentials } from '../credentials.js';
import { galleryFile, imagesDir, imageTaskJournalFile, imageTaskStateFile } from '../paths.js';
import { publishBusEvent } from '../addons/bus.js';
import { getUiState } from '../uiState.js';
import type { ProviderPublic } from '../contracts.js';


const imageTasks = new Map<string, ImageTaskRecord>();

/** A pending task older than this expires as FAILED instead of polling forever. */
export const IMAGE_TASK_TTL_MS = 15 * 60 * 1000;

function persistImageTasks(): void {
  try {
    atomicWriteJson(imageTaskStateFile, [...imageTasks.entries()]);
  } catch (error) {
    console.error('[images] failed to persist task state:', error);
  }
}

export function loadImageTasksFromDisk(): void {
  try {
    if (!fs.existsSync(imageTaskStateFile)) return;
    const parsed = JSON.parse(fs.readFileSync(imageTaskStateFile, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[1]) continue;
      const record = entry[1] as ImageTaskRecord;
      if (typeof record.adapterId !== 'string' || !record.credentials) continue;
      imageTasks.set(entry[0], record);
    }
    if (imageTasks.size > 0) {
      console.log(`[images] restored ${imageTasks.size} in-flight task(s) from disk`);
    }
  } catch (error) {
    console.error('[images] failed to restore task state:', error);
  }
}

function rememberTask(taskId: string, record: ImageTaskRecord): void {
  if (imageTasks.size > 200) {
    const oldest = imageTasks.keys().next().value;
    if (oldest) imageTasks.delete(oldest);
  }
  imageTasks.set(taskId, record);
  persistImageTasks();
}


export type ImageTaskEvent =
  | {
      kind: 'submit';
      taskId: string;
      adapter: string;
      provider: string;
      model: string;
      prompt: string;
      aspectRatio: string | null;
      size: string | null;
    }
  | {
      kind: 'terminal';
      taskId: string;
      adapter: string;
      status: string;
      providerStatus?: string;
      imageCount: number;
      failure?: string;
      raw?: unknown;
    }
  | { kind: 'unknown-task'; taskId: string }
  | {
      kind: 'submit-rejected';
      adapter: string;
      provider: string;
      model: string;
      upstreamStatus: number | string;
      raw: string;
    }
  | { kind: 'sweep'; removed: number; retentionDays: number }
  | { kind: 'cleanup'; removed: number; skipped: number }
  | { kind: 'session-created'; sessionId: string; label: string }
  | { kind: 'session-deleted'; sessionId: string; label: string; removedFiles: number };

export function logImageTask(event: ImageTaskEvent): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  try {
    fs.appendFileSync(imageTaskJournalFile, `${line}\n`);
  } catch {
  }
  console.log(`[images] ${event.kind}: ${line.slice(0, 400)}`);
}


/**
 * Resolves the image target for a request: credentials (server key first,
 * browser-supplied second) plus the adapter that speaks this provider's API.
 * Custom providers may pin an adapter via `imageAdapter`/`imageConfig`;
 * everything else is inferred from the base URL.
 */
export async function resolveImageTarget(providerId: string, browserKey?: string) {
  const credentials = await resolveCredentials(providerStore, providerId, browserKey);
  let selection: ImageProviderSelection | undefined;
  const custom = await providerStore.get(providerId);
  const builtIn = findBuiltIn(providerId);
  if (custom) {
    selection = {
      imageAdapter: custom.imageAdapter ?? builtIn?.imageAdapter,
      imageConfig: custom.imageConfig,
    };
  } else if (builtIn?.imageAdapter) {
    selection = { imageAdapter: builtIn.imageAdapter };
  }
  const adapter = resolveImageAdapter(selection, credentials.baseUrl);
  return { credentials, adapter, providerId };
}

/**
 * Re-resolves the adapter for an in-flight task at poll time. Registry
 * adapters resolve from their id; factory-based adapters (declarative) are
 * rebuilt from the provider's stored `imageConfig` on demand.
 */
async function resolveAdapterForTask(task: ImageTaskRecord) {
  const custom = task.providerId ? await providerStore.get(task.providerId) : undefined;
  const selection = custom
    ? { imageAdapter: custom.imageAdapter ?? task.adapterId, imageConfig: custom.imageConfig }
    : { imageAdapter: task.adapterId };
  return resolveImageAdapter(selection, task.credentials.baseUrl);
}


/** Transport bound for reference images — shape/capacity are checked here. */
const MAX_REFERENCE_IMAGES = 8;

export interface ImageSubmitInput {
  providerId: string;
  model: string;
  prompt: string;
  apiKey?: string;
  width?: unknown;
  height?: unknown;
  aspectRatio?: unknown;
  images?: unknown;
}

/**
 * Submits a generation task and returns its id — the exact validation ladder
 * the HTTP route enforced, now shared with the agent tool. Throws HttpError
 * (400) for user errors and ImageAdapterError when the provider refuses.
 */
export async function submitImageTask(input: ImageSubmitInput): Promise<{ taskId: string }> {
  const providerId = input.providerId?.trim();
  const model = input.model?.trim();
  if (!providerId) throw new HttpError(400, 'Pick a provider in Run settings first.');
  if (!model) throw new HttpError(400, 'Pick a model in Run settings first.');
  if (!input.prompt?.trim()) throw new HttpError(400, 'A prompt is required.');

  const { credentials, adapter } = await resolveImageTarget(providerId, input.apiKey?.trim() || undefined);
  const apiKey = credentials.apiKey || process.env.MODELSCOPE_API_KEY || '';
  if (!apiKey && adapter.id !== 'comfyui-local') {
    throw new HttpError(
      400,
      `No API key for ${credentials.label}. Add one in Provider settings, or set MODELSCOPE_API_KEY in .env.`,
    );
  }

  const width = Number(input.width);
  const height = Number(input.height);
  const requested =
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= 64 &&
    height >= 64 &&
    width <= 4096 &&
    height <= 4096
      ? { width: Math.round(width), height: Math.round(height) }
      : null;

  const aspectRatio =
    typeof input.aspectRatio === 'string' ? input.aspectRatio.trim() || undefined : undefined;

  const images = (Array.isArray(input.images) ? input.images : [])
    .filter((entry): entry is string => typeof entry === 'string')
    .filter((entry) => /^(data:image\/|https?:\/\/)/.test(entry));
  if (images.length > MAX_REFERENCE_IMAGES) {
    throw new HttpError(400, `At most ${MAX_REFERENCE_IMAGES} reference images per request.`);
  }
  const referenceCapacity = adapter.capabilities.maxReferences;
  if (images.length > referenceCapacity) {
    throw new HttpError(
      400,
      referenceCapacity === 0
        ? `The ${adapter.id} adapter for ${credentials.label} cannot forward reference images — remove them, or pick a provider that supports image references.`
        : `${credentials.label} accepts at most ${referenceCapacity} reference image(s) per request — you sent ${images.length}. Remove some in Image Studio.`,
    );
  }

  let taskId: string;
  try {
    ({ taskId } = await adapter.submit(
      {
        model,
        prompt: input.prompt.trim(),
        aspectRatio,
        width: requested?.width,
        height: requested?.height,
        ...(images.length > 0 ? { images } : {}),
      },
      { credentials: { ...credentials, apiKey } },
    ));
  } catch (error) {
    if (error instanceof ImageAdapterError) {
      logImageTask({
        kind: 'submit-rejected',
        adapter: adapter.id,
        provider: credentials.label,
        model,
        upstreamStatus: error.status,
        raw: (error.upstreamBody ?? error.message).slice(0, 600),
      });
      throw error;
    }
    throw error;
  }

  rememberTask(taskId, {
    adapterId: adapter.id,
    providerId,
    credentials: { label: credentials.label, baseUrl: credentials.baseUrl, apiKey },
    model,
    prompt: input.prompt.trim(),
    requested,
    aspectRatio: aspectRatio ?? null,
    submittedAt: new Date().toISOString(),
  });
  logImageTask({
    kind: 'submit',
    taskId,
    adapter: adapter.id,
    provider: credentials.label,
    model,
    prompt: input.prompt.trim(),
    aspectRatio: aspectRatio ?? null,
    size: requested ? `${requested.width}x${requested.height}` : null,
  });
  return { taskId };
}


const IMAGES_DIR = imagesDir;
fs.mkdirSync(IMAGES_DIR, { recursive: true });

export const LOCAL_IMAGE_PREFIX = '/api/images/local/';

/** Extracts a safe filename from a local image URL, or null for foreign URLs. */
export function localImageName(url: string): string | null {
  if (!url.startsWith(LOCAL_IMAGE_PREFIX)) return null;
  const name = path.basename(url.slice(LOCAL_IMAGE_PREFIX.length));
  return /^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(name) ? name : null;
}

export function localImageExists(name: string): boolean {
  return fs.existsSync(path.join(IMAGES_DIR, name));
}

/** Reads a locally-saved generated image back as bytes (agent iteration path). */
export function localImageByUrl(url: string): { buffer: Buffer; mime: string } | null {
  const name = localImageName(url);
  if (!name || !localImageExists(name)) return null;
  const buffer = fs.readFileSync(path.join(IMAGES_DIR, name));
  const ext = path.extname(name).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { buffer, mime };
}

interface ImageMeta {
  prompt: string;
  model: string;
  provider: string;
  createdAt: string;
  file: string;
  requested: { width: number; height: number } | null;
  output: { width: number; height: number } | null;
  aspectRatio: string | null;
}

/** Reads the real pixel dimensions from a PNG/JPEG/WebP buffer. */
function readImageSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  if (
    buffer.length > 30 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP' &&
    buffer.toString('ascii', 12, 16) === 'VP8X'
  ) {
    return {
      width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
      height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
    };
  }
  return null;
}

/** Picks a file extension from raw image bytes (PNG/JPEG/WebP magic). */
function sniffImageExt(buffer: Buffer): 'png' | 'jpg' | 'webp' {
  if (buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
  if (
    buffer.length > 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return 'jpg';
}

/**
 * Persists one generated image — a provider CDN URL or inline base64 — into
 * IMAGES_DIR, so the client only ever sees same-origin local links. When the
 * creation context is known, a sidecar JSON ("<file>.json") keeps the prompt
 * that produced the image beside the file itself.
 */
async function saveImageLocally(
  taskId: string,
  index: number,
  image: NormalizedImage,
  meta?: {
    prompt: string;
    model: string;
    provider: string;
    requested?: { width: number; height: number } | null;
    aspectRatio?: string | null;
  },
): Promise<string> {
  try {
    let buffer: Buffer;
    let ext: 'png' | 'jpg' | 'webp';
    if (image.kind === 'b64') {
      const raw = image.data.includes(',') ? (image.data.split(',')[1] ?? '') : image.data;
      buffer = Buffer.from(raw, 'base64');
      ext = sniffImageExt(buffer);
    } else {
      const upstream = await fetch(image.url);
      if (!upstream.ok) return image.url;
      const type = upstream.headers.get('content-type') ?? 'image/jpeg';
      ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
      buffer = Buffer.from(await upstream.arrayBuffer());
    }
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'task';
    const name = `${safeId}-${index}.${ext}`;
    fs.writeFileSync(path.join(IMAGES_DIR, name), buffer);

    if (meta) {
      const payload: ImageMeta = {
        ...meta,
        createdAt: new Date().toISOString(),
        file: `/api/images/local/${name}`,
        requested: meta.requested ?? null,
        output: readImageSize(buffer),
        aspectRatio: meta.aspectRatio ?? null,
      };
      fs.writeFileSync(
        path.join(IMAGES_DIR, name.replace(/\.[^.]+$/, '.json')),
        JSON.stringify(payload, null, 2),
      );
    }

    return `/api/images/local/${name}`;
  } catch {
    return image.kind === 'url' ? image.url : image.data;
  }
}

export interface ImagePollOutcome {
  status: string;
  images: string[];
  note?: string;
  error?: string;
}

/**
 * Polls one task. Results are saved locally; the task is then forgotten.
 * Returns null when the task id is unknown (finished, expired, restarted).
 * Throws ImageAdapterError when the provider poll fails.
 */
export async function pollImageTaskOnce(taskId: string): Promise<ImagePollOutcome | null> {
  const task = imageTasks.get(taskId);
  if (!task) {
    logImageTask({ kind: 'unknown-task', taskId });
    return null;
  }

  const submittedMs = Date.parse(task.submittedAt);
  if (Number.isFinite(submittedMs) && Date.now() - submittedMs > IMAGE_TASK_TTL_MS) {
    logImageTask({
      kind: 'terminal',
      taskId,
      adapter: task.adapterId,
      status: 'FAILED',
      imageCount: 0,
      failure: 'Task expired after 15 minutes without reaching a terminal status.',
    });
    imageTasks.delete(taskId);
    persistImageTasks();
    return {
      status: 'FAILED',
      images: [],
      error: 'This image task expired after 15 minutes without finishing. Submit again.',
    };
  }

  const adapter = await resolveAdapterForTask(task);

  let result: ImagePollResult;
  try {
    result = await adapter.poll(taskId, { credentials: task.credentials, record: task });
  } catch (error) {
    if (error instanceof ImageAdapterError) throw error;
    throw error;
  }

  const { status } = result;
  const failure = result.error;
  const meta = task.prompt
    ? {
        prompt: task.prompt,
        model: task.model,
        provider: task.credentials.label,
        requested: task.requested,
        aspectRatio: task.aspectRatio,
      }
    : undefined;
  const images =
    result.images.length > 0
      ? await Promise.all(result.images.map((image, index) => saveImageLocally(taskId, index, image, meta)))
      : [];
  if (isTerminalImageStatus(status)) {
    logImageTask({
      kind: 'terminal',
      taskId,
      adapter: adapter.id,
      status,
      ...(result.providerStatus && result.providerStatus !== status ? { providerStatus: result.providerStatus } : {}),
      imageCount: images.length,
      ...(status === 'FAILED' ? { failure, raw: result.raw } : {}),
    });
    imageTasks.delete(taskId);
    persistImageTasks();
  }
  return {
    status,
    images,
    ...(result.note ? { note: result.note } : {}),
    ...(failure ? { error: String(failure).slice(0, 1200) } : {}),
  };
}

/**
 * Submit + poll to completion inside one call — the agent tool's loop. The
 * model receives the finished result in a single tool call instead of having
 * to re-invoke a poller. Bounded by IMAGE_TASK_TTL_MS; honors ctx.signal.
 */
export async function runImageTask(
  input: ImageSubmitInput,
  opts: { signal?: AbortSignal; onProgress?: (message: string) => void; pollIntervalMs?: number } = {},
): Promise<ImagePollOutcome> {
  const { taskId } = await submitImageTask(input);
  const interval = opts.pollIntervalMs ?? 2000;
  const startedAt = Date.now();
  let lastTick = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    if (opts.signal?.aborted) {
      return { status: 'FAILED', images: [], error: 'Aborted — the generation was stopped by the user.' };
    }
    const outcome = await pollImageTaskOnce(taskId);
    if (!outcome) {
      return { status: 'FAILED', images: [], error: 'The task record vanished mid-poll — submit again.' };
    }
    if (isTerminalImageStatus(outcome.status)) return outcome;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (elapsed - lastTick >= 10) {
      lastTick = elapsed;
      opts.onProgress?.(`Waiting for the provider… ${elapsed}s (${outcome.status})`);
    }
    if (Date.now() - startedAt > IMAGE_TASK_TTL_MS) {
      return { status: 'FAILED', images: [], error: 'Timed out after 15 minutes without a terminal status.' };
    }
  }
}


/**
 * The Gallery is a persisted, ordered list of image URLs — usually local ones
 * under `/api/images/local/...`, occasionally a provider CDN link. The client
 * owns the ordering and sends the whole collection on every change.
 */
const GALLERY_FILE = galleryFile;

export function readGallery(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(GALLERY_FILE, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function writeGallery(images: string[]): void {
  fs.mkdirSync(path.dirname(GALLERY_FILE), { recursive: true });
  fs.writeFileSync(GALLERY_FILE, JSON.stringify(images, null, 2));
}

/** Appends agent-generated results and broadcasts the change to every client. */
export function appendToGallery(urls: string[]): string[] {
  const current = readGallery();
  const next = [...current, ...urls.filter((url) => !current.includes(url))].slice(0, 500);
  writeGallery(next);
  void publishBusEvent('moriko:gallery-added', { urls }, '__harness__');
  return next;
}


/**
 * Adapter capabilities for one provider, or undefined when the provider has
 * no resolvable image adapter (chat-only providers stay without the field).
 */
export function imageCapabilitiesOrNull(
  selection: ImageProviderSelection | undefined,
  baseUrl: string,
  models?: string[],
): ProviderPublic['imageCapabilities'] {
  try {
    const adapter = resolveImageAdapter(selection, baseUrl);
    const capabilities = { ...adapter.capabilities };
    if (models) {
      const classified = classifyImageModels(models);
      capabilities.models = classified;
    }
    return capabilities;
  } catch {
    return undefined;
  }
}

export interface ImageProviderEntry {
  providerId: string;
  label: string;
  hasServerKey: boolean;
  maxReferences: number;
  models: Array<{
    id: string;
    modes: Array<'text-to-image' | 'edit'>;
    maxReferences: number;
    label?: string;
  }>;
}

/**
 * Every provider that can actually generate images right now: a resolvable
 * image adapter AND at least one classified image model. Shared by the
 * agent tool listing and the system-prompt injection gate.
 */
export async function listImageCapableProviders(): Promise<ImageProviderEntry[]> {
  const entries: ImageProviderEntry[] = [];

  for (const definition of BUILT_IN_PROVIDERS) {
    const envKey = definition.envKey ? process.env[definition.envKey] : undefined;
    const storedKey = await providerStore.getBuiltInKey(definition.id);
    const userModels = await providerStore.getBuiltInModels(definition.id);
    const liveModels = await providerStore.getBuiltInLiveModels(definition.id);
    const catalogue = liveModels.length > 0 ? [...liveModels, ...userModels] : [...definition.models, ...userModels];
    const baseUrl = (definition.envBaseUrl && process.env[definition.envBaseUrl]) || definition.baseUrl;
    const capabilities = imageCapabilitiesOrNull(
      definition.imageAdapter ? { imageAdapter: definition.imageAdapter } : undefined,
      baseUrl,
      catalogue,
    );
    const models = Object.entries(capabilities?.models ?? {}) as Array<[string, ImageModelCaps]>;
    if (!capabilities || models.length === 0) continue;
    entries.push({
      providerId: definition.id,
      label: definition.label,
      hasServerKey: Boolean(envKey) || Boolean(storedKey) || Boolean(definition.keyOptional),
      maxReferences: capabilities.maxReferences,
      models: models.map(([id, caps]) => ({
        id,
        modes: [...caps.modes],
        maxReferences: caps.maxReferences,
        ...(caps.label ? { label: caps.label } : {}),
      })),
    });
  }

  const custom = await providerStore.list();
  for (const provider of custom) {
    const capabilities = imageCapabilitiesOrNull(
      { imageAdapter: provider.imageAdapter, imageConfig: provider.imageConfig },
      provider.baseUrl,
      provider.models,
    );
    const models = Object.entries(capabilities?.models ?? {}) as Array<[string, ImageModelCaps]>;
    if (!capabilities || models.length === 0) continue;
    entries.push({
      providerId: provider.id,
      label: provider.label,
      hasServerKey: Boolean(await providerStore.getKey(provider.id)),
      maxReferences: capabilities.maxReferences,
      models: models.map(([id, caps]) => ({
        id,
        modes: [...caps.modes],
        maxReferences: caps.maxReferences,
        ...(caps.label ? { label: caps.label } : {}),
      })),
    });
  }

  return entries;
}

export interface AgentImageTarget {
  providerId: string;
  providerLabel: string;
  model: string;
  maxReferences: number;
}

/**
 * The agent's default generator: the user's SAVED Image Studio choice when it
 * is still valid, else the first image-capable provider with a key and a
 * text-to-image model. Explicit args (providerId/model) always win.
 */
export async function resolveAgentImageTarget(
  preferred?: { providerId?: string; model?: string },
): Promise<AgentImageTarget | null> {
  const providers = await listImageCapableProviders();
  if (providers.length === 0) return null;
  const usable = providers.filter((entry) => entry.hasServerKey);
  if (usable.length === 0) return null;

  const pick = (entry: ImageProviderEntry, modelId?: string): AgentImageTarget | null => {
    const model =
      (modelId && entry.models.find((m) => m.id === modelId)) ||
      entry.models.find((m) => m.modes.includes('text-to-image'));
    if (!model) return null;
    return {
      providerId: entry.providerId,
      providerLabel: entry.label,
      model: model.id,
      maxReferences: entry.maxReferences,
    };
  };

  if (preferred?.providerId) {
    const entry = usable.find((p) => p.providerId === preferred.providerId);
    if (!entry) return null;
    return pick(entry, preferred.model);
  }
  if (preferred?.model) {
    const entry = usable.find((p) => p.models.some((m) => m.id === preferred.model));
    if (entry) return pick(entry, preferred.model);
  }

  try {
    const saved = getUiState()['imageStudio'] as { providerId?: unknown; model?: unknown } | undefined;
    if (saved && typeof saved === 'object') {
      const providerId = typeof saved.providerId === 'string' ? saved.providerId : '';
      const model = typeof saved.model === 'string' ? saved.model : '';
      if (providerId && model) {
        const entry = usable.find((p) => p.providerId === providerId);
        const target = entry ? pick(entry, model) : null;
        if (target) return target;
      }
    }
  } catch {
  }

  for (const entry of usable) {
    const target = pick(entry);
    if (target) return target;
  }
  return null;
}
