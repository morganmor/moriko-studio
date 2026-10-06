/**
 * Contracts for pluggable image-generation providers.
 *
 * The Image Studio client speaks ONE frozen async contract:
 *   POST /api/images/generations → { taskId }
 *   GET  /api/images/tasks/:id   → { status, images, error? }
 *
 * Everything that differs between providers (sync vs async execution, param
 * names, response shapes, URL vs base64 results) is absorbed here, in
 * adapters. Adding a provider means adding an adapter (or a declarative
 * config) — never touching the routes or the UI.
 */

import type { ImageModelCaps } from './modelCaps.js';
export type { ImageModelCaps, ImageModelMode } from './modelCaps.js';

/** Normalized, terminal-aware task status. Unknown passthroughs stay strings. */
export type ImageTaskStatus = 'PENDING' | 'RUNNING' | 'SUCCEED' | 'FAILED' | (string & {});

/** A generated image in whichever shape the provider returned it. */
export type NormalizedImage =
  | { kind: 'url'; url: string }
  | { kind: 'b64'; /** Raw base64, or a `data:` URL; the server unwraps both. */ data: string };

export interface ImageSubmitRequest {
  model: string;
  prompt: string;
  /** Preset like "16:9" — sent only when the adapter's capability says so. */
  aspectRatio?: string;
  /** Validated pixel size (64–4096), when the user chose pixel mode. */
  width?: number;
  height?: number;
  /**
   * Reference images — data URLs (or http URLs). Adapters map them onto
   * their provider's field (ModelScope `image_url`, BFL `input_image…`).
   * Forwarded as-is: the route validates shape plus the ADAPTER's declared
   * capacity — never the HF classifier, which is a UI hint only.
   */
  images?: string[];
}

/** Provider-facing credentials, already resolved (server key first). */
export interface ImageCredentials {
  label: string;
  baseUrl: string;
  apiKey?: string;
}

/** Everything an adapter may need at call time. */
export interface AdapterContext {
  credentials: ImageCredentials;
  /** The stored task record — available on `poll` only. */
  record?: ImageTaskRecord;
}

/**
 * What the server persists per in-flight task so any adapter can poll later
 * without re-deriving provider configuration.
 */
export interface ImageTaskRecord {
  adapterId: string;
  providerId: string;
  credentials: ImageCredentials;
  model: string;
  prompt: string;
  requested: { width: number; height: number } | null;
  aspectRatio: string | null;
  submittedAt: string;
}

export interface ImagePollResult {
  /**
   * NORMALIZED status — always one of the internal values, never the
   * provider's own vocabulary. Adapters map their provider's strings onto
   * SUCCEED/FAILED/RUNNING so the route and the frozen client contract stay
   * adapter-agnostic.
   */
  status: ImageTaskStatus;
  /** The provider's original status string, for journals and debugging. */
  providerStatus?: string;
  images: NormalizedImage[];
  /** Human-readable failure reason, already extracted from the provider. */
  error?: string;
  /** Non-fatal caveat for a SUCCESSFUL generation (e.g. a size request the
   * provider rejected was dropped in a retry). Shown to the user as a note. */
  note?: string;
  /** Raw provider payload — kept for the failure journal. */
  raw?: unknown;
}

/** Declared provider traits — surfaced to the UI so it never sends nonsense. */
export interface ImageCapabilities {
  /** `sync` providers are wrapped in a server-side local job. */
  execution: 'async' | 'sync';
  /** Which size parameter this provider actually understands. */
  sizeParam: 'aspect_ratio' | 'size' | 'width_height' | 'none';
  /** What the provider returns for a finished image. */
  resultFormat: 'url' | 'b64' | 'both';
  /** How many images one request may ask for (`n`). 1 = not supported. */
  maxImages: number;
  supportsNegativePrompt: boolean;
  /**
   * ENDPOINT truth — how many reference images this adapter's wire format can
   * carry (0 = the endpoint cannot carry any). Provider/endpoint authority,
   * never an HF `pipeline_tag` guess: the route refuses over-cap requests
   * with an explicit error instead of silently dropping images, and `0` turns
   * into a visible UI warning.
   */
  maxReferences: number;
  /**
   * Per-model image classification (see modelCaps.ts): which of the
   * provider's models actually generate images, and which of those accept
   * reference images. Models absent from the map are not image models.
   */
  models?: Record<string, ImageModelCaps>;
}

/**
 * The one interface every provider protocol implements. `submit` starts a
 * task (for `sync` providers, a server-side local job) and returns its id;
 * `poll` reports the task's current state in normalized form.
 */
export interface ImageAdapter {
  readonly id: string;
  readonly capabilities: ImageCapabilities;
  submit(req: ImageSubmitRequest, ctx: AdapterContext): Promise<{ taskId: string }>;
  poll(taskId: string, ctx: AdapterContext): Promise<ImagePollResult>;
}

/** Raised by adapters for any upstream rejection; the route maps it to HTTP. */
export class ImageAdapterError extends Error {
  readonly status: number;
  /** Raw upstream body — persisted to the failure journal by the route. */
  readonly upstreamBody?: string;

  constructor(status: number, message: string, upstreamBody?: string) {
    super(message);
    this.name = 'ImageAdapterError';
    this.status = status;
    this.upstreamBody = upstreamBody;
  }
}

export const isTerminalImageStatus = (status: string): boolean =>
  status === 'SUCCEED' || status === 'FAILED';

/** Ensures the base URL carries the `/v1` suffix many OpenAI-shaped APIs need. */
export function ensureV1(baseUrl: string): string {
  const raw = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(raw) ? raw : `${raw}/v1`;
}
