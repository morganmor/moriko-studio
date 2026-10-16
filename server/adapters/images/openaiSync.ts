/**
 * OpenAI-compatible synchronous image adapter.
 *
 * Many gateways answer `POST /v1/images/generations` with the finished image
 * in the same response (`data[].url` or `data[].b64_json`) — no task to poll.
 * The client contract stays async, so this adapter wraps the synchronous call
 * in a server-side local job: `submit` returns a generated id immediately and
 * runs the upstream call in the background; `poll` reads the job's state.
 */

import { randomUUID } from 'node:crypto';

import {
  ensureV1,
  ImageAdapterError,
  type AdapterContext,
  type ImageAdapter,
  type ImagePollResult,
  type ImageSubmitRequest,
  type ImageCredentials,
  type NormalizedImage,
} from './types.js';
import { ratioToSize } from './ratio.js';
import { formatRejection } from './errorReport.js';

interface LocalJob {
  status: 'RUNNING' | 'SUCCEED' | 'FAILED';
  images: NormalizedImage[];
  error?: string;
  /** Non-fatal caveat for a successful generation (e.g. size was dropped). */
  note?: string;
  raw?: unknown;
}

/** Local job states live here (not in `imageTasks`) so sync execution owns them. */
const localJobs = new Map<string, LocalJob>();

function rememberJob(id: string, job: LocalJob): void {
  if (localJobs.size > 200) {
    const oldest = localJobs.keys().next().value;
    if (oldest) localJobs.delete(oldest);
  }
  localJobs.set(id, job);
}

/**
 * Known OpenAI image sizes mapped from our aspect-ratio presets. Ratios with
 * no safe mapping are omitted rather than guessed — the provider default
 * applies.
 */
const RATIO_TO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1792x1024',
  '9:16': '1024x1792',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
};

/**
 * Maps custom pixel dimensions to the closest standard OpenAI size by
 * computing the aspect ratio and snapping to the nearest known pair.
 * Returns null when no standard size is close enough (e.g. 1:1 stays 1024x1024).
 */
function closestStandardSize(width: number, height: number): string | null {
  const ratio = width / height;
  const standards: Array<{ size: string; r: number }> = [
    { size: '1024x1024', r: 1 },
    { size: '1792x1024', r: 16 / 9 },
    { size: '1024x1792', r: 9 / 16 },
    { size: '1536x1024', r: 3 / 2 },
    { size: '1024x1536', r: 2 / 3 },
  ];
  let best: { size: string; diff: number } | null = null;
  for (const s of standards) {
    const diff = Math.abs(s.r - ratio);
    if (!best || diff < best.diff) best = { size: s.size, diff };
  }
  return best ? best.size : null;
}

interface OpenAiImagesResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
}


interface DetailedImageModel {
  id?: string;
  model?: string;
  supported_parameters?: { resolutions?: string[] } | null;
}

const catalogCache = new Map<string, { at: number; models: Map<string, string[]> }>();
const CATALOG_TTL = 10 * 60 * 1000;

/**
 * Fetches the provider's image-model catalog (NanoGPT
 * `GET /image-models?detailed=true`) and indexes each model's
 * `supported_parameters.resolutions`. Cached 10 min per base URL. An empty
 * map means the catalog is unavailable — size snapping is skipped.
 */
async function fetchResolutionCatalog(base: string, apiKey: string | undefined): Promise<Map<string, string[]>> {
  const cached = catalogCache.get(base);
  if (cached && Date.now() - cached.at < CATALOG_TTL) return cached.models;

  const models = new Map<string, string[]>();
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  try {
    const res = await fetch(`${base}/image-models?detailed=true`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const payload = (await res.json()) as { data?: DetailedImageModel[] } | DetailedImageModel[];
      const list = Array.isArray(payload) ? payload : (payload.data ?? []);
      for (const m of list) {
        const id = m.id ?? m.model;
        const resolutions = m.supported_parameters?.resolutions;
        if (id && Array.isArray(resolutions)) {
          const clean = resolutions.filter((r): r is string => typeof r === 'string' && /^\d+x\d+$/.test(r.trim()));
          if (clean.length > 0) models.set(id, clean);
        }
      }
    }
  } catch {  }
  catalogCache.set(base, { at: Date.now(), models });
  return models;
}

/**
 * Picks the supported resolution with the closest aspect ratio (ties broken
 * by total pixel count). Only pixel-dimension entries ("WxH") are considered;
 * symbolic values like "auto" are skipped.
 */
function snapToSupported(width: number, height: number, resolutions: string[]): string | null {
  const ratio = width / height;
  let best: { size: string; diff: number; areaDiff: number } | null = null;
  for (const r of resolutions) {
    const m = /^(\d+)x(\d+)$/.exec(r.trim());
    if (!m) continue;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!w || !h) continue;
    const diff = Math.abs(w / h - ratio);
    const areaDiff = Math.abs(w * h - width * height);
    if (!best || diff < best.diff - 1e-9 || (Math.abs(diff - best.diff) < 1e-9 && areaDiff < best.areaDiff)) {
      best = { size: `${w}x${h}`, diff, areaDiff };
    }
  }
  return best ? best.size : null;
}

/** What this adapter's contract says the endpoint accepts — quoted verbatim
 * in rejection reports so the user sees the expected configuration. */
const ACCEPTED_CONTRACT =
  'model, prompt, n (image count), size "WxH" (optional — some OpenAI-compatible ' +
  'gateways, e.g. BitDeer, reject size with HTTP 400 invalid request, in which case ' +
  'Moriko retries with the minimal body and the provider default applies) — response ' +
  'returns data[].url or data[].b64_json';

/** The request shapes the adapter tries, in order. Gateways vary in how
 * strictly they validate optional parameters (BitDeer rejects `size` with
 * 400), so a 400 falls back to the next simpler body instead of failing
 * the generation outright.
 *
 * When the user enters custom pixels (e.g. 1080x1920) and the provider
 * rejects that size, the adapter tries the closest standard OpenAI size
 * (e.g. 1024x1792 for 9:16) before falling back to no size at all. */
function attemptBodies(req: ImageSubmitRequest, explicitSize?: string): Array<{ label: string; body: Record<string, unknown> }> {
  const customSize =
    explicitSize ??
    (req.width && req.height
      ? `${req.width}x${req.height}`
      : req.aspectRatio
        ? (RATIO_TO_SIZE[req.aspectRatio] ?? ratioToSize(req.aspectRatio) ?? undefined)
        : undefined);

  const attempts: Array<{ label: string; body: Record<string, unknown> }> = [];

  if (customSize) {
    attempts.push({
      label: `full request (model, prompt, n, size ${customSize})`,
      body: { model: req.model, prompt: req.prompt, n: 1, size: customSize },
    });
  }

  if (req.width && req.height) {
    const standard = closestStandardSize(req.width, req.height);
    if (standard && standard !== customSize) {
      attempts.push({
        label: `standard size fallback (size ${standard})`,
        body: { model: req.model, prompt: req.prompt, n: 1, size: standard },
      });
    }
  }

  attempts.push({
    label: 'minimal fallback (model, prompt only — no optional parameters)',
    body: { model: req.model, prompt: req.prompt },
  });
  return attempts;
}

async function execute(
  localId: string,
  req: ImageSubmitRequest,
  credentials: ImageCredentials,
): Promise<void> {
  const job = localJobs.get(localId);
  if (!job) return;

  const base = ensureV1(credentials.baseUrl);
  const url = `${base}/images/generations`;
  const sizeDesc =
    req.width && req.height
      ? `size "${req.width}x${req.height}"`
      : req.aspectRatio
        ? `size from preset ${req.aspectRatio}`
        : 'no size parameter (Size: Default)';

  let lastStatus = 0;
  let lastText = '';
  let fellBack = false;

  let snapNote: string | undefined;
  let sizeOverride: string | undefined;
  const desiredSize =
    req.width && req.height
      ? `${req.width}x${req.height}`
      : req.aspectRatio
        ? (RATIO_TO_SIZE[req.aspectRatio] ?? ratioToSize(req.aspectRatio) ?? undefined)
        : undefined;
  if (desiredSize) {
    const resolutions = (await fetchResolutionCatalog(base, credentials.apiKey)).get(req.model);
    if (resolutions && resolutions.length > 0 && !resolutions.includes(desiredSize)) {
      const [w, h] = desiredSize.split('x').map(Number);
      if (w && h) {
        const snapped = snapToSupported(w, h, resolutions);
        if (snapped && snapped !== desiredSize) {
          sizeOverride = snapped;
          snapNote =
            `Requested size ${desiredSize} is not supported by ${req.model} on this provider; ` +
            `Moriko sent ${snapped}, the closest supported resolution.`;
        }
      }
    }
  }

  const attempts = attemptBodies(req, sizeOverride);

  try {
    for (const [index, attempt] of attempts.entries()) {
      if (index > 0) fellBack = true;
      const upstream = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.apiKey ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(attempt.body),
      });
      const text = await upstream.text();

      if (upstream.ok) {
        let payload: OpenAiImagesResponse;
        try {
          payload = JSON.parse(text) as OpenAiImagesResponse;
        } catch {
          throw new ImageAdapterError(
            502,
            `${credentials.label} returned a non-JSON response.`,
            `non-JSON body: ${text.slice(0, 600)}`,
          );
        }
        const images: NormalizedImage[] = (payload.data ?? [])
          .map((entry): NormalizedImage | null =>
            entry.url
              ? { kind: 'url', url: entry.url }
              : entry.b64_json
                ? { kind: 'b64', data: entry.b64_json }
                : null,
          )
          .filter((entry): entry is NormalizedImage => entry !== null);
        if (images.length === 0) {
          throw new ImageAdapterError(
            502,
            `${credentials.label} returned no image data.`,
            `no images in body: ${text.slice(0, 600)}`,
          );
        }

        job.images = images;
        job.raw = payload;
        job.status = 'SUCCEED';
        if (snapNote || fellBack) {
          const parts = [
            snapNote,
            fellBack
              ? 'This provider rejected the size parameter (HTTP 400), so the generation was retried without it — the image uses the provider\'s default size.'
              : null,
          ].filter(Boolean);
          job.note = parts.join(' ');
        }
        return;
      }

      lastStatus = upstream.status;
      lastText = text;
      if (upstream.status !== 400) break;
    }

    throw new ImageAdapterError(
      lastStatus || 502,
      formatRejection({
        label: credentials.label,
        status: lastStatus || 502,
        bodyText: lastText,
        request:
          `POST ${url} — model "${req.model}", prompt ${req.prompt.length} chars, ${sizeDesc}` +
          (fellBack ? ' — retried with the minimal request (model + prompt only) and still rejected' : ''),
        accepts: ACCEPTED_CONTRACT,
      }),
      lastText,
    );
  } catch (error) {
    job.status = 'FAILED';
    job.error = error instanceof Error ? error.message : 'Generation failed.';
    job.raw = error instanceof ImageAdapterError ? error.upstreamBody : undefined;
  }
}

export const openaiSyncAdapter: ImageAdapter = {
  id: 'openai-sync',
  capabilities: {
    execution: 'sync',
    sizeParam: 'size',
    resultFormat: 'both',
    maxImages: 1,
    supportsNegativePrompt: false,
    maxReferences: 0,
  },

  async submit(
    req: ImageSubmitRequest,
    { credentials }: AdapterContext,
  ): Promise<{ taskId: string }> {
    const localId = randomUUID();
    rememberJob(localId, { status: 'RUNNING', images: [] });
    void execute(localId, req, credentials).catch(() => {
    });
    return { taskId: localId };
  },

  async poll(taskId: string): Promise<ImagePollResult> {
    const job = localJobs.get(taskId);
    if (!job) {
      throw new ImageAdapterError(
        404,
        'Unknown image task — it may have finished or the server restarted. Submit again.',
      );
    }
    return { status: job.status, images: job.images, error: job.error, note: job.note, raw: job.raw };
  },
};
